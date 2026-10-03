import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import type { AuthFoundation } from '../lib/constructs/auth-foundation';
import { Bff } from '../lib/constructs/bff';
import { PURPOSE_TAG, REQUEST_ID_TAG } from '../lib/constructs/hop';
import { atoms, canonical, diffAtoms, roleStatements, type Json } from './policy';

/**
 * bffの目的を刻むroleの信頼ポリシーの回帰テスト（設計書§5）。刻める目的の値と、セッション名をリクエストIDのtagに縛る条件を確かめる。
 * 後半では、条件をわざと壊したテンプレートを見逃さないことを確かめる
 */

const PURPOSES = ['p-a', 'p-b'];
// `aws:FederatedProvider`の値は、OIDC providerのARNではなく、`https://`を除いた発行者
const ISSUER = 'cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_pool';

function buildFixture() {
  // バンドルを飛ばす（テンプレートだけを見る）
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'PurposeRoleTest', { env: { account: '111111111111', region: 'ap-northeast-1' } });
  // 目的を刻むroleの配線が使うのはfederated roleだけ。Cognitoは作らない
  const federatedRole = new iam.Role(stack, 'Federated', { assumedBy: new iam.AccountRootPrincipal() });
  const bff = new Bff(stack, 'Bff');
  bff.connect({ federatedRole, oidcIssuer: ISSUER } as unknown as AuthFoundation, PURPOSES);
  const purposeRole = bff.asCaller().chainRole;
  const template: Json = Template.fromStack(stack).toJSON();
  const id = (role: iam.Role) => stack.getLogicalId(role.node.defaultChild as cdk.CfnElement);
  return { stack, template, purposeRoleId: id(purposeRole), federatedRoleId: id(federatedRole), purposeRole, federatedRole };
}

type Fixture = ReturnType<typeof buildFixture>;
const fixture = buildFixture();
const r = (f: Fixture, v: unknown): Json => f.stack.resolve(v);

/**
 * 目的を刻むroleの信頼：federated roleだけを、このUser Poolで認証されたセッション（`aws:FederatedProvider`）で、
 * 刻むリクエストIDと同じセッション名でだけ信頼し、刻めるのは目的とリクエストIDのtagだけ
 */
function checkTrust(f: Fixture): string[] {
  const doc = f.template.Resources[f.purposeRoleId].Properties.AssumeRolePolicyDocument;
  const principal = { AWS: r(f, f.federatedRole.roleArn) };
  const expected = atoms([
    {
      Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:RoleSessionName': `\${aws:RequestTag/${REQUEST_ID_TAG}}`, 'aws:FederatedProvider': ISSUER } },
    },
    { Effect: 'Allow', Principal: principal, Action: 'sts:SetSourceIdentity' },
    {
      Effect: 'Allow', Principal: principal, Action: 'sts:TagSession',
      Condition: {
        'ForAllValues:StringEquals': { 'aws:TagKeys': [PURPOSE_TAG, REQUEST_ID_TAG] },
        StringEquals: { [`aws:RequestTag/${PURPOSE_TAG}`]: PURPOSES },
      },
    },
  ]);
  return diffAtoms('purpose role trust', atoms(doc.Statement), expected);
}

/** federated roleは、目的を刻むroleへのchainだけを持つ */
function checkFederated(f: Fixture): string[] {
  const resource = r(f, f.purposeRole.roleArn);
  const expected = atoms([{ Effect: 'Allow', Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'], Resource: resource }]);
  return diffAtoms('federated role', atoms(roleStatements(f.template, f.federatedRoleId)), expected);
}

const checks = { trust: checkTrust, federated: checkFederated } satisfies Record<string, (f: Fixture) => string[]>;

describe('目的を刻むroleのテンプレート', () => {
  it('信頼：federated roleだけを、このUser Poolで認証されたセッションで、リクエストIDのtagと同じセッション名でだけ信頼し、tagのキーは目的とリクエストID、目的の値は一覧だけ', () => {
    expect(checks.trust(fixture)).toEqual([]);
  });

  it('federated roleは、目的を刻むroleへのchainだけを持つ', () => {
    expect(checks.federated(fixture)).toEqual([]);
  });
});

const trustStatements = (f: Fixture, t: Json): Json[] => t.Resources[f.purposeRoleId].Properties.AssumeRolePolicyDocument.Statement;
const statementFor = (f: Fixture, t: Json, action: string) => trustStatements(f, t).find((s) => [s.Action].flat().includes(action));

const mutations: { name: string; check: keyof typeof checks; mutate: (f: Fixture, t: Json) => void }[] = [
  {
    name: 'セッション名の条件を外す', check: 'trust',
    mutate: (f, t) => { delete statementFor(f, t, 'sts:AssumeRole').Condition.StringEquals['sts:RoleSessionName']; },
  },
  {
    name: 'IdPの条件を外す（別のIdPで認証されたセッションも受け付ける）', check: 'trust',
    mutate: (f, t) => { delete statementFor(f, t, 'sts:AssumeRole').Condition.StringEquals['aws:FederatedProvider']; },
  },
  {
    name: 'IdPの条件を、別のUser Poolにする', check: 'trust',
    mutate: (f, t) => { statementFor(f, t, 'sts:AssumeRole').Condition.StringEquals['aws:FederatedProvider'] = 'cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_other'; },
  },
  {
    name: 'セッション名を、刻むtagではなく任意の値で許す', check: 'trust',
    mutate: (f, t) => { statementFor(f, t, 'sts:AssumeRole').Condition = { StringLike: { 'sts:RoleSessionName': '*' } }; },
  },
  {
    name: '目的の値の制限を外す', check: 'trust',
    mutate: (f, t) => { delete statementFor(f, t, 'sts:TagSession').Condition.StringEquals; },
  },
  {
    name: '刻める目的を増やす', check: 'trust',
    mutate: (f, t) => { statementFor(f, t, 'sts:TagSession').Condition.StringEquals[`aws:RequestTag/${PURPOSE_TAG}`] = [...PURPOSES, 'admin']; },
  },
  {
    name: 'tagのキーの制限を外す', check: 'trust',
    mutate: (f, t) => { delete statementFor(f, t, 'sts:TagSession').Condition['ForAllValues:StringEquals']; },
  },
  {
    name: 'federated role以外も信頼する', check: 'trust',
    mutate: (f, t) => { statementFor(f, t, 'sts:AssumeRole').Principal = { AWS: 'arn:aws:iam::111111111111:root' }; },
  },
  {
    name: 'federated roleに別のroleへのchainを許す', check: 'federated',
    mutate: (f, t) => {
      const policy = Object.values<Json>(t.Resources).find((x) => x.Type === 'AWS::IAM::Policy' && x.Properties.Roles.some((y: Json) => y.Ref === f.federatedRoleId));
      policy.Properties.PolicyDocument.Statement[0].Resource = '*';
    },
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
