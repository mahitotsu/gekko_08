# ADR: IdPにはCognito User Poolを使い、Identity Poolsは使わない

## Status

**今有効な決定**：IdPはCognito User Poolで、Pre Token Generation V2がIDトークンにSourceIdentityだけを入れる。BFFがIDトークンで`AssumeRoleWithWebIdentity`を呼ぶ。Identity Poolsは使わない。

Accepted (2026-09-30)。業務属性をIDトークンの`tags`に入れてsession tagsにする部分（決定2・3の業務属性、結果の業務属性とsession tagsの上限）は、
[委任の範囲と業務上のアクセス権のADR](20260930150529-delegation-scope-and-entitlements.md)で置き換えた。今のPre Token GenerationはSourceIdentityだけを入れ、
federated roleは`sts:TagSession`を許さない。

## Context

ユーザーの識別子と業務属性をログイン時に一度だけ確定し、途中のホップが変更できないようにする必要がある（[要件定義](../requirements.md)）。
[多段伝播のADR](20260930064314-multi-hop-authorization-context-propagation.md)では、これをSTSセッションのSourceIdentityと
transitive session tagsとして刻み、role chainingで運ぶ。そのため、ログイン時に両方を設定できるIdPが必要になる。
あわせて、サーバーレスとマネージドサービスを最大限に使う（要件定義）ため、自前で運用するIdPは避けたい。

`AssumeRoleWithWebIdentity`は、渡されたIDトークンの`https://aws.amazon.com/source_identity`と`https://aws.amazon.com/tags`
（`principal_tags`と`transitive_tag_keys`）の両方のクレームを読み、1回の呼び出しでSourceIdentityとtransitiveなsession tagsを設定できる。

## Decision

**Amazon Cognito User PoolをIdPとし、Identity Poolsは使わない。**

1. User PoolをIAM OIDC providerとして登録する。信頼ポリシーは`aud`＝アプリクライアントのIDで絞る。
2. Pre Token Generation **V2**トリガーで、IDトークンに`https://aws.amazon.com/source_identity`（ユーザー識別子）と
   `https://aws.amazon.com/tags`（業務属性と、引き継がせるキー）を入れる。
3. BFFが、このIDトークンで`AssumeRoleWithWebIdentity`を直接呼ぶ（[入口のADR](20260930083437-entry-via-bff.md)）。
   federated roleの信頼ポリシーには`sts:AssumeRoleWithWebIdentity`・`sts:TagSession`・`sts:SetSourceIdentity`を許す。

根拠は[実現性検証](../../experiments/feasibility/RESULTS.md)の検証3。この構成でSourceIdentityとsession tagsが1回の呼び出しで設定され、
role chainingで引き継がれることを実機で確かめた。

## 採用しなかった選択肢

- **Cognito Identity Pools**：「Attributes for access control」はprincipal tagsのマッピングに対応するが、SourceIdentityを制御する経路が
  文書にない。SourceIdentityは本構成の中心なので使えない。また、呼び出し先が自前のバックエンドだけならIdentity Poolsは不要である。
- **Pre Token Generation V1トリガー**：クレームの値が文字列だけで、配列の`transitive_tag_keys`を返せない。
- **自前で運用するIdP（Keycloakなど）**：OIDCのクレームを自由に作れるが、IdPの運用が必要になり、サーバーレスとマネージドサービスを
  最大限に使うという要件に反する。

## Consequences

### よくなること

- IdPの運用が不要。User PoolのEssentialsプランには月10,000 MAUまでの無料枠がある。
- ログイン時の1回の`AssumeRoleWithWebIdentity`で、SourceIdentityと業務属性が確定する。

### 引き受けること

- **Pre Token Generation V2にはEssentials以上のプランが必要**（新規User Poolの既定）。
- **Pre Token Generationトリガーが信頼の起点になる**。SourceIdentityとtagsの値はこのLambdaが決め、AWSは値の正しさを検証しない。
  このLambdaとUser Poolの設定の保護が重要になる。
- **session tagsの上限**：最大50個、値は単一値だけ。業務属性の表現はこの範囲に収める。
- Cognito以外のIdPを使う場合は、IAM OIDC providerとして登録でき、上の2つのクレームを入れられることが条件になる（本参照実装では扱わない）。
