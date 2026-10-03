import { defineConfig } from 'vitest/config';

// 単体テスト（`npm test`）。テストを持つワークスペースを、1回の実行でまとめて走らせる。
// シナリオテスト（tests/）はデプロイしたスタックを呼ぶので含めない（`npm run test:scenario`）
export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'infra'],
  },
});
