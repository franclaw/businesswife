# Shared wife selection and final poll ballots

Poker and polls both use `public/components/bw-wife-picker.js` and its CSS,
including the upload controls, portrait processing, previews, saved cards,
subtitles and raw-photo frame flag. Host label styles must not override this
component's control typography; rendered checks cover both apps at mobile and
desktop widths.

## Device library

Both pickers default to `sbw_custom_wives` on the same browser/origin. Existing
`bw_poll_custom_wives` entries migrate into it once, preserving subtitles and
raw/frame flags. Names deduplicate case-insensitively, newest `savedAt` wins,
and the ten most recently used entries remain. Migration only removes the old
key after a successful shared write. Saved-wife removal affects both apps.
`picker.refresh()` re-reads storage when the picker is opened, so another tab's
new saves are available without reloading. This is device-local reuse, not
cross-device storage or copying data between LAN and production origins.

## Poll reservations

`POST /poll/api/polls/:id/identity` accepts `voterId`, `name`, `icon`, `raw` and
optional `subtitle`. The server reserves the normalized display name for that
participant in that poll, before voting. Reservations are case-insensitive;
custom wives behave like poker (unique names, not unique stock-avatar images).
An atomic duplicate claim returns 409. Switching before voting releases the old
name. The shared picker moves unavailable roster cards into Taken and disables
taken saved cards; SSE updates availability on other devices.

Only hashes of voter IDs are persisted. Public `identities` contains display
information, never voter IDs/hashes. Reservations survive restart and named
legacy votes reserve their wives on load. Abandoned selections remain reserved,
like a poker seat; they are not expired independently of the poll.

## Final votes

Results appear immediately after submitting, so the first accepted ballot is
final. The UI disables options and identity changes and explains that the vote
is final. The server rejects a changed ballot with 409 and the accepted
`optionId`, even after reload/restart or concurrent submissions. A same-option
retry returns success without rewriting identity or changing state. A reserved
wife, not a replacement name supplied in a vote request, labels the ballot.
Restoring identity also returns the accepted option, allowing the client to
recover after a lost response or missing local vote record.

As before, anonymous API votes are supported, and voter IDs are per-tab bearer
identifiers rather than authenticated people. Reservations apply within a poll,
not across independent polls or apps. Existing duplicate legacy ballots are not
deleted or renamed during upgrade.
