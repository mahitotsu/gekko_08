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
| 「消防署の方から来ました」（消火器の訪問販売） | どこから来たか | 呼び出し元を名乗るヘッダーや、本部・管理者を名乗るデータ中の指示 | 入口のIAMが、呼び出し元の実行roleと関数を確かめる（actor） |
| オレオレ詐欺（「俺だよ」「息子さんの代理の者です」） | 誰の代理か | ユーザーIDを載せたヘッダーや引数、LLMが出力したユーザー名 | STSが署名したJWTの`source_identity`（subject） |
| 劇場型（警察、協会、弁護士と、人が入れ替わって話をつなぐ） | 前の人の話が本当であること | 途中のホップが、手前のホップから聞いた値をそのまま次へ伝える | 各ホップが署名を検証する。手前の言い分は使わない |
| 還付金詐欺（本人にATMを操作させる） | 何も偽らない。本人に、本人の権限で操作させる | プロンプトインジェクションで、エージェントがユーザーの権限の範囲内で誤った操作をする | 防がない（[§5](#5-この構成が守らないもの)）。取引の目的とscopeで、操作できる範囲を狭めておく |

AIエージェントは、こうした口上に騙される側になりうる。デモの案件メモには「本部監査部の者です」と名乗って他の支店の口座を
調べさせる文言が入っていて、エージェントは誘導されることがある。それでも、本部を名乗ったのはデータの中の文字列で、
AWSが保証した値ではないので、受信側の判定は変わらない。守りをエージェントの判断ではなく、各ホップの検証に置く。

## 2. 仕組み

```
ログイン     Cognito ─(IDトークン: source_identity)─> bff ─AssumeRoleWithWebIdentity─> federated roleのセッション（SourceIdentity＝yamada）
取引の開始   bff ─AssumeRole（purpose＝agent-analysisをtransitive tagで刻む）─> 目的用のroleのセッション
ホップ間     呼び出し元                                                           受信側
             ① 受け取ったセッションで自分のchain用roleにchain（目的は引き継がれ、変えられない）
             ② GetWebIdentityToken（aud＝受信側、Tags＝scope）。IAMが目的・宛先・scopeを限る
             ③ 自分の実行roleでSigV4署名して呼ぶ ──────────────────────────────> 入口のIAM：実行roleと関数を確かめる（actor）
                x-authz-context: JWT                                             アプリ：JWTを検証する（subject、aud、目的、scope）
                x-authz-session: chainのセッション（受信側がさらに先を呼ぶ場合）   業務のコード：属性サービスからアクセス権を得て判定
```

認可の根拠は3つの層に分ける。

| 層 | 問い | 担い手 |
|---|---|---|
| 1. 身元 | 誰の代理か、どのサービスから来たか、自分宛てか | SourceIdentity、入口のIAM、JWTの`sub`と`aud` |
| 2. 委任の範囲 | この取引で、この呼び出し元に何を許すか | 取引の目的とホップごとのscope。IAMが強制する |
| 3. 業務的なアクセス権 | このユーザーは、このデータを扱ってよいか | 属性サービス（人事データと権限マスタ） |

判定は、**委任の範囲が操作を許し、かつ業務的なアクセス権がデータを許す**ときだけ許す。Microsoft Entra IDの委任された権限で
「実効権限はアプリに許した範囲とユーザー自身の権限の積集合」とするのと同じ考え方である。

要点：

- **ユーザーと取引の目的は入口で一度だけ刻む。** SourceIdentityとtransitive session tagは、role chainingで途中のホップが変えられない。
- **呼び出しの許可（actor）とユーザーの証明（subject）を分ける。** ホップを呼ぶ権限は各ホップの実行roleにだけあり、ユーザーの代理の
  セッションは、IAMが許した宛先・目的・scopeのJWTを作ることしかできない。
- **委任の範囲はコードではなくIAMのポリシーが強制する。** 目的に合わない下流宛てのJWTや、宣言していないscopeは、STSが発行しない。
- **業務的なアクセス権はトークンに入れない。** 属性サービスが判定のたびに人事データを読むので、異動や権限の剥奪が次のリクエストから効く。
- **判断は受信側のアプリが、検証済みの値と属性サービスの値だけで行う。** ヘッダーや引数、LLMの出力からユーザーを読まない。

## 3. 各判断の根拠

| 判断 | 根拠 | 詳細 |
|---|---|---|
| ユーザーと目的はSourceIdentityとtransitive session tagで運ぶ | role chainingでのみ偽装されずに引き継げた。受信側が設定し直す方式は偽装が成立し、JWTでIAMセッションに戻す方式はIAMが拒否した | [多段伝播のADR](adr/20260930064314-multi-hop-authorization-context-propagation.md)、[方式比較](../experiments/multi-hop-propagation/RESULTS.md) |
| 委任の範囲を、取引の目的とホップごとのscopeの2つで表す | 目的（Transaction Tokensの`purp`に相当）だけでは同じ取引の中でホップごとに絞れず、scope（Token Exchangeのdownscopingに相当）だけでは元の取引の目的に沿っているかを強制できない。どちらもIAMで強制できた | [委任の範囲と業務的なアクセス権のADR](adr/20260930150529-delegation-scope-and-entitlements.md)、[検証](../experiments/scope-tags/RESULTS.md) |
| 業務的なアクセス権は属性サービスから得る | トークンに入れると変更がトークンの更新まで効かず、セッションタグの制約（最大50個、値は単一の文字列）に収まる権限しか表せない | 同上のADR |
| 属性サービスは本人のアクセス権だけを返す | 照会する相手を引数に取らないので、誘導されたエージェントや侵害されたホップが他人の権限を問い合わせられない | 同上のADR |
| 受け渡すセッションでホップを呼ばない | セッション自体に呼び出し権限があると、漏れたときに外から使え、侵害されたホップが次のホップを飛ばせる | [Token Exchange相当の構成](../experiments/actor-subject-jwt/RESULTS.md) |
| 入口で「許可したrole以外」を明示的にDenyする | 同じアカウントでは、resource policyが許可していなくても、呼び出し元のidentity policyの広い許可で呼べた | 同上 |
| 入口で`lambda:SourceFunctionArn`も確かめる | 同じ実行roleを共有する別の関数からの呼び出しを区別できた | 同上 |
| JWTの`sub`を呼び出し元と照合する | 入口を通った呼び出し元と、JWTを作ったchain用roleが対応していることを確かめ、別経路で作られたJWTの持ち込みを防ぐ | [設計書§6](design/architecture.md#6-受信側の共通部品と判定) |
| 入口はBFFにし、ブラウザには認証情報を持たせない | ブラウザは秘密を保持できない。ブラウザには実行roleがなく、actorを確かめられない。取引の目的を決める場所としても、サーバー側の入口が要る | [入口のADR](adr/20260930083437-entry-via-bff.md) |
| IdPはCognito User PoolとPre Token Generation V2 | 1回の`AssumeRoleWithWebIdentity`でSourceIdentityを設定できる | [IdPのADR](adr/20260930091026-idp-cognito-user-pool.md) |
| ホップ間はFunction URLの`AWS_IAM`認証で、mTLSは使わない | 参加資格をネットワークではなくIAMで守れる。SPIREのような常駐コンポーネントが要らない | [コンピュートと通信のADR](adr/20260930091257-lambda-function-url-without-mtls.md) |
| エージェントはClaude Agent SDKで作り、MCPは関数の中の中継から共通部品で呼ぶ | 広く使われているフレームワークでも同じ境界を保てることを示す。SDKのMCPには固定のヘッダーしか付けられないので、認証情報を持つ親のプロセスが中継する。中継をHTTPにすると、トレースの親子関係も一続きになった | [Claude Agent SDKのADR](adr/20261001040729-fraud-agent-on-claude-agent-sdk.md)、[検証](../experiments/agent-frameworks/RESULTS.md) |
| MCPサーバーもOAuthではなく他のホップと同じ入口で守る | ホップの仕組みを1種類にできる。MCPの仕様で認可は任意（OAuthは推奨） | [エージェントとMCPのADR](adr/20260930093746-agent-and-mcp-on-lambda.md) |

### 委任の範囲の決め方

Token Exchangeでは、認可サーバーがトークンを交換するたびに`scope`を絞る。この参照実装では、同じ判断を**CDKの宣言とIAMのポリシー**に置く。

- **取引の目的**は、入口のbffが経路ごとに決める（画面での要約は`case-summary`、エージェントによる分析は`agent-analysis`）。bffは
  Transaction Tokensの発行サービスに当たる。刻める値は目的用のroleの信頼ポリシーで限る。
- **ホップごとのscope**と**JWTを発行できる目的**は、`allowCaller`で呼び出し元と呼び出し先の組ごとに宣言する。CDKが、その値しか
  付けさせない`sts:TagGetWebIdentityToken`の権限と、その目的でしか発行させない`sts:GetWebIdentityToken`の権限を生成する。
- 受信側は、scopeで操作を、目的で返す範囲を判断する。参照実装では、case-serviceは要約を`case:summary`、案件の取得を`case:read`でだけ受け付け、
  account-serviceは目的が`case-summary`のときだけ残高を返す。
- 委任の範囲は1か所（CDKの宣言）で見渡せるが、それを使った判定のコードは各受信側にある。範囲を見直すときは、宣言と受信側の両方を見る。

## 4. 自分のシステムへの当てはめ方

### 前提

- 単一のAWSアカウントで、ホップはLambda（Function URL）であること。
- IAMのアウトバウンドIDフェデレーションを有効にすること（アカウント全体の設定。[README](../README.md#前提条件)）。
- 1回のリクエストの処理が各ホップで15分以内に収まること（chainのセッションの有効期間）。

### 手順

1. **取引の目的を決める。** 入口の経路ごとに、何のための取引かを決める（[app-stack.ts](../infra/lib/app-stack.ts)の`PURPOSE`）。
2. **業務的なアクセス権のデータ源を決める。** 属性サービス（[entitlement-service](../services/entitlement-service/src/index.ts)）が、
   自分のシステムの人事データや権限マスタを読むようにする。本人の分だけを返す形は変えない。
3. **ホップを定義する。** 他のホップ（属性サービスを含む）を呼ぶなら`callsOthers: true`にする。chain用roleが作られる。

   ```ts
   const orders = new Hop(this, 'Orders', { hopName: 'orders', entry: 'services/orders/src/index.ts', issuer, callsOthers: true });
   ```

4. **呼び出し関係と委任の範囲をつなぐ。** `allowCaller`が、入口のresource policy、chain用roleの信頼とchainの権限、JWTの発行の権限
   （宛先、scope、目的）、`sub`の対応表をまとめて設定する。呼び出し元になれるのは`Hop#asCaller()`か`Bff#asCaller()`。

   ```ts
   orders.allowCaller(caseService.asCaller(), { scope: 'orders:read', purposes: ['case-summary'] });
   entitlementService.allowCaller(orders.asCaller(), { scope: 'entitlements:read', purposes: ['case-summary'] });
   ```

5. **業務のコードを書く。** `createHopHandler`に業務の関数を渡す。受け取るのは検証済みの`subject`・`actor`・`purpose`・`scope`と、
   次のホップを呼ぶ`call`だけで、JWTも認証情報も扱わない。scopeで操作を、属性サービスのアクセス権でデータを判定する。
   AWS SDKのクライアントは`traceAwsClient`で包み、呼び出しをトレースに出す。

   ```ts
   export const handler = createHopHandler(async (body, { scope, purpose, call }) => {
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
7. **データは各ホップの実行roleで読む。** ユーザーの権限でAWSリソースに直接アクセスすることは扱わない（要件定義のスコープ外）。
8. **シナリオテストを要件にひも付ける。** [tests/scenario](../tests/scenario/)を参考に、正しいユーザーが通ること、アクセス権のないユーザー、
   目的やscopeに合わない呼び出し、飛ばした呼び出し、許可していない主体が拒否されることを確かめる。

### 守るべき規律

- 入口のresource policyとJWTの発行の権限を手で書かない。`Hop`を通さずに書くと、Denyや条件の書き漏らしがそのまま穴になる。
- `GetWebIdentityToken`の宛先を、内部のホップに限る。外部のサービスがこのJWTを単独で信じると、そこではユーザーになりすませる。
  `Hop`は宛先を`ForAllValues:StringEquals`と`Null`で絞る。`ForAnyValue`で書くと、許した宛先に外部の宛先を混ぜたJWTを発行できる
  （[検証](../experiments/scope-tags/RESULTS.md)）。
- scopeや目的のないJWTを受け入れない。共通部品は拒否する。
- 属性サービスが使えないときは拒否する（fail closed）。
- 受け渡すセッションとJWTをログや応答に出さない。共通部品は出さないが、業務のコードで`event`全体をログに出すと漏れる。
- Pre Token Generationトリガー、User Poolの設定、属性サービスのデータを守る。SourceIdentityの値はこのLambdaが決め、AWSは値の正しさを
  検証しない。業務的なアクセス権は属性サービスのデータがすべてを決める。

## 5. この構成が守らないもの

| 守らないもの | 内容 |
|---|---|
| 侵害されたホップの振る舞い | 侵害されたホップは、処理中のリクエストについて、自分に許された呼び出し先・目的・scopeの範囲でユーザーとして振る舞える。Token Exchangeでも同じ |
| 実行環境から持ち出された認証情報 | 実行roleの認証情報と受け渡されたセッションを持ち出されると、有効期限内は、そのホップとして次のホップを呼べうる。`lambda:SourceFunctionArn`が実行環境の外での利用でも付くかは確かめていない。IPv6の送信元アドレスで使用場所を縛れることは確かめたが、ホップのLambdaをVPCにつなぐ必要がある（[IPv6送信元による縛り](../experiments/network-binding/RESULTS.md)） |
| 侵害されたBFF | BFFは、ログイン中のユーザーのIDトークンとリフレッシュトークンを持ち、取引の目的を決める。BFFが侵害されると、そのユーザーとして、定めた目的のどれででも最初のホップを呼べる。BFFは最も価値の高い構成要素になる |
| 侵害された属性サービスやそのデータ | 業務的なアクセス権は属性サービスのデータがすべてを決める。書き換えられると、そのとおりに判定される |
| アカウントの管理者 | IAMの権限を持つ主体は、resource policyや信頼ポリシーを書き換えられる。管理者に対する境界は、アカウントの分離やSCPで作る必要がある |
| 途中での取り消し | 発行済みのJWT（有効期間5分）とchainのセッション（15分）は、途中で取り消さない。ログアウトはBFFのセッションを消し、リフレッシュトークンを取り消すまで。業務的なアクセス権の変更は、次のリクエストから効く |
| エージェントの判断 | プロンプトインジェクションでエージェントが誤った要求をすることは防がない。防ぐのは、その要求が委任の範囲とユーザーの権限を超えること |
| エージェントの子プロセスからの隔離 | fraud-agentのClaude Codeは、親のプロセスと同じ実行環境、同じOSのユーザーで動く。子プロセスに認証情報を渡さないのは環境変数の範囲で、OSの境界ではない。子プロセスに任意のコードを実行させない境界は、組み込みのツールを無効にする設定である。中継は、子プロセスから呼び出し先（fraud-mcp）をユーザーの代理で呼べる、その実行環境の中の入口になる |
| アプリからの認証情報の隔離 | 共通部品はアプリと同じプロセスで動くライブラリで、アプリが乗っ取られると、受け渡されたセッションも実行roleの認証情報も読める。k8sでEnvoyなどのサイドカーに任せる構成と違い、Lambdaでは関数とExtensionが同じ実行環境で動くので、Extensionに分けても、乗っ取られたアプリに対する境界にはならない見込み（未検証） |

補足：

- 受け渡すセッションは、漏れてもどのホップも呼べないように作ってある（SR-1）。守るべきものが小さいので、アプリからの隔離の
  価値は、ワークロードの鍵そのものを守るk8sのサイドカーより小さい。
- テストのために、アプリクライアントで`ADMIN_USER_PASSWORD_AUTH`を有効にしている。呼ぶにはIAMの権限が要り、ブラウザからは使えないが、
  本番で使うなら無効にしてよい。
- 各ホップのログとトレースのスパン（`enduser.id`）には、ユーザーの識別子と取引の目的が出る。個人情報の扱いは、自分のシステムの方針に合わせる。
- 業務的なアクセス権の判定を1か所に集めたい場合は、各ホップのコードの判定を、Amazon Verified Permissions（Cedar）のような判定サービスに
  任せる選択肢がある（[§8](#8-将来の拡張の方向)）。委任の範囲をIAMに強制させる部分は変わらない。

## 6. レイテンシの実測

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

- 呼び出し先を持つホップの追加は、ウォームでおよそ110ms（chain約60ms、JWTの発行約45ms、検証数ms）。呼び出し先を持たない終端のホップは検証だけで、数ms。
- 取引の目的を刻むことで、bffに約50msが加わる。
- 属性サービスの呼び出しは、呼ぶ側のJWTの発行（約45ms）と属性サービスの処理（約12ms）とネットワークで、1回あたりおよそ60〜80ms。
  chainは次のホップの呼び出しと共有する。
- 画面からの1リクエストは、業務的なアクセス権をトークンで運んでいたとき（中央値222ms）から、目的の刻印と属性サービスの呼び出し2回で
  約250ms増えた（470ms）。
- トレースの送信は、各ホップが応答を返す前に行うので、ホップの呼び出し1回あたり約40ms（ウォーム）、呼び出し元から見た時間が延びる
  （[送り方のADR](adr/20261001053646-telemetry-direct-export.md)）。画面からの1リクエスト（ホップの呼び出し5回）では、bffの処理全体が
  470msから626msになり、これにbff自身の送信（約40ms）が加わる。
- コールドスタート直後は、JWTの検証に発行者のJWKSの取得が加わり、約340msかかった。
- エージェントの経路では、モデルの呼び出し（Claude Haiku 4.5）が1回あたり約1〜5秒かかり、認可の処理の追加は相対的に小さい。
  fraud-agentはClaude Codeを子プロセスとして起動するので、1回の分析（ツールの呼び出し3回）は全体で約10〜12秒、最大メモリは約500MBだった
  （[検証](../experiments/agent-frameworks/RESULTS.md)。コールドスタートの初期化は約0.6〜0.7秒）。
- 自分の環境では、`npm run test:scenario`の結果（`tests/out-latency.json`）で確かめる。

## 7. 規模の上限

ホップが増えたときに先に上限になるのは、STSのリクエスト数（アカウント・リージョンごとに毎秒600件）と、1スタックのリソース数である。
目安と対処の方向は[設計書§11](design/architecture.md#11-前提条件と制約)にある。

## 8. 将来の拡張の方向

初版では扱わないが、次の方向が考えられる。

- **実装言語を問わない共通部品**：Lambda Extensionとして、受信時の検証（Runtime API proxyでイベントを書き換え、JWTと受け渡すセッションを
  取り除く）と、送信時のchain・JWTの発行・署名（`localhost`のプロキシ）を提供すれば、HTTPを話せる言語ならどれでも同じ仕組みに乗れる。
  アプリは通常の処理で認証情報を一度も手にしないので、誤ってログに出す事故も防げる。ただし§5のとおり、乗っ取られたアプリに対する
  境界にはならない見込みである。実現性（Function URLの呼び出しでのイベントの書き換え、コールドスタートの増分、関数からExtensionの
  メモリを読めるか）は未検証。
- **判定をポリシー言語で書く**：今は各ホップの業務のコードが、scopeと業務的なアクセス権で判定している。この判定をCedarのポリシーに移せば、
  ポリシーを1か所で管理し、検証やレビューができる。Cedarは判定する側で、入力が本物かどうかは保証しない。そのため、入力にはこの参照実装が
  検証した値を使う。principalに`subject`、contextに`actor`・`purpose`・`scope`、エンティティに属性サービスのアクセス権を渡す。
  判定は、Amazon Verified Permissionsの`IsAuthorized`に問い合わせるか、Cedarのライブラリで関数の中で評価する。
  前者は判定ごとの費用と往復の時間がかかり、後者はポリシーの配布を自分で行う。どちらを選んでも、委任の範囲をIAMに強制させる部分は変わらない。
  関係の整理は[PRFAQ](prfaq/aws-authorization-context-propagation.md#q9-amazon-verified-permissionsやcedaraws-verified-accessとどう関係するのか)にある。未検証。
- **非同期処理と複数アカウント**：要件定義の「将来の拡張」を参照。
