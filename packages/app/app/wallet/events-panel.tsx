"use client";

/**
 * Account-activity panel. The confidential token leans on events for all
 * client-visible state, so this lists every token-contract event concerning
 * the connected account (inside the RPC retention window), loaded on landing.
 *
 * Transfers are split by direction — received vs. sent — and each hosts the
 * holder side of the matching selective-disclosure flow
 * (SELECTIVE_DISCLOSURE.md §12): paste a verifier's request (P_R, ν),
 * generate a D-recipient or D-sender proof in-browser, copy the bundle back.
 */

import { useCallback, useEffect, useState } from "react";
import type { ConfidentialEvent, TransferEvent, DisclosureRequest } from "@ctd/sdk";
import type { ConfidentialWallet } from "@/lib/wallet";
import { useActiveDeployment } from "@/lib/active-deployment";
import { errMsg } from "@/lib/err";
import { CopyButton } from "../copy-button";

export function EventsPanel({ wallet, reloadKey = 0 }: { wallet: ConfidentialWallet; reloadKey?: number }) {
  const { active } = useActiveDeployment();
  const [events, setEvents] = useState<ConfidentialEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEvents(await wallet.listEvents());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [wallet]);

  // Events are the dashboard's ground truth — load on landing, and again
  // whenever the parent bumps reloadKey (after each submitted tx).
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return (
    <section className="rounded border border-neutral-800 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">Your activity</h3>
        <button
          onClick={load}
          disabled={busy}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Reload"}
        </button>
      </div>
      <p className="mb-3 text-xs text-neutral-400">
        Events involving your account ({active.indexerUrl ? "full history via indexer" : "~7-day RPC retention"}).
        Disclose a transfer to prove its amount to a third party — as its receiver or as its sender.
      </p>
      {error && <div className="mb-3 rounded border border-red-800 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
      {events && events.length === 0 && (
        <p className="text-sm text-neutral-500">No activity in the retention window.</p>
      )}
      {!events && busy && <p className="text-sm text-neutral-500">Loading events…</p>}
      {events && (
        <ul className="space-y-2">
          {events.map((ev) => (
            <EventRow key={ev.cursor} ev={ev} wallet={wallet} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Direction = "received" | "sent" | null;

function EventRow({ ev, wallet }: { ev: ConfidentialEvent; wallet: ConfidentialWallet }) {
  const [showDisclose, setShowDisclose] = useState(false);

  const direction: Direction =
    ev.type !== "transfer" ? null : ev.to === wallet.address ? "received" : "sent";
  // Sender disclosure re-derives the ephemeral scalar from this wallet's keys.
  const canDisclose =
    direction === "received" || (direction === "sent" && wallet.canDiscloseSent(ev as TransferEvent));

  return (
    <li className="rounded border border-neutral-900 bg-neutral-500/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeCls(ev.type, direction)}`}>
          {direction ?? ev.type}
        </span>
        <span className="text-xs text-neutral-500">ledger {ev.ledger}</span>
        <span className="font-mono text-xs text-neutral-500">tx {ev.txHash.slice(0, 10)}…</span>
        <span className="flex-1" />
        {direction && canDisclose && (
          <button
            onClick={() => setShowDisclose((v) => !v)}
            className="rounded bg-indigo-900/70 px-2 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-800"
          >
            {showDisclose ? "Close disclosure" : "Disclose amount…"}
          </button>
        )}
        {direction === "sent" && !canDisclose && (
          <span
            className="text-xs text-neutral-600"
            title="This transfer's R_e doesn't match the ephemeral scalar derived from this wallet's keys (it was sent with different keys or a non-deterministic r_e), so a D-sender proof can't be built."
          >
            not disclosable
          </span>
        )}
      </div>
      <div className="mt-1.5 text-xs text-neutral-400">{summary(ev, wallet.address)}</div>
      {showDisclose && direction && (
        <DiscloseFlow ev={ev as TransferEvent} direction={direction} wallet={wallet} />
      )}
    </li>
  );
}

/** Holder side of §12: request in, bundle out. */
function DiscloseFlow({
  ev,
  direction,
  wallet,
}: {
  ev: TransferEvent;
  direction: "received" | "sent";
  wallet: ConfidentialWallet;
}) {
  const [requestJson, setRequestJson] = useState("");
  const [bundleJson, setBundleJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setBundleJson(null);
    try {
      const request = parseRequest(requestJson);
      const bundle =
        direction === "received"
          ? await wallet.discloseReceived(ev, request)
          : await wallet.discloseSent(ev, request);
      setBundleJson(JSON.stringify(bundle, null, 2));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [requestJson, ev, direction, wallet]);

  return (
    <div className="mt-3 space-y-2 rounded border border-indigo-900/60 bg-indigo-950/20 p-3">
      <p className="text-xs text-neutral-400">
        {direction === "received"
          ? "Prove this transfer paid you its exact amount."
          : "Prove you sent this transfer and what it paid the recipient."}{" "}
        Paste the disclosure request you received from the verifying party (their <code>pR</code> key
        and one-time nonce <code>nu</code>). The proof binds to that pair — it is useless to anyone else.
      </p>
      <textarea
        className="h-24 w-full rounded border border-neutral-700 bg-neutral-900 p-2 font-mono text-xs outline-none focus:border-indigo-600"
        placeholder='{"pR":{"x":"0x…","y":"0x…"},"nu":"0x…"}'
        value={requestJson}
        onChange={(e) => setRequestJson(e.target.value)}
      />
      <button
        onClick={generate}
        disabled={busy || !requestJson.trim()}
        className="rounded bg-indigo-700 px-3 py-1.5 text-sm font-medium hover:bg-indigo-600 disabled:opacity-50"
      >
        {busy ? "Proving…" : "Generate disclosure proof"}
      </button>
      {error && <div className="rounded border border-red-800 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
      {bundleJson && (
        <div className="space-y-2">
          <textarea
            readOnly
            className="h-32 w-full rounded border border-neutral-800 bg-neutral-500/10 p-2 font-mono text-xs text-neutral-300"
            value={bundleJson}
          />
          <CopyButton label="Copy bundle" payload={() => bundleJson} />
          <p className="text-xs text-neutral-500">
            Send this bundle back to the requester over your usual channel — it never touches the chain.
          </p>
        </div>
      )}
    </div>
  );
}

function parseRequest(json: string): DisclosureRequest {
  let req: unknown;
  try {
    req = JSON.parse(json);
  } catch {
    throw new Error("request is not valid JSON");
  }
  const r = req as DisclosureRequest;
  if (!r?.pR?.x || !r?.pR?.y || !r?.nu) {
    throw new Error("request must contain pR {x,y} and nu");
  }
  return r;
}

function summary(ev: ConfidentialEvent, me: string): string {
  const who = (a: string) => (a === me ? "you" : `${a.slice(0, 6)}…${a.slice(-4)}`);
  switch (ev.type) {
    case "register":
      return `${who(ev.account)} registered (auditor #${ev.auditorId})`;
    case "deposit":
      return `${who(ev.from)} deposited ${ev.amount} (public) → ${who(ev.to)}`;
    case "merge":
      return `${who(ev.account)} merged receiving → spendable`;
    case "withdraw":
      return `${who(ev.from)} withdrew ${ev.amount} (public) → ${who(ev.to)}`;
    case "transfer":
      return ev.to === me
        ? `from ${who(ev.from)} · amount confidential (ṽ on-chain)`
        : `to ${who(ev.to)} · amount confidential (ṽ on-chain)`;
    default:
      // Compliance/policy events are not shown in the wallet activity list.
      return ev.type;
  }
}

function badgeCls(type: ConfidentialEvent["type"], direction: Direction): string {
  if (direction === "received") return "bg-emerald-900 text-emerald-300";
  if (direction === "sent") return "bg-orange-900 text-orange-300";
  switch (type) {
    case "deposit":
      return "bg-sky-900 text-sky-300";
    case "withdraw":
      return "bg-amber-900 text-amber-300";
    case "register":
      return "bg-purple-900 text-purple-300";
    case "merge":
      return "bg-emerald-900 text-emerald-300";
    default:
      return "bg-neutral-800 text-neutral-300";
  }
}
