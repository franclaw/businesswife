# Character selection and room ownership

All three character-based apps (Planning Poker, Poll and Meeting Room) use `public/components/bw-wife-picker.js`. The picker renders Add your own first, its editor immediately below, then saved and built-in characters. Custom characters are a shared device library; choosing one never automatically joins another room.

`public/components/bw-room-session.js` is the shared scoped browser store. It preserves existing poker seat keys (`sbw_seat_<room>`), meeting credentials (`bw_meeting_<room>`) and stores poll selections under `bw_poll_identity_<poll>`. The unscoped legacy `bw_poll_identity` is deliberately not used to auto-join new polls. Reopening a previously selected room restores that room's identity. Storage falls back from localStorage to sessionStorage and finally tab memory when browser storage is unavailable.

Each app exposes Change character after joining. Identity updates reuse the authenticated participant and preserve roles, facilitator/host status and votes. Name conflicts are checked server-side. Polls permit character edits even after voting or closure, but their ballot option remains final; retries through `/vote` cannot rewrite identity. `/identity` with `restore: true` returns the server's current identity instead of overwriting it with stale device data.

## Poker creator authority

New poker room creation returns `ownerToken` once. The server persists only `ownerHash`; the creating device saves the capability separately as `sbw_owner_<room>` using the shared store. Public URLs and state never include it. The creator claims/restores host status on joining or rejoining with that token. A first visitor cannot become host, and a departing creator does not hand host authority to another visitor. The creator can return to their own locked room.

Existing persisted poker rooms without creator metadata retain their existing host model: the original creator cannot be reliably recovered from old data. Creating a new room uses the new creator-host rule. Normal seated participants still retain the existing collaborative reveal/next-round actions; kick and lock remain host-only.

Verification: `change-character.spec.js` covers UI changes on desktop and phone, per-poll join isolation and guest-before-creator order. `character-server.spec.js` covers permissions, conflicts, persistence, creator recovery and unchanged votes.

## Poll rounds on a stable link

The poll creator's New poll round button opens a private draft using the existing question/title and option labels. The URL stays fixed. Cancel leaves the active round untouched; Start new round validates and archives it, clears ballots, and opens the next round. Participant identities and owner authority persist. Earlier aggregate results remain under Previous rounds, including after restart. A poll supports up to 100 rounds without silently dropping history.

`POST /poll/api/polls/:id/round` requires the owner capability and expected current `round`, plus `question` and `options`. Votes and close operations include the displayed round; stale operations fail with 409 instead of voting in or closing a newer round. Missing round is accepted only for round 1 to support older clients. Existing saved polls load as round 1.

Clients retain the existing round-1 ballot key and use `bw_poll_vote_<poll>_r<round>` thereafter. Live round changes clear the old locked ballot and allow another vote without another character join. The server returns the round with restored ballots so delayed responses cannot restore a previous round's vote into the current round.
