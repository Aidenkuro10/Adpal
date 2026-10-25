---
name: paypal-webhook-sandbox
description: Hands-on sandbox testing of the full PayPal webhook lifecycle — subscription CRUD (including a local name-to-ID upsert convenience), simulate-event, trigger a real transaction, signature verification, delivered-event history/resend, continuous watch/polling, the public-URL requirement, and the simulate-vs-real signature-verification fidelity gap.
---

# Webhook Lifecycle Testing

**When to Use:** The developer wants to exercise the webhook API surface in sandbox right now — subscribe a URL, trigger an event, verify its signature, inspect history, watch for new deliveries, or delete a subscription. This reference is self-contained — there is no separate command; walk the developer through whichever stage they ask for directly from here.
**When NOT to Use:** Writing production webhook handler code (signature-verification pattern, event types, async-200 handling) — see `references/webhooks.md`. Missing a sandbox token entirely — use `/paypal:setup`.

**No MCP dependency:** every operation here — subscribe, trigger, verify, history, watch, list, update, cleanup — is a direct `curl` call against the REST API using the sandbox token and does not require PayPal's MCP server to be connected. Webhook subscription management has no MCP tool at all: not for create, list, get, update, or delete. If `mcp__paypal-sandbox__*` or `mcp__paypal-prod__*` is disconnected, rate-limited, or returns an error, proceed with the `curl` calls below exactly as documented — REST is the only path for these operations, not a fallback. The one optional MCP convenience anywhere in this file is creating the order used to trigger a real event. Every call hits `api-m.sandbox.paypal.com` directly.

## Contents

