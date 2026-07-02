/**
 * ConfidentialWallet — UI-facing orchestration over @ctd/sdk.
 *
 * Holds the RPC client, the Freighter signer, the user's confidential key set,
 * a local state engine, and lazily-created provers. All proving happens in the
 * browser (bb.js); the confidential `sk` never leaves the device. It is
 * derived deterministically from a Freighter `signMessage` signature over a
 * deployment-bound message (see derive-key.ts) and cached in localStorage so
 * the signature prompt only appears once per account + deployment.
 */

import {
  ChainClient,
  type Signer,
  type OnChainAccount,
  deriveKeys,
  type KeyPair,
  addressToField,
  toHex32,
  fromHex,
  StateEngine,
  LocalStorageStore,
  type AccountState,
  type CircuitProver,
  proverFromArtifact,
  buildRegisterWitness,
  buildWithdrawWitness,
  buildTransferWitness,
  submitRegister,
  submitDeposit,
  submitMerge,
  submitWithdraw,
  submitTransfer,
  IndexerClient,
  hybridFetchEvents,
  proveRecipientDisclosure,
  proveSenderDisclosure,
  deriveEphemeralRE,
  scalarMul,
  H,
  pointCoords,
  ecdh,
  decryptWithDomain,
  DOMAIN,
  type ConfidentialEvent,
  type TransferEvent,
  type DisclosureRequest,
  type DisclosureBundle,
} from "@ctd/sdk";
import registerCircuit from "@ctd/sdk/circuits/register.json";
import withdrawCircuit from "@ctd/sdk/circuits/withdraw.json";
import transferCircuit from "@ctd/sdk/circuits/transfer.json";
import discloseRecipientCircuit from "@ctd/disclosure/artifacts/disclose_recipient.json";
import discloseSenderCircuit from "@ctd/disclosure/artifacts/disclose_sender.json";

import type { Deployment } from "./deployment";
import { connectFreighter } from "./freighter";
import { keyDerivationMessage, skFromSignature } from "./derive-key";
import { ensureBrowserBackend } from "./bb-loader";

type Log = (msg: string) => void;
type CircuitName = "register" | "withdraw" | "transfer" | "disclose_recipient" | "disclose_sender";

const CIRCUITS: Record<CircuitName, { bytecode: string } & Record<string, unknown>> = {
  register: registerCircuit as never,
  withdraw: withdrawCircuit as never,
  transfer: transferCircuit as never,
  disclose_recipient: discloseRecipientCircuit as never,
  disclose_sender: discloseSenderCircuit as never,
};

/** Coarse progress of a proof-carrying operation, for UI button labels. */
export type TxPhase = "proving" | "submitting";

export interface WalletView {
  address: string;
  registered: boolean;
  spendable: bigint;
  receiving: bigint;
  syncedLedger: number;
  matchesChain: boolean | null;
}

export class ConfidentialWallet {
  private provers = new Map<CircuitName, CircuitProver>();
  /** In-flight full-history fetch shared by concurrent callers (see fetchAllEvents). */
  private inFlightEvents: Promise<ConfidentialEvent[]> | null = null;

  private constructor(
    readonly address: string,
    private deployment: Deployment,
    private signer: Signer,
    private keys: KeyPair,
    private client: ChainClient,
    private engine: StateEngine,
    private indexer: IndexerClient | undefined,
    private log: Log,
  ) {}

