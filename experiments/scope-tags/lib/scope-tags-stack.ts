import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const AUD_A = 'gekko08-exp:case-service';
export const AUD_B = 'gekko08-exp:account-service';
export const PURPOSES = ['case-summary', 'agent-analysis', 'account-unfreeze'];

// scope相当の値をAWSに強制させる2つの形を検証する。
// E0: JWTの発行条件（sts:SigningAlgorithm、sts:DurationSeconds、宛先のForAllValues）
// E1（形A）: GetWebIdentityTokenのrequest_tagsを、宛先ごとにIAMで絞れるか
// E2（形B）: 取引の目的をtransitive session tagとして刻み、下流で変えられないか。目的でIAMの判定を変えられるか
// E3: 形Aと形Bの組み合わせ
// E4: 同じ宛先で、取引の目的ごとに付けられるscopeを変える（tagの許可に目的の条件を加える）
export class ScopeTagsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('experiment', 'gekko08-scope-tags');
    const tester = new iam.AccountRootPrincipal();

    const mint = (audiences: string[], extra: Record<string, Record<string, unknown>> = {}) => new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': audiences }, StringEquals: { 'sts:SigningAlgorithm': 'ES384' }, ...extra },
    });
    // 宛先がすべてaudienceに含まれ、tagはscopeだけで、その値がscopeValueのときだけ、JWTにtagを付けられる
    const tagFor = (audience: string, scopeValue: string) => new iam.PolicyStatement({
      actions: ['sts:TagGetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [audience], 'aws:TagKeys': ['scope'] },
        Null: { 'sts:IdentityTokenAudience': 'false' },
        StringEquals: { 'aws:RequestTag/scope': scopeValue },
      },
    });

    // E0: 宛先はForAllValues（すべての宛先が許したものに含まれる）で絞る。E1のForAnyValueと比べる
    const r0 = new iam.Role(this, 'E0', { assumedBy: tester });
    r0.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [AUD_A] },
        Null: { 'sts:IdentityTokenAudience': 'false' },
        StringEquals: { 'sts:SigningAlgorithm': 'ES384' },
        NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
      },
    }));

    // E1
    const ra = new iam.Role(this, 'E1', { assumedBy: tester });
    ra.addToPolicy(mint([AUD_A, AUD_B]));
    ra.addToPolicy(tagFor(AUD_A, 'case:summary'));
    ra.addToPolicy(tagFor(AUD_B, 'account:read'));

    // E2: U（ログイン時のfederated roleのセッションに相当）→ P（取引の目的を刻む）→ C（下流のchain用role）
    const u = new iam.Role(this, 'User', { assumedBy: tester });
    u.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [tester] }),
      new iam.PolicyStatement({ actions: ['sts:TagSession'], principals: [tester], conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['branch'] } } }),
    );
    const trustFrom = (role: iam.Role, from: iam.Role, conditions: Record<string, Record<string, unknown>>) => {
      const p = new iam.ArnPrincipal(from.roleArn);
      role.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [p] }),
        new iam.PolicyStatement({ actions: ['sts:TagSession'], principals: [p], conditions }),
      );
      from.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'], resources: [role.roleArn] }));
    };
    const p = new iam.Role(this, 'Purpose', { assumedBy: new iam.ArnPrincipal(u.roleArn) });
    // 目的のキーはpurposeだけ、値は定めたものだけ。引き継いだbranchも含めてキーを限る
    trustFrom(p, u, {
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['branch', 'purpose'] },
      StringEquals: { 'aws:RequestTag/purpose': PURPOSES },
    });
    p.addToPolicy(mint([AUD_A]));
    const c = new iam.Role(this, 'Chain', { assumedBy: new iam.ArnPrincipal(p.roleArn) });
    trustFrom(c, p, { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['branch', 'purpose'] } });
    // 目的によって、発行できるJWTの宛先を変える：account-service宛ては、目的がcase-summaryのときだけ
    c.addToPolicy(mint([AUD_A]));
    c.addToPolicy(mint([AUD_B], { StringEquals: { 'sts:SigningAlgorithm': 'ES384', 'aws:PrincipalTag/purpose': 'case-summary' } }));
    // E3: 下流でも、宛先ごとのscopeを付けられる
    c.addToPolicy(tagFor(AUD_A, 'case:read'));

    // E4: account-service宛ては、case-summaryならaccount:readだけ、account-unfreezeならaccount:unfreezeだけ
    const c4 = new iam.Role(this, 'Chain4', { assumedBy: new iam.ArnPrincipal(p.roleArn) });
    trustFrom(c4, p, { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['branch', 'purpose'] } });
    c4.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [AUD_B] },
        Null: { 'sts:IdentityTokenAudience': 'false' },
        StringEquals: { 'sts:SigningAlgorithm': 'ES384', 'aws:PrincipalTag/purpose': ['case-summary', 'account-unfreeze'] },
      },
    }));
    const tagForPurpose = (audience: string, purpose: string, scopeValue: string) => {
      const st = tagFor(audience, scopeValue);
      st.addCondition('StringEquals', { 'aws:RequestTag/scope': scopeValue, 'aws:PrincipalTag/purpose': purpose });
      return st;
    };
    c4.addToPolicy(tagForPurpose(AUD_B, 'case-summary', 'account:read'));
    c4.addToPolicy(tagForPurpose(AUD_B, 'account-unfreeze', 'account:unfreeze'));
    // tagの値に空白を使えるか（scopeを空白区切りの一覧にする場合）
    c4.addToPolicy(mint([AUD_A]));
    c4.addToPolicy(tagFor(AUD_A, 'case:read case:propose'));

    for (const [key, role] of Object.entries({ E0: r0, E1: ra, User: u, Purpose: p, Chain: c, Chain4: c4 })) {
      new cdk.CfnOutput(this, `${key}RoleArn`, { value: role.roleArn });
    }
  }
}
