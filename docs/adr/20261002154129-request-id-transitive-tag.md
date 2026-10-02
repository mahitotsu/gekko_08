# ADR: リクエストIDをtransitive session tagとして刻み、途中のホップに変えさせない

## Status

Accepted (2026-10-03)。[監査サービスのADR](20261002074437-audit-service.md)の「引き受けること」のうち、「リクエストIDはSTSもIAMも強制しない」を改訂する。

## Context

bffはリクエストごとにIDを発行し、ヘッダー（`x-request-id`）と、各chainで作るセッションの名前（`RoleSessionName`）で下流へ引き継ぐ。
そのセッションによる`AssumeRole`と`GetWebIdentityToken`のイベントは`Username`にこの名前が残るので、監査サービスは、
CloudTrailのイベントをリクエストIDで引き、ホップの記録と突き合わせる。

これまでリクエストIDは追跡のための値で、STSもIAMも強制しなかった。乗っ取られたホップは、下流に渡すリクエストIDを別の値にできる。
そうすると、そのホップから先のイベントはリクエストIDで引けず、監査の画面では「未着」と区別できない（FR-6の追跡と、FR-7(d)の突き合わせが、
侵害されたホップの協力に依存する）。設計ガイドの「将来の拡張」に、取引の目的と同じ仕組みで刻む案を挙げていた。

## Decision

**bffは、リクエストIDを取引の目的と同じくtransitive session tag（キー`requestId`）として刻む。IAMは、各chainの`RoleSessionName`を、
刻まれたリクエストIDと同じ値に限る。受信側は、JWTの`principal_tags.requestId`とヘッダーのリクエストIDを照合する。**

1. **刻む**：bffは、目的用のroleへのchainで、`Tags`に`purpose`と`requestId`を、`TransitiveTagKeys`に両方を指定する。`RoleSessionName`もリクエストIDにする。
2. **IAMで縛る**：
   - 目的用のroleの信頼ポリシー：`sts:AssumeRole`に`"StringEquals": { "sts:RoleSessionName": "${aws:RequestTag/requestId}" }`を付ける。
     刻むtagとセッション名が同じ値でなければ引き受けられない。`sts:TagSession`で許すキーに`requestId`を加える。
   - 各chain用roleの信頼ポリシー：呼び出し元からの`sts:AssumeRole`に`"StringEquals": { "sts:RoleSessionName": "${aws:PrincipalTag/requestId}" }`を付ける。
     `sts:SetSourceIdentity`は別の文にし、`sts:TagSession`で許すキーに`requestId`を加える（transitive tagは引き継ぐだけで、上書きはSTSが拒否する）。
3. **受信側で照合する**：共通部品の受信の検証は、JWTの`principal_tags.requestId`がなければ401、ヘッダーのリクエストIDと違えば401を返す。
4. **拒否の記録も刻まれた値に結びつける**：ヘッダーのリクエストIDは、検証するまで呼び出し元の自己申告である。食い違いで拒否したときは、ログに
   JWTに刻まれていた値（`stampedRequestId`）も書き、監査サービスはその値で記録を引く。ヘッダーを偽った呼び出しは、本当の取引の監査に「偽ったリクエストID」として出て、
   名乗られた取引の監査には出ない。
5. **監査の操作も取引として扱う**：監査サービスも同じ仕組みで守るホップなので、監査の操作（一覧、突き合わせ）にもbffがリクエストIDを刻む。
   監査の一覧には、監査の操作も載せ、監査した取引のリクエストIDを添える。誰がいつどの取引を監査したかを、同じ画面で追える。

## 採用しなかった選択肢

- **今のまま（強制しない）**：監査の突き合わせが、侵害されたホップの協力に依存したまま残る。tagと条件を1つずつ加えるだけで外せる。
- **受信側の照合だけにする（IAMで縛らない）**：ヘッダーとJWTの食い違いは見つけられるが、乗っ取られたホップは、chainの`RoleSessionName`を別の値にしてから
  下流を呼ばずにJWTを発行できる。CloudTrailのイベントをリクエストIDで引けなくなることは防げない。
- **セッション名ではなく`sts:SourceIdentity`に含める**：SourceIdentityはユーザー識別子として使っており、監査や属性サービスの照合が値の形に依存する。

## Consequences

### よくなること

- 途中のホップは、下流に渡すリクエストIDを変えられない。ヘッダーを変えれば受信側が拒否し、セッション名を変えればIAMがchainを拒否する。
- CloudTrailのイベントを、リクエストIDで漏れなく引ける。監査の画面で、ホップの侵害による「未着」を考えなくてよくなる（CloudTrailの遅れによる未着は残る）。
- リクエストIDを偽った呼び出しは、本当の取引の監査に、偽った値とともに出る。

### 引き受けること

- **tagが1つ増える**：セッションのtagの大きさの上限（packed policyとtagの合計）に、リクエストIDの分が加わる。リクエストIDは64文字以内（`RoleSessionName`の制約）。
- **`AssumeRoleWithWebIdentity`のセッション名は縛らない**：federated roleはIDトークンで引き受け、tagを持たない。bffが作るセッションで、bffは信頼の起点である。
- **bffは、どの値でも刻める**：リクエストIDを決めるのはbffで、bffが侵害されれば任意の値を刻める（取引の目的と同じ）。
- **JWTを検証できない拒否は、ヘッダーの値でしか引けない**：JWTがない、署名が違うなどで拒否した記録には刻まれた値がなく、名乗られたリクエストIDで記録する。
- **監査の一覧が増える**：監査の画面を開くたびに、監査の操作が1件ずつ加わる。ログインのセッションごとにまとめて表示する。
