import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export const FRONTEND_ROLE = 'Gekko08Exp-Frontend';
// 各ホップが自分のセッションの中身（source_identity / principal_tags）を観測するためだけのaudience
export const INSPECT_AUD = 'gekko08-inspect';
// 方式(c)で Frontend が A-c 宛てに発行する JWT の audience
export const HOP_C_AUD = 'gekko08-hop-a-c';

export function hopFunction(scope: Construct, id: string, environment: Record<string, string>): lambda.Function {
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.PYTHON_3_13,
    handler: 'index.handler',
    code: lambda.Code.fromAsset('lambda/hop'),
    timeout: cdk.Duration.seconds(30),
    environment,
  });
}

export function inspectStatement(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: ['sts:GetWebIdentityToken'],
    resources: ['*'],
    conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': [INSPECT_AUD] } },
  });
}

// 条件なしで、指定roleからの Function URL 経由の呼び出しを受信側で許可する
export function allowInvoke(fn: lambda.Function, id: string, principalArn: string): void {
  const principal = new iam.ArnPrincipal(principalArn);
  fn.addPermission(`${id}Url`, {
    principal, action: 'lambda:InvokeFunctionUrl', functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
  });
  fn.addPermission(`${id}Fn`, { principal, action: 'lambda:InvokeFunction', invokedViaFunctionUrl: true });
}

// 受信側 resource policy で、指定roleから department=sales のときだけ呼び出しを許可する。
// PutResourcePolicy は既存ポリシーを置換するため、allowInvoke と同じ関数には使わない
export function allowSalesOnly(scope: Construct, id: string, fn: lambda.Function, principalArns: string[]): void {
  const cond = { StringEquals: { 'aws:PrincipalTag/department': 'sales' } };
  new lambda.CfnResourcePolicy(scope, id, {
    resourceArn: fn.functionArn,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'SalesUrl', Effect: 'Allow', Principal: { AWS: principalArns },
          Action: 'lambda:InvokeFunctionUrl', Resource: fn.functionArn,
          Condition: { StringEquals: { ...cond.StringEquals, 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
        },
        {
          Sid: 'SalesFn', Effect: 'Allow', Principal: { AWS: principalArns },
          Action: 'lambda:InvokeFunction', Resource: fn.functionArn,
          Condition: { ...cond, Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
        },
      ],
    },
  });
}

// SourceIdentity と session tags の付与を許した chain 先 role
export function chainRole(scope: Construct, id: string, trustedArn: string): iam.Role {
  const principal = new iam.ArnPrincipal(trustedArn);
  const role = new iam.Role(scope, id, { assumedBy: principal });
  role.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
    actions: ['sts:TagSession', 'sts:SetSourceIdentity'],
    principals: [principal],
  }));
  role.addToPolicy(inspectStatement());
  return role;
}

export function allowAssume(grantee: iam.IGrantable, target: iam.Role): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
    resources: [target.roleArn],
  }));
}
