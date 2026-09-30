"""Token Exchange 相当の構成（actor＝実行role、subject＝STS発行のJWT）の検証シナリオ。

前提: scripts/build.sh の後に `cdk deploy -c stsIssuer=... --outputs-file outputs.json` 済み。boto3 が必要。
このスクリプトの端末は、漏れたセッションを外で使う攻撃者の役も兼ねる。
実行: python scripts/run.py  （結果は out-results.json に保存）
"""
import json
import sys
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

REGION = "ap-northeast-1"
o = json.load(open("outputs.json"))["Gekko08ExpActorSubject"]
sts = boto3.client("sts", region_name=REGION)


def frontend(user, dept):
    c = sts.assume_role(
        RoleArn=o["FrontendRoleArn"], RoleSessionName=f"frontend-{user}", SourceIdentity=user,
        Tags=[{"Key": "department", "Value": dept}], TransitiveTagKeys=["department"],
    )["Credentials"]
    return {k: c[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}


def sts_of(c):
    return boto3.client(
        "sts", region_name=REGION, aws_access_key_id=c["AccessKeyId"],
        aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"],
    )


def mint(c, aud):
    return sts_of(c).get_web_identity_token(Audience=[aud], SigningAlgorithm="ES384", DurationSeconds=300)["WebIdentityToken"]


def call(url, c, body, headers=None):
    data = json.dumps(body)
    h = {"content-type": "application/json", **(headers or {})}
    req = AWSRequest(method="POST", url=url, data=data, headers=h)
    SigV4Auth(Credentials(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"]), "lambda", REGION).add_auth(req)
    r = urllib.request.Request(url, data=data.encode(), headers=dict(req.headers), method="POST")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return {"status": resp.status, "body": json.loads(resp.read().decode())}
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return {"status": e.code, "body": json.loads(text)}
        except ValueError:
            return {"status": e.code, "body": text}


def attempt(f):
    try:
        return {"result": "succeeded", "value": f()}
    except Exception as e:
        return {"result": f"denied: {type(e).__name__}: {e}"}


def enter(c, body):
    # 入口 A を、Frontend のセッションと A 宛ての JWT で呼ぶ
    return call(o["AUrl"], c, {"creds": c, **body}, {"x-authz-context": mint(c, "gekko08-hop-A")})


def main():
    alice, bob = frontend("alice", "sales"), frontend("bob", "hr")
    admin = boto3.Session().get_credentials().get_frozen_credentials()
    admin = {"AccessKeyId": admin.access_key, "SecretAccessKey": admin.secret_key, "SessionToken": admin.token}
    r = {}

    # 正常系
    r["t1_alice"] = enter(alice, {})
    r["t2_bob"] = enter(bob, {})
    # 受信側のアプリによる JWT 検証
    r["t3_forward_incoming_token"] = enter(alice, {"forward_incoming": True})  # A 宛ての JWT を B に転送する
    r["t4_tampered"] = enter(alice, {"tamper": True})
    r["t5_no_token"] = enter(alice, {"no_token": True})
    # 侵害された A によるホップ飛ばし（BChain になって C 宛て JWT を作り、A の実行role で C を呼ぶ）
    r["t6_skip_from_A"] = enter(alice, {"skip": True})
    # chain用role で外部向けの aud の JWT を作れるか
    r["t7_external_aud"] = enter(alice, {"external_aud": True})

    # 漏洩: A が作った AChain のセッション（B へ渡すもの）を持ち出す
    leak = enter(alice, {"leak": True})
    s_a = leak["body"]["leaked"]
    r["x1_outside_sA_call_B_with_valid_jwt"] = call(o["BUrl"], s_a, {"creds": s_a}, {"x-authz-context": mint(s_a, "gekko08-hop-B")})
    r["x2_outside_sA_chain_to_BChain"] = attempt(
        lambda: sts_of(s_a).assume_role(RoleArn=o["BChainArn"], RoleSessionName="x2")["AssumedRoleUser"]["Arn"])
    s_b = sts_of(s_a).assume_role(RoleArn=o["BChainArn"], RoleSessionName="x2b")["Credentials"]
    s_b = {k: s_b[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}
    tok_c = mint(s_b, "gekko08-hop-C")
    r["x3_outside_sB_call_C_with_valid_jwt"] = call(o["CUrl"], s_b, {}, {"x-authz-context": tok_c})
    r["x4_outside_admin_call_C_with_valid_jwt"] = call(o["CUrl"], admin, {}, {"x-authz-context": tok_c})
    # B と同じ実行role を持つ別関数 B2 が、正規の C 宛て JWT で C を呼ぶ
    r["x5_impostor_same_exec_role"] = call(o["B2Url"], alice, {"creds": s_b})

    json.dump(r, open("out-results.json", "w"), indent=2, ensure_ascii=False, default=str)
    json.dump(r, sys.stdout, indent=2, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
