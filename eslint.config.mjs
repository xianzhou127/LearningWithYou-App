import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores(['node_modules/**', 'dist/**', 'release/**', 'artifacts/**', '.local/**']),
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], plugins: { 'react-hooks': hooks }, rules: hooks.configs.recommended.rules },
]);
