/**
 * D-sender disclosure-circuit witness (SELECTIVE_DISCLOSURE.md §7).
 *
 * The ORIGINATOR of a confidential transfer proves to a third party that they
 * paid exactly `v_tx` to the on-chain `to` recorded in the event. The event
 * ciphertext is keyed to the recipient's `PVK_B`, so the sender's necessary
 * witness is the ephemeral scalar `r_e` from transfer time — recomputed as
 * `Poseidon2(EPHEMERAL_KEY, vk, sigma)` from the event's public `sigma`
 * (§15.2; see `deriveEphemeralRE`), so no per-transfer state is needed.
 *
 * Public-input order (matches `disclose_sender/src/main.nr`):
 *   addr_f, PVK_A, R_e, sigma, v_tilde, PVK_B, P_R, nu, R_disc, v_tilde_disc
 */

import type { KeyPair } from "../crypto/keys.js";
import { H, scalarMul, ecdh, pointCoords, type Point } from "../crypto/grumpkin.js";
import { randomScalar } from "../crypto/field.js";
import { DOMAIN } from "../crypto/constants.js";
import { decryptWithDomain, encryptDisclosure } from "../crypto/poseidon2.js";
import { fieldIn, pointIn, type NoirInputs } from "./common.js";

export interface DiscloseSenderParams {
  /** Originator's contract-bound key set (the event's `from` account). */
  keys: KeyPair;
  /** The transfer's ephemeral SCALAR, re-derived via `deriveEphemeralRE` (§15.2). */
  rEScalar: bigint;
  /** Per-event fields from the on-chain `Transfer` being disclosed. */
  event: { rE: Point; sigma: bigint; vTilde: bigint };
  /** Transfer recipient's stored viewing key (from the account at `E.to`). */
  pvkB: Point;
  /** Disclosure recipient's Grumpkin pubkey `P_R` (§2.1). */
  pR: Point;
  /** Recipient-supplied request nonce `nu` (§2.1). */
  nu: bigint;
  rDisc?: bigint;
}

export interface DiscloseSenderWitness {
  inputs: NoirInputs;
  /** Plaintext amount the event decrypts to (what the proof discloses). */
  vTx: bigint;
  /** Disclosure ciphertext (§4) — travels in the bundle alongside the proof. */
  rDisc: Point;
  vTildeDisc: bigint;
}

export function buildDiscloseSenderWitness(p: DiscloseSenderParams): DiscloseSenderWitness {
  const { keys, rEScalar, event, pvkB, pR, nu } = p;

  // DS3 sanity — catch a mismatched scalar before proving.
  const rEDerived = pointCoords(scalarMul(rEScalar, H));
  const rEEvent = pointCoords(event.rE);
  if (rEDerived.x !== rEEvent.x || rEDerived.y !== rEEvent.y) {
    throw new Error(
      "supplied r_e does not match the event's R_e — wrong event, or this transfer was sent with different keys",
    );
  }

  // DS4/DS5 — reconstruct the recipient-side decryption from the sender side.
  const sBx = ecdh(rEScalar, pvkB);
  const vTx = decryptWithDomain(event.vTilde, DOMAIN.TRANSFER_AMOUNT, sBx, event.sigma);
  if (vTx >= 1n << 127n) {
    throw new Error(
      "event does not decrypt to a valid amount — does PVK_B belong to the event's recipient?",
    );
  }

  // U-block — seal v_tx to the disclosure recipient (§4).
  const rDiscScalar = p.rDisc ?? randomScalar();
  const rDisc = scalarMul(rDiscScalar, H);
  const sDiscX = ecdh(rDiscScalar, pR);
  const vTildeDisc = encryptDisclosure(vTx, sDiscX, nu);

  const inputs: NoirInputs = {
    sk: fieldIn(keys.sk),
    r_e: fieldIn(rEScalar),
    v_tx: fieldIn(vTx),
    r_disc: fieldIn(rDiscScalar),
    addr_f: fieldIn(keys.addrF),
    ...pointIn("pvk_a", keys.PVK),
    ...pointIn("r_e", event.rE),
    sigma: fieldIn(event.sigma),
    v_tilde: fieldIn(event.vTilde),
    ...pointIn("pvk_b", pvkB),
    ...pointIn("p_r", pR),
    nu: fieldIn(nu),
    ...pointIn("r_disc", rDisc),
    v_tilde_disc: fieldIn(vTildeDisc),
  };

  return { inputs, vTx, rDisc, vTildeDisc };
}
