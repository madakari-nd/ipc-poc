import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**', '**/generated.ts', '**/*.min.js', '.specify/**', '.claude/**', 'specs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/design-system/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: { ...reactHooks.configs.recommended.rules, ...jsxA11y.configs.strict.rules },
  },
  { files: ['scripts/**', 'tests/**'], rules: { 'no-console': 'off' } },
  {
    // k6 load scripts run in the k6 runtime, not Node: __ENV, __VU and the k6 module are globals.
    files: ['tests/load/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', __EXEC_SCENARIO: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
);
