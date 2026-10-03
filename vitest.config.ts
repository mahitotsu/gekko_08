import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// 単体テスト（`npm test`）。テストを持つワークスペースを、1回の実行でまとめて走らせる。
// シナリオテスト（tests/）はデプロイしたスタックを呼ぶので含めない（`npm run test:scenario`）。
// ワークスペースの中で`vitest run`を実行したときもこの設定が読まれるので、パスはこのファイルの場所から決める
export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'infra'].map((p) => path.join(import.meta.dirname, p)),
  },
});
