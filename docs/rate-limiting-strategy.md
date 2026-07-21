# Rate Limiting Strategy for Velo (x402 Micropayments)

Velo uses the x402 model where payment is the authentication mechanism, removing the need for traditional API keys. This creates a vulnerability to spam and DDoS attacks on endpoints before a payment is verified.

## Recommendations and Tradeoffs

### 1. IP-Based Soft Limits & Progressive Delays

**Approach**: Limit the number of unverified requests (e.g., requests requesting a price quote) per IP address per minute. Exceeding this limit results in a `429 Too Many Requests` or introduces a progressive artificial delay.

- **Pros**: Easy to implement at the infrastructure level (WAF, Nginx, Redis). Protects against basic spam bots.
- **Cons**: Can penalize users behind NATs or corporate firewalls (shared IPs). Sophisticated attackers can rotate IPs.

### 2. Client-Side Proof of Work (PoW)

**Approach**: Before quoting a price or generating an invoice, the server provides a cryptographic challenge that the client must solve. This forces the client to expend compute resources, creating friction for automated spam while remaining mostly unnoticeable to legitimate users.

- **Pros**: Imposes an economic cost (compute) on the attacker regardless of their IP. Highly effective against volumetric spam without penalizing legitimate shared IPs.
- **Cons**: Increases latency and complexity for legitimate clients. Difficult to calibrate for various devices (mobile vs. desktop).

### 3. Challenge-Response / CAPTCHA for High Volume

**Approach**: Normal requests proceed smoothly, but if a behavioral anomaly is detected, a CAPTCHA or cryptographic challenge is required before proceeding to the payment step.

- **Pros**: Reduces friction for normal users. Good fallback mechanism.
- **Cons**: Requires complex anomaly detection. CAPTCHAs ruin the seamless automated micropayment UX.

### 4. Websocket/Session Rate Limiting

**Approach**: Require a session initialization to get an invoice. Limit the number of pending unpaid invoices per session.

- **Pros**: Limits the ability to spam invoice generation without completing payments.
- **Cons**: Requires stateful connections, scaling complexity.

## Final Recommendation

Implement **IP-Based Soft Limits** combined with a **Session-based Unpaid Invoice Limit** (maximum of N pending invoices per IP/Session). For future-proofing against sophisticated botnets, lay the groundwork for **Client-Side PoW** to be triggered dynamically when system load spikes.
