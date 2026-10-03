# 検証結果：元のIdPは、chainした先のJWTに残るか

実施：2026-10-03（UTC）、ap-northeast-1。デプロイ済みのスタック`Gekko08App`に対し、シナリオテストの補助関数（`tests/scenario/helpers.ts`）で、
bffと同じ手順のセッションを作った。テスト専用のユーザー（`test-tokyo-manager`）でCognitoにログインし、federated roleを`AssumeRoleWithWebIdentity`で引き受け、
目的を刻むroleへchainし、さらにcase-serviceのchain用roleへchainした。目的を刻むroleとchain用roleのそれぞれで`GetWebIdentityToken`を呼び、
JWTのクレームを読んだ。検証のための構成は作っていない。

目的：各ホップが、受け取ったJWTから、ユーザーを認証したIdP（どのOIDC providerから来たセッションか）を確かめられるかを調べる。
別のIdPで同じSourceIdentityを持つセッションを作るなりすましを、各ホップで見分けられるかにかかわる。

## 結論

**元のIdPを示すクレーム（`federated_provider`）は、chainした先のセッションが発行したJWTには入らなかった。** 各ホップが受け取るJWTは、
すべてchainした先のセッション（目的を刻むroleか、chain用role）が発行するので、各ホップはJWTから元のIdPを確かめられない。
IdPを実行時に確かめられるのは、OIDC providerで引き受けたfederated roleのセッションが、次のroleを引き受けるとき（目的を刻むroleの信頼ポリシー）だけである。

## 観測

| JWTを発行したセッション | `sub` | `https://sts.amazonaws.com/`の下のクレーム | `source_identity` | `federated_provider` |
|---|---|---|---|---|
| 目的を刻むrole | 目的を刻むroleのARN | `aws_account`、`org_id`、`original_session_exp`、`ou_path`、`principal_id`、`principal_tags`、`request_tags`、`source_identity`、`source_region` | `test-tokyo-manager` | ない |
| case-serviceのchain用role | chain用roleのARN | 同上 | `test-tokyo-manager` | ない |

- SourceIdentityは、chainしても同じ値のまま残った。
- [IAMの文書](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound_token_claims.html)は、`federated_provider`を
  「フェデレーションのセッションのIdP名」とし、条件キー`aws:FederatedProvider`に対応づけている。
  [条件キーの文書](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-federatedprovider)は、
  このキーが「OIDC providerで引き受けたroleのセッション」にあるとしている。chainした先に引き継がれるかは書いていない。今回の観測では、引き継がれなかった。

## 設計への示唆

- 各ホップの検証に、IdPの確認を足すことはできない。各ホップは、JWTの`sub`を、入口のIAMが確かめた呼び出し元のchain用roleと照合する。
  chain用roleは信頼ポリシーの連鎖によって、federated roleから始まったセッションからしか引き受けられないので、この照合が元のIdPの確認を間接的に担う。
- 連鎖の根元を、2か所で確かめる。federated roleの信頼ポリシー（このUser PoolのOIDC providerと`aud`）と、目的を刻むroleの信頼ポリシー
  （`aws:FederatedProvider`＝このUser PoolのOIDC provider）。後者は、federated roleのセッションが目的を刻むroleを引き受ける要求に
  `aws:FederatedProvider`が入ることを前提にする。この前提は、下の追加の観測で成り立たなかった。

## 追加の観測：目的を刻むroleの信頼ポリシーで`aws:FederatedProvider`を条件にする

実施：2026-10-03（UTC）。目的を刻むroleの信頼ポリシーの`sts:AssumeRole`に、`"aws:FederatedProvider": "<このUser PoolのOIDC providerのARN>"`の条件を足してデプロイし、
シナリオテストを流した。

- federated roleのセッションから目的を刻むroleへの`AssumeRole`が、正規の手順でも、すべて`AccessDenied`になった。画面の操作はすべて500になった。
- 条件キーが要求に入っていないのか、値の形（ARNか、発行者のURLか）が違うのかは、この観測からは区別できない。
- 条件を外して元に戻した。federated roleのセッションが次のroleを引き受けるときにIdPを確かめる方法は、今のところ得られていない。
  IdPを確かめるのは、federated roleの信頼ポリシー（このUser PoolのOIDC providerと`aud`）だけである。
