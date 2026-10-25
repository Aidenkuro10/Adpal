---
description: Explain a PayPal API error code or message and provide actionable solutions
argument-hint: <error_code or error_message>
allowed-tools: Read, Grep
---

If "$ARGUMENTS" is empty, respond only with: "Please provide a PayPal error code or message. Example: `/paypal:explain-error INSTRUMENT_DECLINED`" and stop.

If "$ARGUMENTS" does not match any known PayPal error code or message pattern, respond with: "Unknown error code or message: `$ARGUMENTS`. This may be a typo, a third-party error, or a new PayPal error not yet in this reference. Check https://developer.paypal.com/api/rest/reference/orders/v2/errors/ for the full list." Then do your best to explain what the error string suggests based on its name, and stop — do not fabricate retry behavior or related errors.

Otherwise, explain the PayPal error "$ARGUMENTS". Provide:

1. **What it means** — plain-language explanation
2. **Common causes** — most likely reasons this occurs
3. **How to fix it** — specific, actionable steps
4. **Code example** — detect the user's programming language by scanning any open files with Read/Grep; default to Node.js if no language is found. Show proper error handling including how to catch the error, display a user-friendly message, and whether to retry.
5. **Related errors** — only list errors from the Key error reference below that are meaningfully related (same HTTP status, same flow, or must be handled together). Do not suggest errors outside this list.

Key error reference:

- `INVALID_REQUEST` (400) — malformed body or missing fields; inspect the `details[]` array for the specific `field` and `issue`
- `UNAUTHORIZED` (401) — expired or missing access token; refresh via `POST /v1/oauth2/token`
- `NOT_AUTHORIZED` (401) — valid token but missing scope for this operation
- `PERMISSION_DENIED` (403) — account not eligible for this API; check Developer Dashboard feature eligibility
- `RESOURCE_NOT_FOUND` (404) — resource ID does not exist or belongs to a different account
- `DUPLICATE_TRANSACTION` (409) — idempotency key already succeeded; retrieve the existing resource instead
- `INSTRUMENT_DECLINED` (422) — buyer's payment method declined; ask for a different payment method, do not retry the same instrument
- `TRANSACTION_REFUSED` (422) — risk engine decline; do not retry automatically
- `ORDER_ALREADY_COMPLETED` (422) — cannot capture/authorize an already-completed order
- `AMOUNT_MISMATCH` (422) — captured amount doesn't match authorized amount
- `RATE_LIMIT_REACHED` (429) — back off with exponential retry; honor the `Retry-After` header
- `INTERNAL_SERVER_ERROR` (500) — retry with the same `PayPal-Request-Id` idempotency key; log `debug_id`
- `PLAN_STATUS_INVALID` — plan must be `ACTIVE` before creating subscriptions
- `SUBSCRIPTION_STATUS_INVALID` — subscription is not in a state that allows this operation

Always include the full error response body and `debug_id` when contacting PayPal support at https://developer.paypal.com/support/.
