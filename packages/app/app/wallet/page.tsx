"use client";

import { useCallback, useState } from "react";
import { ConfidentialWallet, type WalletView, type TxPhase } from "@/lib/wallet";
import { DEPLOYMENT } from "@/lib/deployment";
import { errMsg } from "@/lib/err";
import { EventsPanel } from "./events-panel";

type ActionTab = "deposit" | "withdraw" | "transfer" | "merge";

// Per-action visual identity. Colors match the activity-panel badges
// (deposit = sky, withdraw = amber); classes are literal so Tailwind sees them.
const ACTIONS: Record<
  ActionTab,
  { icon: string; title: string; hint: string; card: string; panel: string; btn: string }
> = {
  deposit: {
    icon: "↓",
    title: "Deposit",
    hint: "Public XLM (stroops) → your receiving balance.",
    card: "border-sky-500/60 bg-sky-500/15 text-sky-300",
    panel: "border-sky-500/30 bg-sky-500/5",
    btn: "bg-sky-600 hover:bg-sky-500",
  },
  withdraw: {
    icon: "↑",
    title: "Withdraw",
    hint: "Spendable → public XLM (to yourself).",
    card: "border-amber-500/60 bg-amber-500/15 text-amber-300",
    panel: "border-amber-500/30 bg-amber-500/5",
    btn: "bg-amber-600 hover:bg-amber-500",
  },
  transfer: {
    icon: "→",
    title: "Transfer",
    hint: "Send to another registered account's receiving balance — amount stays private.",
    card: "border-violet-500/60 bg-violet-500/15 text-violet-300",
    panel: "border-violet-500/30 bg-violet-500/5",
    btn: "bg-violet-600 hover:bg-violet-500",
  },
  merge: {
    icon: "⊕",
    title: "Merge",
    hint: "Fold your receiving balance into spendable.",
    card: "border-emerald-500/60 bg-emerald-500/15 text-emerald-300",
    panel: "border-emerald-500/30 bg-emerald-500/5",
    btn: "bg-emerald-600 hover:bg-emerald-500",
  },
};

