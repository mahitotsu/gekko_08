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
  `aws:FederatedProvider`が入ることを前提にする。キーは入るが、値はOIDC providerのARNではなく発行者だった（下の追加の観測と追加の検証）。

## 追加の観測：目的を刻むroleの信頼ポリシーで`aws:FederatedProvider`を条件にする

実施：2026-10-03（UTC）。目的を刻むroleの信頼ポリシーの`sts:AssumeRole`に、`"aws:FederatedProvider": "<このUser PoolのOIDC providerのARN>"`の条件を足してデプロイし、
シナリオテストを流した。

- federated roleのセッションから目的を刻むroleへの`AssumeRole`が、正規の手順でも、すべて`AccessDenied`になった。画面の操作はすべて500になった。
- 条件キーが要求に入っていないのか、値の形（ARNか、発行者のURLか）が違うのかは、この観測からは区別できない。
- 条件を外して元に戻した。原因は、次の検証で、値の形の違いだとわかった。

## 追加の検証：`aws:FederatedProvider`の値の形

実施：2026-10-03（UTC）、ap-northeast-1。本体とは別のスタック`Gekko08ExpFederatedProvider`（[lib/stack.ts](lib/stack.ts)）を使った。
本体のOIDC providerとアプリクライアントを信頼する検証用のfederated roleを作り、テスト専用のユーザーのIDトークンで引き受けた。そのセッションから、
信頼ポリシーの条件だけが違う6つのroleの引き受けを試み、それぞれのセッションでJWTを発行した。

### 結論

**`aws:FederatedProvider`は、OIDC providerで引き受けたroleのセッションが次のroleを引き受ける要求に入る。値は、OIDC providerのARNではなく、
`https://`を除いた発行者（`cognito-idp.ap-northeast-1.amazonaws.com/<User PoolのID>`）だった。** 本体で条件を付けたときに拒否されたのは、
値をARNにしていたためである。条件キーの文書は、AWSの組み込みでないIdPの値をARNとしているが、Cognito User Pool（IAMのOIDC providerとして登録したもの）では違った。

### 観測

| role | 信頼ポリシーの条件 | 引き受け |
|---|---|---|
| V0 | なし（対照） | できた |
| V1 | `aws:FederatedProvider`＝OIDC providerのARN | 拒否 |
| V2 | `aws:FederatedProvider`＝`cognito-idp.ap-northeast-1.amazonaws.com/<pool>` | できた |
| V3 | `aws:FederatedProvider`＝`https://cognito-idp.ap-northeast-1.amazonaws.com/<pool>` | 拒否 |
| V4 | `aws:FederatedProvider`がある（`Null`＝`false`） | できた |
| V5 | `aws:FederatedProvider`がない（`Null`＝`true`） | 拒否 |

| JWTを発行したセッション | `federated_provider` |
|---|---|
| 検証用のfederated role（OIDC providerで引き受けたセッション） | `cognito-idp.ap-northeast-1.amazonaws.com/<pool>` |
| V0、V2、V4（federated roleからchainしたセッション） | ない |

- chainしたセッションでも、SourceIdentityは同じ値のまま残った。
- JWTの`federated_provider`の値も、条件キーと同じく、`https://`を除いた発行者だった。

### 再現

本体のスタック`Gekko08App`をデプロイしたうえで、このディレクトリで次を実行する。結果は`out-results.json`（git管理外）にも書く。

```sh
export AWS_REGION=ap-northeast-1
npx cdk deploy              # 本体のUser PoolのIDとアプリクライアントのIDは、本体のスタックの出力から読む
npx tsx scripts/run.ts      # テスト専用のユーザー（test-tokyo-manager）でログインし、6つのroleを試す
npx cdk destroy
```

### 設計への示唆

- 目的を刻むroleの信頼ポリシーで、`"aws:FederatedProvider": "cognito-idp.<region>.amazonaws.com/<User PoolのID>"`を条件にすれば、
  このUser Poolで認証されたfederated roleのセッションだけが、目的を刻むroleを引き受けられる。IdPを実行時に確かめる2か所目になる。
- 各ホップのJWTには元のIdPが残らないことは、変わらない。
