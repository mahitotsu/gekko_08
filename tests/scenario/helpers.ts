import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand, paginateListStackResources } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient, paginateFilterLogEvents } from '@aws-sdk/client-cloudwatch-logs';
import {
  AdminCreateUserCommand, AdminInitiateAuthCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, DescribeUserPoolClientCommand, UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, GetWebIdentityTokenCommand, STSClient, type Tag } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { AwsCredentialIdentity } from '@smithy/types';
import { SignatureV4 } from '@smithy/signature-v4';

export const STACK = process.env.STACK_NAME ?? 'Gekko08App';
const cognito = new CognitoIdentityProviderClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sts = new STSClient({});

export type Outputs = Record<string, string>;

let outputs: Promise<Outputs> | undefined;
export function stackOutputs(): Promise<Outputs> {
  outputs ??= (async () => {
    const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK }));
    return Object.fromEntries((Stacks![0].Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
  })();
  return outputs;
}

/** デモユーザーの人事データ（DemoDataの初期値） */
export const DEMO_USERS = { yamada: { branch: 'tokyo', title: '支店長' }, tanaka: { branch: 'osaka', title: '担当者' } } as const;
export type DemoUser = keyof typeof DEMO_USERS;

/**
 * デモユーザーでログインし、IDトークンとリフレッシュトークンを得る。
 * マネージドログインはブラウザが必要なので、テストではADMIN_USER_PASSWORD_AUTHで代える。
 */
export async function loginTokens(user: DemoUser): Promise<{ idToken: string; refreshToken: string }> {
  const o = await stackOutputs();
  const UserPoolId = o.UserPoolId;
  const ClientId = o.UserPoolClientId;
  // Cognitoはユーザーの識別だけを持つ。所属と役職は人事データ（属性サービス）にある
  try {
    await cognito.send(new AdminCreateUserCommand({ UserPoolId, Username: user, MessageAction: 'SUPPRESS' }));
  } catch (e) {
    if (!(e instanceof UsernameExistsException)) throw e;
  }
  // 毎回ランダムなパスワードに置き換える。テストの外にパスワードを残さない
  const password = `${randomBytes(18).toString('base64url')}aA1!`;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: user, Password: password, Permanent: true }));
  const { UserPoolClient } = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId, ClientId }));
  const secretHash = createHmac('sha256', UserPoolClient!.ClientSecret!).update(user + ClientId).digest('base64');
  const r = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId, ClientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: user, PASSWORD: password, SECRET_HASH: secretHash },
  }));
  return { idToken: r.AuthenticationResult!.IdToken!, refreshToken: r.AuthenticationResult!.RefreshToken! };
}

/** bffの`/api/callback`が行うのと同じ形でセッションを作り、セッションcookieを返す */
export async function loginSession(user: DemoUser): Promise<string> {
  const o = await stackOutputs();
  const { idToken, refreshToken } = await loginTokens(user);
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
  const sid = randomBytes(32).toString('base64url');
  await db.send(new PutCommand({
    TableName: o.SessionsTable,
    Item: {
      pk: `sid#${createHash('sha256').update(sid).digest('base64url')}`,
      username: user, idToken, idTokenExp: claims.exp, refreshToken,
      ttl: Math.floor(Date.now() / 1000) + 3600,
    },
  }));
  return `__Host-sid=${sid}`;
}

/** ブラウザと同じ経路（CloudFront）でbffを呼ぶ */
export async function browserGet(path: string, cookie?: string, headers: Record<string, string> = {}) {
  const o = await stackOutputs();
  const res = await fetch(`${o.WebUrl}${path}`, { headers: { ...(cookie ? { cookie } : {}), ...headers }, redirect: 'manual' });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* 文字列のまま */ }
  return { status: res.status, headers: res.headers, text, body };
}

