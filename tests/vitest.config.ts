import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scenario/**/*.test.ts'],
    // デプロイした1つのスタック（デモユーザーのパスワードなど）を共有するので、ファイルを並列に実行しない
    fileParallelism: false,
    testTimeout: 60_000,
    // スタックのリージョン（infra/lib/app-stack.tsのREGION）。シェルの設定に左右されないよう固定する
    env: { AWS_REGION: 'ap-northeast-1' },
    hookTimeout: 120_000,
  },
});