  static async connect(deployment: Deployment, log: Log): Promise<ConfidentialWallet> {
    ensureBrowserBackend();
    const signer = await connectFreighter();
    log(`connected ${signer.publicKey}`);
    log(`deployment: ${deployment.label} (token ${deployment.contracts.token.slice(0, 6)}…)`);

    const client = new ChainClient({
      rpcUrl: deployment.rpcUrl,
      networkPassphrase: deployment.networkPassphrase,
      contracts: deployment.contracts,
    });

    // Keys are token-bound (addr_f domain separation), so a different deployment
    // derives a different key set and caches under a different localStorage key.
    const tokenId = deployment.contracts.token;
    const addrF = addressToField(tokenId);
    const skKey = `ctd:sk:${tokenId}:${signer.publicKey}`;
    let sk: bigint;
    const stored = localStorage.getItem(skKey);
    if (stored) {
      sk = fromHex(stored);
    } else {
      log("sign the key-derivation message in Freighter…");
      const signature = await signer.signMessage(
        keyDerivationMessage(deployment.networkPassphrase, tokenId),
      );
      sk = await skFromSignature(signature);
      localStorage.setItem(skKey, toHex32(sk));
      log("derived confidential key from wallet signature (cached in localStorage)");
    }
    const keys = deriveKeys(sk, addrF);

    // Optional Goldsky indexer: when configured, the hybrid event source
    // backfills history older than the RPC's ~7-day window. Without it the app
    // is RPC-only (today's behavior).
    const indexer = deployment.indexerUrl
      ? new IndexerClient({ baseUrl: deployment.indexerUrl })
      : undefined;
    if (indexer) log(`indexer configured (${deployment.indexerUrl})`);

    // State store is namespaced by token address so separate deployments using
    // the same Freighter account don't corrupt each other's balances. The
    // pre-namespacing default-deployment cache (`ctd:state:<addr>`) is orphaned;
    // with the indexer available, the first sync rebuilds full history, so we
    // just clear the legacy key once to avoid clutter.
    if (deployment.id === "default") {
      try {
        localStorage.removeItem(`ctd:state:${signer.publicKey}`);
      } catch {
        /* ignore */
      }
    }

    const engine = new StateEngine({
      client,
      store: new LocalStorageStore(`ctd:state:${tokenId}:`),
      keys,
      address: signer.publicKey,
      // Start from the deploy ledger, unclamped: hybridFetchEvents clamps the
      // RPC leg to the retention window and routes anything older to the indexer.
      fromLedger: deployment.deployedAtLedger,
      indexer,
    });

    return new ConfidentialWallet(
      signer.publicKey,
      deployment,
      signer,
      keys,
      client,
      engine,
      indexer,
      log,
    );
  }

  private prover(name: CircuitName): CircuitProver {
    let p = this.provers.get(name);
    if (!p) {
      p = proverFromArtifact(CIRCUITS[name]);
      this.provers.set(name, p);
    }
    return p;
  }

  /** Read on-chain account (null if not registered). */
  async account(): Promise<OnChainAccount | null> {
    return this.client.confidentialBalance(this.address);
  }

  async register(onPhase?: (p: TxPhase) => void): Promise<void> {
    const w = buildRegisterWitness(this.keys);
    onPhase?.("proving");
    this.log("proving register…");
    const { proof } = await this.prover("register").prove(w.inputs);
    onPhase?.("submitting");
    this.log("submitting register…");
    const r = await submitRegister(this.client, this.signer, this.address, this.deployment.auditorId, w, proof);
    this.log(`registered (tx ${r.hash.slice(0, 10)}…)`);
  }

  async deposit(amount: bigint): Promise<void> {
    this.log(`depositing ${amount}…`);
    const r = await submitDeposit(this.client, this.signer, this.address, this.address, amount);
    this.log(`deposited (tx ${r.hash.slice(0, 10)}…) → receiving balance`);
  }

  async merge(): Promise<void> {
    this.log("merging receiving → spendable…");
    const r = await submitMerge(this.client, this.signer, this.address);
    this.log(`merged (tx ${r.hash.slice(0, 10)}…)`);
  }

  async transfer(to: string, amount: bigint, onPhase?: (p: TxPhase) => void): Promise<void> {
    const recipient = await this.client.confidentialBalance(to);
    if (!recipient) throw new Error("recipient is not registered");
    const kAudR = await this.client.auditorKey(recipient.auditorId);
    const kAudS = await this.client.auditorKey(this.deployment.auditorId);

    const s = await this.engine.sync();
    if (s.spendable.v < amount) throw new Error(`insufficient spendable balance (${s.spendable.v})`);

    const w = buildTransferWitness({
      keys: this.keys,
      v: s.spendable.v,
      r: s.spendable.r,
      amount,
      pvkB: recipient.viewingPublicKey,
      kAudR,
      kAudS,
    });
    onPhase?.("proving");
    this.log("proving transfer…");
    const { proof } = await this.prover("transfer").prove(w.inputs);
    onPhase?.("submitting");
    this.log("submitting transfer…");
    const r = await submitTransfer(this.client, this.signer, this.address, to, w, proof);
    await this.engine.setSpendable(w.next);
    // No r_e bookkeeping (§15.2): the witness derives it from (vk, sigma), so
    // discloseSent() re-derives it from the emitted event whenever needed.
    this.log(`transferred ${amount} → ${to.slice(0, 6)}… (tx ${r.hash.slice(0, 10)}…)`);
  }

