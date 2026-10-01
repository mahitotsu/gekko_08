# ADR: 呼び出し元の関数の限定は、呼び出し元の実行roleのidentity policyのDenyで行う

## Status

Accepted (2026-10-01)。[多段伝播のADR](20260930064314-multi-hop-authorization-context-propagation.md)の決定1のうち、
`lambda:SourceFunctionArn`を受信側のresource policyで使う部分を置き換える。

## Context

各ホップの入口では、呼び出し元ホップの実行roleだけを許し、さらに`lambda:SourceFunctionArn`で呼び出し元の関数に限っている（多段伝播のADRの決定1）。
同じ実行roleを持つ別の関数から呼べないようにするためで（SR-2）、受信側のresource policyに「`lambda:SourceFunctionArn`が呼び出し元の関数でなければDeny」
という文を置いている。実機では効いた（[Token Exchange相当の構成](../../experiments/actor-subject-jwt/RESULTS.md)）。

ところが、公式の文書は「`lambda:SourceFunctionArn`はresource-based policyでは使えない。identity-based policyかSCPで使う」と明記している
（[Using source function ARN](https://docs.aws.amazon.com/lambda/latest/dg/permissions-source-function-arn.html)）。実機で効いたのは文書にない挙動で、
SR-2の境界をそこに置き続けると、AWSの変更で黙って効かなくなるおそれがある。外部のレビュー（2026-10-01）でも、最優先の指摘とされた。

[置き場所の検証](../../experiments/source-function-arn/RESULTS.md)で、次のことを確かめた。

- 呼び出し元の実行roleのidentity policyに「受信側に対して、`lambda:SourceFunctionArn`が呼び出し元の関数でなければDeny」を置くと、
  同じ実行roleを持つ別の関数からの呼び出しは403になった。受信側のresource policyで使う形と、結果は同じだった。
- 同じアカウントでは、受信側のresource policyの許可だけで呼べる。identity policyに許可の条件を書いても絞れないので、Denyにする必要がある。
- 実行環境の外に持ち出した認証情報で呼ぶと、どちらの形でも通った。関数のARNは、認証情報そのものに刻まれているとみられる。

## Decision

**`lambda:SourceFunctionArn`は、受信側のresource policyでは使わず、呼び出し元の実行roleのidentity policyのDenyで使う。**

1. 受信側のresource policyは、許可した実行role以外の主体をDenyし（`ArnNotEquals aws:PrincipalArn`）、許可した実行roleに呼び出しを許す。
   `lambda:SourceFunctionArn`の条件は置かない。
2. 呼び出し元の実行roleに、受信側ごとに「`lambda:InvokeFunctionUrl`と`lambda:InvokeFunction`を、`lambda:SourceFunctionArn`が許可した呼び出し元の関数でなければDeny」
   する文を持たせる。`Hop.allowCaller()`が、ほかの権限と一緒に生成する。
3. この文は、roleの既定のポリシーとは別のポリシーにする。関数がこのポリシーに依存しないので、呼び出し元と受信側の間に循環参照が生じない。

## 採用しなかった選択肢

- **今のまま、受信側のresource policyで使う**：実機では効くが、文書は使えないとしている。セキュリティの境界を、文書にない挙動に置かない。
- **呼び出し元の関数の限定をやめる**：参照実装はホップごとに実行roleを分けているので、今は実害がない。ただし、利用者が実行roleを共有すると、
  共有した関数どうしを区別できなくなる。費用の小さい防御なので残す。
- **SCPで限る**：文書どおりの使い方だが、Organizationsが要り、`cdk deploy`だけで再現できなくなる（NFR-4）。

## Consequences

### よくなること

- セキュリティの境界が、文書に書かれた使い方の上に乗る。
- 呼び出し元の関数の限定が、呼び出し元の側の権限として見えるようになる（受信側のresource policyが小さくなる）。

### 引き受けること

- **呼び出し元の関数の限定は、呼び出し元の実行roleが自分で持つDenyに依存する**。実行roleのポリシーを書き換えられる主体（アカウントの管理者）は、
  このDenyを外せる。これは今のresource policyの形でも同じで、管理者に対する境界はアカウントの分離やSCPで作る（設計の前提どおり）。
- **持ち出された認証情報には効かない**。`lambda:SourceFunctionArn`が区別するのは、どの関数の認証情報かであって、実行環境の中か外かではない。
  持ち出された実行roleの認証情報は、有効期限内は、その関数として次のホップを呼べる。
- **実行roleを共有する複数の関数を呼び出し元にする場合**は、そのroleのDenyの条件に、許可する関数をすべて並べる必要がある。`Hop`は、
  呼び出し元の実行roleごとに許可する関数をまとめて条件にする。
