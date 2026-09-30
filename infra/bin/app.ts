import * as cdk from 'aws-cdk-lib';
import { Gekko08AppStack } from '../lib/app-stack';

const app = new cdk.App();
new Gekko08AppStack(app, 'Gekko08App', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(app).add('project', 'gekko08');
