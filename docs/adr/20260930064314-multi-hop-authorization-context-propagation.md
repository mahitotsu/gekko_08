# ADR: 多段呼び出しでは、actorを呼び出し元の実行roleで、subjectをSTSが署名したJWTで伝える

## Status

Accepted (2026-09-30)。業務属性をtransitive session tagで運ぶ部分は、[委任の範囲と業務的なアクセス権のADR](20260930150529-delegation-scope-and-entitlements.md)で
取引の目的を運ぶことに置き換えた（業務的なアクセス権は属性サービスから得る）。actorとsubjectを分ける決定は変わらない。
決定1のうち、`lambda:SourceFunctionArn`を受信側のresource policyで使う部分は、[置き場所のADR](20261001094443-source-function-arn-in-caller-identity-policy.md)で、
呼び出し元の実行roleのidentity policyのDenyに置き換える。

## Context

ユーザーの権限を多段呼び出しの最後のホップまで届けたい。要件は、OAuth Token Exchangeと同等のことをAWSのマネージドサービスで実現することである
（[PRFAQ](../prfaq/aws-authorization-context-propagation.md)）。つまり各ホップが次の3つを確実に知れればよい。

| 知るべきこと | Token Exchangeでの担い手 |
|---|---|
| 誰の代理か（subject、業務属性） | トークンの`sub`とクレーム |
| どのサービスから来たか（actor） | 呼び出し元のクライアント認証 |
| 自分宛てか | トークンの`aud` |

認可判定は、各ホップのアプリが検証済みの属性を使って行う（ABAC）。データへのアクセスは、各ホップが自分の実行roleで行う。

ログイン時に`AssumeRoleWithWebIdentity`でSTSセッションへ刻んだSourceIdentityとtransitive session tagsは、role chainingでのみ
偽装されずに引き継げる。受信側が自分で設定し直す方式は偽装が成立し、`GetWebIdentityToken`のJWTでIAMセッションに戻す方式は
IAMが同一パーティションのSTS発行者の登録を拒否した（[多段伝播の方式比較](../../experiments/multi-hop-propagation/RESULTS.md)）。
したがって、次のホップ向けに「aliceの代理」を証明するには、aliceの属性を持つセッションを受け渡す必要がある。

当初は、このセッションで次のホップを呼び、受信側の入口でIAMにユーザーの属性を判定させる構成を検討した。この構成では受け渡すセッション自体が
ホップの呼び出し権限を持つため、漏れると外から使え、侵害されたホップが次のホップを飛ばすこともできた。IPv6の送信元アドレスで使用場所を縛れば
防げることは確かめたが（[IPv6送信元による縛り](../../experiments/network-binding/RESULTS.md)）、ホップのLambdaをVPCにつなぐ必要がある。

そこで、呼び出しの許可（actor）とユーザーの証明（subject）を分ける構成を検証し、成立した
（[Token Exchange相当の構成](../../experiments/actor-subject-jwt/RESULTS.md)）。

## Decision

**actorは受信側の入口で呼び出し元の実行roleをIAMが確かめ、subjectとaudはSTSが署名したJWTをアプリが検証する。受け渡すセッションには、
次のホップ宛てのJWTを作る以上の価値を持たせない。**

1. **actor（入口）**：各ホップのFunction URL（`AWS_IAM`認証）のresource policyで、呼び出し元ホップの**実行role**だけを許可し、
   `lambda:SourceFunctionArn`で呼び出し元の関数に限る。許可したrole以外は`ArnNotEquals aws:PrincipalArn`で明示的にDenyする
   （同じアカウントの広いidentity policyによる呼び出しを塞ぐため）。呼び出しには、呼び出し元の実行roleの認証情報で署名する。
2. **subjectとaud（JWT）**：呼び出し元は、aliceの属性を持つセッションで`GetWebIdentityToken`を呼び、`aud`＝次のホップのJWTを
   リクエストヘッダーに付ける。受信側のアプリは、自アカウントのSTS発行者のJWKSで署名を検証し、`aud`＝自分、`iss`＝自アカウントの発行者、
   `exp`、`sub`＝期待する呼び出し元のchain用roleを確かめてから、`https://sts.amazonaws.com/`名前空間の`source_identity`と
   `principal_tags`を使う。ヘッダーや引数による自己申告は読まない。
