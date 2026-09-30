import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

const INSPECT_AUD = 'gekko08-inspect';

// 案A: 方式(a)で渡す一時クレデンシャルを、IPv6 の送信元アドレス（aws:SourceIp）でホップのサブネットに縛る。
// Frontend(テストスクリプト) → A(サブネットA) → B(サブネットB) → C(VPC外)
export class NetBindStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('experiment', 'gekko08-netbind');

    // --- VPC: IPv4 は Lambda の dual-stack 要件のためだけに持ち、IPv4 の外向き経路は作らない ---
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.8.0.0/16', enableDnsHostnames: true, enableDnsSupport: true });
    const v6 = new ec2.CfnVPCCidrBlock(this, 'V6', { vpcId: vpc.ref, amazonProvidedIpv6CidrBlock: true });
    const eigw = new ec2.CfnEgressOnlyInternetGateway(this, 'Eigw', { vpcId: vpc.ref });
    const v6Subnets = cdk.Fn.cidr(cdk.Fn.select(0, vpc.attrIpv6CidrBlocks), 4, '64');
    const sg = new ec2.CfnSecurityGroup(this, 'Sg', {
      vpcId: vpc.ref,
      groupDescription: 'hop egress',
      securityGroupEgress: [
        { ipProtocol: '-1', cidrIp: '0.0.0.0/0' },
        { ipProtocol: '-1', cidrIpv6: '::/0' },
      ],
    });

    const subnet = (name: string, idx: number) => {
      const cidr6 = cdk.Fn.select(idx, v6Subnets);
      const s = new ec2.CfnSubnet(this, name, {
        vpcId: vpc.ref,
        availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
        cidrBlock: `10.8.${idx}.0/24`,
        ipv6CidrBlock: cidr6,
      });
      s.addDependency(v6);
      const rt = new ec2.CfnRouteTable(this, `${name}Rt`, { vpcId: vpc.ref });
      new ec2.CfnRoute(this, `${name}V6Default`, {
        routeTableId: rt.ref, destinationIpv6CidrBlock: '::/0', egressOnlyInternetGatewayId: eigw.ref,
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `${name}RtAssoc`, { routeTableId: rt.ref, subnetId: s.ref });
      return { subnet: s, cidr6 };
    };
    const subA = subnet('SubnetA', 0);
    const subB = subnet('SubnetB', 1);

    const hop = (id: string, environment: Record<string, string>, placement?: ec2.CfnSubnet) => {
      const fn = new lambda.Function(this, id, {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('lambda/hop'),
        timeout: cdk.Duration.seconds(60),
        // IPv6 で届く dual-stack エンドポイント（sts.<region>.api.aws 等）を使わせる
        environment: { AWS_USE_DUALSTACK_ENDPOINT: 'true', ...environment },
      });
      if (placement) {
        fn.role!.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
        (fn.node.defaultChild as lambda.CfnFunction).vpcConfig = {
          subnetIds: [placement.ref], securityGroupIds: [sg.attrGroupId], ipv6AllowedForDualStack: true,
        };
      }
      return fn;
    };

    const fromCidr = (cidr: string) => ({ IpAddress: { 'aws:SourceIp': cidr } });
    const inspect = new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': [INSPECT_AUD] } },
    });

    // --- Frontend: テストスクリプト（このアカウントの管理者）が SourceIdentity と tags を付けて assume する ---
    const admin = new iam.AccountRootPrincipal();
    const frontend = new iam.Role(this, 'Frontend', { assumedBy: admin });
    frontend.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession', 'sts:SetSourceIdentity'], principals: [admin],
    }));

    // chain 先 role: AssumeRole・TagSession・SetSourceIdentity のすべてを、指定サブネットからの呼び出しに限る
    const chainRole = (id: string, trustedArn: string, cidr: string) => {
      const p = new iam.ArnPrincipal(trustedArn);
      const role = new iam.Role(this, id, { assumedBy: p.withConditions(fromCidr(cidr)) });
      role.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [p], conditions: fromCidr(cidr) }),
        new iam.PolicyStatement({
          actions: ['sts:TagSession'], principals: [p],
          conditions: { ...fromCidr(cidr), 'ForAllValues:StringEquals': { 'aws:TagKeys': ['department'] } },
        }),
      );
      role.addToPolicy(inspect);
      return role;
    };
    const assume = (grantee: iam.IGrantable, target: iam.Role) =>
      grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'], resources: [target.roleArn],
      }));

    const aaOut = chainRole('AaOut', frontend.roleArn, subA.cidr6); // A がサブネットAから assume する
    const baOut = chainRole('BaOut', aaOut.roleArn, subB.cidr6);    // B がサブネットBから assume する
    assume(frontend, aaOut);
    assume(aaOut, baOut);

    // --- C: VPC 外の終端。BaOut から、サブネットB発かつ department=sales のときだけ許可 ---
    const c = hop('C', { MODE: 'terminal', HOP: 'C' });
    const urlC = c.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    // --- B: サブネットB。AaOut から、サブネットA発のときだけ許可 ---
    const b = hop('B', { MODE: 'a', HOP: 'B', OUT_ROLE: baOut.roleArn, NEXT_URL: urlC.url }, subB.subnet);
    const urlB = b.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    // --- A: サブネットA。Frontend からの呼び出しは送信元を問わない（入口） ---
    const a = hop('A', {
      MODE: 'a', HOP: 'A', OUT_ROLE: aaOut.roleArn, NEXT_URL: urlB.url,
      // ホップ飛ばしの試行用: A の中から BaOut になって C を直接呼べるか
      SKIP_ROLE: baOut.roleArn, SKIP_URL: urlC.url,
    }, subA.subnet);
    const urlA = a.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const policy = (pid: string, fn: lambda.Function, principal: iam.Role, cond: Record<string, Record<string, string>>) =>
      new lambda.CfnResourcePolicy(this, pid, {
        resourceArn: fn.functionArn,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'Url', Effect: 'Allow', Principal: { AWS: principal.roleArn },
              Action: 'lambda:InvokeFunctionUrl', Resource: fn.functionArn,
              Condition: { ...cond, StringEquals: { ...(cond.StringEquals ?? {}), 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
            },
            {
              Sid: 'Fn', Effect: 'Allow', Principal: { AWS: principal.roleArn },
              Action: 'lambda:InvokeFunction', Resource: fn.functionArn,
              Condition: { ...cond, Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
            },
          ],
        },
      });
    policy('APolicy', a, frontend, {});
    policy('BPolicy', b, aaOut, fromCidr(subA.cidr6));
    policy('CPolicy', c, baOut, { ...fromCidr(subB.cidr6), StringEquals: { 'aws:PrincipalTag/department': 'sales' } });

    new cdk.CfnOutput(this, 'FrontendRoleArn', { value: frontend.roleArn });
    new cdk.CfnOutput(this, 'AaOutArn', { value: aaOut.roleArn });
    new cdk.CfnOutput(this, 'BaOutArn', { value: baOut.roleArn });
    new cdk.CfnOutput(this, 'AUrl', { value: urlA.url });
    new cdk.CfnOutput(this, 'BUrl', { value: urlB.url });
    new cdk.CfnOutput(this, 'CUrl', { value: urlC.url });
    new cdk.CfnOutput(this, 'SubnetACidr6', { value: subA.cidr6 });
    new cdk.CfnOutput(this, 'SubnetBCidr6', { value: subB.cidr6 });
  }
}
