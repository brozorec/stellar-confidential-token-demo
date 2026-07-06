"use client";

/**
 * Token-admin dashboard. The owner of a compliant confidential token manages
 * compliance here:
 *
 *  1. Registered accounts — every `register` event on the token.
 *  2. Freeze panel (all compliant configs) — freeze/unfreeze accounts; the
 *     frozen set is replayed from `frozen`/`unfrozen` events.
 *  3. Policy panel (allowlist/blocklist) — allow/disallow or block/unblock; the
 *     membership set is replayed from `user_*` events on the policy contract.
 *  4. Redeploy — the only way to reconfigure/redeploy an advanced deployment,
 *     so it's also shown (without the panels above) for a vanilla token
 *     deployed in advanced mode, which has no owner or compliance to manage.
 *
 * Access to the compliance panels requires a Freighter connection whose
 * account is the token owner. The page reads the owner publicly; mutations
 * are owner-gated on-chain (#[only_owner]). A vanilla deployment has no owner,
 * so it skips this gate entirely.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  hybridFetchEvents,
  readOwner,
  freezeAccount,
  unfreezeAccount,
  allowUser,
  disallowUser,
  blockUser,
  unblockUser,
  type ConfidentialEvent,
  type ComplianceEventType,
} from "@ctd/sdk";
import { useActiveDeployment } from "@/lib/active-deployment";
import { hasAdminDashboard } from "@/lib/deployment";
import { connectFreighter, type MessageSigner } from "@/lib/freighter";
import { clientsFor } from "@/lib/rpc";
import { errMsg } from "@/lib/err";
import { PageShell } from "../page-shell";
import { ErrorBox } from "../error-box";
import { Addr } from "../addr";

/** Small triangular alert glyph — marks the danger-zone header. */
function Warning() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M8 2 14.5 13.5h-13z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8 6.3v3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="0.75" fill="currentColor" />
    </svg>
  );
}

interface Registered {
  account: string;
  auditorId: number;
}

function registeredAccounts(events: ConfidentialEvent[]): Registered[] {
  const seen = new Map<string, number>();
  for (const ev of events) if (ev.type === "register") seen.set(ev.account, ev.auditorId);
  return [...seen.entries()].map(([account, auditorId]) => ({ account, auditorId }));
}

/** Current membership set: add events add, remove events remove. */
function replaySet(
  events: ConfidentialEvent[],
  addType: ComplianceEventType,
  removeType: ComplianceEventType,
): string[] {
  const s = new Set<string>();
  for (const ev of events) {
    if (ev.type === addType) s.add((ev as { account: string }).account);
    else if (ev.type === removeType) s.delete((ev as { account: string }).account);
  }
  return [...s];
}

/** Redeploy — start over with a brand-new token. Styled as a danger zone
    (irreversible: the current token, its registrations, and compliance
    history are abandoned) and kept apart from the compliance panels because
    it replaces the whole deployment, not a setting within it. Shown for any
    deployment created in advanced mode (compliant or vanilla), since this
    dashboard is the only place to reach it. Forgets the current deployment
    on click — the /advanced wizard has nothing left to carry over. */
function RedeploySection() {
  const { clearAdvanced } = useActiveDeployment();
  return (
    <section className="mt-8 rounded border border-red-900/60 bg-red-950/10 p-4">
      <h2 className="mb-1 flex items-center gap-1.5 font-medium text-red-300">
        <Warning />
        Danger zone
      </h2>
      <p className="mb-3 text-xs leading-relaxed text-neutral-400">
        Deploy a brand-new confidential token through the factory. This does not
        modify the current token — it replaces it as your active advanced deployment, so you start
        from scratch: no registered accounts, balances, or compliance history carry over, and the
        account you deploy with becomes the new owner.
      </p>
      <Link
        href="/advanced"
        onClick={clearAdvanced}
        className="items-center gap-1.5 rounded border bg-red-600 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-red-500"
      >
        Redeploy
      </Link>
    </section>
  );
}

