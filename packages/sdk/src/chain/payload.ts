/**
 * XDR encoding of the `{ payload, proof }` envelopes that the proof-carrying
 * entry points (`register`, `withdraw`, `confidential_transfer`, …) decode from
 * their `data: Bytes` argument via `RegisterData::from_xdr` etc.
 *
 * Layout, per `storage.rs`:
 *   - A `#[contracttype]` struct serializes to `ScVal::Map` with `Symbol` keys
 *     (the field names), entries sorted ascending by key.
 *   - `Point = BytesN<64>` is a FLAT 64-byte value (`be(x) || be(y)`), NOT an
 *     `{ x, y }` sub-map (that was the previous design).
 *   - `BytesN<32>` fields are 32-byte values; `proof` is variable `Bytes`.
 *
 * The `data` argument itself is `Bytes`, so the wire value is
 * `scvBytes( ScVal(<XDR of the {payload, proof} map>) )`.
 */

import { xdr } from "@stellar/stellar-sdk";

import { pointToBytes, type Point } from "../crypto/grumpkin.js";
import { toBytes32BE } from "../crypto/field.js";
import type { RegisterWitness } from "../witness/register.js";
import type { WithdrawWitness } from "../witness/withdraw.js";
import type { TransferWitness } from "../witness/transfer.js";

// `scvBytes` is typed for Buffer but accepts any byte view at runtime; normalize
// to Buffer so this is correct under both Node and bundlers.
const scvBytes = (b: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(b));
const pointVal = (p: Point): xdr.ScVal => scvBytes(pointToBytes(p));
const fieldVal = (v: bigint): xdr.ScVal => scvBytes(toBytes32BE(v));

/** A contracttype struct: ScMap with symbol keys sorted ascending (byte order). */
export function scvStruct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map(
      (k) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! }),
    );
  return xdr.ScVal.scvMap(entries);
}

/** Wrap a payload struct and proof bytes into the `data: Bytes` argument. */
function envelope(payload: xdr.ScVal, proof: Uint8Array): xdr.ScVal {
  const data = scvStruct({ payload, proof: scvBytes(proof) });
  return scvBytes(data.toXDR()); // toXDR() -> Buffer (raw)
}

export function encodeRegisterData(w: RegisterWitness, proof: Uint8Array): xdr.ScVal {
  const payload = scvStruct({
    y: pointVal(w.payload.y),
    pvk: pointVal(w.payload.pvk),
  });
  return envelope(payload, proof);
}

export function encodeWithdrawData(w: WithdrawWitness, proof: Uint8Array): xdr.ScVal {
  const p = w.payload;
  const payload = scvStruct({
    c_spend_new: pointVal(p.cSpendNew),
    b_tilde: fieldVal(p.bTilde),
    r_e_point: pointVal(p.rE),
    sigma: fieldVal(p.sigma),
    b_tilde_aud_s: fieldVal(p.bAudS),
  });
  return envelope(payload, proof);
}

export function encodeTransferData(w: TransferWitness, proof: Uint8Array): xdr.ScVal {
  const p = w.payload;
  const payload = scvStruct({
    c_spend_new: pointVal(p.cSpendNew),
    c_transfer: pointVal(p.cTransfer),
    r_e_point: pointVal(p.rE),
    v_tilde: fieldVal(p.vTilde),
    b_tilde: fieldVal(p.bTilde),
    sigma: fieldVal(p.sigma),
    v_tilde_aud_r: fieldVal(p.vAudR),
    r_tilde_aud_r: fieldVal(p.rAudR),
    v_tilde_aud_s: fieldVal(p.vAudS),
    b_tilde_aud_s: fieldVal(p.bAudS),
  });
  return envelope(payload, proof);
}
