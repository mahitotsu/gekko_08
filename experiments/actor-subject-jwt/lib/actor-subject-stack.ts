import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  issuer: string;
}

const aud = (hop: string) => `gekko08-hop-${hop}`;

// Token Exchange 相当の構成:
// - actor（どのサービスから来たか）: 受信側 resource policy で呼び出し元の「実行role」だけを許可する
// - subject（誰の代理か）と aud: 呼び出し元が GetWebIdentityToken で発行した JWT をアプリが検証する
// - chain用role は「次の chain用role への chain」と「次のホップ宛て JWT の発行」だけを持つ
// Frontend(テストスクリプト) → A → B → C
export class ActorSubjectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    cdk.Tags.of(this).add('experiment', 'gekko08-actor-subject');

    const mint = (audience: string) => new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': [audience] } },
    });

    // --- chain用role ---
    const admin = new iam.AccountRootPrincipal();
    const frontend = new iam.Role(this, 'Frontend', { assumedBy: admin });
    frontend.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession', 'sts:SetSourceIdentity'], principals: [admin],
    }));
    frontend.addToPolicy(mint(aud('A')));

    const chainRole = (cid: string, trusted: iam.Role, audience: string) => {
      const p = new iam.ArnPrincipal(trusted.roleArn);
      const role = new iam.Role(this, cid, { assumedBy: p });
      role.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [p] }),
        new iam.PolicyStatement({
          actions: ['sts:TagSession'], principals: [p],
          conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['department'] } },
        }),
      );
      role.addToPolicy(mint(audience));
      trusted.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'], resources: [role.roleArn],
      }));
      return role;
    };
    const aChain = chainRole('AChain', frontend, aud('B'));
    const bChain = chainRole('BChain', aChain, aud('C'));

    // --- ホップ ---
    const hop = (hid: string, environment: Record<string, string>, role?: iam.IRole) => new lambda.Function(this, hid, {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('build/hop'),
      timeout: cdk.Duration.seconds(30),
      role,
      environment: { ISSUER: props.issuer, ...environment },
    });
    const c = hop('C', { MODE: 'terminal', HOP: 'C', AUD: aud('C'), EXPECTED_SUB: bChain.roleArn });
    const urlC = c.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const b = hop('B', {
      MODE: 'relay', HOP: 'B', AUD: aud('B'), EXPECTED_SUB: aChain.roleArn,
      CHAIN_ROLE: bChain.roleArn, NEXT_URL: urlC.url, NEXT_AUD: aud('C'),
    });
    const urlB = b.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const a = hop('A', {
      MODE: 'relay', HOP: 'A', AUD: aud('A'), EXPECTED_SUB: frontend.roleArn,
      CHAIN_ROLE: aChain.roleArn, NEXT_URL: urlB.url, NEXT_AUD: aud('B'),
      // ホップ飛ばしの試行用: A が BChain になり、C 宛ての JWT を作って C を直接呼ぶ
      SKIP_ROLE: bChain.roleArn, SKIP_URL: urlC.url, SKIP_AUD: aud('C'),
    });
    const urlA = a.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    // B と同じ実行role を共有する別の関数。lambda:SourceFunctionArn で B と区別できるかを試す
    const b2 = hop('B2', { MODE: 'impostor', HOP: 'B2', NEXT_URL: urlC.url, NEXT_AUD: aud('C') }, b.role);
    const urlB2 = b2.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // --- 入口: 呼び出し元の身元（actor）だけを IAM で確かめる ---
    // 同一アカウントでは identity policy の広い許可（AdministratorAccess 等）でも呼べてしまうため、
    // 許可した role 以外を明示的に Deny する（初回の x4 で確認）
    const door = (pid: string, fn: lambda.Function, principalArn: string, extra: Record<string, Record<string, string>> = {}) =>
      new lambda.CfnResourcePolicy(this, pid, {
        resourceArn: fn.functionArn,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'DenyOthers', Effect: 'Deny', Principal: '*',
              Action: ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'], Resource: fn.functionArn,
              Condition: { ArnNotEquals: { 'aws:PrincipalArn': principalArn } },
            },
            {
              Sid: 'Url', Effect: 'Allow', Principal: { AWS: principalArn },
              Action: 'lambda:InvokeFunctionUrl', Resource: fn.functionArn,
              Condition: { ...extra, StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
            },
            {
              Sid: 'Fn', Effect: 'Allow', Principal: { AWS: principalArn },
              Action: 'lambda:InvokeFunction', Resource: fn.functionArn,
              Condition: { ...extra, Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
            },
          ],
        },
      });
    door('ADoor', a, frontend.roleArn);                 // 入口: Frontend
    door('BDoor', b, a.role!.roleArn);                  // A の実行role
    door('CDoor', c, b.role!.roleArn, { ArnEquals: { 'lambda:SourceFunctionArn': b.functionArn } }); // B の実行role かつ関数 B
    door('B2Door', b2, frontend.roleArn);               // テストスクリプトから起動する

    new cdk.CfnOutput(this, 'FrontendRoleArn', { value: frontend.roleArn });
    new cdk.CfnOutput(this, 'BChainArn', { value: bChain.roleArn });
    new cdk.CfnOutput(this, 'AUrl', { value: urlA.url });
    new cdk.CfnOutput(this, 'BUrl', { value: urlB.url });
    new cdk.CfnOutput(this, 'CUrl', { value: urlC.url });
    new cdk.CfnOutput(this, 'B2Url', { value: urlB2.url });
  }
}
