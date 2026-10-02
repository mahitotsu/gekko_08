# ADR: デモのエージェントとMCPサーバーもLambdaのホップとして動かす

## 状態

**今有効な決定**：エージェントとMCPサーバーもLambdaのホップにし、MCPはOAuthではなく他のホップと同じ入口で守る。エージェントの実装は[Claude Agent SDKのADR](20261001040729-fraud-agent-on-claude-agent-sdk.md)による。

採用（2026-09-30）。決定1（Converse APIのループ）は、[Claude Agent SDKのADR](20261001040729-fraud-agent-on-claude-agent-sdk.md)で置き換えた。

## 背景

デモとして、AIエージェント→MCPサーバー→内部サービスのシナリオを含め、プロンプトインジェクションで誘導されたエージェントの要求が
拒否されることを示す（[要件定義](../requirements.md)）。エージェントとMCPサーバーをどこで動かすか、どのモデルを使うかを決める。

ホップ間の呼び出しは、入口で呼び出し元の実行roleと関数を確かめ（`lambda:SourceFunctionArn`）、STSが署名したJWTでユーザーを伝える
（[多段伝播のADR](20260930064314-multi-hop-authorization-context-propagation.md)、[コンピュートと通信のADR](20260930091257-lambda-function-url-without-mtls.md)）。

MCPの仕様（2026-07-28版）では、認可は任意（OPTIONAL）である。認可を実装する場合、HTTPではOAuthに従うことが推奨（SHOULD）される。

## 決定

1. **エージェントはLambdaのホップとする。** LambdaでAmazon BedrockのConverse API（ツール呼び出し）を回し、MCPクライアントとしてMCPサーバーを呼ぶ。
   モデルはClaude Haiku 4.5（Bedrock）とする。
2. **MCPサーバーもLambdaのホップとする。** 入口は他のホップと同じ（実行roleとJWT）で、OAuthの認可フローは使わない。

## 採用しなかった選択肢

- **エージェントをAgentCore Runtimeで動かす**：エージェント向けのマネージドな実行基盤だが、Lambdaを前提とした入口（`lambda:SourceFunctionArn`など）が使えず、
  ホップの仕組みが2種類になる。
- **より上位のモデル**：プロンプトインジェクションに強い可能性があるが、費用が高い。デモの目的は「判断が揺らいでも権限境界は揺らがない」ことを示すことで、
  誘導されうるモデルの方が示しやすい。

## 結果として引き受けること

### よくなること

- ホップの仕組みが1種類で済み、エージェントもMCPサーバーも他のホップと同じ共通部品で守れる。
- モデルの費用が低い。

### 引き受けること

- **MCPの認可はOAuthの推奨（SHOULD）に従わない**。仕様違反ではないが、設計書と設計ガイドに明記する。
- **JWTは`Authorization: Bearer`ではなく独自のヘッダーで渡す**。Function URLの`AWS_IAM`認証が`Authorization`ヘッダーをSigV4に使うため。
