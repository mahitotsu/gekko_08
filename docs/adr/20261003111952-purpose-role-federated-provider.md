# ADR: 目的を刻むroleは、このUser PoolのIdPから来たセッションだけを受け付ける

## 状態

却下（2026-10-03）。条件を足してデプロイしたところ、federated roleのセッションから目的を刻むroleへの`AssumeRole`が、正規のリクエストも含めてすべて拒否された
（[検証](../../experiments/federated-provider/RESULTS.md)）。条件を外して元に戻した。別のIdPからのなりすましは、federated roleの信頼ポリシーと、その単体テストで防ぐ。

## 背景

ユーザー（SourceIdentity）を最初に刻む入口は、federated roleの信頼ポリシーだけだった。federated roleは、このUser PoolのOIDC providerと、
このアプリクライアントの`aud`だけを信頼する。ここが緩むと（たとえば、別の利用者向けに社内のSSOを足すと）、別のIdPのトークンで、
同じSourceIdentityを持つセッションを作れる（RFC 9700がいうIdPの取り違えの、この構成での形）。

各ホップでIdPを確かめることはできない。chainした先のセッションが発行したJWTには、元のIdP（`federated_provider`）が残らないからである
（[検証](../../experiments/federated-provider/RESULTS.md)）。IdPを実行時に確かめられるのは、OIDC providerで引き受けたfederated roleのセッションが、
次のroleを引き受けるときだけである。

## 決定

**目的を刻むroleの信頼ポリシーの`sts:AssumeRole`に、`"aws:FederatedProvider": "<このUser PoolのOIDC providerのARN>"`の条件を足す。**

- `AuthFoundation`が、OIDC providerのARNを公開し、`Bff#connect`が条件に使う。
- federated roleの信頼ポリシー（OIDC providerと`aud`）と、目的を刻むroleのこの条件を、テンプレートの単体テストで確かめる。
  条件を外したテンプレートや、別のproviderにしたテンプレートを見逃さないことも確かめる。

## 採用しなかった選択肢

- **各ホップの検証で、JWTの`federated_provider`を確かめる**：chainした先のJWTには入らないので、できない（[検証](../../experiments/federated-provider/RESULTS.md)）。
- **federated roleで直接JWTを発行し、目的を刻むroleを経由しない**：JWTに`federated_provider`は入るかもしれないが、目的をtransitive session tagとして
  刻めなくなる。目的はこの構成の委任の範囲の中心なので、採らない。
- **単体テストだけにする**：コードの変更は防げるが、IAMの設定の誤りが1か所あれば、なりすましが成立する。条件を足せば、
  federated roleの信頼ポリシーを誤っても、別のIdPから来たセッションは目的を刻むroleに進めない。
- **Permission Boundary**：roleのセッションができることを制限するもので、roleを誰が引き受けられるかは制限しない。

## 結果として引き受けること

- **IdPを足すときは、2か所を変える必要がある**：federated roleの信頼ポリシーと、目的を刻むroleの条件の両方である。意図して両方を変えることになり、
  片方だけの変更でなりすましの経路が開くことはない。
- **アプリクライアント（`aud`）は、この条件では確かめない**：`aws:FederatedProvider`が示すのはIdP（User Pool）までで、アプリクライアントの限定は、
  引き続きfederated roleの信頼ポリシーだけが担う。
- **アカウントの管理者は防げない**：両方の信頼ポリシーを書き換えられる主体には効かない。境界はアカウントの分離やSCP、RCPで作る。
- **実機での前提**：federated roleのセッションが目的を刻むroleを引き受ける要求に、`aws:FederatedProvider`が入ることを前提にする。入らなければ、
  条件が満たされず、すべてのリクエストが拒否される。
