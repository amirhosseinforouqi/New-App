/**
 * ESLint, flat config.
 *
 * Next 16 removed `next lint`, so this runs ESLint directly and the npm script
 * calls `eslint .` rather than going through the framework.
 *
 * The rule set is deliberately small. `tsc --noEmit` already runs in CI with
 * `strict` and `noUncheckedIndexedAccess`, so anything the type checker catches
 * is left to the type checker; what is added here are the things types cannot
 * see — an unawaited promise that silently drops an error, a `<a href>` where
 * Next wants `<Link>`, an effect with a stale dependency list.
 */

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'public/**',
      'next-env.d.ts',
    ],
  },

  ...nextCoreWebVitals,
  ...nextTypeScript,

  {
    // `no-floating-promises` needs the type checker, which means the parser
    // has to be given a project. Scoped to TypeScript sources only — pointing
    // the project service at this config file itself is what makes ESLint
    // fail to boot.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A floating promise in a route handler is how a write silently fails
      // and still returns 200. This is the single most valuable rule here.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  {
    rules: {
      // `catch {}` with no binding is used deliberately in a few places where
      // the failure genuinely does not matter; an unused *named* binding is a
      // sign someone meant to log it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      // Server components legitimately render plain <a> for external links and
      // for downloads; the rule cannot tell those apart, and `<Link>` to an
      // off-site URL is worse than the lint it silences.
      '@next/next/no-html-link-for-pages': 'off',

      // Both of these are suppressed at a call site with an inline directive
      // explaining why. Enabling them here is what makes those directives mean
      // something — an unenforced rule with a disable comment beside it reads
      // like protection and provides none.
      'no-var': 'error',
      'no-control-regex': 'error',
    },
  },

  {
    // Scripts and tests are Node programs, not part of the bundle.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'drizzle.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // `node:test` returns a promise from `describe` and `it` that the caller is
    // explicitly not meant to await — the runner owns it. Every one of the 280
    // reports this rule produced in tests/ was that, and none were real, so the
    // rule is off here rather than 280 `void`s being added to appease it.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
];

export default config;
