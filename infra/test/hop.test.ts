import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { Hop, PURPOSE_TAG, REQUEST_ID_TAG, type HopCaller } from '../lib/constructs/hop';
import { atoms, canonical, diffAtoms, roleStatements, type Atom, type Json } from './policy';

/**
 * Hopが作るIAMの条件の回帰テスト。デモの配線には依存させず、試験用の小さなスタックで確かめる。
 * 各チェックは、設計書§5のひな形どおりなら空の配列を返す。後半では、条件をわざと壊したテンプレートを各チェックが見逃さないことを確かめる
 */

const INVOKE = ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'];
const CHAIN = ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'];
const ISSUE = ['sts:GetWebIdentityToken', 'sts:TagGetWebIdentityToken'];

/** 提供側の定義（受信時の照合の設定） */
const PROVIDES = {
  front: { 'front:call': {} },
  leaf: { 'leaf:read': {}, 'leaf:list': {}, 'leaf:write': { purposes: ['p-a'], callers: ['front'] }, 'leaf:direct': { purposes: ['p-a', 'p-b'] } },
};

/** 呼び出し関係：origin（bffに相当する、Hopではない呼び出し元）→ front → leaf、origin → leaf */
function buildFixture() {
  // バンドルを飛ばす（テンプレートだけを見る）
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'HopTest', { env: { account: '111111111111', region: 'ap-northeast-1' } });
  const entry = 'infra/test/fixtures/handler.ts';

  const originFn = new lambda.Function(stack, 'OriginFn', {
    runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>{}'),
  });
  const originChain = new iam.Role(stack, 'OriginChain', { assumedBy: new iam.AccountRootPrincipal() });
  const originTargets: Record<string, unknown> = {};
  const origin: HopCaller = {
    hopName: 'origin', execRole: originFn.role!, fn: originFn, chainRole: originChain,
    addTarget: (name, target) => { originTargets[name] = target; },
  };

  const front = new Hop(stack, 'Front', { hopName: 'front', entry, issuer: 'https://issuer.example', callsOthers: true });
  const leaf = new Hop(stack, 'Leaf', { hopName: 'leaf', entry, issuer: 'https://issuer.example', callsOthers: false });
  front.provide(PROVIDES.front);
  leaf.provide(PROVIDES.leaf);
  front.allowCaller(origin, [{ scope: 'front:call' }]);
  leaf.allowCaller(front.asCaller(), [{ scope: 'leaf:read' }, { scope: 'leaf:list' }, { scope: 'leaf:write', purposes: ['p-a'] }]);
  leaf.allowCaller(origin, [{ scope: 'leaf:direct', purposes: ['p-a', 'p-b'] }]);

  const template: Json = Template.fromStack(stack).toJSON();
  return { stack, template, origin, front, leaf, originTargets };
}

type Fixture = ReturnType<typeof buildFixture>;
const fixture = buildFixture();

const r = (f: Fixture, v: unknown): Json => f.stack.resolve(v);
const logicalId = (f: Fixture, c: { node: { defaultChild?: unknown } } | cdk.CfnElement): string =>
  f.stack.getLogicalId((c instanceof cdk.CfnElement ? c : c.node.defaultChild) as cdk.CfnElement);
const roleId = (f: Fixture, role: iam.IRole) => logicalId(f, role as iam.Role);
const fnId = (f: Fixture, fn: lambda.IFunction) => logicalId(f, fn as lambda.Function);

/** 呼び出し元の組（このホップを呼ぶ相手） */
function callersOf(f: Fixture, hop: Hop): HopCaller[] {
  if (hop === f.front) return [f.origin];
  if (hop === f.leaf) return [f.front.asCaller(), f.origin];
  return [];
}