/** ブラウザと同じ経路（CloudFront）でbffにPOSTする。OACの要件で本文のSHA-256を付ける */
export async function browserPost(path: string, body: string, cookie?: string) {
  const o = await stackOutputs();
  const res = await fetch(`${o.WebUrl}${path}`, {
    method: 'POST', body, redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'), ...(cookie ? { cookie } : {}) },
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* 文字列のまま */ }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

/** 漏れたchainのセッションに相当する、ユーザーの属性を持つfederated roleのセッションを得る */
export async function federatedSession(user: DemoUser, sessionName = `test-${Date.now()}`): Promise<AwsCredentialIdentity> {
  const o = await stackOutputs();
  const { idToken } = await loginTokens(user);
  const { Credentials: c } = await sts.send(new AssumeRoleWithWebIdentityCommand({
    RoleArn: o.FederatedRoleArn, RoleSessionName: sessionName, WebIdentityToken: idToken, DurationSeconds: 900,
  }));
  return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
}

/** bffと同じ手順で、取引の目的を刻んだセッションを得る。漏れた「受け渡すセッション」に相当する */
export async function purposeSession(user: DemoUser, purpose: string, extraTags: Tag[] = []): Promise<AwsCredentialIdentity> {
  const o = await stackOutputs();
  const fed = await federatedSession(user);
  const { Credentials: c } = await new STSClient({ credentials: fed }).send(new AssumeRoleCommand({
    RoleArn: o.PurposeRoleArn, RoleSessionName: `test-${Date.now()}`, DurationSeconds: 900,
    Tags: [{ Key: 'purpose', Value: purpose }, ...extraTags], TransitiveTagKeys: ['purpose'],
  }));
  return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
}

/** セッションからchain用roleへchainする */
export async function chainTo(from: AwsCredentialIdentity, roleArn: string, extra: { SourceIdentity?: string; Tags?: Tag[] } = {}): Promise<AwsCredentialIdentity> {
  const { Credentials: c } = await new STSClient({ credentials: from }).send(new AssumeRoleCommand({
    RoleArn: roleArn, RoleSessionName: `test-${Date.now()}`, DurationSeconds: 900, ...extra,
  }));
  return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
}

/** セッションでJWTを発行する。scopeを渡すと、JWTのrequest_tagsに付ける */
export async function mintJwt(credentials: AwsCredentialIdentity, audience: string | string[], scope?: string, durationSeconds = 300): Promise<string> {
  const r = await new STSClient({ credentials }).send(new GetWebIdentityTokenCommand({
    Audience: Array.isArray(audience) ? audience : [audience], SigningAlgorithm: 'ES384', DurationSeconds: durationSeconds,
    Tags: scope ? [{ Key: 'scope', Value: scope }] : undefined,
  }));
  return r.WebIdentityToken!;
}

/** 人事データでユーザーの所属を変える（異動） */
export async function setStaffBranch(user: DemoUser, branch: string): Promise<void> {
  const o = await stackOutputs();
  await db.send(new UpdateCommand({
    TableName: o.StaffTable, Key: { userId: user }, UpdateExpression: 'SET branch = :b', ExpressionAttributeValues: { ':b': branch },
  }));
}

/** 任意の認証情報でSigV4署名し、ホップのFunction URLを直接呼ぶ */
export async function signedPost(url: string, body: unknown, headers: Record<string, string>, credentials?: AwsCredentialIdentity) {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  const signer = new SignatureV4({ service: 'lambda', region: process.env.AWS_REGION ?? 'ap-northeast-1', credentials: credentials ?? defaultProvider(), sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST', protocol: u.protocol, hostname: u.hostname, path: u.pathname, body: payload,
    headers: { host: u.host, 'content-type': 'application/json', 'x-request-id': `test-${Date.now()}`, ...headers },
  });
  const res = await fetch(u, { method: 'POST', headers: signed.headers, body: payload });
  return { status: res.status, text: await res.text() };
}

const HOP_LOG_GROUPS = {
  bff: 'BffFunctionLogs',
  'case-service': 'CaseServiceFunctionLogs',
  'account-service': 'AccountServiceFunctionLogs',
  'fraud-agent': 'FraudAgentFunctionLogs',
  'fraud-mcp': 'FraudMcpFunctionLogs',
  'entitlement-service': 'EntitlementServiceFunctionLogs',
} as const;
export type HopName = keyof typeof HOP_LOG_GROUPS;

let logGroups: Promise<Record<HopName, string>> | undefined;
/** 各ホップのロググループ名。論理IDの接頭辞でスタックのリソースから探す */
export function hopLogGroups(): Promise<Record<HopName, string>> {
  logGroups ??= (async () => {
    const found: Partial<Record<HopName, string>> = {};
    for await (const page of paginateListStackResources({ client: new CloudFormationClient({}) }, { StackName: STACK })) {
      for (const r of page.StackResourceSummaries ?? []) {
        for (const [hop, prefix] of Object.entries(HOP_LOG_GROUPS)) {
          if (r.ResourceType === 'AWS::Logs::LogGroup' && r.LogicalResourceId!.startsWith(prefix)) found[hop as HopName] = r.PhysicalResourceId!;
        }
      }
    }
    for (const hop of Object.keys(HOP_LOG_GROUPS)) if (!found[hop as HopName]) throw new Error(`log group for ${hop} not found`);
    return found as Record<HopName, string>;
  })();
  return logGroups;
}

const logs = new CloudWatchLogsClient({});

/** ロググループのイベントを、開始時刻以降・パターンで絞って読む */
export async function readLogs(group: string, startTime: number, filterPattern?: string): Promise<string[]> {
  const out: string[] = [];
  for await (const page of paginateFilterLogEvents({ client: logs }, { logGroupName: group, startTime, filterPattern })) {
    for (const e of page.events ?? []) out.push(e.message!);
  }
  return out;
}

/** 条件を満たすまで繰り返す。ログやCloudTrailの到着を待つのに使う */
export async function eventually<T>(f: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 共通部品とbffが出す、1回のリクエストの処理結果のログ */
export interface HandledLog {
  hop: string;
  requestId: string;
  /** ログを出したときのスパンのトレースID */
  traceId?: string;
  status: number;
  /** 呼び出し元のホップ名 */
  actor?: string;
  /** 呼び出し元の実行role名 */
  actorRole?: string;
  tokenSub?: string;
  subject?: { id: string };
  purpose?: string;
  scope?: string;
  user?: string;
  route?: string;
  timings: Record<string, number>;
}

/** 各ホップの`handled`ログのうち、指定したリクエストIDのものを、すべてのホップに揃うまで待って返す */
export async function handledLogs(requestIds: string[], hops: HopName[], startTime: number): Promise<Record<string, Partial<Record<HopName, HandledLog>>>> {
  const groups = await hopLogGroups();
  const byId: Record<string, Partial<Record<HopName, HandledLog>>> = Object.fromEntries(requestIds.map((id) => [id, {}]));
  return eventually(async () => {
    for (const hop of hops) {
      for (const m of await readLogs(groups[hop], startTime, '{ $.message = "handled" }')) {
        // Lambdaのtext形式のログは、時刻などの接頭辞の後ろにJSONが続く
        const l = JSON.parse(m.slice(m.indexOf('{'))) as HandledLog;
        if (byId[l.requestId]) byId[l.requestId][hop] = l;
      }
    }
    return requestIds.every((id) => hops.every((h) => byId[id][h])) ? byId : undefined;
  }, 90_000, 5000);
}

/** CloudWatch Transaction Searchのスパン（ロググループ`aws/spans`の1件） */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  attributes: Record<string, unknown>;
  resource: { attributes: Record<string, unknown> };
  status?: { code: string };
}

/** トレースのスパンを、expectedの数だけ揃うまで待って返す。スパンの到着には数十秒〜数分かかる */
export async function traceSpans(traceId: string, startTime: number, ready: (spans: SpanRecord[]) => boolean): Promise<SpanRecord[]> {
  return eventually(async () => {
    const spans = (await readLogs('aws/spans', startTime, `{ $.traceId = "${traceId}" }`)).map((m) => JSON.parse(m) as SpanRecord);
    return ready(spans) ? spans : undefined;
  }, 300_000, 10_000);
}
