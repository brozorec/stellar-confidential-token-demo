/**
 * Adapts the Freighter browser wallet to the SDK's {@link Signer} interface.
 */
import {
  isConnected,
  requestAccess,
  signTransaction,
  signMessage as freighterSignMessage,
} from "@stellar/freighter-api";
import type { Signer } from "@ctd/sdk";

import { DEPLOYMENT } from "./deployment";
import { errMsg } from "./err";

/** A {@link Signer} that can also sign arbitrary UTF-8 messages (SEP-53). */
export interface MessageSigner extends Signer {
  /** Sign a message and return the raw ed25519 signature bytes. */
  signMessage(message: string): Promise<Uint8Array>;
}

export async function connectFreighter(): Promise<MessageSigner> {
  const conn = await isConnected();
  if (!conn.isConnected) {
    throw new Error("Freighter not detected. Install the Freighter extension.");
  }
  const access = await requestAccess();
  if (access.error) throw new Error(errMsg(access.error));
  const address = access.address;

  return {
    publicKey: address,
    async sign(txXdrBase64: string): Promise<string> {
      const res = await signTransaction(txXdrBase64, {
        networkPassphrase: DEPLOYMENT.networkPassphrase,
        address,
      });
      if (res.error) throw new Error(errMsg(res.error));
      return res.signedTxXdr;
    },
    async signMessage(message: string): Promise<Uint8Array> {
      const res = await freighterSignMessage(message, {
        networkPassphrase: DEPLOYMENT.networkPassphrase,
        address,
      });
      if (res.error) throw new Error(errMsg(res.error));
      if (res.signerAddress !== address) {
        throw new Error(`Freighter signed with ${res.signerAddress}, expected ${address}`);
      }
      return normalizeSignature(res.signedMessage);
    },
  };
}

/** Freighter API v4 returns a base64 string; v3 a Buffer (structured-cloned). */
function normalizeSignature(signed: unknown): Uint8Array {
  if (typeof signed === "string") {
    return Uint8Array.from(atob(signed), (c) => c.charCodeAt(0));
  }
  if (signed instanceof Uint8Array) return new Uint8Array(signed);
  if (signed && typeof signed === "object" && Array.isArray((signed as { data?: unknown }).data)) {
    return Uint8Array.from((signed as { data: number[] }).data);
  }
  throw new Error("Freighter returned no usable message signature");
}
