# ADR-0046: Gateway `getIssuedCard` Read-Accessor for Transport Adapters

**Status:** Accepted
**Date:** 2026-06-16
**Tags:** gateway, telegram, approval-cards, api-surface

## Context

The Telegram gateway adapter (`@aisy/telegram-gw`) must render an approval card
as a Telegram message with inline buttons. Each button's `callback_data`
encodes `{cardId, nonce, verb}` so a tap can be turned back into a `CardTap`.
`handleCardTap` requires the tap to echo the **exact** `mintedNonce` and
`actionHash` bound at issue (spec §5.3 step 1; gateway/index.ts lines 340, 350).

But the existing API gives the adapter no supported way to obtain those values:

- `Gateway.issueCard(action)` returns only a bare `CardId`. The `mintedNonce`
  is generated inside `makeGateway` (via `deps.mintNonce`, an injected
  **test** seam) and stored in the private `cards` Map — never surfaced.
- `GatewayDeps` has no transport-send seam; `streamReply` drains tokens but the
  actual Telegram send is "injected in real deployments" and not yet wired.

So a transport adapter cannot build the approval button. This is a genuine gap,
not something an edge adapter can paper over: the nonce is encapsulated by
design (it is the single-use binding that makes "knowing the cardId alone
insufficient", per ADR-0029 §4).

## Decision

**Add a read-only accessor to the `Gateway` interface:**

```ts
getIssuedCard(cardId: CardId): IssuedCardView | null
```

where

```ts
interface IssuedCardView {
  cardId: CardId
  actionId: string
  actionHash: string
  nonce: string          // the single-use nonce minted at issue
  requiresStepUp: boolean
  redVariant: boolean    // Tier-3 renders as the distinct red card
  expiresAt: number      // epoch ms; informational countdown / liveness
}
```

It returns a projection of the internal `IssuedCard` for a live card, or `null`
for an unknown or already-confirmed-and-cleared card. It is synchronous (an
in-memory map read) and confers **no confirmation power** — `handleCardTap`
remains the sole, deterministic confirmer.

The adapter flow becomes: `cardId = await gw.issueCard(action)` →
`view = gw.getIssuedCard(cardId)` → render body from the `PendingAction` it
already holds + embed `view.nonce` in `callback_data`.

Telegram-specific rendering and `callback_data` encoding stay entirely in the
adapter; Core returns **data, never a rendered message**.

## Consequences

- **Positive:** Additive. `issueCard` keeps its `Promise<CardId>` signature, so
  the spec §5.3 contract and AC-02-7..12 conformance are untouched (527 tests
  green, up from 524 with 3 new accessor tests).
- **Positive:** Keeps the transport-agnostic boundary intact — Core has no
  knowledge of HTML, inline keyboards, or the 64-byte `callback_data` cap.
- **Positive:** The internal `IssuedCard` already modelled exactly this view;
  we expose a read-only projection rather than inventing new state.
- **Negative / accepted:** The minted nonce is now readable by any in-process
  holder of a `cardId`. This is acceptable under the threat model: the nonce
  defends against replay (still blocked by `consumedTaps`) and taps on
  never-issued cards; it is **not** a secret from the trusted in-process
  transport that renders the button (the nonce ships in `callback_data`
  regardless). The model never calls Gateway methods — it emits actions/text —
  so it cannot reach this accessor.
- **Neutral:** Two calls (`issueCard` then `getIssuedCard`) instead of one.
  Same process, no expiry window between them in practice.

## Alternatives considered

**Enrich `issueCard` to return `IssuedCardView` instead of `CardId`:** Cleaner
semantically (one call), but changes a public method signature defined by the
spec — touches AC-02-7 and every existing caller/test. Rejected as
unnecessarily breaking for a need an additive accessor already meets.

**Add a transport seam (`sendCard`/`sendMessage`) to `GatewayDeps`:** Would let
the Gateway render and send the card itself. Rejected: it drags Telegram
specifics (HTML, inline keyboards, encoding) into Core and would duplicate the
adapter's `approval-card.ts`, breaking the transport-agnostic boundary.

## References

- spec §5.3 (approval-card callback lifecycle)
- ADR-0029 §4 (a tap applies only to the exact pending action it was issued for)
- ADR-0045 (Telegram as primary gateway adapter — forthcoming)
- `packages/core-ts/src/gateway/types.ts` — `IssuedCardView`, `Gateway`
- `packages/core-ts/src/gateway/index.ts` — `getIssuedCard` implementation
- `packages/core-ts/src/gateway/gateway.spec.ts` — accessor tests
