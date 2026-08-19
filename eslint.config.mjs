import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Spec §10.1. A preview must never persist anything, so the token that
      // would persist it is not allowed to appear in a string literal at all.
      // The detector that recognises COMMIT in *user* SQL is exempted below.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\bCOMMIT\\b/i]',
          message:
            'Dry Run never commits. If this is user-supplied SQL, route it through findTransactionControl instead.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\bCOMMIT\\b/i]',
          message: 'Dry Run never commits.',
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The detector and its tests exist precisely to talk about COMMIT.
    files: ['src/parser/transactionControl.ts', 'src/test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
