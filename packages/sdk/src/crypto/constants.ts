/**
 * Cross-language constants shared with the Noir circuits and the on-chain
 * contract. Every value here is a hard contract: if any of these diverges from
 * `circuits/lib/src/lib.nr` (generators, domain tags, IV base) or from the
 * Soroban host's field (the BN254 scalar field `F_r`), proofs silently fail to
 * verify or — worse — verify against the wrong statement.
 *
 * Source of truth:
 *   OpenZeppelin/stellar-contracts @ feat/confidential-verifier-ultrahonk
 *   packages/tokens/src/confidential/circuits/lib/src/lib.nr
 */

// ---------------------------------------------------------------------------
// Field moduli
// ---------------------------------------------------------------------------

/**
 * BN254 scalar field order `r`. This is Noir's native `Field` modulus and the
 * Grumpkin **base** field (point coordinates live here). The Soroban host's
 * `Bn254Fr` is this field; "canonical" means a 32-byte big-endian value `< r`.
 */
export const FR_MODULUS =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/**
 * BN254 base field order `p`. This is the Grumpkin **scalar** field — the
 * modulus that scalars are reduced by during point multiplication.
 *
 * Note `r < p`, so every `F_r` element (key material, blinding factors, salts —
 * all in `[0, r)`) is already a valid Grumpkin scalar with no reduction. That
 * is exactly why a Noir `Field` can be fed to `multi_scalar_mul` unambiguously.
 */
export const FP_MODULUS =
  0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

// ---------------------------------------------------------------------------
// Grumpkin generators (Barretenberg "DEFAULT_DOMAIN_SEPARATOR", indices 0/1)
// ---------------------------------------------------------------------------
//
// These are derive_generators("DEFAULT_DOMAIN_SEPARATOR", ...) outputs, so
// `commit(v, r) = v*G + r*H` is identical to Barretenberg's
// `pedersen_commitment([v, r])`. There is NO known discrete-log relation
// between G and H (do NOT assume H = k*G as some older designs did).

/** Pedersen generator G (index 0). */
export const G_X =
  0x083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5an;
export const G_Y =
  0x1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935dn;

/** Pedersen generator H (index 1). */
export const H_X =
  0x054aa86a73cb8a34525e5bbed6e43ba1198e860f5f3950268f71df4591bde402n;
export const H_Y =
  0x209dcfbf2cfb57f9f6046f44d71ac6faf87254afc7407c04eb621a6287cac126n;

// ---------------------------------------------------------------------------
// Poseidon2 sponge
// ---------------------------------------------------------------------------

/** IV multiplier: `iv = (input_length) * 2^64`, placed at the capacity slot. */
export const POSEIDON2_IV_BASE = 1n << 64n; // 2^64 = 18446744073709551616

// ---------------------------------------------------------------------------
// Domain separation tags (lib.nr `mod domain`). The integer IS the wire
// contract: it is the first element absorbed by every Poseidon2 call.
// ---------------------------------------------------------------------------

export const DOMAIN = {
  /** address_to_field(a) = Poseidon2(ADDRESS, lo, hi). */
  ADDRESS: 1n,
  /** vk = Poseidon2(VIEWING_KEY, sk, addr_f). */
  VIEWING_KEY: 2n,
  /** dvk = Poseidon2(DELEGATION_VIEWING_KEY, vk, op_i). */
  DELEGATION_VIEWING_KEY: 3n,
  /** r' = Poseidon2(SPEND_RANDOMNESS, vk, sigma). */
  SPEND_RANDOMNESS: 4n,
  /** r_transfer = Poseidon2(TRANSFER_BLINDING, s, sigma). */
  TRANSFER_BLINDING: 5n,
  /** v_tilde = v_transfer + Poseidon2(TRANSFER_AMOUNT, s, sigma). */
  TRANSFER_AMOUNT: 6n,
  /** b_tilde = v_new + Poseidon2(ENCRYPTED_BALANCE, vk, sigma). */
  ENCRYPTED_BALANCE: 7n,
  /** a_tilde = v_a + Poseidon2(ENCRYPTED_ALLOWANCE, dvk, sigma_a). */
  ENCRYPTED_ALLOWANCE: 8n,
  /** r_a = Poseidon2(ALLOWANCE_RANDOMNESS, dvk, sigma_a). */
  ALLOWANCE_RANDOMNESS: 9n,
  /** escrowed_dvk = dvk + Poseidon2(ESCROWED_DELEGATION_VIEWING_KEY, s, op_i). */
  ESCROWED_DELEGATION_VIEWING_KEY: 10n,
  /** Sender / owner-auditor channel tag. */
  AUDITOR_SENDER: 11n,
  /** Recipient-auditor channel tag. */
  AUDITOR_RECIPIENT: 12n,
  /**
   * ECDH shared-secret scalar extraction: `s = Poseidon2(ECDH_SHARED_SECRET,
   * S.x, S.y)` where `S = scalar · P`. DESIGN §2.4.
   *
   * Absorbing `S.y` (rather than taking `S.x` alone, as the previous revision
   * did) removes the negation invariance of an x-only extraction: `P` and
   * `-P = (P.x, -P.y)` share an x-coordinate, so `(scalar · P).x` mapped a key
   * and its negation — itself a valid, canonical registration — to the same
   * shared secret for every scalar. See {@link ecdh}.
   */
  ECDH_SHARED_SECRET: 13n,
  /** Aggregate-disclosure nonce binding (`delta_disc_bind`, §10). Reserved. */
  DISCLOSURE_BIND: 14n,
  /**
   * Wallet-side deterministic ephemeral scalar:
   * `r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma)`. Never absorbed inside a
   * circuit — `r_e` is a free private witness there (only `R_e = r_e·H` and
   * `r_e ≠ 0` are constrained), so this is a client convention, not a wire
   * contract. It continues the tag list to stay collision-free with the other
   * `(vk, sigma)`-keyed calls (SPEND_RANDOMNESS, ENCRYPTED_BALANCE).
   */
  EPHEMERAL_KEY: 15n,
  /**
   * Off-chain selective-disclosure ciphertext to a disclosure recipient:
   * `v_tilde_disc = v_transfer + Poseidon2(DISCLOSURE, S_disc.x, nu)`.
   * SELECTIVE_DISCLOSURE.md §2.2 / §4 (`delta_disc`). Source of truth:
   * packages/disclosure circuits.
   *
   * Moved from 13 to 16: upstream claimed 13 for {@link DOMAIN.ECDH_SHARED_SECRET},
   * and the disclosure circuits call `ecdh()` themselves — a shared tag would put
   * two unrelated two-input Poseidon calls on one domain inside a single circuit,
   * making a disclosure pad collide with an ECDH scalar.
   */
  DISCLOSURE: 16n,
} as const;

/** Verifier circuit-type discriminants (verifier/mod.rs `CircuitType`). */
export const CIRCUIT_TYPE = {
  Register: 0,
  Withdraw: 1,
  Transfer: 2,
  SpenderTransfer: 3,
  SetSpender: 4,
  RevokeSpender: 5,
} as const;

export type CircuitTypeName = keyof typeof CIRCUIT_TYPE;
