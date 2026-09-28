# ADR 0001: SPIRE agentの実行基盤はself-managed EC2を採用する

## Status

Accepted (2026-09-29)

## Context

ECSバックエンドのmTLS化にあたり、SPIRE agentの配置先として以下3案を検討した。

- 案A: self-managed ECS on EC2（自前のAuto Scaling Group）+ 従来のDAEMON
  スケジューリング戦略、またはホストレベルのSPIRE agent
- 案B: ECS Managed Instances + Managed Daemon（2026年4月GAの新機能）
- 案C: AWS Fargate

パッチ適用の自動化・容量の弾力性・SSH不要な運用など、案Bには運用上の
メリットが大きく、当初は案Bを本命として検討していた。そのため、SPIRE
agentが必要とする以下2点の到達性を実機で検証した。

- node attestation(`aws_iid`)に必要なIMDSv2への到達性
- workload attestation(`docker`アテスタ)に必要なdocker.sockへの到達性

案Cは実地検証以前の設計段階で却下した(理由はDecision参照)。

## Decision

**案A(self-managed EC2)を採用する。**

### 案A(self-managed EC2)を採用した理由

案Aを積極的に選んだというより、運用上のメリットが大きかった案Bを
技術的制約により断念した結果の消去法での採用である。案C(Fargate)も
構造的な制約で候補になり得なかった(後述)。案Aが持つ「AMI・user-data・
SSHのすべてに手が届き、IMDSホップリミットやdocker.sockアクセスなどの
ホスト設定を自分たちで調整できる」という性質は、案Bで実際に直面した
制約を回避できる唯一の選択肢だった、というのが採用の実際の根拠である。

### 案B(Managed Instances + Managed Daemon)を却下した理由

実機検証の結果、IMDSv2・docker.sockのいずれにも到達できなかった
（Managed Instancesの`HttpPutResponseHopLimit: 1`等、ホストの構造的な
制約による）。ECS Container Metadata v4は到達可能だったため、
メタデータベースのworkload attestorという代替手段自体はあるが、
node attestationの代替(`join_token`方式)を含めても、AMI・user-data・
SSH・エージェント設定のいずれにも手が届かないためこちら側で制約を
修正できず、Managed Instances固有の運用上の制約（`cdk destroy`の
既知の未解決バグ[aws/aws-cdk#36071](https://github.com/aws/aws-cdk/issues/36071)
を含む）も積み重なった。

### 案C(Fargate)を却下した理由

Fargateは実地検証を行うまでもなく、SPIRE agentを「ノード単位で動かし、
同一ノード上の複数ワークロードの信頼を仲介する」という今回のモデルと
構造的に相容れないため却下した。

- Fargateにはタスク間で共有される永続的な「ノード」という概念が無く、
  タスクごとに隔離されたmicroVMが割り当てられる。DAEMON戦略・Managed
  Daemonのような「ノードに1エージェント、複数ワークロードがそれを共有
  する」という配置がそもそも成立しない。
- `aws_iid` node attestorはEC2のInstance Identity Documentを前提にして
  おり、Fargateのタスクメタデータモデルには適用できない。SPIRE公式の
  GitHub Issueでも「FargateのSPIRE AgentはインスタンスIDを取得できない」
  ことが既知の制約として挙がっている
  ([spiffe/spire#3261](https://github.com/spiffe/spire/issues/3261))。
- Fargateで実現するには「SPIRE agentを各タスクにサイドカーとして同梱し、
  ノード単位のnode attestationを行わずタスク単位でSTSトークン等により
  attestationする」という別アーキテクチャが必要になる。これは今回比較
  した案A/案Bとは前提が異なる別の設計であり、かつSPIRE agentの数がタスク
  数分に比例して増えるため、共有ノードエージェント方式に比べてリソース
  効率でも劣る。
- 将来的に純粋なFargate中心の構成を採る場合は、上記のサイドカー方式を
  別途評価する必要がある。本ADRの対象外とする。

## Consequences

- AMI・user-data・SSHへの完全な制御を得られ、IMDSホップリミットや
  docker.sockアクセスなど、SPIRE agentの要件に合わせた調整が可能になる。
- 一方でパッチ適用・容量管理などManaged Instancesが提供していた運用上の
  メリットは自前で負う。

## この決定を見直すべき条件

本決定は「案Bの運用上のメリットは認めつつ、技術的制約により断念した」
消去法での選択であり、案Bを塞いでいる制約はAWS側の仕様変更で解消され得る。
以下のいずれかが解消された場合は、案Bへの切り替えを再検討する価値がある。

- Managed InstancesでIMDSホップリミットをこちらで設定できるようになる
  (現状デフォルト`1`固定で変更不可)
- Managed DaemonのコンテナからDocker関連情報(docker.sock相当)にアクセス
  できるようになる
- Managed Instancesでエージェント設定(`ecs.config`相当)・AMI・user-data
  のいずれかをカスタマイズできるようになる
- `cdk destroy`の既知バグ([aws/aws-cdk#36071](https://github.com/aws/aws-cdk/issues/36071))
  が解消される

これらはいずれも本ADR作成時点(2026-09-29)でのAWSの仕様・CDKの実装状況に
基づく制約であり、恒久的な制約ではない。
