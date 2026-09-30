import base64
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.credentials import Credentials

REGION = os.environ["AWS_REGION"]
MODE = os.environ["MODE"]
HOP = os.environ["HOP"]
OUT_ROLE = os.environ.get("OUT_ROLE")
NEXT_URL = os.environ.get("NEXT_URL")
SKIP_ROLE = os.environ.get("SKIP_ROLE")
SKIP_URL = os.environ.get("SKIP_URL")
# IPv4 の外向き経路がないため、IPv4 に接続しようとした場合に長く待たないようにする
CFG = Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 1})


def _claims(jwt):
    p = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


def _plain(c):
    return {k: c[k] for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")}


def _sts(c):
    return boto3.client(
        "sts", region_name=REGION, config=CFG,
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"],
    )


def _err(e):
    return f"{type(e).__name__}: {e}"


def _inspect(c):
    tok = _sts(c).get_web_identity_token(
        Audience=["gekko08-inspect"], SigningAlgorithm="ES384", DurationSeconds=300,
    )["WebIdentityToken"]
    ns = _claims(tok).get("https://sts.amazonaws.com/", {})
    return {"source_identity": ns.get("source_identity"), "principal_tags": ns.get("principal_tags")}


def _call(url, c, body):
    data = json.dumps(body)
    req = AWSRequest(method="POST", url=url, data=data, headers={"content-type": "application/json"})
    SigV4Auth(Credentials(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"]), "lambda", REGION).add_auth(req)
    r = urllib.request.Request(url, data=data.encode(), headers=dict(req.headers), method="POST")
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            status, text = resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    except Exception as e:
        return {"status": None, "error": _err(e)}
    try:
        return {"status": status, "body": json.loads(text)}
    except ValueError:
        return {"status": status, "body": text}


def _probe():
    # 各ホストの名前解決結果と、IPv6 / IPv4 それぞれで 443 に TCP 接続できるか
    hosts = [f"sts.{REGION}.api.aws", f"sts.{REGION}.amazonaws.com"]
    if NEXT_URL:
        hosts.append(urllib.parse.urlparse(NEXT_URL).hostname)
    out = {}
    for h in hosts:
        r = {}
        for fam, name in ((socket.AF_INET6, "v6"), (socket.AF_INET, "v4")):
            try:
                addr = socket.getaddrinfo(h, 443, fam, socket.SOCK_STREAM)[0][4]
            except Exception as e:
                r[name] = f"no address: {e}"
                continue
            t = time.time()
            try:
                with socket.create_connection((addr[0], 443), timeout=3):
                    r[name] = f"connected {addr[0]} in {int((time.time() - t) * 1000)}ms"
            except Exception as e:
                r[name] = f"failed {addr[0]}: {_err(e)}"
        out[h] = r
    return out


def handler(event, context):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    body = json.loads(raw)
    rc = event.get("requestContext", {})
    out = {
        "hop": HOP,
        "caller": (rc.get("authorizer", {}).get("iam") or {}).get("userArn"),
        "source_ip": rc.get("http", {}).get("sourceIp"),
    }
    if MODE == "terminal":
        return _resp(out)
    if body.get("probe"):
        out["probe"] = _probe()
    try:
        s = _sts(body["creds"]).assume_role(RoleArn=OUT_ROLE, RoleSessionName=f"hop-{HOP}", DurationSeconds=900)["Credentials"]
    except Exception as e:
        out["assume_out_role"] = _err(e)
        return _resp(out)
    out["inspect"] = _inspect(s)
    if body.get("skip") and SKIP_ROLE:
        # 自分のサブネットに縛られていない次々段の role になり、次のホップを飛ばせるか
        try:
            k = _sts(s).assume_role(RoleArn=SKIP_ROLE, RoleSessionName=f"skip-{HOP}", DurationSeconds=900)["Credentials"]
            out["skip"] = {"assume": "succeeded", "call": _call(SKIP_URL, k, {})}
        except Exception as e:
            out["skip"] = {"assume": _err(e)}
    if body.get("leak"):
        # 認証情報の持ち出しを模擬する（テスト用スクリプトが VPC の外から使ってみる）
        out["leaked"] = _plain(s)
    if NEXT_URL:
        out["next"] = _call(NEXT_URL, s, {"creds": _plain(s), "leak": body.get("leak"), "probe": body.get("probe")})
    return _resp(out)


def _resp(out):
    return {"statusCode": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(out, default=str)}
