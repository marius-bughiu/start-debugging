---
title: "How to Subscribe to Claude API Organization Webhooks"
description: "Register an HTTPS endpoint with POST /v1/organizations/webhooks and the anthropic-beta: webhooks-2026-10-07 header, store the whsec_ signing secret from the create response, verify deliveries with client.beta.webhooks.unwrap(), answer 2xx within 5 seconds, dedupe on webhook-id and poll to catch up on dropped events. Covers the five event types, which ones are actually delivered today, the 32-endpoint limit, secret rotation and the 404s you get when the beta is not on. Receiver checked against anthropic 2.12.0 and standardwebhooks 1.3.0."
pubDate: 2026-11-22
template: "how-to"
tags:
  - "llm"
  - "anthropic-sdk"
  - "ai-agents"
  - "webhooks"
  - "claude-api"
---

**Short answer:** create an endpoint with `POST https://api.anthropic.com/v1/organizations/webhooks`, sending an Admin API key, `anthropic-version: 2026-10-21` and `anthropic-beta: webhooks-2026-10-07`, a public HTTPS `url` and at least one entry in `enabled_events`. The response carries a `signing_secret` that starts with `whsec_` and that no later read returns, so store it immediately. Your receiver verifies each delivery with the Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`), which the Python SDK (`anthropic` 2.12.0) does for you in `client.beta.webhooks.unwrap()`, returns a 2xx within 5 seconds, and deduplicates on `webhook-id`. As of the `webhooks-2026-10-07` beta, the `external_key.failed` / `external_key.recovered` events are delivered; the two `user_profile.enforcement_action_*` events are registrable but Anthropic does not send them yet.

## What organization webhooks are for

Most Claude API integrations find out that something changed at the organization level the hard way: a Messages call fails. Organization webhooks are Anthropic's push channel for those org-wide state changes, separate from the Managed Agents session webhooks that report on individual agent runs. The [organization webhooks guide](https://platform.claude.com/docs/en/manage-claude/organization-webhooks) lists two families of events today:

| Event type | Fires when | Delivered today? |
| --- | --- | --- |
| `external_key.failed` | A customer-managed encryption key (CMEK) stops working | Yes |
| `external_key.recovered` | That key works again | Yes |
| `user_profile.enforcement_action_opened` | Anthropic opens a restriction or ban on one of your end-customer user profiles | No, registrable only |
| `user_profile.enforcement_action_resolved` | That action is closed | No, registrable only |
| `user_profile.program_status_updated` | Listed in the `enabled_events` enum | Payload not documented |

The docs are explicit about the enforcement pair: you can register endpoints for them and build your handler from the published event format, but Anthropic does not send them yet. If you subscribe to them today and see nothing, that is expected, not a bug in your receiver. `user_profile.program_status_updated` appears in the API reference enum and in the SDK's type literal, but no page describes its trigger or payload, so treat it as reserved.

The practical value right now is the CMEK pair. If your organization runs on customer-managed keys and someone disables the key in KMS, every Messages request in every workspace tied to that key starts failing. `external_key.failed` tells you within about 30 minutes (at roughly one request per minute per workspace, per the docs) instead of when the on-call pager goes off.

## Preconditions that produce a 404

Before writing code, check the three things that make the API pretend it does not exist:

1. **The beta header.** Every call needs `anthropic-beta: webhooks-2026-10-07`. Without it the API returns 404, exactly as if the route were absent.
2. **The feature flag on your org.** Anthropic turns organization webhooks on per organization. CMEK organizations have it; others go through their account team. Until then, 404.
3. **HIPAA-readiness orgs** are excluded entirely. 404 again.

Credentials are an Admin API key, an OAuth token with the `org:admin` scope, or a personal or service-account key that is not scoped to a workspace. A key bound to a non-Default workspace cannot call these endpoints. For non-admin keys, list and get need the `developer` or `admin` org role; create, update, delete and secret rotation need `admin`.

## Registering the endpoint

Your URL must be HTTPS on port 443 and use a public domain name, not an IP address. Here is the create call with curl:

```bash
# Claude API, anthropic-version 2026-10-21, beta webhooks-2026-10-07
curl "https://api.anthropic.com/v1/organizations/webhooks" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2026-10-21" \
  -H "anthropic-beta: webhooks-2026-10-07" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://hooks.example.com/anthropic-webhooks",
    "name": "CMEK key health",
    "enabled_events": ["external_key.failed", "external_key.recovered"]
  }'
