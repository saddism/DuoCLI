import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'release/',
      'node_modules/',
      'build/',
      'frp/',
      'native/',
      'public/',
      'docs/',
      'tests/.artifacts/',
      '*.map',
      'mobile/client/xterm.js',
      'mobile/client/xterm.js.map',
      'mobile/client/addon-fit.js',
      'mobile/client/addon-fit.js.map',
      'mobile/client/addon-unicode11.js',
      'mobile/client/addon-unicode11.js.map',
      'mobile/client/novnc/**',
      // vendored/bundled third-party file, not hand-written app code
      'mobile/client/mac-desktop-novnc-bundle.js',
    ],
  },
  {
    files: ['src/main/**/*', 'src/preload/**/*', 'scripts/**/*', 'tests/**/*.test.*', '*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.es2020 },
    },
  },
  {
    files: ['src/renderer/**/*', 'mobile/client/**/*'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2020, ...globals.nodeBuiltin, module: 'readonly', require: 'readonly', global: 'readonly', Terminal: 'readonly', FitAddon: 'readonly', Unicode11Addon: 'readonly', RFB: 'readonly', $: 'readonly' },
    },
  },
  {
    // Mobile helper tests run in Node even though their source files live in the browser bundle tree.
    files: ['mobile/client/**/*.test.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Puppeteer e2e tests reference globals injected by the test harness at runtime
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2020, inst: 'writable', mgr: 'writable', textOf: 'writable', t: 'writable', __dirname: 'readonly', __filename: 'readonly' },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Existing browser and Electron modules predate lint; keep cleanup visible without blocking.
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
      'no-var': 'error',
      // terminal escape sequences are core to DuoCLI, not a mistake
      'no-control-regex': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // pragmatic relaxations for an existing, previously-unlinted codebase
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'error',
    },
  },
  prettier,
  {
    files: ['tests/e2e/**/*.mjs'],
    // page.evaluate callbacks intentionally resolve names inside the browser fixture.
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['**/*.ts'],
    // TypeScript's compiler checks symbols and ambient types for these files.
    rules: { 'no-undef': 'off' },
  },
);
