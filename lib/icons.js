// What may be stored and broadcast as a person's picture.
//
// Built-in portraits (/img/<name>.png), a small uploaded data URL, or a short
// emoji. External URLs are refused: they would let any page owner see who opens
// a room or poll, and they bloat every broadcast for every listener.
const ICON_DATA_MAX = 20_000; // characters; the client resizes uploads to fit

function validIcon(icon) {
  if (typeof icon !== 'string' || !icon) return false;
  if (/^\/img\/[a-z0-9-]+\.png$/.test(icon)) return true;
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)) return icon.length <= ICON_DATA_MAX;
  if (/^[a-z]+:/i.test(icon) || icon.includes('/')) return false;
  return [...icon].length <= 8 && icon.length <= 32;
}

module.exports = { validIcon, ICON_DATA_MAX };
