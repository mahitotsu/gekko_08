import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AuthFoundation } from './constructs/auth-foundation';
import { Bff } from './constructs/bff';
import { DemoData } from './constructs/demo-data';
import { Hop } from './constructs/hop';
import { REPO_ROOT, type NodeFunctionProps } from './constructs/node-function';
import { OutboundFederationCheck } from './constructs/outbound-federation-check';
import { WebFrontend } from './constructs/web-frontend';
import { connectHops } from './delegation';
import { authz as accountServiceAuthz } from '../../services/account-service/authz';
import { authz as bffAuthz, PURPOSES } from '../../services/bff/authz';
import { authz as caseServiceAuthz } from '../../services/case-service/authz';
import { authz as entitlementServiceAuthz } from '../../services/entitlement-service/authz';
import { authz as fraudAgentAuthz } from '../../services/fraud-agent/authz';
import { authz as fraudMcpAuthz } from '../../services/fraud-mcp/authz';

/** デプロイ先のリージョン（要件定義の前提）。エージェントが、日本国内の推論プロファイルでモデルを呼ぶため */
export const REGION = 'ap-northeast-1';

const BEDROCK_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** 委任の範囲の定義。各サービスが自分の`authz.ts`に書く（設計書§4） */
export const DELEGATION_DEFINITIONS = [bffAuthz, caseServiceAuthz, accountServiceAuthz, entitlementServiceAuthz, fraudAgentAuthz, fraudMcpAuthz];
export const BEDROCK_PROFILE = `jp.${BEDROCK_MODEL}`;

// Lambdaの関数とレイヤーを合わせた展開後の上限は250MiB（262,144,000バイト）。上限に近づいたら合成を失敗させる
const MAX_BUNDLE_BYTES = 255_000_000;

/**
 * fraud-agentに、Claude Code（linux-arm64の実行ファイル）を同梱する。SDKと同じ版を、npmのレジストリから取得する。
 * 開発機の`node_modules`には開発機のプラットフォーム向けしか入らないため。SDKの版はfraud-agentの`package.json`で固定する
 */
function claudeCodeBundling(): NodeFunctionProps['bundling'] {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'services/fraud-agent/package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const version = manifest.dependencies['@anthropic-ai/claude-agent-sdk'];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`pin @anthropic-ai/claude-agent-sdk to an exact version (got ${version})`);
  const pkg = '@anthropic-ai/claude-agent-sdk-linux-arm64';
  const cache = path.join(os.tmpdir(), `gekko08-claude-code-${version}`);
  return {
    commandHooks: {
      beforeBundling: () => [],
      beforeInstall: () => [],
      afterBundling: (_inputDir: string, outputDir: string) => [
        `test -f ${cache}/package/claude || (mkdir -p ${cache} && cd ${cache} && npm pack ${pkg}@${version} --silent && tar -xzf *.tgz)`,
        `cp ${cache}/package/claude ${outputDir}/claude`,
        `size=$(du -sb ${outputDir} | cut -f1); if [ "$size" -gt ${MAX_BUNDLE_BYTES} ]; then echo "fraud-agent bundle is $size bytes (limit ${MAX_BUNDLE_BYTES})" >&2; exit 1; fi`,
      ],
    },
  };
}

