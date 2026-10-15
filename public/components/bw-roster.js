// The Business Wife roster: one list for every app that shows the portraits.
// `name` is the title (what poker seats use as the player name), `first` the
// first name (what polls show), `img` the full portrait; thumbnails live under
// /img/thumb/ as .jpg.
window.BW_ROSTER = [
  { icon: "💼", name: "The Executive", first: "Vivienne", img: "/img/executive.png" },
  { icon: "👠", name: "The Closer", first: "Coco", img: "/img/closer.png" },
  { icon: "👩‍💼", name: "Boardroom Boss", first: "Victoria", img: "/img/boardroom.png" },
  { icon: "📊", name: "Quarterly Queen", first: "Margot", img: "/img/quarterly.png" },
  { icon: "📋", name: "Executive Assistant", first: "Scarlett", img: "/img/assistant.png" },
  { icon: "🗂️", name: "Head of HR", first: "Danielle", img: "/img/hr.png" },
  { icon: "💍", name: "The Merger", first: "Aurélie", img: "/img/merger.png" },
  { icon: "🥂", name: "Champagne CFO", first: "Bibi", img: "/img/cfo.png" },
  { icon: "⚖️", name: "Legal Counsel", first: "Charlotte", img: "/img/legal.png" },
  { icon: "💄", name: "The Negotiator", first: "Roxane", img: "/img/negotiator.png" },
  { icon: "☕", name: "Secretary", first: "Betty", img: "/img/secretary.png" },
  { icon: "⛓️", name: "Trekhaak services", first: "Jaqueline", img: "/img/broker.png" },
  { icon: "🖊️", name: "Signature Artist", first: "Joséphine", img: "/img/signature.png" },
  { icon: "💅", name: "Interim CEO", first: "Catherine", img: "/img/interim-ceo.png" },
  { icon: "📈", name: "Growth Widow", first: "Gaby", img: "/img/growth.png" },
  { icon: "🧾", name: "Expense Account", first: "Tamara", img: "/img/expense.png" },
];

/** /img/x.png -> /img/thumb/x.jpg; anything else unchanged. */
window.bwThumb = function (src) {
  if (!src || !String(src).startsWith("/img/") || String(src).startsWith("/img/thumb/")) return src;
  return String(src).replace("/img/", "/img/thumb/").replace(/\.png$/, ".jpg");
};
