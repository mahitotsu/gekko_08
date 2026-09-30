import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import {
  FRONTEND_ROLE, HOP_C_AUD, INSPECT_AUD,
  allowAssume, allowInvoke, allowSalesOnly, chainRole, hopFunction, inspectStatement,
} from './common';

// 多段伝播の方式比較 (a) 一時クレデンシャルを下流へ渡す / (b) 受信側が SourceIdentity を付け直す
// Frontend(Cognito federation) → A → (B) → C。C は受信側 resource policy で department=sales のみ許可
export class MultiHopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('experiment', 'gekko08-multihop');

    // --- Cognito → IAM OIDC provider → Frontend role（検証3と同じ構成） ---
    const pretoken = new lambda.Function(this, 'PreToken', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/pretoken'),
    });
    const pool = new cognito.UserPool(this, 'Pool', {
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      customAttributes: { department: new cognito.StringAttribute({ mutable: true }) },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    pool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, pretoken, cognito.LambdaVersion.V2_0);
    const client = pool.addClient('Client', { authFlows: { userPassword: true } });

    const issuer = `cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`;
    const provider = new iam.OidcProviderNative(this, 'Oidc', {
      url: `https://${issuer}`,
      clientIds: [client.userPoolClientId],
    });
    const fedPrincipal = new iam.FederatedPrincipal(provider.oidcProviderArn, {
      StringEquals: new cdk.CfnJson(this, 'AudCond', { value: { [`${issuer}:aud`]: client.userPoolClientId } }),
    }, 'sts:AssumeRoleWithWebIdentity');
    const frontend = new iam.Role(this, 'Frontend', { roleName: FRONTEND_ROLE, assumedBy: fedPrincipal });
    frontend.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession', 'sts:SetSourceIdentity'],
      principals: [fedPrincipal],
    }));
    frontend.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': [INSPECT_AUD, HOP_C_AUD] } },
    }));

    // --- 終端 C ---
    const c = hopFunction(this, 'C', { MODE: 'terminal', HOP: 'C' });
    const urlC = c.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // --- 方式(a): 受け取った一時クレデンシャルで次の role に chain し、それを下流へ渡す ---
    const aaOut = chainRole(this, 'AaOut', frontend.roleArn);
    const baOut = chainRole(this, 'BaOut', aaOut.roleArn);
    allowAssume(frontend, aaOut);
    allowAssume(aaOut, baOut);
    const ba = hopFunction(this, 'Ba', { MODE: 'a', HOP: 'B-a', OUT_ROLE: baOut.roleArn, NEXT_URL: urlC.url });
    const urlBa = ba.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const aa = hopFunction(this, 'Aa', { MODE: 'a', HOP: 'A-a', OUT_ROLE: aaOut.roleArn, NEXT_URL: urlBa.url });
    const urlAa = aa.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    allowInvoke(aa, 'Frontend', frontend.roleArn);
    allowInvoke(ba, 'AaOut', aaOut.roleArn);

    // --- 方式(b): 受信側が自分の実行 role から、SourceIdentity と tags を付けて AssumeRole し直す ---
    const ab = hopFunction(this, 'Ab', { MODE: 'b', HOP: 'A-b', NEXT_URL: urlC.url });
    const abOut = chainRole(this, 'AbOut', ab.role!.roleArn);
    ab.addEnvironment('OUT_ROLE', abOut.roleArn);
    allowAssume(ab, abOut);
    const urlAb = ab.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    allowInvoke(ab, 'Frontend', frontend.roleArn);

    allowSalesOnly(this, 'CPolicy', c, [baOut.roleArn, abOut.roleArn]);

    // 途中のホップによる新しい tag キーの追加を防げるか。
    // sts:TagSession を外すと transitive tags の引き継ぎ自体が拒否されたため（out-tags.json 初回）、
    // aws:TagKeys でログイン時に決めたキーだけに絞る
    const strictPrincipal = new iam.ArnPrincipal(frontend.roleArn);
    const strict = new iam.Role(this, 'StrictOut', { assumedBy: strictPrincipal });
    strict.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      actions: ['sts:SetSourceIdentity'],
      principals: [strictPrincipal],
    }), new iam.PolicyStatement({
      actions: ['sts:TagSession'],
      principals: [strictPrincipal],
      conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['department'] } },
    }));
    strict.addToPolicy(inspectStatement());
    allowAssume(frontend, strict);
    new cdk.CfnOutput(this, 'StrictOutArn', { value: strict.roleArn });

    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'FrontendRoleArn', { value: frontend.roleArn });
    new cdk.CfnOutput(this, 'AaUrl', { value: urlAa.url });
    new cdk.CfnOutput(this, 'AbUrl', { value: urlAb.url });
  }
}
