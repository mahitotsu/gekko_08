import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  receiver: lambda.IFunction;
}

// 検証3: Cognito(Pre Token Generation V2) → IAM OIDC provider → AssumeRoleWithWebIdentity → role chaining
export class CognitoSpikeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    cdk.Tags.of(this).add('spike', 'gekko08');

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

    const fedRoleName = 'Gekko08-Federated';
    const fedPrincipal = new iam.FederatedPrincipal(provider.oidcProviderArn, {
      StringEquals: new cdk.CfnJson(this, 'AudCond', { value: { [`${issuer}:aud`]: client.userPoolClientId } }),
    }, 'sts:AssumeRoleWithWebIdentity');
    const fed = new iam.Role(this, 'Federated', { roleName: fedRoleName, assumedBy: fedPrincipal });
    // SourceIdentity と session tags を刻むために必要
    fed.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession', 'sts:SetSourceIdentity'],
      principals: [fedPrincipal], // aud 条件は principal 側が持つ
    }));

    // chain role: 1つは PrincipalTag のみ、もう1つは SourceIdentity のみで Receiver の呼び出しを許可
    const mkChain = (name: string, cond: Record<string, Record<string, string>>) => {
      const role = new iam.Role(this, name, {
        assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/${fedRoleName}`),
      });
      role.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
        actions: ['sts:TagSession', 'sts:SetSourceIdentity'],
        principals: [new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/${fedRoleName}`)],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunctionUrl'],
        resources: [props.receiver.functionArn],
        conditions: { ...cond, StringEquals: { ...(cond.StringEquals ?? {}), 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.receiver.functionArn],
        conditions: { ...cond, Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:GetWebIdentityToken'],
        resources: ['*'],
        conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': ['https://spike.example'] } },
      }));
      fed.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'], resources: [role.roleArn] }));
      // trust policy の principal は ARN 文字列なので、fed の role 本体の作成後に作る（DefaultPolicy との循環を避ける）
      (role.node.defaultChild as cdk.CfnResource).addDependency(fed.node.defaultChild as cdk.CfnResource);
      return role;
    };
    const byTag = mkChain('ChainByTag', { StringEquals: { 'aws:PrincipalTag/department': 'sales' } });
    const bySrc = mkChain('ChainBySource', { StringEquals: { 'aws:SourceIdentity': 'alice' } });

    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'FederatedRoleArn', { value: fed.roleArn });
    new cdk.CfnOutput(this, 'ChainByTagArn', { value: byTag.roleArn });
    new cdk.CfnOutput(this, 'ChainBySourceArn', { value: bySrc.roleArn });
  }
}
