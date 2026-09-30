#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetBindStack } from '../lib/netbind-stack';

const app = new cdk.App();
new NetBindStack(app, 'Gekko08ExpNetBind', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
