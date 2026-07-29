/**
 * Withdraw-circuit witness (design §7.5). Debits `amount` from the spendable
 * balance to the public SEP-41 side, re-blinds the remainder, and emits a
 * sender-auditor balance checkpoint.
 *
 * Public-input order (matches `storage.rs::withdraw`):
 *   C_spend, Y, addr_f, K_aud_s, a, C_spend', sigma, b_tilde, R_e, b_tilde_aud_s
 */

import type { KeyPair } from "../crypto/keys.js";
import { H, commit, scalarMul, ecdh, type Point } from "../crypto/grumpkin.js";
import { randomScalar } from "../crypto/field.js";
import {
  deriveSpendR,
  encryptBalance,
  encryptAuditorSenderBalance,
} from "../crypto/poseidon2.js";
import { fieldIn, pointIn, type NoirInputs } from "./common.js";

export interface WithdrawParams {
  /** Spender's contract-bound key set. */
  keys: KeyPair;
  /** Current spendable-balance plaintext value `v`. */
  v: bigint;
  /** Current spendable-balance blinding factor `r` (opening of C_spend). */
  r: bigint;
  /** Public withdrawal amount `a` (0 ≤ a ≤ v). */
  amount: bigint;
  /** Sender's auditor key `K_aud_s` (from the auditor registry). */
  kAudS: Point;
  /** Optional fixed salt (defaults to a fresh random scalar). */
  sigma?: bigint;
  /** Optional fixed ephemeral scalar `r_e ≠ 0` (defaults to random). */
  rE?: bigint;
}

export interface WithdrawWitness {
  inputs: NoirInputs;
  /** On-chain `WithdrawPayload`. `rE` is the POINT `R_e = r_e·H`. */
  payload: {
    cSpendNew: Point;
    bTilde: bigint;
    rE: Point;
    sigma: bigint;
    bAudS: bigint;
  };
  /** Post-op spendable opening, for the local state engine. */
  next: { v: bigint; r: bigint; cSpend: Point };
}

export function buildWithdrawWitness(p: WithdrawParams): WithdrawWitness {
  const { keys, v, r, amount, kAudS } = p;
  if (amount < 0n) throw new Error("withdraw amount must be non-negative");
  const vNew = v - amount;
  if (vNew < 0n) throw new Error("withdraw amount exceeds spendable balance");

  const sigma = p.sigma ?? randomScalar();
  const rE = p.rE ?? randomScalar(); // randomScalar() is always nonzero (T8/W8)

  const cSpend = commit(v, r);
  const rNew = deriveSpendR(keys.vk, sigma);
  const cSpendNew = commit(vNew, rNew);
  const bTilde = encryptBalance(vNew, keys.vk, sigma);
  const rePoint = scalarMul(rE, H);
  const sAsX = ecdh(rE, kAudS);
  const bAudS = encryptAuditorSenderBalance(vNew, sAsX, sigma);

  const inputs: NoirInputs = {
    sk: fieldIn(keys.sk),
    v: fieldIn(v),
    r: fieldIn(r),
    r_e: fieldIn(rE),
    ...pointIn("c_spend", cSpend),
    ...pointIn("y", keys.Y),
    addr_f: fieldIn(keys.addrF),
    ...pointIn("k_aud_s", kAudS),
    a: fieldIn(amount),
    ...pointIn("c_spend_new", cSpendNew),
    sigma: fieldIn(sigma),
    b_tilde: fieldIn(bTilde),
    ...pointIn("r_e", rePoint),
    b_tilde_aud_s: fieldIn(bAudS),
  };

  return {
    inputs,
    payload: { cSpendNew, bTilde, rE: rePoint, sigma, bAudS },
    next: { v: vNew, r: rNew, cSpend: cSpendNew },
  };
}
