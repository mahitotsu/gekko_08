# 検証結果：案A（IPv6の送信元で一時クレデンシャルを縛る）

実施：2026-09-30（UTC）、ap-northeast-1、Lambda Python 3.13。
目的：方式(a)（一時クレデンシャルを下流へ渡す）の漏洩リスクを、`aws:SourceIp`とIPv6で抑えられるかを確かめる
（[多段伝播の方式比較](../multi-hop-propagation/RESULTS.md)の続き）。

構成：
- VPC（IPv4 `10.8.0.0/16`＋Amazon提供のIPv6 /56）。IPv4の外向き経路はなく、IPv6の`::/0`だけをegress-only IGWへ向ける。NAT GatewayもVPCエンドポイントもない。
- サブネットA（`2406:da14:41c:3b00::/64`）にLambda A、サブネットB（`...:3b01::/64`）にLambda Bを置く（dual-stack、`Ipv6AllowedForDualStack`）。CはVPCの外。
- A・Bには`AWS_USE_DUALSTACK_ENDPOINT=true`を設定。
- Frontend（テスト用スクリプト）→ A → B → C の方式(a)。
- AaOutのtrust policyはサブネットA発、BaOutのtrust policyはサブネットB発に限る（AssumeRole・TagSession・SetSourceIdentityのすべてに`aws:SourceIp`条件）。
- Bの受信側resource policyはAaOut＋サブネットA発、Cの受信側resource policyはBaOut＋サブネットB発＋`department=sales`に限る。

テスト用スクリプトの端末はIPv6を持たず、VPCの外からIPv4で呼ぶ（持ち出された認証情報を外で使う攻撃者の役）。
生データ：`out-results.json`（git管理外）。

## 結論

**案Aは成立した。** 追加の固定費なしで、次の2つを実現できた。
- 漏れた一時クレデンシャルは、VPCの外では次のホップへのchainにも呼び出しにも使えない。
- 侵害されたホップが自分のサブネットの外向けroleを越えて、次のホップを飛ばすこともできない。

## 観測した事実

### 1. IPv6だけで届くか

- dual-stackエンドポイント`sts.ap-northeast-1.api.aws`：IPv6で接続できた（数ms）。
- 従来の`sts.ap-northeast-1.amazonaws.com`：AAAAレコードがなく、IPv4は経路がないためタイムアウトした。
  → **boto3は`AWS_USE_DUALSTACK_ENDPOINT=true`（またはConfigの`use_dualstack_endpoint`）が必須**。
- Function URL：IPv6で接続できた。IPv4はタイムアウトした。
- AssumeRole、GetWebIdentityToken、Function URLの呼び出しは、すべてIPv6経由で成功した。

### 2. `aws:SourceIp`はIPv6で判定されるか

- Bが受け取った`requestContext.http.sourceIp`は`2406:da14:41c:3b00:c1eb:ac4:b950:2f`（サブネットA）、
  Cが受け取ったものは`2406:da14:41c:3b01:9944:ac4:48de:8da`（サブネットB）だった。
- CloudTrailの`AssumeRole`イベントの`sourceIPAddress`も同じIPv6アドレスだった。
- trust policyとFunction URLのresource policyのどちらでも、IPv6 CIDRの`aws:SourceIp`条件が効いた（以下の3・4）。
- Lambdaの送信元アドレスはサブネットごとに異なり、同じ関数の呼び出しでは同じアドレスだった（Hyperplane ENI）。

### 3. 正常系とホップの飛ばし

- alice（sales）：A → B → C がすべて200。SourceIdentityとtagsはCまで保たれた。
- bob（hr）：Cで403。
- Aの中（サブネットA）から、S1（AaOut）でBaOutにchainしようとすると拒否された
  （`not authorized to perform: sts:SetSourceIdentity`。BaOutはサブネットB発のみ許可）。
  → **侵害されたAが、Bを飛ばしてCを呼ぶことはできない。**

### 4. 持ち出した認証情報をVPCの外で使う

| 試行 | 結果 |
|---|---|
| x0：FrontendのセッションS0で、外からAaOutにchain | 拒否（AccessDenied） |
| x1：Aが持ち出したS1（AaOut）で、外からBaOutにchain | 拒否（AccessDenied） |
| x2：S1で、外からBのFunction URLを呼ぶ | 403 |
| x3：Bが持ち出したS2（BaOut）で、外からCのFunction URLを呼ぶ | 403 |
| x4（対照）：S1で、外から`aws:SourceIp`で縛っていない権限（GetWebIdentityToken）を使う | **成功** |

x0・x1の拒否メッセージは`sts:SetSourceIdentity`に対するものだった（AssumeRoleで最初に評価されたため）。
いずれも、同じ操作がサブネットの中からは成功しているので、違いは送信元アドレスだけである。

## 設計への示唆

- **chain用roleのすべての権限に送信元条件が必要**。x4のとおり、条件のない権限は外から使える。
  個々のroleで書き漏らさないよう、SCP・RCPでの一括強制（`aws:SourceIp`が自社のIPv6 CIDR以外ならDeny）を検討する。
- **ホップごとにサブネットを分けることが、ワークロードの身元の代わりになる**。「どのサブネットから来たか」＝「どのホップのコードか」が成り立つのは、
  そのサブネットにそのホップのLambdaしか置かない場合に限る。配置の規律をCDK Constructで強制する必要がある。
- 残るリスク：侵害されたホップが、自分に許された範囲で、その場のユーザーの権限を使うこと（サブネットの中からの悪用）。
  これはmTLSやToken Exchangeでも残る。
- 入口（Frontend→A）は今回縛っていない。Frontendをどこで動かすか（ブラウザ直か、Lambdaか）で扱いが変わるため、設計で決める。
- 未確認：マルチAZ構成（サブネットがAZごとに増える場合の条件の書き方）、IPv6 CIDRを持ち込み（BYOIP）ではなくAmazon提供にしたときの再作成時の変化、
  dual-stackエンドポイントを持たないサービスを呼ぶ必要が出た場合の扱い。
