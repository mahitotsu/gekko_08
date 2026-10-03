// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// 静的検査（`npm run lint`）。typescript-eslintの、型情報を使う推奨の規則に従う
export default tseslint.config(
  { ignores: ['**/node_modules/', '**/cdk.out/', '**/dist/', 'experiments/', 'docs/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // asyncは、Lambdaのハンドラーやインターフェース（MCPのTransportなど）がPromiseを返す約束を示すのにも使う。
      // 危ないのはPromiseを待ち忘れることで、それはno-floating-promisesとno-misused-promisesが見つける
      '@typescript-eslint/require-await': 'off',
      // 先頭が`_`の引数と変数は、使わないことを示す名前として許す
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  // CDKのテスト：合成したCloudFormationのテンプレート（型のないJSON）を読んで確かめるので、anyの値の扱いを許す
  {
    files: ['infra/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // 画面：Reactのフックの規則
  { files: ['web/src/**/*.tsx', 'web/src/**/*.ts'], ...reactHooks.configs.flat['recommended-latest'] },
  // この設定ファイル自体は型の検査の対象外
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
);
