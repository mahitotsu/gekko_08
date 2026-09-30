def handler(event, context):
    # Pre Token Generation V2: ID token に AWS STS が読む2つの名前空間クレームを注入する
    attrs = event["request"]["userAttributes"]
    claims = {
        "https://aws.amazon.com/source_identity": event["userName"],
        "https://aws.amazon.com/tags": {
            "principal_tags": {"department": [attrs.get("custom:department", "none")]},
            "transitive_tag_keys": ["department"],
        },
    }
    event["response"] = {
        "claimsAndScopeOverrideDetails": {
            "idTokenGeneration": {"claimsToAddOrOverride": claims}
        }
    }
    return event
