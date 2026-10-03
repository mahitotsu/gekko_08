import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Gekko08AppStack } from '../lib/app-stack';
import { REGION } from '../lib/region';

const app = new cdk.App();
// リージョンは固定する。CLIの既定のリージョンに左右されて、別のリージョンにスタックを作らないようにする
new Gekko08AppStack(app, 'Gekko08App', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
});
cdk.Tags.of(app).add('project', 'gekko08');
// 合成のたびに、cdk-nagのAwsSolutionsの規則で確かめる。認めていない指摘があれば、合成（とデプロイ）を止める
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
