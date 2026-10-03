"""全体構成の図を、AWSの公式アイコンで生成する。

生成のしかたは docs/diagrams/README.md にある。構成を変えたら、このファイルを直して生成し直し、
生成した architecture.png も一緒にコミットする。文字の正本は設計書§2の表である。

実線はホップの呼び出し、点線はAWSのサービスの呼び出し。各ホップに共通する呼び出し（STS、ログ、スパン）は、
ホップのまとまりから1本で描く。
"""

from pathlib import Path

from diagrams import Cluster, Diagram, Edge, Node
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.devtools import XRay
from diagrams.aws.management import Cloudtrail, Cloudwatch, SystemsManagerParameterStore
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import CloudFront
from diagrams.aws.security import Cognito, IAMAWSSts
from diagrams.aws.storage import SimpleStorageServiceS3
from diagrams.onprem.client import User

FONT = "Noto Sans CJK JP"
# 2行のラベルがアイコンに重ならないよう、ノードの高さの基準（既定は1.9）を上げる
Node._height = 2.2
OUT = Path(__file__).with_name("architecture")
HOPS = "ホップ（Lambda。Function URLはAWS_IAM認証）"

graph_attr = {
    "fontname": FONT, "fontsize": "15", "pad": "0.5", "nodesep": "0.7", "ranksep": "1.1",
    "splines": "spline", "compound": "true", "bgcolor": "white",
}
node_attr = {"fontname": FONT, "fontsize": "12"}
edge_attr = {"fontname": FONT, "fontsize": "11", "color": "#232f3e"}


def aws_call(label: str = "", **kw) -> Edge:
    return Edge(label=label, color="#8a96a3", style="dashed", fontcolor="#5f6b7a", **kw)


with Diagram("", filename=str(OUT), outformat="png", show=False, direction="LR",
             graph_attr=graph_attr, node_attr=node_attr, edge_attr=edge_attr):
    browser = User("ブラウザ")

    with Cluster("AWS（ap-northeast-1、単一のアカウント）"):
        cdn = CloudFront("CloudFront")
        static = SimpleStorageServiceS3("S3\n静的な画面")

        with Cluster("bffが使うもの"):
            cognito = Cognito("Cognito\nUser Pool")
            ssm = SystemsManagerParameterStore("Parameter Store\nbffの設定")
            sessions = Dynamodb("DynamoDB\nセッション")

        with Cluster(HOPS):
            bff = Lambda("bff")
            case = Lambda("case-service")
            agent = Lambda("fraud-agent")
            audit = Lambda("audit-service")
            mcp = Lambda("fraud-mcp")
            account = Lambda("account-service")
            ent = Lambda("entitlement-service\n属性サービス")

        sts = IAMAWSSts("STS\nchain、JWTの発行")
        ddb = Dynamodb("DynamoDB\n案件、口座、人事データ")
        bedrock = Bedrock("Bedrock\nClaude Haiku 4.5")

        with Cluster("追跡と監査"):
            xray = XRay("X-Ray\nスパンの受け口")
            logs = Cloudwatch("CloudWatch\nログ、スパン")
            trail = Cloudtrail("CloudTrail\nSTSの呼び出し")

    browser >> cdn
    cdn >> static
    cdn >> Edge(label="/api/*") >> bff
    bff >> aws_call() >> cognito
    bff >> aws_call() >> ssm

    bff >> case >> account
    bff >> agent >> mcp
    mcp >> case
    mcp >> account
    bff >> audit
    bff >> ent
    case >> ent
    account >> ent
    audit >> ent

    agent >> aws_call() >> bedrock
    ent >> aws_call("各ホップ", ltail=f"cluster_{HOPS}") >> sts
    bff >> aws_call() >> sessions
    for hop in (case, account, ent):
        hop >> aws_call() >> ddb
    ent >> aws_call("スパン", ltail=f"cluster_{HOPS}") >> xray
    ent >> aws_call("ログ", ltail=f"cluster_{HOPS}") >> logs
    xray >> aws_call() >> logs
    sts >> Edge(color="#8a96a3", style="dotted") >> trail
    audit >> aws_call("読む") >> logs
    audit >> aws_call("読む") >> trail
