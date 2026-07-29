// XDR envelope encoding test. Verifies the `{payload, proof}` Bytes argument:
//   1. round-trips structurally (decode back to a sorted ScMap),
//   2. uses flat 64-byte Points and 32-byte fields,
//   3. byte-matches stellar-sdk's canonical nativeToScVal encoding.
// The definitive check is on-chain from_xdr (e2e), but a nativeToScVal match
// gives strong confidence the contracttype layout is right.
import { xdr } from "@stellar/stellar-sdk";

import { deriveKeys } from "../src/crypto/keys.ts";
import { addressToField } from "../src/crypto/address.ts";
import { randomScalar } from "../src/crypto/field.ts";
import { pointToBytes } from "../src/crypto/grumpkin.ts";
import { buildRegisterWitness } from "../src/witness/register.ts";
import { buildTransferWitness } from "../src/witness/transfer.ts";
import { encodeRegisterData, encodeTransferData } from "../src/chain/payload.ts";

let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.error("  ✗ " + m)));

const addrF = addressToField("CCREDIB3DG3IBVUKBL7QMEK4MTPSTODR7MQ34QY4SQ5LZ5L4WFWNVNXG");
const keys = deriveKeys(randomScalar(), addrF);
const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// Fake proof bytes (encoding is independent of proof validity).
const proof = new Uint8Array(14592).fill(7);

console.log("register envelope:");
const w = buildRegisterWitness(keys, ACCOUNT);
const dataArg = encodeRegisterData(w, proof);

ok(dataArg.switch().name === "scvBytes", "data arg is scvBytes");
const inner = xdr.ScVal.fromXDR(dataArg.bytes());
ok(inner.switch().name === "scvMap", "inner is scvMap");

// Keys present and sorted: payload, proof.
const keysInOrder = inner.map().map((e) => e.key().sym().toString());
ok(JSON.stringify(keysInOrder) === JSON.stringify(["payload", "proof"]), "top keys sorted [payload, proof]");

const payloadEntry = inner.map().find((e) => e.key().sym().toString() === "payload").val();
const proofEntry = inner.map().find((e) => e.key().sym().toString() === "proof").val();
ok(proofEntry.bytes().length === 14592, "proof is 14592 bytes");

const payloadKeys = payloadEntry.map().map((e) => e.key().sym().toString());
ok(JSON.stringify(payloadKeys) === JSON.stringify(["pvk", "y"]), "payload keys sorted [pvk, y]");
const yEntry = payloadEntry.map().find((e) => e.key().sym().toString() === "y").val();
ok(yEntry.bytes().length === 64, "Point y is flat 64 bytes");
ok(
  Buffer.from(pointToBytes(keys.Y)).equals(yEntry.bytes()),
  "Point y bytes == pointToBytes(Y)",
);

// Soroban #[contracttype] structs use Symbol keys (ScVal type 15), NOT String
// (type 14). nativeToScVal(plainObject) defaults to String keys and would be
// rejected by from_xdr, so assert the key type explicitly — this is the real
// invariant the contract requires.
ok(
  inner.map().every((e) => e.key().switch().name === "scvSymbol"),
  "top map keys are Symbols (not Strings)",
);
ok(
  payloadEntry.map().every((e) => e.key().switch().name === "scvSymbol"),
  "payload map keys are Symbols (not Strings)",
);

console.log("transfer envelope:");
const recipient = deriveKeys(randomScalar(), addrF);
const tw = buildTransferWitness({
  keys,
  v: 1000n,
  r: 0n,
  amount: 250n,
  pvkB: recipient.PVK,
  kAudR: recipient.PVK,
  kAudS: keys.PVK,
});
const tData = encodeTransferData(tw, proof);
const tInner = xdr.ScVal.fromXDR(tData.bytes());
const tPayload = tInner.map().find((e) => e.key().sym().toString() === "payload").val();
const tKeys = tPayload.map().map((e) => e.key().sym().toString());
ok(
  JSON.stringify(tKeys) ===
    JSON.stringify([
      "b_tilde",
      "b_tilde_aud_s",
      "c_spend_new",
      "c_transfer",
      "r_e_point",
      "r_tilde_aud_r",
      "sigma",
      "v_tilde",
      "v_tilde_aud_r",
      "v_tilde_aud_s",
    ]),
  "transfer payload keys sorted (10 fields)",
);
const cTransfer = tPayload.map().find((e) => e.key().sym().toString() === "c_transfer").val();
ok(cTransfer.bytes().length === 64, "c_transfer is 64 bytes");
const bTilde = tPayload.map().find((e) => e.key().sym().toString() === "b_tilde").val();
ok(bTilde.bytes().length === 32, "b_tilde is 32 bytes");

console.log(`\npayload: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
