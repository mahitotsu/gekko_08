import { writeFileSync } from 'node:fs';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { AwsCredentialIdentity } from '@smithy/types';
import { SignatureV4 } from '@smithy/signature-v4';

// 各呼び出しを3回ずつ行い、Function URLの応答のステータスを記録する
const region = process.env.AWS_REGION!;
const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'Gekko08ExpSourceFunctionArn' }));
const o = Object.fromEntries(Stacks![0].Outputs!.map((x) => [x.OutputKey!, x.OutputValue!]));
const targets = { C1: o.ReceiverC1Url, C2: o.ReceiverC2Url };
const lambda = new LambdaClient({});

async function invoke(fn: string, payload: unknown) {
  const r = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(payload)) }));
  return JSON.parse(Buffer.from(r.Payload!).toString());
}
async function callFromHere(credentials: AwsCredentialIdentity | (() => Promise<AwsCredentialIdentity>)) {
  const signer = new SignatureV4({ service: 'lambda', region, credentials, sha256: Sha256 });
  const out: Record<string, number> = {};
  for (const [name, target] of Object.entries(targets)) {
    const url = new URL(target);
    const req = await signer.sign({ method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers: { host: url.host }, body: '{}' });
    out[name] = (await fetch(url, { method: 'POST', headers: req.headers, body: '{}' })).status;
  }
  return out;
}

const results: Record<string, Record<string, number>[]> = { 'B（許可した関数）': [], 'B2（同じ実行roleの別の関数）': [], 'Bの実行roleの認証情報を手元から': [], '手元の主体（広い権限）': [] };
for (let i = 0; i < 3; i++) {
  results['B（許可した関数）'].push(await invoke(o.CallerBName, { targets }));
  results['B2（同じ実行roleの別の関数）'].push(await invoke(o.CallerB2Name, { targets }));
  const leaked = await invoke(o.CallerBName, { dump: true });
  results['Bの実行roleの認証情報を手元から'].push(await callFromHere(leaked));
  results['手元の主体（広い権限）'].push(await callFromHere(defaultProvider()));
}
for (const [k, v] of Object.entries(results)) console.log(k.padEnd(28), JSON.stringify(v));
writeFileSync(new URL('../out-results.json', import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
