"""多段伝播の方式比較シナリオ。

前提: `cdk deploy --all -c stsIssuer=... --outputs-file outputs.json` 済み。boto3 が必要。
実行: python scripts/run.py  （結果は out-results.json に保存）
"""
import json
import secrets
import sys
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

REGION = "ap-northeast-1"
USERS = {"alice": "sales", "bob": "hr"}

outputs = json.load(open("outputs.json"))
base = outputs["Gekko08ExpMultiHop"]
jwt_stack = outputs.get("Gekko08ExpMultiHopJwt", {})
idp = boto3.client("cognito-idp", region_name=REGION)
sts = boto3.client("sts", region_name=REGION)
PASSWORD = "Aa1!" + secrets.token_urlsafe(16)


def setup_users():
    for name, dept in USERS.items():
        try:
            idp.admin_create_user(
                UserPoolId=base["PoolId"], Username=name, MessageAction="SUPPRESS",
                UserAttributes=[{"Name": "custom:department", "Value": dept}],
            )
        except idp.exceptions.UsernameExistsException:
            pass
        idp.admin_set_user_password(UserPoolId=base["PoolId"], Username=name, Password=PASSWORD, Permanent=True)


def frontend_session(user):
    tok = idp.initiate_auth(
        ClientId=base["ClientId"], AuthFlow="USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": user, "PASSWORD": PASSWORD},
    )["AuthenticationResult"]["IdToken"]
    r = sts.assume_role_with_web_identity(
        RoleArn=base["FrontendRoleArn"], RoleSessionName=f"frontend-{user}", WebIdentityToken=tok,
    )
    c = r["Credentials"]
    return {k: c[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}


def call(url, creds, body, headers=None):
    data = json.dumps(body)
    h = {"content-type": "application/json", **(headers or {})}
    req = AWSRequest(method="POST", url=url, data=data, headers=h)
    SigV4Auth(Credentials(creds["AccessKeyId"], creds["SecretAccessKey"], creds["SessionToken"]), "lambda", REGION).add_auth(req)
    r = urllib.request.Request(url, data=data.encode(), headers=dict(req.headers), method="POST")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return {"status": resp.status, "body": json.loads(resp.read().decode())}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read().decode()}


def context_token(creds, aud):
    s = boto3.client(
        "sts", region_name=REGION, aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"], aws_session_token=creds["SessionToken"],
    )
    return s.get_web_identity_token(Audience=[aud], SigningAlgorithm="ES384", DurationSeconds=300)["WebIdentityToken"]


def main():
    setup_users()
    s = {u: frontend_session(u) for u in USERS}
    results = {}

    # (a) 一時クレデンシャルを下流へ渡す
    results["a1_alice"] = call(base["AaUrl"], s["alice"], {"creds": s["alice"]})
    results["a2_bob"] = call(base["AaUrl"], s["bob"], {"creds": s["bob"]})
    results["a3_alice_forge"] = call(base["AaUrl"], s["alice"], {"creds": s["alice"], "forge": True})

    # (b) 受信側が SourceIdentity と tags を付け直す（claim は受信側が決める値の代わり）
    results["b1_alice_honest"] = call(base["AbUrl"], s["alice"], {"claim": {"source_identity": "alice", "department": "sales"}})
    results["b2_bob_honest"] = call(base["AbUrl"], s["bob"], {"claim": {"source_identity": "bob", "department": "hr"}})
    results["b3_bob_forged"] = call(base["AbUrl"], s["bob"], {"claim": {"source_identity": "bob", "department": "sales"}})

    # (c) GetWebIdentityToken の JWT を伝達媒体にする
    if "AcUrl" in jwt_stack:
        for i, u in enumerate(USERS, 1):
            tok = context_token(s[u], "gekko08-hop-a-c")
            results[f"c{i}_{u}"] = call(jwt_stack["AcUrl"], s[u], {}, {"x-context-token": tok})

    json.dump(results, open("out-results.json", "w"), indent=2, ensure_ascii=False, default=str)
    json.dump(results, sys.stdout, indent=2, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
