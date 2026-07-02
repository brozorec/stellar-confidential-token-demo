import { ServingBadge } from "./serving-badge";

/**
 * Shared `<main>` + header wrapper for the persona workflow pages (wallet,
 * verify, auditor, admin, advanced) — same max width, padding, and heading
 * treatment everywhere; only the copy (and whether the serving badge applies)
 * differs per page.
 */
export function PageShell({
  title,
  subtitle,
  badge = true,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-sm leading-relaxed text-neutral-400">{subtitle}</p>}
        {badge && <ServingBadge className="mt-4" />}
      </header>
      {children}
    </main>
  );
}
