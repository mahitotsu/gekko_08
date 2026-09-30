#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { JwtHopStack } from '../lib/jwt-stack';
import { MultiHopStack } from '../lib/multihop-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' };
const base = new MultiHopStack(app, 'Gekko08ExpMultiHop', { env });

// 方式(c)は自アカウントのSTS発行者をIAM OIDC providerとして登録できるか自体が検証対象なので、
// 失敗しても(a)(b)を巻き込まないよう別スタックにする。
// issuer は `aws iam get-outbound-web-identity-federation-info` の IssuerIdentifier
const issuer = app.node.tryGetContext('stsIssuer');
if (issuer) {
  new JwtHopStack(app, 'Gekko08ExpMultiHopJwt', { env, issuer }).addStackDependency(base);
}