/** 参照実装の単一のスタック（設計書§9） */
export class Gekko08AppStack extends cdk.Stack {
  // 構成を外から拡張するための参照（呼び出し関係とbffの設定は合成時に決まるので、作成後に加えたホップも反映される）
  readonly issuer: string;
  readonly bff: Bff;
  readonly fraudMcp: Hop;
  /** エージェントが呼ぶモデル（推論プロファイルと、その先の基盤モデル） */
  readonly bedrockResources: string[];

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const { issuer } = new OutboundFederationCheck(this, 'OutboundFederationCheck');
    this.issuer = issuer;
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
    data.accounts.grantReadWriteData(accountService.fn);
    const caseService = new Hop(this, 'CaseService', {
      hopName: 'case-service', entry: 'services/case-service/src/index.ts', issuer, callsOthers: true,
      environment: { CASES_TABLE: data.cases.tableName },
    });
    data.cases.grantReadData(caseService.fn);
    const fraudMcp = new Hop(this, 'FraudMcp', {
      hopName: 'fraud-mcp', entry: 'services/fraud-mcp/src/index.ts', issuer, callsOthers: true,
    });
    this.fraudMcp = fraudMcp;
    // エージェントはClaude Agent SDKで、Claude Code（linux-arm64の実行ファイル）を子プロセスとして動かす（Claude Agent SDKのADR）
    const fraudAgent = new Hop(this, 'FraudAgent', {
      hopName: 'fraud-agent', entry: 'services/fraud-agent/src/index.ts', issuer, callsOthers: true,
      environment: {
        BEDROCK_MODEL_ID: BEDROCK_PROFILE,
        // 原因を調べるときだけ（`cdk deploy -c agentLogStderr=true`）、異常終了したClaude Codeの標準エラー出力をログに出す（設計書§8）
        ...(this.node.tryGetContext('agentLogStderr') === 'true' ? { AGENT_LOG_STDERR: '1' } : {}),
      },
      timeout: cdk.Duration.seconds(55), memorySize: 1024,
      bundling: claudeCodeBundling(),
    });
    // Claude Haiku 4.5を、日本国内の推論プロファイル（東京・大阪）で呼ぶ
    this.bedrockResources = [
      this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: BEDROCK_PROFILE }),
      ...['ap-northeast-1', 'ap-northeast-3'].map((region) => `arn:aws:bedrock:${region}::foundation-model/${BEDROCK_MODEL}`),
    ];
    // モデルを呼ぶのはClaude Codeの子プロセスで、渡すのはこのroleの認証情報だけ。ホップの実行roleの認証情報は渡さない
    const modelRole = new iam.Role(this, 'FraudAgentModelRole', {
      assumedBy: new iam.ArnPrincipal(fraudAgent.execRole.roleArn),
      description: 'fraud-agent: invokes the Bedrock model only (credentials for the Claude Code child process)',
    });
    modelRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: this.bedrockResources,
    }));
    modelRole.grantAssumeRole(fraudAgent.execRole);
    fraudAgent.fn.addEnvironment('MODEL_ROLE_ARN', modelRole.roleArn);

    // 入口
    const bff = new Bff(this, 'Bff');
    this.bff = bff;
    const web = new WebFrontend(this, 'Web', { bff });
    const callbackUrl = `${web.origin}/api/callback`;
    const auth = new AuthFoundation(this, 'Auth', { callbackUrl, logoutUrl: `${web.origin}/` });

    bff.connect(auth, Object.values(PURPOSES));

    // 呼び出し関係と委任の範囲（設計書§4）。定義を突き合わせ、IAMと共通部品の設定を生成する
    connectHops(Object.values(PURPOSES), DELEGATION_DEFINITIONS, {
      bff, 'case-service': caseService, 'account-service': accountService, 'entitlement-service': entitlementService,
      'fraud-agent': fraudAgent, 'fraud-mcp': fraudMcp,
    });

    bff.writeSettings(auth, callbackUrl);

    new cdk.CfnOutput(this, 'WebUrl', { value: web.origin });
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.client.userPoolClientId });
    new cdk.CfnOutput(this, 'SessionsTable', { value: bff.sessions.tableName });
    new cdk.CfnOutput(this, 'FederatedRoleArn', { value: auth.federatedRole.roleArn });
    new cdk.CfnOutput(this, 'PurposeRoleArn', { value: bff.asCaller().chainRole.roleArn });
    new cdk.CfnOutput(this, 'StaffTable', { value: data.staff.tableName });
    new cdk.CfnOutput(this, 'CasesTable', { value: data.cases.tableName });
    new cdk.CfnOutput(this, 'AccountsTable', { value: data.accounts.tableName });
    new cdk.CfnOutput(this, 'Issuer', { value: issuer });
    for (const hop of [caseService, accountService, entitlementService, fraudAgent, fraudMcp]) {
      const key = hop.hopName.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
      new cdk.CfnOutput(this, `${key}Url`, { value: hop.url.url });
      new cdk.CfnOutput(this, `${key}Audience`, { value: hop.audience });
      if (hop.chainRole) new cdk.CfnOutput(this, `${key}ChainRoleArn`, { value: hop.chainRole.roleArn });
    }
  }
}
