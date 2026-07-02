"use client";

/**
 * Auditor console (DESIGN.md §8). The auditor persona holds the Grumpkin
 * secret behind auditor id 0 — the id every account in this demo registers
 * under — and decrypts the dual-channel ciphertexts that each transfer and
 * withdraw event carries. Pure key-and-events work: no wallet, no proving,
 * no holder cooperation.
 *
 * Beyond per-event amounts, the page replays the event stream into the
 * auditor's running view of every account (§8.1/§8.2): spendable balance from
 * the sender-channel checkpoints, receiving balance as the sum of decrypted
 * inbound transfers plus public deposits, folded on merge.
 *
 * ⚠️ The secret key is shipped in the client bundle ON PURPOSE so anyone can
 * play this persona. Real deployments keep it far away from a browser.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  hybridFetchEvents,
  auditTransfer,
  auditWithdraw,
  auditorPublicKey,
  pointCoords,
  toHex32,
  fromHex,
  type ConfidentialEvent,
} from "@ctd/sdk";
import { useActiveDeployment } from "@/lib/active-deployment";
import { clientsFor } from "@/lib/rpc";
import { errMsg } from "@/lib/err";
import { CopyButton } from "../copy-button";
import { PageShell } from "../page-shell";
import { ErrorBox } from "../error-box";
import { Addr } from "../addr";
import { TxLink } from "../tx-link";

/** One decrypted line of the auditor's ledger. */
interface AuditRow {
  ev: ConfidentialEvent;
  text: string;
  /** Decrypted (or public) amount, when the event has one. */
  amount: bigint | null;
  /** Sender's post-op spendable balance, when the event reveals one. */
  senderBalance: bigint | null;
  /** False iff a transfer's two channels decrypt to different amounts. */
  channelsAgree: boolean;
}

/** The auditor's running view of one account (§8.1). */
interface AccountView {
  address: string;
  /** Last sender-channel checkpoint (null = no owner op seen yet). */
  spendable: bigint | null;
  /** Running sum of decrypted inbound transfers + public deposits. */
  receiving: bigint;
  lastLedger: number;
}

function replay(
  events: ConfidentialEvent[],
  auditorSk: bigint,
): { rows: AuditRow[]; accounts: AccountView[] } {
  const rows: AuditRow[] = [];
  const accounts = new Map<string, AccountView>();
  const acct = (address: string): AccountView => {
    let a = accounts.get(address);
    if (!a) {
      a = { address, spendable: null, receiving: 0n, lastLedger: 0 };
      accounts.set(address, a);
    }
    return a;
  };
  const seen = (address: string, ledger: number) => {
    const a = acct(address);
    a.lastLedger = Math.max(a.lastLedger, ledger);
    return a;
  };

  for (const ev of events) {
    switch (ev.type) {
      case "register": {
        const a = seen(ev.account, ev.ledger);
        a.spendable = 0n;
        rows.push({ ev, text: "registered", amount: null, senderBalance: null, channelsAgree: true });
        break;
      }
      case "deposit": {
        const a = seen(ev.to, ev.ledger);
        a.receiving += ev.amount;
        rows.push({
          ev,
          text: "deposit (public amount)",
          amount: ev.amount,
          senderBalance: null,
          channelsAgree: true,
        });
        break;
      }
      case "merge": {
        const a = seen(ev.account, ev.ledger);
        if (a.spendable !== null) a.spendable += a.receiving;
        a.receiving = 0n;
        rows.push({
          ev,
          text: "merged receiving → spendable",
          amount: null,
          senderBalance: a.spendable,
          channelsAgree: true,
        });
        break;
      }
      case "withdraw": {
        const a = seen(ev.from, ev.ledger);
        const { senderBalance } = auditWithdraw(auditorSk, ev);
        a.spendable = senderBalance;
        rows.push({
          ev,
          text: "withdrawal (public amount) — checkpoint decrypted",
          amount: ev.amount,
          senderBalance,
          channelsAgree: true,
        });
        break;
      }
      case "transfer": {
        const from = seen(ev.from, ev.ledger);
        const to = seen(ev.to, ev.ledger);
        const d = auditTransfer(auditorSk, ev);
        if (d.channelsAgree) {
          from.spendable = d.senderBalance;
          to.receiving += d.amount;
        }
        rows.push({
          ev,
          text: d.channelsAgree
            ? "confidential transfer — both channels decrypted"
            : "transfer did NOT decrypt under this key",
          amount: d.channelsAgree ? d.amount : null,
          senderBalance: d.channelsAgree ? d.senderBalance : null,
          channelsAgree: d.channelsAgree,
        });
        break;
      }
    }
  }

  return {
    rows: rows.reverse(),
    accounts: [...accounts.values()].sort((a, b) => b.lastLedger - a.lastLedger),
  };
}

