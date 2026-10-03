# ADR: 目的を刻むroleは、このUser Poolで認証されたセッションだけを受け付ける

## 状態

採用（2026-10-03）。本体に条件を付けてデプロイし、シナリオテストがすべて通ることを確かめた。
最初は条件の値をOIDC providerのARNにして、正規のリクエストも拒否された。値の形を[検証](../../experiments/federated-provider/RESULTS.md)で確かめ、決定を改めた。

## 背景

ユーザー（SourceIdentity）を最初に刻む入口は、federated roleの信頼ポリシーだけだった。federated roleは、このUser PoolのOIDC providerと、
このアプリクライアントの`aud`だけを信頼する。ここが緩むと（たとえば、別の利用者向けに社内のSSOを足すと）、別のIdPのトークンで、
同じSourceIdentityを持つセッションを作れる（RFC 9700がいうIdPの取り違えの、この構成での形）。

各ホップでIdPを確かめることはできない。chainした先のセッションが発行したJWTには、元のIdP（`federated_provider`）が残らないからである。
IdPを実行時に確かめられるのは、OIDC providerで引き受けたfederated roleのセッションが、次のroleを引き受けるときだけである。
このとき、要求には条件キー`aws:FederatedProvider`が入り、値は、OIDC providerのARNではなく、`https://`を除いた発行者
（`cognito-idp.<region>.amazonaws.com/<User PoolのID>`）になる（[検証](../../experiments/federated-provider/RESULTS.md)）。

## 決定

**目的を刻むroleの信頼ポリシーの`sts:AssumeRole`に、`"aws:FederatedProvider": "cognito-idp.<region>.amazonaws.com/<User PoolのID>"`の条件を足す。**

- `AuthFoundation`が、`https://`を除いた発行者（`oidcIssuer`）を公開し、`Bff#connect`が条件に使う。
- federated roleの信頼ポリシー（OIDC providerと`aud`）と、目的を刻むroleのこの条件を、テンプレートの単体テストで確かめる。
  条件を外したテンプレートや、別のUser Poolにしたテンプレートを見逃さないことも確かめる。

## 採用しなかった選択肢

- **条件の値を、OIDC providerのARNにする**：条件キーの文書は、AWSの組み込みでないIdPの値をARNとしているが、Cognito User Pool（IAMのOIDC providerとして
  登録したもの）では、値は発行者だった。ARNにすると、正規のリクエストも拒否される（[検証](../../experiments/federated-provider/RESULTS.md)のV1）。
- **値の形に頼らず、キーがあることだけを条件にする（`Null`）**：OIDC providerで引き受けたセッションであることはわかるが、どのIdPかは確かめられない。
  別のIdPを足したときのなりすましを防げない。
- **各ホップの検証で、JWTの`federated_provider`を確かめる**：chainした先のJWTには入らないので、できない。
- **federated roleで直接JWTを発行し、目的を刻むroleを経由しない**：JWTに`federated_provider`は入るが、目的をtransitive session tagとして
  刻めなくなる。目的はこの構成の委任の範囲の中心なので、採らない。
- **単体テストだけにする**：コードの変更は防げるが、IAMの設定の誤りが1か所あれば、なりすましが成立する。条件を足せば、
  federated roleの信頼ポリシーを誤っても、別のIdPで認証されたセッションは目的を刻むroleに進めない。
- **Permission Boundary**：roleのセッションができることを制限するもので、roleを誰が引き受けられるかは制限しない。

## 結果として引き受けること

- **IdPを足すときは、2か所を変える必要がある**：federated roleの信頼ポリシーと、目的を刻むroleの条件の両方である。意図して両方を変えることになり、
  片方だけの変更でなりすましの経路が開くことはない。
- **アプリクライアント（`aud`）は、この条件では確かめない**：`aws:FederatedProvider`が示すのはIdP（User Pool）までで、アプリクライアントの限定は、
  引き続きfederated roleの信頼ポリシーだけが担う。
- **アカウントの管理者は防げない**：両方の信頼ポリシーを書き換えられる主体には効かない。境界はアカウントの分離やSCP、RCPで作る。
- **値の形は文書と違う**：値が発行者になることは、文書ではなく実機の観測に頼っている。AWSが値の形を変えると、正規のリクエストも拒否される。
  そうなればシナリオテストが失敗するので、気づける。
