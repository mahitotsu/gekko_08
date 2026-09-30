import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminCreateUserCommand, AdminInitiateAuthCommand, AdminSetUserPasswordCommand, AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient, DescribeUserPoolClientCommand, UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
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

export const DEMO_USERS = { yamada: 'tokyo', tanaka: 'osaka' } as const;
export type DemoUser = keyof typeof DEMO_USERS;

/**
 * デモユーザーでログインし、IDトークンとリフレッシュトークンを得る。
 * マネージドログインはブラウザが必要なので、テストではADMIN_USER_PASSWORD_AUTHで代える。
 */
export async function loginTokens(user: DemoUser): Promise<{ idToken: string; refreshToken: string }> {
  const o = await stackOutputs();
  const UserPoolId = o.UserPoolId;
  const ClientId = o.UserPoolClientId;
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId, Username: user, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'custom:branch', Value: DEMO_USERS[user] }],
    }));
  } catch (e) {
    if (!(e instanceof UsernameExistsException)) throw e;
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId, Username: user, UserAttributes: [{ Name: 'custom:branch', Value: DEMO_USERS[user] }],
    }));
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
      username: user, branch: DEMO_USERS[user], idToken, idTokenExp: claims.exp, refreshToken,
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

/** 漏れたchainのセッションに相当する、ユーザーの属性を持つfederated roleのセッションを得る */
export async function federatedSession(user: DemoUser, sessionName = `test-${Date.now()}`): Promise<AwsCredentialIdentity> {
  const o = await stackOutputs();
  const { idToken } = await loginTokens(user);
  const { Credentials: c } = await sts.send(new AssumeRoleWithWebIdentityCommand({
    RoleArn: o.FederatedRoleArn, RoleSessionName: sessionName, WebIdentityToken: idToken, DurationSeconds: 900,
  }));
  return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
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
