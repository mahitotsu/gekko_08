# 設計ガイド

この参照実装を自分のシステムに当てはめるエンジニアに向けて、仕組み、各判断の根拠、当てはめ方、この構成が守らないものを説明する。
構成の詳細は[設計書](design/architecture.md)に、判断の経緯は[ADR](adr/)に、実機での観測は[検証記録](../experiments/)にある。

## 1. 解く問題

マイクロサービスやAIエージェントが多段に呼び合うと、最初にログインしたユーザーの権限が、奥のホップに届くまでに失われたり、
すり替わったりしやすい。ユーザーIDをヘッダーで渡せば途中のホップが書き換えられ、アクセストークンを丸ごと転送すれば宛先（`aud`）を
確かめられず、委任の範囲（scope）も絞れない。OAuth Token Exchangeは正攻法だが、認可サーバーを運用する必要がある。

この参照実装は、Token Exchangeと同じことを、認可サーバーもサイドカーも置かずに、Cognito・STS・IAM・Lambdaだけで実現する。
各ホップは、受け取ったリクエストについて次の4つを確かめられる。

| 確かめること | Token Exchangeでの担い手 | この参照実装での担い手 |
|---|---|---|
| 誰の代理か（subject） | トークンの`sub` | STSが署名したJWTの`source_identity` |
| どのサービスから来たか（actor） | 呼び出し元のクライアント認証 | 入口のIAM（呼び出し元の実行roleと関数） |
| 自分宛てか | トークンの`aud` | JWTの`aud` |
| 委任の範囲 | トークンの`scope`（交換のたびに絞る） | 取引の目的（`principal_tags.purpose`）とホップごとのscope（`request_tags.scope`）。値はIAMが強制する |

そのうえで、業務的なアクセス権（このユーザーはこのデータを扱ってよいか）はトークンに入れず、属性サービスから判定のときに得る。

### 特殊詐欺の手口に置き換えると

多段呼び出しで起きることは、特殊詐欺の手口とよく似ている。どの手口も、相手が確かめようのない自己申告を信じさせる。
この参照実装は、各ホップが自己申告ではなく、AWSが保証する値で確かめるようにする。

