---
name: paypal-webhooks
description: PayPal webhooks - signature verification, event types (PAYMENT.CAPTURE.*, BILLING.SUBSCRIPTION.*), event handling, and webhook simulator testing.
---

# Webhooks

**When to Use:** Developer asks about webhook setup, signature verification, event handling, or specific webhook event types.
**When NOT to Use:** Non-webhook payment issues (see checkout.md), MCP connection problems (use `/paypal:setup`).

## Verification

Always verify webhook signatures with `POST /v1/notifications/verify-webhook-signature` before trusting an event — an unverified endpoint will accept a POST from anyone, not just PayPal.

Every delivery carries five headers your handler needs to pass through:

| Header                     | Purpose                        |
| -------------------------- | ------------------------------ |
| `PAYPAL-AUTH-ALGO`         | Signing algorithm used         |
| `PAYPAL-CERT-URL`          | Certificate PayPal signed with |
| `PAYPAL-TRANSMISSION-ID`   | Unique ID for this delivery    |
| `PAYPAL-TRANSMISSION-SIG`  | The signature itself           |
| `PAYPAL-TRANSMISSION-TIME` | When it was sent               |

Send those five headers, your `webhook_id`, and the **raw request body exactly as received** — re-serializing the JSON, even just reformatting whitespace, changes the bytes the signature was computed over and breaks verification. A `{"verification_status": "SUCCESS"}` response means the event is genuine; anything else, reject it and return a 4xx.

Return HTTP 200 immediately from your handler and process events asynchronously, because PayPal retries delivery if it doesn't receive a 200 within 30 seconds — slow processing causes duplicate events. For that reason, handlers must be idempotent: track processed event `id`s and skip any you've already handled, since the same event can arrive more than once. Register explicit event types rather than wildcard subscriptions, since this prevents your handler from receiving irrelevant events and reduces noise.

## Critical Event Types

**Payment events:**

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.REFUNDED`

**Subscription events:**

- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
- `PAYMENT.SALE.COMPLETED` (each renewal)

**Dispute events:**

- `CUSTOMER.DISPUTE.CREATED`
- `CUSTOMER.DISPUTE.RESOLVED`

## Testing

Use the [Webhooks Simulator](https://developer.paypal.com/dashboard/webhooksSimulator) for testing without real transactions. Never use production credentials in test code.

For an interactive, end-to-end sandbox test of the full lifecycle — subscribing a URL, triggering a real event, verifying its signature, and cleanup — see [references/webhook-sandbox.md](webhook-sandbox.md) for the full subscription-CRUD and simulate-event API surface (including why a simulated event can't be used to test real signature verification).

## Live Documentation

- [Verify webhook signature](https://developer.paypal.com/api/webhooks/v1/definitions/verify_webhook_signature)
- [Webhook event format](https://developer.paypal.com/api/webhooks/v1/definitions/webhook)
- [Webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/)
- [Webhooks REST API guide](https://developer.paypal.com/api/rest/webhooks/)
- [Webhooks Simulator](https://developer.paypal.com/dashboard/webhooksSimulator)
