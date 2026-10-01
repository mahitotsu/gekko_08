import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodeFunction } from '../../../infra/lib/constructs/node-function';

// Lambdaから、OTelのトレースとメトリクスをCloudWatchへ送る方式を比べる。本体のスタックとは別に作る
const app = new cdk.App();
const stack = new cdk.Stack(app, 'Gekko08ExpOtelExport', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(app).add('project', 'gekko08');

const dir = 'experiments/otel-export/src';
// CloudWatchのOTLPの受け口に送る権限。トレースの受け口が要るアクションは文書に明記がないので、候補をすべて許す
const sendToCloudWatch = [
  new iam.PolicyStatement({ actions: ['xray:PutSpans', 'xray:PutSpansForIndexing', 'xray:PutTraceSegments'], resources: ['*'] }),
  new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }),
];

const fn = (id: string, entry: string, extra: Partial<ConstructorParameters<typeof NodeFunction>[2]> = {}) =>
  new NodeFunction(stack, id, { entry: `${dir}/${entry}`, description: `otel-export: ${id}`, ...extra });

const baseline = fn('Baseline', 'baseline.ts');
const direct = fn('Direct', 'direct.ts');
for (const s of sendToCloudWatch) direct.addToRolePolicy(s);

// B. ADOTのレイヤー（CloudWatch Application Signalsの方式）
const adot = fn('Adot', 'adot.ts', {
  layers: [lambda.LayerVersion.fromLayerVersionArn(stack, 'AdotLayer', 'arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:16')],
  tracing: lambda.Tracing.ACTIVE,
  environment: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument' },
});
adot.role!.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLambdaApplicationSignalsExecutionRolePolicy'));

// C. コレクターのレイヤー（opentelemetry-lambda）
const collector = fn('Collector', 'collector.ts', {
  layers: [lambda.LayerVersion.fromLayerVersionArn(stack, 'CollectorLayer', 'arn:aws:lambda:ap-northeast-1:184161586896:layer:opentelemetry-collector-arm64-0_23_0:1')],
  environment: { OPENTELEMETRY_COLLECTOR_CONFIG_URI: '/var/task/collector.yaml' },
  bundling: {
    commandHooks: {
      beforeBundling: () => [],
      beforeInstall: () => [],
      afterBundling: (inputDir: string, outputDir: string) => [`cp ${inputDir}/${dir}/collector.yaml ${outputDir}/collector.yaml`],
    },
  },
});
for (const s of sendToCloudWatch) collector.addToRolePolicy(s);

// トレースとメトリクスの受け口が、どのIAMのアクションで認可するかを確かめるrole。1つのアクションだけを持つ。
// 送信のAPIはCloudTrailに記録されないので、実際に送って確かめる（scripts/probe-iam.ts）
const probes = {
  PutSpans: 'xray:PutSpans',
  PutSpansForIndexing: 'xray:PutSpansForIndexing',
  PutTraceSegments: 'xray:PutTraceSegments',
  PutMetricData: 'cloudwatch:PutMetricData',
  Nothing: undefined,
};
for (const [name, action] of Object.entries(probes)) {
  const role = new iam.Role(stack, `Probe${name}`, { assumedBy: new iam.AccountRootPrincipal(), description: `otel-export: only ${action ?? 'nothing'}` });
  if (action) role.addToPolicy(new iam.PolicyStatement({ actions: [action], resources: ['*'] }));
  else role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:GetCallerIdentity'], resources: ['*'] }));
  new cdk.CfnOutput(stack, `Probe${name}Role`, { value: role.roleArn });
}

for (const [name, f] of Object.entries({ baseline, direct, adot, collector })) {
  new cdk.CfnOutput(stack, `${name}Function`, { value: f.functionName });
}
