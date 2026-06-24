/**
 * Event ingestion over the Soroban RPC `getEvents` API — the ONLY source of
 * the protocol's client-visible secrets (encrypted amounts, salts, balance
 * checkpoints). There is no indexer.
 *
 * ⚠️ Retention: `getEvents` only serves roughly the last 7 days of ledgers.
 * Because spending requires re-deriving `v`/`r` from these events, a client
 * that misses an event before it expires can permanently lose the ability to
 * open the affected balance. The state engine (`state/`) therefore persists
 * decrypted state locally and must sync within the retention window. This is
 * the central, deliberate limitation of the demo.
 *
 * Events are soroban-sdk 26 `#[contractevent]` Map-format: `#[topic]` fields
 * become topics (after the event-name symbol), the rest become a data `ScMap`.
 */

import { xdr, Address, scValToNative, rpc } from "@stellar/stellar-sdk";

import { fromBytesBE, toHex32 } from "../crypto/field.js";
import { pointFromBytes, pointCoords, type Point } from "../crypto/grumpkin.js";
import type { ChainClient } from "./client.js";

export type ConfidentialEventType =
  | "register"
  | "deposit"
  | "merge"
  | "withdraw"
  | "transfer";

interface BaseEvent {
  type: ConfidentialEventType;
  ledger: number;
  txHash: string;
  /**
   * Source-independent event id ({@link naturalEventId}) — the SAME string
   * whether this event came from the RPC or the Goldsky indexer, so the two
   * sources dedupe and cross-resolve. This is NOT the RPC resume cursor; that
   * is the response-level {@link FetchEventsResult.cursor} (still an RPC paging
   * token), which is what the StateEngine persists between syncs.
   */
  cursor: string;
}

export interface RegisterEvent extends BaseEvent {
  type: "register";
  account: string;
  auditorId: number;
}
export interface DepositEvent extends BaseEvent {
  type: "deposit";
  from: string;
  to: string;
  amount: bigint;
}
export interface MergeEvent extends BaseEvent {
  type: "merge";
  account: string;
}
export interface WithdrawEvent extends BaseEvent {
  type: "withdraw";
  from: string;
  to: string;
  amount: bigint;
  rE: Point;
  sigma: bigint;
  bTilde: bigint;
  bAudS: bigint;
}
export interface TransferEvent extends BaseEvent {
  type: "transfer";
  from: string;
  to: string;
  rE: Point;
  vTilde: bigint;
  sigma: bigint;
  bTilde: bigint;
  vAudR: bigint;
  rAudR: bigint;
  vAudS: bigint;
  bAudS: bigint;
}

export type ConfidentialEvent =
  | RegisterEvent
  | DepositEvent
  | MergeEvent
  | WithdrawEvent
  | TransferEvent;

/** The event-name symbols this client understands (topic[0]). Shared by the
 * RPC (XDR) and indexer (Goldsky-JSON) decoders so both accept the same set. */
export const KNOWN: ReadonlySet<string> = new Set([
  "register",
  "deposit",
  "merge",
  "withdraw",
  "transfer",
]);

/**
 * Source-agnostic accessor over an event's data `ScMap`, keyed by field name.
 * The RPC decoder backs it with XDR ({@link dataMap}); the indexer decoder backs
 * it with Goldsky JSON. {@link buildConfidentialEvent} is written against this
 * interface alone, so the two sources share ONE event-shape definition.
 */
export interface EventDataAccessor {
  field(name: string): bigint;
  point(name: string): Point;
  i128(name: string): bigint;
  u32(name: string): number;
}

/**
 * The single source of truth for each event type's shape: which topics are
 * addresses and which data fields are field elements / points / i128 / u32.
 * Both {@link parseEvent} (RPC/XDR) and `parseIndexerEvent` (Goldsky/JSON) call
 * this with their own `addr`/`data` adapters, so the field mapping cannot drift
 * between sources (the invariant the parity test guards). Returns `null` for
 * names outside {@link KNOWN}.
 */
