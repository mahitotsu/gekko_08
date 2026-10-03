"""全体構成の図を、AWSの公式アイコンで生成する。

生成のしかたは docs/diagrams/README.md にある。構成を変えたら、このファイルを直して生成し直し、
生成した architecture.png も一緒にコミットする。文字の正本は設計書§2の表である。

線を直線にして交差を減らすため、Graphvizのneatoで、各ノードを座標（インチ）で固定して置く。
neatoは入れ子の枠を描かないので、まとまり（ホップ、bffが使うもの、追跡と監査）は最上位の枠にし、
AWSのアカウントの境界は、背景に置いた塗りのない四角で表す。
実線はホップの呼び出し、点線はAWSのサービスの呼び出し。各ホップに共通する呼び出し（STS、スパン、ログ）は、ホップの枠の右端から1本で描く。
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

graph_attr = {
    "layout": "neato", "inputscale": "1", "overlap": "true", "splines": "false",
    "fontname": FONT, "fontsize": "15", "pad": "0.3", "bgcolor": "white",
}
node_attr = {"fontname": FONT, "fontsize": "13"}
edge_attr = {"fontname": FONT, "fontsize": "13", "color": "#232f3e", "penwidth": "1.8", "arrowsize": "0.9"}
GRAY = "#5f6b7a"

# 行（y）の位置。単位はインチ
TOP, AGENT, MAIN, LOW, BOTTOM = 8.8, 5.6, 2.4, -0.8, -3.2


def at(x: float, y: float) -> dict:
    return {"pos": f"{x},{y}!", "pin": "true"}


def waypoint(x: float, y: float) -> Node:
    """線を折り曲げるための見えない点。"""
    return Node("", shape="point", width="0.01", style="invis", **at(x, y))


def aws_call(label: str = "", **kw) -> Edge:
    return Edge(label=label, color=GRAY, style="dashed", penwidth="2.2", fontcolor="#3d4651", **kw)


with Diagram("", filename=str(OUT), outformat="png", show=False,
             graph_attr=graph_attr, node_attr=node_attr, edge_attr=edge_attr):
    # AWSのアカウントの境界（背景。最初に置いて、ほかのノードの下に描く）
    Node("AWS（ap-northeast-1、単一のアカウント）", shape="box", style="rounded,dashed", color="#8c4fff", penwidth="2",
         fontcolor="#8c4fff", labelloc="t", width="23.6", height="15.2", fixedsize="true", **at(13.5, 2.7))

    browser = User("ブラウザ", **at(-0.6, MAIN))
    cdn = CloudFront("CloudFront", **at(2.4, MAIN))
    static = SimpleStorageServiceS3("S3\n静的な画面", **at(2.4, LOW))
    bedrock = Bedrock("Bedrock\nClaude Haiku 4.5", **at(11.4, TOP))
    sts = IAMAWSSts("STS", **at(20.4, 6.0))
    ddb = Dynamodb("DynamoDB\n案件、口座、人事データ", **at(19.8, LOW))

    with Cluster("bffが使うもの"):
        cognito = Cognito("Cognito\nUser Pool", **at(3.0, TOP))
        ssm = SystemsManagerParameterStore("Parameter Store\nbffの設定", **at(5.4, TOP))
        sessions = Dynamodb("DynamoDB\nセッション", **at(7.8, TOP))

    with Cluster("ホップ（Lambda。Function URLはAWS_IAM認証）"):
        bff = Lambda("bff", **at(5.4, MAIN))
        agent = Lambda("fraud-agent", **at(8.4, AGENT))
        mcp = Lambda("fraud-mcp", **at(12.0, AGENT))
        case = Lambda("case-service", **at(12.0, MAIN))
        account = Lambda("account-service", **at(15.6, MAIN))
        audit = Lambda("audit-service", **at(8.4, LOW))
        ent = Lambda("entitlement-service\n属性サービス", **at(14.4, LOW))
        hops_edge = waypoint(17.4, MAIN)

    with Cluster("追跡と監査"):
        trail = Cloudtrail("CloudTrail\nSTSの呼び出し", **at(23.6, 6.0))
        xray = XRay("X-Ray\nスパンの受け口", **at(23.6, 3.0))
        logs = Cloudwatch("CloudWatch\nログ、スパン", **at(23.6, 0.0))
        audit_in = waypoint(23.6, -1.6)

    # 入口
    browser >> cdn
    cdn >> static
    cdn >> Edge(label="/api/*") >> bff
    bff >> aws_call() >> cognito
    bff >> aws_call() >> ssm
    bff >> aws_call() >> sessions

    # ホップの呼び出し
    bff >> agent >> mcp
    bff >> case >> account
    mcp >> case
    mcp >> account
    bff >> audit
    bff >> ent
    case >> ent
    account >> ent
    audit >> ent

    # AWSのサービスの呼び出し
    agent >> aws_call() >> bedrock
    for hop in (case, account, ent):
        hop >> aws_call() >> ddb
    hops_edge >> aws_call("各ホップ：chain、JWTの発行") >> sts
    hops_edge >> aws_call("各ホップ：スパン") >> xray
    hops_edge >> aws_call("各ホップ：ログ") >> logs
    xray >> aws_call() >> logs
    sts >> Edge(color=GRAY, style="dotted", penwidth="2.2", label="記録") >> trail

    # audit-serviceは、ログとCloudTrailを読む。図の下を回して、ほかの線と交差させない
    turn1, turn2 = waypoint(8.4, BOTTOM), waypoint(23.6, BOTTOM)
    audit >> aws_call(dir="none") >> turn1
    turn1 >> aws_call("ログとCloudTrailを読む", dir="none") >> turn2
    turn2 >> aws_call(dir="none") >> audit_in
    audit_in >> aws_call() >> logs
