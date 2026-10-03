import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';

/**
 * テストで合成するApp。cdk.jsonと同じcontext（feature flag）を使い、デプロイと同じ設定のテンプレートを確かめる。
 * Lambdaのバンドルはしない
 */
export function testApp(): cdk.App {
  const { context } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../cdk.json'), 'utf8')) as { context: Record<string, unknown> };
  return new cdk.App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
}
