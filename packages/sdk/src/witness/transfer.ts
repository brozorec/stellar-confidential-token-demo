/**
 * Transfer-circuit witness (design §7.6). Moves `amount` from the sender's
 * spendable balance into the recipient's receiving balance, and emits dual
 * auditor channels (recipient + sender).
 *
 * Public-input order (matches `storage.rs::confidential_transfer`):
 *   C_spend_A, Y_A, PVK_B, addr_f, K_aud_r, K_aud_s, C_spend', C_transfer,
 *   R_e, v_tilde, b_tilde, sigma, v_tilde_aud_r, r_tilde_aud_r, v_tilde_aud_s,
 *   b_tilde_aud_s
 */

import type { KeyPair } from "../crypto/keys.js";
import { H, commit, scalarMul, ecdh, type Point } from "../crypto/grumpkin.js";
import { randomScalar, frAdd } from "../crypto/field.js";
import { DOMAIN } from "../crypto/constants.js";
import {
  deriveEphemeralRE,
  deriveSpendR,
  deriveTransferBlind,
  encryptAmount,
  encryptBalance,
  spongeSqueeze2,
} from "../crypto/poseidon2.js";
import { fieldIn, pointIn, type NoirInputs } from "./common.js";

export interface TransferParams {
  /** Sender's contract-bound key set. */
  keys: KeyPair;
  /** Sender's current spendable plaintext / blinding. */
  v: bigint;
  r: bigint;
  /** Confidential transfer amount `v_transfer` (0 ≤ v_transfer ≤ v). */
  amount: bigint;
  /** Recipient's public viewing key `PVK_B` (from their account). */
  pvkB: Point;
  /** Recipient's auditor key `K_aud_r`. */
  kAudR: Point;
  /** Sender's auditor key `K_aud_s`. */
  kAudS: Point;
  sigma?: bigint;
  rE?: bigint;
}

export interface TransferWitness {
  inputs: NoirInputs;
  /** On-chain `TransferPayload`. `rE` is the POINT `R_e = r_e·H`. */
  payload: {
    cSpendNew: Point;
    cTransfer: Point;
    rE: Point;
    vTilde: bigint;
    bTilde: bigint;
    sigma: bigint;
    vAudR: bigint;
    rAudR: bigint;
    vAudS: bigint;
    bAudS: bigint;
  };
  /** Post-op sender spendable opening, for the local state engine. */
  next: { v: bigint; r: bigint; cSpend: Point };
  /**
   * Plaintext the recipient would recover from the emitted event (amount and
   * the C_transfer blinding it folds into their receiving balance). Exposed for the
   * e2e flow / tests; on-chain the recipient derives these from the event.
   */
  recipientView: { vTransfer: bigint; rTransfer: bigint; cTransfer: Point };
  /**
   * The ephemeral SCALAR `r_e` for this transfer — the witness that lets the
   * sender later prove what the event ciphertext contains (D-sender,
   * SELECTIVE_DISCLOSURE.md §15.2). Derived as
   * `Poseidon2(EPHEMERAL_KEY, vk, sigma)`, so the sender can recompute it
   * from `vk` + the event's public `sigma` at any time — nothing to retain.
   */
  rEScalar: bigint;
}

export function buildTransferWitness(p: TransferParams): TransferWitness {
  const { keys, v, r, amount, pvkB, kAudR, kAudS } = p;
  if (amount < 0n) throw new Error("transfer amount must be non-negative");
  const vNew = v - amount;
  if (vNew < 0n) throw new Error("transfer amount exceeds spendable balance");

  const sigma = p.sigma ?? randomScalar();
  // Deterministic by default (vk + sigma) so the sender can re-derive r_e
  // from the emitted event alone and build D-sender disclosures later. The
  // circuit only constrains R_e = r_e·H and r_e ≠ 0, so an explicit random
  // p.rE remains equally valid.
  const rE = p.rE ?? deriveEphemeralRE(keys.vk, sigma);

  // Sender balance conservation.
  const cSpend = commit(v, r);
  const rNew = deriveSpendR(keys.vk, sigma);
  const cSpendNew = commit(vNew, rNew);
  const bTilde = encryptBalance(vNew, keys.vk, sigma);
  const rePoint = scalarMul(rE, H);

  // Recipient ECDH → transfer commitment + encrypted amount.
  const sX = ecdh(rE, pvkB);
  const rTransfer = deriveTransferBlind(sX, sigma);
  const cTransfer = commit(amount, rTransfer);
  const vTilde = encryptAmount(amount, sX, sigma);

  // Recipient-auditor channel (amount mask, then r_transfer mask).
  const sArX = ecdh(rE, kAudR);
  const mR = spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, sArX, sigma);
  const vAudR = frAdd(amount, mR[0]);
  const rAudR = frAdd(rTransfer, mR[1]);

  // Sender-auditor channel (amount mask, then balance-checkpoint mask).
  const sAsX = ecdh(rE, kAudS);
  const mS = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sAsX, sigma);
  const vAudS = frAdd(amount, mS[0]);
  const bAudS = frAdd(vNew, mS[1]);

  const inputs: NoirInputs = {
    sk: fieldIn(keys.sk),
    v: fieldIn(v),
    r: fieldIn(r),
    v_transfer: fieldIn(amount),
    r_e: fieldIn(rE),
    ...pointIn("c_spend", cSpend),
    ...pointIn("y", keys.Y),
    ...pointIn("pvk_b", pvkB),
    addr_f: fieldIn(keys.addrF),
    ...pointIn("k_aud_r", kAudR),
    ...pointIn("k_aud_s", kAudS),
    ...pointIn("c_spend_new", cSpendNew),
    ...pointIn("c_transfer", cTransfer),
    ...pointIn("r_e", rePoint),
    v_tilde: fieldIn(vTilde),
    b_tilde: fieldIn(bTilde),
    sigma: fieldIn(sigma),
    v_tilde_aud_r: fieldIn(vAudR),
    r_tilde_aud_r: fieldIn(rAudR),
    v_tilde_aud_s: fieldIn(vAudS),
    b_tilde_aud_s: fieldIn(bAudS),
  };

  return {
    inputs,
    payload: { cSpendNew, cTransfer, rE: rePoint, vTilde, bTilde, sigma, vAudR, rAudR, vAudS, bAudS },
    next: { v: vNew, r: rNew, cSpend: cSpendNew },
    recipientView: { vTransfer: amount, rTransfer, cTransfer },
    rEScalar: rE,
  };
}
