import { writeFileSync } from 'node:fs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { AssumeRoleCommand, GetWebIdentityTokenCommand, STSClient, type Tag } from '@aws-sdk/client-sts';
import { AUD_A, AUD_B } from '../lib/scope-tags-stack';

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken: string };

const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'Gekko08ExpScopeTags' }));
const out = Object.fromEntries((Stacks![0].Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));

const sts = (credentials?: Creds) => new STSClient({ credentials });
async function assume(from: Creds | undefined, roleArn: string, extra: { SourceIdentity?: string; Tags?: Tag[]; TransitiveTagKeys?: string[] } = {}): Promise<Creds> {
  const { Credentials: c } = await sts(from).send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `exp-${Date.now()}`, DurationSeconds: 900, ...extra }));
  return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
}
async function mint(creds: Creds, audience: string[], opts: { alg?: string; duration?: number; tags?: Tag[] } = {}) {
  const r = await sts(creds).send(new GetWebIdentityTokenCommand({
    Audience: audience, SigningAlgorithm: opts.alg ?? 'ES384', DurationSeconds: opts.duration ?? 300, Tags: opts.tags,
  }));
  const claims = JSON.parse(Buffer.from(r.WebIdentityToken!.split('.')[1], 'base64url').toString());
  return { aud: claims.aud, ...claims['https://sts.amazonaws.com/'] };
}

const results: { id: string; expect: 'ok' | 'denied'; outcome: string; pass: boolean; detail?: unknown }[] = [];
async function check(id: string, expect: 'ok' | 'denied', f: () => Promise<unknown>) {
  try {
    const detail = await f();
    results.push({ id, expect, outcome: 'ok', pass: expect === 'ok', detail });
  } catch (e) {
    const err = e as Error;
    results.push({ id, expect, outcome: `${err.name}: ${err.message.slice(0, 160)}`, pass: expect === 'denied' });
  }
}
const scope = (v: string): Tag[] => [{ Key: 'scope', Value: v }];

// E0: JWTの発行条件
const r0 = await assume(undefined, out.E0RoleArn);
await check('E0-1 ES384・300秒', 'ok', () => mint(r0, [AUD_A]));
await check('E0-2 RS256', 'denied', () => mint(r0, [AUD_A], { alg: 'RS256' }));
await check('E0-3 有効期間900秒', 'denied', () => mint(r0, [AUD_A], { duration: 900 }));
await check('E0-4 ForAllValues：許した宛先と外部の宛先を混ぜる', 'denied', () => mint(r0, [AUD_A, 'https://external.example']));

// E1（形A）: 宛先ごとのrequest_tags
const ra = await assume(undefined, out.E1RoleArn);
await check('E1-1 case宛てにscope=case:summary', 'ok', () => mint(ra, [AUD_A], { tags: scope('case:summary') }));
await check('E1-2 case宛てにscope=account:read', 'denied', () => mint(ra, [AUD_A], { tags: scope('account:read') }));
await check('E1-3 account宛てにscope=account:read', 'ok', () => mint(ra, [AUD_B], { tags: scope('account:read') }));
await check('E1-4 case宛てにscopeと別のキー', 'denied', () => mint(ra, [AUD_A], { tags: [...scope('case:summary'), { Key: 'admin', Value: 'true' }] }));
await check('E1-5 caseとaccountの両方宛てにscope=case:summary', 'denied', () => mint(ra, [AUD_A, AUD_B], { tags: scope('case:summary') }));
await check('E1-6 tagなし（scopeのないJWT）', 'ok', () => mint(ra, [AUD_A]));
// 対照：本体と同じForAnyValueでは、許していない宛先を混ぜられるか
await check('E1-7 ForAnyValue：許した宛先と外部の宛先を混ぜる（穴の確認）', 'denied', () => mint(ra, [AUD_A, 'https://external.example']));

// E2（形B）: 取引の目的をtransitive session tagで運ぶ
const u = await assume(undefined, out.UserRoleArn, { SourceIdentity: 'yamada', Tags: [{ Key: 'branch', Value: 'tokyo' }], TransitiveTagKeys: ['branch'] });
const purpose = (value: string, extraTags: Tag[] = []) =>
  assume(u, out.PurposeRoleArn, { Tags: [{ Key: 'purpose', Value: value }, ...extraTags], TransitiveTagKeys: ['purpose'] });
