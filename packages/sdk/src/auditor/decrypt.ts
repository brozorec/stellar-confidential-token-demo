/**
 * Auditor-side event decryption (DESIGN.md §8).
 *
 * The auditor holds the Grumpkin secret `k` behind the registry key
 * `K_aud = k·H` and decrypts the auditor ciphertexts every withdraw/transfer
 * event carries — using nothing but the public event and `k`. No viewing
 * keys, no holder cooperation, no extra on-chain data:
 *
 *   s     = ecdh(k, R_e)             (ECDH against the event's ephemeral point;
 *                                     equals the prover's ecdh(r_e, K_aud))
 *   masks = SpongeSqueeze2(δ_aud, s, σ)
 *   plaintext = ciphertext − mask
 *
 * Channels (DESIGN.md §8.1):
 *   - sender channel (δ_aud_s):    transfer amount + sender's post-op balance
 *   - recipient channel (δ_aud_r): transfer amount + per-transfer Pedersen
 *     randomness r_transfer (a full opening of C_transfer, hence of the
 *     recipient's receiving balance between merges)
 *
 * Withdraw events carry only a sender-channel balance checkpoint. Its pad is the
 * SECOND squeeze of the same two-squeeze sponge (the balance slot) — not a
 * standalone Poseidon call, as an earlier revision of the circuit used; the
 * first-squeeze amount slot goes unused because the withdrawn amount is public.
 */

import { H, ecdh, scalarMul, type Point } from "../crypto/grumpkin.js";
import { frMod } from "../crypto/field.js";
import { DOMAIN } from "../crypto/constants.js";
import { spongeSqueeze2 } from "../crypto/poseidon2.js";
import type { TransferEvent, WithdrawEvent } from "../chain/events.js";

/** What the sender's auditor learns from one transfer (§8.1, T_a5–T_a8). */
export interface AuditedSenderChannel {
  /** Transfer amount `v_transfer`. */
  amount: bigint;
  /** Sender's post-transfer spendable balance `v_A − v_transfer`. */
  senderBalance: bigint;
}

/** What the recipient's auditor learns from one transfer (§8.1, T_a1–T_a4). */
export interface AuditedRecipientChannel {
  /** Transfer amount `v_transfer`. */
  amount: bigint;
  /**
   * Per-transfer Pedersen randomness `r_transfer` — with `amount`, a full
   * opening of `C_transfer`.
   */
  rTransfer: bigint;
}

/** Decrypt a transfer's sender-auditor channel with the auditor secret `k`. */
export function auditTransferSenderChannel(
  k: bigint,
  ev: Pick<TransferEvent, "rE" | "sigma" | "vAudS" | "bAudS">,
): AuditedSenderChannel {
  const sX = ecdh(k, ev.rE);
  const [mV, mB] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sX, ev.sigma);
  return { amount: frMod(ev.vAudS - mV), senderBalance: frMod(ev.bAudS - mB) };
}

/** Decrypt a transfer's recipient-auditor channel with the auditor secret `k`. */
export function auditTransferRecipientChannel(
  k: bigint,
  ev: Pick<TransferEvent, "rE" | "sigma" | "vAudR" | "rAudR">,
): AuditedRecipientChannel {
  const sX = ecdh(k, ev.rE);
  const [mV, mR] = spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, sX, ev.sigma);
  return { amount: frMod(ev.vAudR - mV), rTransfer: frMod(ev.rAudR - mR) };
}

/** Both channels of one transfer, decrypted under a single auditor key. */
export interface AuditedTransfer {
  /** Transfer amount `v_transfer` (from the sender channel). */
  amount: bigint;
  /** Sender's post-transfer spendable balance. */
  senderBalance: bigint;
  /** Per-transfer Pedersen randomness (recipient channel). */
  rTransfer: bigint;
  /**
   * The amount decrypts independently on each channel; under the correct key
   * the two MUST agree (the circuit constrains both to the same `v_transfer`).
   * `false` means `k` is not the auditor key for both parties of this event.
   */
  channelsAgree: boolean;
}

/**
 * Decrypt everything a transfer reveals to an auditor holding `k` for BOTH
 * the sender's and the recipient's `auditor_id` — the single-auditor setup
 * this demo deploys (every account registers under auditor id 0).
 */
export function auditTransfer(k: bigint, ev: TransferEvent): AuditedTransfer {
  const s = auditTransferSenderChannel(k, ev);
  const r = auditTransferRecipientChannel(k, ev);
  return {
    amount: s.amount,
    senderBalance: s.senderBalance,
    rTransfer: r.rTransfer,
    channelsAgree: s.amount === r.amount,
  };
}

/**
 * Decrypt a withdraw's sender-auditor balance checkpoint (§8.2): the
 * post-withdrawal spendable balance `v − a`. The amount itself is public in
 * the event.
 *
 * The pad is `sponge_squeeze_2(δ_aud_s, s, σ)[1]` — the same balance slot the
 * transfer sender channel uses (W_a3/W_a4). Index `[0]`, the amount slot, is
 * deliberately skipped.
 */
export function auditWithdraw(
  k: bigint,
  ev: Pick<WithdrawEvent, "rE" | "sigma" | "bAudS">,
): { senderBalance: bigint } {
  const sX = ecdh(k, ev.rE);
  const [, mB] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sX, ev.sigma);
  return { senderBalance: frMod(ev.bAudS - mB) };
}

/** The registry public key `K_aud = k·H` for an auditor secret `k`. */
export function auditorPublicKey(k: bigint): Point {
  return scalarMul(k, H);
}
