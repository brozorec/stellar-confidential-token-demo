/**
 * Landing page: a persona chooser. The demo is a three-hander — pick a role and
 * land on that persona's page. The same three links live in the top bar of every
 * page (app/nav.tsx).
 */

import Link from "next/link";
import { DEPLOYMENT } from "@/lib/deployment";

const PERSONA_CARDS = [
  {
    href: "/wallet",
    title: "Account holder",
    tagline: "token holder",
    accent: "border-indigo-500/40 hover:border-indigo-400/70",
    cta: "Open wallet →",
    ctaCls: "text-indigo-300",
    blurb:
      "Hold and move balances without exposing amounts on-chain. Connect a wallet to deposit, " +
      "transfer, and withdraw. Each operation is a zero-knowledge proof generated client-side, " +
      "and on-chain your balance is only a curve commitment.",
  },
  {
    href: "/verify",
    title: "Verifier",
    tagline: "verifying counterparty",
    accent: "border-cyan-500/40 hover:border-cyan-400/70",
    cta: "Verify a disclosure →",
    ctaCls: "text-cyan-300",
    blurb:
      "A compliance desk, tax authority, or counterparty that needs proof of a single payment. " +
      "Issue a one-time request, receive a proof in return, and learn exactly one amount about " +
      "exactly one transfer. No wallet required.",
  },
  {
    href: "/auditor",
    title: "Auditor",
    tagline: "designated auditor",
    accent: "border-amber-500/40 hover:border-amber-400/70",
    cta: "Open auditor console →",
    ctaCls: "text-amber-300",
    blurb:
      "Every account in this deployment registers under the auditor key, so each transfer and " +
      "withdrawal carries ciphertexts only the auditor can open.",
  },
] as const;

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Confidential transfers</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-400">
          Balances are Grumpkin Pedersen commitments and every transfer is verified on-chain by an
          UltraHonk proof. Amounts stay private, disclosed only to the parties entitled to see
          them. Select a role to begin.
        </p>
      </header>

      <div className="space-y-4">
        {PERSONA_CARDS.map((p) => (
          <Link
            key={p.href}
            href={p.href}
            className={`block rounded-lg border bg-neutral-900/40 p-5 transition-colors ${p.accent}`}
          >
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-medium">{p.title}</h2>
              <span className="text-sm text-neutral-500">— {p.tagline}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">{p.blurb}</p>
            <span className={`mt-3 inline-block text-sm font-medium ${p.ctaCls}`}>{p.cta}</span>
          </Link>
        ))}
      </div>

      <footer className="mt-10 font-mono text-xs text-neutral-600">
        token {short(DEPLOYMENT.contracts.token)} · verifier {short(DEPLOYMENT.contracts.verifier)} ·
        auditor {short(DEPLOYMENT.contracts.auditor)} · Stellar testnet · unaudited reference demo
      </footer>
    </main>
  );
}

function short(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
