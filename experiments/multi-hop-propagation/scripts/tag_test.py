"""途中のホップが session tags を上書き・追加できるか。

chain 先 role の trust policy に sts:TagSession がある場合（AaOut）とない場合（StrictOut）を比べる。
実行: python scripts/tag_test.py  （run.py と同じ前提）
"""
import base64
import json

import boto3

import run

CASES = {
    "plain": None,
    "override_transitive_department": [{"Key": "department", "Value": "hr"}],
    "add_new_key_clearance": [{"Key": "clearance", "Value": "top"}],
}


def inspect(c):
    s = boto3.client(
        "sts", region_name=run.REGION, aws_access_key_id=c["AccessKeyId"],
        aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"],
    )
    tok = s.get_web_identity_token(Audience=["gekko08-inspect"], SigningAlgorithm="ES384", DurationSeconds=300)["WebIdentityToken"]
    p = tok.split(".")[1]
    ns = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))["https://sts.amazonaws.com/"]
    return {"source_identity": ns.get("source_identity"), "principal_tags": ns.get("principal_tags")}


def main():
    run.setup_users()
    s = run.frontend_session("alice")
    sts = boto3.client(
        "sts", region_name=run.REGION, aws_access_key_id=s["AccessKeyId"],
        aws_secret_access_key=s["SecretAccessKey"], aws_session_token=s["SessionToken"],
    )
    iam = boto3.client("iam")
    roles = {r["RoleName"]: r["Arn"] for p in iam.get_paginator("list_roles").paginate() for r in p["Roles"]}
    targets = {
        "with_TagSession": next(a for n, a in roles.items() if n.startswith("Gekko08ExpMultiHop-AaOut")),
        "TagSession_limited_by_TagKeys": run.base["StrictOutArn"],
    }
    results = {}
    for tname, arn in targets.items():
        for cname, tags in CASES.items():
            kw = {"Tags": tags} if tags else {}
            try:
                c = sts.assume_role(RoleArn=arn, RoleSessionName="tagtest", **kw)["Credentials"]
                results[f"{tname}/{cname}"] = {"result": "succeeded", **inspect(c)}
            except Exception as e:
                results[f"{tname}/{cname}"] = {"result": f"denied: {e}"}
    json.dump(results, open("out-tags.json", "w"), indent=2, ensure_ascii=False)
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
