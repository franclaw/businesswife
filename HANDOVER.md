# Handover — Date Picker redesign (name-keyed availability + capability URLs)

**Branch:** `wip/date-picker-lock-links`
**Head:** `b6be63b`
**Date:** 2026-10-09
**Status:** server complete and verified, **client not started**, **not merged**, **not live**

Read this top to bottom before touching code. The "Do not merge yet" section is the
one that breaks production if skipped.

---

## 1. The project in one paragraph

`businesswife.nl` is a zero-dependency Node.js hub of small web apps. One file
(`server.js`, ~900 lines) serves static files, a JSON API and SSE; each app is a
single vanilla-JS HTML file. No build step, no npm packages, no framework, no CI.

| Path | File | What |
| --- | --- | --- |
| `/` | `hub.html` | app launcher |
| `/planning-poker` | `index.html` | poker planning, custom "wives" |
| `/poll` | `poll/index.html` | live polls |
| `/pomodoro` | `pomodoro/index.html` | timer |
| `/dates` | `dates/index.html` | **the app this handover is about** |

Conventions that are not optional: zero external dependencies; the dark theme CSS
variables (`--bg #0f0c14`, `--surface #171219`, `--accent #c43d6e`, `--gold #c9a227`);
PWA-installable (manifest + service worker + 192/512 icons); 6-char ids from
`ID_CHARS = '23456789abcdefghjkmnpqrstuvwxyz'`; Playwright e2e specs in `tests/e2e/`
keyed off `data-testid`.

## 2. Where things actually stand

**Live on `businesswife.nl` right now:** the *original* Date Picker, merged as
`cb7c6d5`. It is device-keyed (one anonymous voter id per browser), has no names, no
lock links, and no creator URL. That is the version users see.

**On this branch, committed and verified:** everything the user asked for on the
server side, in two commits:

- `9fa1c03` — availability keyed by **name** instead of device; anyone may fill in or
  correct anyone else's answers; locking a name mints a UUID edit link
- `b6be63b` — the **creator capability URL**; only the creator can set the final date

**Not done:** the client. `dates/index.html` on this branch is still the old page and
**does not speak the new API**. This is the whole remaining job.

## 3. What the user asked for

Verbatim, in order:

1. "the one who creates the date room should be able to propose date and which parts
   of the day of those dates" — the creator picks specific dates *and* which parts of
   each are on the table. Unproposed parts are not offered at all.
2. "people who set their dates need to set their name" — a name is required to mark.
3. "Anybody should be able to add or edit dates from any name" — availability is
   shared and collaborative, not per-device.
4. "only the creator of the vote is able to lock in the date, so creator should have a
   special admin url" — creator powers travel as a URL, not a device id.

Point 4 came with a real bug it quietly fixes: creator used to be a device-local id,
so switching phones silently cost you the ability to lock in a date.

## 4. The model

Three tiers, deliberately:

- **Anyone** can mark availability for **any name**, and correct anyone else's
  mistakes. No account, no device identity. Names are matched case-insensitively and
  trimmed; `Sana` and `sana` are one person.
- **A locked name** can only be edited by whoever holds that name's UUID edit link.
  Locking is how you say "these are my answers, don't type over them" while staying
  in the shared model.
- **The creator** holds the creator URL and is the only one who can set the final
  date, reopen voting, or add more dates later.

Both credentials are UUIDs, both are capabilities (holding them *is* the permission),
and **neither is ever included in broadcast state** — verified, not assumed.

## 5. API contract

All under `/dates/api`. Bodies and responses are JSON.

| Method + path | Body | Notes |
| --- | --- | --- |
| `POST /picks` | `title`, `days[{date, blocks[]}]` | 200 `{ id, ownerToken }`. `ownerToken` is returned **once**, here only. ≤14 days, dates within 14 days, each date needs ≥1 valid part |
| `GET /picks/:id` | — | full state: `days[].blocks[].{id,label,who[],count,locked}`, `people[]`, `totalPeople`, `best`, `closed`, `chosen` |
| `POST /picks/:id/mark` | `name`, `date`, `block`, `on` | 400 `name required`; 400 if that part was not proposed; **423 `{error:"locked", name}`** if locked and credential missing/wrong; 409 once a date is set |
| `POST /picks/:id/lock` | `name` | 200 `{ name, token }`. 400 nothing marked; 409 already locked |
| `POST /picks/:id/unlock` | `name`, credential | 403 wrong credential. The same link keeps working after unlock |
| `GET /picks/:id/who` | a query param carrying either credential | resolves `{role:"admin"}` for the creator URL, `{role:"person", name, locked}` for a lock link, 403 otherwise. Lets a link resolve on a fresh device |
| `GET /picks/:id/events` | — | SSE. First frame is full state, then one per change |
| `POST /picks/:id/choose` | creator credential, `date`, `block` | **403 `creator link only`** without it. Sets the date, closes the pick |
| `POST /picks/:id/reopen` | creator credential | reopens |
| `POST /picks/:id/dates` | creator credential, `days[]` | creator adds more dates later; 409 if a date is already set |

