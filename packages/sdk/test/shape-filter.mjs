// Shape-filter parity test — pins the Goldsky JSON encoding that the indexer's
// Goldsky pipeline relies on to select the confidential-token event family by
// SHAPE instead of by a hardcoded contract id (goldsky/pipeline-testnet.yaml).
//
// The pipeline keeps an event when one of these holds (see the YAML WHERE):
//
//   register : symbol = 'register' AND topic[1] address, topic[2] absent,
//              AND data LIKE '%auditor%'
//   transfer : symbol IN ('transfer','withdraw') AND data LIKE '%sigma%'
//   withdraw
//   deposit  : symbol = 'deposit' AND topic[2] is an address AND data LIKE '%amount%'
//   merge    : symbol = 'merge'   AND topic[1] is an address, topic[2] absent,
//              AND data has no fields (empty Map)
//
// Every branch identifies the confidential family by a FIELD, not just the
// symbol — so foreign events that reuse these symbols are excluded: the SAC /
// SEP-41 `transfer` firehose (also a Map, {amount, to_muxed_id}), vault /
// budgeting-app `deposit`s, etc. `sigma`/`auditor` (and `amount`/`symbol` as key
// names) cannot occur inside hex bytes / i128 / base32 addresses, so the
// substring tests are unambiguous. If Goldsky changes
// how it serializes ScVals — or the contract stops emitting these fields — the
// predicates silently stop matching and the indexer goes empty; this test makes
// that failure loud and visible.
//
// Env-gated (needs a live, synced indexer), SKIPS cleanly when unset:
//
//   CTD_INDEXER_URL=https://…workers.dev \
//   CTD_TOKEN=CBF6…N3F \
//   [CTD_FROM_LEDGER=<n>] \
//   tsx test/shape-filter.mjs

const INDEXER_URL = process.env.CTD_INDEXER_URL;
const TOKEN = process.env.CTD_TOKEN;

if (!INDEXER_URL || !TOKEN) {
  console.log("shape-filter: SKIPPED (set CTD_INDEXER_URL and CTD_TOKEN to run)");
  process.exit(0);
}

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const KNOWN = new Set(["register", "deposit", "merge", "transfer", "withdraw"]);

const hasKey = (value, name) => (value?.map ?? []).some((e) => e?.key?.symbol === name);
const isEmptyMap = (value) => Array.isArray(value?.map) && value.map.length === 0;
const topicAddr = (topic, i) => topic?.[i]?.address;

// Mirror the pipeline's WHERE predicate in JS, against the RAW Goldsky row, so
// the assertion is the same logic the SQL applies. The pipeline's `data LIKE
// '%x%'` substring tests correspond to the map-key checks below; the topic-arity
// tests correspond to topicAddr().
function pipelineKeeps(topic, value) {
  const sym = topic?.[0]?.symbol;
  switch (sym) {
    case "register":
      return topicAddr(topic, 1) != null && topicAddr(topic, 2) == null && hasKey(value, "auditor_id");
    case "transfer":
    case "withdraw":
      return hasKey(value, "sigma");
    case "deposit":
      return topicAddr(topic, 2) != null && hasKey(value, "amount");
    case "merge":
      return topicAddr(topic, 1) != null && topicAddr(topic, 2) == null && isEmptyMap(value);
    default:
      return false;
  }
}

// Fetch RAW rows (not parsed events): we are validating Goldsky's JSON shape,
// which the SDK's parseIndexerEvent deliberately normalizes away.
const base = INDEXER_URL.replace(/\/?$/, "/");
const start = Number(process.env.CTD_FROM_LEDGER ?? 0);
const rows = [];
let cursor;
for (;;) {
  const u = new URL(`contracts/${TOKEN}/events`, base);
  if (cursor) u.searchParams.set("cursor", cursor);
  else if (start) u.searchParams.set("startLedger", String(start));
  u.searchParams.set("limit", "1000");
  const resp = await fetch(u);
  if (!resp.ok) {
    console.error(`shape-filter: indexer ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const page = await resp.json();
  rows.push(...(page.events ?? []));
  if (!page.cursor || (page.events ?? []).length === 0) break;
  cursor = page.cursor;
}

console.log(`shape-filter: ${rows.length} rows for token ${TOKEN.slice(0, 6)}…\n`);
check("indexer returned rows", rows.length > 0, "no rows — pipeline empty or wrong token");

const bySymbol = new Map();
for (const r of rows) {
  const sym = r.topic?.[0]?.symbol ?? "<none>";
  if (!bySymbol.has(sym)) bySymbol.set(sym, r);
}

// 1. Every row the indexer holds must satisfy the pipeline's own filter — i.e.
//    the SQL predicate and the real JSON encoding agree.
const violating = rows.filter((r) => !pipelineKeeps(r.topic, r.value));
check(
  "every stored row matches the pipeline shape filter",
  violating.length === 0,
  violating.length ? `${violating.length} row(s) would be dropped by the filter, e.g. ${JSON.stringify(violating[0]?.topic)}` : "",
);

// 2. The encoding invariants each branch leans on, asserted per symbol present.
for (const [sym, r] of bySymbol) {
  if (!KNOWN.has(sym)) continue;
  const t = r.topic, v = r.value;
  const keys = () => (v?.map ?? []).map((e) => e?.key?.symbol).join(",");
  check(`${sym}: topic[0].symbol present`, t?.[0]?.symbol === sym, JSON.stringify(t)?.slice(0, 200));
  if (sym === "register") {
    check(`${sym}: shape [register, account] + 'auditor_id'`, topicAddr(t, 1) != null && topicAddr(t, 2) == null && hasKey(v, "auditor_id"), `topics=${JSON.stringify(t)?.slice(0, 160)} keys=${keys()}`);
  } else if (sym === "transfer" || sym === "withdraw") {
    check(`${sym}: carries the 'sigma' ciphertext key`, hasKey(v, "sigma"), `keys: ${keys()}`);
  } else if (sym === "deposit") {
    check(`${sym}: shape [deposit, from, to] + 'amount'`, topicAddr(t, 2) != null && hasKey(v, "amount"), `topics=${JSON.stringify(t)?.slice(0, 160)} keys=${keys()}`);
  } else if (sym === "merge") {
    check(`${sym}: shape [merge, account] + empty data`, topicAddr(t, 1) != null && topicAddr(t, 2) == null && isEmptyMap(v), `topics=${JSON.stringify(t)?.slice(0, 160)} value=${JSON.stringify(v)?.slice(0, 120)}`);
  }
}

console.log(`\nshape-filter: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
