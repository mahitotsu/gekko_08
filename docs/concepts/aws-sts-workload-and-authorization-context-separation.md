# コンセプト: AWSマネージドサービスによるWorkload IdentityとAuthorization Contextの分離

## 位置づけ

これはADRではない。実機検証を経ていない段階のアイデアを記録したコンセプトノートである。
検証（Lambda関数からの`GetWebIdentityToken`呼び出し確認など）が済むまではADRとして
`Accepted`にすべきではない内容である。実現可能性が確認できた段階で、ここに書いた内容を
根拠にADRを書き起こす。さらにその先、working backwardsの手法でPRFAQから
ソリューションとして整理し直す想定。

現在の[ADR 0001](../adr/0001-spire-agent-compute-platform.md)（SPIRE agentの実行基盤に
self-managed EC2を採用）は、このコンセプトが目指す方向とは前提が異なる（SPIRE agentの
配置問題そのものを解消しうる方向）。有益な調査記録ではあるため今は残すが、この方向性が
実現可能と確認でき次第、適切なタイミングで整理（削除、または新ADRによる置き換え）する。

## 背景：2つの独立した関心事

「身元」は2つの独立した関心事に分けて考える。

| 関心事 | 問い | 担うもの |
|---|---|---|
| 業務認可（Authorization Context） | 誰が、何をしてよいか | OAuth / Token Exchange |
| 通信路の身元（Workload Identity） | 今、誰と通信しているか | mTLS（SPIFFE/SPIRE等） |

この2つを混同すると設計がこんがらがる。トークンが「持ち主に何を許すか」を語る一方で、
mTLSは「その通信の両端が本当に名乗ったとおりの相手か」を保証する。片方だけでは守りに
隙間が残るため、レイヤーを分けて両方を敷く、という考え方が出発点になる。

さらに、認可サーバーへのクライアント認証（「このリクエストは本当に正規のワークロードから
来ているか」）を、`client_secret`のような合言葉ではなく、ワークロード自身の身元（mTLS証明書
発行基盤が発行するJWT等）で行う、というパターンもある。この場合、業務認可のToken Exchangeと
ワークロード自身のクライアント認証は**毎ホップ**セットで行われることになり、認可サーバーへの
参照コストがホップ数に比例して増える。

## AWSマネージドサービスへのマッピング

検証：[AWS IAM SourceIdentity](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html)、
[IAM Outbound Identity Federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound.html)
（2025年11月GA、`sts:GetWebIdentityToken`）。

| 従来モデル（SPIFFE/SPIRE mTLS＋OAuth Token Exchange） | AWS候補 | 対応の質 |
|---|---|---|
| mTLS（ワークロードごとのX.509証明書） | 不要とする方針（TLS＋Bearer JWTの`sub`で送信元を識別） | 代替ではなく、要件自体を見直す（詳細は次節） |
| ワークロード自身の身元による認可サーバーへのクライアント認証 | `GetWebIdentityToken` | ほぼそのまま代替可能 |
| OAuth Token Exchange（毎ホップの業務認可伝播） | STS SourceIdentity（role chaining全体で不変・CloudTrail監査）＋ 各ホップでの`GetWebIdentityToken` | 認可サーバーへの参照を「毎ホップ」から「ログイン時の1回」に削減できる |

### SourceIdentityの性質（検証済み事実）

- `AssumeRole`系オペレーションで一度設定すると、role chaining全体を通じて**不変**（後続で書き換え不可）。
- 設定後は`aws:SourceIdentity`として、そのセッションで行う**すべての後続APIコール**がCloudTrailに記録される。
  実機確認：chain後のセッションによる`GetWebIdentityToken`呼び出しのCloudTrailイベントに
  `userIdentity.sessionContext.sourceIdentity`として記録された（2026-09-30）。
- アカウント跨ぎのchainingでは、起点側の実行ポリシーと先方のtrust policy両方に
  `sts:SetSourceIdentity`が必要。
- `AssumeRoleWithWebIdentity`では、OIDCトークンの`https://aws.amazon.com/source_identity`
  namespaceにSourceIdentityを含められる → OIDC IdPをIAM OIDC providerとして登録すれば、
  ログイン時にIdPが発行したIDトークンからSourceIdentityを設定できる。
- 制約：role chainingは**最大1時間セッション**。長時間のエージェント対話では
  re-AssumeRoleが必要になるタイミングが出る。

### GetWebIdentityTokenの性質（検証済み事実）