  async withdraw(amount: bigint, onPhase?: (p: TxPhase) => void): Promise<void> {
    const kAudS = await this.client.auditorKey(this.deployment.auditorId);
    const s = await this.engine.sync();
    if (s.spendable.v < amount) throw new Error(`insufficient spendable balance (${s.spendable.v})`);

    const w = buildWithdrawWitness({ keys: this.keys, v: s.spendable.v, r: s.spendable.r, amount, kAudS });
    onPhase?.("proving");
    this.log("proving withdraw…");
    const { proof } = await this.prover("withdraw").prove(w.inputs);
    onPhase?.("submitting");
    this.log("submitting withdraw…");
    const r = await submitWithdraw(this.client, this.signer, this.address, this.address, amount, w, proof);
    await this.engine.setSpendable(w.next);
    this.log(`withdrew ${amount} → public (tx ${r.hash.slice(0, 10)}…)`);
  }

  /**
   * This account's token-contract events, newest first. With an indexer
   * configured this spans the full history; otherwise it is limited to the
   * RPC's ~7-day retention window.
   */
  async listEvents(): Promise<ConfidentialEvent[]> {
    const events = await this.fetchAllEvents();
    return events.filter((ev) => this.concernsMe(ev)).reverse();
  }

  /**
   * Other accounts with a `register` event — the way to enumerate possible
   * transfer recipients. With an indexer this covers the full history; without
   * one, an account registered more than ~7 days ago won't appear.
   */
  async registeredRecipients(): Promise<string[]> {
    const seen = new Set<string>();
    for (const ev of await this.fetchAllEvents()) {
      if (ev.type === "register" && ev.account !== this.address) seen.add(ev.account);
    }
    return [...seen];
  }

  /**
   * Full token-event history (indexer + RPC), the source for both the activity
   * list and recipient discovery.
   *
   * Single-flight: `listEvents()` and `registeredRecipients()` both run a
   * full-history scan and fire near-simultaneously on connect. Concurrent
   * callers share ONE in-flight fetch; the moment it settles the slot is
   * cleared, so any LATER call (the activity panel's Reload, a post-tx refresh,
   * the recipients refresh button) re-fetches and picks up new events —
   * including ones from other accounts. This only de-duplicates overlapping
   * requests; it never serves stale data, so there is no cache to invalidate.
   */
  private async fetchAllEvents(): Promise<ConfidentialEvent[]> {
    if (this.inFlightEvents) return this.inFlightEvents;
    const fetch = hybridFetchEvents(this.client, this.indexer, {
      fromLedger: this.deployment.deployedAtLedger,
    }).then((r) => r.events);
    this.inFlightEvents = fetch;
    try {
      return await fetch;
    } finally {
      this.inFlightEvents = null;
    }
  }

  private concernsMe(ev: ConfidentialEvent): boolean {
    switch (ev.type) {
      case "register":
      case "merge":
        return ev.account === this.address;
      case "deposit":
      case "withdraw":
      case "transfer":
        return ev.from === this.address || ev.to === this.address;
      default:
        // Compliance/policy membership events are surfaced in the admin
        // dashboard, not the wallet activity list.
        return false;
    }
  }

  // ---- selective disclosure (SELECTIVE_DISCLOSURE.md §12, holder side) -----

  /**
   * Recover the ephemeral scalar for an outgoing transfer:
   * `r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma)`, checked against the event's
   * `R_e`. No per-transfer state — `sigma` is public in the event. `null`
   * means the transfer wasn't built with this wallet's keys and the
   * deterministic derivation (e.g. a pre-derivation random-r_e transfer).
   */
  private recoverRE(event: TransferEvent): bigint | null {
    const eventRE = pointCoords(event.rE);
    const derived = deriveEphemeralRE(this.keys.vk, event.sigma);
    const derivedRE = pointCoords(scalarMul(derived, H));
    if (derivedRE.x === eventRE.x && derivedRE.y === eventRE.y) return derived;
    return null;
  }

