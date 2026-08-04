/**
 * Soroban RPC client: read-only simulation, full invoke (build → simulate →
 * assemble → sign → send → poll), and typed reads of confidential state.
 *
 * No indexer. State that the protocol exposes only through events is read with
 * the RPC `getEvents` API (see `events.ts`), accepting its ~7-day retention
 * window — the central trade-off of this demo.
 */

import {
  xdr,
  Address,
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  rpc,
} from "@stellar/stellar-sdk";

import { pointFromBytes, type Point } from "../crypto/grumpkin.js";

/** Source used for read-only simulation; never signs, never pays. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60;

/**
 * Minimal transaction signer. A Node script wraps a {@link Keypair} via
 * {@link keypairSigner}; the web app wraps Freighter's `signTransaction`.
 */
export interface Signer {
  /** G-address of the signer (transaction source / auth principal). */
  publicKey: string;
  /** Sign an assembled transaction (base64 XDR) and return signed base64 XDR. */
  sign(txXdrBase64: string): Promise<string>;
}

export interface ContractIds {
  token: string;
  verifier: string;
  auditor: string;
}

export interface ChainConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: ContractIds;
}

export interface InvokeResult {
  hash: string;
  status: string;
  /** Return value of the invoked function (if any). */
  returnValue?: xdr.ScVal;
}

/** On-chain confidential account (`confidential_balance` return value). */
export interface OnChainAccount {
  spendingKey: Point;
  viewingPublicKey: Point;
  spendableBalance: Point;
  receivingBalance: Point;
  auditorId: number;
}

export function keypairSigner(secret: string, networkPassphrase: string): Signer {
  const kp = Keypair.fromSecret(secret);
  return {
    publicKey: kp.publicKey(),
    async sign(txXdrBase64: string): Promise<string> {
      const tx = TransactionBuilder.fromXDR(txXdrBase64, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

export class ChainClient {
  readonly server: rpc.Server;

  constructor(readonly cfg: ChainConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
    });
  }

  // ----- reads -------------------------------------------------------------

  /** Simulate a read-only call and return its raw `ScVal` result. */
  async simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const account = await this.server
      .getAccount(NULL_ACCOUNT)
      .catch(() => new Account(NULL_ACCOUNT, "0"));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${method} failed: ${sim.error}`);
    }
    const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
    if (!ok.result) throw new Error(`simulate ${method}: no result`);
    return ok.result.retval;
  }

  /**
   * Read a confidential account, or `null` if `address` is not registered.
   *
   * Only the simulate call is treated as "not registered" (the contract panics
   * with `AccountNotRegistered`). A {@link parseAccount} failure is a real
   * SDK/contract mismatch and propagates — swallowing it here would report every
   * account as unregistered after an upstream field rename.
   */
  async confidentialBalance(address: string): Promise<OnChainAccount | null> {
    let retval: xdr.ScVal;
    try {
      retval = await this.simulate(this.cfg.contracts.token, "confidential_balance", [
        new Address(address).toScVal(),
      ]);
    } catch {
      return null;
    }
    return parseAccount(retval);
  }

  async isRegistered(address: string): Promise<boolean> {
    return (await this.confidentialBalance(address)) !== null;
  }

  /** Fetch auditor key `K_aud` (BytesN<64>) for an `auditor_id`. */
  async auditorKey(auditorId: number): Promise<Point> {
    const retval = await this.simulate(this.cfg.contracts.auditor, "get_key", [
      xdr.ScVal.scvU32(auditorId),
    ]);
    return pointFromBytes(new Uint8Array(retval.bytes()));
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getHealth()).latestLedger;
  }

  // ----- writes ------------------------------------------------------------

  /**
   * Build, simulate, assemble, sign, submit, and poll a contract invocation.
   * Auth is taken from simulation; for these demo ops the source account is the
   * sole auth principal, so a single signature suffices.
   */
  async invoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signer: Signer,
  ): Promise<InvokeResult> {
    const source = await this.server.getAccount(signer.publicKey);
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(180)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${method} failed: ${sim.error}`);
    }
    const assembled = rpc.assembleTransaction(tx, sim).build();

    const signedXdr = await signer.sign(assembled.toXDR());
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);

    const send = await this.server.sendTransaction(signedTx);
    if (send.status === "ERROR") {
      throw new Error(`send ${method} rejected: ${JSON.stringify(send.errorResult)}`);
    }

    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const res = await this.server.getTransaction(send.hash);
      if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`${method} failed on-chain (tx ${send.hash})`);
      }
      return { hash: send.hash, status: res.status, returnValue: res.returnValue };
    }
    throw new Error(`${method} confirmation timed out (tx ${send.hash})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decode the `ConfidentialAccount` struct returned by `confidential_balance`.
 *
 * The keys are the upstream struct field names verbatim (`storage.rs`), so they
 * move when upstream renames them — as `spending_key`/`spendable_balance`/
 * `receiving_balance` did, becoming `spending_public_key`/
 * `spendable_commitment`/`receiving_commitment`. The completeness check at the
 * end is what makes such a rename loud: without it an unrecognized key set
 * yields an all-`undefined` object that passes as a registered account and only
 * fails much later, inside commitment arithmetic.
 */
function parseAccount(val: xdr.ScVal): OnChainAccount {
  const entries = val.map();
  if (!entries) throw new Error("expected ScMap for ConfidentialAccount");
  const out: Partial<OnChainAccount> = {};
  for (const e of entries) {
    const key = e.key().sym().toString();
    switch (key) {
      case "spending_public_key":
        out.spendingKey = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "viewing_public_key":
        out.viewingPublicKey = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "spendable_commitment":
        out.spendableBalance = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "receiving_commitment":
        out.receivingBalance = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "auditor_id":
        out.auditorId = e.val().u32();
        break;
    }
  }
  const missing = (
    ["spendingKey", "viewingPublicKey", "spendableBalance", "receivingBalance", "auditorId"] as const
  ).filter((k) => out[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `ConfidentialAccount is missing ${missing.join(", ")} — the contract's field names ` +
        `(${entries.map((e) => e.key().sym().toString()).join(", ")}) do not match this SDK build`,
    );
  }
  return out as OnChainAccount;
}
