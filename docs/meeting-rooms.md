# Meeting Rooms

`/meeting-room` is the shared meeting app. Standalone poker and poll routes and persisted data remain unchanged, avoiding a forced migration of existing links.

## Domain boundaries

- `lib/meetings.js`: persisted room, participants, facilitator, sessions, active activity and SSE. Stored under `meetingRooms` in the existing atomic store.
- `lib/meeting-activities.js`: activity registry. Each type supplies `configure`, `valid`, and `results`. Poker reuses the standalone summary calculation; poll uses distinct option/count rules.
- `meeting-room/`: shared room UI. One saved seat identity per device/room, editable through Change character without replacing the seat or ballots; changing activity is a room-wide facilitator action, while browsing history is local.

Add future tools to the registry and their UI renderer. Do not put tool-specific workflows into room membership or make each tool join a separate room. Tools beyond ballots may require additional explicit activity commands rather than forcing every interaction into `respond`.

## Lifecycle

A room is reusable until one calendar month after its last successful join or explicit action, UTC with end-of-month clamping. Public reads, previews, SSE connections, automatic reconnects and server heartbeats do not renew it. Returning clients explicitly reclaim their seat once on page load; that successful join renews the link. Expiry is enforced before each API operation, at persistence load and by a sweeper. Expired room data is discarded; this first version does not provide a separate long-term results archive.

Rooms retain separate meeting sessions. Ending a meeting closes its activities, clears the live activity and allows a new meeting with the same room URL and participant seats. Limits: 64 saved participants, 200 activities per meeting, 100 meetings per room, 5,000 rooms. Limits fail explicitly and never silently discard history. Saved participants are not an online-presence indicator.

Starting another activity suspends the previous one without losing ballots. Facilitators can resume any current-session activity. Poker supports hidden cards, reveal and re-vote; polls accept one final response and reveal aggregate counts when closed. Historic activities remain read-only.

## Identity and permissions

Room creation returns an owner capability once, stored on the creating device, with only its hash persisted. Only that capability can establish/recover facilitator authority on joining; an early visitor cannot capture it. Seat credentials are similarly hashed. Only the current facilitator controls activities, sessions and handover. Participants can respond to the currently active, open activity only; each mutation includes the expected activity ID to reject delayed votes/reveals after a switch. Public state excludes credentials, hashes, and unrevealed ballot values.

Creating-device storage is required to recover the creator capability; do not send it in public links. Handover transfers current control, but the creator retains recovery authority. No automatic handover to arbitrary arrivals. Member roster persists across meetings; a participant removal/archive UI and explicit capability export/recovery are future work.

The new room app currently requires a network connection. It intentionally has no offline worker; the standalone apps retain their existing workers.

## Verification

`npm test` runs desktop and phone meeting flows alongside all existing apps. `meeting-server.spec.js` covers access guards, delayed actions, hidden ballots, poll immutability, real SSE reconnect across process restart, persistence, handover and rolling/calendar expiry. `npm run lint:ui` includes the new lobby. Check the joined room too when changing its layout.
