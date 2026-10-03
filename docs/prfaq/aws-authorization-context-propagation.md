# PRFAQ: 「誰の権限で」を最後のホップまでAWS IAMに強制させる参照実装

## この文書について

working backwardsの手法で、参照実装を作る前（2026-09-30）に「公開した日」の視点から書き、実装に合わせて更新しているPRFAQである
（最終更新：2026-10-03（UTC））。プレスリリースに書いたことは、参照実装で実現した。
実現できたことの根拠と、残る制約は、FAQ（特に[内部FAQ](#内部faq)）に書く。

- 前提となる検証結果：[実現性検証](../../experiments/feasibility/RESULTS.md)、ほかの検証記録は内部FAQ Q4から引いている
- 提供形態：OSSのCDK構成＋参照設計（事業化はしない）
- 想定読者（顧客）：AWS上でマイクロサービスを実装しているエンジニア

---

## プレスリリース

### 「誰の権限で処理するのか」を、認可サーバーもサイドカーも置かずに最後のホップまで届ける ── AWSサーバーレス参照実装を公開

**Cognito・STS・IAMだけで、Authorization ContextとWorkload Identityを分離する。常駐コンポーネントなし、従量課金のみ。**

マイクロサービスやAIエージェントが多段に呼び合うシステムでは、最初にログインした
ユーザーの権限が、奥のサービスに届くまでのどこかで失われたり、すり替わったりしやすい。
本日公開する参照実装は、「誰の代理で、何のためのリクエストとして処理しているか」
（Authorization Context）をリクエストごとに入口で刻み、以降のすべてのホップで、AWSが署名した
証明として確かめられるようにする構成を、前提の設定をしたうえで、`cdk deploy`で自分のAWSアカウントに再現できる。

**解決する課題**

ユーザーの権限を下流へ届けようとすると、多くのチームは次のどれかに行き着く。
アクセストークンを丸ごと下流へ転送する（`aud`を検証できなくなる）、ユーザーIDをカスタムヘッダーに
載せる（署名のない自己申告で、ネットワーク上の誰でも書き換えられる）、APIパラメータで対象ユーザーを
指定する。どれも「手前のサービスが本当にそのユーザーの代理で呼んでいる」ことを保証できない。

特殊詐欺にたとえると、「消防署の方から来ました」（どこから来たかの自己申告）や「息子さんの代理の者です」
（誰の代理かの自己申告）を、確かめずに信じている状態である。

この問題はAIエージェントの登場で表に出てきた。エージェントは、データに紛れ込んだ「本部の者です」のような口上に誘導されて、
権限外の呼び出しを作ってしまうことがある。守りをモデルの判断に頼るのではなく、構造的な
認可境界に置く必要がある。つまり、**Requestはcallerが作ってよいが、Authorization Contextは
callerに作らせない**。

正攻法はある。OAuth Token Exchange（RFC 8693）でホップごとにトークンを交換し、SPIFFE/SPIREの
mTLSで通信相手の身元を確かめ、Envoyサイドカーでアプリからそれらを切り離す構成である。
ただし、認可サーバー・SPIRE server/agent・サイドカーという常駐するものを、自分たちで運用し続けることになる。
小さなチームには重い。

**この参照実装がすること**

2つの「誰」を、AWSがすでに持っている仕組みに割り当てる。

| 関心事 | 問い | この参照実装での担い手 |
|---|---|---|
| Workload Identity | 今、どのサービスと通信しているか | 各サービスのIAM role（SigV4署名で自動的に証明される） |
| Authorization Context | 誰の代理で、何のためのリクエストとして、どこまで許されて処理しているか | STS SourceIdentity（書き換え不能）＋リクエストの目的（transitive session tag）＋ホップごとのscope（IAMが付けられる値を限る） |

業務上のアクセス権（このユーザーはこのデータを扱ってよいか）はトークンに入れず、各サービスが判定のときに
権威あるデータ源（人事データと権限マスタを読む属性サービス）から得る。

1. ユーザーはAmazon Cognitoにログインする。Pre Token Generationトリガーが、IDトークンに
   ユーザーの識別子（SourceIdentity）を載せる。
2. サーバー側の入口（BFF）が、リクエストごとに、このIDトークンを`AssumeRoleWithWebIdentity`でAWSセッションに変換し、
   リクエストの目的（案件を開く、凍結を解除する、エージェントによる分析など）をtransitive session tagとして刻む。SourceIdentityと
   目的は、以降は誰にも書き換えられない。ブラウザには、Cognitoのトークンも、AWSの認証情報も渡さない。
3. 各サービスの入口では、IAMが「どのサービスから来たか」を確かめる。受信側のresource policyで
   呼び出し元サービスの実行roleだけを許可し、それ以外は関数コードに届く前に403で拒否する。
4. 呼び出し元は、刻まれたAuthorization Contextを載せた「次のサービス宛て」のJWTを
   `sts:GetWebIdentityToken`でSTSに発行させ、呼び出しに付ける。JWTの宛先とscope、および影響の大きい操作のscopeを発行できるリクエストの目的は、IAMが限る。
   受信側はSTSの署名を検証して、誰の代理か、何のリクエストか、何を許されているかを知る。途中のサービスやエージェントは、
   この値を変更も拡大もできない。
5. 受信側は、検証した委任の範囲と、属性サービスから得たそのユーザーのアクセス権の両方が許すときだけ処理する。
   異動などの変更は、次のリクエストから効く。
6. CloudTrailには、JWTの発行と、受け渡されたセッションからのchain（`AssumeRole`）が、元のユーザー（`sourceIdentity`）付きで記録される。

`GetWebIdentityToken`（IAMのアウトバウンドIDフェデレーション）は、AWSのワークロードの身元を、OIDCに対応した外部のサービスに
証明するための機能として提供されている。この参照実装は、これを**AWSの内側の、制約付きの委任**に使う。STSが署名し、宛先とscopeと
リクエストの目的をIAMが限るJWTを、ホップ間で「このユーザーの代理として、この呼び出しを許されている」ことの証明にする。
外部への身元の証明と同じ部品で、内側の委任も認可サーバーなしに組み立てられる、というのがこの参照実装の位置づけである。

認可サーバーやSPIREのような常駐コンポーネントは持たない。認可の仕組みに使うのはCognito・STS・IAM・Lambda・CloudTrailで、
デモの画面とデータにCloudFront・S3・DynamoDB・SSM Parameter Store、エージェントにAmazon Bedrock、
追跡にCloudWatch（ログとTransaction Search）を使う。費用はほぼ従量課金に収まる。

代わりに、ホップごとにSTSへの往復が加わる。往復の回数は、ホップごとに認可サーバーでトークンを交換する構成より減らない。
この参照実装が減らすのは往復ではなく、運用し続けるものである。

**始め方**

アカウント全体の設定（IAMのアウトバウンドIDフェデレーションとCloudWatchのTransaction Searchの有効化）と、Bedrockのモデルの利用申請をしたうえで、
リポジトリをクローンして`cdk deploy`すると、ログインから多段のサービス呼び出しまで一式が立ち上がる。デモのユーザーを作れば、画面から試せる。
付属のシナリオでは、権限のあるユーザーの呼び出しは通り、権限のないユーザー・
偽装したヘッダー・リクエストの目的に合わない呼び出し・「本部監査部の者です」と名乗って凍結の解除を求める案件メモに誘導されたエージェントの呼び出しは、
いずれも入口のIAMか、STSの署名を検証する受信側によって拒否されることを確かめられる。監査の画面では、1回のリクエストについて、
各ホップが書いたログと、AWSが記録したSTSの呼び出し（CloudTrail）を、JWTの識別子で突き合わせて見られる
（[検証](../../experiments/cloudtrail-records/RESULTS.md)）。設計ガイドでは、各判断の根拠と、この構成が守らないものを説明している。

> 「ユーザーIDをヘッダーで引き回すのをやめたかったが、Keycloakを立てる余力はなかった。
> Cognitoはもう使っていたので、残りはIAMポリシーと、署名を検証する共通部品を組み込むだけだった。」
> ── サーバーレスでB2B SaaSを開発するエンジニア（想定される利用者の声。架空）

---

## 外部FAQ

参照実装を使うエンジニアが抱くであろう疑問。

### Q1. OAuth Token Exchangeと何が違うのか。

Token Exchangeは、ホップごとに認可サーバーへ問い合わせて、そのホップ向けに`aud`と`scope`を
絞ったトークンを発行し直す。この参照実装は、Authorization Contextをリクエストごとに入口で
STSセッションへ刻み、以降は認可サーバーへ問い合わせない。各ホップは、STSが署名したJWTで
「誰の代理か」と「自分宛てか」を、入口のIAMで「どのサービスから来たか」を確かめる。
JWTの署名はSTSが行うので、認可サーバーを運用する必要はない。

Token Exchangeの「ホップごとに`scope`を絞る」性質は、認可サーバーの代わりにIAMのポリシーで再現する。
APIを提供する側が提供するscopeを、使う側が付けたいscopeを宣言すると、合成のときに突き合わせてIAMのポリシーを生成し、
それ以外の値ではSTSがJWTを発行しない。影響の大きい操作のscopeは、許したリクエストの目的のときだけ発行させられる（[検証](../../experiments/scope-tags/RESULTS.md)）。
代わりに、絞り方は実行時の交換ではなく、デプロイ時の宣言で決まる。

### Q2. Amazon Bedrock AgentCore Identityを使えばよいのではないか。

用途が違うので、置き換えではなく併用を想定している。

- AgentCore IdentityのOn-Behalf-Of（2026年4月GA）は、ホップごとに外部IdPでRFC 8693の
  トークン交換を行う。外部SaaS（Salesforceなど）やOAuthで守られたAPIを呼ぶ場面に向く。
- AgentCore GatewayからLambdaを呼ぶ場合、選べるのはGatewayのサービスroleだけで、
  呼び出し元の主体でのSigV4署名はAgentCore Runtimeのターゲットに限られる。
- この参照実装が対象にするのは、**AWSの内側で自分たちのサービスが多段に呼び合う部分**である。
  ここでユーザーの権限をIAMに強制させる。外部との境界への橋渡しは将来の拡張とし、AgentCore Identityなど既存の手段との
  使い分けを検討する。参照実装のJWTは宛先を内部のホップに限っており、そのまま外部に渡すことはしない。

### Q3. AWS公式ブログの「Propagate user authorization context in AI agents」と何が違うのか。

2026年8月のそのブログは、Cognito＋Pre Token Generationのsession tags＋`AssumeRoleWithWebIdentity`＋
`aws:PrincipalTag`という、この参照実装に近い部品を使っている。部品の組み合わせが正しいことの
公式な裏付けといえる。この参照実装は、業務上のアクセス権をsession tagsに入れず、トークンにはSourceIdentityとリクエストの目的だけを載せる。

ただし、ブログが扱うのはエージェントがDynamoDBなどのAWSリソースを**直接**触る1ホップである。
SourceIdentity、role chaining、自分たちのサービス同士の多段呼び出しは扱っていない。
この参照実装はその先、サービス間の多段呼び出しとCloudTrailでの一貫した監査を扱う。

### Q4. 費用はどのくらいかかるか。

常時稼働するサーバーを持たないので、固定費はほぼない。STSのAPI呼び出しとLambda Function URLに
追加料金はかからない。Cognito User PoolのEssentialsプランには月10,000 MAUまでの無料枠がある。
Lambdaの実行料金、CloudWatch Logs（ログとトレースのスパン。スパンの取り込みは量に比例する）とCloudTrailの保管料金は、
通常のサーバーレス構成と同じようにかかる。デモのエージェントには、Bedrockのモデルの料金がかかる。VPCも使わない。
比較対象は、Keycloak・SPIRE server・サイドカーを常時稼働させ続けるための計算資源と、それを
運用する人手である。

### Q5. mTLSを使わなくて大丈夫なのか。

mTLSが守っていたのは「正規に配置されたワークロードしか接続できない」という参加資格である。
この参照実装では、それをネットワークではなくIAMで守る。Lambda Function URLを`AWS_IAM`認証にすると、
呼び出しにはSigV4署名が必要になる。そのうえで受信側のresource policyに、許可する呼び出し元roleを
明示的に列挙する。署名のない呼び出しと許可されていないroleからの呼び出しが403になることは、
実機で確認済みである（[実現性検証](../../experiments/feasibility/RESULTS.md)）。

SigV4では`SecretAccessKey`が通信路に乗らず、署名は呼び出しの内容と時刻に縛られる。このため、
通信路で盗み見た値から新しい呼び出しは作れず、mTLSの送信者拘束に近い性質をもともと持つ。
ただし、署名済みの呼び出しそのものは、署名の時刻の許容幅（約5分）の中では再送できる。
残るリスクは、AssumeRoleで得た3つの値（`AccessKeyId`・`SecretAccessKey`・`SessionToken`）
すべてが実行環境から漏れた場合で、有効期限まではどこからでも使える（これは同じ環境から
秘密鍵が漏れた場合のmTLSも同じ）。被害の範囲はSTSセッションの短寿命化で抑える。
なお多段伝播では、次のサービス宛てのJWTを作るために、一時クレデンシャルそのものを下流へ渡す。
ただし、そのセッションには「次のサービス宛てのJWTを作る」以上の権限を持たせず、サービスの呼び出しは
呼び出し元の実行roleからしか受け付けない。そのため漏れても、それで呼べるサービスはない
（[内部FAQ Q4](#q4-技術的に未解決なことは何か)）。

### Q6. AIエージェントやMCPサーバーではどう使うのか。

エージェント → MCPサーバー → 内部サービス、という呼び出しは多段のマイクロサービス呼び出しの
1ケースとして扱う。エージェントがどんなRequestを作っても、Authorization Context（SourceIdentityと
リクエストの目的）はエージェント自身には変えられない。各サービスはSTSの署名で確かめた値と、属性サービスから得たアクセス権だけを使うので、
プロンプトインジェクションでエージェントの判断が揺らいでも、権限の境界は揺らがない。エージェントは「本部の者です」という口上に
騙されることがあるが、口上はデータの中の文字列で、AWSが保証した値ではない。

付属のデモのエージェントは、広く使われているClaude Agent SDKで作り、MCPの呼び出しを関数の中の中継から共通部品に通す。
実際のエージェントのフレームワークでも、同じ境界がそのまま保てる（[検証](../../experiments/agent-frameworks/RESULTS.md)）。

リクエストの目的によって、同じユーザーでも許す範囲を変えられる。付属のデモでは、凍結された口座の解除を題材にする。エージェントは、
凍結の理由と取引の履歴を分析し、解除してよいかを提案するところまでを行う。凍結の解除そのものは、行員が画面から操作するリクエストでだけ実行できる。
エージェントによる分析のリクエストからは、エージェントが乗っ取られても解除できない。

### Q7. Cognito以外のIdPやLambda以外のコンピュートでも使えるか。

初版はCognito User PoolとLambdaを対象にする。

- IdP：IAM OIDC providerとして登録でき、IDトークンに`https://aws.amazon.com/source_identity`の
  クレームを載せられるIdPなら、原理的には置き換えられる。ただし初版では検証しない。
- コンピュート：ECSなどはスコープ外。`GetWebIdentityToken`のECS固有クレームの有無などを
  改めて確かめる必要がある。
- 呼び出し先：初版はLambda Function URL（`AWS_IAM`認証）に限る。API GatewayのIAM認可を経由する形は将来の拡張とする。

### Q8. この設計が守らないものは何か。

- **権限の範囲内での誤った操作**：ユーザー本人に許されている操作を、エージェントが誤って実行することは防げない。
  還付金詐欺で、本人がATMを操作させられるのと同じである。リクエストの目的とscopeで、操作できる範囲を狭めておくことはできる。
- **IAMが強制する範囲の外の判定**：IAMが強制するのは、呼び出し元・呼び出し先・scope・リクエストの目的の組み合わせで、デプロイ時に決まる。
  どの口座か、いくらまでかといった、リソースや値の単位の判定は、各サービスのコードが業務上のアクセス権を使って行う。
  認可の誤りが入りやすいのはこちらで、その正しさは、この構成では保証しない。
- **委任の範囲やアクセス権の設計が粗い場合の過剰な許可**：目的・scope・権限マスタの設計が粗ければ、その粗さのまま許可される。
- **権限の範囲内での大量アクセス**：レート制限や異常検知は別の仕組みで扱う。
- **信頼の起点の侵害**：Cognito、Pre Token Generation Lambda、BFF、属性サービスのデータ、IAMの設定そのものが侵害された場合。
  Pre Token Generation LambdaはSourceIdentityの値を、BFFはリクエストの目的を決める。AWSはその値の正しさを検証しない。
  業務上のアクセス権は、属性サービスのデータがすべてを決める。

### Q9. Amazon Verified PermissionsやCedar、AWS Verified Accessとどう関係するのか。

競合ではなく、別の層を担うので組み合わせられる。この参照実装が担うのは、判定に使う値（誰の代理か、どのサービスから来たか、
委任の範囲）を、多段の奥まで信頼できる形で届けることである。判定そのものと、社員が社内アプリに入る入口の制御は担わない。

| サービス | 担う層 | この参照実装との関係 | 統合の形 | 位置づけ |
|---|---|---|---|---|
| Amazon Verified Permissions／Cedar | 判定（PDP）：この主体がこの操作をこのリソースに対してしてよいか | 協調。Cedarは入力が本物かどうかを保証しない。この参照実装が検証した値を入力にすれば、多段の奥のホップでも判定を任せられる | 各ホップのコードの判定をCedarのポリシーに移す。principalに`subject`、contextに`actor`・scope、エンティティに属性サービスのアクセス権を渡し、`IsAuthorized`に問い合わせるか、Cedarのライブラリで関数の中で評価する | 将来の拡張とする。初版はコードで判定する |
| Amazon Bedrock AgentCore Policy | エージェントのツール呼び出しの判定（Cedar） | 協調。AgentCore Gatewayの境界で判定する。この参照実装はその先、自分たちのサービス間の多段を扱う | AgentCoreでエージェントを動かす場合に併用する | 初版では扱わない |
| AWS Verified Access | 社員が社内アプリに入る入口（VPNの代わり）。IdPとデバイスの状態をCedarのポリシーで判定し、署名したユーザーの主張（ES384のJWT、`x-amzn-ava-user-context`）をアプリに渡す | 協調。守るのは1ホップ目の手前までで、サービス間の多段は対象外 | 社員向けのシステムで、BFFの前段に置く。ただしBFFは、Cognitoのトークンを`AssumeRoleWithWebIdentity`に使う。Verified Accessが渡すJWTからSTSのセッションにつなぐ方法は未検証 | 初版では扱わない |

Verified Permissionsは、CognitoやOIDCのトークンを渡すと、トークンの主張を主体や属性に対応づけて判定する。ただし判定するのは、
渡されたトークンや値に基づく判断だけである。多段の奥のホップに、改ざんされていない「誰の代理か」を届けることは、
利用者の側で作る必要がある（[内部FAQ Q2](#q2-既存のソリューションで足りているのではないか)の「中央の認可判定」）。
この参照実装はその部分を埋めるので、Verified Permissionsを使うチームにとっても前提の部品になる。

初版でCedarを使わないのは、主題（委任の範囲をAWSに強制させること）から見ると追加の要素になり、ポリシー言語と、
Verified Permissionsなら判定ごとの費用が加わるためである。
どちらを選んでも、委任の範囲をIAMに強制させる部分は変わらない。

### Q10. どんなシステムに向くか。

向くのは、**影響の大きい操作（送金、凍結の解除、権限の変更など）の周りにある、閉じた少数のサービス**である。

- 1つのサービスの呼び出し元と呼び出し先が、それぞれ十前後に収まる。呼び出し元と呼び出し先はIAMのポリシーにARNで列挙するので、
  信頼ポリシーとインラインポリシーの大きさのクォータが先に上限になる。ARNのパターンやroleのタグで一致させればポリシーは短くなるが、
  なりすましの経路を戻すことになる。
- 委任の範囲を、リクエストの種類と呼び出しの組ごとに、デプロイ時に決められる。
- 応答時間に、ホップごとのSTSへの往復の分の余裕がある。
- アカウント全体のSTSのAPIの呼び出し回数が、そのクォータに収まる（[内部FAQ Q4](#q4-技術的に未解決なことは何か)）。

向かないのは、サービスメッシュの代わりに数十から数百のサービスの通信すべてに使う場合、リソースや値の単位の制約をトークンで強制したい場合
（[Q8](#q8-この設計が守らないものは何か)）、応答時間の目標が厳しい同期の経路が多い場合である。

向かないと判断した場合も、この参照実装は比較の材料になる。認可サーバーを置く構成と比べて、何を運用せずに済み、代わりに何を払うのかを、
実測した値で比べられる。

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

中央の認可判定は、この参照実装と組み合わせられる（[外部FAQ Q9](#q9-amazon-verified-permissionsやcedaraws-verified-accessとどう関係するのか)）。

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

**最大の不確実性だった2ホップ目以降への伝播は、実機で確かめ、参照実装で実現した。**

実現性検証で確かめたのは1ホップ目までだった。受信側のLambdaは自分の実行roleで動くため、
そのLambdaがさらに次を呼ぶとき、元のユーザーのSourceIdentityは自然には引き継がれない。
偽装されずに引き継げたのはrole chainingだけだった（[方式比較](../../experiments/multi-hop-propagation/RESULTS.md)）。

ただし、受け渡すセッションで次のホップを直接呼ぶ形では、漏れると外から使え、侵害されたホップが次のホップを飛ばすこともできた。
Token Exchangeと同じく「どのサービスから来たか（actor）」と「誰の代理か（subject）」を分け、入口のIAMは呼び出し元の実行roleだけを許し、
ユーザーはSTSが署名したJWTで伝える形にすると、受け渡すセッションは漏れても呼べるサービスがなく、ホップの飛ばしも入口で拒否された
（[Token Exchange相当の構成](../../experiments/actor-subject-jwt/RESULTS.md)）。VPCも要らない。
ホップごとのscopeとリクエストの目的も、認可サーバーなしでSTSとIAMに強制させられた（[検証](../../experiments/scope-tags/RESULTS.md)）。

残る制約とリスク：

- **処理時間の上限**：role chainingで作るセッションと、STSが発行するJWTには有効期間がある。長い対話や非同期ジョブは、
  リクエストを分けるか、別の仕組みが要る。
- **業務上のアクセス権の判定は各サービスのコードに残る**：権限をトークンに入れなければsession tagsの上限（最大50個、値は単一値のみ）には
  縛られないが、判定のたびに権限のデータ源への問い合わせが加わり、判定のロジックは各サービスに散らばる（Cedarとの関係は[外部FAQ Q9](#q9-amazon-verified-permissionsやcedaraws-verified-accessとどう関係するのか)）。
- **scopeの絞り込みは、デプロイ時の宣言で決まる**：Token Exchangeのように、実行時の状況に応じて絞ることはできない。
- **STSへの呼び出しは毎ホップ残る**：認可サーバーへの往復はなくなるが、STSのスロットリングは見積もる必要がある。
  `AssumeRole`の呼び出し回数の上限は文書にあるが、ホップへの呼び出しのたびに使う`GetWebIdentityToken`と、ログインの
  `AssumeRoleWithWebIdentity`の上限は、文書にもService Quotasにもなく、確認できなかった。
- **AWSへのロックイン**：AWS外との相互運用には、`GetWebIdentityToken`などでの変換が必要になる。
  受け手には「ユーザーは`sub`（roleのARN）ではなく`source_identity`で表される」と取り決めてもらう必要がある。
- **受信側の実装の正しさ**：入口のIAMが確かめるのはactorだけで、JWTの検証は各サービスが正しく実装する必要がある。共通部品として提供する。
- **レイテンシ**：ホップごとにSTSの呼び出し（chainとJWTの発行）が加わる。認可サーバーとの往復をSTSとの往復に置き換えた形で、
  回数は減らない。認可サーバーを近くに置いた構成より遅くなりうる。目標値は置かず、実測した値を公開している
  （JWTの発行と検証の実測は[Token Exchange相当の構成](../../experiments/actor-subject-jwt/RESULTS.md)、目的を刻むchainの実測は[検証](../../experiments/scope-tags/RESULTS.md)）。
- **ブラウザの扱い**：ブラウザは秘密を保持できず、呼び出し元として確かめられない。サーバー側の入口（BFF）が要る。
- **初版の範囲**：同期呼び出し・単一アカウント・AWS内部のホップ間に限る。非同期処理、複数アカウント、外部サービスへのユーザーの証明の受け渡しは、
  将来の拡張とする。

### Q5. 何をもって成功とするか。

- 参照実装を`cdk deploy`したエンジニアが、付属のシナリオで「正規の呼び出しは通り、偽装と
  エージェントの誘導は、入口のIAMか、STSの署名を検証する受信側に拒否される」ことを自分の手で確かめられる。
- 設計ガイドを読んだエンジニアが、自分のシステムで「誰がAuthorization Contextを作っているか」
  「途中のサービスやAIがそれを書き換えられるか」に答えられるようになる。
- 記事化と、リポジトリへのフィードバック（issue、フォーク、利用報告）。

### Q6. 何をスコープ外にするか。

- Lambda以外のコンピュート（ECSなど）。
- Cognito以外のIdPの検証。
- 業務RBACの持たせ方の一般論。参照実装では、属性サービスが人事データと権限マスタを読む1つの例を示すにとどめる。
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
- [Amazon Verified Permissions: identity sources](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources.html)（2026-10-01に検証済み：CognitoとOIDCのトークンを主体と属性に対応づける）
- [AWS Verified Access: user claims passing](https://docs.aws.amazon.com/verified-access/latest/ug/user-claims-passing.html)（2026-10-01に検証済み：`x-amzn-ava-user-context`にES384で署名したJWT）
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
