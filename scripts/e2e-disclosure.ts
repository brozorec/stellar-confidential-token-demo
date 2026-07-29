/**
 * Selective-disclosure end-to-end on testnet (SELECTIVE_DISCLOSURE.md §12):
 *
 *   register(Alice) · register(Bob)
 *     → deposit(Alice) → merge(Alice)
 *     → confidential_transfer(Alice → Bob, 400)        [the disclosed event]
 *     → receiver mints (P_R, ν)                        [off-chain]
 *     → Bob proves D-recipient over the REAL event     [off-chain]
 *     → receiver runs the full §5.3 verifier protocol  [off-chain, reads chain]
 *       (resolve ref_E via RPC, read PVK from chain, VK pin, verify, decrypt)
 *
 * Plus rejection paths: a stale/foreign nonce and a ref_E pointing at a
 * non-transfer event must both hard-reject.
 *
 * Usage: pnpm --filter @ctd/sdk exec tsx ../../scripts/e2e-disclosure.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

import { REPO_ROOT, RPC_URL, PASSPHRASE, loadDeployment, friendbotFund } from "./_shared.js";
import { ChainClient, keypairSigner, type Signer } from "../packages/sdk/src/chain/client.js";
import { deriveKeys, type KeyPair } from "../packages/sdk/src/crypto/keys.js";
import { addressToField } from "../packages/sdk/src/crypto/address.js";
import { randomScalar, toHex32 } from "../packages/sdk/src/crypto/field.js";
import { deriveEphemeralRE } from "../packages/sdk/src/crypto/poseidon2.js";
import { buildRegisterWitness } from "../packages/sdk/src/witness/register.js";
import { buildTransferWitness } from "../packages/sdk/src/witness/transfer.js";
import { CircuitProver } from "../packages/sdk/src/proving/prover.js";
import { loadCircuit } from "../packages/sdk/src/proving/artifacts.js";
import { submitRegister, submitDeposit, submitMerge, submitTransfer } from "../packages/sdk/src/chain/contract.js";
import { StateEngine, MemoryStore } from "../packages/sdk/src/state/index.js";
import { fetchEvents, type TransferEvent, type DepositEvent } from "../packages/sdk/src/chain/events.js";
import {
  generateRecipientKeys,
  newDisclosureRequest,
} from "../packages/sdk/src/disclosure/recipient.js";
import { proveRecipientDisclosure, proveSenderDisclosure } from "../packages/sdk/src/disclosure/prove.js";
import { verifyDisclosure, DisclosureVerifyError } from "../packages/sdk/src/disclosure/verify.js";
import type { DisclosureBundle } from "../packages/sdk/src/disclosure/types.js";

const AUDITOR_ID = 0;
const DEPOSIT = 1000n;
const TRANSFER = 400n;

const ARTIFACTS = join(REPO_ROOT, "packages/disclosure/artifacts");

async function freshAccount(label: string): Promise<{ kp: Keypair; signer: Signer }> {
  const kp = Keypair.random();
  await friendbotFund(kp.publicKey());
  console.log(`  ${label} = ${kp.publicKey()}`);
  return { kp, signer: keypairSigner(kp.secret(), PASSPHRASE) };
}

async function main(): Promise<void> {
  const dep = loadDeployment();
  console.log(`token   = ${dep.contracts.token}`);
  const client = new ChainClient({
    rpcUrl: RPC_URL,
    networkPassphrase: PASSPHRASE,
    contracts: { token: dep.contracts.token, verifier: dep.contracts.verifier, auditor: dep.contracts.auditor },
  });

  const addrF = addressToField(dep.contracts.token);
  const kAud = await client.auditorKey(AUDITOR_ID);
  const startLedger = await client.latestLedger();

  const registerProver = new CircuitProver(loadCircuit("register"));
  const transferProver = new CircuitProver(loadCircuit("transfer"));
  const loadArtifact = (n: string) => JSON.parse(readFileSync(join(ARTIFACTS, n), "utf8"));
  const pinned = (vkJson: { vkBase64: string }) => new Uint8Array(Buffer.from(vkJson.vkBase64, "base64"));
  const disclosureProver = new CircuitProver(loadArtifact("disclose_recipient.json"));
  const pinnedVk = pinned(loadArtifact("disclose_recipient.vk.json"));
  const senderProver = new CircuitProver(loadArtifact("disclose_sender.json"));
  const senderPinnedVk = pinned(loadArtifact("disclose_sender.vk.json"));

  try {
    console.log("\n[accounts]");
    const alice = await freshAccount("alice");
    const bob = await freshAccount("bob");
    const aliceKeys: KeyPair = deriveKeys(randomScalar(), addrF);
    const bobKeys: KeyPair = deriveKeys(randomScalar(), addrF);
    const aliceEngine = new StateEngine({
      client, store: new MemoryStore(), keys: aliceKeys,
      address: alice.kp.publicKey(), fromLedger: startLedger,
    });

    console.log("\n[register + fund]");
    for (const [who, keys, acct] of [["alice", aliceKeys, alice], ["bob", bobKeys, bob]] as const) {
      const w = buildRegisterWitness(keys, acct.kp.publicKey());
      const { proof } = await registerProver.prove(w.inputs);
      await submitRegister(client, acct.signer, acct.kp.publicKey(), AUDITOR_ID, w, proof);
      console.log(`  ${who} registered`);
    }
    await submitDeposit(client, alice.signer, alice.kp.publicKey(), alice.kp.publicKey(), DEPOSIT);
    await submitMerge(client, alice.signer, alice.kp.publicKey());

    console.log("\n[transfer] alice → bob", TRANSFER.toString());
    const s = await aliceEngine.sync();
    const tw = buildTransferWitness({
      keys: aliceKeys, v: s.spendable.v, r: s.spendable.r, amount: TRANSFER,
      pvkB: bobKeys.PVK, kAudR: kAud, kAudS: kAud,
    });
    const { proof: transferProof } = await transferProver.prove(tw.inputs);
    const r = await submitTransfer(client, alice.signer, alice.kp.publicKey(), bob.kp.publicKey(), tw, transferProof);
    console.log(`  transferred (tx ${r.hash.slice(0, 8)}…)`);

    // The disclosed event, exactly as any client would see it from the RPC.
    const { events } = await fetchEvents(client, { startLedger });
    const transferEvent = events.find(
      (ev): ev is TransferEvent => ev.type === "transfer" && ev.txHash === r.hash,
    );
    if (!transferEvent) throw new Error("transfer event not found via getEvents");
    console.log(`  event ref = ledger ${transferEvent.ledger}, id ${transferEvent.cursor}`);

    console.log("\n[disclosure] receiver mints request; bob proves D-recipient");
    const receiver = generateRecipientKeys();
    const request = newDisclosureRequest(receiver);
    const bundle = await proveRecipientDisclosure({
      keys: bobKeys, event: transferEvent, request, prover: disclosureProver,
    });
    // Round-trip through JSON — the bundle travels as copy/paste text.
    const wireBundle = JSON.parse(JSON.stringify(bundle)) as DisclosureBundle;
    console.log(`  bundle: proof ${ (wireBundle.proof.length - 2) / 2 }B, ref tx ${wireBundle.refE.txHash.slice(0, 8)}…`);

    console.log("\n[verify] full §5.3 protocol against the live chain");
    const verdict = await verifyDisclosure({
      client, bundle: wireBundle, request, keys: receiver, prover: disclosureProver, pinnedVk,
    });
    for (const step of verdict.steps) console.log(`  · ${step}`);
    assert(verdict.amount === TRANSFER, `disclosed amount ${verdict.amount}, want ${TRANSFER}`);
    assert(verdict.role === "recipient", "expected recipient role");
    assert(verdict.disclosingAccount === bob.kp.publicKey(), "disclosing account mismatch");
    console.log(`  disclosed amount = ${verdict.amount} ✓`);

    console.log("\n[disclosure] alice proves D-sender over the SAME event (r_e re-derived from the event)");
    const senderReceiver = generateRecipientKeys();
    const senderRequest = newDisclosureRequest(senderReceiver);
    const bobAccount = await client.confidentialBalance(bob.kp.publicKey());
    if (!bobAccount) throw new Error("bob has no on-chain account");
    const senderBundle = await proveSenderDisclosure({
      keys: aliceKeys,
      // No retained state: r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma) is
      // recomputed from vk + the event's public sigma alone.
      rEScalar: deriveEphemeralRE(aliceKeys.vk, transferEvent.sigma),
      event: transferEvent,
      pvkB: bobAccount.viewingPublicKey,
      request: senderRequest,
      prover: senderProver,
    });
    const senderVerdict = await verifyDisclosure({
      client,
      bundle: JSON.parse(JSON.stringify(senderBundle)) as DisclosureBundle,
      request: senderRequest,
      keys: senderReceiver,
      prover: senderProver,
      pinnedVk: senderPinnedVk,
    });
    for (const step of senderVerdict.steps) console.log(`  · ${step}`);
    assert(senderVerdict.amount === TRANSFER, `sender-disclosed amount ${senderVerdict.amount}, want ${TRANSFER}`);
    assert(senderVerdict.role === "sender", "expected sender role");
    assert(senderVerdict.disclosingAccount === alice.kp.publicKey(), "sender disclosing account mismatch");
    console.log(`  sender-disclosed amount = ${senderVerdict.amount} ✓`);

    console.log("\n[rejection] same bundle, different request nonce (replay)");
    const staleRequest = { ...request, nu: toHex32(randomScalar()) };
    await expectReject(
      () => verifyDisclosure({ client, bundle: wireBundle, request: staleRequest, keys: receiver, prover: disclosureProver, pinnedVk }),
      "verify-proof",
    );

    console.log("[rejection] ref_E pointing at a non-transfer event");
    const depositEvent = events.find((ev): ev is DepositEvent => ev.type === "deposit");
    if (!depositEvent) throw new Error("deposit event not found");
    const forgedBundle: DisclosureBundle = {
      ...wireBundle,
      refE: { ledger: depositEvent.ledger, id: depositEvent.cursor, txHash: depositEvent.txHash },
    };
    await expectReject(
      () => verifyDisclosure({ client, bundle: forgedBundle, request, keys: receiver, prover: disclosureProver, pinnedVk }),
      "resolve-event",
    );

    console.log("\n✅ disclosure e2e complete — proof bound to a real on-chain event, verified off-chain.");
  } finally {
    await Promise.all([
      registerProver.destroy(),
      transferProver.destroy(),
      disclosureProver.destroy(),
      senderProver.destroy(),
    ]);
  }
}

async function expectReject(run: () => Promise<unknown>, stage: string): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof DisclosureVerifyError && e.stage === stage) {
      console.log(`  rejected at "${e.stage}" ✓`);
      return;
    }
    throw e;
  }
  throw new Error(`expected rejection at "${stage}", but verification succeeded`);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
