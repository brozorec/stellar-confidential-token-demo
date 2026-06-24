/**
 * Disclosure-receiver verification — the mandatory §5.3 protocol from
 * SELECTIVE_DISCLOSURE.md, for the D-recipient (§6) and D-sender (§7)
 * circuits.
 *
 * The trust-boundary rule (§5.2) is load-bearing here: the ONLY bundle values
 * that enter the public-input vector are `(R_disc, v_tilde_disc)`. Everything
 * else — the event fields, the disclosing accounts' PVKs, `addr_f` — is
 * resolved independently from the chain, and `(P_R, nu)` come from the
 * verifier's OWN request record, never from the prover. Which account each
 * PVK is read from is dictated by the variant and the event payload (§5.3
 * step 2): `E.to` for D-recipient; `E.from` (originator) plus `E.to`
 * (transfer recipient) for D-sender. A verifier that took any of these from
 * the bundle would prove nothing (§5.4).
 */

import { fromHex, toHex32, hexToBytes } from "../crypto/field.js";
import { addressToField } from "../crypto/address.js";
import { pointCoords } from "../crypto/grumpkin.js";
import type { ChainClient } from "../chain/client.js";
import { type TransferEvent } from "../chain/events.js";
import { hybridResolveEventRef } from "../chain/event-source.js";
import type { IndexerClient } from "../chain/indexer.js";
import type { CircuitProver } from "../proving/prover.js";
import {
  DISCLOSE_SENDER_CIRCUIT_ID,
  DISCLOSURE_CIRCUIT_IDS,
  type DisclosureBundle,
  type DisclosureRequest,
  type RecipientKeys,
} from "./types.js";
import { pointFromJson, decryptDisclosure } from "./recipient.js";

/** Which §5.3 step a rejection happened at (§15.3: typed errors). */
export type VerifyStage =
  | "vk-pinning"
  | "resolve-event"
  | "resolve-account"
  | "verify-proof"
  | "decrypt";

export class DisclosureVerifyError extends Error {
  constructor(
    readonly stage: VerifyStage,
    message: string,
  ) {
    super(`[${stage}] ${message}`);
    this.name = "DisclosureVerifyError";
  }
}

export interface VerifiedDisclosure {
  /** The disclosed amount — trustworthy as the chain itself (§1.1). */
  amount: bigint;
  /** The resolved on-chain event the proof is pinned to. */
  event: TransferEvent;
  /** What was proven: the disclosing party received or sent the payment. */
  role: "recipient" | "sender";
  /** The account the proof binds to (`E.to` for recipient, `E.from` for sender). */
  disclosingAccount: string;
  /** Human-readable trace of each verifier step, for display. */
  steps: string[];
}

