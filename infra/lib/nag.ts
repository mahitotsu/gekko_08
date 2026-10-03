import { Stack, Validations, type CfnElement } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

/**
 * cdk-nag（AwsSolutions）の指摘を、理由を付けて認める。scopeの下のリソースにだけ効く。
 * ruleは、`IAM5[Resource::*]`のように、cdk-nagが示すIDから接頭辞（`AwsSolutions::AwsSolutions-`）を除いたもの。
 * 認めるのは、参照実装の要件の前提と範囲で採らないもの、AWSの仕様でリソースを絞れないもの、CDKが内部で作るリソースだけにする
 */
export function acknowledgeNag(scope: IConstruct, reason: string, ...rules: string[]): void {
  Validations.of(scope).acknowledge(...rules.map((rule) => ({ id: `AwsSolutions::AwsSolutions-${rule}`, reason })));
}

/**
 * CDKのカスタムリソースのフレームワーク（`cr.Provider`）が、ハンドラーの関数（バージョンを含む）を呼ぶ権限の指摘を認める
 */
export function acknowledgeProviderInvoke(provider: IConstruct, handler: lambda.IFunction): void {
  const id = Stack.of(handler).getLogicalId(handler.node.defaultChild as CfnElement);
  acknowledgeNag(provider, 'CDKのカスタムリソースのフレームワークが、ハンドラーの関数（バージョンを含む）を呼ぶ権限', `IAM5[Resource::<${id}.Arn>:*]`);
}

/** Lambdaの既定の実行role（CDKが付けるAWSLambdaBasicExecutionRole） */
export const LAMBDA_BASIC_EXECUTION = 'IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]';
