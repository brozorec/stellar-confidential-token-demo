// Fast deterministic-r_e checks (no proving): the transfer witness derives
// r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma) by default, so the sender can
// re-derive it from the event's public fields alone and build a D-sender
// disclosure with no retained state. Random override must keep working, and
// the recipient/auditor channels must be unaffected.
import { deriveKeys } from "../src/crypto/keys.ts";
import { H, scalarMul, ecdh } from "../src/crypto/grumpkin.ts";
import { DOMAIN } from "../src/crypto/constants.ts";
import { deriveEphemeralRE, decryptWithDomain } from "../src/crypto/poseidon2.ts";
import { buildTransferWitness } from "../src/witness/transfer.ts";
import { buildDiscloseSenderWitness } from "../src/witness/disclose-sender.ts";
import { auditTransfer, auditorPublicKey } from "../src/auditor/decrypt.ts";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } };

const addrF = 0x1234n;
const sender = deriveKeys(1111n, addrF);
const recipient = deriveKeys(2222n, addrF);
const kAud = auditorPublicKey(42n);
const v = 1_000_000n, r = 777n, amount = 123_456n;

const tw = buildTransferWitness({
  keys: sender, v, r, amount,
  pvkB: recipient.PVK, kAudR: kAud, kAudS: kAud,
});

// Default r_e is the deterministic derivation, and R_e matches it.
ok(tw.rEScalar === deriveEphemeralRE(sender.vk, tw.payload.sigma), "default r_e == Poseidon2(EPHEMERAL_KEY, vk, sigma)");
ok(scalarMul(tw.rEScalar, H).equals(tw.payload.rE), "R_e == derived r_e · H");
ok(tw.rEScalar !== 0n, "derived r_e nonzero (T8)");

// Sender-side recovery from event fields alone (vk + public sigma + R_e).
const recovered = deriveEphemeralRE(sender.vk, tw.payload.sigma);
ok(scalarMul(recovered, H).equals(tw.payload.rE), "recovered scalar reproduces the event's R_e");

// D-sender witness builds from the RECOVERED scalar — no retention involved.
const ds = buildDiscloseSenderWitness({
  keys: sender,
  rEScalar: recovered,
  event: { rE: tw.payload.rE, sigma: tw.payload.sigma, vTilde: tw.payload.vTilde },
  pvkB: recipient.PVK,
  pR: scalarMul(99n, H),
  nu: 0xabcn,
});
ok(ds.vTx === amount, "D-sender from re-derived r_e discloses the right amount");

// Determinism + per-sigma uniqueness.
ok(deriveEphemeralRE(sender.vk, tw.payload.sigma) === tw.rEScalar, "derivation is deterministic");
ok(deriveEphemeralRE(sender.vk, tw.payload.sigma + 1n) !== tw.rEScalar, "fresh sigma -> fresh r_e");
ok(deriveEphemeralRE(recipient.vk, tw.payload.sigma) !== tw.rEScalar, "different vk -> different r_e");

// Recipient decryption and auditor channels are unaffected by derived r_e.
const sB = ecdh(recipient.vk, tw.payload.rE);
ok(
  decryptWithDomain(tw.payload.vTilde, DOMAIN.TRANSFER_AMOUNT, sB, tw.payload.sigma) === amount,
  "recipient still decrypts v_transfer",
);
const audited = auditTransfer(42n, { ...tw.payload });
ok(audited.amount === amount && audited.channelsAgree, "auditor channels still decrypt");

// Explicit random override is still honored (legacy behavior).
const twRand = buildTransferWitness({
  keys: sender, v, r, amount,
  pvkB: recipient.PVK, kAudR: kAud, kAudS: kAud,
  rE: 31337n,
});
ok(twRand.rEScalar === 31337n, "explicit p.rE override respected");
ok(scalarMul(31337n, H).equals(twRand.payload.rE), "override R_e consistent");

console.log(`\nephemeral: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
