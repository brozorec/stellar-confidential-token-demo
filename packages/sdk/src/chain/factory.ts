/**
 * Token-factory deploy helpers (advanced mode).
 *
 * The shared `TokenFactoryContract` deploys confidential-token instances from
 * WASM already installed on-chain (configured at the factory's construction).
 * The browser only INVOKES these methods via Freighter — it never installs
 * WASM. Each deploy derives a deterministic address from `(factory, salt)`, so
 * a fresh random salt per deploy avoids collisions.
 *
 * Arg tuples mirror the factory's Rust signatures by convention (the factory
 * deploys purely by hash + arg tuple); keep them in sync with
 * `contracts/factory/src/lib.rs`.
 */

import { xdr, Address } from "@stellar/stellar-sdk";

import type { ChainClient, Signer } from "./client.js";

const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
// `scvBytes` is typed for Buffer but accepts any byte view; normalize to Buffer
// so this is correct under both Node and browser bundlers.
const saltVal = (s: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(s));
// soroban `Option<Address>`: None → Void, Some(a) → the address ScVal.
const optionAddr = (a?: string): xdr.ScVal => (a ? addr(a) : xdr.ScVal.scvVoid());

/** A fresh 32-byte salt — unique per `(factory, salt)` deploy. */
export function randomSalt(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

/** Constant collaborators every factory deploy is wired to. */
export interface FactoryWiring {
  factory: string;
  underlying: string;
  verifier: string;
  auditor: string;
}

export type PolicyKind = "AllowList" | "BlockList";

function requireAddr(rv: xdr.ScVal | undefined, method: string): string {
  if (!rv) throw new Error(`${method} returned no value`);
  return Address.fromScVal(rv).toString();
}

/** `deploy_token(salt, underlying, verifier, auditor)` → vanilla token address. */
export async function deployVanillaToken(
  client: ChainClient,
  signer: Signer,
  w: FactoryWiring,
  salt: Uint8Array = randomSalt(),
): Promise<string> {
  const r = await client.invoke(
    w.factory,
    "deploy_token",
    [saltVal(salt), addr(w.underlying), addr(w.verifier), addr(w.auditor)],
    signer,
  );
  return requireAddr(r.returnValue, "deploy_token");
}

/**
 * `deploy_compliant_token(salt, owner, underlying, verifier, auditor, policy?)`
 * → compliant token address. `policy` undefined ⇒ compliance-only (freeze + SAC
 * passthrough, no external policy); a policy address binds an existing policy.
 */
export async function deployCompliantToken(
  client: ChainClient,
  signer: Signer,
  w: FactoryWiring,
  owner: string,
  policy?: string,
  salt: Uint8Array = randomSalt(),
): Promise<string> {
  const r = await client.invoke(
    w.factory,
    "deploy_compliant_token",
    [saltVal(salt), addr(owner), addr(w.underlying), addr(w.verifier), addr(w.auditor), optionAddr(policy)],
    signer,
  );
  return requireAddr(r.returnValue, "deploy_compliant_token");
}

/**
 * `deploy_policy_and_token(kind, policy_salt, policy_owner, token_salt,
 * token_owner, underlying, verifier, auditor)` → `{ policy, token }`. Deploys a
 * fresh `owner`-owned policy (allowlist/blocklist) and a compliant token bound
 * to it in one call.
 */
export async function deployPolicyAndToken(
  client: ChainClient,
  signer: Signer,
  w: FactoryWiring,
  kind: PolicyKind,
  owner: string,
  policySalt: Uint8Array = randomSalt(),
  tokenSalt: Uint8Array = randomSalt(),
): Promise<{ policy: string; token: string }> {
  // A fieldless soroban enum variant encodes as Vec[Symbol(variant)].
  const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]);
  const r = await client.invoke(
    w.factory,
    "deploy_policy_and_token",
    [
      kindVal,
      saltVal(policySalt),
      addr(owner),
      saltVal(tokenSalt),
      addr(owner),
      addr(w.underlying),
      addr(w.verifier),
      addr(w.auditor),
    ],
    signer,
  );
  const rv = r.returnValue;
  const vec = rv?.vec();
  if (!vec || vec.length !== 2) {
    throw new Error("deploy_policy_and_token: expected a (policy, token) tuple");
  }
  return {
    policy: Address.fromScVal(vec[0]!).toString(),
    token: Address.fromScVal(vec[1]!).toString(),
  };
}