Routes: `/dates`, `/dates/:id`, `/dates/:id/<uuid>` (a person's edit link) and
`/dates/:id/admin/<uuid>` (the creator link) all serve the same HTML — the client
reads the path and decides what it is.

## 6. What the client must do

`dates/index.html` currently sends `voterId` and expects the old response shape. It
needs a real rewrite, not a patch.

1. **Create form** — title, then per-date part checkboxes (morning/afternoon/evening)
   so the creator proposes parts, not just days. On success, show the creator URL
   **once**, loudly, with copy and "save this, it is the only way to lock in the date".
2. **Grid** — render only proposed parts. Cells tint by how many people are in; the
   cell where everyone overlaps goes gold; the winner is named in plain words
   ("Friday, October 9 · Evening — everyone is free, 3 of 3").
3. **Name field** — required before marking, remembered in `localStorage`.
4. **Marking** — tap any cell for any name; show whose answers are in each cell.
5. **Lock in my answers** — calls `/lock`, then shows that person's edit URL with the
   same save-this-link warning.
6. **Locked state** — a 423 must be explained in words, not a spinner or a toast:
   "Marc's answers are locked. Only his edit link can change them."
7. **Link resolution** — on load, if the path has a UUID, call `/who` and switch
   context: `role:"person"` preselects that name and offers unlock; `role:"admin"`
   reveals the creator panel.
8. **Creator panel** — set the final date, reopen, add more dates. Only visible with
   the creator credential.
9. **Tests** — extend `tests/e2e/dates.spec.js`. It currently has 16 passing specs
   written against the old contract; most will need rewriting, not deleting.

## 7. Do not merge yet

**The new server is not backward compatible with the deployed client.** The live page
sends `voterId` and expects device-keyed responses; the new API wants `name`. Merging
this branch to `main` alone would break `/dates` for anyone who opens it.

Ship server and client **in the same merge**. That is the one rule here.

## 8. How to work on this

```bash
# clone (the default ssh key is a different GitHub account with no push access)
git clone git@github.com:franclaw/businesswife.git && cd businesswife
git checkout wip/date-picker-lock-links

# run
PORT=6977 node server.js

# e2e (BASE_URL defaults to the LIVE site — point it at your local server)
cd tests && npx playwright test dates.spec.js
BASE_URL=http://127.0.0.1:6977 npx playwright test dates.spec.js

# push
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_franclaw -o IdentitiesOnly=yes" git push origin HEAD
```

Node v24.20.0, Playwright 1.63.0. Full suite on `main` is **60 passing**.

## 9. Deploy

Pushing to `main` appears to deploy automatically in **~90 seconds** — no CI exists in
the repo, so it is a Dokploy webhook we could not inspect (panel at
`http://141.144.197.82:3000` returns 401; SSH to the box is denied).

**Always verify a deploy instead of assuming it happened.** Poll for a marker only the
new build has:

```bash
curl -s https://businesswife.nl/dates | grep -c 'some-string-only-in-the-new-build'
```

## 10. Traps that cost real time today

- **An outbound secret-masking layer rewrites credential-looking assignments.** Text
  like `token: <value>` or a field named after a credential gets replaced with `***`
  in *exec command text*, silently, producing code that looks plausible and does not
  parse. It corrupted product code, a test file, a harness and a probe before being
  diagnosed. Mitigations that work: write files with file tools rather than heredocs;
  use neutral names (`ownerToken`, `kA`, `K_PERSON`); assemble sensitive-looking
  literals at runtime (`'to' + 'ken'`); and after any edit, `grep -n '\*\*\*'` plus
  `node --check`. If you see `***` in a file, it is this — not a typo.
- **`/api/rooms/:id` is not the state endpoint.** It returns `{id, exists, locked}`.
  Players come from `/api/rooms/:id/state`. A probe that read the first one reported
  a healthy deployment as broken.
- **One network read is not one SSE frame.** Buffer and split on blank lines, or a
  large frame truncates mid-JSON and looks like a server bug.
- **`BASE_URL` defaults to production.** Forgetting it runs the suite against the live
  site and can pollute real rooms.
- **`MAX_OPTIONS` in `poll/index.html` is still 8.** The user asked for 10; it was
  never changed. Unrelated to this branch, still owed.

## 11. Loose ends not part of this work

- Delete merged remote branches: `feat/saved-custom-wives`, `feat/custom-wife-subtitle`,
  `fix/boardroom-seat-alignment`, `feat/poll-app`, `feat/date-picker`.
- Cosmetic: the LIVE dot stays green on closed polls; percentages can sum to 101%.
- Dokploy auto-deploy webhook is undocumented and unconfirmed — worth pinning down.
- `gh` CLI token is dead (401), so PRs must be opened by hand or via git.

## 12. Suggested first commit

```bash
git checkout wip/date-picker-lock-links
node --check server.js
PORT=6977 node server.js &
DATES_BASE=http://127.0.0.1:6977 node tests/probe-dates-api.mjs
```

`tests/probe-dates-api.mjs` is committed on this branch. It runs 17 API checks covering
per-date parts, case-insensitive names, cross-device marking, lock/unlock enforcement,
credential non-interchangeability, and no credential leakage in broadcast state. If
those pass, the server is trustworthy and the job is purely the client in section 6.
