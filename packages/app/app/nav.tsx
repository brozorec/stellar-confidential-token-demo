"use client";

/**
 * Persona switcher shown at the top of every page. The demo is a three-hander
 * — account holder, verifier, auditor — and each persona has its own page; this
 * bar makes the cast explicit and keeps switching one click. Accents follow the
 * OZ-tuned palette: account holder = indigo (brand), verifier = cyan, auditor =
 * amber.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";

export const PERSONAS = [
  {
    href: "/wallet",
    label: "Account holder",
    accent: "text-indigo-300 border-indigo-500/60 bg-indigo-500/10",
  },
  {
    href: "/verify",
    label: "Verifier",
    accent: "text-cyan-300 border-cyan-500/60 bg-cyan-500/10",
  },
  {
    href: "/auditor",
    label: "Auditor",
    accent: "text-amber-300 border-amber-500/60 bg-amber-500/10",
  },
] as const;

/** Minimal shield mark — a security motif in the OZ brand indigo. */
function ShieldMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5 text-indigo-400"
      fill="none"
    >
      <path
        d="M12 2.5 19 5.5 V11 C19 15.6 16 19.1 12 21 C8 19.1 5 15.6 5 11 V5.5 Z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M9 11.6 11.2 13.8 15.2 9.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PersonaNav() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-20 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
        <Link href="/" className="mr-1 flex items-center gap-2">
          <ShieldMark />
          <span className="hidden text-sm text-neutral-500 sm:inline">Stellar Confidential Token</span>
        </Link>
        <span className="flex-1" />
        <span className="mr-1 hidden text-xs text-neutral-600 sm:inline">Role</span>
        {PERSONAS.map((p) => {
          const active = pathname.startsWith(p.href);
          return (
            <Link
              key={p.href}
              href={p.href}
              className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? p.accent
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
        <ThemeToggle />
      </div>
    </nav>
  );
}
