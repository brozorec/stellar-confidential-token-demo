/**
 * Token-admin operations (admin persona).
 *
 * `token_with_compliance` exposes owner-gated `freeze`/`unfreeze`; the
 * allowlist/blocklist policy contracts expose owner-gated `allow`/`disallow`
 * and `block`/`unblock`. Reads go through `simulate`; writes through `invoke`,
 * where the owner's Freighter signature satisfies each `#[only_owner]` gate.
 *
 * Membership lists (frozen accounts, allowed/blocked users) are reconstructed
 * from the contract's events by the dashboard — these helpers cover the
 * point reads (owner / per-account status) and the mutations.
 */

import { xdr, Address, scValToNative } from "@stellar/stellar-sdk";

import type { ChainClient, Signer, InvokeResult } from "./client.js";

const addr = (a: string): xdr.ScVal => new Address(a).toScVal();

// ----- reads ---------------------------------------------------------------

/**
 * Read a contract's Ownable owner, or `null` if it has none / errors.
 *
 * The OZ `Ownable` trait exposes `get_owner() -> Option<Address>` (NOT `owner`).
 * soroban encodes the `Option` as the address ScVal for `Some`, or `Void` for
 * `None` (owner unset / renounced) — so a `Void` result means "no owner".
 */
export async function readOwner(client: ChainClient, contractId: string): Promise<string | null> {
  try {
    const rv = await client.simulate(contractId, "get_owner", []);
    if (rv.switch().name === "scvVoid") return null;
    return Address.fromScVal(rv).toString();
  } catch {
    return null;
  }
}

/** `is_frozen(account)` on a compliant token. */
export async function isFrozen(client: ChainClient, tokenId: string, account: string): Promise<boolean> {
  return scValToNative(await client.simulate(tokenId, "is_frozen", [addr(account)])) === true;
}

/** `allowed(account)` on an allowlist policy. */
export async function isAllowed(client: ChainClient, policyId: string, account: string): Promise<boolean> {
  return scValToNative(await client.simulate(policyId, "allowed", [addr(account)])) === true;
}

/** `blocked(account)` on a blocklist policy. */
export async function isBlocked(client: ChainClient, policyId: string, account: string): Promise<boolean> {
  return scValToNative(await client.simulate(policyId, "blocked", [addr(account)])) === true;
}

// ----- writes (owner-gated) ------------------------------------------------

/** `freeze(account, operator)` — `operator` is the authorizing owner. */
export function freezeAccount(
  client: ChainClient,
  signer: Signer,
  tokenId: string,
  account: string,
  operator: string,
): Promise<InvokeResult> {
  return client.invoke(tokenId, "freeze", [addr(account), addr(operator)], signer);
}

/** `unfreeze(account, operator)`. */
export function unfreezeAccount(
  client: ChainClient,
  signer: Signer,
  tokenId: string,
  account: string,
  operator: string,
): Promise<InvokeResult> {
  return client.invoke(tokenId, "unfreeze", [addr(account), addr(operator)], signer);
}

/** `allow(user)` on an allowlist policy. */
export function allowUser(
  client: ChainClient,
  signer: Signer,
  policyId: string,
  user: string,
): Promise<InvokeResult> {
  return client.invoke(policyId, "allow", [addr(user)], signer);
}

/** `disallow(user)` on an allowlist policy. */
export function disallowUser(
  client: ChainClient,
  signer: Signer,
  policyId: string,
  user: string,
): Promise<InvokeResult> {
  return client.invoke(policyId, "disallow", [addr(user)], signer);
}

/** `block(user)` on a blocklist policy. */
export function blockUser(
  client: ChainClient,
  signer: Signer,
  policyId: string,
  user: string,
): Promise<InvokeResult> {
  return client.invoke(policyId, "block", [addr(user)], signer);
}

/** `unblock(user)` on a blocklist policy. */
export function unblockUser(
  client: ChainClient,
  signer: Signer,
  policyId: string,
  user: string,
): Promise<InvokeResult> {
  return client.invoke(policyId, "unblock", [addr(user)], signer);
}
