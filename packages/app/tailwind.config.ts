import type { Config } from "tailwindcss";
import defaultColors from "tailwindcss/colors";
import plugin from "tailwindcss/plugin";

/**
 * OpenZeppelin-tuned theme with a light/dark switch.
 *
 * The app is written with literal palette classes (`bg-neutral-950`,
 * `text-amber-300`, …) and no per-element `dark:` variants. To support both
 * themes without rewriting every class, the color families the app uses are
 * redefined as CSS variables and the whole palette is flipped by **lightness
 * inversion** in light mode: shade N renders as its mirror (950↔50, 300↔700,
 * 500 fixed). So `bg-neutral-950` is near-black in dark and near-white in light,
 * `text-amber-300` is light amber in dark and dark amber in light, and tinted
 * surfaces (error / warning / success boxes) land correctly in both — for free.
 *
 * Dark is the canonical look (`.dark` on <html> → true palette); light (`:root`)
 * gets the mirrored values. The toggle lives in app/theme-toggle.tsx and a head
 * script (app/layout.tsx) sets the class before paint to avoid a flash.
 *
 * Brand blue ≈ Tailwind indigo (OZ's hsl(238 94% 65%)). Persona accents:
 * account holder = indigo, verifier = cyan, auditor = amber.
 */

const FAMILIES = [
  "neutral",
  "indigo",
  "cyan",
  "amber",
  "emerald",
  "sky",
  "violet",
  "red",
  "orange",
  "purple",
] as const;

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** Lightness mirror used to derive light-mode values from the dark palette. */
const MIRROR: Record<number, number> = {
  50: 950,
  100: 900,
  200: 800,
  300: 700,
  400: 600,
  500: 500,
  600: 400,
  700: 300,
  800: 200,
  900: 100,
  950: 50,
};

/** "#rrggbb" → "r g b" (space-separated channels, for rgb(... / <alpha-value>)). */
function channels(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// Each scale points at a CSS variable; opacity modifiers compose via <alpha-value>.
const varColors = Object.fromEntries(
  FAMILIES.map((fam) => [
    fam,
    Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--c-${fam}-${s}) / <alpha-value>)`])),
  ]),
);

// dark = true palette (canonical); light (:root) = mirrored by lightness.
const palette = defaultColors as unknown as Record<string, Record<number, string>>;
const darkVars: Record<string, string> = {};
const lightVars: Record<string, string> = {};
for (const fam of FAMILIES) {
  for (const s of SHADES) {
    darkVars[`--c-${fam}-${s}`] = channels(palette[fam][s]);
    lightVars[`--c-${fam}-${s}`] = channels(palette[fam][MIRROR[s]]);
  }
}

export default {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: varColors,
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0.5rem",
        md: "0.625rem",
        lg: "0.75rem",
        xl: "1rem",
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ":root": { "color-scheme": "light", ...lightVars },
        ".dark": { "color-scheme": "dark", ...darkVars },
      });
    }),
  ],
} satisfies Config;
