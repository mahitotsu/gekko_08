import json


def handler(event, context):
    rc = event.get("requestContext", {})
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"receiver": "ok", "iam": rc.get("authorizer", {}).get("iam")}),
    }
