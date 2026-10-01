# 検証結果：`lambda:SourceFunctionArn`の置き場所

実施：2026-10-01（UTC）、ap-northeast-1。スタック`Gekko08ExpSourceFunctionArn`（[bin/app.ts](bin/app.ts)）で、
各呼び出しを3回ずつ行った（[scripts/run.ts](scripts/run.ts)）。生データ：`out-results.json`（git管理外）。検証のあと、スタックは削除した。

目的：参照実装は、同じ実行roleを持つ別の関数からの呼び出しを拒否するため、受信側のresource policyで`lambda:SourceFunctionArn`を使っている。
公式の文書は「`lambda:SourceFunctionArn`はresource-based policyでは使えない。identity-based policyかSCPで使う」としている
（[Using source function ARN](https://docs.aws.amazon.com/lambda/latest/dg/permissions-source-function-arn.html)）。文書どおりの置き場所で、同じ性質が得られるかを確かめる。
あわせて、実行環境の外に持ち出した実行roleの認証情報で呼んだときの扱いを確かめる。

## 構成

- 呼び出し元：同じ実行role（R）を持つ2つの関数、BとB2。自分の実行roleでSigV4署名してFunction URL（`AWS_IAM`）を呼ぶ。
  Bは検証のためだけに、自分の実行roleの認証情報を返せる（実行環境の外への持ち出しを再現する）。
- C1（今の参照実装の形）：受信側のresource policyで、Rだけを許し、ほかの主体をDenyし、`lambda:SourceFunctionArn`がBでなければDenyする。
- C2（文書どおりの形）：受信側のresource policyで、Rだけを許し、ほかの主体をDenyする。Rのidentity policyに、C2に対して
  `lambda:SourceFunctionArn`がBでなければDenyする文を置く。同じアカウントでは、resource policyの許可だけで呼べるので、identity policyに
  許可の条件を書いても絞れない。そのためDenyにした。

## 結論

**文書どおりの形（C2）でも、同じ実行roleを持つ別の関数からの呼び出しを拒否できた。** 今の形（C1）と、守れるものは同じだった。

**実行環境の外に持ち出した認証情報は、どちらの形でも防げなかった。** 持ち出したBの認証情報で手元から呼ぶと、C1もC2も200だった。
キーが付かなければ（否定の条件は、キーがないと真になるので）Denyされるはずなので、Lambdaは関数のARNを認証情報そのものに刻んでいるとみられる。
`lambda:SourceFunctionArn`が区別するのは「どの関数の認証情報か」で、「実行環境の中か外か」ではない。

## 観測した事実

| 呼び出し | C1 | C2 |
|---|---|---|
| B（許可した関数）から | 200（3回） | 200（3回） |
| B2（同じ実行roleの別の関数）から | 403（3回） | 403（3回） |
| Bの実行roleの認証情報を持ち出し、手元から | 200（3回） | 200（3回） |
| 手元の主体（広い権限を持つ、Rではない主体） | 403（3回） | 403（3回） |

## 設計への示唆

1. **`lambda:SourceFunctionArn`は、呼び出し元の実行roleのidentity policyのDenyに置く。** 受信側のresource policyからは外す。
   文書どおりの使い方で、同じ性質が得られる。
2. **呼び出し元の関数の限定は、実行roleを共有する関数どうしを区別するためのもので、持ち出された認証情報への対策にはならない。**
   持ち出された認証情報は、有効期限内は、その関数として次のホップを呼べる。設計ガイドの「守らないもの」で、未確認としていた点を確定させる。