```

The same call from the Python SDK. The resource lives under `client.beta.organization.webhooks` and the SDK adds the beta header for you:

```python
# anthropic 2.12.0 (Python 3.12)
import os
import anthropic

admin = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_ADMIN_KEY"])

endpoint = admin.beta.organization.webhooks.create(
    url="https://hooks.example.com/anthropic-webhooks",
    name="CMEK key health",
    enabled_events=["external_key.failed", "external_key.recovered"],
)

print(endpoint.id)              # wep_...
print(endpoint.state)           # "enabled"
save_to_secret_store(endpoint.signing_secret)  # whsec_..., returned only here
```

Older SDKs do not have this resource. `anthropic` 0.125.0, the newest release that still installs on Python 3.9, has no `client.beta.organization` attribute at all, so `AttributeError: 'Beta' object has no attribute 'organization'` means you need a newer SDK and a newer Python. If you prefer the CLI, the docs show `ant beta:organization:webhooks create --url ... --name ... --enabled-event external_key.failed --enabled-event external_key.recovered`, which pairs well with keeping the rest of your Claude config [as code with `ant apply`](/2026/11/how-to-manage-claude-managed-agents-skills-and-memory-stores-as-code-with-ant-apply/).

The create response looks like this (the `signing_secret` field is present only on create and on secret rotation):

```json
{
  "id": "wep_011CZkZDf8HnUq2mTxRbVn4s",
  "url": "https://hooks.example.com/anthropic-webhooks",
  "name": "CMEK key health",
  "description": "",
  "enabled_events": ["external_key.failed", "external_key.recovered"],
  "state": "enabled",
  "disabled_reason": "",
  "signing_secret": "whsec_...",
  "created_at": "2026-11-22T10:00:00Z",
  "updated_at": "2026-11-22T10:00:00Z"
}
```

Limits worth knowing up front: an organization can have at most 32 endpoints, and disabled endpoints count toward that. Two enabled endpoints cannot share a URL (409). `enabled_events` must contain at least one type on create, and an unsupported type gets a 400 whose message lists the accepted ones.

## Writing the receiver

Deliveries follow the [Standard Webhooks](https://www.standardwebhooks.com/) specification. Each POST carries three headers:

- `webhook-id`: the event ID (`whe_...`), identical to the `id` field in the body.
- `webhook-timestamp`: Unix seconds.
- `webhook-signature`: one or more space-separated `v1,<base64>` values.

The signature is an HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed with the base64 bytes after the `whsec_` prefix. You do not need to hand-roll it. The Python SDK's `client.beta.webhooks.unwrap(payload, headers=...)` imports the `standardwebhooks` package (install it with `pip install "anthropic[webhooks]"`), verifies the signature with the client's `webhook_key`, and parses the body into a typed event. The `standardwebhooks` 1.3.0 verifier also rejects timestamps more than 5 minutes from the current time, which is your replay protection.

```python
# anthropic 2.12.0, standardwebhooks 1.3.0, fastapi 0.165.0, Python 3.12
# anthropic-beta: webhooks-2026-10-07
import os
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from anthropic import Anthropic
from standardwebhooks.webhooks import WebhookVerificationError

client = Anthropic(webhook_key=os.environ["ANTHROPIC_WEBHOOK_SECRET"])  # whsec_...
app = FastAPI()
seen: set[str] = set()  # use a DB unique index or Redis SETNX in production


def handle(event_type: str, object_id: str) -> None:
    ...  # slow work goes here: validate the key, page someone, open a ticket


@app.post("/anthropic-webhooks")
async def receive(request: Request, tasks: BackgroundTasks) -> Response:
    body = (await request.body()).decode("utf-8")  # raw bytes, never re-serialized JSON
    try:
        event = client.beta.webhooks.unwrap(body, headers=dict(request.headers))
    except WebhookVerificationError:
        raise HTTPException(status_code=400, detail="bad signature")

    if event.id in seen:  # retries reuse the same id
        return Response(status_code=204)
    seen.add(event.id)

    tasks.add_task(handle, event.data.type, event.data.id)
    return Response(status_code=204)  # any 2xx within 5 seconds
