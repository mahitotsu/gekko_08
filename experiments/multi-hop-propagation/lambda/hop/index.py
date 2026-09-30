import base64
import json
import os
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

REGION = os.environ["AWS_REGION"]
MODE = os.environ["MODE"]
HOP = os.environ["HOP"]
OUT_ROLE = os.environ.get("OUT_ROLE")
NEXT_URL = os.environ.get("NEXT_URL")


def _claims(jwt):
    p = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


def _plain(creds):
    return {k: creds[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}


def _sts(creds=None):
    if creds is None:
        return boto3.client("sts", region_name=REGION)
    return boto3.client(
        "sts", region_name=REGION,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )


def _inspect(creds):
    # セッションに刻まれた source_identity / principal_tags を、GetWebIdentityToken の JWT 経由で観測する
    tok = _sts(creds).get_web_identity_token(
        Audience=["gekko08-inspect"], SigningAlgorithm="ES384", DurationSeconds=300,
    )["WebIdentityToken"]
    c = _claims(tok)
    return {"sub": c.get("sub"), "sts": c.get("https://sts.amazonaws.com/")}


def _call(url, creds, body, headers=None):
    data = json.dumps(body)
    h = {"content-type": "application/json", **(headers or {})}
    req = AWSRequest(method="POST", url=url, data=data, headers=h)
    c = Credentials(creds["AccessKeyId"], creds["SecretAccessKey"], creds["SessionToken"])
    SigV4Auth(c, "lambda", REGION).add_auth(req)
    r = urllib.request.Request(url, data=data.encode(), headers=dict(req.headers), method="POST")
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            status, text = resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    try:
        return {"status": status, "body": json.loads(text)}
    except ValueError:
        return {"status": status, "body": text}


def _forge(up):
    # 上流から受け取ったセッションで、別人の SourceIdentity と tags を名乗って chain できるか
    try:
        _sts(up).assume_role(
            RoleArn=OUT_ROLE, RoleSessionName=f"forge-{HOP}", SourceIdentity="mallory",
            Tags=[{"Key": "department", "Value": "sales"}], TransitiveTagKeys=["department"],
        )
        return "succeeded"
    except Exception as e:
        return f"denied: {type(e).__name__}: {e}"


def _mode_a(body, out):
    up = body["creds"]
    s = _sts(up).assume_role(RoleArn=OUT_ROLE, RoleSessionName=f"hop-{HOP}")["Credentials"]
    out["inspect"] = _inspect(s)
    if body.get("forge"):
        out["forge"] = _forge(up)
    return s, {"creds": _plain(s), "forge": body.get("forge")}


def _mode_b(body, out):
    claim = body["claim"]
    s = _sts().assume_role(
        RoleArn=OUT_ROLE, RoleSessionName=f"hop-{HOP}", SourceIdentity=claim["source_identity"],
        Tags=[{"Key": "department", "Value": claim["department"]}], TransitiveTagKeys=["department"],
    )["Credentials"]
    out["inspect"] = _inspect(s)
    return s, {}


def _mode_c(headers, out):
    jwt = headers["x-context-token"]
    out["received_token"] = {k: v for k, v in _claims(jwt).items() if k in ("sub", "aud", "iss", "https://sts.amazonaws.com/")}
    r = _sts().assume_role_with_web_identity(RoleArn=OUT_ROLE, RoleSessionName=f"hop-{HOP}", WebIdentityToken=jwt)
    out["assume_role_with_web_identity"] = {
        "SourceIdentity": r.get("SourceIdentity"),
        "SubjectFromWebIdentityToken": r.get("SubjectFromWebIdentityToken"),
        "AssumedRoleUser": r["AssumedRoleUser"]["Arn"],
        "PackedPolicySize": r.get("PackedPolicySize"),
    }
    s = r["Credentials"]
    out["inspect"] = _inspect(s)
    return s, {}


def handler(event, context):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    body = json.loads(raw)
    headers = event.get("headers") or {}
    out = {"hop": HOP, "caller": event.get("requestContext", {}).get("authorizer", {}).get("iam")}
    try:
        if MODE == "a":
            s, nxt = _mode_a(body, out)
        elif MODE == "b":
            s, nxt = _mode_b(body, out)
        elif MODE == "c":
            s, nxt = _mode_c(headers, out)
        else:
            s = None
        if s is not None and NEXT_URL:
            out["next"] = _call(NEXT_URL, s, nxt)
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return {"statusCode": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(out, default=str)}
