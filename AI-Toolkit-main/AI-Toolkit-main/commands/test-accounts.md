---
description: Show PayPal sandbox test accounts and scenario-specific testing tips
argument-hint: [scenario — e.g. "decline", "BNPL", "Venmo", "subscriptions", "dispute"]
allowed-tools: Read, mcp__paypal-sandbox__*
---

If "$ARGUMENTS" is set, show only the section(s) relevant to that scenario plus the Key Gotchas. If empty, show all sections.

## Sandbox Buyer & Seller Accounts

Create test accounts at https://developer.paypal.com/dashboard/accounts. Two types:

| Type                           | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| **Personal (Buyer)**           | Approves payments, Venmo, Pay Later, opens disputes        |
| **Business (Seller/Merchant)** | Receives payments, creates orders, invoices, subscriptions |

Sandbox base URL: `https://api-m.sandbox.paypal.com`

## Quick Access Token (Sandbox)

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -d "grant_type=client_credentials"
```

## Test Scenarios

### Successful Payment

Use any sandbox buyer account with sufficient balance. Amount: any normal value.

### Declined Payment

To simulate declines, use sandbox buyer accounts with specific wallet configurations or use these trigger amounts (USD):

| Trigger             | How to simulate                                                          |
| ------------------- | ------------------------------------------------------------------------ |
| Instrument declined | Use a sandbox buyer card set to "Declined" in the sandbox account wallet |
| Insufficient funds  | Set the sandbox buyer balance below the order amount                     |
| Risk decline        | Use amounts configured in your sandbox to trigger TRANSACTION_REFUSED    |

### BNPL / Pay Later

- Use order amounts between **\$30–\$1,500** (Pay in 4) or **\$199–\$10,000** (Pay Monthly)
- The Pay Later option appears in the sandbox buyer approval window
- Sandbox does not simulate installment billing — only the initial capture is tested

### Pay with Venmo

- Venmo sandbox does not invoke the real Venmo app
- During sandbox approval, select "Venmo" in the funding source picker
- Confirm `payment_source.venmo` in the capture response

### Subscriptions

1. Create product → create plan (must be `ACTIVE`) → create subscription
2. Approve using a sandbox buyer account
3. Sandbox auto-processes renewal cycles — accelerate via the Developer Dashboard
4. Use the Webhooks Simulator to test `BILLING.SUBSCRIPTION.PAYMENT.FAILED` and other lifecycle events

### Fastlane

**Sandbox** buyer email addresses must contain the `whitelistallblock` keyword (e.g. `test-fl@whitelistallblock.com`).

Use any of the following cards as test cards for Fastlane in **Sandbox**:

| Brand            | Test Number         |
| ---------------- | ------------------- |
| Visa             | 4005 5192 0000 0004 |
| Visa             | 4012 0000 3333 0026 |
| Visa             | 4012 0000 7777 7777 |
| Mastercard       | 5555 5555 5555 4444 |
| American Express | 3782 822463 10005   |

### Disputes

1. Complete a payment with a sandbox buyer account
2. Log in to https://sandbox.paypal.com as the buyer → find the transaction → **Report a problem**
3. Use `GET /v2/customer/disputes` to see open disputes via API

### Webhooks

```bash
# Expose your local server on a public HTTPS URL first (PayPal cannot deliver to localhost).
# How you do this depends on what's available/approved on your network — see
# references/webhook-sandbox.md for the full requirement and pitfalls.

# Register webhook
curl -X POST https://api-m.sandbox.paypal.com/v1/notifications/webhooks \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR-PUBLIC-URL/webhooks/paypal",
    "event_types": [
      {"name": "PAYMENT.CAPTURE.COMPLETED"},
      {"name": "BILLING.SUBSCRIPTION.ACTIVATED"},
      {"name": "CUSTOMER.DISPUTE.CREATED"}
    ]
  }'
```

Use the [Webhooks Simulator](https://developer.paypal.com/dashboard/webhooksSimulator) for instant mock events without waiting for real transactions.

For the complete guided walkthrough — registering this subscription, triggering a real event, verifying its signature, inspecting delivery history, and cleaning up — just ask (e.g. "walk me through testing this webhook end to end").

## Key Gotchas

- Sandbox and production credentials are completely separate — never mix them
- Sandbox access tokens only work against `api-m.sandbox.paypal.com`
- Sandbox buyer approval requires logging in at https://sandbox.paypal.com (not the live site)
- Webhook events in sandbox may be delayed; use the Webhooks Simulator for immediate testing
