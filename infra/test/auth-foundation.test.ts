import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AuthFoundation } from '../lib/constructs/auth-foundation';
import { atoms, canonical, diffAtoms, type Json } from './policy';

/**
 * federated roleの信頼ポリシーの回帰テスト（設計書§5）。SourceIdentityを刻む入口は、このUser PoolのOIDC providerと、
 * このアプリクライアントの`aud`だけに限る。別のIdPのトークンで同じSourceIdentityを刻めないこと（脅威の総点検 A-8）を、テンプレートで確かめる。
 * 後半では、条件をわざと壊したテンプレートを見逃さないことを確かめる
 */

function buildFixture() {
  // バンドルを飛ばす（テンプレートだけを見る）
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'AuthFoundationTest', { env: { account: '111111111111', region: 'ap-northeast-1' } });
  const auth = new AuthFoundation(stack, 'Auth', { callbackUrl: 'https://example.com/api/callback', logoutUrl: 'https://example.com/' });
  const template: Json = Template.fromStack(stack).toJSON();
  const id = (c: Json) => stack.getLogicalId(c.node.defaultChild as cdk.CfnElement);
  const idOf = (type: string) => {
    const ids = Object.keys(template.Resources).filter((k) => template.Resources[k].Type === type);
    if (ids.length !== 1) throw new Error(`${type}: ${ids.length}`);
    return ids[0];
  };
  return {
    stack, template, auth,
    federatedRoleId: id(auth.federatedRole), userPoolId: id(auth.userPool), clientId: id(auth.client),
    providerId: idOf('AWS::IAM::OIDCProvider'), audConditionId: idOf('Custom::AWSCDKCfnJson'),
  };
}

type Fixture = ReturnType<typeof buildFixture>;
const fixture = buildFixture();

const issuer = (f: Fixture) => ['cognito-idp.ap-northeast-1.amazonaws.com/', { Ref: f.userPoolId }];

/** `Fn::Join`の要素のうち、連続する文字列を1つにまとめる（CDKはまとめて出力するので、比べる前に同じ形にそろえる） */
const join = (parts: Json[]) => canonical({
  'Fn::Join': ['', parts.reduce<Json[]>((acc, p) => {
    if (typeof p === 'string' && typeof acc[acc.length - 1] === 'string') acc[acc.length - 1] += p; else acc.push(p);
    return acc;
  }, [])],
});

