// Offline decode test for the compliance/policy membership events
// (frozen/unfrozen + allowlist/blocklist user_*). These all share the
// [symbol, account] / empty-data shape, so buildConfidentialEvent must map each
// to { type, account } using ONLY topic[1] — it must never touch the data
// accessor (the events carry no data fields). Runs with no infra.

import { buildConfidentialEvent, KNOWN } from "../src/chain/events.ts";

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

const ACCOUNT = "GBYUUJHG6FE7BTHJYBCSV6YTLLDPVUE5W2LWMTWVDTZ6KOAVNBI6XHIO";
const COMPLIANCE = [
  "frozen",
  "unfrozen",
  "user_allowed",
  "user_disallowed",
  "user_blocked",
  "user_unblocked",
];

// A data accessor that throws on ANY access — proves the decoder never reads
// data for these events (mirrors the empty-Map on-chain shape).
const noData = {
  field: (n) => {
    throw new Error(`unexpected data.field(${n})`);
  },
  point: (n) => {
    throw new Error(`unexpected data.point(${n})`);
  },
  i128: (n) => {
    throw new Error(`unexpected data.i128(${n})`);
  },
  u32: (n) => {
    throw new Error(`unexpected data.u32(${n})`);
  },
};

const base = { ledger: 100, txHash: "deadbeef", cursor: "100-deadbeef-0-0" };
const addr = (i) => (i === 1 ? ACCOUNT : (() => { throw new Error(`unexpected addr(${i})`); })());

for (const sym of COMPLIANCE) {
  check(`${sym}: in KNOWN`, KNOWN.has(sym));
  let ev;
  try {
    ev = buildConfidentialEvent(sym, base, addr, noData);
  } catch (e) {
    check(`${sym}: decodes without touching data`, false, String(e?.message ?? e));
    continue;
  }
  check(`${sym}: type + account`, ev && ev.type === sym && ev.account === ACCOUNT, JSON.stringify(ev));
  check(`${sym}: carries base fields`, ev && ev.ledger === 100 && ev.cursor === base.cursor);
}

// Sanity: an unknown symbol is still rejected.
check("unknown symbol → null", buildConfidentialEvent("definitely_not_an_event", base, addr, noData) === null);

console.log(`\ncompliance-events: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
