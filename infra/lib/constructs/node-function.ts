import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

export interface NodeFunctionProps extends Omit<nodejs.NodejsFunctionProps, 'entry'> {
  /** リポジトリのルートからの相対パス */
  entry: string;
}

/** 参照実装のLambda関数の既定値。AWS SDKは関数に同梱する（実装言語のADR） */
export class NodeFunction extends nodejs.NodejsFunction {
  constructor(scope: Construct, id: string, props: NodeFunctionProps) {
    const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    super(scope, id, {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      logGroup,
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
