import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { acknowledgeNag } from '../nag';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

export interface NodeFunctionProps extends Omit<nodejs.NodejsFunctionProps, 'entry'> {
  /** リポジトリのルートからの相対パス */
  entry: string;
}

/**
 * Lambda関数のロググループ。保持は1週間で、スタックと一緒に消す。名前はCDKが生成し、Lambdaが実行時に作る`/aws/lambda/<関数名>`とは衝突しない。
 * 参照実装の関数のほか、CDKが内部で作る関数（カスタムリソース、BucketDeployment）にも渡す
 */
export function lambdaLogGroup(scope: Construct, id: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
}

/** 参照実装のLambda関数の既定値。AWS SDKは関数に同梱する（実装言語のADR） */
export class NodeFunction extends nodejs.NodejsFunction {
  constructor(scope: Construct, id: string, props: NodeFunctionProps) {
    const logGroup = lambdaLogGroup(scope, `${id}Logs`);
    super(scope, id, {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      logGroup,
      // 1件を1行のJSONにし、Logs Insightsでフィールドを直接扱えるようにする。共通部品のログはJSONのまま書く
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      ...props,
      entry: path.join(REPO_ROOT, props.entry),
      environment: { NODE_OPTIONS: '--enable-source-maps', ...props.environment },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        mainFields: ['module', 'main'],
        minify: true,
        sourceMap: true,
        bundleAwsSDK: true,
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        ...props.bundling,
      },
    });
  }
}

/**
 * 共通部品のトレースを有効にする。関数の中のSDKが、実行roleで署名してCloudWatchのOTLPの受け口に送る（送り方のADR）。
 * トレースの受け口が認可するアクションは`xray:PutTraceSegments`（experiments/otel-export）
 */
export function enableTelemetry(fn: lambda.Function): void {
  fn.addEnvironment('AUTHZ_TELEMETRY', 'cloudwatch');
  // ほかの権限と分けたポリシーにし、ワイルドカードを認める範囲をこの権限だけにする
  const policy = new iam.Policy(fn, 'TelemetryPolicy', {
    roles: fn.role ? [fn.role] : [],
    statements: [new iam.PolicyStatement({ actions: ['xray:PutTraceSegments'], resources: ['*'] })],
  });
  acknowledgeNag(policy, 'xray:PutTraceSegments（OTLPの受け口への送信）は、リソースで絞れない', 'IAM5[Resource::*]');
}
