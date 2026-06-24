"use client";

/**
 * Disclosure-receiver page — the verifying counterparty's tool
 * (SELECTIVE_DISCLOSURE.md §5.3 / §12). This page never connects a Stellar
 * wallet and signs nothing: the receiver is any third party (compliance desk,
 * tax office, KYC provider) with a browser and an RPC endpoint.
 *
 *   1. It holds a long-lived Grumpkin keypair (r_R kept in localStorage) and
 *      mints one-time requests (P_R, ν) to hand to the account holder.
 *   2. The holder pastes the request into the wallet page, proves, and sends
 *      back a bundle.
 *   3. This page resolves the referenced event from the chain itself, rebuilds
 *      the public inputs (trust-boundary rule §5.2 — only R_disc / ṽ_disc come
 *      from the bundle), verifies the UltraHonk proof against the pinned VK
 *      from @ctd/disclosure, and decrypts the disclosed amount.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ChainClient,
  IndexerClient,
  CircuitProver,
  proverFromArtifact,
  generateRecipientKeys,
  recipientKeysFromSecret,
  newDisclosureRequest,
  verifyDisclosure,
  DisclosureVerifyError,
  toHex32,
  fromHex,
  type RecipientKeys,
  type DisclosureRequest,
  type DisclosureBundle,
  type VerifiedDisclosure,
} from "@ctd/sdk";
import discloseRecipientCircuit from "@ctd/disclosure/artifacts/disclose_recipient.json";
import discloseRecipientVk from "@ctd/disclosure/artifacts/disclose_recipient.vk.json";
import discloseSenderCircuit from "@ctd/disclosure/artifacts/disclose_sender.json";
import discloseSenderVk from "@ctd/disclosure/artifacts/disclose_sender.vk.json";

import { DEPLOYMENT } from "@/lib/deployment";
import { ensureBrowserBackend } from "@/lib/bb-loader";
import { errMsg } from "@/lib/err";
import { CopyButton } from "../copy-button";

const RR_KEY = "ctd:disclosure:rR";
const REQUEST_KEY = "ctd:disclosure:request";

/** Shared artifacts (§5.5) by circuit_id — the bundle picks which pair loads. */
const ARTIFACTS = {
  disclose_recipient: { circuit: discloseRecipientCircuit, vk: discloseRecipientVk },
  disclose_sender: { circuit: discloseSenderCircuit, vk: discloseSenderVk },
} as const;

function vkBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function VerifyPage() {
  const [keys, setKeys] = useState<RecipientKeys | null>(null);
  const [request, setRequest] = useState<DisclosureRequest | null>(null);
  const [bundleJson, setBundleJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifiedDisclosure | null>(null);
  const [error, setError] = useState<{ stage: string; message: string } | null>(null);

  // Long-lived receiver identity + last issued request, both local-only.
  useEffect(() => {
    const storedRr = localStorage.getItem(RR_KEY);
    const k = storedRr ? recipientKeysFromSecret(fromHex(storedRr)) : generateRecipientKeys();
    if (!storedRr) localStorage.setItem(RR_KEY, toHex32(k.rR));
    setKeys(k);
    const storedReq = localStorage.getItem(REQUEST_KEY);
    if (storedReq) {
      const req = JSON.parse(storedReq) as DisclosureRequest;
      // A request minted under a previous identity can't be verified anymore.
      if (req.pR.x === k.pR.x && req.pR.y === k.pR.y) setRequest(req);
    }
  }, []);

  const mintRequest = useCallback(() => {
    if (!keys) return;
    const req = newDisclosureRequest(keys);
    localStorage.setItem(REQUEST_KEY, JSON.stringify(req));
    setRequest(req);
    setResult(null);
    setError(null);
  }, [keys]);

  const verify = useCallback(async () => {
    if (!keys || !request) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      ensureBrowserBackend();
      const bundle = parseBundle(bundleJson);
      const client = new ChainClient({
        rpcUrl: DEPLOYMENT.rpcUrl,
        networkPassphrase: DEPLOYMENT.networkPassphrase,
        contracts: DEPLOYMENT.contracts,
      });
      // With an indexer, ref_E resolves even for transfers older than the RPC's
      // ~7-day window (verifyDisclosure tries the indexer first, then the RPC).
      const indexer = DEPLOYMENT.indexerUrl
        ? new IndexerClient({ baseUrl: DEPLOYMENT.indexerUrl })
        : undefined;
      const artifacts = ARTIFACTS[bundle.circuitId];
      const prover: CircuitProver = proverFromArtifact(artifacts.circuit as never);
      try {
        setResult(
          await verifyDisclosure({
            client,
            indexer,
            bundle,
            request,
            keys,
            prover,
            pinnedVk: vkBytes(artifacts.vk.vkBase64),
          }),
        );
      } finally {
        await prover.destroy();
      }
    } catch (e) {
      if (e instanceof DisclosureVerifyError) setError({ stage: e.stage, message: e.message });
      else setError({ stage: "input", message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [keys, request, bundleJson]);

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">
          Disclosure receiver <span className="text-base font-normal text-neutral-500">· verify a disclosure</span>
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          This page is for the curious counterparty — a tax office, a compliance desk, or anyone
          an account holder owes exactly one answer to. You ask them to prove one fact about one
          on-chain transfer; unlike the auditor, you hold no master key and learn nothing they
          don&apos;t explicitly prove to you. No wallet needed — this page reads the chain,
          verifies the proof against the shared circuit artifacts, and decrypts the amount sealed
          to your key. Nothing here is published anywhere.
        </p>
      </header>

      <div className="space-y-6">
        <section className="rounded border border-neutral-800 p-4">
          <h3 className="mb-1 font-medium">1 · Your disclosure request</h3>
          <p className="mb-3 text-xs text-neutral-400">
            Hand this to the account holder (they paste it on the wallet page under
            &ldquo;Disclose amount&rdquo;). The nonce <code>nu</code> is one-time: a proof bound to it
            cannot be replayed against any other request, and the disclosed value is readable
            only with this browser&apos;s secret key.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={mintRequest}
              disabled={!keys}
              className="rounded bg-indigo-700 px-3 py-1.5 text-sm font-medium hover:bg-indigo-600 disabled:opacity-50"
            >
              {request ? "New request (fresh nonce)" : "Create request"}
            </button>
            {request && (
              <CopyButton label="Copy request" payload={() => JSON.stringify(request, null, 2)} />
            )}
          </div>
          {request && (
            <textarea
              readOnly
              className="mt-3 h-28 w-full rounded border border-neutral-800 bg-black/40 p-2 font-mono text-xs text-neutral-300"
              value={JSON.stringify(request, null, 2)}
            />
          )}
        </section>

        <section className="rounded border border-neutral-800 p-4">
          <h3 className="mb-1 font-medium">2 · Verify the holder&apos;s bundle</h3>
          <p className="mb-3 text-xs text-neutral-400">
            Paste the bundle the holder sent back. The event payload, the disclosing account&apos;s
            key, and the contract binding are all re-read from the chain — never trusted from
            the bundle.
          </p>
          <textarea
            className="h-32 w-full rounded border border-neutral-700 bg-neutral-900 p-2 font-mono text-xs outline-none focus:border-indigo-600"
            placeholder='{"circuitId":"disclose_recipient","refE":{…},"proof":"0x…","rDisc":{…},"vTildeDisc":"0x…"}'
            value={bundleJson}
            onChange={(e) => setBundleJson(e.target.value)}
          />
          <button
            onClick={verify}
            disabled={busy || !request || !bundleJson.trim()}
            className="mt-2 rounded bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify against chain"}
          </button>
          {!request && (
            <p className="mt-2 text-xs text-amber-400">
              Create a request first — a bundle can only be verified against the (P_R, ν) it was
              produced for.
            </p>
          )}
        </section>

        {error && (
          <section className="rounded border border-red-800 bg-red-950/40 p-4">
            <h3 className="mb-1 font-medium text-red-300">Rejected at: {error.stage}</h3>
            <p className="text-sm text-red-300/90">{error.message}</p>
            <p className="mt-2 text-xs text-red-400/70">
              Per the verifier protocol, nothing may be learned from a bundle that fails any step.
            </p>
          </section>
        )}

        {result && (
          <section className="rounded border border-emerald-800 bg-emerald-950/30 p-4">
            <h3 className="mb-2 font-medium text-emerald-300">Disclosure verified ✓</h3>
            <div className="mb-3 text-3xl">{result.amount.toString()} stroops</div>
            <p className="mb-3 text-sm text-neutral-300">
              {result.role === "recipient" ? (
                <>
                  The on-chain transfer{" "}
                  <span className="font-mono text-xs">{result.event.txHash.slice(0, 10)}…</span>{" "}
                  (ledger {result.event.ledger}) paid{" "}
                  <span className="font-mono text-xs">{result.disclosingAccount.slice(0, 8)}…</span>{" "}
                  exactly this amount.
                </>
              ) : (
                <>
                  The on-chain transfer{" "}
                  <span className="font-mono text-xs">{result.event.txHash.slice(0, 10)}…</span>{" "}
                  (ledger {result.event.ledger}) was sent by{" "}
                  <span className="font-mono text-xs">{result.disclosingAccount.slice(0, 8)}…</span>{" "}
                  for exactly this amount, to{" "}
                  <span className="font-mono text-xs">{result.event.to.slice(0, 8)}…</span>.
                </>
              )}{" "}
              You learned nothing else about the account, and this proof is useless to anyone but
              you.
            </p>
            <details className="text-xs text-neutral-400">
              <summary className="cursor-pointer text-neutral-300">Verifier steps</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                {result.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </details>
          </section>
        )}
      </div>

      <footer className="mt-10 text-xs text-neutral-600">
        circuits <span className="font-mono">disclose_recipient · disclose_sender</span> · VKs
        pinned from @ctd/disclosure · token {DEPLOYMENT.contracts.token.slice(0, 4)}…
        {DEPLOYMENT.contracts.token.slice(-4)}
      </footer>
    </main>
  );
}

function parseBundle(json: string): DisclosureBundle {
  let b: unknown;
  try {
    b = JSON.parse(json);
  } catch {
    throw new Error("bundle is not valid JSON");
  }
  const bundle = b as DisclosureBundle;
  if (
    !(bundle?.circuitId in ARTIFACTS) ||
    !bundle?.refE?.id ||
    typeof bundle.refE.ledger !== "number" ||
    !bundle?.refE?.txHash ||
    !bundle?.proof ||
    !bundle?.rDisc?.x ||
    !bundle?.rDisc?.y ||
    !bundle?.vTildeDisc
  ) {
    throw new Error("bundle must contain circuitId, refE {ledger,id,txHash}, proof, rDisc {x,y}, vTildeDisc");
  }
  return bundle;
}
