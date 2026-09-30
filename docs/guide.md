# 設計ガイド

この参照実装を自分のシステムに当てはめるエンジニアに向けて、仕組み、各判断の根拠、当てはめ方、この構成が守らないものを説明する。
構成の詳細は[設計書](design/architecture.md)に、判断の経緯は[ADR](adr/)に、実機での観測は[検証記録](../experiments/)にある。

## 1. 解く問題

マイクロサービスやAIエージェントが多段に呼び合うと、最初にログインしたユーザーの権限が、奥のホップに届くまでに失われたり、
すり替わったりしやすい。ユーザーIDをヘッダーで渡せば途中のホップが書き換えられ、アクセストークンを丸ごと転送すれば宛先（`aud`）を
確かめられない。OAuth Token Exchangeは正攻法だが、認可サーバーを運用する必要がある。

この参照実装は、Token Exchangeと同じことを、認可サーバーもサイドカーも置かずに、Cognito・STS・IAM・Lambdaだけで実現する。
各ホップは、受け取ったリクエストについて次の3つを確かめられる。

| 確かめること | Token Exchangeでの担い手 | この参照実装での担い手 |
|---|---|---|
| 誰の代理か（subject）と業務属性 | トークンの`sub`とクレーム | STSが署名したJWTの`source_identity`と`principal_tags` |
| どのサービスから来たか（actor） | 呼び出し元のクライアント認証 | 入口のIAM（呼び出し元の実行roleと関数） |
| 自分宛てか | トークンの`aud` | JWTの`aud` |

## 2. 仕組み

```
ログイン     Cognito ─(IDトークン: source_identity, tags)─> bff ─AssumeRoleWithWebIdentity─> federated roleのセッション
                                                                                            （SourceIdentity＝yamada、branch＝tokyo）
ホップ間     呼び出し元                                                           受信側
             ① 受け取ったセッションで自分のchain用roleにchain
             ② そのセッションでGetWebIdentityToken（aud＝受信側）
             ③ 自分の実行roleでSigV4署名して呼ぶ ──────────────────────────────> 入口のIAM：実行roleと関数を確かめる（actor）
                x-authz-context: JWT                                             アプリ：JWTを検証する（subject、aud）
                x-authz-session: chainのセッション（受信側がさらに先を呼ぶ場合）
```

要点は3つある。

- **ユーザーの属性はログイン時に一度だけ刻む。** Pre Token GenerationトリガーがIDトークンに入れた値を、STSがSourceIdentityと
  transitive session tagとしてセッションに刻む。role chainingでは、途中のホップはこれを変えられない。
- **呼び出しの許可（actor）とユーザーの証明（subject）を分ける。** ホップを呼ぶ権限は各ホップの実行roleにだけあり、ユーザーの属性を
  持つセッションは、次のホップ宛てのJWTを作ることしかできない。
- **判断は受信側のアプリが、検証済みの値だけで行う。** 業務のコードは共通部品が渡すsubjectだけを使い、ヘッダーや引数、LLMの出力から
  ユーザーを読まない。

## 3. 各判断の根拠

