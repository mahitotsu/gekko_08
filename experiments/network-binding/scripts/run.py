"""案A（IPv6 送信元での縛り）の検証シナリオ。

前提: `cdk deploy --outputs-file outputs.json` 済み。boto3 が必要。
このスクリプトを実行する端末は VPC の外（IPv4）にあり、「盗んだ認証情報を外で使う攻撃者」の役も兼ねる。
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
o = json.load(open("outputs.json"))["Gekko08ExpNetBind"]
sts = boto3.client("sts", region_name=REGION)


def frontend(user, dept):
    c = sts.assume_role(
        RoleArn=o["FrontendRoleArn"], RoleSessionName=f"frontend-{user}", SourceIdentity=user,
        Tags=[{"Key": "department", "Value": dept}], TransitiveTagKeys=["department"],
    )["Credentials"]
    return {k: c[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}


def client(c):
    return boto3.client(
        "sts", region_name=REGION, aws_access_key_id=c["AccessKeyId"],
        aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"],
    )


def call(url, c, body):
    data = json.dumps(body)
    req = AWSRequest(method="POST", url=url, data=data, headers={"content-type": "application/json"})
    SigV4Auth(Credentials(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"]), "lambda", REGION).add_auth(req)
    r = urllib.request.Request(url, data=data.encode(), headers=dict(req.headers), method="POST")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return {"status": resp.status, "body": json.loads(resp.read().decode())}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read().decode()}


def attempt(f):
    try:
        return {"result": "succeeded", "value": f()}
    except Exception as e:
        return {"result": f"denied: {type(e).__name__}: {e}"}


def main():
    alice, bob = frontend("alice", "sales"), frontend("bob", "hr")
    r = {}
    r["t1_alice_probe"] = call(o["AUrl"], alice, {"creds": alice, "probe": True})
    r["t2_bob"] = call(o["AUrl"], bob, {"creds": bob})
    r["t3_alice_skip_from_A"] = call(o["AUrl"], alice, {"creds": alice, "skip": True})

    leak = call(o["AUrl"], alice, {"creds": alice, "leak": True})
    r["t4_leak_run"] = leak
    s1 = leak["body"]["leaked"]                  # A が持ち出した AaOut のセッション
    s2 = leak["body"]["next"]["body"]["leaked"]  # B が持ち出した BaOut のセッション

    # VPC の外（この端末）から、漏れた認証情報を使う
    r["x0_outside_frontend_assume_AaOut"] = attempt(
        lambda: client(alice).assume_role(RoleArn=o["AaOutArn"], RoleSessionName="x0")["AssumedRoleUser"]["Arn"])
    r["x1_outside_s1_assume_BaOut"] = attempt(
        lambda: client(s1).assume_role(RoleArn=o["BaOutArn"], RoleSessionName="x1")["AssumedRoleUser"]["Arn"])
    r["x2_outside_s1_call_B"] = call(o["BUrl"], s1, {"creds": s1})
    r["x3_outside_s2_call_C"] = call(o["CUrl"], s2, {})
    # 対照: 送信元で縛っていない権限（inspect 用の GetWebIdentityToken）は外からでも使える
    r["x4_outside_s1_unbound_action"] = attempt(
        lambda: client(s1).get_web_identity_token(Audience=["gekko08-inspect"], SigningAlgorithm="ES384", DurationSeconds=300)["Expiration"])

    json.dump(r, open("out-results.json", "w"), indent=2, ensure_ascii=False, default=str)
    json.dump(r, sys.stdout, indent=2, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
