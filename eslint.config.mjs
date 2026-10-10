import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.tools/**', '.local/**', 'vendor/**', 'references/**', '**/coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  ...vue.configs['flat/essential'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } }, rules: { 'no-undef': 'off' } },
  { files: ['**/*.{ts,vue,mjs,js}'], languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', Response: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', AbortController: 'readonly', crypto: 'readonly', structuredClone: 'readonly', window: 'readonly', document: 'readonly', navigator: 'readonly', self: 'readonly', caches: 'readonly', Blob: 'readonly' } }, rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }], 'vue/multi-word-component-names': 'off' } }
);
