/**
 * D-recipient disclosure-circuit witness (SELECTIVE_DISCLOSURE.md §6).
 *
 * The holder of the account a confidential transfer paid proves to a third
 * party (the "disclosure recipient", identified by Grumpkin key `P_R` and a
 * fresh request nonce `nu`) that the named on-chain event paid them exactly
 * `v_tx`. The amount is decrypted in-witness from the event ciphertext —
 * disclosing requires nothing beyond the wallet keys and the event itself.
 *
 * Public-input order (matches `disclose_recipient/src/main.nr`):
 *   addr_f, PVK_A, R_e, sigma, v_tilde, P_R, nu, R_disc, v_tilde_disc
 */

import type { KeyPair } from "../crypto/keys.js";
import { H, scalarMul, ecdh, type Point } from "../crypto/grumpkin.js";
import { randomScalar } from "../crypto/field.js";
import { DOMAIN } from "../crypto/constants.js";
import { decryptWithDomain, encryptDisclosure } from "../crypto/poseidon2.js";
import { fieldIn, pointIn, type NoirInputs } from "./common.js";

export interface DiscloseRecipientParams {
  /** Holder's contract-bound key set (the event's `to` account). */
  keys: KeyPair;
  /** Per-event fields from the on-chain `Transfer` being disclosed. */
  event: { rE: Point; sigma: bigint; vTilde: bigint };
  /** Disclosure recipient's Grumpkin pubkey `P_R` (§2.1). */
  pR: Point;
  /** Recipient-supplied request nonce `nu` (§2.1). */
  nu: bigint;
  rDisc?: bigint;
}

export interface DiscloseRecipientWitness {
  inputs: NoirInputs;
  /** Plaintext amount the event decrypts to (what the proof discloses). */
  vTx: bigint;
  /** Disclosure ciphertext (§4) — travels in the bundle alongside the proof. */
  rDisc: Point;
  vTildeDisc: bigint;
}

export function buildDiscloseRecipientWitness(
  p: DiscloseRecipientParams,
): DiscloseRecipientWitness {
  const { keys, event, pR, nu } = p;

  // D3/D4 — recipient-side decryption of the event amount. If these keys are
  // not the event's `to` account, this yields garbage; the range guard below
  // catches that long before an unprovable witness reaches the circuit.
  const sX = ecdh(keys.vk, event.rE);
  const vTx = decryptWithDomain(event.vTilde, DOMAIN.TRANSFER_AMOUNT, sX, event.sigma);
  if (vTx >= 1n << 127n) {
    throw new Error(
      "event does not decrypt to a valid amount under these keys — is this transfer addressed to this account?",
    );
  }

  // U-block — seal v_tx to the disclosure recipient (§4).
  const rDiscScalar = p.rDisc ?? randomScalar();
  const rDisc = scalarMul(rDiscScalar, H);
  const sDiscX = ecdh(rDiscScalar, pR);
  const vTildeDisc = encryptDisclosure(vTx, sDiscX, nu);

  const inputs: NoirInputs = {
    sk: fieldIn(keys.sk),
    v_tx: fieldIn(vTx),
    r_disc: fieldIn(rDiscScalar),
    addr_f: fieldIn(keys.addrF),
    ...pointIn("pvk_a", keys.PVK),
    ...pointIn("r_e", event.rE),
    sigma: fieldIn(event.sigma),
    v_tilde: fieldIn(event.vTilde),
    ...pointIn("p_r", pR),
    nu: fieldIn(nu),
    ...pointIn("r_disc", rDisc),
    v_tilde_disc: fieldIn(vTildeDisc),
  };

  return { inputs, vTx, rDisc, vTildeDisc };
}
