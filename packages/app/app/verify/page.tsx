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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CircuitProver,
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

import { useActiveDeployment } from "@/lib/active-deployment";
import { ensureBrowserBackend } from "@/lib/bb-loader";
import { clientsFor } from "@/lib/rpc";
import { errMsg } from "@/lib/err";
import { CopyButton } from "../copy-button";
import { PageShell } from "../page-shell";
import { Addr } from "../addr";
import { TxLink } from "../tx-link";

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
  const { active } = useActiveDeployment();
  const [keys, setKeys] = useState<RecipientKeys | null>(null);
  const [request, setRequest] = useState<DisclosureRequest | null>(null);
  const [bundleJson, setBundleJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifiedDisclosure | null>(null);
  const [error, setError] = useState<{ stage: string; message: string } | null>(null);

  // Provers are the expensive part of verifying (bb.js worker + WASM init), so
  // they're cached per circuit across repeat verifications and only freed when
  // this page unmounts.
  const proversRef = useRef<Map<keyof typeof ARTIFACTS, CircuitProver>>(new Map());
  useEffect(() => {
    const provers = proversRef.current;
    return () => {
      for (const p of provers.values()) void p.destroy();
      provers.clear();
    };
  }, []);
  const proverFor = useCallback((circuitId: keyof typeof ARTIFACTS): CircuitProver => {
    let p = proversRef.current.get(circuitId);
    if (!p) {
      p = proverFromArtifact(ARTIFACTS[circuitId].circuit as never);
      proversRef.current.set(circuitId, p);
    }
    return p;
  }, []);

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
      // With an indexer, ref_E resolves even for transfers older than the RPC's
      // ~7-day window (verifyDisclosure tries the indexer first, then the RPC).
      const { client, indexer } = clientsFor(active);
      const artifacts = ARTIFACTS[bundle.circuitId];
      setResult(
        await verifyDisclosure({
          client,
          indexer,
          bundle,
          request,
          keys,
          prover: proverFor(bundle.circuitId),
          pinnedVk: vkBytes(artifacts.vk.vkBase64),
        }),
      );
    } catch (e) {
      if (e instanceof DisclosureVerifyError) setError({ stage: e.stage, message: e.message });
      else setError({ stage: "input", message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [keys, request, bundleJson, active, proverFor]);

  return (
    <PageShell
      title="Disclosure receiver"
      subtitle="For a verifying counterparty (a compliance desk, tax authority, or KYC provider) that needs proof of a single fact about one on-chain transfer. You hold no key into the system and learn nothing beyond what is explicitly proved to you. No wallet required: this page reads the chain, verifies the proof against the shared circuit artifacts, and decrypts the amount sealed to your key. Nothing here is published."
    >
      <div className="space-y-6">
        <section className="rounded border border-neutral-800 p-4">
          <h3 className="mb-1 font-medium"><span className="text-cyan-400">1</span> · Your disclosure request</h3>
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
              className="mt-3 h-28 w-full rounded border border-neutral-800 bg-neutral-500/10 p-2 font-mono text-xs text-neutral-300"
              value={JSON.stringify(request, null, 2)}
            />
          )}
        </section>

        <section className="rounded border border-neutral-800 p-4">
          <h3 className="mb-1 font-medium"><span className="text-cyan-400">2</span> · Verify the holder&apos;s bundle</h3>
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
            className="mt-2 rounded bg-indigo-600 px-4 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify against chain"}
          </button>
          {!request && (
            <p className="mt-2 text-xs text-amber-400">
              Create a request first. A bundle can only be verified against the (P_R, ν) it was
              produced for.
            </p>
          )}
        </section>

        {error && (
          <section className="rounded border border-red-800 bg-red-950/40 p-4">
            <h3 className="mb-1 font-medium text-red-300">Rejected at: {error.stage}</h3>
            <p className="text-sm text-red-300/90">{error.message}</p>
            <p className="mt-2 text-xs text-red-400/70">
              Per the disclosure protocol, nothing may be learned from a bundle that fails any step.
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
                  <TxLink hash={result.event.txHash} className="text-xs" />{" "}
                  (ledger {result.event.ledger}) paid{" "}
                  <Addr value={result.disclosingAccount} className="text-xs" />{" "}
                  exactly this amount.
                </>
              ) : (
                <>
                  The on-chain transfer{" "}
                  <TxLink hash={result.event.txHash} className="text-xs" />{" "}
                  (ledger {result.event.ledger}) was sent by{" "}
                  <Addr value={result.disclosingAccount} className="text-xs" />{" "}
                  for exactly this amount, to{" "}
                  <Addr value={result.event.to} className="text-xs" />.
                </>
              )}{" "}
              You learned nothing else about the account, and this proof is useless to anyone but
              you.
            </p>
            <details className="text-xs text-neutral-400">
              <summary className="cursor-pointer text-neutral-300">Verification steps</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                {result.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </details>
          </section>
        )}
      </div>
    </PageShell>
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