```

Three details in that handler matter more than they look:

**Verify the raw body.** The HMAC covers the exact bytes Anthropic sent. If your framework parses JSON and you re-serialize it, key order or whitespace can change and every signature fails. Read the body as bytes first, verify, then parse.

**Answer fast.** Anthropic counts anything other than a 2xx within 5 seconds as a failed attempt. Do the validation calls and paging after you respond, in a background task or a queue.

**Deduplicate on `webhook-id`.** Retries carry the same ID. The docs also warn that events can arrive late or out of order, so the handler should treat the event as a hint to re-read current state, not as the state itself.

The receiver above was checked locally with FastAPI's `TestClient` against an event signed by `standardwebhooks.Webhook.sign()` using a freshly generated `whsec_` secret and the docs' `external_key.failed` sample payload: the valid delivery returned 204 and was handled once, the same delivery replayed returned 204 without being handled again, a body with one word changed returned 400, and a valid signature with a timestamp 10 minutes old returned 400. `parse_unverified()` mapped the payload to `BetaWebhookExternalKeyFailedEventData`. That is a local test of the verification and dedup path only; it did not receive a live delivery from Anthropic.

## What the event body contains

Events carry IDs, not state. A CMEK failure looks like this:

```json
{
  "type": "event",
  "id": "whe_8c1d5e2a9f4b7036d1e8a5c2f9b40d73",
  "created_at": "2026-11-20T09:14:07.482913Z",
  "data": {
    "type": "external_key.failed",
    "id": "ekey_011CZkZFr7KpXc4nMgSvQh3w",
    "organization_id": "org_011CZkZBj9RsYd3wNcHvKq6t"
  }
}
```

`created_at` is the time of the first send attempt and can include fractional seconds. The event does not name a workspace. To act on it, take `data.id` and call `POST /v1/organizations/external_keys/{external_key_id}/validate`. A `status` of `failure` comes with an error message that may tell you whether to retry; `success` means the key works again. Then list workspaces with `include_default=true`, find the ones whose `external_key_id` matches, and send a small Messages request in each. Expect `cmek_key_disabled` or `cmek_key_network_blocked` when KMS refuses, `cmek_key_unreachable` when Anthropic cannot reach KMS at all. Requests can keep succeeding for up to an hour after the key stops working, so a passing probe right after a `failed` event is not proof of recovery.

The enforcement events, once delivered, follow the same ID-only shape: `data.id` is the user profile (`uprof_...`) and `data.enforcement_action_id` is the action (`enac_...`). Call `GET /v1/user_profiles/{id}` to read `enforcement_status` (`unrestricted`, `restricted` or `banned`) and the `enforcement_actions` array. Deleting a profile ends its open actions without a `resolved` event.

## Plan for dropped events

This is the part most webhook tutorials skip, and the docs are blunt about it. Anthropic retries a failed delivery "a few times over the next few minutes", with no published retry count or backoff, then drops the event. It also disables your endpoint automatically if it returns a 3xx redirect, if its URL resolves to a non-public IP, or if deliveries keep failing. Events for a disabled endpoint are skipped, not queued. Anthropic does not notify you about either.

So the webhook is a latency optimization on top of a poll, not a replacement for one. Run a catch-up job on a schedule (the docs suggest once a day), after any outage on your side, after adding new event types and after re-enabling an endpoint:

```python
# anthropic 2.12.0
def catch_up(admin: anthropic.Anthropic) -> None:
    for ep in admin.beta.organization.webhooks.list(limit=100):  # auto-paginates
        if ep.state != "enabled":
            alert(f"{ep.id} disabled: {ep.disabled_reason or 'manually'}")
            # after fixing the cause:
            # admin.beta.organization.webhooks.update(ep.id, state="enabled")

    # then re-derive the state the events would have told you about:
    # list external keys and call .../validate on each; list user profiles
    # with enforcement_status[]=restricted and enforcement_status[]=banned
