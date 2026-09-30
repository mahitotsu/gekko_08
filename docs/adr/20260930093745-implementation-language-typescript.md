# ADR: LambdaはTypeScriptで実装し、AWS SDKを関数に同梱する

## Status

Accepted (2026-09-30)

## Context

各ホップとBFFのLambdaを実装する言語を決める。検証はすべてPythonで行い、ランタイム同梱のboto3で`GetWebIdentityToken`が動くことを確かめた。
一方、インフラはCDK（TypeScript）で書く。

Node.jsのランタイムに同梱されるAWS SDKの版は、ランタイム側の更新に依存する。`GetWebIdentityToken`は2025年11月に追加されたAPIである。
AWS SDK for JavaScript v3の`@aws-sdk/client-sts` 3.1143.0に`GetWebIdentityTokenCommand`があることは確認した。

## Decision

**LambdaはTypeScriptで実装し、CDKの`NodejsFunction`でAWS SDK v3を関数に同梱する。** JWTの検証には`jose`を使う。

## 採用しなかった選択肢

- **Python**：検証済みの経路をそのまま使えるが、CDKと言語が分かれる。

## Consequences

### よくなること

- インフラ・Lambda・共通部品・テストを同じ言語で書ける。型定義を共有できる。
- SDKを同梱するので、ランタイムの更新を待たずに必要なAPIを使える。

### 引き受けること

- 検証はPythonで行ったため、TypeScriptでの実装はテストで改めて確かめる必要がある。
- SDKを同梱する分、デプロイパッケージが大きくなり、コールドスタートがわずかに伸びうる。
- 共通部品はTypeScriptのパッケージとして提供するので、TypeScript以外で書かれた関数からは使えない。他の言語で使うには、共通部品の機能を別に提供する必要がある。
