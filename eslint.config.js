import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/', 'tmp/', 'out/', '.e2e/', 'docs/app/core/', 'extension/lib/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.serviceworker, V: 'readonly', YT: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['docs/app/js/denoise-worklet.js'],
    languageOptions: { globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' } },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
  },
];
