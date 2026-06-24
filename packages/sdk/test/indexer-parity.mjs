// Indexer parity test — the make-or-break gate for the Goldsky integration.
//
// For the SAME on-chain events, the indexer JSON decoder (parseIndexerEvent)
// MUST produce byte-identical ConfidentialEvents to the RPC XDR decoder
// (parseEvent). Any divergence in a decoded field element or point silently
// corrupts every reconstructed balance.
//
// This needs a live, synced indexer, so it is env-gated and SKIPS cleanly when
// CTD_INDEXER_URL is unset (keeping `pnpm test` green without infra):
//
//   CTD_INDEXER_URL=https://…workers.dev \
//   CTD_TOKEN=CBF6…N3F \
//   [CTD_RPC_URL=https://soroban-testnet.stellar.org] \
//   [CTD_FROM_LEDGER=<n>] \
//   tsx test/indexer-parity.mjs
import { ChainClient, IndexerClient, fetchEvents, pointCoords } from "../src/index.ts";

// Raw projection: bigints as decimal, points as {x,y} decimal — NO frMod (unlike
// eventToJson's toHex32), so a decoder that produced a non-canonical value
// congruent mod r would still be caught.
function rawJson(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k === "cursor") continue;
    if (typeof v === "bigint") out[k] = v.toString();
    else if (v && typeof v === "object" && "toAffine" in v) {
      const { x, y } = pointCoords(v);
      out[k] = { x: x.toString(), y: y.toString() };
    } else out[k] = v;
  }
  return JSON.stringify(out);
}

const INDEXER_URL = process.env.CTD_INDEXER_URL;
const TOKEN = process.env.CTD_TOKEN;
const RPC_URL = process.env.CTD_RPC_URL ?? "https://soroban-testnet.stellar.org";

if (!INDEXER_URL || !TOKEN) {
  console.log("indexer-parity: SKIPPED (set CTD_INDEXER_URL and CTD_TOKEN to run)");
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

const client = new ChainClient({
  rpcUrl: RPC_URL,
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: { token: TOKEN, verifier: TOKEN, auditor: TOKEN },
});
const indexer = new IndexerClient({ baseUrl: INDEXER_URL });

// A recent window that both sources should hold.
let start = Number(process.env.CTD_FROM_LEDGER ?? 0);
if (!start) {
  const oldest = (await client.server.getHealth()).oldestLedger ?? 0;
  start = oldest + 1;
}

console.log(`indexer-parity: comparing from ledger ${start} (token ${TOKEN.slice(0, 6)}…)`);

const rpc = await fetchEvents(client, { startLedger: start });
const idx = await indexer.fetchEvents({ contractId: TOKEN, startLedger: start });

const rpcById = new Map(rpc.events.map((e) => [e.cursor, e]));
const idxById = new Map(idx.events.map((e) => [e.cursor, e]));

check("indexer returned events", idx.events.length > 0, "indexer is empty for this range");

// Compare every event present in both sources (the overlapping window).
let compared = 0;
for (const [id, rpcEv] of rpcById) {
  const idxEv = idxById.get(id);
  if (!idxEv) {
    check(`indexer has event ${id}`, false, `id ${id} present on RPC, missing from indexer`);
    continue;
  }
  compared++;
  const a = rawJson(rpcEv);
  const b = rawJson(idxEv);
  check(`event ${id} (${rpcEv.type}) decodes identically`, a === b, `RPC:    ${a}\n      INDEX:  ${b}`);
}

check("compared at least one shared event", compared > 0, "no overlapping ids between sources");

console.log(`\nindexer-parity: ${pass} passed, ${fail} failed (${compared} events compared)`);
process.exit(fail === 0 ? 0 : 1);