- 任意のIAMプリンシパルがSTSの`GetWebIdentityToken`を呼ぶと、自分の身元を主張する
  署名付きJWTを取得できる。
- `sub`＝呼び出し元IAMプリンシパルのARN。加えて`https://sts.amazonaws.com/`名前空間に
  `aws_account`・`org_id`・`principal_tags`・`source_identity`（設定されていれば継承）・
  `ec2_source_instance_arn`/`lambda_source_function_arn`等のセッションコンテキストが入る。
- 外部サービスは`iss`のOIDCディスカバリエンドポイントから鍵を取得し、通常のOIDC検証フローで
  署名検証できる。
- `sts:GetWebIdentityToken`/`sts:TagGetWebIdentityToken`権限と、
  `sts:IdentityTokenAudience`・`sts:DurationSeconds`・`sts:SigningAlgorithm`の
  条件キーで発行を制御できる。
- **Lambdaでの実機確認（2026-09-30、ap-northeast-1、Python 3.13、boto3 1.42.97）**：
  Lambda関数の実行roleから呼び出せた（ランタイム同梱のSDKで足り、追加バンドル不要）。
  `sub`は実行roleのARN、`lambda_source_function_arn`・`principal_tags`・`org_id`・
  `aws_account`等が付与された。`iss`はアカウント固有の
  `https://<uuid>.tokens.sts.global.api.aws`。
  `AssumeRoleWithWebIdentity`でSourceIdentityを設定し、role chainingを1段経たセッションで
  呼んだ場合、JWTの`https://sts.amazonaws.com/`名前空間に`source_identity`が継承され、
  transitiveに指定したsession tagも`principal_tags`に入った（`sub`はchain先のroleのARN）。

## トランスポート：mTLSではなくTLS＋Bearer JWTの`sub`

通信路の相互認証（ワークロードごとのX.509証明書によるmTLS）は要件から外し、サーバ認証のみの
TLS上でBearer JWTを流す方針にする。送信元の身元は、JWTの`sub`（署名検証済み。
`GetWebIdentityToken`なら呼び出し元IAMプリンシパルのARN、Cognitoからの
AssumeRoleWithWebIdentityなら`SubjectFromWebIdentityToken`）で判別する。

この判断が成立する理由：
- mTLSが守っていたのは「そもそも正規に配置された（node/workload attestation済みの）
  ワークロードしか接続できない」という参加資格である。これはネットワーク到達性ではなく
  **IAM Policyで代替できる**（検証：[Control access to Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.md)）。
  function URLを`AWS_IAM`認証タイプにすると、呼び出しはSigV4署名を要求され、Lambda自身が
  IAMでリクエストを検証してから関数を起動する（未検証の呼び出しは関数コードに到達する前に
  403で弾かれる＝アプリコードに依存しない強制）。加えて、関数側の**resource-based policy**で
  「どのIAM role（呼び出し元ワークロード）からの`lambda:InvokeFunctionUrl`/`lambda:InvokeFunction`
  を許可するか」を受信側が明示的に宣言できる。これは、特定のワークロードの身元だけを
  許可リストに載せる仕組み（受信側主導のallowlist）とほぼ同じ形になる。同一アカウント内では
  呼び出し元のidentity-based policyかこのresource-based policyのどちらかで足りるが、
  両方を組み合わせて「呼び出し元も許可され、かつ受信側も明示的に許可している」という
  二重の宣言にする方が、許可リストの感覚に近い。
  **実機確認（2026-09-30）**：呼び出し元のidentity policyを空にして、受信側の
  resource-based policy（`lambda:InvokeFunctionUrl`＋`lambda:InvokeFunction`
  〔`invokedViaFunctionUrl`〕）だけで許可したroleは200、同一アカウント内で許可していない
  roleと未署名リクエストはいずれも403だった。受信側には
  `requestContext.authorizer.iam`として呼び出し元の`userArn`・`principalOrgId`等が渡る。