3. **chain用role**：ホップごとに1つ持つ。権限は「次のホップのchain用roleへのchain」と「次のホップ宛てJWTの発行」（`sts:IdentityTokenAudience`で
   宛先を限定）だけで、ホップの呼び出し権限もデータの権限も持たせない。trust policyは、`sts:TagSession`を`aws:TagKeys`でログイン時に決めたキーだけに絞る。
4. **受け渡し**：各ホップは、受け取ったセッションで自分のchain用roleにchainし（有効期間900秒）、そのセッションを次のホップへ渡す。
   認証情報をログ・トレース・エージェントのLLMのコンテキストに入れない。

## 採用しなかった選択肢

- **受け渡すセッションで次のホップを呼び、入口でIAMにユーザーの属性を判定させる**：最後のホップまでIAMが属性を判定できるが、受け渡すセッションが
  ホップの呼び出し権限を持つため、漏れると外から使え、侵害されたホップが次のホップを飛ばせる。防ぐにはIPv6の送信元による縛りとVPCが要る。
- **IPv6の送信元アドレスで使用場所を縛る**（上の構成への対策）：実機で成立したが、VPCとゾーン設計の負担を負う。本構成では受け渡すセッションに
  価値がないため不要。chain用roleやJWTの発行をさらに縛る追加の強化策としては使える。
- **受信側がSourceIdentityを付け直す**：受信側（caller）がAuthorization Contextを作れてしまい、偽装が成立した。
- **JWTでIAMセッションに戻す**：IAMが同一パーティションのSTS発行者をOIDC providerとして登録させない。
- **chain用のAssumeRoleを事前署名して渡す**：STSは`X-Amz-Expires`を守らず（5秒で署名したURLが20秒後も有効だった）、有効期限も再利用の可否も
  セッションを渡す場合と変わらない。得るものが小さい。
- **一時クレデンシャルをKMSで受信ホップ宛てに暗号化する**：通信路はTLSで守られており、追加で守れるのは受信ホップの内側だけ。本構成では漏れても害がない。
- **ホップ宛てトークンを発行するOIDC発行者を自作する**：AWSの秘密鍵を渡さずに済むが、実質的にToken Exchangeの自作で、ホップごとに発行者への往復と
  署名鍵の管理を負う。

## Consequences

### よくなること

- Token Exchangeと同じく、各ホップがsubject・actor・audを確かめられる。認可サーバーは持たず、JWTの署名はSTSが行う。
- 受け渡すセッションが漏れても、それで呼べるホップはない（chain用roleどうしのchainと、許された宛先のJWTの発行しかできない）。
- ホップの飛ばしは入口で拒否される。同じ実行roleを共有する別の関数からの呼び出しも、`lambda:SourceFunctionArn`で拒否される。
- VPCは不要で、純粋なサーバーレス構成のまま使える。
- CloudTrailの`GetWebIdentityToken`・`AssumeRole`イベントに、元のユーザー（`sourceIdentity`）が記録される。

### 引き受けること

- **ユーザーの属性による認可はアプリが行う**：入口のIAMはactorだけを確かめる。JWTの検証とABACを各ホップが正しく実装する必要がある
  （参照実装で共通部品として提供する）。
- **レイテンシ**：1ホップあたり、ウォームで約0.5秒（chainとJWTの発行）、コールドスタート直後はさらにJWKSの取得などが加わった（最適化前の実測）。
- **認証情報の受け渡しは残る**：受け渡すセッションに価値はないが、平文の認証情報をログ等に出さない規律は引き続き必要。
- **入口のDenyを書き漏らすと穴になる**：同じアカウントの広いidentity policyを持つ主体が、漏れたセッションで作ったJWTを使って呼べる（実機で確認）。
  CDK Constructで強制する。
- **残余リスク**：侵害されたホップが、自分に許された範囲でaliceとして振る舞えること（Token Exchangeでも同じ）。
- **JWTの宛先の管理**：`GetWebIdentityToken`の宛先を内部のホップに限る。外部サービスがこのJWTを単独で信じると、そこではaliceになりすませる。
- **role chainingの1時間上限**（有効期間900秒のため、実質15分ごとのchain）。
