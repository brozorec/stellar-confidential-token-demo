/**
 * Grumpkin curve operations (the embedded curve of BN254), wrapping
 * `@noble/curves`.
 *
 *   - Equation: `y^2 = x^3 - 17`
 *   - Base field  (coordinates): BN254 `F_r`  — Noir's `Field`
 *   - Scalar field (multipliers): BN254 `F_p`
 *
 * Generators G and H are Barretenberg's `derive_generators(
 * "DEFAULT_DOMAIN_SEPARATOR")` outputs (indices 0 and 1), matching
 * `circuits/lib/src/lib.nr`. There is NO known discrete-log relation between
 * them — do not assume `H = k·G`.
 *
 * On-chain a point is `BytesN<64>` = `be(x) || be(y)`, and the identity is all
 * 64 bytes zero. `pointToBytes` / `pointFromBytes` implement exactly that.
 */

import { weierstrassN, type WeierstrassPoint } from "@noble/curves/abstract/weierstrass";
import { Field } from "@noble/curves/abstract/modular";

import { FR_MODULUS, FP_MODULUS, G_X, G_Y, H_X, H_Y, DOMAIN } from "./constants.js";
import { fromBytesBE, toBytes32BE } from "./field.js";
// poseidon2.ts depends only on constants.js/field.js, so this is not a cycle.
import { poseidonWithDomain } from "./poseidon2.js";

/** Grumpkin base field = BN254 `F_r` (point coordinates; Noir `Field`). */
export const Fr = Field(FR_MODULUS);
/** Grumpkin scalar field = BN254 `F_p` (multipliers). */
export const Fp = Field(FP_MODULUS);

/**
 * Grumpkin curve. The nominal base point is generator G itself, so
 * `Grumpkin.BASE === G`. `allowInfinityPoint` lets us represent the identity
 * (a registered account's opening balance commitment is the identity).
 */
export const Grumpkin = weierstrassN(
  {
    p: FR_MODULUS,
    n: FP_MODULUS,
    h: 1n,
    a: 0n,
    b: Fr.create(-17n),
    Gx: G_X,
    Gy: G_Y,
  },
  {
    Fp: Fr,
    Fn: Fp,
    allowInfinityPoint: true,
  },
);

export type Point = WeierstrassPoint<bigint>;

/** Pedersen generator G (index 0). */
export const G: Point = Grumpkin.BASE;
/** Pedersen generator H (index 1). */
export const H: Point = Grumpkin.fromAffine({ x: H_X, y: H_Y });
/** The point at infinity / identity element. */
export const IDENTITY: Point = Grumpkin.ZERO;

/** True iff `p` is the identity (encoded on-chain as 64 zero bytes). */
export function isIdentity(p: Point): boolean {
  return p.is0();
}

/**
 * `scalar · P`. The scalar is an `F_r` value (key, blinding, salt); since
 * `r < p` it is always a valid Grumpkin scalar with no reduction. We reduce
 * mod `p` defensively and map `0` to the identity (noble rejects a zero
 * multiplier).
 */
export function scalarMul(scalar: bigint, p: Point): Point {
  let s = scalar % FP_MODULUS;
  if (s < 0n) s += FP_MODULUS;
  if (s === 0n) return Grumpkin.ZERO;
  return p.multiply(s);
}

/** Pedersen commitment `v·G + r·H`. */
export function commit(value: bigint, randomness: bigint): Point {
  return scalarMul(value, G).add(scalarMul(randomness, H));
}

/**
 * ECDH shared-secret SCALAR: `s = Poseidon2(ECDH_SHARED_SECRET, S.x, S.y)` where
 * `S = scalar · P`. Mirrors `lib.nr::ecdh`. Throws on the identity.
 *
 * Both coordinates are absorbed. An x-only extraction (what this returned
 * previously) is negation-invariant: `P` and `-P = (P.x, -P.y)` share an
 * x-coordinate, so every scalar produced the same shared secret against a key
 * and against its negation — and `-PVK = (-vk)·H` is itself a valid, canonical
 * registration. The absorb `[tag, S.x, S.y]` fills exactly one rate-3 block, so
 * the binding costs a single permutation.
 *
 * Callers that need the shared-secret POINT (not the scalar) must use
 * {@link scalarMul} directly.
 */
export function ecdh(scalar: bigint, p: Point): bigint {
  const s = scalarMul(scalar, p);
  if (s.is0()) throw new Error("ecdh produced the identity (degenerate key)");
  const { x, y } = s.toAffine();
  return poseidonWithDomain(DOMAIN.ECDH_SHARED_SECRET, [x, y]);
}

/** Affine coordinates, returning `(0, 0)` for the identity. */
export function pointCoords(p: Point): { x: bigint; y: bigint } {
  if (p.is0()) return { x: 0n, y: 0n };
  return p.toAffine();
}

/** Encode to the on-chain 64-byte `be(x) || be(y)` layout (identity → zeros). */
export function pointToBytes(p: Point): Uint8Array {
  const out = new Uint8Array(64);
  if (p.is0()) return out;
  const { x, y } = p.toAffine();
  out.set(toBytes32BE(x), 0);
  out.set(toBytes32BE(y), 32);
  return out;
}

/** Decode the on-chain 64-byte layout (all-zero → identity). */
export function pointFromBytes(b: Uint8Array): Point {
  if (b.length !== 64) throw new Error(`expected 64 bytes, got ${b.length}`);
  let allZero = true;
  for (const byte of b) {
    if (byte !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return Grumpkin.ZERO;
  const x = fromBytesBE(b.subarray(0, 32));
  const y = fromBytesBE(b.subarray(32, 64));
  return Grumpkin.fromAffine({ x, y });
}
