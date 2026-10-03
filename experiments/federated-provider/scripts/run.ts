import { writeFileSync } from 'node:fs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { loginTokens } from '../../../tests/scenario/helpers';
import { AUD } from '../lib/stack';

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken: string };
const creds = (c: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string }): Creds =>
  ({ accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! });

const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'Gekko08ExpFederatedProvider' }));
const out = Object.fromEntries((Stacks![0].Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));

/** JWTを発行し、`https://sts.amazonaws.com/`の下のクレームを返す */
async function claims(c: Creds) {
  const r = await new STSClient({ credentials: c }).send(new GetWebIdentityTokenCommand({ Audience: [AUD], SigningAlgorithm: 'ES384', DurationSeconds: 300 }));
  return JSON.parse(Buffer.from(r.WebIdentityToken!.split('.')[1], 'base64url').toString())['https://sts.amazonaws.com/'];
}

// テスト専用のユーザーでログインし、検証用のfederated roleを引き受ける（bffと同じ手順）
const { idToken } = await loginTokens('tokyoManager');
const { Credentials: f } = await new STSClient({}).send(new AssumeRoleWithWebIdentityCommand({
  RoleArn: out.FederatedRoleArn, RoleSessionName: `exp-${Date.now()}`, WebIdentityToken: idToken, DurationSeconds: 900,
}));
const federated = creds(f!);
const federatedClaims = await claims(federated);

const results: Record<string, unknown>[] = [];
for (const v of ['V0', 'V1', 'V2', 'V3', 'V4', 'V5']) {
  try {
    const { Credentials: t } = await new STSClient({ credentials: federated }).send(new AssumeRoleCommand({
      RoleArn: out[`${v}RoleArn`], RoleSessionName: `exp-${v}`, DurationSeconds: 900,
    }));
    const c = await claims(creds(t!));
    results.push({ variant: v, assumed: true, federated_provider: c.federated_provider ?? null, source_identity: c.source_identity });
  } catch (e) {
    results.push({ variant: v, assumed: false, error: `${(e as Error).name}: ${(e as Error).message.slice(0, 120)}` });
  }
}

const report = {
  providerArn: out.ProviderArn, issuer: out.Issuer,
  federatedSession: { federated_provider: federatedClaims.federated_provider ?? null, keys: Object.keys(federatedClaims).sort() },
  variants: results,
};
writeFileSync(new URL('../out-results.json', import.meta.url), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
