import * as cdk from 'aws-cdk-lib';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { FederatedProviderStack } from '../lib/stack';

// 本体のスタックのUser Poolとアプリクライアントを使う（OIDC providerは本体が作ったものを信頼する）
const { Stacks } = await new CloudFormationClient({ region: 'ap-northeast-1' }).send(new DescribeStacksCommand({ StackName: process.env.STACK_NAME ?? 'Gekko08App' }));
const out = Object.fromEntries((Stacks![0].Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));

const app = new cdk.App();
new FederatedProviderStack(app, 'Gekko08ExpFederatedProvider', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
  userPoolId: out.UserPoolId,
  clientId: out.UserPoolClientId,
});