export default function AdminPage() {
  const { active } = useActiveDeployment();
  const isVanilla = active.kind === "vanilla";
  // Any token deployed through the advanced wizard, vanilla included — the
  // built-in default is the only deployment excluded from this dashboard.
  const isCustomDeployment = hasAdminDashboard(active);
  const hasPolicy = active.kind === "allowlist" || active.kind === "blocklist";

  const [signer, setSigner] = useState<MessageSigner | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [ownerLoaded, setOwnerLoaded] = useState(false);
  const [registered, setRegistered] = useState<Registered[]>([]);
  const [frozen, setFrozen] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [freezeInput, setFreezeInput] = useState("");
  const [policyInput, setPolicyInput] = useState("");

  const account = signer?.publicKey ?? null;
  const isAdmin = !!account && !!owner && account === owner;

  const { client, indexer } = useMemo(() => clientsFor(active), [active]);

  // Owner is a public read; load it (and reset connection) whenever the active
  // token changes.
  useEffect(() => {
    setSigner(null);
    setOwner(null);
    setOwnerLoaded(false);
    setRegistered([]);
    setFrozen([]);
    setMembers([]);
    if (isVanilla) {
      setOwnerLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const o = await readOwner(client, active.contracts.token);
      if (!cancelled) {
        setOwner(o);
        setOwnerLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, active.contracts.token, isVanilla]);

  const loadLists = useCallback(async () => {
    setBusy("loading");
    setError(null);
    try {
      const tokenEvents = (
        await hybridFetchEvents(client, indexer, {
          fromLedger: active.deployedAtLedger,
          contractId: active.contracts.token,
        })
      ).events;
      setRegistered(registeredAccounts(tokenEvents));
      setFrozen(replaySet(tokenEvents, "frozen", "unfrozen"));

      if (hasPolicy && active.contracts.policy) {
        const policyEvents = (
          await hybridFetchEvents(client, indexer, {
            fromLedger: active.deployedAtLedger,
            contractId: active.contracts.policy,
          })
        ).events;
        const [add, remove]: [ComplianceEventType, ComplianceEventType] =
          active.kind === "allowlist"
            ? ["user_allowed", "user_disallowed"]
            : ["user_blocked", "user_unblocked"];
        setMembers(replaySet(policyEvents, add, remove));
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, [client, indexer, active, hasPolicy]);

  // Once an admin is connected, load the lists.
  useEffect(() => {
    if (isAdmin) void loadLists();
  }, [isAdmin, loadLists]);

  const connect = useCallback(async () => {
    setError(null);
    setBusy("connecting");
    try {
      setSigner(await connectFreighter());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const runAction = useCallback(
    (label: string, fn: (s: MessageSigner) => Promise<unknown>) => async () => {
      if (!signer) return;
      setBusy(label);
      setError(null);
      try {
        await fn(signer);
        await loadLists();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    },
    [signer, loadLists],
  );

  // ---- gating views -------------------------------------------------------

  if (isVanilla && !isCustomDeployment) {
    // The built-in default: no owner, no compliance, nothing to redeploy.
    return (
      <PageShell
        title="Token admin"
        subtitle="Manage compliance for the active confidential token: registered accounts, freezes, and (for allowlist/blocklist configs) policy membership."
      >
        <Notice>
          This deployment is a <b>vanilla</b> token — it has no owner, freeze, or policy, so there
          is no admin dashboard. Deploy a token of your own (compliant or not) in{" "}
          <a className="underline" href="/advanced">
            advanced mode
          </a>{" "}
          to unlock this page.
        </Notice>
      </PageShell>
    );
  }

  if (isVanilla) {
    // A custom vanilla deployment has no owner or compliance to manage, but
    // this dashboard is still the only way to redeploy it with a different
    // configuration — skip the Freighter/owner gate entirely, since there's
    // no owner for a vanilla token.
    return (
      <PageShell
        title="Token admin"
        subtitle="Manage compliance for the active confidential token: registered accounts, freezes, and (for allowlist/blocklist configs) policy membership."
      >
        <Notice>
          This deployment is a <b>vanilla</b> token — it has no owner, freeze, or policy, so there
          is nothing to manage here. You can still redeploy with a different configuration below.
        </Notice>
        <RedeploySection />
      </PageShell>
    );
  }

  if (!account) {
    return (
      <PageShell
        title="Token admin"
        subtitle="Manage compliance for the active confidential token: registered accounts, freezes, and (for allowlist/blocklist configs) policy membership."
      >
        <p className="mb-4 text-sm text-neutral-400">
          The admin dashboard requires the token owner&apos;s Freighter account.
        </p>
        <button
          onClick={connect}
          disabled={busy !== null}
          className="rounded bg-rose-600 px-4 py-2 text-sm font-medium hover:bg-rose-500 disabled:opacity-50"
        >
          {busy === "connecting" ? "Connecting…" : "Connect Freighter"}
        </button>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      </PageShell>
    );
  }

  if (ownerLoaded && !isAdmin) {
    return (
      <PageShell
        title="Token admin"
        subtitle="Manage compliance for the active confidential token: registered accounts, freezes, and (for allowlist/blocklist configs) policy membership."
      >
        <Notice tone="warn">
          You are connected as <Addr value={account} />, but this token&apos;s admin is{" "}
          {owner ? <Addr value={owner} /> : <span className="font-mono">unknown</span>}. Switch to
          the admin account in Freighter, then reconnect below.
        </Notice>
        <button
          onClick={connect}
          disabled={busy !== null}
          className="mt-3 rounded bg-rose-600 px-4 py-2 text-sm font-medium hover:bg-rose-500 disabled:opacity-50"
        >
          {busy === "connecting" ? "Connecting…" : "Connect Freighter"}
        </button>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      </PageShell>
    );
  }

  if (!ownerLoaded) {
    return (
      <PageShell
        title="Token admin"
        subtitle="Manage compliance for the active confidential token: registered accounts, freezes, and (for allowlist/blocklist configs) policy membership."
      >
        <p className="text-sm text-neutral-500">Reading token owner…</p>
      </PageShell>
    );
  }

  // ---- admin dashboard ----------------------------------------------------

  return (
    <PageShell
      title="Token admin"
      subtitle="Manage compliance for the active confidential token: registered accounts, freezes, and (for allowlist/blocklist configs) policy membership."
    >
      {error && <ErrorBox className="mb-4">{error}</ErrorBox>}
      <div className="mb-4 flex items-center justify-between">
        <p className="flex items-center gap-1 text-sm text-neutral-400">
          Admin <span className="text-neutral-300"><Addr value={account} /></span>
        </p>
        <button
          onClick={loadLists}
          disabled={busy !== null}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
        >
          {busy === "loading" ? "Loading…" : "Reload"}
        </button>
      </div>

      <div className="space-y-6">
        {/* Registered accounts */}
        <section className="rounded border border-neutral-800 p-4">
          <h2 className="mb-1 font-medium">Registered accounts</h2>
          <p className="mb-3 text-xs text-neutral-400">
            Every account that has registered a confidential balance on this token ({registered.length}).
          </p>
          {registered.length === 0 ? (
            <p className="text-sm text-neutral-500">No registered accounts yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="pb-2 font-normal">account</th>
                  <th className="pb-2 font-normal">auditor id</th>
                  <th className="pb-2 font-normal">status</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {registered.map((r) => (
                  <tr key={r.account} className="border-t border-neutral-900">
                    <td className="py-1.5">
                      <Addr value={r.account} />
                    </td>
                    <td className="py-1.5">{r.auditorId}</td>
                    <td className="py-1.5">
                      {frozen.includes(r.account) ? (
                        <span className="text-red-300">frozen</span>
                      ) : hasPolicy ? (
                        members.includes(r.account) ? (
                          <span className="text-emerald-300">
                            {active.kind === "allowlist" ? "allowed" : "blocked"}
                          </span>
                        ) : (
                          <span className="text-neutral-500">
                            {active.kind === "allowlist" ? "not allowed" : "not blocked"}
                          </span>
                        )
                      ) : (
                        <span className="text-neutral-500">active</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Freeze panel (all compliant configs) */}
        <ManagePanel
          title="Freeze accounts"
          hint="A frozen account is blocked from every confidential operation until unfrozen."
          inputValue={freezeInput}
          setInput={setFreezeInput}
          placeholder="G… account to freeze"
          actionLabel="Freeze"
          actionTone="bg-red-600 hover:bg-red-500"
          onAction={runAction("freeze", (s) =>
            freezeAccount(client, s, active.contracts.token, freezeInput.trim(), s.publicKey),
          )}
          busy={busy}
          list={frozen}
          listTitle="Frozen accounts"
          rowActionLabel="Unfreeze"
          onRowAction={(acct) =>
            runAction(`unfreeze:${acct}`, (s) =>
              unfreezeAccount(client, s, active.contracts.token, acct, s.publicKey),
            )()
          }
        />

        {/* Policy panel (allowlist / blocklist) */}
        {hasPolicy && (
          <ManagePanel
            title={active.kind === "allowlist" ? "Allowlist (KYC)" : "Blocklist (KYC)"}
            hint={
              active.kind === "allowlist"
                ? "Only allowed accounts may transact. Allow an address after KYC; disallow to revoke."
                : "Every account may transact except those blocked. Block an address to deny it (e.g. sanctions)."
            }
            inputValue={policyInput}
            setInput={setPolicyInput}
            placeholder={active.kind === "allowlist" ? "G… account to allow" : "G… account to block"}
            actionLabel={active.kind === "allowlist" ? "Allow" : "Block"}
            actionTone="bg-emerald-600 hover:bg-emerald-500"
            onAction={runAction(active.kind === "allowlist" ? "allow" : "block", (s) =>
              active.kind === "allowlist"
                ? allowUser(client, s, active.contracts.policy!, policyInput.trim())
                : blockUser(client, s, active.contracts.policy!, policyInput.trim()),
            )}
            busy={busy}
            list={members}
            listTitle={active.kind === "allowlist" ? "Allowed accounts" : "Blocked accounts"}
            rowActionLabel={active.kind === "allowlist" ? "Disallow" : "Unblock"}
            onRowAction={(acct) =>
              runAction(`${active.kind === "allowlist" ? "disallow" : "unblock"}:${acct}`, (s) =>
                active.kind === "allowlist"
                  ? disallowUser(client, s, active.contracts.policy!, acct)
                  : unblockUser(client, s, active.contracts.policy!, acct),
              )()
            }
          />
        )}
      </div>

      {isCustomDeployment && <RedeploySection />}
    </PageShell>
  );
}

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" }) {
  const cls =
    tone === "warn"
      ? "border-amber-800 bg-amber-950/30 text-amber-200"
      : "border-neutral-800 bg-neutral-900/40 text-neutral-300";
  return <div className={`rounded border p-4 text-sm leading-relaxed ${cls}`}>{children}</div>;
}

interface ManagePanelProps {
  title: string;
  hint: string;
  inputValue: string;
  setInput: (v: string) => void;
  placeholder: string;
  actionLabel: string;
  actionTone: string;
  onAction: () => void;
  busy: string | null;
  list: string[];
  listTitle: string;
  rowActionLabel: string;
  onRowAction: (account: string) => void;
}

function ManagePanel(p: ManagePanelProps) {
  return (
    <section className="rounded border border-neutral-800 p-4">
      <h2 className="mb-1 font-medium">{p.title}</h2>
      <p className="mb-3 text-xs text-neutral-400">{p.hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={p.inputValue}
          onChange={(e) => p.setInput(e.target.value)}
          placeholder={p.placeholder}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs outline-none focus:border-rose-500"
        />
        <button
          onClick={p.onAction}
          disabled={p.busy !== null || p.inputValue.trim().length === 0}
          className={`rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${p.actionTone}`}
        >
          {p.actionLabel}
        </button>
      </div>
      <div className="mt-4">
        <h3 className="mb-2 text-xs font-medium text-neutral-400">
          {p.listTitle} ({p.list.length})
        </h3>
        {p.list.length === 0 ? (
          <p className="text-sm text-neutral-500">None.</p>
        ) : (
          <ul className="space-y-1.5">
            {p.list.map((acct) => (
              <li
                key={acct}
                className="flex items-center justify-between rounded border border-neutral-900 bg-neutral-500/5 px-3 py-1.5"
              >
                <span className="text-xs text-neutral-300">
                  <Addr value={acct} />
                </span>
                <button
                  onClick={() => p.onRowAction(acct)}
                  disabled={p.busy !== null}
                  className="rounded border border-neutral-700 px-2.5 py-1 text-xs font-medium hover:bg-neutral-800 disabled:opacity-50"
                >
                  {p.rowActionLabel}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
