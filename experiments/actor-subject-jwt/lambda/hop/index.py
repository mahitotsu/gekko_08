import base64
import json
import os
import time
import urllib.error
import urllib.request

import boto3
import jwt
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

REGION = os.environ["AWS_REGION"]
ISSUER = os.environ["ISSUER"]
MODE = os.environ["MODE"]
HOP = os.environ["HOP"]
AUD = os.environ.get("AUD")
EXPECTED_SUB = os.environ.get("EXPECTED_SUB")
CHAIN_ROLE = os.environ.get("CHAIN_ROLE")
NEXT_URL = os.environ.get("NEXT_URL")
NEXT_AUD = os.environ.get("NEXT_AUD")
SKIP_ROLE = os.environ.get("SKIP_ROLE")
SKIP_URL = os.environ.get("SKIP_URL")
SKIP_AUD = os.environ.get("SKIP_AUD")

_jwks = None


def _jwks_client():
    global _jwks
    if _jwks is None:
        with urllib.request.urlopen(f"{ISSUER}/.well-known/openid-configuration", timeout=5) as r:
            _jwks = jwt.PyJWKClient(json.loads(r.read())["jwks_uri"])
    return _jwks


def _verify(token):
    # subject（誰の代理か）と aud（自分宛てか）を、STS の署名で確かめる
    key = _jwks_client().get_signing_key_from_jwt(token)
    c = jwt.decode(token, key.key, algorithms=["ES384", "RS256"], audience=AUD, issuer=ISSUER,
                   options={"require": ["exp", "iat", "sub", "aud"]})
    if c["sub"] != EXPECTED_SUB:
        raise ValueError(f"unexpected sub {c['sub']}")
    ns = c.get("https://sts.amazonaws.com/", {})
    if not ns.get("source_identity"):
        raise ValueError("no source_identity")
    return {"subject": ns["source_identity"], "tags": ns.get("principal_tags"), "token_sub": c["sub"]}


def _plain(c):
    return {k: c[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}


def _sts(c):
    return boto3.client(
        "sts", region_name=REGION,
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"],
    )


def _mint(c, audience):
    return _sts(c).get_web_identity_token(Audience=[audience], SigningAlgorithm="ES384", DurationSeconds=300)["WebIdentityToken"]


def _exec_creds():
    f = boto3.Session().get_credentials().get_frozen_credentials()
    return {"AccessKeyId": f.access_key, "SecretAccessKey": f.secret_key, "SessionToken": f.token}


def _call(url, c, body, headers):
    data = json.dumps(body)
    h = {"content-type": "application/json", **headers}
    req = AWSRequest(method="POST", url=url, data=data, headers=h)
    SigV4Auth(Credentials(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"]), "lambda", REGION).add_auth(req)
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


def _err(e):
    return f"{type(e).__name__}: {e}"


def _resp(status, out):
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(out, default=str)}


def handler(event, context):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    body = json.loads(raw)
    headers = event.get("headers") or {}
    out = {"hop": HOP, "door_caller": ((event.get("requestContext", {}).get("authorizer") or {}).get("iam") or {}).get("userArn")}
    t = {}

    if MODE == "impostor":
        # B と同じ実行role を持つ別関数が、正規の C 宛て JWT を作って C を呼ぶ
        tok = _mint(body["creds"], NEXT_AUD)
        out["next"] = _call(NEXT_URL, _exec_creds(), {}, {"x-authz-context": tok})
        return _resp(200, out)

    token = headers.get("x-authz-context")
    if not token:
        out["rejected"] = "no x-authz-context"
        return _resp(401, out)
    s0 = time.time()
    try:
        out["verified"] = _verify(token)
    except Exception as e:
        out["rejected"] = _err(e)
        return _resp(401, out)
    t["verify_ms"] = int((time.time() - s0) * 1000)

    if MODE == "terminal":
        # アプリによる ABAC: 検証済みの属性だけを使う（ヘッダー等の自己申告は読まない）
        dept = (out["verified"]["tags"] or {}).get("department")
        out["abac"] = "allow" if dept == "sales" else f"deny (department={dept})"
        out["timing"] = t
        return _resp(200 if dept == "sales" else 403, out)

    s0 = time.time()
    s = _sts(body["creds"]).assume_role(RoleArn=CHAIN_ROLE, RoleSessionName=f"hop-{HOP}", DurationSeconds=900)["Credentials"]
    t["chain_ms"] = int((time.time() - s0) * 1000)
    if body.get("leak"):
        out["leaked"] = _plain(s)
    if body.get("skip") and SKIP_ROLE:
        try:
            k = _sts(s).assume_role(RoleArn=SKIP_ROLE, RoleSessionName=f"skip-{HOP}", DurationSeconds=900)["Credentials"]
            out["skip"] = _call(SKIP_URL, _exec_creds(), {}, {"x-authz-context": _mint(k, SKIP_AUD)})
        except Exception as e:
            out["skip"] = _err(e)
    if body.get("external_aud"):
        try:
            _mint(s, "https://external.example")
            out["external_aud"] = "minted"
        except Exception as e:
            out["external_aud"] = _err(e)

    s0 = time.time()
    tok = _mint(s, NEXT_AUD)
    t["mint_ms"] = int((time.time() - s0) * 1000)
    if body.get("tamper"):
        tok = tok[:-4] + ("AAAA" if not tok.endswith("AAAA") else "BBBB")
    if body.get("forward_incoming"):
        tok = token  # 受け取った自分宛ての JWT をそのまま次へ転送する（トークンの丸ごと転送）
    hdr = {} if body.get("no_token") else {"x-authz-context": tok}
    hdr["x-auth-sub"] = "bob"  # 自己申告ヘッダー。受信側は読まない
    out["timing"] = t
    nxt = {k: body[k] for k in ("leak",) if k in body}
    out["next"] = _call(NEXT_URL, _exec_creds(), {"creds": _plain(s), **nxt}, hdr)
    return _resp(200, out)
