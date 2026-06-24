import type { Metadata } from "next";
import "./globals.css";
import { PersonaNav } from "./nav";

export const metadata: Metadata = {
  title: "Stellar Confidential Token",
  description:
    "Confidential token transfers on Stellar — on-chain UltraHonk proofs, selective disclosure, and auditability (testnet).",
};

// Set the theme class before first paint (no flash). Dark is the canonical
// default; honor a stored choice, else fall back to the OS preference.
const themeInit = `(function(){try{var t=localStorage.getItem('theme');if(t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <PersonaNav />
        {children}
      </body>
    </html>
  );
}
