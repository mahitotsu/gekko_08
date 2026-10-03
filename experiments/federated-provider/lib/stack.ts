import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** JWTを発行して中身を見るための宛先（外部には渡さない） */
export const AUD = 'gekko08-exp-federated-provider';

export interface FederatedProviderStackProps extends cdk.StackProps {
  userPoolId: string;
  clientId: string;
}

/**
 * OIDC providerで引き受けたroleのセッションが、次のroleを引き受ける要求に、条件キー`aws:FederatedProvider`が入るか、入るならどの値かを調べる。
 * 検証用のfederated role（本体と同じOIDC providerと`aud`を信頼する）から、信頼ポリシーの条件だけが違う引き受け先のroleを引き受ける。
 */
export class FederatedProviderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FederatedProviderStackProps) {
    super(scope, id, props);
    const issuer = `cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}`;
    const providerArn = `arn:aws:iam::${this.account}:oidc-provider/${issuer}`;

    const webIdentity = new iam.FederatedPrincipal(providerArn, { StringEquals: { [`${issuer}:aud`]: props.clientId } }, 'sts:AssumeRoleWithWebIdentity');
    const federated = new iam.Role(this, 'Federated', { assumedBy: webIdentity, maxSessionDuration: cdk.Duration.hours(1) });
    federated.assumeRolePolicy!.addStatements(new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [webIdentity] }));
    // federated roleのセッション自身のJWTも見る
    federated.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['sts:GetWebIdentityToken'], resources: ['*'] }));

    // 引き受け先のrole。信頼ポリシーの条件だけを変える
    const variants: Record<string, Record<string, unknown> | undefined> = {
      V0: undefined, // 対照：条件なし
      V1: { StringEquals: { 'aws:FederatedProvider': providerArn } }, // 値＝OIDC providerのARN（本体で試して拒否された形）
      V2: { StringEquals: { 'aws:FederatedProvider': issuer } }, // 値＝発行者（https://なし）
      V3: { StringEquals: { 'aws:FederatedProvider': `https://${issuer}` } }, // 値＝発行者（https://あり）
      V4: { Null: { 'aws:FederatedProvider': 'false' } }, // キーがある
      V5: { Null: { 'aws:FederatedProvider': 'true' } }, // キーがない
    };
    for (const [name, condition] of Object.entries(variants)) {
      const principal = new iam.ArnPrincipal(federated.roleArn);
      const target = new iam.Role(this, name, { assumedBy: condition ? principal.withConditions(condition) : principal });
      target.assumeRolePolicy!.addStatements(new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [principal] }));
      target.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['sts:GetWebIdentityToken'], resources: ['*'] }));
      federated.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:SetSourceIdentity'], resources: [target.roleArn] }));
      new cdk.CfnOutput(this, `${name}RoleArn`, { value: target.roleArn });
    }
    new cdk.CfnOutput(this, 'FederatedRoleArn', { value: federated.roleArn });
    new cdk.CfnOutput(this, 'ProviderArn', { value: providerArn });
    new cdk.CfnOutput(this, 'Issuer', { value: issuer });
  }
}
