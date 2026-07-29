/**
 * Register-circuit witness (design §7.2). Proves knowledge of `sk` such that
 * `Y = sk·H` and `PVK = vk·H` with `vk = Poseidon2(VIEWING_KEY, sk, addr_f)`.
 *
 * Public inputs (contract PI order): Y, PVK, addr_f, acct_f.
 *
 * `acct_f = address_to_field(account)` is referenced by no gate — its presence
 * in the public-input set IS the binding. UltraHonk absorbs every public input
 * into the transcript, and `storage::register` recomputes `acct_f` from the
 * `account` argument rather than trusting the caller's bytes, so a proof
 * produced for one address fails verification for any other. Without it the
 * proof and payload — both public after a legitimate registration — could be
 * replayed by any caller to mint duplicate-key accounts (audit L-06).
 */

import type { KeyPair } from "../crypto/keys.js";
import type { Point } from "../crypto/grumpkin.js";
import { addressToField } from "../crypto/address.js";
import { fieldIn, pointIn, type NoirInputs } from "./common.js";

export interface RegisterWitness {
  inputs: NoirInputs;
  /** On-chain `RegisterPayload` { y, pvk }. */
  payload: { y: Point; pvk: Point };
}

/**
 * @param keys - The registering account's contract-bound key set.
 * @param account - The Stellar address being registered (the `account` argument
 *   of `register`). Bound into the proof as `acct_f`; a mismatch surfaces
 *   on-chain as a proof-verification failure, not a readable error.
 */
export function buildRegisterWitness(keys: KeyPair, account: string): RegisterWitness {
  const inputs: NoirInputs = {
    sk: fieldIn(keys.sk),
    ...pointIn("y", keys.Y),
    ...pointIn("pvk", keys.PVK),
    addr_f: fieldIn(keys.addrF),
    _acct_f: fieldIn(addressToField(account)),
  };
  return { inputs, payload: { y: keys.Y, pvk: keys.PVK } };
}
