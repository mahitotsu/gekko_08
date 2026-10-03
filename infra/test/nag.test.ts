import { Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { Gekko08AppStack } from '../lib/app-stack';
import { testApp } from './app';

/**
 * スタック全体を、cdk-nagのAwsSolutionsの規則で確かめる。認めた指摘（理由は各コンストラクトの`acknowledgeNag`）のほかに、指摘がないこと。
 * 合成（`cdk synth`、`cdk deploy`）でも同じ確認をするが、デプロイの前に単体テストで気づけるようにする
 */
describe('cdk-nag（AwsSolutions）', () => {
  it('認めていない指摘がない', () => {
    const app = testApp();
    new Gekko08AppStack(app, 'Gekko08App', { env: { account: '111111111111', region: 'ap-northeast-1' } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).not.toThrow();
  });
});
