"use client";

/**
 * Top bar: a Deployment dropdown (default ↔ advanced + a link to deploy your
 * own) and a Role dropdown (the personas — account holder, verifier, auditor,
 * and token admin for compliant deployments). Accents follow the OZ-tuned
 * palette: account holder = indigo (brand), verifier = cyan, auditor = amber,
 * admin = rose.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "./theme-toggle";
import { useActiveDeployment } from "@/lib/active-deployment";
import { hasAdmin } from "@/lib/deployment";

export const PERSONAS = [
  { href: "/wallet", label: "Account holder", text: "text-indigo-300" },
  { href: "/verify", label: "Verifier", text: "text-cyan-300" },
  { href: "/auditor", label: "Auditor", text: "text-amber-300" },
] as const;

/** Token-admin persona — only meaningful for compliant deployments (vanilla has
 * no owner), so the Role menu shows it conditionally. */
const ADMIN_PERSONA = { href: "/admin", label: "Token Admin", text: "text-rose-300" } as const;

type Persona = { href: string; label: string; text: string };

/** Minimal shield mark — a security motif in the OZ brand indigo. */
function ShieldMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 text-indigo-400" fill="none">
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

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 opacity-60" fill="none" aria-hidden>
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ITEM_BASE = "block w-full px-3 py-1.5 text-left text-xs font-medium transition-colors";
function itemCls(active: boolean, activeCls = "bg-neutral-800 text-neutral-100"): string {
  return `${ITEM_BASE} ${active ? activeCls : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"}`;
}

/** Compact dropdown: a labelled trigger that opens a click-outside-dismissable menu. */
function Dropdown({
  label,
  triggerText,
  triggerCls = "text-neutral-200",
  children,
}: {
  label: string;
  triggerText: string;
  triggerCls?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      <span className="hidden text-xs text-neutral-600 sm:inline">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-colors hover:border-neutral-600 ${
          open ? "border-neutral-600" : "border-neutral-800"
        } ${triggerCls}`}
      >
        {triggerText}
        <Chevron />
      </button>
      {open && (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] overflow-hidden rounded border border-neutral-800 bg-neutral-950 py-1 shadow-lg shadow-black/40"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DeploymentDropdown() {
  const { advanced, which, setWhich } = useActiveDeployment();
  return (
    <Dropdown
      label="Deployment"
      triggerText={which === "advanced" ? "Advanced" : "Default"}
      triggerCls={which === "advanced" ? "text-emerald-300" : "text-neutral-200"}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => setWhich("default")}
        className={itemCls(which === "default", "bg-neutral-800 text-emerald-300")}
      >
        Default · vanilla
      </button>
      {advanced && (
        <button
          type="button"
          role="menuitem"
          onClick={() => setWhich("advanced")}
          className={itemCls(which === "advanced", "bg-neutral-800 text-emerald-300")}
        >
          {advanced.label}
        </button>
      )}
      <div className="my-1 border-t border-neutral-800" />
      <Link role="menuitem" href="/advanced" className={itemCls(false)}>
        {advanced ? "Reconfigure / redeploy…" : "Deploy your own…"}
      </Link>
    </Dropdown>
  );
}

function RoleDropdown() {
  const pathname = usePathname();
  const { active } = useActiveDeployment();
  const personas: readonly Persona[] = hasAdmin(active.kind) ? [...PERSONAS, ADMIN_PERSONA] : PERSONAS;
  const current = personas.find((p) => pathname.startsWith(p.href));
  return (
    <Dropdown label="Role" triggerText={current?.label ?? "Choose role"} triggerCls={current?.text ?? "text-neutral-400"}>
      {personas.map((p) => (
        <Link
          key={p.href}
          role="menuitem"
          href={p.href}
          className={itemCls(current?.href === p.href, `bg-neutral-800 ${p.text}`)}
        >
          {p.label}
        </Link>
      ))}
    </Dropdown>
  );
}

export function PersonaNav() {
  return (
    <nav className="sticky top-0 z-20 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
        <Link href="/" className="mr-1 flex items-center gap-2">
          <ShieldMark />
          <span className="hidden text-sm text-neutral-500 sm:inline">Stellar Confidential Token</span>
        </Link>
        <span className="flex-1" />
        <DeploymentDropdown />
        <span className="mx-0.5 hidden h-4 w-px bg-neutral-800 sm:inline-block" />
        <RoleDropdown />
        <ThemeToggle />
      </div>
    </nav>
  );
}