export default function Page() {
  const [wallet, setWallet] = useState<ConfidentialWallet | null>(null);
  const [view, setView] = useState<WalletView | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [phase, setPhase] = useState<TxPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ActionTab>("deposit");
  const [recipients, setRecipients] = useState<string[] | null>(null);
  const [mergeNotice, setMergeNotice] = useState<"incoming" | "deposit" | null>(null);
  const [eventsKey, setEventsKey] = useState(0);

  const [depositAmt, setDepositAmt] = useState("1000");
  const [transferTo, setTransferTo] = useState("");
  const [transferAmt, setTransferAmt] = useState("400");
  const [withdrawAmt, setWithdrawAmt] = useState("400");

  const log = useCallback((msg: string) => {
    setLogs((prev) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...prev].slice(0, 60));
  }, []);

  const loadRecipients = useCallback(
    async (w: ConfidentialWallet) => {
      try {
        setRecipients(await w.registeredRecipients());
      } catch (e) {
        log(`failed to list registered accounts: ${errMsg(e)}`);
        setRecipients([]);
      }
    },
    [log],
  );

  const connect = useCallback(async () => {
    setError(null);
    setBusy("connecting");
    try {
      const w = await ConfidentialWallet.connect(log);
      setWallet(w);
      const v = await w.refresh();
      setView(v);
      if (v.receiving > 0n) setMergeNotice("incoming");
      void loadRecipients(w);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, [log, loadRecipients]);

  const run = useCallback(
    (label: string, fn: (w: ConfidentialWallet) => Promise<void>) => async () => {
      if (!wallet) return;
      setError(null);
      setBusy(label);
      setPhase(null);
      try {
        await fn(wallet);
        const v = await wallet.refresh();
        setView(v);
        if (v.receiving === 0n) setMergeNotice(null);
        else if (label === "deposit") setMergeNotice("deposit");
        if (label !== "refresh") setEventsKey((k) => k + 1);
      } catch (e) {
        setError(errMsg(e));
        log(`error: ${errMsg(e)}`);
      } finally {
        setBusy(null);
        setPhase(null);
      }
    },
    [wallet, log],
  );

  const showMerge = (view?.receiving ?? 0n) > 0n;
  const activeTab: ActionTab = tab === "merge" && !showMerge ? "deposit" : tab;
  const tabs: ActionTab[] = showMerge
    ? ["deposit", "withdraw", "transfer", "merge"]
    : ["deposit", "withdraw", "transfer"];

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">
          Account holder <span className="text-base font-normal text-neutral-500">· your wallet</span>
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          This page is for you, the regular user: you hold tokens, move them around, and nobody
          watching the chain learns the amounts. If a
          counterparty asks you to prove what one transfer paid, disclose it from the activity
          list below.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>
      )}

      {!wallet ? (
        <button
          onClick={connect}
          disabled={busy !== null}
          className="rounded bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy === "connecting" ? "Connecting…" : "Connect Freighter"}
        </button>
      ) : (
        <div className="space-y-6">
          <Balances view={view} />

          {view?.registered && mergeNotice && showMerge && (
            <div className="flex items-center justify-between gap-3 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-300">
              <span>
                {mergeNotice === "deposit"
                  ? `Deposit landed in your receiving balance (${view.receiving.toString()}) — merge it before you can transfer or withdraw.`
                  : `You have an incoming balance of ${view.receiving.toString()} — merge it to make it spendable.`}
              </span>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setTab("merge")}
                  className="rounded bg-amber-700 px-3 py-1 font-medium text-amber-100 hover:bg-amber-600"
                >
                  Go to merge
                </button>
                <button
                  onClick={() => setMergeNotice(null)}
                  className="rounded px-2 py-1 text-amber-400 hover:text-amber-200"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {!view?.registered ? (
            <section className="rounded border border-neutral-800 p-4">
              <h3 className="font-medium">Register</h3>
              <p className="mb-3 mt-0.5 text-xs text-neutral-400">
                Bind your confidential keys to the contract (one-time). All other actions unlock
                once you&apos;re registered.
              </p>
              <button
                onClick={run("register", (w) => w.register(setPhase))}
                disabled={busy !== null}
                className="rounded bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy === "register" ? phaseLabel(phase) : "Register"}
              </button>
            </section>
          ) : (
            <section className="rounded border border-neutral-800">
              <div className="flex gap-2 border-b border-neutral-800 bg-neutral-900/40 p-3">
                {tabs.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`relative flex flex-1 flex-col items-center gap-1 rounded-md border py-2.5 text-sm font-medium transition-colors ${
                      activeTab === t
                        ? ACTIONS[t].card
                        : "border-neutral-800 bg-neutral-900/60 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                    }`}
                  >
                    <span aria-hidden className="text-lg leading-none">
                      {ACTIONS[t].icon}
                    </span>
                    {ACTIONS[t].title}
                    {t === "merge" && (
                      <span className="absolute right-1.5 top-1.5 rounded-full bg-emerald-500/20 px-1.5 text-[10px] leading-4 text-emerald-300">
                        {view.receiving.toString()}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="p-4">
                {activeTab === "deposit" && (
                  <ActionPanel action="deposit">
                    <input
                      className={`${inputCls} sm:w-36`}
                      value={depositAmt}
                      onChange={(e) => setDepositAmt(e.target.value)}
                    />
                    <button
                      onClick={run("deposit", (w) => w.deposit(BigInt(depositAmt)))}
                      disabled={busy !== null}
                      className={`${btnCls} ${ACTIONS.deposit.btn}`}
                    >
                      {busy === "deposit" ? "Submitting tx…" : "Deposit"}
                    </button>
                  </ActionPanel>
                )}

                {activeTab === "withdraw" && (
                  <ActionPanel action="withdraw">
                    <input
                      className={`${inputCls} sm:w-36`}
                      value={withdrawAmt}
                      onChange={(e) => setWithdrawAmt(e.target.value)}
                    />
                    <button
                      onClick={run("withdraw", (w) => w.withdraw(BigInt(withdrawAmt), setPhase))}
                      disabled={busy !== null}
                      className={`${btnCls} ${ACTIONS.withdraw.btn}`}
                    >
                      {busy === "withdraw" ? phaseLabel(phase) : "Withdraw"}
                    </button>
                  </ActionPanel>
                )}

                {activeTab === "transfer" && (
                  <ActionPanel action="transfer">
                    <RecipientSelect
                      recipients={recipients}
                      value={transferTo}
                      onChange={setTransferTo}
                    />
                    <input
                      className={`${inputCls} sm:w-28`}
                      value={transferAmt}
                      onChange={(e) => setTransferAmt(e.target.value)}
                    />
                    <button
                      onClick={run("transfer", (w) => w.transfer(transferTo, BigInt(transferAmt), setPhase))}
                      disabled={busy !== null || !transferTo}
                      className={`${btnCls} ${ACTIONS.transfer.btn}`}
                    >
                      {busy === "transfer" ? phaseLabel(phase) : "Send"}
                    </button>
                  </ActionPanel>
                )}

                {activeTab === "merge" && (
                  <ActionPanel action="merge">
                    <button
                      onClick={run("merge", (w) => w.merge())}
                      disabled={busy !== null}
                      className={`${btnCls} ${ACTIONS.merge.btn}`}
                    >
                      {busy === "merge" ? "Submitting tx…" : `Merge ${view.receiving.toString()}`}
                    </button>
                  </ActionPanel>
                )}
              </div>
            </section>
          )}

          <EventsPanel wallet={wallet} reloadKey={eventsKey} />

          <button
            onClick={run("refresh", async (w) => {
              void loadRecipients(w);
            })}
            disabled={busy !== null}
            className="text-sm text-neutral-400 underline hover:text-neutral-200 disabled:opacity-50"
          >
            {busy === "refresh"
              ? "Syncing…"
              : DEPLOYMENT.indexerUrl
                ? "Sync events (RPC + indexer)"
                : "Sync from RPC events"}
          </button>
        </div>
      )}

      <LogPanel logs={logs} />

      <footer className="mt-10 text-xs text-neutral-600">
        token {short(DEPLOYMENT.contracts.token)} · verifier {short(DEPLOYMENT.contracts.verifier)} · auditor{" "}
        {short(DEPLOYMENT.contracts.auditor)} · events {DEPLOYMENT.indexerUrl ? "RPC + indexer" : "RPC only"}
      </footer>
    </main>
  );
}

const inputCls =
  "rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-emerald-600";
const btnCls = "rounded px-4 py-2 text-sm font-medium disabled:opacity-50";

function phaseLabel(phase: TxPhase | null): string {
  if (phase === "submitting") return "Submitting tx…";
  if (phase === "proving") return "Proving…";
  return "Preparing…";
}

function RecipientSelect(props: {
  recipients: string[] | null;
  value: string;
  onChange: (v: string) => void;
}) {
  const { recipients, value, onChange } = props;
  const empty = recipients !== null && recipients.length === 0;
  return (
    <select
      className={`${inputCls} min-w-0 flex-1`}
      value={empty ? "" : value}
      onChange={(e) => onChange(e.target.value)}
    >
      {recipients === null ? (
        <option value="">Loading registered accounts…</option>
      ) : empty ? (
        <option value="">
          No other registered accounts yet — switch your Freighter account to load another
          address, register it, then refresh this page
        </option>
      ) : (
        <>
          <option value="">Select recipient…</option>
          {recipients.map((a) => (
            <option key={a} value={a}>
              {`${a.slice(0, 12)}…${a.slice(-12)}`}
            </option>
          ))}
        </>
      )}
    </select>
  );
}

function ActionPanel(props: { action: ActionTab; children: React.ReactNode }) {
  const meta = ACTIONS[props.action];
  return (
    <div className={`rounded-md border p-4 ${meta.panel}`}>
      <p className="mb-3 text-xs text-neutral-400">{meta.hint}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">{props.children}</div>
    </div>
  );
}

function Balances({ view }: { view: WalletView | null }) {
  if (!view) return null;
  return (
    <section className="rounded border border-neutral-800 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-neutral-400">{view.address}</span>
        {view.matchesChain !== null && (
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              view.matchesChain ? "bg-emerald-900 text-emerald-300" : "bg-red-900 text-red-300"
            }`}
            title="Local reconstruction re-committed and compared to on-chain commitments"
          >
            {view.matchesChain ? "state matches chain ✓" : "state mismatch ✗"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Spendable" value={view.spendable.toString()} />
        <Stat label="Receiving" value={view.receiving.toString()} />
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        {view.registered ? `synced through ledger ${view.syncedLedger}` : "not registered yet"}
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-2xl">{value}</div>
    </div>
  );
}

function LogPanel({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;
  return (
    <pre className="mt-6 max-h-56 overflow-auto rounded border border-neutral-900 bg-black/40 p-3 text-xs text-neutral-400">
      {logs.join("\n")}
    </pre>
  );
}

function short(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