- この`aws:SourceIdentity`/`aws:PrincipalTag`を、このresource-based policyやidentity-based
  policyの条件キーとして使えば、認可コンテキスト（誰の代理か・どの業務属性を持つか）の判定も
  IAMのポリシーエンジン自身が行うことになる。以前このコンセプトで整理した「tagはアプリコードが
  読んで従わない限りOAuth scopeと同じくただの飾り」という結論は、通信がプレーンHTTPであることが
  前提だった。Function URL/API Gatewayの`AWS_IAM`認証を使う限り、通信はプレーンHTTPではなく
  IAMが仲介するAWS API呼び出しになるため、その結論はここには当てはまらない。
  **実機確認（2026-09-30）**：Function URLを呼ぶchain先roleのidentity-based policyに
  `aws:PrincipalTag/department`だけ、または`aws:SourceIdentity`だけを条件にした許可を書き、
  ログイン時に注入した値が異なるユーザーで呼ぶと、条件を満たす場合のみ200、満たさない場合は
  403になった（片方の条件だけを満たすユーザーでも正しく区別された）。
  受信側のresource-based policyでも同様に機能した。呼び出し元roleのidentity policyには
  何も許可を書かず、受信側関数のresource policy（`PutResourcePolicy`／CloudFormationの
  `AWS::Lambda::ResourcePolicy`）に、呼び出し元roleをPrincipalとして`aws:PrincipalTag`または
  `aws:SourceIdentity`の条件付きで`lambda:InvokeFunctionUrl`と`lambda:InvokeFunction`
  （`lambda:InvokedViaFunctionUrl`）を許可した場合も、結果は同じだった。
  注意：`PutResourcePolicy`は関数の既存のresource policyを**置き換える**（`AddPermission`で
  付けた許可も上書きされる）ため、同じ関数で両方を併用しない。
- 残る差分は「盗まれたBearerトークン（＝ここではSigV4署名の元になるIAM認証情報）の再利用防止」。
  mTLS/送信者拘束が持っていたこの性質の代替は、STSセッションの短寿命化
  （`GetWebIdentityToken`の`sts:DurationSeconds`条件キー等）に委ねる。

Lambdaを最初のスパイク対象にするのはこの判断と相性がよい。理由は3つ。

1. **TLS終端のマネージド度が違う**（検証：[Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)）。
   Lambda function URLは作成するだけで`https://<url-id>.lambda-url.<region>.on.aws`が
   自動発行され、証明書の用意・更新は一切不要（HTTPSのみ、証明書はAWSが完全管理）。
   API Gatewayも同様に`*.execute-api.<region>.amazonaws.com`でマネージドTLSが標準装備
   （カスタムドメインを使う場合のみACM証明書が必要）。対してECSは、最低でもALB＋ACM証明書が
   必要で、さらに「共有ALBを介さずサービス同士が直接呼び合う」構成（サイドカーによる直接通信
   モデル）を取る場合、ALBの管理範囲外になるためサービスごとに証明書を自前で用意・更新する
   必要が生じる（これはmTLS証明書発行基盤が自動化していた証明書配布の問題そのもの）。
2. Lambdaはそもそも「ノードに常駐するmTLS証明書発行エージェント」「docker.sockへのworkload
   attestation」というADR 0001の前提と構造的に噛み合わない実行環境だった。mTLS要件を外せば
   この噛み合わなさ自体が問題にならなくなる。
3. `GetWebIdentityToken`のドキュメントはLambdaを参照実装として明示しており（session context
   claimに`lambda_source_function_arn`が明記されている一方、ECS task固有のclaimはドキュメント
   上確認できていない）、検証の不確実性が最も低い。

**Lambda function URL選定時の注意点**：function URLは**パブリックインターネット経由でのみ
到達可能**であり、PrivateLinkに対応していない（VPCエンドポイント経由の到達不可）。ただし
上記のとおり「正規ワークロードのみ接続可」はネットワーク到達性ではなくIAM Policy
（`AWS_IAM`認証タイプ＋resource-based policy）で担保する方針なので、これは
S3バケットやSQSキューが公開エンドポイントを持ちつつIAM Policyでアクセス制御されているのと
同じ、AWSでは標準的なパターンであり、必須の代替が必要な欠落ではない。ネットワークレベルの
到達性制限を追加の防御層として重ねたい場合は、プライベート統合（VPCエンドポイント経由）に
対応するAPI Gatewayを選ぶ余地もあるが、これは多層防御の追加オプションであって必須ではない。

### IPv6スタックでの実現

エンドポイントがインターネットに晒される前提を受け入れるなら、egress側もIPv6に寄せる価値がある。

