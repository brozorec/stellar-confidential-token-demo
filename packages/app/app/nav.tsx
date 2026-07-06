"use client";

/**
 * Top bar: a Deployment toggle (Default ↔ Advanced; clicking Advanced with no
 * deployment yet routes to /advanced to create one) and a Role dropdown (the
 * personas — account holder, disclosure receiver, auditor, and token admin for
 * any deployment created in advanced mode, compliant or not). Reconfigure/
 * redeploy of an existing advanced deployment lives on the Token Admin
 * dashboard, not here. Accents follow the OZ-tuned palette: account holder =
 * indigo (brand), disclosure receiver = cyan, auditor = amber, admin = rose.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "./theme-toggle";
import { useActiveDeployment } from "@/lib/active-deployment";
import { hasAdminDashboard } from "@/lib/deployment";

export const PERSONAS = [
  { href: "/wallet", label: "Account holder", text: "text-indigo-300" },
  { href: "/verify", label: "Disclosure receiver", text: "text-cyan-300" },
  { href: "/auditor", label: "Auditor", text: "text-amber-300" },
] as const;

/** Token-admin persona — shown for any deployment created in advanced mode
 * (compliant or vanilla), since its dashboard is also the only place to
 * redeploy. The built-in default has neither, so the Role menu hides it. */
const ADMIN_PERSONA = { href: "/admin", label: "Token admin", text: "text-rose-300" } as const;

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
  disabled = false,
  disabledTitle,
  children,
}: {
  label: string;
  triggerText: string;
  triggerCls?: string;
  disabled?: boolean;
  disabledTitle?: string;
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
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-neutral-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-neutral-800 ${
          open ? "border-neutral-600" : "border-neutral-800"
        } ${triggerCls}`}
      >
        {triggerText}
        <Chevron />
      </button>
      {open && !disabled && (
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

const SEG_BASE = "rounded px-2.5 py-1 text-xs font-medium transition-colors";

/** Default ↔ Advanced switch. `Advanced` toggles the active slot when a
 * deployment exists; with none yet it routes to /advanced to create one (the
 * discovery/creation path, since the home page no longer carries a card).
 * Reconfigure/redeploy of an existing deployment lives on the admin dashboard. */
function DeploymentToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const { advanced, which, setWhich } = useActiveDeployment();

  // The /advanced config page is the Advanced context even before a deployment
  // exists, so the Advanced segment lights up there too — otherwise clicking it
  // (which routes to /advanced to create one) would leave Default highlighted.
  const advancedContext = which === "advanced" || pathname.startsWith("/advanced");

  const selectDefault = () => {
    setWhich("default");
    // Clicking Default from the config page returns to a neutral landing so the
    // toggle doesn't stay stuck on Advanced (pathname would otherwise keep it lit).
    if (pathname.startsWith("/advanced")) router.push("/");
  };

  const selectAdvanced = () => {
    if (advanced) setWhich("advanced");
    else router.push("/advanced");
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden text-xs text-neutral-600 sm:inline">Deployment</span>
      <div className="inline-flex items-center rounded-md border border-neutral-800 p-0.5">
        <button
          type="button"
          aria-pressed={!advancedContext}
          onClick={selectDefault}
          className={`${SEG_BASE} ${
            !advancedContext ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          Default
        </button>
        <button
          type="button"
          aria-pressed={advancedContext}
          onClick={selectAdvanced}
          title={advanced ? undefined : "Deploy your own token"}
          className={`${SEG_BASE} ${
            advancedContext ? "bg-neutral-800 text-emerald-300" : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          Advanced
        </button>
      </div>
    </div>
  );
}

function RoleDropdown() {
  const pathname = usePathname();
  const { active, advanced, which } = useActiveDeployment();
  // No deployment to serve a persona against yet: in the advanced context (the
  // /advanced config page, or advanced active) with nothing deployed, there's
  // no role to play, so the picker is disabled until a token is deployed.
  const disabled = (which === "advanced" || pathname.startsWith("/advanced")) && !advanced;
  const personas: readonly Persona[] = hasAdminDashboard(active) ? [...PERSONAS, ADMIN_PERSONA] : PERSONAS;
  const current = personas.find((p) => pathname.startsWith(p.href));
  return (
    <Dropdown
      label="Role"
      triggerText={current?.label ?? "Choose role"}
      triggerCls={current?.text ?? "text-neutral-400"}
      disabled={disabled}
      disabledTitle="Deploy your own token first to choose a role"
    >
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
        <DeploymentToggle />
        <span className="mx-0.5 hidden h-4 w-px bg-neutral-800 sm:inline-block" />
        <RoleDropdown />
        <ThemeToggle />
      </div>
    </nav>
  );
}