- [Prerequisites](#prerequisites) · [Mint a Sandbox Token](#mint-a-sandbox-token)
- [Subscription CRUD](#subscription-crud) · [Optional local upsert: `--name` and `--update-if-exists`](#optional-local-upsert---name-and---update-if-exists)
- [Triggering an Event: Real Transaction vs. `simulate-event`](#triggering-an-event-real-transaction-vs-simulate-event) · [Path A](#path-a--real-sandbox-transaction-default-recommended) · [Path B](#path-b--simulate-event-fast-sanity-check-only) · [The Fidelity Gap](#the-fidelity-gap)
- [Receive and Verify the Signature](#receive-and-verify-the-signature)
- [Delivered-Event History](#delivered-event-history)
- [Watching for New Events Continuously](#watching-for-new-events-continuously) · [Start watching](#start-watching) · [Check progress](#check-progress) · [Stop watching](#stop-watching)
- [Common Pitfalls](#common-pitfalls)
- [Troubleshooting](#troubleshooting)
- [Live Documentation](#live-documentation)

## Prerequisites

Two checks worth confirming before using this reference:

1. **Sandbox token available?** Confirm `PAYPAL_SANDBOX_ACCESS_TOKEN` is set — in `~/.claude/settings.json` (Claude Code) or the process environment (Codex and other agents); either counts. If neither has it, stop and say: "Run `/paypal:setup` first to configure your sandbox token."
2. **Public HTTPS URL ready?** Needed only to create a new subscription or change an existing one's URL — not for listing, inspecting, deleting, checking history, watching, or verifying a signature. PayPal cannot deliver webhooks to `localhost` — the subscribed URL must be reachable on the public internet over HTTPS. Ask the developer for a URL they already have (a staging server, a devbox with a public hostname, or whatever their own team's tooling/network policy provides). Don't recommend a specific tunnel tool — that choice depends entirely on what's available and approved on the developer's own network.

### Mint a Sandbox Token

```bash
curl -s -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "${PAYPAL_SANDBOX_CLIENT_ID:-$PAYPAL_CLIENT_ID}:${PAYPAL_SANDBOX_CLIENT_SECRET:-$PAYPAL_CLIENT_SECRET}" \
  -d "grant_type=client_credentials" \
  | jq -r .access_token
```

Falls back to the plain `$PAYPAL_CLIENT_ID`/`$PAYPAL_CLIENT_SECRET` if the sandbox-specific ones aren't set, same as `scripts/generate-token.sh`.

Same pattern as `/paypal:setup`'s credential setup and `/paypal:test-accounts`' Quick Access Token snippet. Store the result as `$ACCESS_TOKEN` for everything below; sandbox tokens last 9 hours, re-mint on any `401`.

## Subscription CRUD

Every action in this table is a plain REST call with no MCP equivalent. A failure here is always a REST-level issue — an expired token, a malformed ID, a bad URL — never an MCP connection problem. Use `curl` with `$ACCESS_TOKEN` directly, re-minting the token on a `401` per above.

| Action               | Endpoint                                         |
| -------------------- | ------------------------------------------------ |
| Create               | `POST /v1/notifications/webhooks`                |
| List                 | `GET /v1/notifications/webhooks`                 |
| Get one              | `GET /v1/notifications/webhooks/{webhook_id}`    |
| Update               | `PATCH /v1/notifications/webhooks/{webhook_id}`  |
| Delete               | `DELETE /v1/notifications/webhooks/{webhook_id}` |
| Discover event types | `GET /v1/notifications/webhooks-event-types`     |

`create` requires `url` (HTTPS) and `event_types` (array of `{"name": "EVENT.TYPE"}`). Up to 10 webhook URLs per app. Recommend `PAYMENT.CAPTURE.COMPLETED` for a first run — it fires on every successful sandbox capture (see Triggering an Event, below).

```bash
curl -s -X POST https://api-m.sandbox.paypal.com/v1/notifications/webhooks \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "'"$PUBLIC_URL"'/webhooks/paypal",
    "event_types": [{"name": "PAYMENT.CAPTURE.COMPLETED"}]
  }'
```

This is the same registration shape already shown in `/paypal:test-accounts`. Capture the returned `id` as `$WEBHOOK_ID` — everything below needs it. **Reused, not re-registered:** if the developer already has a subscription for this URL from `/paypal:test-accounts`, skip creating a new one and ask for the existing `$WEBHOOK_ID` instead.

```bash
# List every webhook registered for this app (no ID needed) — useful for spotting
# stale ones left over from earlier sessions, or duplicates for the same URL.
curl -s -X GET https://api-m.sandbox.paypal.com/v1/notifications/webhooks \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Get one subscription's current state
curl -s -X GET "https://api-m.sandbox.paypal.com/v1/notifications/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Update the URL (e.g. if the endpoint's address changed)
curl -s -X PATCH "https://api-m.sandbox.paypal.com/v1/notifications/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"op": "replace", "path": "/url", "value": "'"$NEW_PUBLIC_URL"'/webhooks/paypal"}]'

# Delete
curl -s -w "\n%{http_code}" -X DELETE "https://api-m.sandbox.paypal.com/v1/notifications/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

`delete` is idempotent for sandbox subscriptions: a `204` means it was deleted just now, a `404` with `"name": "INVALID_RESOURCE_ID"` means it was already gone in sandbox — treat both as success (a `400` on the same call is a genuine malformed-ID error, not the idempotent case). A sandbox `404` on an ID described as production is not evidence that subscription was deleted — confirm environment first rather than reporting success. When deleting, also remind the developer to tear down whatever they used to expose their endpoint if it was set up just for this testing session, and to stop any background watch job (see below) still pointed at this subscription.

### Optional local upsert: `--name` and `--update-if-exists`

PayPal's own API resolves everything by its `id` only — there's no name field and no upsert on the wire; each `POST` above always creates a brand-new subscription. This is a **local-only** convenience layered on top: a name-to-ID mapping stored at `~/.claude/paypal-webhook-subscriptions.json` on the developer's machine (separate from the sandbox credentials, wherever those live for this agent), so a developer can say "register/update my webhook named X" across sessions instead of re-pasting an ID by hand. Trigger this whenever the developer gives a subscription a name in conversation (e.g. "register a webhook called checkout-dev") or asks to update one by name — it doesn't require any special flag syntax, just resolve the intent.

**Security note:** every value below (`$SUB_NAME`, `$PUBLIC_URL`, `$WEBHOOK_ID`) is passed into `jq` via `--arg`, never spliced into a `jq`/Python/shell _program string_. `--arg` binds the value as inert data, so a name containing quotes, backticks, or `$()` can't break out and run as code — never rewrite this with a Python `-c "...'$SUB_NAME'..."` or similar string-interpolation form, that reintroduces the injection this avoids.

```bash
MAP_FILE="$HOME/.claude/paypal-webhook-subscriptions.json"
mkdir -p -m 700 "$HOME/.claude" || { echo "Could not create $HOME/.claude — check permissions." >&2; exit 1; }
[ -f "$MAP_FILE" ] || (umask 077; echo '{}' > "$MAP_FILE")

# Look up an existing entry for the given name (safe: value passed via --arg)
EXISTING_ID=$(jq -r --arg n "$SUB_NAME" '.[$n].webhook_id // empty' "$MAP_FILE")
```

1. **No entry for that name** (`$EXISTING_ID` empty) — create normally (the `POST` above), then record it:
   ```bash
   TMP="$(mktemp)"
   jq --arg n "$SUB_NAME" --arg id "$WEBHOOK_ID" --arg url "${PUBLIC_URL}/webhooks/paypal" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.[$n] = {webhook_id: $id, url: $url, event_types: ["PAYMENT.CAPTURE.COMPLETED"], updated_at: $ts}' \
      "$MAP_FILE" > "$TMP" && mv "$TMP" "$MAP_FILE"
   ```
2. **An entry exists** — confirm it's still real before trusting it: `GET /v1/notifications/webhooks/$EXISTING_ID`. A `404`/`INVALID_RESOURCE_ID` means it was deleted out from under the mapping (via `delete`, or directly in the dashboard); drop the stale entry (`jq --arg n "$SUB_NAME" 'del(.[$n])'` into the same file) and fall through to step 1's create-and-record path, same as if the name had never been seen.
3. **Confirmed still live:**
   - **Developer wants it updated ("update my webhook named X", "--update-if-exists"):** `PATCH` it —
     ```bash
     PATCH_RESP=$(curl -s -w "\n%{http_code}" -X PATCH "https://api-m.sandbox.paypal.com/v1/notifications/webhooks/$EXISTING_ID" \
       -H "Authorization: Bearer $ACCESS_TOKEN" \
       -H "Content-Type: application/json" \
       -d '[{"op": "replace", "path": "/url", "value": "'"${PUBLIC_URL}/webhooks/paypal"'"}]')
     PATCH_CODE=$(echo "$PATCH_RESP" | tail -1)
     PATCH_BODY=$(echo "$PATCH_RESP" | sed '$d')
     [ "${PATCH_CODE:0:1}" = "2" ] || { echo "PATCH failed (HTTP $PATCH_CODE): $PATCH_BODY — not updating the local map or reporting success." >&2; exit 1; }
     WEBHOOK_ID="$EXISTING_ID"
     TMP="$(mktemp)"
     jq --arg n "$SUB_NAME" --arg id "$WEBHOOK_ID" --arg url "${PUBLIC_URL}/webhooks/paypal" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.[$n] = {webhook_id: $id, url: $url, event_types: ["PAYMENT.CAPTURE.COMPLETED"], updated_at: $ts}' \
        "$MAP_FILE" > "$TMP" && mv "$TMP" "$MAP_FILE"
     ```
     Only record the update and report success once `PATCH_CODE` confirms a 2xx — report this as "updated existing subscription `<name>` (`$EXISTING_ID`)," not a new creation. On failure, surface the actual `http_code` and body rather than silently updating local state.
   - **Developer just asked to register/create, with no explicit update intent:** do **not** create a duplicate or silently update anything. Tell them a subscription named `<name>` already exists (`$EXISTING_ID`, registered to `<url>`), and that they can ask to update it, or give a different name to register a separate one.

This mapping is a local convenience only — never sent to PayPal, no bearing on the real subscription's `id`, and contains no secrets (just IDs, URLs, and timestamps). If the file is deleted or edited by hand, the next name lookup simply finds nothing and falls back to a normal create. No name given at all means behavior is unchanged: every call creates a new subscription, resolved only by the real `id`.

## Triggering an Event: Real Transaction vs. `simulate-event`

Default to driving a **real sandbox transaction** (e.g. create + capture a sandbox order) rather than `simulate-event`, because only a real transaction produces a genuinely signed, verifiable event — a simulated one can never pass real signature verification (see the Fidelity Gap below).

### Path A — Real Sandbox Transaction (default, recommended)

If `mcp__paypal-sandbox__create_order` and `mcp__paypal-sandbox__pay_order` are connected in this session, prefer them — call `create_order` for a small sandbox amount, then `pay_order` to approve and capture it. Otherwise, use the REST API directly — a direct-card order completes immediately, no browser or buyer login needed:

```bash
curl -s -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: webhook-lifecycle-$(date +%s)" \
  -d '{
    "intent": "CAPTURE",
    "purchase_units": [{"amount": {"currency_code": "USD", "value": "10.00"}}],
    "payment_source": {
      "card": {
        "number": "4111111111111111",
        "expiry": "2027-12",
        "name": "Test Buyer",
        "security_code": "123"
      }
    }
  }'
```

A `COMPLETED` response means the capture already happened — no separate capture call needed. (A standard checkout order without `payment_source.card` returns an `approve` link instead, requiring the developer to log in as a sandbox buyer at `sandbox.paypal.com` and approve before a separate `POST .../capture` call — use this path only if they specifically want to exercise the full buyer-approval flow.)

A successful capture fires a real, genuinely signed `PAYMENT.CAPTURE.COMPLETED` delivery to the subscribed URL — delivery isn't instant, expect anywhere from ~10 seconds up to 75+ seconds (occasionally longer) depending on sandbox load.

### Path B — `simulate-event` (fast sanity check only)

`POST /v1/notifications/simulate-event` is a real, documented endpoint (not just a Dashboard UI feature) — it takes `event_type` plus either `webhook_id` or `url`, and returns a 202 with a sample event. Use it as a quick sanity check: does the listener respond, is the URL reachable, what does the payload look like. For anything beyond that — especially confirming signature verification — use Path A instead.

```bash
curl -s -X POST https://api-m.sandbox.paypal.com/v1/notifications/simulate-event \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_id": "'"$WEBHOOK_ID"'",
    "event_type": "PAYMENT.CAPTURE.COMPLETED"
  }'
```

If the developer uses Path B, skip signature verification below and tell them to come back after a Path A run if they want to confirm real signature verification.

### The Fidelity Gap

> A simulated event from `POST /v1/notifications/simulate-event` or the Dashboard Webhooks Simulator uses a fixed literal `webhook_id` of `"WEBHOOK_ID"`. It **cannot** be verified through the standard `POST /v1/notifications/verify-webhook-signature` call — that call will fail or be meaningless because the webhook_id won't match a real subscription. Simulated events test listener plumbing and payload shape only. Never present a simulated event as proof that signature verification works. Use a real transaction, or resend a real delivered event via `POST /v1/notifications/webhooks-events/{id}/resend`, for an actually verifiable test.

## Receive and Verify the Signature

Confirm the registered endpoint logged the inbound request. It needs five PayPal headers plus the raw body:

- `PAYPAL-AUTH-ALGO`
- `PAYPAL-CERT-URL`
- `PAYPAL-TRANSMISSION-ID`
- `PAYPAL-TRANSMISSION-SIG`
- `PAYPAL-TRANSMISSION-TIME`

Then call the verification endpoint with those headers plus `$WEBHOOK_ID` and the exact raw event body:

```bash
curl -s -X POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "auth_algo": "'"$AUTH_ALGO"'",
    "cert_url": "'"$CERT_URL"'",
    "transmission_id": "'"$TRANSMISSION_ID"'",
    "transmission_sig": "'"$TRANSMISSION_SIG"'",
    "transmission_time": "'"$TRANSMISSION_TIME"'",
    "webhook_id": "'"$WEBHOOK_ID"'",
    "webhook_event": '"$RAW_EVENT_BODY"'
  }'
```

A real event returns `{"verification_status": "SUCCESS"}`. **Only run this against a Path A (real) event** — a Path B payload will not verify, per the Fidelity Gap above. Before verifying, confirm with the developer that the headers and body came from one single captured delivery, not stitched together from two. Don't judge this by comparing the headers' `transmission-time` to the body's `create_time` — a legitimate `resend` carries a fresh `transmission-time` while `create_time` stays at the event's original creation, so those are expected to differ even for a correct, matching pair. If the developer can't confirm a single source, run the call anyway and let `verify-webhook-signature`'s own result be the judge — a genuinely mismatched pair fails there, not on a timestamp guess.

## Delivered-Event History

```
GET /v1/notifications/webhooks-events            # list
GET /v1/notifications/webhooks-events/{event_id}  # one event
POST /v1/notifications/webhooks-events/{event_id}/resend
```

`resend` replays the _original_ real signed event — the cheapest way to re-test signature verification without firing a new transaction each time. Simulated events never appear in this history.

The list call accepts `start_time`/`end_time` query params (RFC 3339 UTC) to filter by a time window. Accept a duration from the developer (`30m`, `24h`, `7d` — integer + `s`/`m`/`h`/`d` only, including relative phrasing like "last hour") and validate it **before** making any network call:

```bash
# Parse a duration like "30m"/"24h"/"7d" into an absolute UTC timestamp, N units back from now.
# Usage: to_timestamp <amount><unit>
to_timestamp() {
  local dur="$1"
  [[ "$dur" =~ ^[0-9]+[smhd]$ ]] || { echo "Invalid duration: $dur (expected e.g. 30m, 24h, 7d)" >&2; return 1; }
  local n="${dur%[smhd]}" unit="${dur: -1}"
  [[ "$n" =~ ^0+$ ]] && { echo "Invalid duration: $dur (must be greater than zero)" >&2; return 1; }
  n=$((10#$n))  # force base-10: bash treats a leading-zero numeral like "010" as octal otherwise
  case "$unit" in
    s) secs=$n ;;
    m) secs=$((n * 60)) ;;
    h) secs=$((n * 3600)) ;;
    d) secs=$((n * 86400)) ;;
  esac
  date -u -v-"${secs}"S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "-${secs} seconds" +%Y-%m-%dT%H:%M:%SZ
}

# Build query params only for the filters the developer actually gave.
QUERY="page_size=20"
if [ -n "$SINCE_DUR" ]; then
  SINCE_TS=$(to_timestamp "$SINCE_DUR") || exit 1
  QUERY="$QUERY&start_time=$SINCE_TS"
fi
if [ -n "$UNTIL_DUR" ]; then
  UNTIL_TS=$(to_timestamp "$UNTIL_DUR") || exit 1
  QUERY="$QUERY&end_time=$UNTIL_TS"
fi

curl -s -X GET "https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?${QUERY}" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

A window with more than `page_size` events doesn't all come back in one response — PayPal returns the rest via a `links` entry with `"rel": "next"`. Follow it until there isn't one, or the window's results silently truncate at the first page:

```bash
URL="https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?${QUERY}"
while [ -n "$URL" ]; do
  RESP=$(curl -s -w "\n%{http_code}" -X GET "$URL" -H "Authorization: Bearer $ACCESS_TOKEN")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  if [ "${CODE:0:1}" != "2" ]; then
    echo "History request failed (HTTP $CODE) — stopping rather than treating this as an empty page: $BODY" >&2
    exit 1
  fi
  echo "$BODY" | jq -c '.events[]?'
  URL=$(echo "$BODY" | jq -r '[.links[]? | select(.rel == "next") | .href][0] // empty')
done
```

Reject a bare number, a decimal, `ms`, zero, or a negative value with a usage error before any network call. A "since" duration means "that far back from now"; an "until" duration means "up to that far back from now" (defaults to now if omitted). This is a **one-shot** lookup — re-run it to refresh; there's no continuous mode here, use Watching (below) for that. An empty result is a normal, successful outcome — not an error; say so plainly rather than treating a `{"events": []}` response as a failure. This step only builds a time-window filter (`start_time`/`end_time`) from what the developer asks for — PayPal's API also accepts `event_type` and `transaction_id` as query params, but this workflow doesn't expose either as a filter option here, so there's nothing else to ask the developer for in this step.

An event only shows up here if an active subscription with a URL that actually received the delivery existed at the time. No subscription, or a subscription pointing at an unreachable URL, means the event never appears in this history at all. Don't assume this endpoint is a general firehose of everything that happened on the app; it only reflects successful deliveries.

## Watching for New Events Continuously

`GET /v1/notifications/webhooks-events` (above) can be polled repeatedly to watch for new deliveries as they arrive, instead of checking once. **This is observe-only** — it never forwards events anywhere and never invents a signature. It only surfaces the same genuinely-signed real deliveries the history call already shows (simulated events still never appear here at all, per the Fidelity Gap above). To actually prove signature verification works, use a real transaction and the verification call above — watching only tells you _that_ and _when_ something arrived.

**App-wide, not per-subscription:** this endpoint has no `webhook_id`/subscription filter (`page_size`, `start_time`, `end_time`, `transaction_id`, `event_type` are the only query params it accepts), so a watch surfaces every delivered event for the whole app, not just the one subscription named in `$WEBHOOK_ID`. `$WEBHOOK_ID` only names the local tracking files below — if the developer has more than one active subscription, say so plainly rather than implying the results are scoped to just one.

### Start watching

Start a background polling loop with the Bash tool (`run_in_background: true`) so the conversation turn isn't blocked — the developer can go trigger a transaction or do anything else while it runs. `$WEBHOOK_ID` isn't always agent-generated — it can come verbatim from what a developer pastes in chat, or from the local name-to-ID map — so **`$SEEN_FILE` is exported and read in Python via `os.environ`, never spliced into the `python3 -c` program string**, for the same reason as the `--name` upsert above: splicing would let a value containing a quote or parenthesis break out of the string and run as code. This loop's `curl` calls carry an explicit timeout, unlike the one-shot calls elsewhere in this file — a hang here would block the loop from ever reaching its own 60-minute ceiling check, where a hung one-shot call just blocks a single turn the developer can see and interrupt.

```bash
[[ "$WEBHOOK_ID" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid webhook ID: $WEBHOOK_ID (letters, digits, - and _ only)" >&2; exit 1; }
WATCH_DIR="/tmp/paypal-webhook-watch-$WEBHOOK_ID"
if [ -e "$WATCH_DIR" ] || [ -L "$WATCH_DIR" ]; then
  OWNER_UID=$(stat -f %u "$WATCH_DIR" 2>/dev/null || stat -c %u "$WATCH_DIR" 2>/dev/null)
  PERM=$(stat -f %Lp "$WATCH_DIR" 2>/dev/null || stat -c %a "$WATCH_DIR" 2>/dev/null)
  if [ -L "$WATCH_DIR" ] || [ "$OWNER_UID" != "$(id -u)" ] || [ "$PERM" != "700" ]; then
    echo "Refusing to use $WATCH_DIR — it already exists and isn't a private directory I own (possible pre-planted path on a shared host)." >&2
    exit 1
  fi
else
  mkdir -m 700 "$WATCH_DIR" || exit 1
fi
WATCH_FILE="$WATCH_DIR/events.ndjson"
SEEN_FILE="$WATCH_DIR/seen.txt"
export SEEN_FILE
: > "$WATCH_FILE"; : > "$SEEN_FILE"
END_TIME=$(( $(date +%s) + 3600 ))   # 60-minute safety ceiling
BACKOFF=15
while [ "$(date +%s)" -lt "$END_TIME" ]; do
  SINCE=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
  URL="https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?page_size=20&start_time=${SINCE}"
  while [ -n "$URL" ]; do
    RESP=$(curl -s --connect-timeout 5 --max-time 15 -w "\n%{http_code}" -X GET \
      "$URL" -H "Authorization: Bearer $ACCESS_TOKEN")
    CODE=$(echo "$RESP" | tail -1)
    BODY=$(echo "$RESP" | sed '$d')
    if [ "$CODE" = "429" ]; then
      echo "{\"type\":\"error\",\"http_code\":\"429\"}" >> "$WATCH_FILE"
      sleep "$BACKOFF"; BACKOFF=$(( BACKOFF < 60 ? BACKOFF * 2 : 60 ))
      continue 2
    fi
    if [ -z "$BODY" ] || [ "${CODE:0:1}" != "2" ]; then
      # Connection failure, timeout, auth error, or any other non-2xx — never attempt to parse,
      # and leave a visible marker so a progress check can tell this apart from normal silence.
      echo "{\"type\":\"error\",\"http_code\":\"${CODE:-000}\"}" >> "$WATCH_FILE"
      sleep 20
      continue 2
    fi
    BACKOFF=15
    echo "$BODY" | python3 -c "
import json, os, sys
seen_file = os.environ['SEEN_FILE']
seen = set(open(seen_file).read().split())
for e in json.load(sys.stdin).get('events', []):
    if e['id'] not in seen:
        print(json.dumps(e))
        with open(seen_file, 'a') as f: f.write(e['id'] + '\n')
" >> "$WATCH_FILE"
    # Follow pagination so a burst of more than page_size events in one window isn't truncated.
    URL=$(echo "$BODY" | jq -r '[.links[]? | select(.rel == "next") | .href][0] // empty')
  done
  sleep 20
done
echo "WATCH_ENDED_AT_CEILING" >> "$WATCH_FILE"
```

- **Dedup** by event `id`, tracked in `$SEEN_FILE`, so overlapping poll windows never report the same delivery twice.
- **5-minute overlap window on every poll**, not just the newest page: sandbox deliveries have been directly observed to take anywhere from ~10 seconds up to 75+ seconds — occasionally longer — to appear, and any single poll response can transiently omit an event that's already visible on the next one. Polling only the newest results would miss events.
- **Rate-limit floor**: this endpoint shares a request budget across all callers — the 20-second poll interval here is intentionally conservative, with exponential backoff (capped at 60s) on `429`.
- **Self-enforced ceiling**: stops automatically after 60 minutes so a forgotten background job doesn't poll indefinitely.
- **Failed polls are never parsed and never silent**: a connection failure, an expired token, or any other non-2xx response writes a visible `{"type":"error","http_code":"..."}` marker to `$WATCH_FILE` instead of being fed to the JSON parser — this is what lets status checks tell "the connection is broken" apart from "sandbox just hasn't delivered yet."
- Both `$WATCH_FILE` and `$SEEN_FILE` live inside `$WATCH_DIR`, a per-watch directory under `/tmp` created with mode `700` — not world-readable, unlike a loose file in shared `/tmp` — named using `$WEBHOOK_ID` so starting, checking, or stopping "the watch for subscription X" resolves to the right _directory_ deterministically even with more than one watch running. Ephemeral: not committed anywhere, gone after reboot. That naming is local bookkeeping only, though: per the app-wide note above, two concurrent watches for two different subscriptions on the same app will record the same events in both.
- **No forwarding, no invented signature scheme.** There is no durable secret storage behind this plugin to back a dev-mode re-signing scheme, and inventing one would directly contradict the Fidelity Gap above — never build a second, different pseudo-signature shortcut here. If a developer asks for forwarding, say it's explicitly out of scope and point them back to real-transaction verification.

### Check progress

```bash
[[ "$WEBHOOK_ID" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid webhook ID: $WEBHOOK_ID (letters, digits, - and _ only)" >&2; exit 1; }
WATCH_DIR="/tmp/paypal-webhook-watch-$WEBHOOK_ID"
OWNER_UID=$(stat -f %u "$WATCH_DIR" 2>/dev/null || stat -c %u "$WATCH_DIR" 2>/dev/null)
PERM=$(stat -f %Lp "$WATCH_DIR" 2>/dev/null || stat -c %a "$WATCH_DIR" 2>/dev/null)
if [ -L "$WATCH_DIR" ] || [ "$OWNER_UID" != "$(id -u)" ] || [ "$PERM" != "700" ]; then
  echo "Refusing to read $WATCH_DIR — it isn't a private directory I own (possible pre-planted path, or no watch has started yet)." >&2
  exit 1
fi
echo "Events seen so far:"
grep -c '"event_type"' "$WATCH_DIR/events.ndjson" 2>/dev/null
echo "Poll errors:"
grep -c '"type":"error"' "$WATCH_DIR/events.ndjson" 2>/dev/null
tail -5 "$WATCH_DIR/events.ndjson" 2>/dev/null
```

If the error count is climbing, surface the most recent `http_code` rather than letting it look like ordinary latency — a `401` means the token expired, a `429` means the shared rate-limit budget was hit (the loop backs off and recovers on its own, not a sign of an outage), anything else likely means the network path to `api-m.sandbox.paypal.com` is down. **Re-minting `$ACCESS_TOKEN` in the current conversation does not fix an already-running watch** — that background process captured its own copy of the token when it started and has no way to pick up a new one. After a 401, explicitly stop the watch (below), re-mint the token, then start a new watch. Also report whether the background job is still running (check via the Bash tool's background-task status for the job you started).

### Stop watching

Kill the background job, then print the final count from `$WATCH_FILE`. Background jobs don't self-terminate except at the 60-minute ceiling — always explicitly stop one when the developer is done, and note that stopping the watch does **not** delete the underlying subscription. For a single one-off check instead of continuous watching, use Delivered-Event History above rather than starting a background job.

This is an ephemeral, session-local aid, not a persistent background service.

## Common Pitfalls

- Registering a `localhost` or `http://` URL — rejected; must be public HTTPS.
- Running `verify-webhook-signature` against a `simulate-event` payload — the fixed `WEBHOOK_ID` won't match, so it fails or is meaningless. See the Fidelity Gap above.
- An ephemeral or free/dynamic-address endpoint can change between sessions — a stale registered `url` silently stops deliveries. `GET` the subscription to check, `PATCH` to fix.
- Delivery isn't instant — expect anywhere from ~10 seconds up to 75+ seconds (occasionally longer) after the triggering transaction before the event is delivered and appears in history.

## Troubleshooting

| Error                                                                                        | Likely Cause                                                                                                                                          | Fix                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscription create/update rejects the URL                                                   | `localhost` or a non-HTTPS URL was used                                                                                                               | PayPal requires a public HTTPS URL. The developer needs some endpoint reachable from the internet — don't prescribe how to get one.                                                                                                                         |
| `verify-webhook-signature` fails or returns a mismatch                                       | A simulated-event payload was used instead of a real event, or headers/body were mismatched                                                           | Simulated events use a fixed literal `webhook_id` and can't be verified this way — re-trigger a real transaction, or resend a real delivered event. If both headers and body look real, confirm they're from the _same_ delivery before retrying.           |
| No delivery arrives after capture                                                            | The registered URL stopped resolving or changed (common if the endpoint is ephemeral)                                                                 | `GET` the subscription to check the registered `url`, then `PATCH` it to the current address.                                                                                                                                                               |
| 401 on any call                                                                              | Token expired (9-hour sandbox lifetime)                                                                                                               | Re-mint via the OAuth call above.                                                                                                                                                                                                                           |
| PayPal MCP server (`mcp__paypal-sandbox__*`) is disconnected, rate-limited, or returns a 500 | Unrelated to this reference — only triggering a real event optionally uses it, as a convenience                                                       | Proceed immediately with the direct `curl` calls documented above. Subscription management, history, and watching have no MCP path to begin with, so this is never a blocker for them.                                                                      |
| Watching sees nothing even though a transaction succeeded                                    | Normal sandbox delivery latency (10s–75s+) or a transient poll miss                                                                                   | Wait through at least one more overlap window (~5 min) before concluding it's broken; check watch progress.                                                                                                                                                 |
| 429 while watching                                                                           | The shared request budget on this endpoint was exceeded (e.g. multiple watches running at once)                                                       | The loop backs off automatically; avoid running several watches concurrently, or widen the poll interval.                                                                                                                                                   |
| A watch still shows as running after the developer thought they stopped it                   | A previous watch's background job was never explicitly stopped                                                                                        | Stop it explicitly — background jobs don't self-terminate except at the 60-minute ceiling.                                                                                                                                                                  |
| Watch status shows growing `"type":"error"` entries                                          | A poll inside the watch loop is failing — token expired, network path down, etc. (never a JSON parse crash; failed polls are never fed to the parser) | Check the most recent `http_code` in the error line: `401` means re-mint the token; anything else means check connectivity to `api-m.sandbox.paypal.com`.                                                                                                   |
| `404` with `"name": "INVALID_RESOURCE_ID"` on `DELETE`                                       | The webhook was already deleted (or never existed with that exact ID)                                                                                 | Not a real error — report it as "already clean" **only if the ID is confirmed sandbox**. Only a `400` on this call is a genuine usage error (malformed ID); if the ID was described as production, this `404` proves nothing — confirm environment instead. |

## Live Documentation

- [Webhooks REST API guide](https://developer.paypal.com/api/rest/webhooks/)
- [Verify webhook signature](https://developer.paypal.com/api/webhooks/v1/definitions/verify_webhook_signature)
- [Webhooks Simulator](https://developer.paypal.com/dashboard/webhooksSimulator)