| 手口 | 偽るもの | 多段呼び出しで起きること | この参照実装で確かめるもの |
|---|---|---|---|
| 「消防署の方から来ました」（消火器の訪問販売） | どこから来たか | 呼び出し元のサービスを名乗るヘッダー | 入口のIAMが、呼び出し元の実行roleと関数を確かめる（actor） |
| 同上（データの中での名乗り） | 誰の権限で頼んでいるか | 本部や管理者を名乗る、データの中の指示（デモの案件メモ） | 名乗りは判定に使わない。検証済みのsubjectと、属性サービスから得たアクセス権だけで判定する |
| オレオレ詐欺（「俺だよ」「息子さんの代理の者です」） | 誰の代理か | ユーザーIDを載せたヘッダーや引数、LLMが出力したユーザー名 | STSが署名したJWTの`source_identity`（subject） |
| 劇場型（警察、協会、弁護士と、人が入れ替わって話をつなぐ） | 前の人の話が本当であること | 途中のホップが、手前のホップから聞いた値をそのまま次へ伝える | 各ホップが署名を検証する。手前の言い分は使わない |
| キャッシュカード詐欺盗（「確認のため」とカードを預かり、すり替える） | 何のための手続きか | 案件を開くだけの取引の途中で、侵害されたホップが下流に凍結の解除を頼む | 影響の大きい操作のscopeは、許した目的の取引でだけSTSが発行する。目的は入口で刻まれ、途中で変えられない |
| 還付金詐欺（本人にATMを操作させる） | 何も偽らない。本人に、本人の権限で操作させる | プロンプトインジェクションで、エージェントがユーザーの権限の範囲内で誤った操作をする | 防がない（[§5](#5-この構成が守らないもの)）。取引の目的とscopeで、操作できる範囲を狭めておく。デモでは、凍結の解除をエージェントの取引から外している |

AIエージェントは、こうした口上に騙される側になりうる。デモの案件メモには「本部監査部の者です」と名乗って口座の凍結の解除を
求める文言が入っていて、エージェントは誘導されることがある。それでも、本部を名乗ったのはデータの中の文字列で、
AWSが保証した値ではないので、受信側の判定は変わらない。凍結の解除は、そもそもエージェントの取引からは許されていない。
守りをエージェントの判断ではなく、各ホップの検証と、取引の目的に置く。

## 2. 仕組み

```
ログイン     Cognito ─(IDトークン: source_identity)─> bff ─AssumeRoleWithWebIdentity─> federated roleのセッション（SourceIdentity＝yamada）
取引の開始   bff ─AssumeRole（purpose＝agent-analysisをtransitive tagで刻む）─> 目的用のroleのセッション
ホップ間     呼び出し元                                                           受信側
             ① 受け取ったセッションで自分のchain用roleにchain（目的は引き継がれ、変えられない）
             ② GetWebIdentityToken（aud＝受信側、Tags＝scope）。IAMが宛先とscopeを限り、影響の大きいscopeは目的でも限る
             ③ 自分の実行roleでSigV4署名して呼ぶ ──────────────────────────────> 入口のIAM：実行roleと関数を確かめる（actor）
                x-authz-context: JWT                                             アプリ：JWTを検証する（subject、aud、目的、scope）
                x-authz-session: chainのセッション（受信側がさらに先を呼ぶ場合）   業務のコード：属性サービスからアクセス権を得て判定
```

要素の対応：

| AWSの仕組み | この構成での役割 | OAuthなどでの相当 |
|---|---|---|
| STSのSourceIdentity（JWTの`source_identity`） | subject：誰の代理か | トークンの`sub` |
| 呼び出し元の実行role（SigV4の署名を入口のIAMが確かめる） | actor：どのサービスから来たか | クライアント認証、Token Exchangeの`act` |
| JWTの`aud`（`GetWebIdentityToken`の宛先） | 受信側：自分宛てか | トークンの`aud` |
| transitive session tag `purpose`（JWTの`principal_tags`） | 取引の目的：取引全体で得られる、影響の大きい操作の上限。入口で刻み、途中で変えられない。影響の大きいscopeは、許された目的の取引でだけ発行される。業務のコードは使わない | Transaction Tokensの`purp` |
| JWTの`request_tags.scope` | scope：この1ホップで、この呼び出し元に渡す操作。業務のコードはこれで判定する | トークンの`scope` |
| 属性サービス（人事データ、権限マスタ） | 今の業務的なアクセス権：このユーザーはこのデータを扱ってよいか | リソースサーバーが持つ権限のデータ（トークンには入れない） |

用語：

| 用語 | 意味 |
|---|---|
| ホップ | 呼び出しの連鎖の1つ。Lambdaの関数と、`AWS_IAM`認証のFunction URL |
| 実行role | 各ホップの関数のrole。ホップを呼ぶ（SigV4で署名する）のはこのroleで、入口のIAMはこれで呼び出し元（actor）を確かめる |
| federated role | bffが、ユーザーのIDトークンで`AssumeRoleWithWebIdentity`するrole。SourceIdentityが刻まれる |
| 目的用のrole | bffが、federated roleのセッションからchainし、取引の目的をtransitive session tagとして刻むrole |
| chain用role | 呼び出し先を持つホップごとのrole。受け取ったセッションからchainし、次のホップ宛てのJWTを作ることだけができる |
| 受け渡すセッション | 呼び出し元が`x-authz-session`で渡すchainのセッション。漏れても、どのホップも呼べない |
| 取引の目的（purpose） | 入口が経路ごとに決める、何のための取引か。途中で変えられない。取引全体で得られる、影響の大きい操作の上限として使う |
| scope | 呼び出し元と呼び出し先の組ごとに宣言する、呼び出し元に許す操作。JWTに付く |
| 属性サービス | 本人の業務的なアクセス権（所属、役職ごとの権限）を返すホップ |

認可の根拠は3つの層に分ける。

| 層 | 問い | 担い手 |
|---|---|---|
| 1. 身元 | 誰の代理か、どのサービスから来たか、自分宛てか | SourceIdentity、入口のIAM、JWTの`sub`と`aud` |
| 2. 委任の範囲 | この取引で、この呼び出し元に何を許すか | 取引の目的とホップごとのscope。IAMが強制する |
| 3. 業務的なアクセス権 | このユーザーは、このデータを扱ってよいか | 属性サービス（人事データと権限マスタ） |

判定は、**委任の範囲が操作を許し、かつ業務的なアクセス権がデータを許す**ときだけ許す。Microsoft Entra IDの委任された権限で
「実効権限はアプリに許した範囲とユーザー自身の権限の積集合」とするのと同じ考え方である。

要点：

- **ユーザーと取引の目的は、リクエストごとに入口で刻む。** SourceIdentityとtransitive session tagは、role chainingで途中のホップが変えられない。
- **呼び出しの許可（actor）とユーザーの証明（subject）を分ける。** ホップを呼ぶ権限は各ホップの実行roleにだけあり、ユーザーの代理の
  セッションは、IAMが許した宛先・目的・scopeのJWTを作ることしかできない。
- **委任の範囲はコードではなくIAMのポリシーが強制する。** 宣言していないscopeや、許していない目的の取引での影響の大きい操作のscopeは、STSが発行しない。
  業務のコードはscopeだけを見て、目的は使わない。
- **業務的なアクセス権はトークンに入れない。** 属性サービスが判定のたびに人事データを読むので、異動や権限の剥奪が次のリクエストから効く。
- **判断は受信側のアプリが、検証済みの値と属性サービスの値だけで行う。** ヘッダーや引数、LLMの出力からユーザーを読まない。

## 3. 各判断の根拠

| 判断 | 根拠 | 詳細 |
|---|---|---|
| ユーザーと目的はSourceIdentityとtransitive session tagで運ぶ | role chainingでのみ偽装されずに引き継げた。受信側が設定し直す方式は偽装が成立し、JWTでIAMセッションに戻す方式はIAMが拒否した | [多段伝播のADR](adr/20260930064314-multi-hop-authorization-context-propagation.md)、[方式比較](../experiments/multi-hop-propagation/RESULTS.md) |
| 委任の範囲を、取引の目的とホップごとのscopeの2つで表す | 目的（Transaction Tokensの`purp`に相当）だけでは同じ取引の中でホップごとに絞れず、scope（Token Exchangeのdownscopingに相当）だけでは元の取引の目的に沿っているかを強制できない。どちらもIAMで強制できた | [委任の範囲と業務的なアクセス権のADR](adr/20260930150529-delegation-scope-and-entitlements.md)、[検証](../experiments/scope-tags/RESULTS.md) |
| 目的は、影響の大きいscopeの発行を限るためだけに使い、業務のコードは使わない | scopeと呼び出し元が効くのは1ホップ分だけで、複数の経路が共有するホップが侵害されると、経路をまたいで権限を持ち出せる。それを止めるのが目的である。一方、すべてのscopeを目的に縛ったり、業務のコードが目的を見たりすると、目的の追加や削除がすべてのサービスに及ぶ | [委任の範囲の定義のADR](adr/20261001130745-delegation-definitions.md)、[検証](../experiments/scope-tags/RESULTS.md)のE4 |
| 業務的なアクセス権は属性サービスから得る | トークンに入れると変更がトークンの更新まで効かず、セッションタグの制約（最大50個、値は単一の文字列）に収まる権限しか表せない | 同上のADR |
| 属性サービスは本人のアクセス権だけを返す | 照会する相手を引数に取らないので、誘導されたエージェントや侵害されたホップが他人の権限を問い合わせられない | 同上のADR |
| 受け渡すセッションでホップを呼ばない | セッション自体に呼び出し権限があると、漏れたときに外から使え、侵害されたホップが次のホップを飛ばせる | [Token Exchange相当の構成](../experiments/actor-subject-jwt/RESULTS.md) |
| 入口で「許可したrole以外」を明示的にDenyする | 同じアカウントでは、resource policyが許可していなくても、呼び出し元のidentity policyの広い許可で呼べた | 同上 |
| 呼び出し元の関数も限る（呼び出し元の実行roleのDenyで、`lambda:SourceFunctionArn`を使う） | 同じ実行roleを共有する別の関数からの呼び出しを区別できた。このキーはresource-based policyでは使えないので、呼び出し元の側に置く | [置き場所のADR](adr/20261001094443-source-function-arn-in-caller-identity-policy.md)、[検証](../experiments/source-function-arn/RESULTS.md) |
| JWTの`sub`を呼び出し元と照合する | 入口を通った呼び出し元と、JWTを作ったchain用roleが対応していることを確かめ、別経路で作られたJWTの持ち込みを防ぐ | [設計書§6](design/architecture.md#6-受信側の共通部品と判定) |
| 入口はBFFにし、ブラウザには認証情報を持たせない | ブラウザは秘密を保持できない。ブラウザには実行roleがなく、actorを確かめられない。取引の目的を決める場所としても、サーバー側の入口が要る | [入口のADR](adr/20260930083437-entry-via-bff.md) |
| IdPはCognito User PoolとPre Token Generation V2 | 1回の`AssumeRoleWithWebIdentity`でSourceIdentityを設定できる | [IdPのADR](adr/20260930091026-idp-cognito-user-pool.md) |
| ホップ間はFunction URLの`AWS_IAM`認証で、mTLSは使わない | 参加資格をネットワークではなくIAMで守れる。SPIREのような常駐コンポーネントが要らない | [コンピュートと通信のADR](adr/20260930091257-lambda-function-url-without-mtls.md) |
| エージェントはClaude Agent SDKで作り、MCPは関数の中の中継から共通部品で呼ぶ | 広く使われているフレームワークでも同じ境界を保てることを示す。SDKのMCPには固定のヘッダーしか付けられないので、認証情報を持つ親のプロセスが中継する。中継をHTTPにすると、トレースの親子関係も一続きになった | [Claude Agent SDKのADR](adr/20261001040729-fraud-agent-on-claude-agent-sdk.md)、[検証](../experiments/agent-frameworks/RESULTS.md) |
| トレースはOTLPで出し、関数の中のSDKが署名してCloudWatchに直接送る。メトリクスは出さず、件数や時間はログから集計する | 常駐するものも固定費もなく、レイヤーや拡張機能も要らない。実測で、直接送信はADOTのレイヤーやコレクターのレイヤーより要件に合った。子プロセス（Claude Code）のトレースも親が署名して転送できる | [収集先のADR](adr/20261001020115-telemetry-destination-cloudwatch.md)、[送り方のADR](adr/20261001053646-telemetry-direct-export.md)、[検証](../experiments/otel-export/RESULTS.md) |
| MCPサーバーもOAuthではなく他のホップと同じ入口で守る | ホップの仕組みを1種類にできる。MCPの仕様で認可は任意（OAuthは推奨） | [エージェントとMCPのADR](adr/20260930093746-agent-and-mcp-on-lambda.md) |

### 委任の範囲の決め方

Token Exchangeでは、認可サーバーがトークンを交換するたびに`scope`を絞る。この参照実装では、同じ判断を**3つの定義とIAMのポリシー**に置き、
定義のオーナーを分ける。

| 定義 | オーナー | 書くこと |
|---|---|---|
| 目的の一覧 | 入口（bff） | 取引の種類。参照実装では`profile`（本人の表示）、`case-summary`（案件を開く）、`account-unfreeze`（凍結を解除する）、`agent-analysis`（エージェントによる分析） |
| 提供側の定義 | APIを提供するサービス | 提供するscope。影響の大きい操作のscopeには、使ってよい目的と、必要なら使ってよい呼び出し元（目的の制限があるscope） |
| 利用側の定義 | APIを使うサービス | 呼び出し先ごとに、付けたいscope |

- 合成のときに3つを突き合わせ、整合しなければ合成を失敗させる。CDKが、宣言したscopeしか付けさせない権限と、目的の制限があるscopeを
  許した目的の取引でしか付けさせない権限を生成する。
- 提供側は、普通のscopeについては利用者を知らなくてよい。影響の大きいscopeについてだけ、目的と呼び出し元で限る。参照実装で目的に縛るのは、
  凍結の解除の2つのscope（`case:unfreeze`、`account:unfreeze`）だけである。
- 目的は、取引の種類として少数に保つ。目的の追加や削除の影響は、目的の一覧、入口、その目的を名指しする提供側の定義に限られる。
- 業務のコードは、呼び出しごとにscopeを指定し、受け取ったscopeだけで操作を判断する。目的で振る舞いを変えたくなったら、scopeを分けて、
  提供側の定義で目的を限る。
- 利用側の定義は、実質的に呼び出しの許可になる。利用側の定義の変更は、提供側（またはセキュリティの担当）がレビューする。

## 4. 自分のシステムへの当てはめ方

### 前提

- 単一のAWSアカウントで、ホップはLambda（Function URL）であること。
- IAMのアウトバウンドIDフェデレーションを有効にすること（アカウント全体の設定。[README](../README.md#前提条件)）。
- トレースを使うなら、CloudWatchのTransaction Searchを有効にすること（アカウント全体の設定。同上）。
- 1回のリクエストの処理が各ホップで15分以内に収まること（chainのセッションの有効期間）。

### 手順

1. **取引の目的を決める。** 入口の経路ごとに、何のための取引かを決める（[services/bff/authz.ts](../services/bff/authz.ts)の`PURPOSES`）。少数に保つ。
2. **業務的なアクセス権のデータ源を決める。** 属性サービス（[entitlement-service](../services/entitlement-service/src/index.ts)）が、
   自分のシステムの人事データや権限マスタを読むようにする。本人の分だけを返す形は変えない。
3. **ホップを定義する。** 他のホップ（属性サービスを含む）を呼ぶなら`callsOthers: true`にする。chain用roleが作られる。

   ```ts
   const orders = new Hop(this, 'Orders', { hopName: 'orders', entry: 'services/orders/src/index.ts', issuer, callsOthers: true });
   ```

4. **委任の範囲を定義する。** サービスごとに`authz.ts`を置き、提供するscopeと、呼び出し先ごとに付けたいscopeを書く。
   スタックの`connectHops`が定義を突き合わせ、入口のresource policy、chain用roleの信頼とchainの権限、JWTの発行の権限（宛先、scope、目的の制限）、
   `sub`の対応表、受信時の照合の設定をまとめて生成する。

   ```ts
   // services/orders/authz.ts
   export const authz: DelegationDefinition = {
     hop: 'orders',
     provides: {
       'orders:read': {},
       'orders:cancel': { purposes: ['order-cancel'], callers: ['case-service'] }, // 影響の大きい操作だけ目的で限る
     },
     consumes: { 'entitlement-service': ['entitlements:read'] },
   };
   ```

   呼び出し元（この例ではcase-service）の`authz.ts`の`consumes`にも`orders`を加える。定義は[app-stack.ts](../infra/lib/app-stack.ts)の
   `DELEGATION_DEFINITIONS`に、ホップは`connectHops`に渡すホップの表に加える。整合しなければ、合成が失敗して理由を示す。

5. **業務のコードを書く。** `createHopHandler`に業務の関数を渡す。受け取るのは検証済みの`subject`・`actor`・`scope`と、
   次のホップを呼ぶ`call`だけで、JWTも認証情報も、取引の目的も扱わない。scopeで操作を、属性サービスのアクセス権でデータを判定する。
   次のホップを呼ぶときは、付けるscopeを指定する（呼び出し先に1つしか求めていなければ省ける。例：`call('orders', body, { scope: 'orders:cancel' })`）。
   AWS SDKのクライアントは`traceAwsClient`で包み、呼び出しをトレースに出す。

   ```ts
   export const handler = createHopHandler(async (body, { scope, call }) => {
     if (scope !== 'orders:read') return { status: 403, body: { error: 'forbidden' } };
     const ent = await call('entitlement-service', {});
     if (ent.status !== 200) return { status: 403, body: { error: 'forbidden' } }; // 得られなければ拒否する
     const order = await loadOrder(body.orderId);
     if (order.branch !== (ent.body as { branch: string }).branch) return { status: 403, body: { error: 'forbidden' } };
     return { status: 200, body: { order } };
   });
   ```

6. **エージェントは、MCPの呼び出しを共通部品に通す。** フレームワークのMCPクライアントが、他のホップと同じ入口を通るようにする。
   JWTはリクエストごと、宛先ごとに作るので、固定のヘッダーでは渡せない。フレームワークに応じて2つの形がある
   （[検証](../experiments/agent-frameworks/RESULTS.md)）。

   | 形 | 当てはまるフレームワーク | 使う部品 |
   |---|---|---|
   | 直接型 | MCPクライアントに通信路を渡せるもの（MCPのSDKの`Client`、Strands Agentsなど） | `HopMcpTransport`を渡す |
   | 中継型 | 固定のヘッダーしか付けられないもの（Claude Agent SDKなど） | `startMcpRelay`で`127.0.0.1`に中継を立て、そのURLをHTTPのMCPサーバーとして渡す |

   ```ts
   import { startMcpRelay } from '@gekko08/authz-context/mcp';
   const relay = await startMcpRelay(call, 'orders-mcp');
   // query({ prompt, options: { mcpServers: { orders: { type: 'http', url: relay.url } }, ... } })
   await relay.close();
   ```

   エージェントのテレメトリは、ホップのトレースにつなぐ。子プロセスで動く場合は、`startOtlpTraceRelay`の受け口を送り先にし、
   親のプロセスが署名して転送する。エージェントが本文（プロンプト、ツールの入出力）を記録しない設定になっているかを確かめる。
   エージェントが子プロセスで動く場合（Claude Agent SDK）は、子プロセスに認証情報を渡さない。モデルを呼ぶのに要る認証情報は、
   モデルの呼び出しだけを許すroleのものにし、組み込みのツール（シェルやファイルの読み書き）を無効にする（[fraud-agent](../services/fraud-agent/src/index.ts)）。
7. **データは各ホップの実行roleで読み書きする。** ユーザーの権限でAWSリソースに直接アクセスすることは扱わない（要件定義のスコープ外）。
8. **シナリオテストを要件にひも付ける。** [tests/scenario](../tests/scenario/)を参考に、正しいユーザーが通ること、アクセス権のないユーザー、
   目的やscopeに合わない呼び出し、飛ばした呼び出し、許可していない主体が拒否されることを確かめる。影響の大きいscopeは、許していない目的の取引の
   chain用roleのセッションから発行できないことも確かめる（[unfreeze.test.ts](../tests/scenario/unfreeze.test.ts)）。

### 守るべき規律

- 入口のresource policyとJWTの発行の権限を手で書かない。`Hop`を通さずに書くと、Denyや条件の書き漏らしがそのまま穴になる。
- `GetWebIdentityToken`の宛先を、内部のホップに限る。外部のサービスがこのJWTを単独で信じると、そこではユーザーになりすませる。
  `Hop`は宛先を`ForAllValues:StringEquals`と`Null`で絞る。`ForAnyValue`で書くと、許した宛先に外部の宛先を混ぜたJWTを発行できる
  （[検証](../experiments/scope-tags/RESULTS.md)）。
- scopeや目的のないJWTを受け入れない。共通部品は拒否する。
- 業務のコードで目的を使わない。目的で振る舞いを変えたいときは、scopeを分ける。
- 属性サービスが使えないときは拒否する（fail closed）。
- 受け渡すセッションとJWTをログや応答に出さない。共通部品は出さないが、業務のコードで`event`全体をログに出すと漏れる。
- Pre Token Generationトリガー、User Poolの設定、属性サービスのデータを守る。SourceIdentityの値はこのLambdaが決め、AWSは値の正しさを
  検証しない。業務的なアクセス権は属性サービスのデータがすべてを決める。

## 5. この構成が守らないもの

### 侵害された要素ごとの影響

この構成は、どの要素も侵害されないことを前提にしない。要素ごとに、侵害されたときにできることとできないことを示す。
「処理中のリクエスト」は、そのホップが受け取ったchainのセッション（有効期間15分）とJWT（同5分）の範囲を指す。

| 侵害された要素 | できること | できないこと |
|---|---|---|
| 外部の主体（インターネット） | ホップのFunction URLには、公開の経路から到達できる | 署名（SigV4）なしでは、どのホップも呼べない（403）。bffはCloudFront経由で呼べるが、セッションcookieがなければ拒否する |
| 同じアカウントの、許可していない主体（広い権限を持つroleを含む） | — | どのホップも呼べない。入口のresource policyが、許可した実行role以外をDenyする（SR-2） |
| 途中のホップ（業務のコードの乗っ取り） | 処理中のリクエストについて、そのユーザーとして、自分に許された呼び出し先を、自分に許されたscopeで呼べる。自分の実行roleで、自分のデータを読み書きできる。下流に渡すリクエストID（ヘッダーと、chainとJWTの発行の`RoleSessionName`）を別の値にできる。リクエストIDは追跡のための値で、STSもIAMも強制しない | ユーザー（SourceIdentity）と取引の目的を変えること。許されていない呼び出し先を呼ぶこと（ホップを飛ばすことを含む）。宣言していないscopeを付けること。**目的の制限があるscopeを、その取引の目的が許さないときに付けること**（例：案件を開く取引やエージェントの取引のcase-serviceは、凍結の解除のJWTを発行できない）。他人のアクセス権を属性サービスに問い合わせること |
| 共通部品と同じプロセスのアプリ | 途中のホップの乗っ取りと同じ。共通部品はアプリと同じプロセスで動くライブラリなので、アプリが乗っ取られると、受け渡されたセッションも実行roleの認証情報も読める | 同上 |
| エージェントの子プロセス（Claude Code） | 誘導された場合：中継を通して、fraud-mcpのツールを、ユーザーの代理として、エージェントの取引（`agent-analysis`）で呼べる。任意のコードを実行させられた場合：親と同じ実行環境、同じOSのユーザーで動くので、親の持つ認証情報を読みうる。そうなると、fraud-agentのホップの乗っ取りと同じになる。トレースの受け口を通して、アカウントのトレースに任意のスパンを書き込める | 誘導された場合：ツールの範囲を越えること。凍結の解除は、fraud-mcpが付けられるscopeにないので拒否される。他の支店のデータは、業務的なアクセス権で拒否される |
| BFF | ログイン中のユーザーのIDトークンとリフレッシュトークンを持ち、取引の目的を決める。セッションのあるユーザーとして、定めた目的のどれででも（凍結の解除の取引を含む）最初のホップを呼べる。BFFは最も価値の高い構成要素である | ログインしていないユーザーになりすますこと（Cognitoが署名したIDトークンが要る）。定めていない目的を刻むこと。最初のホップ（case-service、fraud-agent、属性サービス）以外を直接呼ぶこと |
| 属性サービスとそのデータ | 業務的なアクセス権は、属性サービスのデータがすべてを決める。書き換えられると、そのとおりに判定される（例：担当者に解除の権限を与える） | 委任の範囲を広げること。目的とscopeはIAMが強制するので、データを書き換えても、エージェントの取引で凍結を解除させることはできない |
| 実行環境の外に持ち出した認証情報 | 実行roleの認証情報と受け渡されたセッションの両方を持ち出すと、有効期限内は、そのホップとして次のホップを呼べる。呼び出し元の関数の限定（`lambda:SourceFunctionArn`）では防げない。関数のARNは認証情報そのものに刻まれており、持ち出した認証情報で呼んでも、その関数からの呼び出しとして扱われた（[検証](../experiments/source-function-arn/RESULTS.md)） | 受け渡されたセッションやJWTだけでは、どのホップも呼べない（SR-1）。呼び出しには、呼び出し元の実行roleの署名が要る |
| Pre Token Generationトリガー、User Poolの設定 | SourceIdentityの値は、このLambdaが決める。AWSは値の正しさを検証しない。任意のユーザーとして振る舞える | — |
| アカウントの管理者 | IAMの権限を持つ主体は、resource policyや信頼ポリシーを書き換えられる | — 管理者に対する境界は、アカウントの分離やSCPで作る必要がある |

#### エージェントの子プロセスの隔離は、能力の隔離である

fraud-agentは、子プロセスに認証情報を渡さない。ただし、それは環境変数の範囲での話で、OSの境界ではない。子プロセスは親と同じ実行環境、
同じOSのユーザーで動くので、任意のコードを実行できれば、親のメモリやファイルから認証情報を読みうる。

この構成が置く境界は、**認証情報の隔離ではなく、能力の隔離（子プロセスに任意のコードを実行させない）**である。組み込みのツール（シェル、ファイルの
読み書き）を無効にし、使えるのは中継のツール（`mcp__fraud__*`）だけにしている。この設定が崩れると、子プロセスの乗っ取りは、fraud-agentの
ホップの乗っ取りと同じになる。より強い境界が要る場合は、子プロセスを使わずに、親のプロセスがモデルを直接呼ぶ構成にする。

### そのほかに守らないもの

| 守らないもの | 内容 |
|---|---|
| エージェントの判断 | プロンプトインジェクションでエージェントが誤った要求をすることは防がない。防ぐのは、その要求が委任の範囲とユーザーの権限を超えること |
| 人間が操作したことの証明 | 凍結の解除の取引で示せるのは、「エージェントの取引からは解除できない」ことである。取引の目的を決めるのはBFFなので、BFFが侵害されれば、どの目的でも刻める |
| 途中での取り消し | 発行済みのJWT（有効期間5分）とchainのセッション（15分）は、途中で取り消さない。ログアウトはBFFのセッションを消し、リフレッシュトークンを取り消すまで。業務的なアクセス権の変更は、次のリクエストから効く |
| 権限の範囲内での大量アクセス | レート制限や異常検知は、別の仕組みで扱う |
| アプリからの認証情報の隔離 | 共通部品をアプリから隔離しない。k8sでEnvoyなどのサイドカーに任せる構成と違い、Lambdaでは関数とExtensionが同じ実行環境で動くので、Extensionに分けても、乗っ取られたアプリに対する境界にはならない見込み（未検証） |
| 持ち出した認証情報の使用場所 | 使用場所を縛る手段として、IPv6の送信元アドレスで縛れることは確かめたが、ホップのLambdaをVPCにつなぐ必要がある（[IPv6送信元による縛り](../experiments/network-binding/RESULTS.md)）。参照実装は縛らない |

補足：

- 受け渡すセッションは、漏れてもどのホップも呼べないように作ってある（SR-1）。守るべきものが小さいので、アプリからの隔離の
  価値は、ワークロードの鍵そのものを守るk8sのサイドカーより小さい。
- テストのために、アプリクライアントで`ADMIN_USER_PASSWORD_AUTH`を有効にしている。呼ぶにはIAMの権限が要り、ブラウザからは使えないが、
  本番で使うなら無効にしてよい。
- 各ホップのログとトレースのスパン（`enduser.id`）には、ユーザーの識別子と取引の目的が出る。個人情報の扱いは、自分のシステムの方針に合わせる。
- 業務的なアクセス権の判定を1か所に集めたい場合は、各ホップのコードの判定を、Amazon Verified Permissions（Cedar）のような判定サービスに
  任せる選択肢がある（[§7](#7-将来の拡張の方向)）。委任の範囲をIAMに強制させる部分は変わらない。

## 6. 運用

### 代償：運用は軽く、レイテンシは軽くない

- **運用は軽い**：認可サーバー、SPIRE、サイドカーのような常駐するものを持たない。鍵の管理と署名はSTSが行い、固定費はほぼない。
  運用で見るのは、IAMのポリシー（CDKが生成する）と、ログとトレースである。
- **レイテンシは軽くない**：ホップごとに、chain（`AssumeRole`）とJWTの発行（`GetWebIdentityToken`）がSTSへの往復として加わる。
  呼び出し先を持つホップごとに、ウォームでおよそ150ms（トレースの送信を含む）、画面からの1リクエストでは数百msになる（下の実測）。
  認可サーバーへの問い合わせをなくした代わりに、STSへの問い合わせが増える構成である。
- どちらを重く見るかは、システムによる。応答時間の目標が厳しい同期の経路が多い場合は、この代償を先に測る。

### トレースを見る

トレースは、CloudWatchのTransaction Searchで見る（スパンはロググループ`aws/spans`に入る）。各ホップのログの`traceId`で、1回のリクエストの
トレースを開ける。スパンの種類と属性は[設計書§7](design/architecture.md#7-追跡fr-6)にある。

- 1つのトレースは、bffの受信のスパンから始まり、各ホップの受信（SERVER）と送信（`call <呼び出し先>`）、その内訳（chain、JWTの発行）、
  AWS SDKの呼び出し（`DynamoDB.GetItem`など）が親子でつながる。エージェントの経路では、fraud-agentの受信の下にClaude Codeのスパン
  （`claude_code.*`）が入り、`tools/call`ごとのfraud-mcpへの送信がその下につながる。
- 受信のスパンの`authz.actor`・`authz.purpose`・`authz.scope`・`enduser.id`で、どの呼び出し元が、何の取引で、誰の代理で呼んだかがわかる。
  共通部品が拒否したときは、`authz.inbound`が`rejected`になり、`authz.reject_reason`に理由が入る。
- スパンの量（2026-10-01の実測）は、1リクエストあたり、案件を開く取引で32スパン・約27KB、エージェントの分析（ツールの呼び出し3回）で
  56スパン・約47KBだった。スパンはCloudWatch Logsとして取り込まれ、費用は量に比例する。

### ログで集計する

メトリクスは出さず、認可の判定の件数や処理時間は、各ホップの構造化ログからCloudWatch Logs Insightsで集計する。ログは1件1行のJSONなので、
フィールドをそのまま使える。対象のロググループには、bffと各ホップの関数のロググループ（`Gekko08App-*FunctionLogs*`）を選ぶ。

```
# 共通部品が受信の検証で拒否した件数（ホップと理由ごと）
filter message = "rejected"
| stats count(*) as rejected by hop, reason
| sort rejected desc

# ホップごとの結果（業務のコードによる403を含む）
filter message = "handled"
| stats count(*) as requests by hop, actor, purpose, status

# 処理時間の内訳（NFR-3）
filter message = "handled" and hop = "case-service"
| stats pct(timings.chainMs, 50) as chain, pct(timings.mintMs, 50) as mint, pct(timings.totalMs, 50) as total, pct(timings.totalMs, 90) as total_p90
```

- 入口のIAMが拒否した呼び出し（許可していない呼び出し元、署名のない呼び出し、ホップの飛ばし）は、関数に届かないので、関数のログにもトレースにも出ない。
  `rejected`に出るのは、入口のIAMを通ったあとに共通部品が拒否したもの（JWTがない、宛先や`sub`が合わない、目的やscopeがないなど）である。
- ログの`traceId`で、Transaction Searchのトレースを開ける。
- 常に見張る（アラームを出す）には、ロググループのメトリクスフィルターを加える。

### 監査で追う

「誰の代理の、どの取引の、どの呼び出しだったか」は、リクエストIDを軸に、業務のデータ、ログ、CloudTrail、トレースを突き合わせて追う。
例として、「口座A-101の凍結を、誰が、どの取引で解除したか」を追う。

1. **業務のデータからリクエストIDを得る。** account-serviceは、解除したユーザー（`unfrozenBy`）とリクエストID（`unfreezeRequestId`）を口座に記録する。

   ```sh
   export AWS_REGION=ap-northeast-1
   ACCOUNTS=$(aws cloudformation describe-stacks --stack-name Gekko08App --query "Stacks[0].Outputs[?OutputKey=='AccountsTable'].OutputValue" --output text)
   aws dynamodb get-item --table-name "$ACCOUNTS" --key '{"accountId":{"S":"A-101"}}' \
     --projection-expression 'unfrozenBy, unfrozenAt, unfreezeRequestId'
   ```

2. **ログで、各ホップが何を受け取ったかを見る。** Logs Insightsで、bffと各ホップのロググループ（`Gekko08App-*FunctionLogs*`）を選び、リクエストIDで引く。

   ```
   fields @timestamp, hop, route, user, subject.id, actor, purpose, scope, status, traceId
   | filter requestId = "<リクエストID>" and message = "handled"
   | sort @timestamp asc
   ```

   bffの行に経路（`route`＝`case-unfreeze`）と取引の目的、各ホップの行に検証したユーザー（`subject.id`）・呼び出し元（`actor`）・目的・scopeが出る。
   ログはアプリが書くものなので、次のCloudTrailで、AWSの側の記録と照らし合わせる。

3. **CloudTrailで、AWSが記録した事実と照らし合わせる。** chainとJWTの発行の`RoleSessionName`はリクエストIDなので、CloudTrailの`Username`で引ける
   （届くまでに最大15分ほどかかる。`lookup-events`で引けるのは90日まで）。

   ```sh
   aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=<リクエストID> \
     --query "Events[].CloudTrailEvent" --output text
   ```

   2026-10-01に解除の取引を引くと、次のイベントが出た（いずれも`userIdentity.sessionContext.sourceIdentity`はユーザー）。

   | イベント | 呼んだ主体（`userIdentity.arn`のrole） | 主な`requestParameters` |
   |---|---|---|
   | `AssumeRole` | federated role | `roleArn`＝目的用のrole、`tags`＝`purpose: account-unfreeze`（transitive） |
   | `GetWebIdentityToken` | 目的用のrole | `audience`＝case-service、`tags`＝`scope: case:unfreeze` |
   | `AssumeRole` | 目的用のrole | `roleArn`＝case-serviceのchain用role |
   | `GetWebIdentityToken` | case-serviceのchain用role | `audience`＝account-service、`tags`＝`scope: account:unfreeze` |
   | `AssumeRole`、`GetWebIdentityToken` | case-service、account-serviceのchain用role | 属性サービス宛て（`scope: entitlements:read`） |

   取引の目的はbffの`AssumeRole`の`tags`に、各ホップが下流に渡した委任の範囲は`GetWebIdentityToken`の`audience`と`tags`に、AWSの記録として残る。
   ログに書かれた目的とscopeが、これと一致することを確かめる。

4. **トレースで、呼び出しの順序と結果を見る。** ログの`traceId`で、Transaction Searchのトレースを開く（[トレースを見る](#トレースを見る)）。

補足：

- 「あるユーザーが期間内に何をしたか」は、ログを`subject.id`（bffでは`user`）で引く。CloudTrailの`lookup-events`は`sourceIdentity`で絞れないので、
  CloudTrailで引くなら、CloudTrail LakeやAthenaで`userIdentity.sessionContext.sourceIdentity`を条件にする。
- 影響の大きい操作が想定外の取引で行われていないかは、ログで定期的に確かめられる。参照実装では、次の照会の結果は常に空（0件）になるはずである
  （IAMが発行させず、共通部品も受け付けない）。2026-10-01に、シナリオテストのあとのログで空であることを確かめた。

  ```
  filter message = "handled" and scope = "account:unfreeze" and purpose != "account-unfreeze"
  | stats count(*)
  ```

- 入口のIAMで拒否された呼び出しは、関数のログにもCloudTrailのこれらのイベントにも出ない（Lambdaのデータイベントを記録していれば、そこに出る）。
- リクエストIDは、bffが付けて各ホップが引き継ぐ値で、STSもIAMも強制しない。乗っ取られたホップは、下流に渡すリクエストIDを変えられる（[§5](#5-この構成が守らないもの)）。
  ホップの侵害を疑うときは、リクエストIDで引いた結果だけに頼らず、CloudTrailの`sourceIdentity`（変えられない）、呼んだ主体（`userIdentity.arn`のrole）、時刻で突き合わせる。

### レイテンシの実測

2026-10-01、ap-northeast-1、Lambda（Node.js 24、arm64、512MB）で、マイクロサービスの経路（bff → case-service → account-service、
case-serviceとaccount-serviceはそれぞれ属性サービスも呼ぶ）を10回呼んだときのウォームの値（ミリ秒）。トレースを有効にした状態で測った。
シナリオテストのNFR-3が集計する。

| 場所 | 処理 | 中央値 | 90パーセンタイル |
|---|---|---|---|
| bff | `AssumeRoleWithWebIdentity` | 15 | 17 |
| bff | 取引の目的を刻むchain（`AssumeRole`） | 55 | 69 |
| bff | JWTの発行（`GetWebIdentityToken`） | 42 | 48 |
| 各ホップ | JWTの検証 | 1〜2 | 2〜16 |
| case-service・account-service | chain（`AssumeRole`） | 53〜67 | 68〜85 |
| case-service・account-service | JWTの発行（1回あたり） | 約40〜45 | 約55〜60 |
| entitlement-service | 処理全体（検証とDynamoDBの読み出し2回） | 10 | 19 |
| bff | 処理全体（画面からの1リクエスト。bff自身のトレースの送信は含まない） | 626 | 712 |

- 呼び出し先を持つホップの追加は、ウォームでおよそ110ms（chain約60ms、JWTの発行約45ms、検証数ms）。トレースの送信（約40ms）を含めると約150ms。呼び出し先を持たない終端のホップは検証だけで、数ms。
- 取引の目的を刻むことで、bffに約50msが加わる。
- 属性サービスの呼び出しは、呼ぶ側のJWTの発行（約45ms）と属性サービスの処理（約10ms）とネットワークで、1回あたりおよそ60〜80ms。
  chainは次のホップの呼び出しと共有する。
- トレースの送信は、各ホップが応答を返す前に行うので、ホップの呼び出し1回あたり約40ms（ウォーム）、呼び出し元から見た時間が延びる
  （[送り方のADR](adr/20261001053646-telemetry-direct-export.md)）。画面からの1リクエスト（ホップの呼び出し4回）では、bffの処理全体が
  トレースなしの470msから626msになり、これにbff自身の送信（約40ms）が加わる。
- コールドスタート直後は、JWTの検証に発行者のJWKSの取得が加わり、約340msかかった。
- エージェントの経路では、モデルの呼び出し（Claude Haiku 4.5）が1回あたり約1〜5秒かかり、認可の処理の追加は相対的に小さい。
  fraud-agentはClaude Codeを子プロセスとして起動するので、1回の分析（ツールの呼び出し3回）は全体で約10〜12秒、最大メモリは約500MBだった
  （[検証](../experiments/agent-frameworks/RESULTS.md)。コールドスタートの初期化は約0.6〜0.7秒）。
- 自分の環境では、`npm run test:scenario`の結果（`tests/out-latency.json`）で確かめる。

### 規模の上限

ホップが増えたときに先に上限になるのは、STSのリクエスト数と、1スタックのリソース数である。上限の一覧と、経路ごとのSTSの呼び出し回数は
[設計書§11](design/architecture.md#11-前提条件と制約)にある。

- 文書にある上限は、`AssumeRole`などが共有する毎秒600件（アカウント・リージョンごと）である。参照実装では、chainのたびに`AssumeRole`を呼ぶ。
  案件を開く取引では1リクエストで3回なので、アカウント全体でおよそ毎秒200リクエストが目安になる。
- JWTの発行（`GetWebIdentityToken`）は、ホップへの呼び出しのたびに行うので、`AssumeRole`より回数が多い。ところが、その上限は文書にも
  Service Quotasにも記載がない。ログインの`AssumeRoleWithWebIdentity`も同じである。大きな規模で使う前に、自分の構成で負荷をかけて、
  スロットリング（`Throttling`のエラー）が起きる手前の回数を確かめる。

上限に近づいたときの対処の方向：

- STSのリクエスト数のクォータの引き上げを依頼する。それでも足りない規模では、複数のアカウントに分ける（[要件定義](requirements.md#将来の拡張初版では扱わない)では将来の拡張）。
- スタックを分ける。
- 受信側の`sub`の対応表を、命名規則による導出や、起動時に読む設定（SSM Parameter Storeなど）に置き換える。
- 信頼ポリシーで、呼び出し元の列挙を1つの文にまとめる。

この設計はroleと関数をARNで厳格に一致させている。ポリシーの大きさを抑えるために、次の書き方に切り替える選択肢もあるが、いずれもなりすましを防ぐ別の統制が必要になる。

| 書き方 | 代償 |
|---|---|
| 名前のパターンで一致させる（`ArnLike`） | そのパターンに合う名前のroleを作れる人は誰でも一致する。roleの作成をSCPやPermissions Boundaryで縛る必要がある。ARNを`Principal`に直接書く場合と違い、同じ名前での作り直しによるなりすましも防げない |
| roleのタグで一致させる（`aws:PrincipalTag`） | セッションタグが同じキーのroleのタグを上書きするため、`sts:TagSession`のキーの制限を誤ると呼び出し元が身元を偽れる。`iam:TagRole`の統制も必要 |

## 7. 将来の拡張の方向

初版では扱わないが、次の方向が考えられる。

- **実装言語を問わない共通部品**：Lambda Extensionとして、受信時の検証（Runtime API proxyでイベントを書き換え、JWTと受け渡すセッションを
  取り除く）と、送信時のchain・JWTの発行・署名（`localhost`のプロキシ）を提供すれば、HTTPを話せる言語ならどれでも同じ仕組みに乗れる。
  アプリは通常の処理で認証情報を一度も手にしないので、誤ってログに出す事故も防げる。ただし§5のとおり、乗っ取られたアプリに対する
  境界にはならない見込みである。実現性（Function URLの呼び出しでのイベントの書き換え、コールドスタートの増分、関数からExtensionの
  メモリを読めるか）は未検証。
- **判定をポリシー言語で書く**：今は各ホップの業務のコードが、scopeと業務的なアクセス権で判定している。この判定をCedarのポリシーに移せば、
  ポリシーを1か所で管理し、検証やレビューができる。Cedarは判定する側で、入力が本物かどうかは保証しない。そのため、入力にはこの参照実装が
  検証した値を使う。principalに`subject`、contextに`actor`・`scope`、エンティティに属性サービスのアクセス権を渡す（目的は、業務のコードと同じく判定に使わない）。
  判定は、Amazon Verified Permissionsの`IsAuthorized`に問い合わせるか、Cedarのライブラリで関数の中で評価する。
  前者は判定ごとの費用と往復の時間がかかり、後者はポリシーの配布を自分で行う。どちらを選んでも、委任の範囲をIAMに強制させる部分は変わらない。
  関係の整理は[PRFAQ](prfaq/aws-authorization-context-propagation.md#q9-amazon-verified-permissionsやcedaraws-verified-accessとどう関係するのか)にある。未検証。
- **定義の共有**：参照実装は単一のCDKアプリなので、委任の範囲の定義を合成の中で突き合わせられる。サービスごとにリポジトリやアカウントが分かれる場合は、
  定義を共有する場所（レジストリ）と、利用側の定義をレビューする手順が要る。
- **改ざんできないリクエストID**：bffがリクエストIDを、取引の目的と同じくtransitive session tagとして刻めば、途中のホップは変えられなくなり、
  受信側はJWTの`principal_tags`の値とヘッダーを照合できる。tagと、信頼ポリシーで許すtagのキーが1つ増える。未検証。
- **ほかの拡張**：非同期処理、複数アカウント、AWSの外のサービスへのユーザーの証明の受け渡し、API Gateway経由のホップは、
  [要件定義の「将来の拡張」](requirements.md#将来の拡張初版では扱わない)にある。
