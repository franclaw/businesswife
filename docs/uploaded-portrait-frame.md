# Uploaded portrait frame

New file uploads and CORS-readable image-URL imports use the shared wife picker
in both Planning Poker and Poll. The client crops a photo to a 2:3 portrait
without stretching, draws `/img/portrait-frame-v1.png` over it, and compresses the
result as a JPEG data URL under the existing 19,000-character client budget.

The frame is part of the stored/sent image, not a temporary CSS decoration:
it follows new uploads into preview, saved cards, seats, voter portraits and
later visits. Stock portraits already contain their own border and are unchanged.
Previously saved unframed uploads remain unchanged; re-upload one to frame it.
Legacy oversized uploads are only shrunk during migration, never double-framed.
If the frame cannot load, the picker reports an error and retains the previous
portrait. Joining is disabled while a new upload is processed.

The overlay is precached by both installable apps and uses the existing shared
`/img/` service-worker allowlist. Its 256×384 production PNG is about 123 KB; the
high-resolution generation master is retained outside the repo. Compression
limits are checked after compositing the frame, not before.

## Asset provenance

- Built-in image-generation tool (not the CLI/API fallback).
- Edit reference: existing `public/img/closer.png`.
- Output: `public/img/portrait-frame-v1.png`, RGBA with a transparent centre.
- Full generation prompt:

> Create a reusable transparent PNG portrait FRAME OVERLAY from the supplied Business Wife portrait. Edit target: supplied image. Preserve the 2:3 portrait aspect ratio and the original ornate Art Deco gold decorative rectangular perimeter, fine gold rules, geometric fan motifs at top/bottom center and corners, burgundy/red aged outer rim and distressed gold edges. Remove ALL of the woman, clothing, red shoe, furniture and the burgundy INNER BACKGROUND. The entire central portrait area must be genuinely transparent alpha (not white, black or checkerboard drawn into image), ready to place over a user's photo. Keep only a narrow continuous ornate gold/burgundy perimeter occupying about 8 percent on each side and 8 percent top/bottom, leaving at least 80 percent width of central opening unobscured. Remove the central oval gold line as it would cross a user's face. Frame aligned to canvas edges, no surrounding space. No text, no person, no objects, no logo. Match the supplied elegant distressed antique gold on dark oxblood border closely; this must be a production transparent overlay, not a new illustrated portrait.

## Verification

`tests/e2e/portrait-frame.spec.js` checks frame pixels, portrait aspect ratio,
payload budget, square/landscape uploads, persistence through saved-card reuse,
actual poker seats and poll votes, plus a missing-frame failure with a retained
stock portrait and successful retry, and offline framing using the precached
overlay. Existing feedback export assertions now wait for that client's
SSE-rendered field instead of racing a different client's results update.
