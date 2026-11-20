// Activity-specific rules. New meeting helpers register here, not in room routing.
const { voteSummary } = require('./poker');
const poker = {
  configure(body) { return { title: text(body.title, 200) || 'Estimate a story', options: [] }; },
  valid(value) { return typeof value === 'string' && /^(0|1|2|3|5|8|13|20|40|100|\?|☕|∞)$/.test(value); },
  results(a, members) {
    return voteSummary(Object.entries(a.responses).map(([id, vote]) => ({ name: members[id]?.name || 'Former participant', vote })));
  },
};
const poll = {
  configure(body) {
    const title = text(body.title, 200);
    const options = Array.isArray(body.options) ? body.options.map(x => text(x, 80)) : [];
    if (!title || options.length < 2 || options.length > 8 || options.some(x => !x) || new Set(options).size !== options.length) return null;
    return { title, options: options.map((label, i) => ({ id: 'o' + i, label })) };
  },
  valid(value, a) { return a.options.some(o => o.id === value); },
  results(a) { return a.options.map(o => ({ ...o, count: Object.values(a.responses).filter(v => v === o.id).length })); },
};
function text(value, max) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''; }
module.exports = { activityTypes: { poker, poll }, text };