/** 呼び出し先の組（このchain用roleがJWTを発行できる相手）。open：目的の制限がないscope、bound：目的の制限があるscope */
function targetsOf(f: Fixture, caller: HopCaller): { hop: Hop; open: string[]; bound: { scope: string; purposes: string[] }[] }[] {
  if (caller.hopName === 'origin') {
    return [{ hop: f.front, open: ['front:call'], bound: [] }, { hop: f.leaf, open: [], bound: [{ scope: 'leaf:direct', purposes: ['p-a', 'p-b'] }] }];
  }
  if (caller.hopName === 'front') return [{ hop: f.leaf, open: ['leaf:read', 'leaf:list'], bound: [{ scope: 'leaf:write', purposes: ['p-a'] }] }];
  return [];
}

// --- チェック ---

/** 入口：Function URLはAWS_IAM。許可した呼び出し元の実行role以外はDenyし、許可もその実行roleだけに出す */
function checkEntry(f: Fixture, hop: Hop): string[] {
  const t = f.template;
  const problems: string[] = [];
  const url = t.Resources[logicalId(f, hop.url)];
  if (url?.Properties.AuthType !== 'AWS_IAM') problems.push(`${hop.hopName}: function URL auth type is ${url?.Properties.AuthType}`);

  const policy = t.Resources[logicalId(f, hop.node.findChild('EntryPolicy') as cdk.CfnElement)];
  if (!policy) return [...problems, `${hop.hopName}: no entry policy`];
  const fnArn = r(f, hop.fn.functionArn);
  const roles = callersOf(f, hop).map((c) => r(f, c.execRole.roleArn));
  const expected: Atom[] = atoms([
    { Effect: 'Deny', Principal: '*', Action: INVOKE, Resource: fnArn, Condition: { ArnNotEquals: { 'aws:PrincipalArn': roles } } },
    {
      Effect: 'Allow', Principal: { AWS: roles }, Action: 'lambda:InvokeFunctionUrl', Resource: fnArn,
      Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
    },
    {
      Effect: 'Allow', Principal: { AWS: roles }, Action: 'lambda:InvokeFunction', Resource: fnArn,
      Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
    },
  ]);
  if (canonical(policy.Properties.ResourceArn) !== canonical(fnArn)) problems.push(`${hop.hopName}: entry policy is not on the function`);
  return [...problems, ...diffAtoms(`${hop.hopName} entry`, atoms(policy.Properties.PolicyDocument.Statement), expected)];
}

/** 呼び出し元の実行role：このホップを、許可した呼び出し元の関数以外から呼ぶことをDenyする */
function checkCallerGuard(f: Fixture, hop: Hop): string[] {
  const fnArn = canonical(r(f, hop.fn.functionArn));
  return callersOf(f, hop).flatMap((c) => {
    const actual = atoms(roleStatements(f.template, roleId(f, c.execRole))).filter((a) => a.effect === 'Deny' && a.resource === fnArn);
    const expected = atoms([{
      Effect: 'Deny', Action: INVOKE, Resource: r(f, hop.fn.functionArn),
      Condition: { ArnNotEquals: { 'lambda:SourceFunctionArn': [r(f, c.fn.functionArn)] } },
    }]);
    return diffAtoms(`${c.hopName} -> ${hop.hopName} guard`, actual, expected);
  });
}

/**
 * JWTの発行：宛先はForAllValues＋Nullで呼び出し先だけ、ES384、300秒以下。付けられるtagはキーscopeだけで、値は宣言したscopeだけ。
 * 目的の制限があるscopeは、許した目的のリクエストでだけ付けられ、目的の制限がない文には混ざらない
 */
