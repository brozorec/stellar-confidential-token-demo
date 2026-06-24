// Offline unit test for dedupeById — the merge guard that keeps the hybrid
// RPC+indexer stream safe to feed into StateEngine.apply (which is NOT
// idempotent: a duplicated deposit/transfer would double-count the balance).
import { dedupeById } from "../src/chain/event-source.ts";

let pass = 0,
  fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// Minimal events — dedupeById only reads `.cursor` (id) and `.ledger`.
const ev = (cursor, ledger, type = "deposit") => ({ type, cursor, ledger, txHash: "tx" });

console.log("dedupeById:");

// 1. Duplicate ids collapse to a single event.
{
  const out = dedupeById([ev("a", 1), ev("a", 1), ev("b", 2)]);
  check("collapses duplicate ids", out.length === 2);
  check("keeps distinct ids", out.map((e) => e.cursor).join(",") === "a,b");
}

// 2. Stable sort by ledger only; same-ledger events keep INPUT order (the
//    correctly-ordered source order), not a fragile id-string re-sort.
{
  const out = dedupeById([ev("z", 5), ev("a", 2), ev("m", 2)]);
  check(
    "stable-sorts by ledger, preserving intra-ledger input order",
    out.map((e) => `${e.ledger}:${e.cursor}`).join(",") === "2:a,2:m,5:z",
  );
}

// 2b. Same-ledger events are NOT reordered by id string (e.g. '-10' vs '-2'):
//     a deposit (id '…-2') then a merge (id '…-10') in one ledger must stay in
//     that order, since StateEngine.apply folds receiving→spendable on merge.
{
  const out = dedupeById([ev("9-2", 9, "deposit"), ev("9-10", 9, "merge")]);
  check(
    "does not re-sort same-ledger ids lexicographically",
    out.map((e) => e.cursor).join(",") === "9-2,9-10",
  );
}

// 3. Boundary overlap between the indexer (old) and RPC (recent) legs: a single
//    shared event at the seam must not be applied twice.
{
  const old = [ev("00-0", 1), ev("00-1", 2)];
  const recent = [ev("00-1", 2), ev("00-2", 3)]; // "00-1" appears in both legs
  const out = dedupeById([...old, ...recent]);
  check("dedupes a boundary-overlap event", out.length === 3);
  check(
    "preserves full ledger order across the seam",
    out.map((e) => e.cursor).join(",") === "00-0,00-1,00-2",
  );
}

// 4. Empty input is fine.
check("handles empty input", dedupeById([]).length === 0);

console.log(`\ndedup: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