export default function AuditorPage() {
  const { active } = useActiveDeployment();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The auditor key is constant across deployments (same auditor contract), but
  // the token whose events we decrypt follows the active deployment.
  const auditorSk = useMemo(() => fromHex(active.auditorSecretHex), [active.auditorSecretHex]);
  const kAud = useMemo(() => pointCoords(auditorPublicKey(auditorSk)), [auditorSk]);
  const hasIndexer = !!active.indexerUrl;

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Hybrid source: the indexer (when configured) backfills the full history
      // below the RPC's ~7-day window — exactly what an auditor needs. The RPC
      // leg is clamped to the retention boundary internally.
      const { client, indexer } = clientsFor(active);
      const { events } = await hybridFetchEvents(client, indexer, {
        fromLedger: active.deployedAtLedger,
      });
      const result = replay(events, auditorSk);
      setRows(result.rows);
      setAccounts(result.accounts);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [active, auditorSk]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageShell
      title="Auditor"
      subtitle="You are the designated auditor for this deployment: every account registers under your auditor id. Amounts that everyone else sees as ciphertext, you read in cleartext: each transfer and withdrawal carries ECDH ciphertexts addressed to your key. No wallet, no proofs, and no account cooperation required."
    >
      <div className="space-y-6">
        <section className="rounded border border-amber-900/70 bg-amber-950/20 p-4">
          <h3 className="mb-1 font-medium text-amber-300">Your auditor key (id {active.auditorId})</h3>
          <p className="mb-3 text-xs text-neutral-400">
            Demo-only: this secret ships with the app so anyone can take the auditor role.
            In a real deployment it lives in the auditor&apos;s vault and only the public key{" "}
            <code>K_aud = k·H</code> is registered on-chain.
          </p>
          <dl className="space-y-1 break-all font-mono text-xs text-neutral-300">
            <div>
              <dt className="inline text-neutral-500">secret k: </dt>
              <dd className="inline">{active.auditorSecretHex}</dd>{" "}
              <CopyButton label="Copy" payload={() => active.auditorSecretHex} />
            </div>
            <div>
              <dt className="inline text-neutral-500">K_aud.x: </dt>
              <dd className="inline">{toHex32(kAud.x)}</dd>
            </div>
            <div>
              <dt className="inline text-neutral-500">K_aud.y: </dt>
              <dd className="inline">{toHex32(kAud.y)}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded border border-neutral-800 p-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-medium">Accounts as you see them</h3>
            <button
              onClick={load}
              disabled={busy}
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? "Decrypting…" : "Reload + decrypt"}
            </button>
          </div>
          <p className="mb-3 text-xs text-neutral-400">
            Reconstructed from sender-channel balance checkpoints and decrypted inbound credits
            (DESIGN.md §8.1).{" "}
            {hasIndexer
              ? "Backed by the Goldsky indexer, so the full deployment history is decrypted."
              : "Only events inside the RPC's ~7-day retention window are available — accounts with older history may be incomplete."}
          </p>
          {accounts.length === 0 && !busy && (
            <p className="text-sm text-neutral-500">No accounts in the retention window.</p>
          )}
          {accounts.length > 0 && (
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="pb-2 font-normal">account</th>
                  <th className="pb-2 font-normal">spendable</th>
                  <th className="pb-2 font-normal">receiving</th>
                  <th className="pb-2 font-normal">last seen</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {accounts.map((a) => (
                  <tr key={a.address} className="border-t border-neutral-900">
                    <td className="py-1.5">
                      <Addr value={a.address} />
                    </td>
                    <td className="py-1.5">{a.spendable === null ? "?" : a.spendable.toString()}</td>
                    <td className="py-1.5">{a.receiving.toString()}</td>
                    <td className="py-1.5 text-neutral-500">ledger {a.lastLedger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded border border-neutral-800 p-4">
          <h3 className="mb-1 font-medium">Decrypted activity</h3>
          <p className="mb-3 text-xs text-neutral-400">
            Every token-contract event {hasIndexer ? "since deployment" : "in the retention window"},
            newest first. Amounts the wallet page shows as &ldquo;confidential&rdquo; appear here in
            cleartext — decrypted with your key alone.
          </p>
          {error && (
            <ErrorBox size="sm" className="mb-3">
              {error}
            </ErrorBox>
          )}
          {!rows && busy && <p className="text-sm text-neutral-500">Syncing events…</p>}
          {rows && rows.length === 0 && (
            <p className="text-sm text-neutral-500">No activity in the retention window.</p>
          )}
          {rows && (
            <ul className="space-y-2">
              {rows.map((row) => (
                <AuditRowView key={row.ev.cursor} row={row} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageShell>
  );
}

function AuditRowView({ row }: { row: AuditRow }) {
  const { ev } = row;
  // deposit/withdraw/transfer carry from→to; register/merge (and any compliance
  // event, though the auditor never emits rows for those) carry a single account.
  const parties =
    "from" in ev ? (
      <>
        <Addr value={ev.from} /> → <Addr value={ev.to} />
      </>
    ) : (
      <Addr value={ev.account} />
    );
  return (
    <li className="rounded border border-neutral-900 bg-neutral-500/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeCls(ev.type)}`}>{ev.type}</span>
        <span className="text-xs text-neutral-400">{parties}</span>
        <span className="flex-1" />
        {row.amount !== null && (
          <span className="text-sm font-medium text-amber-300">{row.amount.toString()}</span>
        )}
        {!row.channelsAgree && (
          <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-300">undecryptable</span>
        )}
      </div>
      <div className="mt-1.5 text-xs text-neutral-400">
        {row.text}
        {row.senderBalance !== null && (
          <> · sender&apos;s balance now <span className="text-neutral-300">{row.senderBalance.toString()}</span></>
        )}
      </div>
      <div className="mt-1 text-xs text-neutral-600">
        ledger {ev.ledger} · tx <TxLink hash={ev.txHash} />
      </div>
    </li>
  );
}

function badgeCls(type: ConfidentialEvent["type"]): string {
  switch (type) {
    case "transfer":
      return "bg-amber-900 text-amber-300";
    case "deposit":
      return "bg-sky-900 text-sky-300";
    case "withdraw":
      return "bg-orange-900 text-orange-300";
    case "register":
      return "bg-purple-900 text-purple-300";
    case "merge":
      return "bg-neutral-800 text-neutral-300";
    default:
      return "bg-neutral-800 text-neutral-300";
  }
}