function checkIssuance(f: Fixture, caller: HopCaller): string[] {
  const issuing = (a: Atom) => ISSUE.includes(a.action) || a.action === '*' || a.action === 'sts:*';
  const actual = atoms(roleStatements(f.template, roleId(f, caller.chainRole))).filter(issuing);
  const expected = atoms(targetsOf(f, caller).flatMap(({ hop, open, bound }) => {
    const aud = { 'sts:IdentityTokenAudience': [hop.audience] };
    const notNull = { 'sts:IdentityTokenAudience': 'false' };
    const tag = (stringEquals: Record<string, unknown>) => ({
      Effect: 'Allow', Action: 'sts:TagGetWebIdentityToken', Resource: '*',
      Condition: { 'ForAllValues:StringEquals': { ...aud, 'aws:TagKeys': ['scope'] }, Null: notNull, StringEquals: stringEquals },
    });
    return [
      {
        Effect: 'Allow', Action: 'sts:GetWebIdentityToken', Resource: '*',
        Condition: {
          'ForAllValues:StringEquals': aud, Null: notNull,
          StringEquals: { 'sts:SigningAlgorithm': 'ES384' },
          NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
        },
      },
      ...(open.length ? [tag({ 'aws:RequestTag/scope': open })] : []),
      ...bound.map((b) => tag({ 'aws:RequestTag/scope': b.scope, [`aws:PrincipalTag/${PURPOSE_TAG}`]: b.purposes })),
    ];
  }));
  return diffAtoms(`${caller.hopName} issuance`, actual, expected);
}

/** chain用roleは、次のホップのchain用roleへのchainとJWTの発行のほかに、何の権限も持たない */
function checkChainRoleScope(f: Fixture, caller: HopCaller): string[] {
  const actual = atoms(roleStatements(f.template, roleId(f, caller.chainRole))).filter((a) => !ISSUE.includes(a.action));
  const expected = atoms(targetsOf(f, caller).filter((t) => t.hop.chainRole).map(({ hop }) => ({
    Effect: 'Allow', Action: CHAIN, Resource: r(f, hop.chainRole!.roleArn),
  })));
  return diffAtoms(`${caller.hopName} chain role`, actual, expected);
}

/** chain用roleの信頼：呼び出し元のchain用roleだけを、刻まれたリクエストIDのセッション名でだけ信頼し、新しいtagのキーは加えさせない */
function checkChainTrust(f: Fixture, hop: Hop): string[] {
  if (!hop.chainRole) return [];
  const doc = f.template.Resources[roleId(f, hop.chainRole)].Properties.AssumeRolePolicyDocument;
  const principals = callersOf(f, hop).map((c) => r(f, c.chainRole.roleArn));
  const expected = atoms([
    // セッション名は、bffが刻んだリクエストIDに限る（FR-6）
    {
      Effect: 'Allow', Principal: { AWS: principals }, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:RoleSessionName': `\${aws:PrincipalTag/${REQUEST_ID_TAG}}` } },
    },
    { Effect: 'Allow', Principal: { AWS: principals }, Action: 'sts:SetSourceIdentity' },
    {
      Effect: 'Allow', Principal: { AWS: principals }, Action: 'sts:TagSession',
      Condition: { 'ForAllValues:StringEquals': { 'aws:TagKeys': [PURPOSE_TAG, REQUEST_ID_TAG] } },
    },
  ]);
  return diffAtoms(`${hop.hopName} trust`, atoms(doc.Statement), expected);
}

/** 受信時の照合の設定：提供側の定義がそのまま渡る */
function checkProvides(f: Fixture, hop: Hop): string[] {
  const env = f.template.Resources[fnId(f, hop.fn)].Properties.Environment.Variables.AUTHZ_PROVIDES;
  const expected = r(f, f.stack.toJsonString(hop === f.front ? PROVIDES.front : PROVIDES.leaf));
  return canonical(env) === canonical(expected) ? [] : [`${hop.hopName} provides: ${canonical(env)}`];
}

