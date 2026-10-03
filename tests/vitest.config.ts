import { defineConfig } from 'vitest/config';
import { REGION } from '../infra/lib/region';

export default defineConfig({
  test: {
    include: ['scenario/**/*.test.ts'],
    // デプロイした1つのスタック（デモユーザーのパスワードなど）を共有するので、ファイルを並列に実行しない
    fileParallelism: false,
    testTimeout: 60_000,
    // スタックのリージョン。シェルの設定に左右されないよう、infraと同じ値に固定する
    env: { AWS_REGION: REGION },
    hookTimeout: 120_000,
  },
});
