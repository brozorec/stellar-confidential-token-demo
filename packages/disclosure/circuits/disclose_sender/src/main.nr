use std::embedded_curve_ops::EmbeddedCurvePoint;
use stellar_confidential_lib::{
    H, assert_on_curve_non_identity, ecdh, encrypt_amount, poseidon_with_domain, scalar_mul,
    vk_from_sk,
};

mod tests;

// D-sender disclosure circuit -- SELECTIVE_DISCLOSURE.md Section 7.
//
// The party that ORIGINATED an on-chain confidential transfer proves, to a
// designated disclosure recipient (P_R, nu), that they paid exactly v_tx to
// the on-chain `to` address recorded in the event. The sender has no ECDH
// path through their own vk into the event ciphertext v_tilde (it is keyed
// to the recipient's PVK_B), so the necessary witness is the ephemeral
// scalar r_e the sender sampled at transfer time -- wallets retain (r_e,
// v_tx) per outgoing transfer to support this circuit (Section 15.2).
//
// Verified entirely OFF-chain (Section 5.5), same transport and verifier
// protocol as disclose_recipient. The verifier resolves PVK_A from the
// account at the event's `from` and PVK_B from the account at the event's
// `to` (Section 5.3 step 2) -- never from the bundle.
//
// Constraints
// -----------
//   D1   vk_A = Poseidon2(delta_vk, sk_A, addr_f)    Contract-bound viewing
//                                                    key.
//   D2   PVK_A = vk_A * H                            Binds proof to the
//                                                    on-chain account at the
//                                                    event's `from`.
//   DS3  R_e = r_e * H, r_e != 0                     Prover knows the
//                                                    ephemeral scalar used at
//                                                    transfer time (same
//                                                    shape as transfer's T6 /
//                                                    T13).
//   DS4  S_B = r_e * PVK_B                           Sender-side ECDH to the
//                                                    transfer's recipient
//                                                    (mirrors T5).
//   DS5  v_tx = v_tilde
//          - Poseidon2(delta_tx_amount, S_B.x, sigma) Reconstructs the
//                                                    recipient-side
//                                                    decryption from the
//                                                    originator's witnesses
//                                                    (matches T9).
//   D5   v_tx in [0, 2^127)                          Range validity.
//   U1   R_disc = r_disc * H, r_disc != 0            Disclosure ephemeral key.
//   U2   s_disc = ecdh(r_disc, P_R)                   Disclosure ECDH
//                                                    shared scalar (2.4).
//   U3   v_tilde_disc = v_tx
//          + Poseidon2(delta_disc, s_disc, nu)       Value sealed to the
//                                                    disclosure recipient.
//
// DS3 anchors R_e to the originator: combined with D1/D2 it proves the
// prover is the same party that produced the transfer's ephemeral key.
//
// Point-validation doctrine (DESIGN.md Section 10.8): PVK_B and P_R are
// public-input points consumed by ECDH with no on-chain verifier
// reconstructing them from trusted storage, so both are explicitly checked
// on-curve and non-identity. R_e here is bound to an in-circuit scalar_mul
// output (DS3), so unlike disclose_recipient no explicit check is needed.
//
// Public inputs (15 fields, in order)
// -----------------------------------
//   Idx  Param          Symbol         Verifier source (Section 5.3)
//   ---  -----          ------         ------------------------------------
//   0    addr_f         addr_f         Recomputed from the token contract
//                                      address.
//   1    pvk_a_x        PVK_A.x        `confidential_balance(E.from)`
//   2    pvk_a_y        PVK_A.y         .viewing_public_key (the ORIGINATOR).
//   3    r_e_x          R_e.x          The on-chain event resolved from
//   4    r_e_y          R_e.y           ref_E.
//   5    sigma          sigma_E        Event ECDH nonce.
//   6    v_tilde        v_tilde        Event encrypted amount.
//   7    pvk_b_x        PVK_B.x        `confidential_balance(E.to)`
//   8    pvk_b_y        PVK_B.y         .viewing_public_key (the recipient).
//   9    p_r_x          P_R.x          The verifier's own disclosure key.
//   10   p_r_y          P_R.y
//   11   nu             nu             The verifier's own request nonce.
//   12   r_disc_x       R_disc.x       From the bundle (also ciphertext).
//   13   r_disc_y       R_disc.y
//   14   v_tilde_disc   v_tilde_disc   From the bundle (ciphertext).
//
// Private witnesses
// -----------------
//   sk      Originator's spending secret scalar.
//   r_e     Ephemeral scalar sampled at transfer time (retained by the
//           wallet); r_e != 0 (DS3).
//   v_tx    Plaintext transfer amount.
//   r_disc  Ephemeral scalar for the disclosure ciphertext; r_disc != 0 (U1).

