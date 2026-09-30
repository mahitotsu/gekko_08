# PRFAQ: 「誰の権限で」を最後のホップまでAWS IAMに強制させる参照実装

## この文書について

working backwardsの手法で、これから作る参照実装を「公開した日」の視点から書いたPRFAQである。
プレスリリースは**目指す到達点**を描いたもので、現時点で実現済みの事実ではない。
実現済みの事実と未解決の課題は、FAQ（特に[内部FAQ](#内部faq)）で区別して書く。

- 前提となる検証結果：[コンセプトノート](../concepts/aws-sts-workload-and-authorization-context-separation.md)
- 提供形態：OSSのCDK構成＋参照設計（事業化はしない）
- 想定読者（顧客）：AWS上でマイクロサービスを実装しているエンジニア

---

## プレスリリース

### 「誰の権限で処理するのか」を、認可サーバーもサイドカーも置かずに最後のホップまで届ける ── AWSサーバーレス参照実装を公開

**Cognito・STS・IAMだけで、Authorization ContextとWorkload Identityを分離する。常駐コンポーネントなし、従量課金のみ。**

（公開日未定）── マイクロサービスやAIエージェントが多段に呼び合うシステムでは、最初にログインした
ユーザーの権限が、奥のサービスに届くまでのどこかで失われたり、すり替わったりしやすい。
本日公開する参照実装は、「誰の代理で、どんな業務属性を持って処理しているか」
（Authorization Context）をログイン時に一度だけ刻み、以降のすべてのホップでAWS IAMの
ポリシーエンジン自身に判定させる構成を、`cdk deploy`ひとつで自分のAWSアカウントに再現できるようにする。

**解決する課題**

ユーザーの権限を下流へ届けようとすると、多くのチームは次のどれかに行き着く。
アクセストークンを丸ごと下流へ転送する（`aud`を検証できなくなる）、ユーザーIDをカスタムヘッダーに
載せる（署名のない自己申告で、ネットワーク上の誰でも書き換えられる）、APIパラメータで対象ユーザーを
指定する。どれも「手前のサービスが本当にそのユーザーの代理で呼んでいる」ことを保証できない。

この問題はAIエージェントの登場で表に出てきた。エージェントは信頼できないデータに誘導されて、
権限外のリクエストを作ってしまうことがある。守りをモデルの判断に頼るのではなく、構造的な
認可境界に置く必要がある。つまり、**Requestはcallerが作ってよいが、Authorization Contextは
callerに作らせない**。

正攻法はある。OAuth Token Exchange（RFC 8693）でホップごとにトークンを交換し、SPIFFE/SPIREの
mTLSで通信相手の身元を確かめ、Envoyサイドカーでアプリからそれらを切り離す構成である。
ただし、認可サーバー・SPIRE server/agent・サイドカーを自分たちで運用し続けることになり、
ホップ数に比例して認可サーバーへの問い合わせが増える。小さなチームには重い。

**この参照実装がすること**

2つの「誰」を、AWSがすでに持っている仕組みに割り当てる。

| 関心事 | 問い | この参照実装での担い手 |
|---|---|---|
| Workload Identity | 今、どのサービスと通信しているか | 各サービスのIAM role（SigV4署名で自動的に証明される） |
| Authorization Context | 誰の代理で、どんな業務属性で処理しているか | STS SourceIdentity（書き換え不能）＋transitive session tags |

1. ユーザーはAmazon Cognitoにログインする。Pre Token Generationトリガーが、IDトークンに
   ユーザー識別子と業務属性（部署・テナントなど）を載せる。
2. このIDトークンを`AssumeRoleWithWebIdentity`で一度だけAWSセッションに変換する。
   このときSourceIdentityとsession tagsが刻まれ、以降は誰にも書き換えられない。
3. 各サービスは、受信側のresource policyで「どのサービスroleから、どの業務属性を持つ
   リクエストなら受け付けるか」を宣言する。判定するのはアプリコードではなくIAMである。
   条件を満たさない呼び出しは、関数コードに届く前に403で拒否される。
4. すべてのAPI呼び出しは、CloudTrailに元のユーザー（`sourceIdentity`）付きで記録される。
5. AWSの外（外部SaaSや他クラウド）へ出る境界では、`sts:GetWebIdentityToken`で
   ユーザー情報を引き継いだ署名付きJWTを発行する。

認可サーバーやSPIREのような常駐コンポーネントは持たない。使うのはCognito・STS・IAM・Lambda・
CloudTrailだけで、費用はほぼ従量課金に収まる。

**始め方**

リポジトリをクローンして`cdk deploy`すると、ログインから多段のサービス呼び出しまで一式が
立ち上がる。付属のシナリオでは、権限のあるユーザーの呼び出しは通り、権限のないユーザー・
偽装したヘッダー・プロンプトインジェクションで誘導されたエージェントの呼び出しは、
いずれもIAMによって拒否されることを確かめられる。設計ガイドでは、各判断の根拠と、
この構成が守らないものを説明している。

> 「ユーザーIDをヘッダーで引き回すのをやめたかったが、Keycloakを立てる余力はなかった。
> Cognitoはもう使っていたので、残りはIAMポリシーを書くだけだった。」
> ── サーバーレスでB2B SaaSを開発するエンジニア（想定される利用者の声。架空）

---

## 外部FAQ

参照実装を使うエンジニアが抱くであろう疑問。

### Q1. OAuth Token Exchangeと何が違うのか。

Token Exchangeは、ホップごとに認可サーバーへ問い合わせて、そのホップ向けに`aud`と`scope`を
絞ったトークンを発行し直す。この参照実装は、Authorization Contextをログイン時に一度だけ
STSセッションへ刻み、以降は認可サーバーへ問い合わせない。各ホップの可否はIAMのポリシーエンジンが
判定する。

代わりに失うものもある。Token Exchangeの「ホップが進むほど`scope`を狭める」性質は、
そのままの形では持っていない。権限はホップごとのIAM roleとpolicyの設計で絞る必要がある
（[内部FAQ Q4](#q4-技術的に未解決なことは何か)）。

### Q2. Amazon Bedrock AgentCore Identityを使えばよいのではないか。

用途が違うので、置き換えではなく併用を想定している。

- AgentCore IdentityのOn-Behalf-Of（2026年4月GA）は、ホップごとに外部IdPでRFC 8693の
  トークン交換を行う。外部SaaS（Salesforceなど）やOAuthで守られたAPIを呼ぶ場面に向く。
- AgentCore GatewayからLambdaを呼ぶ場合、選べるのはGatewayのサービスroleだけで、
  呼び出し元の主体でのSigV4署名はAgentCore Runtimeのターゲットに限られる。
- この参照実装が対象にするのは、**AWSの内側で自分たちのサービスが多段に呼び合う部分**である。
  ここでユーザーの権限をIAMに強制させる。外部との境界では、AgentCore Identityや
  `GetWebIdentityToken`でOAuthの世界に橋渡しする。

### Q3. AWS公式ブログの「Propagate user authorization context in AI agents」と何が違うのか。

2026年8月のそのブログは、Cognito＋Pre Token Generationのsession tags＋`AssumeRoleWithWebIdentity`＋
`aws:PrincipalTag`という、この参照実装と同じ部品を使っている。部品の組み合わせが正しいことの
公式な裏付けといえる。

ただし、ブログが扱うのはエージェントがDynamoDBなどのAWSリソースを**直接**触る1ホップである。
SourceIdentity、role chaining、自分たちのサービス同士の多段呼び出しは扱っていない。
この参照実装はその先、サービス間の多段呼び出しとCloudTrailでの一貫した監査を扱う。

### Q4. 費用はどのくらいかかるか。

常時稼働するサーバーを持たないので、固定費はほぼない。STSのAPI呼び出しとLambda Function URLに
追加料金はかからない。Cognito User PoolのEssentialsプランには月10,000 MAUまでの無料枠がある。
Lambdaの実行料金とCloudTrailのログ保管料金は、通常のサーバーレス構成と同じようにかかる。
比較対象は、Keycloak・SPIRE server・サイドカーを常時稼働させ続けるための計算資源と、それを
運用する人手である。

### Q5. mTLSを使わなくて大丈夫なのか。

mTLSが守っていたのは「正規に配置されたワークロードしか接続できない」という参加資格である。
この参照実装では、それをネットワークではなくIAMで守る。Lambda Function URLを`AWS_IAM`認証にすると、
呼び出しにはSigV4署名が必要になる。そのうえで受信側のresource policyに、許可する呼び出し元roleを
明示的に列挙する。署名のない呼び出しと許可されていないroleからの呼び出しが403になることは、
実機で確認済みである（[コンセプトノート](../concepts/aws-sts-workload-and-authorization-context-separation.md#トランスポートmtlsではなくtlsbearer-jwtのsub)）。

SigV4では`SecretAccessKey`が通信路に乗らず、署名はリクエスト内容と時刻に縛られる。このため、
通信路で盗み見た値から新しいリクエストは作れず、mTLSの送信者拘束に近い性質をもともと持つ。
残るリスクは、AssumeRoleで得た3つの値（`AccessKeyId`・`SecretAccessKey`・`SessionToken`）
すべてが実行環境から漏れた場合で、有効期限まではどこからでも使える（これは同じ環境から
秘密鍵が漏れた場合のmTLSも同じ）。被害の範囲はSTSセッションの短寿命化で抑える。
なお、多段伝播で一時クレデンシャルそのものを下流へ渡す方式（[内部FAQ Q4](#q4-技術的に未解決なことは何か)の(a)）を
採ると、3つの値すべてを意図的に通信路に乗せることになり、この性質を失う。

### Q6. AIエージェントやMCPサーバーではどう使うのか。

エージェント → MCPサーバー → 内部サービス、という呼び出しは多段のマイクロサービス呼び出しの
1ケースとして扱う。エージェントがどんなRequestを作っても、Authorization Context（SourceIdentityと
session tags）はエージェント自身には変えられない。最終的に呼ばれるサービスでIAMが判定するので、
プロンプトインジェクションでエージェントの判断が揺らいでも、権限の境界は揺らがない。

### Q7. Cognito以外のIdPやLambda以外のコンピュートでも使えるか。

初版はCognito User PoolとLambdaを対象にする。

- IdP：IAM OIDC providerとして登録でき、IDトークンに`https://aws.amazon.com/source_identity`と
  `https://aws.amazon.com/tags`のクレームを載せられるIdPなら、原理的には置き換えられる。ただし初版では検証しない。
- コンピュート：ECSなどはスコープ外。`GetWebIdentityToken`のECS固有クレームの有無などを
  改めて確かめる必要がある。
- 呼び出し先：SigV4で認証できるエンドポイント（Lambda Function URL、API GatewayのIAM認可など）に限られる。

### Q8. この設計が守らないものは何か。

- **権限の範囲内での誤った操作**：ユーザー本人に許されている操作を、エージェントが誤って実行することは防げない。
- **業務属性の粒度が粗い場合の過剰な許可**：session tagsの設計が粗ければ、その粗さのまま許可される。
- **権限の範囲内での大量アクセス**：レート制限や異常検知は別の仕組みで扱う。
- **信頼の起点の侵害**：Cognito、Pre Token Generation Lambda、IAMの設定そのものが侵害された場合。
  特にPre Token Generation Lambdaは、SourceIdentityとtagsの値を決める信頼の起点である。AWSはその値の正しさを検証しない。

---

## 内部FAQ

作る価値があるか、何が未解決かを判断するための問い。

### Q1. この課題を抱えるエンジニアは本当にいるのか。

いる。根拠は次のとおり。

- **標準化団体の脅威整理**：OWASP Top 10 for Agentic Applications（2025年12月）のASI03
  「Identity & Privilege Abuse」は、委任チェーンの中で下流が継承した資格情報によって、本来の
  認可範囲を超えてアクセスするシナリオを挙げている。OWASP NHI Top 10は過剰権限を上位に置いている。
- **プロトコル仕様**：MCP認可仕様（2026-07-28版）は、MCPサーバーが自分宛て以外のトークンを
  受け付けたり転送したりすることを禁じ、トークンパススルーをconfused deputyの原因としている。
  つまり「トークンを丸ごと転送する」という一番手軽な方法は、仕様上も使えない。
- **実際の事故**：
  - Asana MCP（2025年6月）：アクセス制御の強制が不完全で、他組織のデータが返った。
  - ServiceNow Now Assist（2025年11月）：エージェントが、悪意ある指示を書いた低権限ユーザーではなく、
    対話を始めた高権限ユーザーの権限で動いたため、権限昇格が成立した。「誰の権限で」を
    多段の中で正しく表現できていない典型例である。
- **AWS上の実例**：AWS Summit Japan 2026のマルチテナントエージェントSaaSのデモでも、Cognito JWTの
  `tenant_id`をデータストア・メモリ・Cedar Policyまで手作業で伝播していた。各チームが個別に作り込んでいる。
- **調査データ**：CSAの調査（2026年3月、228人）では68%が人間の行為とエージェントの行為を明確に
  区別できないと答え、74%がエージェントに必要以上の権限が付いていると答えた。ただしこの調査は
  NHIベンダー（Aembit）の出資で、サンプルも小さい。方向性の参考にとどめる。
- **規制**：EU AI Actの高リスクAI向け義務（2026年8月適用）は自動ログ記録を求めている。日本では
  経済産業省が2026年9月にAIエージェントの安全な利活用に関するサブWGを立ち上げ、利用企業向けの
  ガイドライン策定を始めた。「誰の権限で実行したか」を監査証跡として出せることの重要度は上がっていく。

一方で、単一ホップの構成（API Gateway＋Lambda authorizer＋JWT検証）で十分回っているチームも多い。
痛みが表に出るのは、多段呼び出し・エージェント連携・マルチテナント・監査要求が重なったときである。
この参照実装の読者は、そこに差しかかっているエンジニアである。

### Q2. 既存のソリューションで足りているのではないか。

足りていない部分がある。既存のソリューションは大きく3系統に分かれる。

| 系統 | 例 | 多段での「誰の権限で」 |
|---|---|---|
| ホップごとのトークン交換 | AgentCore Identity OBO、Microsoft Entra Agent ID、Okta Cross App Access、Auth0 for AI Agents、HashiCorp Vault | ホップごとにIdPや認可サーバーへ往復する |
| 中央の認可判定（PDP） | Amazon Verified Permissions、AgentCore Policy、OPA、Cerbos | 判定はするが、コンテキストの伝播は利用者任せ |
| ワークロードIDのみ | SPIFFE/SPIRE、Istio ambient、Google Cloud Agent Identity | ユーザーのコンテキストは対象外 |

AWS純正で考え方が最も近いのはIAM Identity CenterのTrusted Identity Propagationである。
ただし対象は社員（workforce）ユーザーと、Redshift・S3 Access Grantsなどの対応サービスに限られ、
Cognitoの顧客IDや自作のLambdaには使えない。

IETFのTransaction Tokensドラフト（-11、2026年7月）は、「信頼ドメイン内でユーザーとリクエストの
コンテキストを不変のまま伝える」という同じ狙いを持つ。ただしまだ標準化の途中である。

まとめると、**Cognitoの顧客IDをIAMの書き換え不能な属性としてサービス間の多段で運び、各ホップの
受信側でIAMに強制させ、CloudTrailで一貫して監査できる**構成を示した参照実装は見つからなかった。

### Q3. AWSが純正機能で埋めてしまったら、作る意味はなくなるのではないか。

その可能性は高い。AWSは2026年に入ってから、AgentCore Identity OBO（4月GA）、AgentCore Policy
（3月GA）、ユーザー認可コンテキストの伝播パターン（8月のブログ）と、この領域を月単位で拡充している。
多段のサービス間伝播も12〜18か月のうちに純正で扱われるかもしれない。

それでも作る価値はあると判断する。理由は3つ。

- この参照実装の目的は事業化ではなく、エンジニアへの設計知見の提供である。純正機能が出たとき、
  「何を分離すべきで、どこでIAMに強制させるべきか」を理解しているエンジニアは、その機能を正しく評価し、正しく使える。
- 純正機能が出るまでの間、今まさに多段呼び出しを作っているエンジニアに、ヘッダー引き回しより安全な選択肢を示せる。
- 純正機能が出たら、参照実装をそれに寄せて更新すればよい。CDK構成は差し替えやすい。

### Q4. 技術的に未解決なことは何か。

**最大の課題は、2ホップ目以降への伝播方式がまだ決まっていないことである。**

スパイクで実機確認したのは1ホップ（chainしたセッションで呼び出し元がSigV4署名し、受信側の
resource policyがSourceIdentityとtagsで判定する）だけである。受信側のLambdaは自分の実行roleで
動くため、そのLambdaがさらに次のサービスを呼ぶとき、元のユーザーのSourceIdentityは**自然には引き継がれない**。

候補は3つあり、設計フェーズで最初に決めるADRの題材にする。

| 方式 | 概要 | 懸念 |
|---|---|---|
| (a) 一時クレデンシャルを下流へ渡す | 上流のSTSセッションの認証情報を次のホップに渡し、次のホップはそれでAssumeRoleを続ける | bearer型の資格情報の転送で、MCPが禁じるトークンパススルーと同じ形になる。3つの値すべてを通信路に乗せるため、SigV4の送信者拘束的な性質（`SecretAccessKey`を送らない）を失い、漏れたときの影響範囲が大きい |
| (b) 受信側がSourceIdentityを付け直す | 受信側が、受け取った呼び出し元情報をもとに自分でAssumeRoleし、SourceIdentityとtagsを設定する | 受信側がどんな値でも設定できるなら偽装を防げない。値の出どころをどう縛るかが論点 |
| (c) 署名付きJWTを伝達媒体にする | 各ホップが`GetWebIdentityToken`で`source_identity`を引き継いだJWTを発行し、次のホップはそれを検証して使う | Transaction Tokensに近い形になる。IAMの強制とJWT検証をどう組み合わせるか、`aud`をどう運用するか |

その他の制約とリスク：

- **role chainingのセッションは最大1時間**：長時間のエージェント対話や非同期ジョブでは、どこかで
  再認証や再AssumeRoleが必要になる。
- **session tagsの上限**：最大50個、値は単一値のみ。リソース単位の関係性のような細かい認可は
  IAMだけでは表現しにくい。その部分はAmazon Verified PermissionsやCedarとの併用を検討する。
- **ホップごとの`scope`の絞り込みがない**：Token Exchangeの「ホップが進むほど狭める」性質を、
  roleとsession policyの設計でどう再現するか。
- **STSへの呼び出しは毎ホップ残る**：認可サーバーへの往復はなくなるが、STSのレイテンシと
  スロットリングは見積もる必要がある。
- **AWSへのロックイン**：AWS外との相互運用には、`GetWebIdentityToken`などでの変換が必要になる。
  受け手には「ユーザーは`sub`（roleのARN）ではなく`source_identity`で表される」と取り決めてもらう必要がある。
- **IPv6のegress-only IGW経路**（NAT Gatewayを使わない構成）は未検証。

### Q5. 何をもって成功とするか。

- 参照実装を`cdk deploy`したエンジニアが、付属のシナリオで「正規の呼び出しは通り、偽装と
  エージェントの誘導はIAMに拒否される」ことを自分の手で確かめられる。
- 設計ガイドを読んだエンジニアが、自分のシステムで「誰がAuthorization Contextを作っているか」
  「途中のサービスやAIがそれを書き換えられるか」に答えられるようになる。
- 記事化と、リポジトリへのフィードバック（issue、フォーク、利用報告）。

### Q6. 何をスコープ外にするか。

- Lambda以外のコンピュート（ECSなど）。
- Cognito以外のIdPの検証。
- 業務RBACの持たせ方（ログイン時にsession tagsへ焼き込むか、各サービスがディレクトリを引き直すか）。
  参照実装では1つの例を示すにとどめる。
- Pre Token Generation V1トリガー（V2を前提とする）。
- 事業化、サポート、SLA。

---

## 付録：調査の出典

調査日は2026-09-30。「検証済み」は一次情報を直接確認したもの、「二次情報」は報道や検索結果の要約に基づくもの。

### 課題の出発点

- [奥までユーザーの権限を届けたい ── OAuth Token Exchangeによるマイクロサービス間の権限委譲](https://zenn.dev/akring/articles/1a9f25fd6b04ab)（2026-09-15）
- [プロンプトインジェクションでAIエージェントは騙せたが、認可は揺るがなかった](https://zenn.dev/akring/articles/1c25b8f471f92d)（2026-09-30）

### 需要・脅威・規制

- [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)（2025-12-09）
- [OWASP Non-Human Identities Top 10 2025](https://owasp.org/www-project-non-human-identities-top-10/2025/top-10-2025/)
- [MCP Authorization（2026-07-28）](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)／[Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)（検証済み）
- [Asana MCPのデータ露出（BleepingComputer）](https://www.bleepingcomputer.com/news/security/asana-warns-mcp-ai-feature-exposed-customer-data-to-other-orgs/)（2025-06）
- [ServiceNow AIエージェントの二次プロンプトインジェクション（The Hacker News）](https://thehackernews.com/2025/11/servicenow-ai-agents-can-be-tricked.html)（2025-11）
- [CSA調査：組織の3分の2以上がAIエージェントと人間の行為を区別できない](https://cloudsecurityalliance.org/press-releases/2026/03/24/more-than-two-thirds-of-organizations-cannot-clearly-distinguish-ai-agent-from-human-actions)（2026-03-24、Aembit出資）
- [AWS Summit Japan 2026 マルチテナントAIエージェントSaaSのアーキテクチャ](https://aws.amazon.com/jp/blogs/news/multitenant-ai-agent-saas-architecture-aws-summit-japan-2026/)（2026-07-27）
- [EU AI Act第12条のログ要件（Help Net Security）](https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/)（2026-04-16）
- [経済産業省 事業者におけるAIエージェントの安全な利活用に関するサブWG](https://www.meti.go.jp/shingikai/mono_info_service/sangyo_cyber/wg_seido/wg_ai_agent/index.html)（第1回 2026-09-18）

### 既存ソリューション

- [AgentCore Identity: On-behalf-of token exchange](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html)（検証済み）／[GA告知](https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore/)（2026-04-30）
- [AgentCore Gateway outbound authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-outbound-auth.html)（検証済み：Lambdaターゲットはサービスroleのみ）
- [Implement on-behalf-of token exchange for multi-tenant agents with AgentCore Gateway](https://aws.amazon.com/blogs/machine-learning/implement-on-behalf-of-token-exchange-for-multi-tenant-agents-with-amazon-bedrock-agentcore-gateway/)（2026-07-13、検証済み）
- [Propagate user authorization context in AI agents with Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/security/propagate-user-authorization-context-in-ai-agents-with-amazon-bedrock-agentcore/)（2026-08-19、検証済み：1ホップ、SourceIdentityとrole chainingは扱っていない）
- [AgentCore Policy GA](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available/)（2026-03）
- [Well-Architected Agentic AI Lens AGENTSEC02-BP01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec02-bp01.html)（検証済み）
- [IAM Identity Center: Trusted identity propagation（identity-enhanced IAM role sessions）](https://docs.aws.amazon.com/singlesignon/latest/userguide/trustedidentitypropagation-identity-enhanced-iam-role-sessions.html)（検証済み）
- [IAM outbound identity federation: token claims](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound_token_claims.html)（検証済み）
- [Microsoft Entra Agent ID: What's new](https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id)
- [draft-ietf-oauth-identity-assertion-authz-grant（Okta Cross App Access / ID-JAG）](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)（二次情報）
- [Auth0 for AI Agents GA](https://auth0.com/blog/auth0-for-ai-agents-generally-available/)（2025-11-19）
- [HashiCorp Vault Agentic IAM GA](https://www.hashicorp.com/en/blog/hashicorp-vault-agentic-iam-is-now-generally-available)（二次情報）
- [Google Cloud Agent Identity overview](https://docs.cloud.google.com/iam/docs/agent-identity-overview)
- [draft-ietf-oauth-transaction-tokens](https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/)（-11、2026-07-30、検証済み）
- [IETF WIMSE WG documents](https://datatracker.ietf.org/group/wimse/documents/)

### 本方式の部品に関するAWSドキュメント

- [Monitor and control actions taken with assumed roles（SourceIdentity）](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html)
- [Pass session tags in AWS STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)
- [SaaS tenant isolation with ABAC using AWS STS support for tags in JWT](https://aws.amazon.com/blogs/security/saas-tenant-isolation-with-abac-using-aws-sts-support-for-tags-in-jwt/)
- [Implement user-level access control for multi-tenant ML platforms on Amazon SageMaker AI](https://aws.amazon.com/blogs/machine-learning/implement-user-level-access-control-for-multi-tenant-ml-platforms-on-amazon-sagemaker-ai/)（2025-07-11、SourceIdentity＋ABACの前例）
