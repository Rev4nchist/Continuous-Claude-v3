import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';

import './globals.css';

/**
 * The terminal face (PRD design system). next/font downloads it at build time and serves it from the
 * app, so a page load makes no request to Google. `next dev` offline falls back to the stack in
 * globals.css (a var() with no fallback would make the whole declaration invalid, so the stack names
 * the face itself). `next build` offline throws: it needs the network once.
 */
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Agentic OS',
  description: 'Local command center for projects, sessions, and context.',
};

/**
 * Root shell. Deliberately almost empty.
 *
 * The Mission Control chrome — fleet grid, active-sessions strip, project drill-in
 * — belongs to the `aos-fleet-grid` and `aos-project-canvas` lanes and is not
 * built here. This lane's job is that those lanes have somewhere to render.
 *
 * No login screen and no user menu, per ADR-0005: v1 has no auth at all, and a UI
 * that LOOKS authenticated while it is not is worse than one that visibly is not.
 * If this app ever becomes reachable by a second reader — a tunnel, a deploy, a
 * shared host — that cut must be reversed BEFORE the exposure, not after.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
