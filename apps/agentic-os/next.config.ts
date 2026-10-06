import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * The e2e check (playwright.config.ts) sets this so its dev server gets its OWN
   * build directory. Next 16 allows one `next dev` per distDir, so without it the
   * check cannot run while the dashboard is open. Unset, it is the default `.next`.
   */
  distDir: process.env.AGENTIC_OS_DIST_DIR || '.next',

  /**
   * Pin the workspace root to this app.
   *
   * Without this, Turbopack walks up looking for a lockfile, finds THREE
   * (here, the repo root, and a stray C:\Users\david.hayes\package-lock.json),
   * and picks the home directory as the root — which puts all of $HOME in the
   * module-resolution scope and prints every error path as
   * ./continuous-claude/apps/agentic-os/... instead of app-relative.
   */
  turbopack: {
    root: import.meta.dirname,
  },

  /**
   * `pg` is a driver that must never be bundled into a client chunk. Nothing
   * should import it from a component in the first place — the ESLint boundary
   * in eslint.config.mjs enforces that — but this is the belt-and-braces half.
   */
  serverExternalPackages: ['pg'],

  typescript: {
    // A type error is a broken build. Never set this to true to "unblock" a run.
    ignoreBuildErrors: false,
  },

  /**
   * NOTE: there is deliberately no `eslint` key here.
   *
   * Next 16 REMOVED the built-in ESLint build integration (deprecated in 15,
   * gone in 16) — `next build` no longer runs ESLint at all, and setting
   * `eslint.ignoreDuringBuilds` is now an unrecognized key that Next warns about
   * and ignores. An earlier version of this file set it and claimed in a comment
   * that it kept the ADR-0002 boundary build-enforced. That claim was false: the
   * key did nothing, so the boundary was gated by nothing.
   *
   * The guarantee is restored by the `prebuild` script in package.json, which
   * npm runs automatically before `build`. That is now the only thing making the
   * db-import boundary a build failure rather than a suggestion.
   */
};

export default nextConfig;