export function buildConfidentialEvent(
  name: string,
  base: { ledger: number; txHash: string; cursor: string },
  addr: (topicIndex: number) => string,
  data: EventDataAccessor,
): ConfidentialEvent | null {
  switch (name) {
    case "register":
      return { ...base, type: "register", account: addr(1), auditorId: data.u32("auditor_id") };
    case "deposit":
      return { ...base, type: "deposit", from: addr(1), to: addr(2), amount: data.i128("amount") };
    case "merge":
      return { ...base, type: "merge", account: addr(1) };
    case "withdraw":
      return {
        ...base,
        type: "withdraw",
        from: addr(1),
        to: addr(2),
        amount: data.i128("amount"),
        rE: data.point("r_e"),
        sigma: data.field("sigma"),
        bTilde: data.field("b_tilde"),
        bAudS: data.field("b_aud_s"),
      };
    case "transfer":
      return {
        ...base,
        type: "transfer",
        from: addr(1),
        to: addr(2),
        rE: data.point("r_e"),
        vTilde: data.field("v_tilde"),
        sigma: data.field("sigma"),
        bTilde: data.field("b_tilde"),
        vAudR: data.field("v_aud_r"),
        rAudR: data.field("r_aud_r"),
        vAudS: data.field("v_aud_s"),
        bAudS: data.field("b_aud_s"),
      };
    default:
      return null;
  }
}

export interface FetchEventsResult {
  events: ConfidentialEvent[];
  /** Last RPC cursor seen — pass back as `startCursor` to resume. */
  cursor: string | undefined;
  /** Latest ledger the RPC has, for staleness/retention checks. */
  latestLedger: number;
}

/**
 * Ledger sequence encoded in an RPC paging-token cursor (`<toid>-<event index>`,
 * where `toid = ledger << 32 | ...`). The cursor the RPC returns marks the end
 * of the ledger range it SCANNED, which can be far behind the chain head. Only
 * ever called on the RPC RESUME cursor ({@link FetchEventsResult.cursor}), never
 * on a per-event {@link BaseEvent.cursor} ({@link naturalEventId}).
 */
export function cursorLedger(cursor: string): number {
  return Number(BigInt(cursor.split("-")[0]!) >> 32n);
}

/**
 * Source-independent id for one on-chain event:
 * `${ledger}-${txHash}-${opIndex}-${eventIndex}`. The RPC and the Goldsky
 * indexer encode an event's coordinates differently (RPC: a `<toid>-<eventOrder>`
 * paging token; Goldsky: a `<ledger>-<txHash>-op-N-event-M` row id), but both
 * carry the same `(ledger, txHash, opIndex, eventIndex)`. Normalizing to this
 * string lets {@link dedupeById} and disclosure {@link resolveEventRef} treat
 * events from either source as one. It is used purely as a match key (it is NOT
 * bound into any proof's public inputs), so the format is free to change.
 */
export function naturalEventId(p: {
  ledger: number;
  txHash: string;
  opIndex: number;
  eventIndex: number;
}): string {
  return `${p.ledger}-${p.txHash}-${p.opIndex}-${p.eventIndex}`;
}

/**
 * The operation and event indices carried inside an RPC event id
 * (`<toid>-<eventOrder>`): `opIndex = toid & 0xfff`, `eventIndex = eventOrder`.
 */
function rpcEventCoords(id: string): { opIndex: number; eventIndex: number } {
  const [toidStr, eventStr] = id.split("-");
  const opIndex = Number(BigInt(toidStr!) & 0xfffn);
  const eventIndex = Number(eventStr ?? "0");
  return { opIndex, eventIndex };
}

/**
 * Fetch and parse all confidential-token events from `startLedger` (or resume
 * from `startCursor`), following pagination to the end. Unknown event types
 * (config setters, spender ops) are skipped.
 */
export async function fetchEvents(
  client: ChainClient,
  opts: { startLedger?: number; startCursor?: string; pageLimit?: number },
): Promise<FetchEventsResult> {
  const tokenId = client.cfg.contracts.token;
  const limit = opts.pageLimit ?? 100;
  const out: ConfidentialEvent[] = [];
  let pageCursor = opts.startCursor;
  let resumeCursor = opts.startCursor;
  let latestLedger = 0;

  if (pageCursor === undefined && opts.startLedger === undefined) {
    throw new Error("fetchEvents requires either startLedger or startCursor");
  }

  for (;;) {
    const filters = [{ type: "contract" as const, contractIds: [tokenId] }];
    const req: rpc.Api.GetEventsRequest = pageCursor
      ? { filters, cursor: pageCursor, limit }
      : { filters, startLedger: opts.startLedger!, limit };

    const resp = await client.server.getEvents(req);
    latestLedger = resp.latestLedger;

    for (const ev of resp.events) {
      const parsed = parseEvent(ev);
      if (parsed) out.push(parsed);
    }
    // GetEventsResponse.cursor is the canonical resume token for the next page.
    const prevCursor = resumeCursor;
    resumeCursor = resp.cursor;
    pageCursor = resp.cursor;

    // A short — even empty — page does NOT mean we reached the chain head:
    // the RPC scans a bounded window of ledgers (~10k) per request and stops
    // there, returning a cursor at the end of the SCANNED range. Page until
    // that cursor catches up with the RPC's latest ledger.
    if (!resp.cursor) break;
    if (cursorLedger(resp.cursor) >= resp.latestLedger) break;
    if (resp.cursor === prevCursor) break; // defensive: no forward progress
  }

  return { events: out, cursor: resumeCursor, latestLedger };
}