/** `sub`の対応表：呼び出し元の実行roleごとに、JWTの`sub`になるべきchain用role */
function checkCallersMap(f: Fixture, hop: Hop): string[] {
  const env = f.template.Resources[fnId(f, hop.fn)].Properties.Environment.Variables.AUTHZ_CALLERS;
  const expected = r(f, f.stack.toJsonString(Object.fromEntries(
    callersOf(f, hop).map((c) => [c.execRole.roleName, { hop: c.hopName, sub: c.chainRole.roleArn }]),
  )));
  return canonical(env) === canonical(expected) ? [] : [`${hop.hopName} callers: ${canonical(env)}`];
}

const hops = (f: Fixture) => [f.front, f.leaf];
const callers = (f: Fixture) => [f.origin, f.front.asCaller()];
const checks: Record<string, (f: Fixture) => string[]> = {
  entry: (f) => hops(f).flatMap((h) => checkEntry(f, h)),
  callerGuard: (f) => hops(f).flatMap((h) => checkCallerGuard(f, h)),
  issuance: (f) => callers(f).flatMap((c) => checkIssuance(f, c)),
  chainRoleScope: (f) => callers(f).flatMap((c) => checkChainRoleScope(f, c)),
  chainTrust: (f) => hops(f).flatMap((h) => checkChainTrust(f, h)),
  callersMap: (f) => hops(f).flatMap((h) => checkCallersMap(f, h)),
  provides: (f) => hops(f).flatMap((h) => checkProvides(f, h)),
};

describe('Hopのテンプレート', () => {
  it('入口：Function URLはAWS_IAMで、許可した呼び出し元の実行role以外をDenyする', () => {
    expect(checks.entry(fixture)).toEqual([]);
  });

  it('呼び出し元の実行role：許可した呼び出し元の関数以外からの呼び出しをDenyする', () => {
    expect(checks.callerGuard(fixture)).toEqual([]);
  });

  it('JWTの発行：宛先（ForAllValues＋Null）、ES384、300秒以下、scopeのキーと値、目的の制限があるscopeの目的を限る', () => {
    expect(checks.issuance(fixture)).toEqual([]);
  });

  it('chain用role：次のchain用roleへのchainとJWTの発行のほかに権限を持たない', () => {
    expect(checks.chainRoleScope(fixture)).toEqual([]);
  });

  it('chain用roleの信頼：呼び出し元のchain用roleだけを、リクエストIDのセッション名でだけ信頼し、tagのキーはpurposeとrequestIdだけ', () => {
    expect(checks.chainTrust(fixture)).toEqual([]);
  });

  it('subの対応表：呼び出し元の実行roleごとに、そのchain用roleを対応させる', () => {
    expect(checks.callersMap(fixture)).toEqual([]);
  });

  it('受信時の照合の設定：提供側の定義を渡す', () => {
    expect(checks.provides(fixture)).toEqual([]);
  });

  it('同じ組を2回つなぐと失敗する', () => {
    const f = buildFixture();
    expect(() => f.leaf.allowCaller(f.front.asCaller(), [{ scope: 'leaf:read' }])).toThrow(/already allowed/);
  });

  it('呼び出し先を持たないホップはchain用roleを持たない', () => {
    expect(fixture.leaf.chainRole).toBeUndefined();
    expect(fixture.template.Resources[fnId(fixture, fixture.leaf.fn)].Properties.Environment.Variables.AUTHZ_CHAIN_ROLE).toBeUndefined();
  });
});

// --- 条件を壊したテンプレート ---

const OTHER_ROLE = 'arn:aws:iam::111111111111:role/other';

/** objの中で、条件のキーfromをtoに付け替える */
function renameKeyDeep(obj: Json, from: string, to: string): void {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    renameKeyDeep(obj[k], from, to);
    if (k === from) {
      obj[to] = obj[k];
      delete obj[k];
    }
  }
}

/** objの中の、valueと等しい部分をreplacementに置き換える */
function replaceDeep(obj: Json, value: Json, replacement: Json): Json {
  if (canonical(obj) === canonical(value)) return structuredClone(replacement);
  if (Array.isArray(obj)) return obj.map((x) => replaceDeep(x, value, replacement));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, replaceDeep(v, value, replacement)]));
  return obj;
}

