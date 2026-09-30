import * as cdk from 'aws-cdk-lib';
import { ScopeTagsStack } from '../lib/scope-tags-stack';

const app = new cdk.App();
new ScopeTagsStack(app, 'Gekko08ExpScopeTags', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
