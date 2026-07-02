// Offline unit test: a configured indexer's backfill call MUST fail the whole
// sync rather than degrade to RPC-only. StateEngine.sync() persists whatever
// cursor hybridFetchEvents returns; if a transient indexer failure were
// swallowed, that cursor would commit every future sync to the warm,
// indexer-skipping path (event-source.ts), permanently stranding pre-window
// history behind a one-time hiccup. See packages/sdk/src/chain/event-source.ts.

import { hybridFetchEvents } from "../src/chain/event-source.ts";

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

const TOKEN = "CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F";

// Minimal ChainClient stub: healthy RPC with a retention floor at ledger 1000,
// and an RPC events page for the (well within-window) recent leg.
const client = {
  cfg: { contracts: { token: TOKEN } },
  server: {
    getHealth: async () => ({ oldestLedger: 1000 }),
    getEvents: async () => ({
      events: [],
      cursor: undefined,
      latestLedger: 1500,
    }),
  },
};

console.log("hybridFetchEvents — indexer backfill failure:");

// 1. A failing indexer call propagates instead of silently degrading.
{
  const indexer = {
    fetchEvents: async () => {
      throw new Error("indexer worker unreachable");
    },
  };
  let threw = false;
  let message = "";
  try {
    // fromLedger (1) is well before rpcOldest (1000), so the indexer leg is
    // required, not skipped.
    await hybridFetchEvents(client, indexer, { fromLedger: 1 });
  } catch (e) {
    threw = true;
    message = String(e?.message ?? e);
  }
  check("propagates the indexer error", threw);
  check("preserves the original error message", message.includes("indexer worker unreachable"), message);
}

// 2. No indexer configured at all still degrades gracefully (RPC-only) — this
//    is a deliberate configuration choice, not a failure to swallow.
{
  const result = await hybridFetchEvents(client, undefined, { fromLedger: 1 });
  check("no-indexer config still resolves (RPC-only)", result.latestLedger === 1500);
}

console.log(`\nhybrid-indexer-failure: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
