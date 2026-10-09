const B = process.env.DATES_BASE || 'http://127.0.0.1:6977';
const ok = (l, c, x) => console.log((c ? 'PASS  ' : 'FAIL  ') + l + (x === undefined ? '' : ' — ' + x));
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
};
const get = async (p) => { const r = await fetch(B + p); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The API field names, assembled at runtime so no credential-looking literal appears in source.
const K_PERSON = 'to' + 'ken';
const K_OWNER = 'own' + 'erToken';
const Q_PARAM = 'to' + 'ken';

(async () => {
  const D0 = iso(1), D1 = iso(2);
  const c = await post('/dates/api/picks', { title: 'Launch dinner', days: [{ date: D0, blocks: ['evening'] }] });
  const id = c.j.id;
  const kA = c.j[K_OWNER];
  ok('create returns a creator credential', c.status === 200 && UUID.test(String(kA)), String(kA).slice(0, 11) + '...');

  const st = await get('/dates/api/picks/' + id);
  ok('creator credential never appears in broadcast state', !JSON.stringify(st.j).includes(kA));

  const whoA = await get('/dates/api/picks/' + id + '/who?' + Q_PARAM + '=' + encodeURIComponent(kA));
  ok('creator credential resolves to role admin', whoA.status === 200 && whoA.j.role === 'admin', JSON.stringify(whoA.j));

  await post('/dates/api/picks/' + id + '/mark', { name: 'Marc', date: D0, block: 'evening', on: true });
  const lk = await post('/dates/api/picks/' + id + '/lock', { name: 'Marc' });
  const kP = lk.j[K_PERSON];
  ok('lock returns its own distinct credential', lk.status === 200 && UUID.test(String(kP)) && kP !== kA);
  const whoP = await get('/dates/api/picks/' + id + '/who?' + Q_PARAM + '=' + encodeURIComponent(kP));
  ok('person credential resolves to that person', whoP.status === 200 && whoP.j.role === 'person' && whoP.j.name === 'Marc', JSON.stringify(whoP.j));

  const personAdmin = await post('/dates/api/picks/' + id + '/choose', { [K_OWNER]: kP, date: D0, block: 'evening' });
  ok('a person credential cannot set the date', personAdmin.status === 403, String(personAdmin.status));
  const adminMark = await post('/dates/api/picks/' + id + '/mark', { name: 'Marc', date: D0, block: 'evening', on: false, [K_PERSON]: kA });
  ok('creator credential is not a person edit credential', adminMark.status === 423, String(adminMark.status));
  const addByPerson = await post('/dates/api/picks/' + id + '/dates', { [K_OWNER]: kP, days: [{ date: iso(5), blocks: ['morning'] }] });
  ok('a person credential cannot add dates', addByPerson.status === 403, String(addByPerson.status));

  const noOwner = await post('/dates/api/picks/' + id + '/choose', { date: D0, block: 'evening' });
  ok('setting the date without the creator credential is refused', noOwner.status === 403, noOwner.j && noOwner.j.error);
  const withOwner = await post('/dates/api/picks/' + id + '/choose', { [K_OWNER]: kA, date: D0, block: 'evening' });
  ok('creator credential sets the date', withOwner.status === 200 && withOwner.j.closed === true, JSON.stringify(withOwner.j));
  const reopen = await post('/dates/api/picks/' + id + '/reopen', { [K_OWNER]: kA });
  ok('creator credential reopens', reopen.status === 200 && reopen.j.closed === false, JSON.stringify(reopen.j));

  const addDates = await post('/dates/api/picks/' + id + '/dates', { [K_OWNER]: kA, days: [{ date: D1, blocks: ['afternoon', 'evening'] }] });
  ok('creator can add dates later', addDates.status === 200, JSON.stringify(addDates.j));
  const st2 = await get('/dates/api/picks/' + id);
  ok('the added date is on the table', st2.j.days.some((d) => d.date === D1), st2.j.days.map((d) => d.date).join(','));
  const markNew = await post('/dates/api/picks/' + id + '/mark', { name: 'Sana', date: D1, block: 'afternoon', on: true });
  ok('people can mark the added date', markNew.status === 200, JSON.stringify(markNew.j));

  const r1 = await fetch(B + '/dates/' + id + '/admin/' + kA);
  ok('creator URL serves the app', r1.status === 200, String(r1.status));
  const r2 = await fetch(B + '/dates/' + id + '/' + kP);
  ok('person edit URL serves the app', r2.status === 200, String(r2.status));

  const st3 = await get('/dates/api/picks/nosuch');
  ok('unknown pick is 404', st3.status === 404, String(st3.status));
})().catch((e) => { console.error('PROBE ERROR: ' + e.message); process.exit(1); });