/** federated roleの信頼：このUser PoolのOIDC providerだけを、`aud`の条件付きで信頼する。SourceIdentityを刻めるのも同じ相手だけ */
function checkTrust(f: Fixture): string[] {
  const doc = f.template.Resources[f.federatedRoleId].Properties.AssumeRolePolicyDocument;
  const principal = { Federated: { Ref: f.providerId } };
  const condition = { StringEquals: { 'Fn::GetAtt': [f.audConditionId, 'Value'] } };
  const expected = atoms([
    { Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRoleWithWebIdentity', Condition: condition },
    { Effect: 'Allow', Principal: principal, Action: 'sts:SetSourceIdentity', Condition: condition },
  ]);
  return diffAtoms('federated role trust', atoms(doc.Statement), expected);
}

/** `aud`の条件：キーはこのUser Poolの発行者の`aud`、値はこのアプリクライアントのID */
function checkAud(f: Fixture): string[] {
  const actual = f.template.Resources[f.audConditionId].Properties.Value;
  const expected = ['{"', ...issuer(f), ':aud":"', { Ref: f.clientId }, '"}'];
  return join(actual['Fn::Join'][1]) === join(expected) ? [] : [`aud condition: ${JSON.stringify(actual)}`];
}

/** OIDC provider：URLはこのUser Poolの発行者、受け付けるクライアントはこのアプリクライアントだけ */
function checkProvider(f: Fixture): string[] {
  const p = f.template.Resources[f.providerId].Properties;
  const errors: string[] = [];
  const url = typeof p.Url === 'string' ? [p.Url] : p.Url['Fn::Join'][1];
  if (join(url) !== join(['https://', ...issuer(f)])) errors.push(`provider url: ${JSON.stringify(p.Url)}`);
  if (canonical(p.ClientIdList) !== canonical([{ Ref: f.clientId }])) errors.push(`provider clients: ${JSON.stringify(p.ClientIdList)}`);
  return errors;
}

const checks: Record<string, (f: Fixture) => string[]> = { trust: checkTrust, aud: checkAud, provider: checkProvider };

describe('federated roleのテンプレート（SourceIdentityを刻む入口）', () => {
  it('信頼：このUser PoolのOIDC providerだけを、`aud`の条件付きで信頼し、SourceIdentityを刻めるのも同じ相手だけ', () => {
    expect(checks.trust(fixture)).toEqual([]);
  });

  it('`aud`の条件：このUser Poolの発行者の`aud`が、このアプリクライアントのIDであること', () => {
    expect(checks.aud(fixture)).toEqual([]);
  });

  it('OIDC provider：このUser Poolの発行者で、受け付けるクライアントはこのアプリクライアントだけ', () => {
    expect(checks.provider(fixture)).toEqual([]);
  });

  it('`AuthFoundation`が公開するOIDC providerのARNは、federated roleが信頼するproviderと同じ', () => {
    expect(fixture.stack.resolve(fixture.auth.oidcProviderArn)).toEqual({ Ref: fixture.providerId });
  });
});

const trustStatement = (f: Fixture, t: Json, action: string) =>
  t.Resources[f.federatedRoleId].Properties.AssumeRolePolicyDocument.Statement.find((s: Json) => [s.Action].flat().includes(action));

const mutations: { name: string; check: keyof typeof checks; mutate: (f: Fixture, t: Json) => void }[] = [
  {
    name: '`aud`の条件を外す（同じUser Poolの別のアプリクライアントのトークンも受け付ける）', check: 'trust',
    mutate: (f, t) => { delete trustStatement(f, t, 'sts:AssumeRoleWithWebIdentity').Condition; },
  },
  {
    name: '別のIdP（OIDC provider）も信頼する', check: 'trust',
    mutate: (f, t) => {
      t.Resources[f.federatedRoleId].Properties.AssumeRolePolicyDocument.Statement.push({
        Effect: 'Allow', Principal: { Federated: 'arn:aws:iam::111111111111:oidc-provider/evil.example.com' }, Action: 'sts:AssumeRoleWithWebIdentity',
      });
    },
  },
  {
    name: '別のIdPにもSourceIdentityを刻ませる', check: 'trust',
    mutate: (f, t) => { trustStatement(f, t, 'sts:SetSourceIdentity').Principal = { Federated: 'arn:aws:iam::111111111111:oidc-provider/evil.example.com' }; },
  },
  {
    name: '`aud`を別のアプリクライアントにする', check: 'aud',
    mutate: (f, t) => {
      const parts = t.Resources[f.audConditionId].Properties.Value['Fn::Join'][1];
      parts[parts.findIndex((p: Json) => p?.Ref === f.clientId)] = 'other-client';
    },
  },
  {
    name: 'OIDC providerを別のUser Poolにする', check: 'provider',
    mutate: (f, t) => { t.Resources[f.providerId].Properties.Url = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_other'; },
  },
  {
    name: 'OIDC providerが別のクライアントも受け付ける', check: 'provider',
    mutate: (f, t) => { t.Resources[f.providerId].Properties.ClientIdList.push('other-client'); },
  },
];

describe('条件を壊したテンプレートを見逃さない', () => {
  it.each(mutations)('$name → $check', ({ check, mutate }) => {
    const template = structuredClone(fixture.template);
    mutate(fixture, template);
    expect(canonical(template)).not.toEqual(canonical(fixture.template));
    expect(checks[check]({ ...fixture, template })).not.toEqual([]);
  });
});
