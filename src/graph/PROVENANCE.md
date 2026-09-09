# These five files are copies, and that is a liability worth naming

Source of truth: `integrations/graph/src/` in **namixai/signer-ethonline2026**,
at commit `3f16027b5309fae035c501a3900f27f5dbc62277`. They are here byte for byte — not adapted, not "ported".

## Why a copy and not a dependency

The reading code is not published to npm, and publishing it is Alex's call, not a
side effect of this change. So the honest interim is a copy that announces itself:
`test/graph-drift.test.ts` hashes these files against a local checkout of the
submission repository and fails when they diverge. If that checkout is absent the
test says so and skips — a guard that cannot run must not report success.

The right end state is one published package and no copies. Until then, a change to
the reading logic has to land in the submission repository first and be copied here
second, in that order, or the drift guard will catch it the wrong way round.

## What they do

`fetch.js` prices and runs the query against The Graph's keyless x402 gateway.
`attestation.js` verifies the indexer's signature over the exact response bytes.
`chain.js` resolves that signer to a staked indexer and reads the chain head.
`usability.js` decides whether the reading is a usable price at all.
`snapshot.js` composes the four into one answer that states what was not checked.
