#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoSpikeStack } from '../lib/cognito-stack';
import { SpikeStack } from '../lib/spike-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' };
const base = new SpikeStack(app, 'Gekko08Spike', { env });
new CognitoSpikeStack(app, 'Gekko08SpikeCognito', { env, receiver: base.receiver });
