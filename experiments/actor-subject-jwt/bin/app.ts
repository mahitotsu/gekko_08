#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ActorSubjectStack } from '../lib/actor-subject-stack';

const app = new cdk.App();
// `aws iam get-outbound-web-identity-federation-info` の IssuerIdentifier
const issuer = app.node.tryGetContext('stsIssuer');
if (!issuer) throw new Error('pass -c stsIssuer=<IssuerIdentifier>');
new ActorSubjectStack(app, 'Gekko08ExpActorSubject', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
  issuer,
});
