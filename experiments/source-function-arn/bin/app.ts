import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodeFunction } from '../../../infra/lib/constructs/node-function';

// lambda:SourceFunctionArnで、同じ実行roleを持つ別の関数からの呼び出しを拒否する2つの形を比べる。
// C1：受信側のresource policyで使う（今の参照実装。公式の文書は「resource-based policyでは使えない」としている）
// C2：呼び出し元の実行roleのidentity policyのDenyで使う（公式の文書どおりの使い方）
const app = new cdk.App();
const stack = new cdk.Stack(app, 'Gekko08ExpSourceFunctionArn', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(app).add('project', 'gekko08');
const dir = 'experiments/source-function-arn/src';

// BとB2が共有する実行role
const shared = new iam.Role(stack, 'SharedExecRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
});
const b = new NodeFunction(stack, 'CallerB', { entry: `${dir}/caller.ts`, role: shared, description: 'source-function-arn: B' });
const b2 = new NodeFunction(stack, 'CallerB2', { entry: `${dir}/caller.ts`, role: shared, description: 'source-function-arn: B2 (same role as B)' });

const actions = ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'];
function receiver(id: string, denyOtherFunctionsInResourcePolicy: boolean) {
  const fn = new NodeFunction(stack, id, { entry: `${dir}/receiver.ts`, description: `source-function-arn: ${id}` });
  const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
  new lambda.CfnResourcePolicy(stack, `${id}EntryPolicy`, {
    resourceArn: fn.functionArn,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyOtherPrincipals', Effect: 'Deny', Principal: '*', Action: actions, Resource: fn.functionArn,
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': [shared.roleArn] } },
        },
        ...(denyOtherFunctionsInResourcePolicy ? [{
          Sid: 'DenyOtherFunctions', Effect: 'Deny', Principal: '*', Action: actions, Resource: fn.functionArn,
          Condition: { ArnNotEquals: { 'lambda:SourceFunctionArn': [b.functionArn] } },
        }] : []),
        {
          Sid: 'AllowUrl', Effect: 'Allow', Principal: { AWS: [shared.roleArn] }, Action: 'lambda:InvokeFunctionUrl', Resource: fn.functionArn,
          Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
        },
        {
          Sid: 'AllowInvoke', Effect: 'Allow', Principal: { AWS: [shared.roleArn] }, Action: 'lambda:InvokeFunction', Resource: fn.functionArn,
          Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
        },
      ],
    },
  });
  return { fn, url };
}
const c1 = receiver('ReceiverC1', true);
const c2 = receiver('ReceiverC2', false);

// C2の形：呼び出し元の実行roleに、Bからの呼び出しでなければDenyする文を置く。同じアカウントではresource policyの許可だけで
// 呼べるので、identity policyに許可の条件を書いても絞れない。Denyにする。
// 別のPolicyにするのは、関数がroleの既定のポリシーに依存して、循環参照になるのを避けるため
new iam.Policy(stack, 'DenyOtherSourceFunctions', {
  roles: [shared],
  statements: [new iam.PolicyStatement({
    effect: iam.Effect.DENY, actions, resources: [c2.fn.functionArn],
    conditions: { ArnNotEquals: { 'lambda:SourceFunctionArn': b.functionArn } },
  })],
});

new cdk.CfnOutput(stack, 'CallerBName', { value: b.functionName });
new cdk.CfnOutput(stack, 'CallerB2Name', { value: b2.functionName });
new cdk.CfnOutput(stack, 'ReceiverC1Url', { value: c1.url.url });
new cdk.CfnOutput(stack, 'ReceiverC2Url', { value: c2.url.url });