/// Disclosure ciphertext domain tag (`delta_disc`) -- same value as
/// disclose_recipient's; the U-block is shared across the circuit family. See
/// that circuit for why this is 16 and not 13.
pub global DISCLOSURE: Field = 16;

fn main(
    sk: Field,
    r_e: Field,
    v_tx: Field,
    r_disc: Field,
    addr_f: pub Field,
    pvk_a_x: pub Field,
    pvk_a_y: pub Field,
    r_e_x: pub Field,
    r_e_y: pub Field,
    sigma: pub Field,
    v_tilde: pub Field,
    pvk_b_x: pub Field,
    pvk_b_y: pub Field,
    p_r_x: pub Field,
    p_r_y: pub Field,
    nu: pub Field,
    r_disc_x: pub Field,
    r_disc_y: pub Field,
    v_tilde_disc: pub Field,
) {
    // Degenerate-scalar rejections first (same doctrine as transfer's T13).
    assert(r_e != 0);
    assert(r_disc != 0);

    // D1
    let vk = vk_from_sk(sk, addr_f);

    // D2
    let pvk_derived = scalar_mul(vk, H);
    assert(pvk_derived.x == pvk_a_x);
    assert(pvk_derived.y == pvk_a_y);

    // DS3 -- the originator binding: only the party that sampled r_e at
    // transfer time can satisfy this against the event's emitted R_e.
    let r_e_derived = scalar_mul(r_e, H);
    assert(r_e_derived.x == r_e_x);
    assert(r_e_derived.y == r_e_y);

    // PVK_B is an account-sourced public-input point consumed by ECDH: validate.
    let pvk_b = EmbeddedCurvePoint { x: pvk_b_x, y: pvk_b_y, is_infinite: false };
    assert_on_curve_non_identity(pvk_b);

    // DS4
    let s_b_x = ecdh(r_e, pvk_b);

    // DS5 -- same algebra as T9, recomputed from the sender side.
    let v_tilde_derived = encrypt_amount(v_tx, s_b_x, sigma);
    assert(v_tilde_derived == v_tilde);

    // D5
    v_tx.assert_max_bit_size::<127>();

    // U1 (point part)
    let r_disc_derived = scalar_mul(r_disc, H);
    assert(r_disc_derived.x == r_disc_x);
    assert(r_disc_derived.y == r_disc_y);

    // P_R is the disclosure recipient's key, consumed by ECDH: validate.
    let p_r = EmbeddedCurvePoint { x: p_r_x, y: p_r_y, is_infinite: false };
    assert_on_curve_non_identity(p_r);

    // U2 -- via the shared `ecdh` gadget, so the disclosure channel inherits the
    // same full-point binding as D3: `s = Poseidon2(ECDH_SHARED_SECRET, S.x, S.y)`.
    // Taking `S_disc.x` alone would let `P_R` and `-P_R` produce one mask.
    let s_disc = ecdh(r_disc, p_r);

    // U3
    let mask = poseidon_with_domain(DISCLOSURE, [s_disc, nu]);
    assert(v_tx + mask == v_tilde_disc);
}
