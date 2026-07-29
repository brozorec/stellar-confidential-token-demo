// End-to-end proving test: generate a real UltraHonk proof (keccak transcript)
// for each circuit and locally verify it. Also reports the proof byte length
// and public-input count so we know exactly what the contract must receive.
//
// Requires the Barretenberg CRS. bb.js fetches it on first run (network) and
// caches under ~/.bb-crs; offline environments will fail here — that's a
// proving-environment limitation, not a correctness problem (witness
// correctness is already covered by parity.mjs).
import { deriveKeys } from "../src/crypto/keys.ts";
import { addressToField } from "../src/crypto/address.ts";
import { G, scalarMul } from "../src/crypto/grumpkin.ts";
import { randomScalar } from "../src/crypto/field.ts";
import { buildRegisterWitness } from "../src/witness/register.ts";
import { buildWithdrawWitness } from "../src/witness/withdraw.ts";
import { buildTransferWitness } from "../src/witness/transfer.ts";
import { CircuitProver } from "../src/proving/prover.ts";
import { loadCircuit } from "../src/proving/artifacts.ts";

const TOKEN = "CCREDIB3DG3IBVUKBL7QMEK4MTPSTODR7MQ34QY4SQ5LZ5L4WFWNVNXG";
const addrF = addressToField(TOKEN);
// The registering account, bound into the register proof as `acct_f`.
const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const auditorKey = () => scalarMul(randomScalar(), G);

let pass = 0,
  fail = 0;

async function proveAndVerify(name, buildInputs) {
  const prover = new CircuitProver(loadCircuit(name));
  try {
    const t0 = performance.now();
    const result = await prover.prove(buildInputs());
    const ms = Math.round(performance.now() - t0);
    const ok = await prover.verify(result);
    if (ok) {
      pass++;
      console.log(
        `  ✓ ${name}: proof ${result.proof.length}B, ${result.publicInputs.length} public inputs, verified (${ms}ms)`,
      );
    } else {
      fail++;
      console.error(`  ✗ ${name}: local verify returned false`);
    }
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}: ${String(e.message || e).split("\n")[0]}`);
  } finally {
    await prover.destroy();
  }
}

console.log("proving (UltraHonk + keccak):");

await proveAndVerify("register", () => {
  const keys = deriveKeys(randomScalar(), addrF);
  return buildRegisterWitness(keys, ACCOUNT).inputs;
});

await proveAndVerify("withdraw", () => {
  const keys = deriveKeys(randomScalar(), addrF);
  return buildWithdrawWitness({ keys, v: 1000n, r: 0n, amount: 400n, kAudS: auditorKey() }).inputs;
});

await proveAndVerify("transfer", () => {
  const sender = deriveKeys(randomScalar(), addrF);
  const recipient = deriveKeys(randomScalar(), addrF);
  return buildTransferWitness({
    keys: sender,
    v: 1000n,
    r: 0n,
    amount: 250n,
    pvkB: recipient.PVK,
    kAudR: auditorKey(),
    kAudS: auditorKey(),
  }).inputs;
});

console.log(`\nprove: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
