import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import type { Bff } from './bff';
import { acknowledgeNag } from '../nag';
import { lambdaLogGroup, REPO_ROOT } from './node-function';

/** 静的なフロントエンド（S3）とbffを、同じCloudFrontディストリビューションから配信する（BFFの公開のADR） */
export class WebFrontend extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly origin: string;

  constructor(scope: Construct, id: string, props: { bff: Bff }) {
    super(scope, id);

    const bucket = new s3.Bucket(this, 'Assets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(props.bff.url, { readTimeout: cdk.Duration.seconds(60) }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });
    this.origin = `https://${this.distribution.distributionDomainName}`;

    // OACのoriginが付けるのはlambda:InvokeFunctionUrlだけ。Function URLの呼び出しにはlambda:InvokeFunctionも要る
    props.bff.fn.addPermission('CloudFrontInvoke', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    acknowledgeNag(this.distribution, '本番での利用は想定しない（README）。WAFは利用者の環境で決める', 'CFR2');
    acknowledgeNag(this.distribution, '本番での利用は想定しない（README）。地域の制限は利用者の環境で決める', 'CFR1');
    acknowledgeNag(this.distribution, '本番での利用は想定しない（README）。アクセスログは利用者の環境で決める', 'CFR3');
    acknowledgeNag(this.distribution, 'CloudFrontの既定のドメイン（*.cloudfront.net）の証明書では、TLSの最低の版を指定できない。独自のドメインは使わない', 'CFR4');
    acknowledgeNag(bucket, '静的なファイルだけを置き、CloudFrontのOACからだけ読む。本番での利用は想定しない（README）', 'S1');

    const deployment = new s3deploy.BucketDeployment(this, 'Deploy', {
      sources: [s3deploy.Source.asset(path.join(REPO_ROOT, 'web'), {
        exclude: ['node_modules', 'dist'],
        // 画面（React）は合成のときに開発機でビルドし、静的なファイルだけを置く。Dockerは使わない
        bundling: {
          image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24'),
          local: {
            tryBundle(outputDir) {
              execFileSync('npm', ['run', 'build', '-w', '@gekko08/web', '--', '--outDir', outputDir], { cwd: REPO_ROOT, stdio: 'inherit' });
              return true;
            },
          },
        },
      })],
      destinationBucket: bucket,
      distribution: this.distribution,
      logGroup: lambdaLogGroup(this, 'DeployLogs'),
    });
    // CDKが作る、静的なファイルを置く関数（BucketDeployment）の権限とランタイム。CDKが決める
    const qualifier = cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const { account, region } = cdk.Stack.of(this);
    const bucketId = cdk.Stack.of(this).getLogicalId(bucket.node.defaultChild as cdk.CfnElement);
    acknowledgeNag(deployment.handlerRole.node.scope ?? deployment, 'CDKが作るBucketDeploymentの関数。権限とランタイムはCDKが決める',
      'IAM5[Action::s3:Abort*]', 'IAM5[Action::s3:DeleteObject*]', 'IAM5[Action::s3:GetBucket*]', 'IAM5[Action::s3:GetObject*]', 'IAM5[Action::s3:List*]',
      'IAM5[Resource::*]', `IAM5[Resource::<${bucketId}.Arn>/*]`, `IAM5[Resource::arn:aws:s3:::cdk-${qualifier}-assets-${account}-${region}/*]`, 'L1');
  }
}
