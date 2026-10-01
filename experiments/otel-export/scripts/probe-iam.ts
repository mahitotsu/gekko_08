import { randomBytes } from 'node:crypto';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { SignatureV4 } from '@smithy/signature-v4';

// 1つのアクションだけを持つroleで、トレースとメトリクスの受け口にOTLP（JSON）を1件ずつ送り、応答を見る
const region = process.env.AWS_REGION!;
const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'Gekko08ExpOtelExport' }));
const roles = Stacks![0].Outputs!.filter((o) => o.OutputKey!.startsWith('Probe')).map((o) => [o.OutputKey!.replace(/^Probe|Role$/g, ''), o.OutputValue!] as const);

const now = () => String(BigInt(Date.now()) * 1_000_000n);
const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'gekko08-exp-probe' } }] };
const traces = () => JSON.stringify({ resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'probe' }, spans: [{
  traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), name: 'probe', kind: 1, startTimeUnixNano: now(), endTimeUnixNano: now(),
}] }] }] });
const metrics = () => JSON.stringify({ resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'probe' }, metrics: [{
  name: 'gekko08_exp_probe', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ asInt: '1', startTimeUnixNano: now(), timeUnixNano: now() }] },
}] }] }] });

async function post(credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }, service: string, path: string, body: string) {
  const host = `${service}.${region}.amazonaws.com`;
  const req = await new SignatureV4({ service, region, credentials, sha256: Sha256 })
    .sign({ method: 'POST', protocol: 'https:', hostname: host, path, headers: { host, 'content-type': 'application/json' }, body });
  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers: req.headers, body });
  return `${res.status} ${(await res.text()).slice(0, 160)}`;
}

for (const [name, arn] of roles) {
  const { Credentials: c } = await new STSClient({}).send(new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: `probe-${name}` }));
  const creds = { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
  console.log(name.padEnd(20), 'traces :', await post(creds, 'xray', '/v1/traces', traces()));
  console.log(''.padEnd(20), 'metrics:', await post(creds, 'monitoring', '/v1/metrics', metrics()));
}