| 判断 | 根拠 | 詳細 |
|---|---|---|
| 属性はSourceIdentityとtransitive session tagで運ぶ | role chainingでのみ偽装されずに引き継げた。受信側が設定し直す方式は偽装が成立し、JWTでIAMセッションに戻す方式はIAMが拒否した | [多段伝播のADR](adr/20260930064314-multi-hop-authorization-context-propagation.md)、[方式比較](../experiments/multi-hop-propagation/RESULTS.md) |
| 受け渡すセッションでホップを呼ばない | セッション自体に呼び出し権限があると、漏れたときに外から使え、侵害されたホップが次のホップを飛ばせる | [Token Exchange相当の構成](../experiments/actor-subject-jwt/RESULTS.md) |
| 入口で「許可したrole以外」を明示的にDenyする | 同じアカウントでは、resource policyが許可していなくても、呼び出し元のidentity policyの広い許可で呼べた | 同上 |
| 入口で`lambda:SourceFunctionArn`も確かめる | 同じ実行roleを共有する別の関数からの呼び出しを区別できた | 同上 |
| JWTの`sub`を呼び出し元と照合する | 入口を通った呼び出し元と、JWTを作ったchain用roleが対応していることを確かめ、別経路で作られたJWTの持ち込みを防ぐ | [設計書§6](design/architecture.md#6-受信側の共通部品packagesauthz-context) |
| 入口はBFFにし、ブラウザには認証情報を持たせない | ブラウザは秘密を保持できない。ブラウザには実行roleがなく、actorを確かめられない | [入口のADR](adr/20260930083437-entry-via-bff.md) |
| IdPはCognito User PoolとPre Token Generation V2 | 1回の`AssumeRoleWithWebIdentity`でSourceIdentityとtransitive tagを設定できる。V1は配列のクレームを返せない | [IdPのADR](adr/20260930091026-idp-cognito-user-pool.md) |
| ホップ間はFunction URLの`AWS_IAM`認証で、mTLSは使わない | 参加資格をネットワークではなくIAMで守れる。SPIREのような常駐コンポーネントが要らない | [コンピュートと通信のADR](adr/20260930091257-lambda-function-url-without-mtls.md) |
| MCPサーバーもOAuthではなく他のホップと同じ入口で守る | ホップの仕組みを1種類にできる。MCPの仕様で認可は任意（OAuthは推奨） | [エージェントとMCPのADR](adr/20260930093746-agent-and-mcp-on-lambda.md) |

### 代理で何を許すかは、各受信側が判断する

Token Exchangeでは、認可サーバーがトークンを発行するときに`scope`を絞り、「このサービスには、ユーザーの代理でここまで許す」という判断を
1か所に集められる。この参照実装には認可サーバーがないので、その判断は**各受信側に分散する**。

- JWTには、呼び出し元ごとに絞った`scope`がない。受信側は「誰の代理か」と「どのサービスから来たか」を確かめたうえで、何を許すかを
  自分で決める。
- 入口のresource policyが決めるのは「どのサービスが呼べるか」までで、「そのサービスに何を許すか」は受信側のアプリのコードにある。
  許す範囲を見直すときは、1か所の設定ではなく、各受信側のコードを見る必要がある。
- 共通部品は、subjectとともに、呼び出し元のホップ名（actor）を業務のコードに渡す。actorは、入口のIAMが確かめた実行roleと、JWTを作った
  roleの両方が一致したときだけ渡る。呼び出し元ごとに許す操作を変えるときは、これを使う。
- 参照実装では、case-serviceが、要約（口座の情報を含む）をbffからだけ、案件の取得をfraud-mcpからだけ受け付ける。エージェントの経路からは、
  口座の情報をまとめて返す要約を使えない。

## 4. 自分のシステムへの当てはめ方

### 前提

- 単一のAWSアカウントで、ホップはLambda（Function URL）であること。
- IAMのアウトバウンドIDフェデレーションを有効にすること（アカウント全体の設定。[README](../README.md#前提条件)）。
- 1回のリクエストの処理が各ホップで15分以内に収まること（chainのセッションの有効期間）。

### 手順

1. **業務属性を決める。** 認可に使う属性をsession tagとして表す。参照実装では`branch`の1つだけで、`TAG_KEYS`
   （[hop.ts](../infra/lib/constructs/hop.ts)）とPre Token Generationトリガー（[pretoken](../services/pretoken/src/index.ts)）で定める。
   session tagは最大50個、値は単一の文字列に限られる。
2. **ホップを定義する。** 他のホップを呼ぶなら`callsOthers: true`にする。chain用roleが作られる。

   ```ts
   const orders = new Hop(this, 'Orders', { hopName: 'orders', entry: 'services/orders/src/index.ts', issuer, callsOthers: false });
   ```

3. **呼び出し関係をつなぐ。** `allowCaller`が、入口のresource policy、chain用roleの信頼とchainの権限、JWTの宛先の許可、`sub`の対応表を
   まとめて設定する。呼び出し元になれるのは`Hop#asCaller()`か`Bff#asCaller()`。

   ```ts
   orders.allowCaller(caseService.asCaller());
   ```

4. **業務のコードを書く。** `createHopHandler`に業務の関数を渡す。受け取るのは検証済みの`subject`、呼び出し元のホップ名`actor`、
   次のホップを呼ぶ`call`だけで、JWTも認証情報も扱わない。

   ```ts
   export const handler = createHopHandler(async (body, { subject, actor, call }) => {
     if (actor !== 'case-service') return { status: 403, body: { error: 'forbidden' } };
     const order = await loadOrder(body.orderId);
     if (order.branch !== subject.branch) return { status: 403, body: { error: 'forbidden' } };
     return { status: 200, body: { order } };
   });
   ```

5. **データは各ホップの実行roleで読む。** ユーザーの権限でAWSリソースに直接アクセスすることは扱わない（要件定義のスコープ外）。
   ユーザーごとの制限は、業務のコードのABACで行う。
6. **シナリオテストを要件にひも付ける。** [tests/scenario](../tests/scenario/)を参考に、正しいユーザーが通ること、他の属性のユーザー、
   飛ばした呼び出し、許可していない主体が拒否されることを確かめる。

### 守るべき規律

- 入口のresource policyを手で書かない。`Hop`を通さずに書くと、Denyの書き漏らしがそのまま穴になる。
- `GetWebIdentityToken`の宛先を、内部のホップに限る。外部のサービスがこのJWTを単独で信じると、そこではユーザーになりすませる。
  `Hop`は宛先を`ForAllValues:StringEquals`と`Null`で絞る。`ForAnyValue`で書くと、許した宛先に外部の宛先を混ぜたJWTを発行できる
  （[検証](../experiments/scope-tags/RESULTS.md)）。
- 受け渡すセッションとJWTをログや応答に出さない。共通部品は出さないが、業務のコードで`event`全体をログに出すと漏れる。
- Pre Token GenerationトリガーとUser Poolの設定を守る。SourceIdentityとtagの値はこのLambdaが決め、AWSは値の正しさを検証しない。

## 5. この構成が守らないもの

| 守らないもの | 内容 |
|---|---|
| 侵害されたホップの振る舞い | 侵害されたホップは、処理中のリクエストについて、自分に許された呼び出し先の範囲でユーザーとして振る舞える。Token Exchangeでも同じ |
| 実行環境から持ち出された認証情報 | 実行roleの認証情報と受け渡されたセッションを持ち出されると、有効期限内は、そのホップとして次のホップを呼べうる。`lambda:SourceFunctionArn`が実行環境の外での利用でも付くかは確かめていない。IPv6の送信元アドレスで使用場所を縛れることは確かめたが、ホップのLambdaをVPCにつなぐ必要がある（[IPv6送信元による縛り](../experiments/network-binding/RESULTS.md)） |
| 侵害されたBFF | BFFは、ログイン中のユーザーのIDトークンとリフレッシュトークンを持つ。BFFが侵害されると、そのユーザーとして最初のホップを呼べる。BFFは最も価値の高い構成要素になる |
| アカウントの管理者 | IAMの権限を持つ主体は、resource policyや信頼ポリシーを書き換えられる。管理者に対する境界は、アカウントの分離やSCPで作る必要がある |
| 途中での取り消し | 発行済みのJWT（有効期間5分）とchainのセッション（15分）は、途中で取り消さない。ログアウトはBFFのセッションを消し、リフレッシュトークンを取り消すまで |
| ホップごとの`scope`の絞り込み | 代理で許す範囲は各受信側の判断による（§3） |
| エージェントの判断 | プロンプトインジェクションでエージェントが誤った要求をすることは防がない。防ぐのは、その要求がユーザーの権限を超えること |
| アプリからの認証情報の隔離 | 共通部品はアプリと同じプロセスで動くライブラリで、アプリが乗っ取られると、受け渡されたセッションも実行roleの認証情報も読める。k8sでEnvoyなどのサイドカーに任せる構成と違い、Lambdaでは関数とExtensionが同じ実行環境で動くので、Extensionに分けても、乗っ取られたアプリに対する境界にはならない見込み（未検証） |

補足：

- 受け渡すセッションは、漏れてもどのホップも呼べないように作ってある（SR-1）。守るべきものが小さいので、アプリからの隔離の
  価値は、ワークロードの鍵そのものを守るk8sのサイドカーより小さい。
- テストのために、アプリクライアントで`ADMIN_USER_PASSWORD_AUTH`を有効にしている。呼ぶにはIAMの権限が要り、ブラウザからは使えないが、
  本番で使うなら無効にしてよい。
- 各ホップのログには、ユーザーの識別子と業務属性が出る。個人情報の扱いは、自分のシステムの方針に合わせる。

## 6. レイテンシの実測

2026-09-30、ap-northeast-1、Lambda（Node.js 24、arm64、512MB）で、マイクロサービスの経路（bff → case-service → account-service）を
10回呼んだときのウォームの値（ミリ秒）。シナリオテストのNFR-3が集計する。

| 場所 | 処理 | 中央値 | 90パーセンタイル |
|---|---|---|---|
| bff | `AssumeRoleWithWebIdentity` | 14〜17 | 19〜22 |
| bff | JWTの発行（`GetWebIdentityToken`） | 36〜50 | 50〜163 |
| case-service | JWTの検証 | 1〜2 | 2〜17 |
| case-service | chain（`AssumeRole`） | 62〜65 | 76〜78 |
| case-service | JWTの発行 | 45 | 64〜68 |
| account-service | JWTの検証 | 2 | 2〜21 |

- 1ホップあたりの追加は、ウォームでおよそ110ms（chain、JWTの発行、検証の合計）。呼び出し先を持たない終端のホップは検証だけで、数ms。
- コールドスタート直後は、JWTの検証に発行者のJWKSの取得が加わり、約340msかかった。
- エージェントの経路では、モデルの呼び出し（Claude Haiku 4.5）が1回あたり約1〜5秒かかり、認可の処理の追加は相対的に小さい。
- 範囲は2回の測定の値。自分の環境では、`npm run test:scenario`の結果（`tests/out-latency.json`）で確かめる。

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
- **非同期処理と複数アカウント**：要件定義の「将来の拡張」を参照。