await check('E2-1 目的=agent-analysisを刻む', 'ok', () => purpose('agent-analysis').then(() => 'assumed'));
await check('E2-2 定めていない目的=admin', 'denied', () => purpose('admin'));
await check('E2-3 目的と別のキーを刻む', 'denied', () => purpose('agent-analysis', [{ Key: 'role', Value: 'admin' }]));

const timings: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await purpose('agent-analysis');
  timings.push(Math.round(performance.now() - t0));
}
const pAgent = await purpose('agent-analysis');
const cAgent = await assume(pAgent, out.ChainRoleArn);
await check('E2-4 下流のJWTにsource_identity・branch・purposeが入る', 'ok', () => mint(cAgent, [AUD_A]));
await check('E2-5 下流で目的を上書きする', 'denied', () => assume(pAgent, out.ChainRoleArn, { Tags: [{ Key: 'purpose', Value: 'case-summary' }] }));
await check('E2-6 目的=agent-analysisではaccount宛てのJWTを発行できない', 'denied', () => mint(cAgent, [AUD_B]));
const cSummary = await assume(await purpose('case-summary'), out.ChainRoleArn);
await check('E2-7 目的=case-summaryならaccount宛てのJWTを発行できる', 'ok', () => mint(cSummary, [AUD_B]));

// E3: 形Aと形Bの組み合わせ
await check('E3-1 下流でcase宛てにscope=case:read', 'ok', () => mint(cAgent, [AUD_A], { tags: scope('case:read') }));
await check('E3-2 下流でcase宛てにscope=case:summary', 'denied', () => mint(cAgent, [AUD_A], { tags: scope('case:summary') }));

// E4: 目的ごとのscope
const c4 = async (value: string) => assume(await purpose(value), out.Chain4RoleArn);
const c4Summary = await c4('case-summary');
const c4Unfreeze = await c4('account-unfreeze');
const c4Agent = await c4('agent-analysis');
await check('E4-1 目的=case-summaryでaccount宛てにscope=account:read', 'ok', () => mint(c4Summary, [AUD_B], { tags: scope('account:read') }));
await check('E4-2 目的=case-summaryでaccount宛てにscope=account:unfreeze', 'denied', () => mint(c4Summary, [AUD_B], { tags: scope('account:unfreeze') }));
await check('E4-3 目的=account-unfreezeでaccount宛てにscope=account:unfreeze', 'ok', () => mint(c4Unfreeze, [AUD_B], { tags: scope('account:unfreeze') }));
await check('E4-4 目的=account-unfreezeでaccount宛てにscope=account:read', 'denied', () => mint(c4Unfreeze, [AUD_B], { tags: scope('account:read') }));
await check('E4-5 目的=agent-analysisでaccount宛てにscope=account:read', 'denied', () => mint(c4Agent, [AUD_B], { tags: scope('account:read') }));
await check('E4-6 目的=agent-analysisでaccount宛てにscope=account:unfreeze', 'denied', () => mint(c4Agent, [AUD_B], { tags: scope('account:unfreeze') }));
await check('E4-7 目的=case-summaryでaccount宛てにscopeを2つ（一覧）', 'denied', () => mint(c4Summary, [AUD_B], { tags: scope('account:read account:unfreeze') }));
await check('E4-8 tagの値に空白（scope=case:read case:propose）', 'ok', () => mint(c4Agent, [AUD_A], { tags: scope('case:read case:propose') }));

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  expect=${r.expect}  ${r.outcome}${r.detail && typeof r.detail === 'object' ? `  ${JSON.stringify(r.detail)}` : ''}`);
const sorted = [...timings].sort((a, b) => a - b);
console.log(`目的を刻むchain（ウォーム10回）: median ${sorted[5]}ms, max ${sorted[9]}ms, all ${JSON.stringify(timings)}`);
writeFileSync('out-results.json', JSON.stringify({ at: new Date().toISOString(), results, purposeChainMs: timings }, null, 2));
