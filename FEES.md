# FEES — Action Hub service fee

Engine: `api/_lib/fee-engine.js` — `getPlatformFee({ action, provider,
instrument, user, amount })` → `{ enabled, bps, amount, asset, recipient,
source }`. Priority: specific → provider → action → global. Config lives in
the `config` table (`fee:*`) or env (`ACTION_HUB_DEFAULT_FEE_BPS`,
`ACTION_HUB_FEE_RECIPIENT`).

| Fee | Meaning |
|---|---|
| Protocol fee | Charged by the underlying protocol (pool, market) |
| Provider fee | Charged by the routing/execution provider |
| Action Hub fee | Hub service fee — real PTB leg or $0.00 |
| Network fee | Sui gas (estimated pre-sign, actual post-confirmation) |
| Builder fee | Where the protocol supports it (Predict builder-code split) |
| Penalty / Impact | Instrument-specific (Predict, exact per market) |

Rules:

1. Without `ACTION_HUB_FEE_RECIPIENT` (valid Sui address) the platform fee
   is **disabled** — never routed anywhere unknown.
2. The recipient is env/admin only. No `setFeeRecipient(userInput)` exists;
   AI cannot choose it; the frontend never hardcodes it.
3. Displayed fee === actual transaction (§85). Swap SUI-input PTBs carry a
   real `splitCoins → transferObjects` leg when enabled; spot/predict PTBs
   carry none today, so they honestly show $0.00. The platform fee leg is
   carved from the **input coin**, so it is always reported in whole units of
   the input asset (`platformFeeAsset`) — never mislabelled as USD. The raw
   base-unit leg stays on `feeCollected.amountMist` for on-chain accounting.
4. Predict builder/referral revenue is a **split of protocol proceeds**,
   never a trader debit. Without a registered builder code there is no
   eligible Predict revenue.
5. `RevenueEntry` is written only after `confirmed`, from actual hub
   revenue. Referral = configurable % of that revenue
   (`gross → referral → net`), settled once per digest (unique index).
   Self-referral, circular, expired-window and zero-revenue cases pay 0.