検証（[Egress-only internet gateway](https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html)、
[Lambda VPC networking](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)、
[NAT Gateway pricing](https://aws.amazon.com/vpc/pricing/)）：

- Lambda function URLは元々dual-stack（IPv4/IPv6両対応）。呼び出し元のLambdaがVPCにアタッチ
  されていて（例：プライベートなデータストアへ接続するため）他サービスのfunction URLへ
  アウトバウンド接続する場合、従来はNAT Gateway（**$0.045/時間 ＋ $0.045/GB処理料**、さらに
  使用するpublic IPv4アドレスにも$0.005/時間）が必要だった。
- egress-only internet gatewayはIPv6アウトバウンド専用で、**ゲートウェイ自体の時間課金・GB処理料が
  ない**（通常のデータ転送料のみ）。dual-stackサブネット＋egress-only internet gatewayへのルートを
  設定すれば、他サービスのfunction URLへの呼び出しをIPv6経路に流し、NAT Gatewayを完全に回避できる。
- 制約：Lambdaは現時点で**IPv6-onlyサブネットに未対応**（`Ipv6AllowedForDualStack`を有効にした
  dual-stackサブネットが必須。IPv4 CIDRも引き続き必要）。つまり「サブネットを完全にIPv6のみにする」
  ことはできないが、実際のインターネットegressの経路をIPv6（egress-only IGW）に寄せることで
  NAT Gatewayのコストと管理を回避する、という効果は得られる。

未検証：dual-stackサブネット＋egress-only IGWの構成で、実際にLambda間のfunction URL呼び出しが
NAT Gatewayなしに成立するか。

## OIDC IdPの選定：Cognito

ログイン用のOIDC IdPには、自前運用が必要なIdPではなく**Amazon Cognito User Pool**を使う方針にする。
「可能な限りマネージドサービスで実現する」という本コンセプトの出発点にも合致する。

検証（[AssumeRoleWithWebIdentity APIリファレンス](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)、
[Pass session tags in AWS STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)、
[Using attributes for access control（Cognito Identity Pools）](https://docs.aws.amazon.com/cognito/latest/developerguide/attributes-for-access-control.html)）：

- `AssumeRoleWithWebIdentity`はSourceIdentityとsession tagsの**両方**を、渡されたJWT（WebIdentityToken）
  のクレームから直接読み取れる。SourceIdentityは`https://aws.amazon.com/source_identity`、
  session tagsは`https://aws.amazon.com/tags`名前空間（`principal_tags`＋`transitive_tag_keys`。
  ネストされたJSONをサポートしないIdP向けにフラット形式もある）。つまり**1回のAssumeRoleWithWebIdentity
  呼び出しで、SourceIdentityと業務属性（役職等）のtagsを同時に、しかもtransitiveとして設定できる**。
- Cognito **Identity Pools**の「Attributes for access control」機能は、principal tagsのマッピングは
  やってくれる（`sts:TagSession`経由）が、**SourceIdentityには対応していない**（ドキュメントに記載がない）。
  Identity Poolsの管理フロー（Enhanced/Basicいずれも）を使う限り、SourceIdentityを制御する経路がない。
- したがって、Identity Poolsは**使わない**。User Poolを直接IAM OIDC providerとして登録し、
  Pre Token Generation Lambdaトリガーで ID token に上記2つのクレームを注入した上で、
  アプリ（またはサイドカー）が`sts:AssumeRoleWithWebIdentity`を直接呼ぶ。これはaws-authスキル自身の
  一般指針（「クライアントが自前のバックエンドしか呼ばないならIdentity Poolは不要」）とも整合する。
- Pre Token Generation Lambdaは、ネストしたJSONクレーム（`https://aws.amazon.com/tags`の
  `principal_tags`/`transitive_tag_keys`）を返すためにV2トリガーを使い、V2は
  **Essentials以上のプラン**が必要（新規User Poolのデフォルト）。Essentialsも月10,000 MAUまでは
  無料枠がある（[Cognito料金](https://aws.amazon.com/cognito/pricing/)）。V1トリガーは
  クレーム値が文字列のみのため、配列である`transitive_tag_keys`を返せず、role chainingを
  越えるtag伝播ができない可能性が高い（公式ドキュメント上の記述に基づく推定で、実機未確認）。
  本コンセプトはV2を前提とし、V1は対象外とする。
- **実機確認（2026-09-30、ap-northeast-1）**：User Pool（Essentialsプラン）に
  Pre Token Generation **V2**トリガーを付け、ID tokenに
  `https://aws.amazon.com/source_identity`（文字列）と`https://aws.amazon.com/tags`
  （ネストしたJSON：`principal_tags`＋`transitive_tag_keys`）を注入できた。User PoolをIAM OIDC
  providerとして登録し（`aud`＝App ClientのIDで信頼ポリシーを絞る）、`AssumeRoleWithWebIdentity`を
  直接呼ぶと、SourceIdentityとsession tagが1回の呼び出しで設定された。Chain先のroleの
  `AssumeRole`でもSourceIdentityは保持され、transitiveに指定したtagも伝播した。
  federated roleの信頼ポリシーには`sts:AssumeRoleWithWebIdentity`に加えて`sts:TagSession`と
  `sts:SetSourceIdentity`、chain先の信頼ポリシーには`sts:AssumeRole`＋同2つが必要。
  IdP側から取得した認証は`USER_PASSWORD_AUTH`で行い、Authorization Code + PKCEでの
  ログインフローは検証していない（発行されるID tokenの形式は同じ）。

## 想定するフロー

1. 人間ユーザーがCognito User Poolにログイン（OIDC、Authorization Code + PKCE）。
2. Pre Token Generation Lambdaトリガーが、発行されるID tokenに
   `https://aws.amazon.com/source_identity`（ユーザー識別子）と
   `https://aws.amazon.com/tags`（`principal_tags`に業務属性、`transitive_tag_keys`に
   role chaining全体へ伝播させたいキーを指定）を注入する。
3. アプリ（またはサイドカー）が、User Poolを直接指すIAM OIDC providerに対して
   `AssumeRoleWithWebIdentity`を呼び、AWSセッションへ変換する。この1回の呼び出しで
   SourceIdentityとtransitive session tagsの両方が一度だけ刻まれる。
4. 以降、複数ホップにわたる委任チェーンの各ホップは、次のroleをAssumeRoleし続けるだけでよい。
   SourceIdentityは書き換え不能なまま、transitiveに指定したtagsも自動で伝播する。
5. どのホップでも、下流や外部システムに「このリクエストは元々誰の代理か」を証明する必要が
   あれば`GetWebIdentityToken`を呼ぶ。同一タスク・同一実行環境内で認証情報を共有できる場合、
   サイドカーやラッパーがアプリコードを変えずにこの呼び出しを代行できる。

### スコープの絞り込み

`GetWebIdentityToken`は呼び出しごとに`Tags`（request_tags）を渡せ、IAM側の
`aws:RequestTag`/`aws:TagKeys`条件キーで「そのroleが主張してよい値」を制約できる。
ただし、これは実際のIAM許可（roleの権限そのもの）を狭めるわけではなく、あくまで
新しく発行するJWTに載せるclaimを狭めるだけであり、そのclaimを受け取った側が読んで
準拠するかどうかは別問題である。この性質はOAuthのscope downと同じ
（発行される新トークンのscope claimが狭まるだけで、それをresource serverが
どう扱うかは別問題という点で対応する）。

## 未検証事項・次のステップ

- role chaining 1時間上限が、長時間のエージェントセッションで実運用上どこまで問題になるか。
- IPv6のegress-only IGW経路（前掲「IPv6スタックでの実現」）。

## スコープ外

以下は本コンセプトの検証・ソリューションの対象に含めない。含めなくても、ここまでの
検証の価値は損なわれない。

- **Lambda以外のコンピュート基盤**（ECS等）：現時点で予定はなく、将来拡張する可能性があるもの。
  その際は`GetWebIdentityToken`の対応状況（ECS task固有のclaimなど）を改めて確認する。
- **業務RBACの持たせ方**（ログイン時federationでprincipal_tags/session tagsに焼き込むか、
  各サービスがダウンストリームでディレクトリを引き直すか等）：設計判断であり、
  コンセプトの実現可能性の検証とは独立して決められる。
- **Pre Token Generation V1トリガー**：上記のとおりV2を前提とする。

## 参考

- 検証用CDKコード：[spike/cdk/](../../spike/cdk/)
- [AWS: Federating AWS Identities to external services](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound.html)
- [AWS: Understanding token claims](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound_token_claims.html)
- [AWS: Controlling access with IAM policies（outbound federation）](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound_policies.html)
- [AWS: Monitor and control actions taken with assumed roles（SourceIdentity）](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html)
- [AWS What's New: IAM outbound identity federation JWTs（2025年11月）](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-iam-identity-federation-external-services-jwts/)
- [AWS: AssumeRoleWithWebIdentity APIリファレンス](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)
- [AWS: Pass session tags in AWS STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)
- [AWS: Using attributes for access control（Cognito Identity Pools）](https://docs.aws.amazon.com/cognito/latest/developerguide/attributes-for-access-control.html)
- [AWS: Creating and managing Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)
- [AWS: Control access to Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.md)
- [AWS: Egress-only internet gateway](https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html)
