// Circuit-parity test: the ultimate gate for the crypto + witness layers.
//
// For each circuit we build a witness entirely from SDK-side crypto (Grumpkin
// generators, Poseidon2 sponge, ECDH, the derivation formulas) and ask the
// REAL compiled circuit (via noir_js) to solve it. If execution succeeds, every
// in-circuit `assert(derived == public_input)` held — meaning the SDK computed
// Y, PVK, vk, C_spend', C_transfer, R_e, the encrypted scalars, and BOTH auditor
// channels exactly as the circuit does. Negative cases tamper one public input
// and require rejection, proving the test actually constrains.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Noir } from "@noir-lang/noir_js";

import { deriveKeys } from "../src/crypto/keys.ts";
import { addressToField } from "../src/crypto/address.ts";
import { G, scalarMul } from "../src/crypto/grumpkin.ts";
import { randomScalar } from "../src/crypto/field.ts";
import { buildRegisterWitness } from "../src/witness/register.ts";
import { buildWithdrawWitness } from "../src/witness/withdraw.ts";
import { buildTransferWitness } from "../src/witness/transfer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const circuit = (name) =>
  JSON.parse(readFileSync(join(here, "..", "circuits", `${name}.json`), "utf8"));

// Any valid 56-char strkey works as the bound token address.
const TOKEN = "CCREDIB3DG3IBVUKBL7QMEK4MTPSTODR7MQ34QY4SQ5LZ5L4WFWNVNXG";
const addrF = addressToField(TOKEN);
// The registering account, bound into the register proof as `acct_f` (L-06).
const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// A mock auditor key: any on-curve, non-identity Grumpkin point.
const auditorKey = () => scalarMul(randomScalar(), G);

let pass = 0,
  fail = 0;
async function expectOk(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n      ${String(e.message || e).split("\n")[0]}`);
  }
}
async function expectReject(name, fn) {
  try {
    await fn();
    fail++;
    console.error(`  ✗ ${name} (expected rejection, but it passed)`);
  } catch {
    pass++;
    console.log(`  ✓ ${name} (rejected as expected)`);
  }
}

const registerNoir = new Noir(circuit("register"));
const withdrawNoir = new Noir(circuit("withdraw"));
const transferNoir = new Noir(circuit("transfer"));

console.log("register:");
await expectOk("SDK Y/PVK satisfy the circuit", async () => {
  const keys = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildRegisterWitness(keys, ACCOUNT);
  await registerNoir.execute(inputs);
});
// No negative case for `acct_f`: it is referenced by no gate, so witness
// solving accepts any value. Its binding lives in the proof transcript and is
// only observable at verification (see witness/register.ts).
await expectReject("tampered PVK.x rejected", async () => {
  const keys = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildRegisterWitness(keys, ACCOUNT);
  await registerNoir.execute({ ...inputs, pvk_x: "0x1" });
});

console.log("withdraw:");
await expectOk("deposit-funded partial withdraw (v=1000, a=400)", async () => {
  const keys = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildWithdrawWitness({
    keys,
    v: 1000n,
    r: 0n,
    amount: 400n,
    kAudS: auditorKey(),
  });
  await withdrawNoir.execute(inputs);
});
await expectOk("full withdraw (v=1000, a=1000 → v_new=0)", async () => {
  const keys = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildWithdrawWitness({ keys, v: 1000n, r: 0n, amount: 1000n, kAudS: auditorKey() });
  await withdrawNoir.execute(inputs);
});
await expectReject("tampered b_tilde_aud_s rejected", async () => {
  const keys = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildWithdrawWitness({ keys, v: 1000n, r: 0n, amount: 400n, kAudS: auditorKey() });
  await withdrawNoir.execute({ ...inputs, b_tilde_aud_s: "0x123456" });
});

console.log("transfer:");
await expectOk("dual-auditor transfer (v=1000, v_tx=250)", async () => {
  const sender = deriveKeys(randomScalar(), addrF);
  const recipient = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildTransferWitness({
    keys: sender,
    v: 1000n,
    r: 0n,
    amount: 250n,
    pvkB: recipient.PVK,
    kAudR: auditorKey(),
    kAudS: auditorKey(),
  });
  await transferNoir.execute(inputs);
});
await expectReject("tampered v_tilde_aud_r rejected", async () => {
  const sender = deriveKeys(randomScalar(), addrF);
  const recipient = deriveKeys(randomScalar(), addrF);
  const { inputs } = buildTransferWitness({
    keys: sender,
    v: 1000n,
    r: 0n,
    amount: 250n,
    pvkB: recipient.PVK,
    kAudR: auditorKey(),
    kAudS: auditorKey(),
  });
  await transferNoir.execute({ ...inputs, v_tilde_aud_r: "0xdead" });
});

console.log(`\nparity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