  /** True iff this wallet can produce the ephemeral scalar for an outgoing transfer. */
  canDiscloseSent(event: TransferEvent): boolean {
    return this.recoverRE(event) !== null;
  }

  /**
   * Decrypt a confidential transfer's amount for local display, from whichever
   * side this wallet is on:
   *   - inbound (to === me):  ECDH with this wallet's viewing key.
   *   - outbound (from === me): re-derive the ephemeral scalar (§15.2) and ECDH
   *     against the recipient's stored viewing key — the same recovery as
   *     discloseSent, minus the proof.
   * Returns null when the amount can't be recovered here: an outbound transfer
   * not built with these keys (non-deterministic r_e), or a recipient with no
   * on-chain account record. The amount stays confidential on-chain regardless.
   */
  async transferAmount(event: TransferEvent): Promise<bigint | null> {
    // Inbound path also covers a self-transfer (to === from === me).
    if (event.to === this.address) {
      return this.engine.decryptIncoming(event.rE, event.vTilde, event.sigma).vTx;
    }
    if (event.from === this.address) {
      const rEScalar = this.recoverRE(event);
      if (rEScalar === null) return null;
      const recipient = await this.client.confidentialBalance(event.to);
      if (!recipient) return null;
      const sBx = ecdh(rEScalar, recipient.viewingPublicKey);
      const vTx = decryptWithDomain(event.vTilde, DOMAIN.TX_AMOUNT, sBx, event.sigma);
      // A wrong key yields garbage far outside the 127-bit amount range.
      if (vTx >= 1n << 127n) return null;
      return vTx;
    }
    return null;
  }

  /**
   * Produce a D-recipient disclosure bundle for an inbound transfer event,
   * answering a third party's `(P_R, ν)` request. Runs the disclosure circuit
   * in-browser; only works for events whose `to` is this wallet.
   */
  async discloseReceived(event: TransferEvent, request: DisclosureRequest): Promise<DisclosureBundle> {
    if (event.to !== this.address) {
      throw new Error("D-recipient disclosure only works for transfers addressed to this wallet");
    }
    this.log("proving disclosure (D-recipient)…");
    const bundle = await proveRecipientDisclosure({
      keys: this.keys,
      event,
      request,
      prover: this.prover("disclose_recipient"),
    });
    this.log(`disclosure proof ready for event in tx ${event.txHash.slice(0, 10)}…`);
    return bundle;
  }

  /**
   * Produce a D-sender disclosure bundle for an outgoing transfer event. The
   * ephemeral scalar is re-derived from `vk` + the event's public `sigma`
   * (deterministic r_e) — no per-transfer state (§7).
   */
  async discloseSent(event: TransferEvent, request: DisclosureRequest): Promise<DisclosureBundle> {
    if (event.from !== this.address) {
      throw new Error("D-sender disclosure only works for transfers sent by this wallet");
    }
    const rEScalar = this.recoverRE(event);
    if (rEScalar === null) {
      throw new Error(
        "the event's R_e doesn't match this wallet's derived ephemeral scalar — the transfer wasn't sent with these keys (or used a non-deterministic r_e)",
      );
    }
    const recipient = await this.client.confidentialBalance(event.to);
    if (!recipient) throw new Error("transfer recipient has no confidential account record");
    this.log("proving disclosure (D-sender)…");
    const bundle = await proveSenderDisclosure({
      keys: this.keys,
      rEScalar,
      event,
      pvkB: recipient.viewingPublicKey,
      request,
      prover: this.prover("disclose_sender"),
    });
    this.log(`disclosure proof ready for event in tx ${event.txHash.slice(0, 10)}…`);
    return bundle;
  }

  /** Sync from RPC events, verify against chain, and return a UI view. */
  async refresh(): Promise<WalletView> {
    const state: AccountState = await this.engine.sync();
    const onchain = await this.account();
    let matchesChain: boolean | null = null;
    if (onchain) {
      matchesChain = (await this.engine.verifyAgainstChain()).ok;
    }
    return {
      address: this.address,
      registered: onchain !== null,
      spendable: state.spendable.v,
      receiving: state.receiving.v,
      syncedLedger: state.syncedLedger,
      matchesChain,
    };
  }
}