export async function verifyDisclosure(params: {
  client: ChainClient;
  bundle: DisclosureBundle;
  /** The verifier's own request this bundle answers — NOT taken from the bundle. */
  request: DisclosureRequest;
  /** The verifier's keypair (request.pR must be its public half). */
  keys: RecipientKeys;
  /** Prover/verifier over the shared artifact for the BUNDLE's circuit_id. */
  prover: CircuitProver;
  /**
   * Pinned verification key from `@ctd/disclosure` (the vk.json matching the
   * bundle's circuit_id). When given, the VK derived from the loaded circuit
   * bytecode must match byte-for-byte — this is the §5.5 "circuit_id →
   * audited circuit" agreement made checkable.
   */
  pinnedVk?: Uint8Array;
  /**
   * Optional Goldsky indexer. When given, `ref_E` is resolved via the indexer
   * first (so disclosures of transfers older than the RPC's ~7-day window still
   * verify), falling back to the RPC.
   */
  indexer?: IndexerClient;
}): Promise<VerifiedDisclosure> {
  const { client, bundle, request, keys, prover, pinnedVk, indexer } = params;
  const steps: string[] = [];

  if (!DISCLOSURE_CIRCUIT_IDS.includes(bundle.circuitId)) {
    throw new DisclosureVerifyError("vk-pinning", `unknown circuit_id "${bundle.circuitId}"`);
  }
  const isSender = bundle.circuitId === DISCLOSE_SENDER_CIRCUIT_ID;
  if (request.pR.x !== keys.pR.x || request.pR.y !== keys.pR.y) {
    throw new DisclosureVerifyError("decrypt", "request was not issued under this recipient key");
  }

  // §5.5 — pin the verification key before trusting any verify result.
  if (pinnedVk) {
    const vk = await prover.verificationKey();
    if (vk.length !== pinnedVk.length || !vk.every((b, i) => b === pinnedVk[i])) {
      throw new DisclosureVerifyError(
        "vk-pinning",
        `circuit artifact does not match the pinned "${bundle.circuitId}" verification key`,
      );
    }
    steps.push(
      `VK pinned: ${bundle.circuitId} artifact matches the shared ${vk.length}B verification key`,
    );
  }

  // §5.3 step 1 — resolve ref_E to exactly one token-contract event.
  const event = await hybridResolveEventRef(client, indexer, bundle.refE);
  if (!event) {
    throw new DisclosureVerifyError(
      "resolve-event",
      `ref_E does not resolve to a token-contract event (ledger ${bundle.refE.ledger}, id ${bundle.refE.id}) — wrong reference${indexer ? "" : ", or outside the RPC's ~7-day retention window"}`,
    );
  }
  if (event.type !== "transfer") {
    throw new DisclosureVerifyError(
      "resolve-event",
      `disclosures cover Transfer events; ref_E resolved to "${event.type}"`,
    );
  }
  steps.push(
    `Resolved ref_E on-chain: transfer ${event.from.slice(0, 6)}… → ${event.to.slice(0, 6)}… in tx ${event.txHash.slice(0, 10)}… (ledger ${event.ledger})`,
  );

  // §5.3 step 2 — account lookups dictated by the variant + the EVENT payload.
  const disclosingAccount = isSender ? event.from : event.to;
  const accountA = await client.confidentialBalance(disclosingAccount);
  if (!accountA) {
    throw new DisclosureVerifyError(
      "resolve-account",
      `event ${isSender ? "sender" : "recipient"} ${disclosingAccount} has no confidential account record`,
    );
  }
  steps.push(
    `Read PVK_A from the on-chain account at the event's "${isSender ? "from" : "to"}" address (${disclosingAccount.slice(0, 6)}…)`,
  );

  let pvkB: { x: bigint; y: bigint } | null = null;
  if (isSender) {
    const accountB = await client.confidentialBalance(event.to);
    if (!accountB) {
      throw new DisclosureVerifyError(
        "resolve-account",
        `event recipient ${event.to} has no confidential account record`,
      );
    }
    pvkB = pointCoords(accountB.viewingPublicKey);
    steps.push(`Read PVK_B from the on-chain account at the event's "to" address (${event.to.slice(0, 6)}…)`);
  }

  // §5.3 step 3 — auxiliary state: addr_f recomputed from the contract address.
  const addrF = addressToField(client.cfg.contracts.token);

  // §5.3 step 4 — public inputs, in the circuit's exact order. Bundle values
  // used: R_disc and v_tilde_disc only.
  const pvkA = pointCoords(accountA.viewingPublicKey);
  const rE = pointCoords(event.rE);
  const publicInputs = [
    toHex32(addrF),
    toHex32(pvkA.x),
    toHex32(pvkA.y),
    toHex32(rE.x),
    toHex32(rE.y),
    toHex32(event.sigma),
    toHex32(event.vTilde),
    ...(pvkB ? [toHex32(pvkB.x), toHex32(pvkB.y)] : []),
    request.pR.x,
    request.pR.y,
    request.nu,
    bundle.rDisc.x,
    bundle.rDisc.y,
    bundle.vTildeDisc,
  ].map((h) => toHex32(fromHex(h)));
  steps.push("Constructed the public-input vector from chain state + own (P_R, ν)");

  // §5.3 step 5 — UltraHonk verification.
  const ok = await prover.verify({ proof: hexToBytes(bundle.proof), publicInputs });
  if (!ok) {
    throw new DisclosureVerifyError("verify-proof", "UltraHonk proof verification failed");
  }
  steps.push("UltraHonk proof verified against the reconstructed public inputs");

  // §5.3 step 6 — decrypt the sealed value.
  const amount = decryptDisclosure(
    keys.rR,
    pointFromJson(bundle.rDisc),
    fromHex(bundle.vTildeDisc),
    fromHex(request.nu),
  );
  if (amount >= 1n << 127n) {
    throw new DisclosureVerifyError("decrypt", "decrypted value out of range — wrong recipient key?");
  }
  steps.push(`Decrypted ṽ_disc with r_R and ν → amount ${amount}`);

  return {
    amount,
    event,
    role: isSender ? "sender" : "recipient",
    disclosingAccount,
    steps,
  };
}
