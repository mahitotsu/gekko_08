import * as cdk from 'aws-cdk-lib';
import { Gekko08AppStack, REGION } from '../lib/app-stack';

const app = new cdk.App();
// リージョンは固定する。CLIの既定のリージョンに左右されて、別のリージョンにスタックを作らないようにする
new Gekko08AppStack(app, 'Gekko08App', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
});
cdk.Tags.of(app).add('project', 'gekko08');
