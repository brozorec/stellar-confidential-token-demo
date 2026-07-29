/**
 * End-to-end flow on testnet — the full-stack validation:
 *
 *   register(Alice) · register(Bob)
 *     → deposit(Alice, 1000)  [public XLM → Alice's receiving]
 *     → merge(Alice)          [receiving → spendable]
 *     → confidential_transfer(Alice → Bob, 400)
 *     → merge(Bob) → withdraw(Bob → public, 400)
 *
 * After each step the local StateEngine reconstructs balances purely from RPC
 * events and asserts `commit(v, r)` matches the on-chain commitments. Every
 * proof is verified ON-CHAIN by the UltraHonk verifier, so a green run proves
 * the whole pipeline: crypto parity, proof acceptance, XDR envelopes, event
 * parsing, and state reconstruction.
 *
 * Usage: pnpm --filter @ctd/sdk exec tsx ../../scripts/e2e.ts
 * Uses two FRESH friendbot-funded accounts each run (so register never clashes).
 */

import { Keypair } from "@stellar/stellar-sdk";

import { RPC_URL, PASSPHRASE, loadDeployment, friendbotFund } from "./_shared.js";
import { ChainClient, keypairSigner, type Signer } from "../packages/sdk/src/chain/client.js";
import { deriveKeys, type KeyPair } from "../packages/sdk/src/crypto/keys.js";
import { addressToField } from "../packages/sdk/src/crypto/address.js";
import { randomScalar } from "../packages/sdk/src/crypto/field.js";
import { type Point } from "../packages/sdk/src/crypto/grumpkin.js";
import { buildRegisterWitness } from "../packages/sdk/src/witness/register.js";
import { buildWithdrawWitness } from "../packages/sdk/src/witness/withdraw.js";
import { buildTransferWitness } from "../packages/sdk/src/witness/transfer.js";
import { CircuitProver } from "../packages/sdk/src/proving/prover.js";
import { loadCircuit } from "../packages/sdk/src/proving/artifacts.js";
import {
  submitRegister, submitDeposit, submitMerge, submitWithdraw, submitTransfer,
} from "../packages/sdk/src/chain/contract.js";
import { StateEngine, MemoryStore } from "../packages/sdk/src/state/index.js";

const AUDITOR_ID = 0;
const DEPOSIT = 1000n;
const TRANSFER = 400n;

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
  const kAud: Point = await client.auditorKey(AUDITOR_ID);

  // Provers (one backend per circuit, reused).
  const registerProver = new CircuitProver(loadCircuit("register"));
  const withdrawProver = new CircuitProver(loadCircuit("withdraw"));
  const transferProver = new CircuitProver(loadCircuit("transfer"));

  try {
    console.log("\n[accounts]");
    const alice = await freshAccount("alice");
    const bob = await freshAccount("bob");
    const aliceKeys: KeyPair = deriveKeys(randomScalar(), addrF);
    const bobKeys: KeyPair = deriveKeys(randomScalar(), addrF);

    const aliceEngine = new StateEngine({
      client, store: new MemoryStore(), keys: aliceKeys,
      address: alice.kp.publicKey(), fromLedger: dep.deployedAtLedger,
    });
    const bobEngine = new StateEngine({
      client, store: new MemoryStore(), keys: bobKeys,
      address: bob.kp.publicKey(), fromLedger: dep.deployedAtLedger,
    });

    console.log("\n[register]");
    {
      const w = buildRegisterWitness(aliceKeys, alice.kp.publicKey());
      const { proof } = await registerProver.prove(w.inputs);
      const r = await submitRegister(client, alice.signer, alice.kp.publicKey(), AUDITOR_ID, w, proof);
      console.log(`  alice registered (tx ${r.hash.slice(0, 8)}…, on-chain proof OK)`);
    }
    {
      const w = buildRegisterWitness(bobKeys, bob.kp.publicKey());
      const { proof } = await registerProver.prove(w.inputs);
      const r = await submitRegister(client, bob.signer, bob.kp.publicKey(), AUDITOR_ID, w, proof);
      console.log(`  bob registered (tx ${r.hash.slice(0, 8)}…)`);
    }

    console.log("\n[deposit + merge] alice deposits", DEPOSIT.toString());
    await submitDeposit(client, alice.signer, alice.kp.publicKey(), alice.kp.publicKey(), DEPOSIT);
    await submitMerge(client, alice.signer, alice.kp.publicKey());
    {
      const s = await aliceEngine.sync();
      const v = await aliceEngine.verifyAgainstChain();
      assert(s.spendable.v === DEPOSIT, `alice spendable v=${s.spendable.v}, want ${DEPOSIT}`);
      assert(v.ok, `alice state mismatch after merge: ${JSON.stringify(v)}`);
      console.log(`  alice spendable = ${s.spendable.v} (state matches chain ✓)`);
    }

    console.log("\n[transfer] alice → bob", TRANSFER.toString());
    {
      const s = await aliceEngine.current();
      const w = buildTransferWitness({
        keys: aliceKeys, v: s.spendable.v, r: s.spendable.r, amount: TRANSFER,
        pvkB: bobKeys.PVK, kAudR: kAud, kAudS: kAud,
      });
      const { proof } = await transferProver.prove(w.inputs);
      const r = await submitTransfer(client, alice.signer, alice.kp.publicKey(), bob.kp.publicKey(), w, proof);
      console.log(`  transferred (tx ${r.hash.slice(0, 8)}…, on-chain proof OK)`);
    }
    {
      const a = await aliceEngine.sync();
      const av = await aliceEngine.verifyAgainstChain();
      assert(a.spendable.v === DEPOSIT - TRANSFER, `alice spendable v=${a.spendable.v}, want ${DEPOSIT - TRANSFER}`);
      assert(av.ok, `alice state mismatch after transfer: ${JSON.stringify(av)}`);
      console.log(`  alice spendable = ${a.spendable.v} (✓)`);

      const b = await bobEngine.sync();
      const bv = await bobEngine.verifyAgainstChain();
      assert(b.receiving.v === TRANSFER, `bob receiving v=${b.receiving.v}, want ${TRANSFER}`);
      assert(bv.ok, `bob state mismatch: ${JSON.stringify(bv)}`);
      console.log(`  bob receiving = ${b.receiving.v} (decrypted from event, matches chain ✓)`);
    }

    console.log("\n[merge + withdraw] bob withdraws", TRANSFER.toString());
    await submitMerge(client, bob.signer, bob.kp.publicKey());
    {
      const s = await bobEngine.sync();
      const w = buildWithdrawWitness({
        keys: bobKeys, v: s.spendable.v, r: s.spendable.r, amount: TRANSFER, kAudS: kAud,
      });
      const { proof } = await withdrawProver.prove(w.inputs);
      const r = await submitWithdraw(client, bob.signer, bob.kp.publicKey(), bob.kp.publicKey(), TRANSFER, w, proof);
      console.log(`  withdrew (tx ${r.hash.slice(0, 8)}…, on-chain proof OK)`);
    }
    {
      const b = await bobEngine.sync();
      const bv = await bobEngine.verifyAgainstChain();
      assert(b.spendable.v === 0n, `bob spendable v=${b.spendable.v}, want 0`);
      assert(bv.ok, `bob final state mismatch: ${JSON.stringify(bv)}`);
      console.log(`  bob spendable = ${b.spendable.v} (✓)`);
    }

    console.log("\n✅ e2e complete — full confidential flow verified on testnet.");
  } finally {
    await Promise.all([registerProver.destroy(), withdrawProver.destroy(), transferProver.destroy()]);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
