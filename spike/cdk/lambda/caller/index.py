import base64
import json
import urllib.error
import urllib.request

import boto3
import botocore
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def _decode(jwt):
    def part(p):
        return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    h, p, _ = jwt.split(".")
    return {"header": part(h), "claims": part(p)}


def handler(event, context):
    action = event.get("action", "token")
    info = {"boto3": boto3.__version__, "botocore": botocore.__version__}

    if action == "token":
        sts = boto3.client("sts")
        kwargs = {
            "Audience": [event.get("audience", "https://spike.example")],
            "SigningAlgorithm": "ES384",
            "DurationSeconds": 300,
        }
        if event.get("tags"):
            kwargs["Tags"] = event["tags"]
        try:
            resp = sts.get_web_identity_token(**kwargs)
        except Exception as e:
            return {**info, "error": f"{type(e).__name__}: {e}"}
        return {**info, "decoded": _decode(resp["WebIdentityToken"])}

    if action == "call":
        creds = boto3.Session().get_credentials().get_frozen_credentials()
        region = event.get("region", "ap-northeast-1")
        req = AWSRequest(method="GET", url=event["url"])
        SigV4Auth(creds, "lambda", region).add_auth(req)
        r = urllib.request.Request(event["url"], headers=dict(req.headers), method="GET")
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return {**info, "status": resp.status, "body": resp.read().decode()}
        except urllib.error.HTTPError as e:
            return {**info, "status": e.code, "body": e.read().decode()}
    return {**info, "error": "unknown action"}
