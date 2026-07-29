// Fast auditor-decryption round-trip (no proving): build transfer/withdraw
// witnesses with a known auditor secret k (K_aud = k·H), then check that the
// auditor-side decryptors recover the amount, the sender's post-op balance,
// and r_transfer from nothing but the would-be event fields and k.
import { deriveKeys } from "../src/crypto/keys.ts";
import { H, scalarMul, commit } from "../src/crypto/grumpkin.ts";
import { buildTransferWitness } from "../src/witness/transfer.ts";
import { buildWithdrawWitness } from "../src/witness/withdraw.ts";
import {
  auditTransfer,
  auditTransferSenderChannel,
  auditTransferRecipientChannel,
  auditWithdraw,
  auditorPublicKey,
} from "../src/auditor/decrypt.ts";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } };

const addrF = 0x1234n;
const sender = deriveKeys(1111n, addrF);
const recipient = deriveKeys(2222n, addrF);
const k = 0x00c066da47bac8f87cd3eb9a36c37b417ca40cfa2730e7d8eb7f0bf939d11832n;
const kAud = auditorPublicKey(k);
ok(kAud.equals(scalarMul(k, H)), "auditorPublicKey == k·H");

// --- transfer: both channels under the single demo auditor key -------------
const v = 1_000_000n, r = 777n, amount = 123_456n;
const tw = buildTransferWitness({
  keys: sender, v, r, amount,
  pvkB: recipient.PVK, kAudR: kAud, kAudS: kAud,
});
// Project the payload into the event shape the auditor sees on-chain.
const tev = {
  rE: tw.payload.rE, sigma: tw.payload.sigma,
  vAudR: tw.payload.vAudR, rAudR: tw.payload.rAudR,
  vAudS: tw.payload.vAudS, bAudS: tw.payload.bAudS,
};

const audited = auditTransfer(k, tev);
ok(audited.amount === amount, "transfer: amount recovered");
ok(audited.senderBalance === v - amount, "transfer: sender post-balance recovered");
ok(audited.channelsAgree, "transfer: both channels agree");
// r_transfer must open the emitted C_transfer: commit(v_transfer, r_transfer) == C_transfer.
ok(
  commit(audited.amount, audited.rTransfer).equals(tw.payload.cTransfer),
  "transfer: (v_transfer, r_transfer) opens C_transfer",
);

const sCh = auditTransferSenderChannel(k, tev);
const rCh = auditTransferRecipientChannel(k, tev);
ok(sCh.amount === amount && sCh.senderBalance === v - amount, "sender channel standalone");
ok(rCh.amount === amount && rCh.rTransfer === audited.rTransfer, "recipient channel standalone");

// Wrong key: decrypts to garbage and the channels disagree.
const wrong = auditTransfer(k + 1n, tev);
ok(!wrong.channelsAgree, "wrong key: channels disagree");
ok(wrong.amount !== amount, "wrong key: amount not recovered");

// --- withdraw: sender-channel balance checkpoint ----------------------------
const ww = buildWithdrawWitness({ keys: sender, v, r, amount: 400n, kAudS: kAud });
const wAudited = auditWithdraw(k, {
  rE: ww.payload.rE, sigma: ww.payload.sigma, bAudS: ww.payload.bAudS,
});
ok(wAudited.senderBalance === v - 400n, "withdraw: post-balance recovered");

console.log(`\nauditor: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
