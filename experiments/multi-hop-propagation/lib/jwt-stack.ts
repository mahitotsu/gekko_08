import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { FRONTEND_ROLE, HOP_C_AUD, allowInvoke, allowSalesOnly, hopFunction, inspectStatement } from './common';

interface Props extends cdk.StackProps {
  issuer: string; // 自アカウントの outbound identity federation の発行者 URL
}

// 方式(c): Frontend が GetWebIdentityToken で発行した JWT を A-c に渡し、
// A-c はその JWT で AssumeRoleWithWebIdentity する。SourceIdentity / tags が引き継がれるかを確かめる
export class JwtHopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    cdk.Tags.of(this).add('experiment', 'gekko08-multihop');

    const host = props.issuer.replace(/^https:\/\//, '');
    const provider = new iam.OidcProviderNative(this, 'StsIssuer', { url: props.issuer, clientIds: [HOP_C_AUD] });
    const principal = new iam.FederatedPrincipal(provider.oidcProviderArn, {
      StringEquals: { [`${host}:aud`]: HOP_C_AUD },
    }, 'sts:AssumeRoleWithWebIdentity');
    const acOut = new iam.Role(this, 'AcOut', { assumedBy: principal });
    // STS が JWT から SourceIdentity / tags を設定しようとした場合に、権限不足で失敗しないようにしておく
    acOut.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession', 'sts:SetSourceIdentity'],
      principals: [principal],
    }));
    acOut.addToPolicy(inspectStatement());

    const c2 = hopFunction(this, 'C2', { MODE: 'terminal', HOP: 'C2' });
    const urlC2 = c2.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    allowSalesOnly(this, 'C2Policy', c2, [acOut.roleArn]);

    const ac = hopFunction(this, 'Ac', { MODE: 'c', HOP: 'A-c', OUT_ROLE: acOut.roleArn, NEXT_URL: urlC2.url });
    const urlAc = ac.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    allowInvoke(ac, 'Frontend', `arn:aws:iam::${this.account}:role/${FRONTEND_ROLE}`);

    new cdk.CfnOutput(this, 'AcUrl', { value: urlAc.url });
  }
}
