/**
 * `F_r` field-element helpers (BN254 scalar field — Noir's `Field`, the Soroban
 * host's `Bn254Fr`). Everything the contract calls a "32-byte canonical
 * representative" lives here.
 */

import { FR_MODULUS, FP_MODULUS } from "./constants.js";

/** Reduce into `[0, r)`. */
export function frMod(x: bigint): bigint {
  const m = x % FR_MODULUS;
  return m < 0n ? m + FR_MODULUS : m;
}

/** Field addition mod `r`. */
export function frAdd(a: bigint, b: bigint): bigint {
  return frMod(a + b);
}

/** Field subtraction mod `r`. */
export function frSub(a: bigint, b: bigint): bigint {
  return frMod(a - b);
}

/**
 * Grumpkin SCALAR addition mod `p` (the group order), for accumulating
 * commitment blinding factors under homomorphic point addition:
 * `C1 + C2 = commit(v1 + v2, (r1 + r2) mod p)`. Reducing mod `r` here instead
 * silently opens the wrong commitment whenever the integer sum crosses `p`
 * (~50% of the time for two full-size blindings) — the resulting opening is
 * off by `p - r` and no longer matches the on-chain point (DESIGN §2.3).
 */
export function fpAdd(a: bigint, b: bigint): bigint {
  const s = (a + b) % FP_MODULUS;
  return s < 0n ? s + FP_MODULUS : s;
}

/** True iff `x` is a canonical representative (`0 <= x < r`). */
export function isCanonicalFr(x: bigint): boolean {
  return x >= 0n && x < FR_MODULUS;
}

/** 32-byte big-endian encoding (the on-chain `BytesN<32>` field layout). */
export function toBytes32BE(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 256n) {
    throw new RangeError(`value out of 256-bit range: ${x}`);
  }
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Decode a big-endian byte slice into a bigint. */
export function fromBytesBE(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

/** Decode a little-endian byte slice into a bigint (used by address_to_field). */
export function fromBytesLE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
}

/** 0x-prefixed, zero-padded 32-byte hex. */
export function toHex32(x: bigint): string {
  return "0x" + frMod(x).toString(16).padStart(64, "0");
}

/** Parse 0x-prefixed (or bare) hex into a bigint. */
export function fromHex(h: string): bigint {
  return BigInt(h.startsWith("0x") || h.startsWith("0X") ? h : "0x" + h);
}

/** Lowercase hex (no 0x) for an arbitrary byte array. */
export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

/** Parse hex (with/without 0x) into bytes. */
export function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Cryptographically-random nonzero scalar, uniform on `[1, r)`.
 *
 * The rejection procedure is fixed by SDK.md §4.7 / DESIGN.md §2.2: draw 32
 * bytes, clear the top **2** bits, redraw if the 254-bit candidate is `>= r`
 * (or zero where nonzero is required). Since `r` is just over ¾ of `2^254`,
 * the loop redraws ~25% of the time and the output is uniform on the full
 * range.
 *
 * Masking more than 2 bits would still be `< r` — but it would silently
 * shrink the range instead of rejecting, and the same procedure is the `RS`
 * step of SDK.md §5.1's `sk` derivation, where a client that masks a different
 * number of bits derives a DIFFERENT `sk` from the same root. The bit count is
 * a cross-client contract, not a local bias-reduction choice.
 */
export function randomScalar(): bigint {
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[0]! &= 0x3f; // clear the top 2 bits -> 254-bit candidate
    const v = fromBytesBE(bytes);
    if (v !== 0n && v < FR_MODULUS) return v;
  }
}