const entryPolicy = (f: Fixture, t: Json, hop: Hop) => t.Resources[logicalId(f, hop.node.findChild('EntryPolicy') as cdk.CfnElement)].Properties.PolicyDocument;
const chainPolicies = (f: Fixture, t: Json, role: iam.IRole) => Object.values<Json>(t.Resources)
  .filter((x) => x.Type === 'AWS::IAM::Policy' && x.Properties.Roles.some((y: Json) => y.Ref === roleId(f, role)))
  .map((x) => x.Properties.PolicyDocument);
const issuanceStatements = (f: Fixture, t: Json, role: iam.IRole) =>
  chainPolicies(f, t, role).flatMap((d) => d.Statement).filter((s: Json) => list(s.Action).some((a) => ISSUE.includes(a)));
const list = (v: Json): Json[] => (Array.isArray(v) ? v : [v]);

const mutations: { name: string; check: keyof typeof checks; mutate: (f: Fixture, t: Json) => void }[] = [
  {
    name: '入口のDenyを消す', check: 'entry',
    mutate: (f, t) => { const d = entryPolicy(f, t, f.leaf); d.Statement = d.Statement.filter((s: Json) => s.Effect !== 'Deny'); },
  },
  {
    name: '入口のDenyの例外にほかの主体を加える', check: 'entry',
    mutate: (f, t) => { const s = entryPolicy(f, t, f.leaf).Statement.find((x: Json) => x.Effect === 'Deny'); s.Condition.ArnNotEquals['aws:PrincipalArn'].push(OTHER_ROLE); },
  },
  {
    name: '入口の許可にほかの主体を加える', check: 'entry',
    mutate: (f, t) => { const s = entryPolicy(f, t, f.front).Statement.find((x: Json) => x.Sid === 'AllowUrl'); s.Principal.AWS = [...list(s.Principal.AWS), OTHER_ROLE]; },
  },
  {
    name: 'Function URLの認証の条件を外す', check: 'entry',
    mutate: (f, t) => { delete entryPolicy(f, t, f.front).Statement.find((x: Json) => x.Sid === 'AllowUrl').Condition; },
  },
  {
    name: 'Function URLをNONEにする', check: 'entry',
    mutate: (f, t) => { t.Resources[logicalId(f, f.leaf.url)].Properties.AuthType = 'NONE'; },
  },
  {
    name: '呼び出し元の実行roleのDenyを消す', check: 'callerGuard',
    mutate: (_f, t) => {
      for (const [id, x] of Object.entries<Json>(t.Resources)) {
        if (x.Type === 'AWS::IAM::Policy' && x.Properties.PolicyDocument.Statement.some((s: Json) => s.Effect === 'Deny')) delete t.Resources[id];
      }
    },
  },
  {
    name: '呼び出し元の実行roleのDenyの例外を広げる', check: 'callerGuard',
    mutate: (_f, t) => {
      for (const x of Object.values<Json>(t.Resources)) {
        if (x.Type !== 'AWS::IAM::Policy') continue;
        for (const s of x.Properties.PolicyDocument.Statement) {
          if (s.Effect === 'Deny') s.Condition = { ArnNotLike: { 'lambda:SourceFunctionArn': 'arn:aws:lambda:*' } };
        }
      }
    },
  },
  {
    name: '宛先をForAnyValueにする', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.origin.chainRole).forEach((s: Json) => renameKeyDeep(s.Condition, 'ForAllValues:StringEquals', 'ForAnyValue:StringEquals')),
  },
  {
    name: '宛先のNullの条件を外す', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => { delete s.Condition.Null; }),
  },
  {
    name: 'tagのキーの制限を外す', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => { delete s.Condition['ForAllValues:StringEquals']?.['aws:TagKeys']; }),
  },
  {
    name: 'scopeの値を変える', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => {
      if (s.Condition.StringEquals['aws:RequestTag/scope']) s.Condition.StringEquals['aws:RequestTag/scope'] = 'leaf:write';
    }),
  },
  {
    name: '目的の制限があるscopeから目的の条件を外す', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => { delete s.Condition.StringEquals?.[`aws:PrincipalTag/${PURPOSE_TAG}`]; }),
  },
  {
    name: '目的の制限があるscopeに目的を加える', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => {
      const k = `aws:PrincipalTag/${PURPOSE_TAG}`;
      if (s.Condition.StringEquals?.[k]) s.Condition.StringEquals[k] = [...list(s.Condition.StringEquals[k]), 'p-b'];
    }),
  },
  {
    name: '目的の制限があるscopeを制限のない文に混ぜる', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => {
      const v = s.Condition.StringEquals?.['aws:RequestTag/scope'];
      if (Array.isArray(v)) s.Condition.StringEquals['aws:RequestTag/scope'] = [...v, 'leaf:write'];
    }),
  },
  {
    name: '有効期間の上限を外す', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => { delete s.Condition.NumericLessThanEquals; }),
  },
  {
    name: '署名のアルゴリズムの条件を外す', check: 'issuance',
    mutate: (f, t) => issuanceStatements(f, t, f.front.chainRole!).forEach((s: Json) => { delete s.Condition.StringEquals?.['sts:SigningAlgorithm']; }),
  },
  {
    name: 'chain用roleに条件のない発行の許可を足す', check: 'issuance',
    mutate: (f, t) => { chainPolicies(f, t, f.front.chainRole!)[0].Statement.push({ Effect: 'Allow', Action: 'sts:GetWebIdentityToken', Resource: '*' }); },
  },
  {
    name: 'chain用roleにホップの呼び出しの権限を足す', check: 'chainRoleScope',
    mutate: (f, t) => { chainPolicies(f, t, f.front.chainRole!)[0].Statement.push({ Effect: 'Allow', Action: 'lambda:InvokeFunctionUrl', Resource: '*' }); },
  },
  {
    name: '信頼でtagのキーの制限を外す', check: 'chainTrust',
    mutate: (f, t) => {
      for (const s of t.Resources[roleId(f, f.front.chainRole!)].Properties.AssumeRolePolicyDocument.Statement) delete s.Condition;
    },
  },
  {
    name: '信頼にほかの主体を加える', check: 'chainTrust',
    mutate: (f, t) => {
      const s = t.Resources[roleId(f, f.front.chainRole!)].Properties.AssumeRolePolicyDocument.Statement[0];
      s.Principal.AWS = [...list(s.Principal.AWS), OTHER_ROLE];
    },
  },
  {
    name: 'subを別のroleにする', check: 'callersMap',
    mutate: (f, t) => {
      const vars = t.Resources[fnId(f, f.leaf.fn)].Properties.Environment.Variables;
      vars.AUTHZ_CALLERS = replaceDeep(vars.AUTHZ_CALLERS, r(f, f.front.chainRole!.roleArn), OTHER_ROLE);
    },
  },
  {
    name: '受信時の照合の設定から目的の制限を外す', check: 'provides',
    mutate: (f, t) => {
      const vars = t.Resources[fnId(f, f.leaf.fn)].Properties.Environment.Variables;
      vars.AUTHZ_PROVIDES = replaceDeep(vars.AUTHZ_PROVIDES, r(f, f.stack.toJsonString(PROVIDES.leaf)), JSON.stringify({ ...PROVIDES.leaf, 'leaf:write': {} }));
    },
  },
  {
    name: 'subの対応表を空にする', check: 'callersMap',
    mutate: (f, t) => { t.Resources[fnId(f, f.front.fn)].Properties.Environment.Variables.AUTHZ_CALLERS = '{}'; },
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
