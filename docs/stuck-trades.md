# Stuck Trades: What Anyone Can Do Today

This is the operational walkthrough for issue-style failures where a cash
hand-off stalls mid-flight (phone dies, parties lose contact, QR never gets
scanned) while funds remain locked in escrow and the on-chain timeout has not
yet elapsed.

**Short answer:** before timeout, nobody can force a permissionless refund.
Either the hand-off completes (`release`), a participant raises a dispute, or
everyone waits until the ledger timeout opens a permissionless refund. After
timeout, anyone can refund. Operators cannot silently seize or reassign funds
without going through the on-chain dispute path.

Related policy: [TIMEOUT_POLICY.md](TIMEOUT_POLICY.md).

---

## Scenario

1. Buyer locks USDC in the escrow contract.
2. Buyer shows the claim QR to the provider.
3. Something breaks before `release()` succeeds (dead phone, no-show, network
   drop).
4. Funds stay locked. Status remains `locked` until the timeout ledger is
   reached (API then surfaces `expired`), or a dispute is raised.

Default lock window for cash trades is `CASH_DEFAULT_TIMEOUT_LEDGERS` (100
ledgers, roughly 8–15 minutes). The claim page and
`GET /api/v1/cash/request/:id` expose how many ledgers remain before refund.

---

## What each party can do

### Buyer

| When | Options |
| --- | --- |
| While `locked`, before timeout | Re-open the claim URL / QR and retry the hand-off. Chat with the provider if a chat token is available. Raise a dispute with `POST /api/v1/cash/request/:id/dispute` (`caller` must be the buyer address). **Cannot** call `refund` yet — the contract rejects it with `TimeoutNotReached`. |
| After timeout (`expired` or ledger ≥ `timeoutLedger`) | Call `POST /api/v1/cash/request/:id/refund` (or submit a signed refund XDR). The claim page shows when refund is available and offers the refund action. Permissionless on-chain: anyone may submit `refund()`. |
| While `disputed` | Wait for arbitrator resolution, or — if the dispute window elapses unresolved — anyone may call the contract's `refund_after_dispute_timeout`. |

### Provider (seller / cash agent)

| When | Options |
| --- | --- |
| While `locked`, before timeout | Ask the buyer to re-show the QR and complete release via the merchant terminal. Chat if available. Raise a dispute with the same dispute endpoint (`caller` must be the seller address). **Cannot** pull funds without the secret, and **cannot** refund early. |
| After timeout | Same as anyone else: permissionless refund returns funds to the **buyer**, not the provider. A completed hand-off without `release` is an off-chain loss unless a dispute was raised in time. |
| While `disputed` | Await arbitrator split via `resolve_dispute`. |

### Operator / admin

| Action | Endpoint / path | Trust model |
| --- | --- | --- |
| Observe stuck / abuse signals | Admin dashboard + `GET /api/v1/admin/trades` | Off-chain only |
| Refund after timeout | `POST /api/v1/admin/trades/:id/refund` (or the public refund route) | Same on-chain gate as everyone else: `refund()` only succeeds once `timeout_ledger` is reached. Admin auth does **not** bypass the contract. |
| Intervene before timeout | Participant raises dispute → arbitrator calls `resolve_dispute` via `POST /api/v1/admin/trades/:id/resolve` | On-chain privileged path. Moves funds only after dispute; does not let a lone API key rewrite a still-`locked` trade. |
| Pause / fee / signer governance | Escrow admin / multisig contract methods | Unrelated to a single trade's escrow balance |

**What operators cannot do today without breaking trustlessness:** unilaterally
refund or release a still-`locked` trade before timeout. The API may *attempt*
an admin refund early, but the Soroban contract will reject it. Early
intervention requires the dispute → resolve flow.

---

## Status map (API vs chain)

| API status | On-chain meaning | Funds |
| --- | --- | --- |
| `locked` | Trade locked; timeout not reached (or ledger check pending) | Still in escrow |
| `expired` | API saw `current_ledger >= timeoutLedger`; display/workflow only | Still in escrow until `refund()` |
| `released` | Secret revealed; paid to seller (minus fee) | Out |
| `refunded` | Returned to buyer | Out |
| `disputed` | Release/refund blocked; awaiting arbitrator or dispute-timeout refund | Still in escrow |

`expired` does **not** move funds. Someone must still submit refund.

---

## Concrete improvement shipped with this doc

`GET /api/v1/cash/request/:id` now returns refund countdown fields whenever the
request is `locked` or `expired` and a `timeoutLedger` is known:

- `timeoutLedger` — first ledger where permissionless refund succeeds
- `latestLedger` — ledger sequence used for the check
- `ledgersUntilRefund` — `max(0, timeoutLedger - latestLedger)`
- `refundAvailable` — `true` once the timeout ledger is reached
- `estimatedSecondsUntilRefund` — wall-clock estimate (`ledgers × ~6s`)

The mobile claim page renders that countdown and, when `refundAvailable` is
true, offers a refund action so buyers do not have to guess when they can
recover funds.

---

## Quick decision tree

```text
Phone dies / hand-off stuck?
│
├─ Can you resume and scan the QR?
│   └─ Yes → provider scans → POST .../release → done
│
├─ Is the trade still before timeout? (claim page countdown > 0)
│   ├─ Need early operator help? → POST .../dispute → admin resolve_dispute
│   └─ Otherwise → wait; watch ledgersUntilRefund
│
└─ Timeout reached (refundAvailable / status expired)?
    └─ POST .../refund (buyer, operator, or anyone) → funds to buyer
```

---

## References

- Escrow contract: `contracts/escrow/src/lib.rs` (`lock`, `release`, `refund`,
  `raise_dispute`, `resolve_dispute`, `refund_after_dispute_timeout`)
- Cash routes: `apps/api/src/routes/cash.ts`
- Admin resolve / refund: `apps/api/src/routes/admin.ts`
- Timeout constants: `apps/api/src/lib/timeouts.ts`
