import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { BEDROCK_PROFILE, Gekko08AppStack, PURPOSE } from '../../../infra/lib/app-stack';
import { Hop } from '../../../infra/lib/constructs/hop';

// 本体のスタック（Gekko08App）に、エージェントのフレームワークで作ったfraud-agentを2つ加えてデプロイする。
// 本体のCDKアプリ（infra）からデプロイし直すと、加えたホップは消える
const app = new cdk.App();
const stack = new Gekko08AppStack(app, 'Gekko08App', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(app).add('project', 'gekko08');

const common = {
  issuer: stack.issuer, callsOthers: true,
  environment: { BEDROCK_MODEL_ID: BEDROCK_PROFILE }, timeout: cdk.Duration.seconds(55),
};
const agents = [
  new Hop(stack, 'FraudAgentStrands', { ...common, hopName: 'fraud-agent-strands', entry: 'experiments/agent-frameworks/src/strands-agent.ts' }),
  new Hop(stack, 'FraudAgentClaude', {
    ...common, hopName: 'fraud-agent-claude', entry: 'experiments/agent-frameworks/src/claude-agent.ts', memorySize: 1024,
    bundling: {
      // Claude Codeの実行ファイル（linux-arm64、約241MB）を関数に同梱する
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (inputDir: string, outputDir: string) => [
          `cp ${inputDir}/experiments/agent-frameworks/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude ${outputDir}/claude`,
        ],
      },
    },
  }),
];
for (const agent of agents) {
  // どちらのフレームワークも、ストリーミングでモデルを呼ぶ
  agent.fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: stack.bedrockResources,
  }));
  // 本体のfraud-agentと同じ委任の範囲
  agent.allowCaller(stack.bff.asCaller(), { scope: 'agent:analyze', purposes: [PURPOSE.agentAnalysis] });
  stack.fraudMcp.allowCaller(agent.asCaller(), { scope: 'mcp:tools', purposes: [PURPOSE.agentAnalysis] });
}