```

`disabled_reason` is an empty string when the endpoint is enabled or when you disabled it yourself; it is populated only when Anthropic disabled it. Setting `state` back to `enabled` clears it.

The list endpoint takes `after_id`, `before_id`, `limit` (default 20, max 100) and `order` (`desc` by default, newest first), and returns `data`, `has_more`, `first_id` and `last_id`. The SDK's iterator follows `last_id` for you. It only returns organization-level endpoints, not workspace-owned ones.

## Updating, rotating and deleting

Updates use `POST /v1/organizations/webhooks/{webhook_endpoint_id}` (POST, not PATCH) and change only the fields you send. One trap: `enabled_events` on update **replaces** the whole set, but an empty list leaves it unchanged rather than clearing it. To stop deliveries, set `state` to `disabled` or delete the endpoint.

```python
# anthropic 2.12.0
admin.beta.organization.webhooks.update(
    "wep_011CZkZDf8HnUq2mTxRbVn4s",
    enabled_events=[  # full list, not a delta
        "external_key.failed",
        "external_key.recovered",
        "user_profile.enforcement_action_opened",
        "user_profile.enforcement_action_resolved",
    ],
)

new = admin.beta.organization.webhooks.regenerate_signing_secret("wep_011CZkZDf8HnUq2mTxRbVn4s")
save_to_secret_store(new.signing_secret)

admin.beta.organization.webhooks.delete("wep_011CZkZDf8HnUq2mTxRbVn4s")
# -> {"id": "wep_...", "type": "webhook_endpoint_deleted"}
```

Rotation has no overlap window. The old secret stops working the moment `regenerate_signing_secret` returns, and every delivery after that, including retries of events first sent before the rotation, is signed with the new one. If your receiver still holds the old secret, those deliveries fail verification, burn their retries and get dropped. Two ways to make that safe: have the receiver accept a list of secrets during the cutover (the SDK's `unwrap()` takes an explicit `key=` argument, so try the new one and fall back to the old), or briefly disable the endpoint, rotate, deploy, re-enable and run the catch-up job.

## Error codes you will actually see

| Status | Cause |
| --- | --- |
| 400 | Bad `url`, no event types, an unsupported event type, more than 32 endpoints, or the org has no Default workspace |
| 403 | Your role lacks permission; or `sandbox_egress_restricted` when the call comes from a network-restricted Claude sandbox |
| 404 | Missing `anthropic-beta` header, feature not on for your org, HIPAA org, unsupported credential, or unknown endpoint ID |
| 409 | Two enabled endpoints would share a URL, or a concurrent change to the org's endpoints (retry) |
| 500 | The endpoint depends on a CMEK key Anthropic currently cannot use |

The `sandbox_egress_restricted` 403 is worth calling out if you are scripting this from inside an agent: a coding agent running in a locked-down sandbox will hit it even with a valid admin key. Run the setup from a normal shell or CI job instead.

## Related reading

If you are wiring Claude into production plumbing, the same SDK now [emits OpenTelemetry spans on its own](/2026/11/how-to-trace-anthropic-sdk-calls-with-built-in-opentelemetry/), which pairs naturally with webhook-driven alerts. For cost signals rather than key health, see [how to find out why a Claude prompt cache missed](/2026/11/how-to-find-out-why-a-claude-prompt-cache-missed-with-diagnostics/). If your receiver lives in .NET rather than Python, the request plumbing in [calling the Claude API from a .NET 11 minimal API](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) is a good starting point, and the "push instead of poll, but keep a poll" pattern also shows up in [waiting for pull request reviews and CI with `gh event listen`](/2026/11/gh-event-listen-wait-for-pull-request-reviews-and-ci-without-polling/).

## Sources

- [Organization webhooks guide, Claude Platform docs](https://platform.claude.com/docs/en/manage-claude/organization-webhooks)
- [Organization webhooks API reference (beta)](https://platform.claude.com/docs/en/api/beta/organization/webhooks)
- [Create organization webhook endpoint](https://platform.claude.com/docs/en/api/beta/organization/webhooks/create)
- [Update organization webhook endpoint](https://platform.claude.com/docs/en/api/beta/organization/webhooks/update)
- [User profiles and enforcement actions](https://platform.claude.com/docs/en/manage-claude/user-profiles)
- [Standard Webhooks specification](https://www.standardwebhooks.com/)
