# Poll link previews

`GET /poll/:id` (including a trailing slash) renders the saved poll question into
`<title>`, `og:title` and `twitter:title` before sending HTML. Crawlers such as
Telegram's do not need to execute JavaScript or call the poll API. The regular
app shell is unchanged, and its client updates the browser title from poll state.

`lib/pages.js` receives a question-only accessor from `lib/polls.js` through
`server.js`. Metadata exposes the public question, a generic invitation, the
poll icon and a canonical `https://businesswife.nl/poll/:id` URL. It does not
include votes, voter identities, query strings or owner credentials. The public
origin is fixed rather than derived from an untrusted request Host header.
Questions are escaped as HTML, including quotes, markup and ampersands.

Specific poll HTML is sent with `Cache-Control: no-store`. Missing polls and the
poll lobby retain the generic shell. Existing service workers are network-first
for navigation; preview crawlers do not use their offline cache.

Third-party apps may cache a preview independently of our headers. After deploying,
a newly shared link should pick up its question; an already cached preview may
need to be refreshed by the receiving app. Automated tests prove crawler-visible
HTML, not delivery or refresh behavior in external apps.
