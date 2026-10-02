# ADR: ホップはLambdaで動かし、ホップ間はFunction URLの`AWS_IAM`認証で守る。mTLSは使わない

## 状態

採用（2026-09-30）

## 背景

各ホップは「どのサービスから来たか」を確かめられる必要があり、そのための仕組みはサーバーレスとマネージドサービスで実現したい
（[要件定義](../requirements.md)）。

従来の正攻法は、SPIFFE/SPIREでワークロードごとにX.509証明書を配り、mTLSで通信相手を確かめる構成である。mTLSが守っているのは、
「正規に配置された（attestation済みの）ワークロードしか接続できない」という参加資格である。ただし、SPIRE server・agentの運用と、
証明書の配布・更新が必要になる。以前の検討では、SPIRE agentをどの実行基盤に置くかが問題になり、LambdaやFargateのような
マネージドな実行基盤とは構造的に噛み合わなかった。

AWSでは、この参加資格をネットワークではなくIAMで守れる。Lambda Function URLを`AWS_IAM`認証にすると、呼び出しにはSigV4署名が必要になり、
Lambdaが関数を起動する前にIAMで判定する。受信側はresource policyで、許可する呼び出し元のroleを明示できる。

## 決定

**ホップはAWS Lambdaで動かし、ホップ間の呼び出しはFunction URL（`AWS_IAM`認証）で行う。mTLSは要件から外し、サーバー認証のTLSとIAMで代替する。**

1. 各ホップはLambda関数とし、Function URLを`AWS_IAM`認証で公開する。TLSの証明書はAWSが管理する。
2. 呼び出し元は自分の実行roleでSigV4署名し、受信側はresource policyで呼び出し元の実行roleと関数を許可する
   （具体的な書き方は[多段伝播のADR](20260930064314-multi-hop-authorization-context-propagation.md)）。

根拠は[実現性検証](../../experiments/feasibility/RESULTS.md)の検証1・2と、[Token Exchange相当の構成](../../experiments/actor-subject-jwt/RESULTS.md)。

- resource policyだけで許可したroleは200、許可していないroleと署名のないリクエストは403だった（関数コードに届く前に拒否）。
- 受信側には呼び出し元の`userArn`が渡る。`lambda:SourceFunctionArn`で、同じ実行roleを持つ関数どうしも区別できた。
- Lambdaの実行roleから`GetWebIdentityToken`を呼べ、JWTに`lambda_source_function_arn`が入る。

## 採用しなかった選択肢

- **SPIFFE/SPIREによるmTLS**：SPIRE server・agentの運用、証明書の配布・更新が必要で、常駐コンポーネントを持たないという要件に反する。
  Lambdaのようなマネージドな実行基盤とは、agentの配置やworkload attestationの点で噛み合わない。
- **ECS（ALB＋ACM証明書）**：サービスが直接呼び合う構成では、ALBの管理範囲外になり、サービスごとに証明書を用意・更新する必要が出る。
  `GetWebIdentityToken`のECSタスク固有のクレームも文書で確認できていない。
- **API Gateway（IAM認可）**：Function URLと同じくマネージドなTLSとIAM認可を持ち、プライベート統合でネットワークの到達範囲も絞れる。
  ただし構成要素とリクエスト課金が増える。ネットワークの制限を追加の防御として重ねたい場合の選択肢として残す。

## 結果として引き受けること

### よくなること

- 証明書の用意・更新が不要。TLSの終端はAWSが管理する。
- 参加資格（許可された呼び出し元だけが呼べること）を、アプリのコードに頼らずIAMが強制する。
- 常駐コンポーネントを持たない。Function URL自体に追加料金はかからない。

### 引き受けること

- **Function URLはインターネット経由でしか届かない**（PrivateLinkに対応しない）。参加資格はネットワークの到達範囲ではなくIAMで守る。
  S3やSQSが公開エンドポイントを持ちつつIAMでアクセスを制御しているのと同じ考え方である。
- **resource policyが唯一の許可リストになるわけではない**：同じアカウント内では、呼び出し元のidentity policyの広い許可でも呼べる。
  許可したrole以外を明示的にDenyする必要がある（多段伝播のADR）。
- **`PutResourcePolicy`は既存のresource policyを置き換える**：`AddPermission`と同じ関数で併用しない。
- mTLSが持っていた送信者の拘束はない。SigV4では秘密鍵（`SecretAccessKey`）が通信路に乗らず、署名はリクエストと時刻に縛られるので、
  通信路で盗み見た値から新しいリクエストは作れない。実行環境から認証情報そのものが漏れた場合の扱いは、多段伝播のADRで整理している。
- コンピュートはLambdaに限られる。Lambda以外で動かす場合は、`GetWebIdentityToken`のクレームや呼び出し元の確かめ方を改めて検討する必要がある（本参照実装では扱わない）。
