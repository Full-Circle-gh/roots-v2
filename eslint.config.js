// ESLint flat config — a BUG-CATCHER, not a style cop.
//
// Philosophy: this runs inside the deploy gate (scripts/deploy-changed.sh) on
// the files a commit ships. So every rule set to "error" must be a thing that
// is almost certainly a real defect — a dead end, a typo'd reference, a logic
// slip that would throw or silently misbehave in production. Style / taste
// rules are deliberately OFF: they'd block deploys for no safety gain and train
// people to ignore the gate. Genuine-but-noisy smells (unused vars) are "warn"
// — surfaced, never blocking.
//
// Adding a rule? Ask: "if this fires, is it almost always a bug?" If yes → error.
// If it's "would be nicer if…" → leave it off.

const globals = require('globals');

// Globals that aren't in every `globals.node` revision but ARE real in our
// Node 20/24 runtime (global fetch landed in Node 18). Declaring them keeps
// no-undef honest instead of forcing us to relax it.
const RUNTIME_EXTRA = {
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  crypto: 'readonly',
};

// The shared verdict. Errors block a deploy; warnings just print.
const BUG_RULES = {
  // ── Dead ends & unreachable logic ──────────────────────────────────────
  'no-unreachable': 'error',           // code after return/throw/continue/break
  'no-unreachable-loop': 'error',      // a loop that can only ever run once
  'no-fallthrough': 'warn',            // switch fallthrough (sometimes intended)
  'no-constant-condition': ['error', { checkLoops: false }], // if (true) {…}
  'no-constant-binary-expression': 'error', // `x || {}` style mistakes, `a ?? b > c`

  // ── Duplicates that mean "I overwrote my own intent" ───────────────────
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-dupe-class-members': 'error',

  // ── References that will throw / surprise at runtime ───────────────────
  'no-undef': 'error',                 // undefined variable/function (ReferenceError)
  'no-func-assign': 'error',
  'no-const-assign': 'error',
  'no-class-assign': 'error',
  'no-import-assign': 'error',
  'no-ex-assign': 'error',
  'no-obj-calls': 'error',             // Math() / JSON() called as functions
  'getter-return': 'error',
  'no-setter-return': 'error',

  // ── Conditions & comparisons that don't do what they look like ─────────
  'no-cond-assign': 'error',           // if (x = 1) — default allows ((x = f()))
  'no-self-assign': 'error',
  'no-self-compare': 'error',          // x === x (usually a typo for another var)
  'no-compare-neg-zero': 'error',
  'no-unsafe-negation': 'error',       // !a in b
  'use-isnan': 'error',                // x === NaN never true
  'valid-typeof': 'error',             // typeof x === 'strnig'

  // ── Control-flow / async footguns ──────────────────────────────────────
  'no-unsafe-finally': 'error',        // return/throw in finally swallows control
  'no-unsafe-optional-chaining': 'error', // (a?.b)() can throw
  'no-async-promise-executor': 'error',
  'no-misleading-character-class': 'error',
  'no-invalid-regexp': 'error',

  // ── Smells: surfaced, never blocking ───────────────────────────────────
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-sparse-arrays': 'warn',

  // ── Deliberately OFF (style, or too noisy on this codebase) ────────────
  'no-empty': 'off',                   // intentional empty catch blocks abound
  'no-prototype-builtins': 'off',
  'no-control-regex': 'off',
  'no-inner-declarations': 'off',
  'require-atomic-updates': 'off',
};

module.exports = [
  // Things ESLint should never look at.
  {
    ignores: [
      'node_modules/**',
      'miniapp/**',      // WeChat build, shipped separately, different toolchain
      'data/**',
      '__stage__/**',
      'backups/**',
      '**/*.min.js',
    ],
  },

  // Backend + tooling: Node CommonJS.
  {
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2021, ...RUNTIME_EXTRA },
    },
    rules: BUG_RULES,
  },

  // Channel probe / recon scripts: Node files that embed BROWSER-context code
  // inside page.evaluate() callbacks. Same situation as the `/* global … */`
  // header in lib/meituan-browser.js, but declared here because these files are
  // byte-for-byte copies of what runs on the server and must not be edited.
  // Only the three DOM globals they actually use are declared, so a real
  // Node-side typo is still caught.
  {
    files: [
      'scripts/guanyi-probe-orders.js',
      'scripts/meituan-capture-stockwrite.js',
      'scripts/meituan-dump-stockdom.js',
      'scripts/meituan-dump-suggest.js',
      'scripts/meituan-order-probe.js',
      'scripts/meituan-order-probe3.js',
      'scripts/meituan-status-recon2.js',
      'scripts/meituan-status-recon3.js',
      'scripts/meituan-status-recon4.js',
      'scripts/meituan-status-recon5.js',
      'scripts/meituan-test-apistock.js',
      'scripts/meituan-test-combo.js',
      'scripts/meituan-test-editstock.js',
      'scripts/shangou-status-recon.js',
    ],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', location: 'readonly' },
    },
  },

  // The PWA test drives a real browser and, unlike its siblings in
  // scripts/test_mobile_*.js, passes its in-page probes as real arrow functions
  // to page.evaluate() rather than as template strings. That is deliberate —
  // the checks are short and readable that way — but it does put browser code
  // in a Node file, so the handful of globals it touches are declared here.
  {
    files: ['scripts/test_mobile_pwa.js'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', location: 'readonly', navigator: 'readonly' },
    },
  },

  // Browser-served scripts (currently just the service worker).
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: BUG_RULES,
  },
];
