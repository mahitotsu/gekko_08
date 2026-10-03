"""全体構成の図を、AWSの公式アイコンで生成する。

生成のしかたは docs/diagrams/README.md にある。構成を変えたら、このファイルを直して生成し直し、
生成した architecture.png も一緒にコミットする。文字の正本は設計書§2の表である。

線を直線にして交差を減らすため、Graphvizのneatoで、各ノードを座標（インチ）で固定して置く。
neatoは入れ子の枠を描かないので、まとまり（ホップ、bffが使うもの、追跡と監査）は最上位の枠にし、
AWSのアカウントの境界は、背景に置いた塗りのない四角で表す。neatoは枠の余白（margin）も無視するので、
枠の隅の外側に見えない点を置いて、アイコンと枠の間の余白を取る。
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
TOP, AGENT, MAIN, LOW, BOTTOM = 9.8, 5.6, 2.4, -0.8, -3.6
# 枠とアイコン（ラベルを含む）の間の余白と、枠の見出しの高さ
MARGIN, TITLE = 0.45, 0.35

placed: list[tuple[float, float, float, float]] = []  # 置いたノードの範囲（左、下、右、上）


def at(x: float, y: float) -> dict:
    return {"pos": f"{x},{y}!", "pin": "true"}


def place(cls, label: str, x: float, y: float) -> Node:
    """アイコンを座標に置き、ラベルを含む範囲を記録する。"""
    lines = label.split("\n")
    # 13ポイントの文字の幅の目安：全角0.19インチ、半角0.1インチ
    text = max(sum(0.19 if ord(c) > 0x2000 else 0.1 for c in line) for line in lines)
    w = max(1.4, text)
    h = Node._height + 0.4 * (len(lines) - 1)
    placed.append((x - w / 2, y - h / 2, x + w / 2, y + h / 2))
    return cls(label, **at(x, y))


def waypoint(x: float, y: float) -> Node:
    """線を折り曲げるための見えない点。"""
    return Node("", shape="point", width="0.01", style="invis", **at(x, y))


def bounds(items: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    return (min(i[0] for i in items), min(i[1] for i in items), max(i[2] for i in items), max(i[3] for i in items))


def pad(start: int) -> tuple[float, float, float, float]:
    """この枠に入れたノード（placedのstart以降）の外側に、余白の分だけ見えない点を置く。枠の範囲を返す。"""
    left, bottom, right, top = bounds(placed[start:])
    left, bottom, right, top = left - MARGIN, bottom - MARGIN, right + MARGIN, top + MARGIN + TITLE
    waypoint(left, bottom), waypoint(right, top)
    placed.append((left, bottom, right, top))
    return left, bottom, right, top


def above(label: str) -> str:
    """水平に近い線のラベルを、線に重ならないよう少し上にずらす（下に空行を足す）。"""
    return label + "\n "


def aws_call(label: str = "", **kw) -> Edge:
    return Edge(label=label, color=GRAY, style="dashed", penwidth="2.2", fontcolor="#3d4651", **kw)


with Diagram("", filename=str(OUT), outformat="png", show=False,
             graph_attr=graph_attr, node_attr=node_attr, edge_attr=edge_attr):
    browser = User("ブラウザ", **at(-1.0, MAIN))
    inner = len(placed)
    cdn = place(CloudFront, "CloudFront", 2.4, MAIN)
    static = place(SimpleStorageServiceS3, "S3\n静的な画面", 2.4, LOW)
    bedrock = place(Bedrock, "Bedrock\nClaude Haiku 4.5", 11.4, TOP)
    sts = place(IAMAWSSts, "STS", 20.4, 6.0)
    ddb = place(Dynamodb, "DynamoDB\n案件、口座、人事データ", 20.0, LOW)

    with Cluster("bffが使うもの"):
        start = len(placed)
        cognito = place(Cognito, "Cognito\nUser Pool", 3.0, TOP)
        ssm = place(SystemsManagerParameterStore, "Parameter Store\nbffの設定", 5.4, TOP)
        sessions = place(Dynamodb, "DynamoDB\nセッション", 7.8, TOP)
        pad(start)

    with Cluster("ホップ（Lambda。Function URLはAWS_IAM認証）"):
        start = len(placed)
        bff = place(Lambda, "bff", 5.4, MAIN)
        agent = place(Lambda, "fraud-agent", 8.4, AGENT)
        mcp = place(Lambda, "fraud-mcp", 12.0, AGENT)
        case = place(Lambda, "case-service", 12.0, MAIN)
        account = place(Lambda, "account-service", 15.6, MAIN)
        audit = place(Lambda, "audit-service", 8.4, LOW)
        ent = place(Lambda, "entitlement-service\n属性サービス", 14.4, LOW)
        _, _, hops_right, _ = pad(start)
        hops_edge = waypoint(hops_right, MAIN)  # 各ホップに共通する線の出どころ（枠の右端）

    with Cluster("追跡と監査"):
        start = len(placed)
        trail = place(Cloudtrail, "CloudTrail\nSTSの呼び出し", 24.0, 6.0)
        xray = place(XRay, "X-Ray\nスパンの受け口", 24.0, 3.0)
        logs = place(Cloudwatch, "CloudWatch\nログ、スパン", 24.0, 0.0)
        _, obs_bottom, _, _ = pad(start)
        audit_in = waypoint(24.0, obs_bottom)  # audit-serviceの読む線の入り口（枠の下端）

    left, bottom, right, top = bounds(placed[inner:])
    left, bottom, right, top = left - MARGIN, min(bottom, BOTTOM) - MARGIN - 0.4, right + MARGIN, top + MARGIN + TITLE
    # AWSのアカウントの境界。塗りのない四角なので、最後に置いて上に重ねても、下のアイコンは隠れない
    # 見出しが枠の線に重ならないよう、前に空行を入れて1行下げる
    Node("\nAWS（ap-northeast-1、単一のアカウント）", shape="box", style="rounded,dashed", color="#8c4fff", penwidth="2",
         fontcolor="#8c4fff", fontsize="15", labelloc="t", fixedsize="true", width=str(right - left), height=str(top - bottom),
         **at((left + right) / 2, (top + bottom) / 2))

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
    hops_edge >> aws_call(above("各ホップ：スパン")) >> xray
    hops_edge >> aws_call("各ホップ：ログ") >> logs
    xray >> aws_call() >> logs
    sts >> Edge(color=GRAY, style="dotted", penwidth="2.2", label=above("記録")) >> trail

    # audit-serviceは、ログとCloudTrailを読む。図の下を回して、ほかの線と交差させない
    turn1, turn2 = waypoint(8.4, BOTTOM), waypoint(24.0, BOTTOM)
    # 途中の区間は向きを持たない「-」でつなぎ、矢じりは最後の区間だけに付ける
    audit - aws_call() - turn1
    turn1 - aws_call(above("ログとCloudTrailを読む")) - turn2
    turn2 - aws_call() - audit_in
    audit_in >> aws_call() >> logs