/**
 * Event reference (SELECTIVE_DISCLOSURE.md §5.1): pins one on-chain event.
 * `id` is the source-independent {@link naturalEventId} (same value as
 * {@link BaseEvent.cursor}), so a reference pinned from an RPC event resolves
 * against the indexer and vice-versa; `ledger`/`txHash` let the verifier bound
 * the lookup and cross-check the resolution. `id` is a match key only — it is
 * never part of any proof's public inputs (disclosure/verify.ts §5.2).
 */
export interface EventRef {
  ledger: number;
  id: string;
  txHash: string;
}

export const eventRef = (ev: ConfidentialEvent): EventRef => ({
  ledger: ev.ledger,
  id: ev.cursor,
  txHash: ev.txHash,
});

/**
 * Resolve an {@link EventRef} to the single on-chain event it names, reading
 * ONLY the referenced ledger from the RPC (ledger-range mode). Returns `null`
 * if no token-contract event with that id exists there — including when the
 * ledger has aged out of the RPC's ~7-day retention window, which is this
 * demo's accepted limitation. The disclosure verifier (disclosure/verify.ts)
 * treats the result as the sole source of event-derived public inputs.
 */
export async function resolveEventRef(
  client: ChainClient,
  ref: EventRef,
): Promise<ConfidentialEvent | null> {
  const resp = await client.server.getEvents({
    filters: [{ type: "contract", contractIds: [client.cfg.contracts.token] }],
    startLedger: ref.ledger,
    endLedger: ref.ledger + 1,
    limit: 200,
  });
  // Match on the normalized id (parseEvent sets cursor = naturalEventId), so a
  // ref pinned from either source resolves here.
  const matches = resp.events
    .map(parseEvent)
    .filter((ev): ev is ConfidentialEvent => ev !== null && ev.cursor === ref.id);
  if (matches.length !== 1) return null;
  const ev = matches[0]!;
  if (ev.txHash !== ref.txHash) return null;
  return ev;
}

/**
 * Plain-JSON projection of a parsed event (bigints → 0x-hex, points → x/y
 * hex), with its {@link EventRef} attached as `ref`. This is the
 * copy-to-clipboard format the UI exposes so any third party can re-resolve
 * and inspect the event.
 */
export function eventToJson(ev: ConfidentialEvent): Record<string, unknown> {
  const plain: Record<string, unknown> = { ref: eventRef(ev) };
  for (const [k, v] of Object.entries(ev)) {
    if (k === "cursor") continue;
    if (typeof v === "bigint") plain[k] = toHex32(v);
    else if (isPoint(v)) {
      const { x, y } = pointCoords(v);
      plain[k] = { x: toHex32(x), y: toHex32(y) };
    } else plain[k] = v;
  }
  return plain;
}

function isPoint(v: unknown): v is Point {
  return typeof v === "object" && v !== null && "toAffine" in v;
}

function parseEvent(ev: rpc.Api.EventResponse): ConfidentialEvent | null {
  const topics = ev.topic;
  if (topics.length === 0) return null;
  const name = topics[0]!.sym().toString();
  if (!KNOWN.has(name)) return null;

  const { opIndex, eventIndex } = rpcEventCoords(ev.id);
  const base = {
    ledger: ev.ledger,
    txHash: ev.txHash,
    cursor: naturalEventId({ ledger: ev.ledger, txHash: ev.txHash, opIndex, eventIndex }),
  };
  const addr = (i: number): string => Address.fromScVal(topics[i]!).toString();
  return buildConfidentialEvent(name, base, addr, dataMap(ev.value));
}

/** XDR-backed {@link EventDataAccessor} over a Map-format event's data `ScMap`. */
function dataMap(value: xdr.ScVal): EventDataAccessor {
  const byName = new Map<string, xdr.ScVal>();
  for (const e of value.map() ?? []) byName.set(e.key().sym().toString(), e.val());
  const get = (name: string): xdr.ScVal => {
    const v = byName.get(name);
    if (!v) throw new Error(`event data missing field "${name}"`);
    return v;
  };
  return {
    field: (name) => fromBytesBE(new Uint8Array(get(name).bytes())),
    point: (name) => pointFromBytes(new Uint8Array(get(name).bytes())),
    i128: (name) => scValToNative(get(name)) as bigint,
    u32: (name) => get(name).u32(),
  };
}
