# Uploaded portrait frame

New file uploads and CORS-readable image-URL imports use the shared wife picker
in both Planning Poker and Poll. The client crops the photo to a 2:3 portrait
without stretching, compresses it as a JPEG data URL under the existing
19,000-character client budget, and stores it **raw — the frame is not baked
in**. The frame is painted in the frontend as a CSS overlay (`.bw-framed`,
styled in `/components/bw-wife-picker.css`), so every surface that shows the
upload — picker preview, saved card, poker seat, voter chip and voter cells —
draws exactly the same frame at display resolution, without a second round of
JPEG artefacts.

Because the frame is a frontend overlay, restyling it later (a thinner border,
a different season's frame) needs no re-uploads: every stored raw photo picks
the new look on next paint.

## The `raw` flag

The icon string alone cannot distinguish today's three portrait kinds, so an
explicit flag rides along:

- Stock roster portraits (`/img/*.png`) carry their frame in the asset itself
  and are never overlaid.
- Uploads saved by the current picker are raw; they set `raw: true` on the
  picker value, `raw: 1` in saved-wife storage, and `raw: true` on the poker
  join and poll vote payloads. The server keeps the boolean on the seat/vote
  and echoes it in room/poll state so other devices overlay it too.
- Entries saved by the previous build (frame composited into the JPEG) and
  ancient oversized uploads have no flag and render exactly as before —
  never double-framed.

## Geometry (option A, 2026-10-21)

`/img/portrait-frame-v1.png` is drawn 15% oversized and cropped by the photo
box (`inset: -7.5%`), which trims its outer rim and slims the ornate border
over the photo from ~13% to ~8% per side. The 2026-10-21 review picked this
over a −28% crop ("option B") because B clips too much of the burgundy rim to
still read as the stock frame; if B is ever wanted, generate a thin-border
asset rather than cropping further.

## Budget, offline and failure behaviour

The frame asset is precached by both installable apps and served under the
shared `/img/` service-worker allowlist, so the overlay also paints offline.
If the frame asset itself fails to load, only the overlay is missing: the
upload, its preview and the join flow all still work (unlike the old build,
where a failed frame fetch rejected the whole upload). Compression limits are
checked on the raw crop, not on a composite.

## Asset provenance

- Built-in image-generation tool (not the CLI/API fallback).
- Edit reference: existing `public/img/closer.png`.
- Output: `public/img/portrait-frame-v1.png`, RGBA with a transparent centre.
- Full generation prompt:

> Create a reusable transparent PNG portrait FRAME OVERLAY from the supplied Business Wife portrait. Edit target: supplied image. Preserve the 2:3 portrait aspect ratio and the original ornate Art Deco gold decorative rectangular perimeter, fine gold rules, geometric fan motifs at top/bottom center and corners, burgundy/red aged outer rim and distressed gold edges. Remove ALL of the woman, clothing, red shoe, furniture and the burgundy INNER BACKGROUND. The entire central portrait area must be genuinely transparent alpha (not white, black or checkerboard drawn into image), ready to place over a user's photo. Keep only a narrow continuous ornate gold/burgundy perimeter occupying about 8 percent on each side and 8 percent top/bottom, leaving at least 80 percent width of central opening unobscured. Remove the central oval gold line as it would cross a user's face. Frame aligned to canvas edges, no surrounding space. No text, no person, no objects, no logo. Match the supplied elegant distressed antique gold on dark oxblood border closely; this must be a production transparent overlay, not a new illustrated portrait.

## Verification

`tests/e2e/portrait-frame.spec.js` checks raw storage (flat-blue uploads stay
blue at centre, top band and corners), the 2:3 crop and the payload budget,
the overlay on preview/poker seat/saved card, legacy flagless entries staying
unframed without a double frame, the poll vote round-trip including the
server-side `raw` echo, flagless vs flagged server votes, and an offline
upload whose overlay paints from the precache.
