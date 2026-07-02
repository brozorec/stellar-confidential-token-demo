"use client";

/**
 * Advanced mode: configure and deploy your own confidential token through the
 * shared factory. The verifier and auditor are constant (a factory-deployed
 * token is wired to the same registries), so only the underlying SEP-41 asset
 * and the compliance configuration are chosen here. On success the app saves
 * the deployment in its "advanced" slot and switches to serving it.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deployVanillaToken,
  deployCompliantToken,
  deployPolicyAndToken,
  type FactoryWiring,
} from "@ctd/sdk";
import {
  DEFAULT_DEPLOYMENT,
  XLM_SAC,
  kindLabel,
  type CtKind,
  type Deployment,
} from "@/lib/deployment";
import { useActiveDeployment } from "@/lib/active-deployment";
import { connectFreighter, type MessageSigner } from "@/lib/freighter";
import { clientsFor } from "@/lib/rpc";
import { errMsg } from "@/lib/err";
import { truncateMiddle } from "@/lib/format";
import { useLog } from "@/lib/use-log";
import { PageShell } from "../page-shell";
import { ErrorBox } from "../error-box";
import { LogPanel } from "../log-panel";
import { Addr } from "../addr";

const CONFIGS: { kind: CtKind; title: string; blurb: string }[] = [
  {
    kind: "vanilla",
    title: "No compliance",
    blurb:
      "A plain confidential token. No owner, no freeze, no policy. Anyone who registers can deposit, transfer, and withdraw.",
  },
  {
    kind: "compliance",
    title: "Compliance (freeze only)",
    blurb:
      "Adds an owner (you) who can freeze and unfreeze individual accounts. A frozen account is blocked from every operation until unfrozen. No external policy.",
  },
  {
    kind: "allowlist",
    title: "Compliance + Allowlist Policy",
    blurb:
      "Freeze/unfreeze plus an allowlist policy: only accounts the owner has explicitly allowed may transact. Use it as a KYC gate — onboard a user by allowing their address after verifying them.",
  },
  {
    kind: "blocklist",
    title: "Compliance + Blocklist Policy",
    blurb:
      "Freeze/unfreeze plus a blocklist policy: everyone may transact except accounts the owner has blocked. Use it to enforce sanctions/AML denials — block an address to cut it off.",
  },
];

export default function AdvancedPage() {
  const router = useRouter();
  const { advanced, saveAdvanced, clearAdvanced } = useActiveDeployment();

  const [account, setAccount] = useState<string | null>(null);
  const [underlying, setUnderlying] = useState(XLM_SAC);
  const [kind, setKind] = useState<CtKind>("compliance");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, log] = useLog(40);
  const [check, setCheck] = useState<string | null>(null);

  const factoryReady = DEFAULT_DEPLOYMENT.contracts.factory.length > 0;
  const customUnderlying = underlying.trim() !== XLM_SAC;

  const { client } = useMemo(() => clientsFor(DEFAULT_DEPLOYMENT), []);

  const connect = useCallback(async () => {
    setError(null);
    setBusy("connecting");
    try {
      const signer = await connectFreighter();
      setAccount(signer.publicKey);
      log(`connected ${signer.publicKey}`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, [log]);

  // Best-effort SEP-41 sanity check on a custom underlying (non-blocking).
  const checkUnderlying = useCallback(async () => {
    setCheck("checking…");
    try {
      const dec = await client.simulate(underlying.trim(), "decimals", []);
      setCheck(`looks like a SEP-41 token (decimals = ${dec.u32()})`);
    } catch {
      setCheck("could not read decimals() — not a SEP-41 token, or not deployed");
    }
  }, [client, underlying]);

  const deploy = useCallback(async () => {
    setError(null);
    setBusy("deploying");
    try {
      const signer: MessageSigner = await connectFreighter();
      setAccount(signer.publicKey);
      const owner = signer.publicKey;
      const u = underlying.trim();
      const wiring: FactoryWiring = {
        factory: DEFAULT_DEPLOYMENT.contracts.factory,
        underlying: u,
        verifier: DEFAULT_DEPLOYMENT.contracts.verifier,
        auditor: DEFAULT_DEPLOYMENT.contracts.auditor,
      };

      // Lower bound for the first event sync; the deploy + register events land
      // at or after this ledger.
      const deployedAtLedger = await client.latestLedger();

      let token: string;
      let policy: string | undefined;
      log(`deploying ${kindLabel(kind)} via factory ${truncateMiddle(wiring.factory, 4, 4)}…`);
      if (kind === "vanilla") {
        token = await deployVanillaToken(client, signer, wiring);
      } else if (kind === "compliance") {
        token = await deployCompliantToken(client, signer, wiring, owner);
      } else {
        const res = await deployPolicyAndToken(
          client,
          signer,
          wiring,
          kind === "allowlist" ? "AllowList" : "BlockList",
          owner,
        );
        token = res.token;
        policy = res.policy;
        log(`policy deployed: ${policy}`);
      }
      log(`token deployed: ${token}`);

      const base = DEFAULT_DEPLOYMENT;
      const adv: Deployment = {
        id: "advanced",
        label: `${truncateMiddle(token, 4, 4)}`,
        kind,
        rpcUrl: base.rpcUrl,
        networkPassphrase: base.networkPassphrase,
        indexerUrl: base.indexerUrl,
        deployedAtLedger,
        auditorId: base.auditorId,
        auditorSecretHex: base.auditorSecretHex,
        contracts: {
          token,
          verifier: base.contracts.verifier,
          auditor: base.contracts.auditor,
          underlying: u,
          factory: base.contracts.factory,
          policy,
        },
        owner: kind === "vanilla" ? undefined : owner,
      };
      saveAdvanced(adv);
      log("saved as the active deployment");
      // Compliant deployments land on the admin dashboard; vanilla on the wallet.
      router.push(kind === "vanilla" ? "/wallet" : "/admin");
    } catch (e) {
      setError(errMsg(e));
      log(`error: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  }, [client, underlying, kind, log, saveAdvanced, router]);

  return (
    <PageShell
      title={
        <>
          Advanced mode <span className="text-base font-normal text-neutral-500">· deploy your own token</span>
        </>
      }
      subtitle="Configure a confidential token and deploy it through the shared factory. The factory holds the contract code; your Freighter account signs the deploy and becomes the token's owner for compliant configurations. The verifier and auditor are reused unchanged."
      badge={false}
    >
      {error && <ErrorBox className="mb-6">{error}</ErrorBox>}

      {!factoryReady && (
        <div className="mb-6 rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">
          The shared factory has not been provisioned yet. Run{" "}
          <code className="font-mono">scripts/deploy.ts</code> and paste the printed{" "}
          <code className="font-mono">factory</code> id into{" "}
          <code className="font-mono">packages/app/lib/deployment.ts</code>.
        </div>
      )}

      {advanced && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-sm">
          <span className="text-neutral-400">
            Current deployment: <span className="font-medium text-neutral-200">{advanced.label}</span>{" "}
            ({kindLabel(advanced.kind)})
          </span>
          <button
            onClick={clearAdvanced}
            className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
          >
            Forget
          </button>
        </div>
      )}

      <div className="space-y-6">
        {/* Step 1: underlying */}
        <section className="rounded border border-neutral-800 p-4">
          <h2 className="mb-1 font-medium">1 · Underlying SEP-41 asset</h2>
          <p className="mb-3 text-sm text-neutral-400">
            The public token whose reserves back every confidential balance. Defaults to the native
            XLM Stellar Asset Contract.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={underlying}
              onChange={(e) => {
                setUnderlying(e.target.value);
                setCheck(null);
              }}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => {
                setUnderlying(XLM_SAC);
                setCheck(null);
              }}
              className="rounded border border-neutral-700 px-3 py-2 text-xs font-medium hover:bg-neutral-800"
            >
              Use XLM SAC
            </button>
            <button
              onClick={checkUnderlying}
              className="rounded border border-neutral-700 px-3 py-2 text-xs font-medium hover:bg-neutral-800"
            >
              Check
            </button>
          </div>
          {check && <p className="mt-2 text-xs text-neutral-400">{check}</p>}
          {customUnderlying && (
            <div className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 p-3 text-xs leading-relaxed text-neutral-300">
              <p className="mb-1 font-medium text-sky-300">Requirements for a custom underlying</p>
              <ul className="list-disc space-y-1 pl-4 text-neutral-400">
                <li>A deployed SEP-41 token contract (a Stellar Asset Contract or a compatible custom token).</li>
                <li>
                  Exact-transfer semantics: no fee-on-transfer and no rebasing — the confidential token
                  assumes the amount deposited equals the amount credited.
                </li>
                <li>
                  Each depositor must hold a balance of the asset and, for non-native assets, an
                  established trustline before they can deposit.
                </li>
                <li>
                  Amounts everywhere are in the asset&apos;s smallest unit (e.g. stroops for XLM).
                </li>
              </ul>
            </div>
          )}
        </section>

        {/* Step 2: configuration */}
        <section className="rounded border border-neutral-800 p-4">
          <h2 className="mb-1 font-medium">2 · Confidential token configuration</h2>
          <p className="mb-3 text-sm text-neutral-400">Choose how compliance is enforced.</p>
          <div className="space-y-2">
            {CONFIGS.map((c) => (
              <label
                key={c.kind}
                className={`flex cursor-pointer gap-3 rounded border p-3 transition-colors ${
                  kind === c.kind
                    ? "border-emerald-500/60 bg-emerald-500/10"
                    : "border-neutral-800 hover:border-neutral-600"
                }`}
              >
                <input
                  type="radio"
                  name="kind"
                  checked={kind === c.kind}
                  onChange={() => setKind(c.kind)}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">{c.title}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-neutral-400">{c.blurb}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* Step 3: deploy */}
        <section className="rounded border border-neutral-800 p-4">
          <h2 className="mb-1 font-medium">3 · Deploy</h2>
          <p className="mb-3 text-sm text-neutral-400">
            {account ? (
              <>
                Connected as <Addr value={account} className="text-neutral-300" />
                {kind !== "vanilla" && " — this account becomes the token owner / admin."}
              </>
            ) : (
              "Connect Freighter to sign the deploy. The connected account becomes the token owner for compliant configurations."
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {!account && (
              <button
                onClick={connect}
                disabled={busy !== null}
                className="rounded bg-neutral-800 px-4 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
              >
                {busy === "connecting" ? "Connecting…" : "Connect Freighter"}
              </button>
            )}
            <button
              onClick={deploy}
              disabled={busy !== null || !factoryReady || underlying.trim().length === 0}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy === "deploying" ? "Deploying…" : `Deploy`}
            </button>
          </div>
        </section>

        <LogPanel logs={logs} />
      </div>
    </PageShell>
  );
}
