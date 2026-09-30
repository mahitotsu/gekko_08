import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AuthFoundation } from './constructs/auth-foundation';
import { Bff } from './constructs/bff';
import { DemoData } from './constructs/demo-data';
import { Hop } from './constructs/hop';
import { OutboundFederationCheck } from './constructs/outbound-federation-check';
import { WebFrontend } from './constructs/web-frontend';

const BEDROCK_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** 取引の目的。bffが経路ごとに決めて刻む（設計書§3） */
const PURPOSE = { profile: 'profile', caseSummary: 'case-summary', agentAnalysis: 'agent-analysis' } as const;
const BEDROCK_PROFILE = `jp.${BEDROCK_MODEL}`;

/** 参照実装の単一のスタック（設計書§9） */
export class Gekko08AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const { issuer } = new OutboundFederationCheck(this, 'OutboundFederationCheck');
    const data = new DemoData(this, 'DemoData');

    // ホップ
    const entitlementService = new Hop(this, 'EntitlementService', {
      hopName: 'entitlement-service', entry: 'services/entitlement-service/src/index.ts', issuer, callsOthers: false,
      environment: { STAFF_TABLE: data.staff.tableName, TITLE_PERMISSIONS_TABLE: data.titlePermissions.tableName },
    });
    data.staff.grantReadData(entitlementService.fn);
    data.titlePermissions.grantReadData(entitlementService.fn);
    const accountService = new Hop(this, 'AccountService', {
      hopName: 'account-service', entry: 'services/account-service/src/index.ts', issuer, callsOthers: true,
      environment: { ACCOUNTS_TABLE: data.accounts.tableName },
    });
    data.accounts.grantReadData(accountService.fn);
    const caseService = new Hop(this, 'CaseService', {
      hopName: 'case-service', entry: 'services/case-service/src/index.ts', issuer, callsOthers: true,
      environment: { CASES_TABLE: data.cases.tableName },
    });
    data.cases.grantReadData(caseService.fn);
    const fraudMcp = new Hop(this, 'FraudMcp', {
      hopName: 'fraud-mcp', entry: 'services/fraud-mcp/src/index.ts', issuer, callsOthers: true,
    });
    const fraudAgent = new Hop(this, 'FraudAgent', {
      hopName: 'fraud-agent', entry: 'services/fraud-agent/src/index.ts', issuer, callsOthers: true,
      environment: { BEDROCK_MODEL_ID: BEDROCK_PROFILE }, timeout: cdk.Duration.seconds(55),
    });
    // Claude Haiku 4.5を、日本国内の推論プロファイル（東京・大阪）で呼ぶ
    fraudAgent.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: BEDROCK_PROFILE }),
        ...['ap-northeast-1', 'ap-northeast-3'].map((region) => `arn:aws:bedrock:${region}::foundation-model/${BEDROCK_MODEL}`),
      ],
    }));

    // 入口
    const bff = new Bff(this, 'Bff');
    const web = new WebFrontend(this, 'Web', { bff });
    const callbackUrl = `${web.origin}/api/callback`;
    const auth = new AuthFoundation(this, 'Auth', { callbackUrl, logoutUrl: `${web.origin}/` });

    bff.connect(auth, Object.values(PURPOSE));

    // 呼び出し関係と委任の範囲（設計書§4）。scopeと発行できる目的はIAMが強制する
    const { profile, caseSummary, agentAnalysis } = PURPOSE;
    // マイクロサービスの経路：bff → case-service → account-service
    caseService.allowCaller(bff.asCaller(), { scope: 'case:summary', purposes: [caseSummary] });
    accountService.allowCaller(caseService.asCaller(), { scope: 'account:read', purposes: [caseSummary] });
    // エージェントの経路：bff → fraud-agent → fraud-mcp → case-service または account-service
    fraudAgent.allowCaller(bff.asCaller(), { scope: 'agent:analyze', purposes: [agentAnalysis] });
    fraudMcp.allowCaller(fraudAgent.asCaller(), { scope: 'mcp:tools', purposes: [agentAnalysis] });
    caseService.allowCaller(fraudMcp.asCaller(), { scope: 'case:read', purposes: [agentAnalysis] });
    accountService.allowCaller(fraudMcp.asCaller(), { scope: 'account:read', purposes: [agentAnalysis] });
    // 属性サービス：業務的なアクセス権を判定するホップと、表示用のbff
    entitlementService.allowCaller(bff.asCaller(), { scope: 'entitlements:read', purposes: [profile] });
    entitlementService.allowCaller(caseService.asCaller(), { scope: 'entitlements:read', purposes: [caseSummary, agentAnalysis] });
    entitlementService.allowCaller(accountService.asCaller(), { scope: 'entitlements:read', purposes: [caseSummary, agentAnalysis] });

    bff.writeSettings(auth, callbackUrl);

    new cdk.CfnOutput(this, 'WebUrl', { value: web.origin });
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.client.userPoolClientId });
    new cdk.CfnOutput(this, 'SessionsTable', { value: bff.sessions.tableName });
    new cdk.CfnOutput(this, 'FederatedRoleArn', { value: auth.federatedRole.roleArn });
    new cdk.CfnOutput(this, 'PurposeRoleArn', { value: bff.asCaller().chainRole.roleArn });
    new cdk.CfnOutput(this, 'StaffTable', { value: data.staff.tableName });
    new cdk.CfnOutput(this, 'Issuer', { value: issuer });
    for (const hop of [caseService, accountService, entitlementService, fraudAgent, fraudMcp]) {
      const key = hop.hopName.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
      new cdk.CfnOutput(this, `${key}Url`, { value: hop.url.url });
      new cdk.CfnOutput(this, `${key}Audience`, { value: hop.audience });
      if (hop.chainRole) new cdk.CfnOutput(this, `${key}ChainRoleArn`, { value: hop.chainRole.roleArn });
    }
  }
}
