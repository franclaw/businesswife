# Feedback & voting

Native zero-build-step sub-app at `/feedback`. The hub links to it.

## Flow

`collecting ↔ revealed ↔ voting ↔ results`

Only a facilitator capability token can change state, moderate or merge items.
The facilitator is also a normal participant; closing never waits for everyone
to vote. Backward moves preserve feedback and current vote selections.

- Browser-generated participant IDs are stored locally, hashed on the server.
- Private facilitator links carry their token in the URL fragment. The browser
  remembers it locally; recent sessions are not listed by a public API.
- Both HTTP snapshots and SSE updates use the same per-viewer projection:
  collecting shows only that participant's items (even to the facilitator),
  voting shows only their own selections, and totals appear only in results.
  No author hashes or other voters' selections are delivered.
- Merges stay within a category, retain original texts and union each person's
  votes: voting for both originals becomes one vote on the combined item,
  returning the spare vote to that participant's budget.
- Deleting an item removes its votes. Editing a merged item retains originals.
- Results offer category ordering by vote count or original order, an overall
  ranking, and facilitator Markdown download/copy. There is no generated report.
- Sessions persist in the existing `DATA_DIR/state.json`, with hashed secrets,
  atomic saves, and graceful-shutdown flushing. Feedback sessions do not expire
  automatically; the bounded store admits up to 2,000 sessions.
- EventSource automatically reconnects and receives a fresh personalized
  snapshot. In-progress drafts survive live updates/reconnects in the open tab;
  offline submissions are not queued. Retrying a failed submission is manual.

The QR generator is a locally vendored MIT-licensed QRCode.js component, not a
third-party service. See `public/components/feedback-qr.LICENSE.txt`.

## Checks

Start a throwaway server (never use production data):

```sh
PORT=6983 DATA_DIR=/tmp/businesswife-feedback-test node server.js
BASE_URL=http://127.0.0.1:6983 npx playwright test
npm run lint:ui
```

`tests/e2e/feedback.spec.js` covers server-side HTTP/SSE privacy, facilitator-only
controls, vote budgets/idempotence, merges, backward transitions, eight separate
mobile participants, abstention, facilitator voting, Markdown copy/download,
refresh/local session links, persistence and real SSE reconnection after restart.
The pre-existing suite must stay green as well. **Without `BASE_URL`, the test
configuration targets the live website.**
