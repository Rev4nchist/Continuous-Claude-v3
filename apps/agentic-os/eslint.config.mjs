import next from 'eslint-config-next';

/**
 * THE STRUCTURAL RULE FROM ADR-0002, MADE MECHANICAL.
 *
 * "No React component ever imports `db`." That rule is the entire reason
 * extracting a real API service later stays a mechanical change instead of a
 * full UI rewrite — and the ADR is explicit that it is enforceable in the
 * scaffold or never. So it lives here as a lint error rather than in a document.
 *
 * Layers:
 *   src/db/**            the only place the pool and Drizzle exist
 *   src/server/queries/  the API boundary — may import db, returns plain DTOs
 *   src/app, components  may import queries, may NOT import db
 *
 * WHY NOT FlatCompat: eslint-config-next@16 already default-exports a FLAT
 * config array. Wrapping it in `FlatCompat.extends()` (the legacy eslintrc
 * bridge) sends it through the old schema validator, which rejects it and then
 * crashes formatting the error — `TypeError: Converting circular structure to
 * JSON`, because eslint-plugin-react's config object is self-referential. The
 * failure mode is what makes this worth a comment: ESLint exits 2 having linted
 * ZERO files, so the boundary rule below reads as present while enforcing
 * nothing. Import the flat config directly; do not reintroduce FlatCompat.
 */
const config = [
  ...next,

  {
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/db',
                '@/db/*',
                '**/db/index',
                '**/db/schema*',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
              ],
              message:
                'ADR-0002: components must not import the database. Add a function to ' +
                'src/server/queries/<domain>.ts and call that instead. This rule is what keeps ' +
                'the Slice 4 command seam and a future API service a mechanical change.',
            },
          ],
        },
      ],
    },
  },

  {
    ignores: ['.next/**', '.next-e2e/**', 'node_modules/**', 'drizzle/**', 'next-env.d.ts'],
  },
];

export default config;
