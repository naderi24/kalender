/* Kalender: a small personal calendar in the style of the iPhone one.
   - Course timetable comes from data/schedule.json (all seminar groups); the user's group picks the right slot.
   - Own events, edits to course events and settings live in localStorage on the device.
   - ai.js adds the assistant (the user's own Anthropic API key). */
const VERSION = 'v1';
const LS = 'kalender-v1', LS_SCHED = 'kalender-schedule-v1';
const HOUR = 56;          /* px per hour in the timeline; keep in step with --hh in styles.css */
const SNAP = 15;          /* minutes */
const WD = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];
const REPEAT = { '': 'Aldrig', d: 'Varje dag', w: 'Varje vecka', '2w': 'Varannan vecka', m: 'Varje månad' };
const PALETTE = ['#007aff', '#ff2d55', '#34c759', '#ff9500', '#af52de', '#5ac8fa', '#a2845e', '#ffcc00'];

/* ---------- DOM ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

/* ---------- dates (all local time) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const toLocal = (d) => ymd(d) + 'T' + hm(d);
function fromLocal(s) {
  const [a, b = '00:00'] = String(s).split('T');
  const [y, m, d] = a.split('-').map(Number), [H, M] = b.split(':').map(Number);
  return new Date(y, m - 1, d, H || 0, M || 0);
}
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const addMin = (d, n) => new Date(d.getTime() + n * 60000);
const dayDiff = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 864e5);
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const mondayOf = (d) => addDays(dayStart(d), -((d.getDay() + 6) % 7));
const minOf = (d) => d.getHours() * 60 + d.getMinutes();
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const n = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - n); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y) / 864e5 + 1) / 7);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (d, o) => new Intl.DateTimeFormat('sv-SE', o).format(d);
const fmtDay = (d) => cap(fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }));
const fmtShort = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
const range = (n) => Array.from({ length: n }, (_, i) => i);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'e' + Math.random().toString(36).slice(2, 10);

/* ---------- state ---------- */
const blank = () => ({
  events: [],            /* {id,title,loc,notes,allDay,start,end,cal,rr:{f,until}|null,ex:[ymd],upd} or {id,del:true,upd} */
  over: {},              /* edits to course events: key -> {hidden} | {title,loc,notes,start,end,allDay} */
  cals: [{ id: 'privat', name: 'Privat', color: '#007aff' }, { id: 'plugg', name: 'Plugg', color: '#ff2d55' }],
  hidden: [],            /* calendar ids switched off */
  groups: {},            /* course id -> seminar group */
  onboarded: false, view: '', lastCal: 'privat', upd: 0,
});
function load() { try { const raw = localStorage.getItem(LS); if (raw) return Object.assign(blank(), JSON.parse(raw)); } catch (e) { /* private mode */ } return blank(); }
let state = load();
let schedule = null;
try { schedule = JSON.parse(localStorage.getItem(LS_SCHED) || 'null'); } catch (e) { /* ignore */ }
let courseCache = null, pristine = new Map();
function save() { state.upd = Date.now(); courseCache = null; try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) { /* ignore */ } }

const today = () => dayStart(new Date());
const ui = { date: today(), view: state.view || (matchMedia('(min-width: 900px)').matches ? 'week' : 'day'), scroll: null, occs: new Map() };

/* ---------- calendars ---------- */
function calendars() {
  const out = (schedule ? schedule.courses : []).map((c) => ({ id: 'c:' + c.id, name: c.code + ' ' + c.name, short: c.code, color: c.color, course: c }));
  return out.concat(state.cals.map((c) => ({ ...c, short: c.name })));
}
const calOf = (id) => calendars().find((c) => c.id === id) || { id, name: 'Kalender', short: '', color: '#8e8e93' };
const visible = (id) => !state.hidden.includes(id);

/* ---------- course events for the chosen groups ---------- */
function courseOccs() {
  if (courseCache) return courseCache;
  const out = []; pristine = new Map();
  for (const c of (schedule ? schedule.courses : [])) {
    const g = state.groups[c.id], calId = 'c:' + c.id;
    const add = (id, kind, title, start, end, room, notes, allDay, short) => {
      const key = c.id + ':' + id;
      const base = { key, src: 'course', calId, color: c.color, kind, title, loc: room || '', notes: notes || '', start, end, allDay: !!allDay, course: c.code, short: short ? c.code + ' ' + short : '' };
      pristine.set(key, base);
      const ov = state.over[key];
      if (ov && ov.hidden) return;
      const o = { ...base };
      if (ov) {
        o.changed = true;
        if (ov.title != null) o.title = ov.title;
        if (ov.loc != null) o.loc = ov.loc;
        if (ov.notes != null) o.notes = ov.notes;
        if (ov.start) { o.allDay = !!ov.allDay; o.start = fromLocal(ov.start); o.end = o.allDay ? addDays(fromLocal(ov.end), 1) : fromLocal(ov.end); }
      }
      out.push(o);
    };
    const deadline = (id, title, at, notes) => add(id, 'deadline', title, addMin(at, -30), at, '', notes);
    for (const e of c.events) {
      if (e.slots) {
        const s = e.slots[g]; if (!s) continue;
        const st = new Date(s.start);
        add(e.id, 'seminar', e.title, st, new Date(s.end), s.room, (s.teacher ? 'Lärare: ' + s.teacher + '\n' : '') + (e.note || ''), false, e.short);
        if (e.due) {
          let at;
          if (e.due.at) at = new Date(e.due.at);
          else { const [H, M] = e.due.dayBefore.split(':').map(Number); at = new Date(st.getFullYear(), st.getMonth(), st.getDate() - 1, H, M); }
          deadline(e.id + ':due', e.due.title, at, 'Lämnas in på Canvas före ' + hm(at) + '.');
        }
      } else if (e.allDay) {
        const d = fromLocal(e.allDay); add(e.id, e.kind, e.title, d, addDays(d, 1), '', e.note, true);
      } else if (e.kind === 'deadline') deadline(e.id, e.title, new Date(e.start), e.note);
      else add(e.id, e.kind, e.title, new Date(e.start), new Date(e.end || e.start), e.room, e.note, false, e.short);
    }
  }
  return (courseCache = out);
}

/* ---------- own events, with repeats expanded ---------- */
function occOf(ev, s, isOcc) {
  const s0 = fromLocal(ev.start), e0 = fromLocal(ev.end);
  let end = new Date(s.getFullYear(), s.getMonth(), s.getDate() + dayDiff(s0, e0), e0.getHours(), e0.getMinutes());
  if (ev.allDay) end = addDays(dayStart(end), 1);
  const cal = calOf(ev.cal);
  return { key: isOcc ? ev.id + '@' + ymd(s) : ev.id, id: ev.id, src: 'user', calId: ev.cal, color: cal.color, kind: 'event', title: ev.title, loc: ev.loc || '', notes: ev.notes || '',
    start: ev.allDay ? dayStart(s) : s, end, allDay: !!ev.allDay, rec: !!ev.rr, occ: isOcc ? ymd(s) : null };
}
function stepDate(s0, f, i) {
  if (f === 'm') { const d = new Date(s0.getFullYear(), s0.getMonth() + i, s0.getDate(), s0.getHours(), s0.getMinutes()); return d.getDate() === s0.getDate() ? d : null; }
  const n = f === 'd' ? 1 : f === '2w' ? 14 : 7;
  return new Date(s0.getFullYear(), s0.getMonth(), s0.getDate() + i * n, s0.getHours(), s0.getMinutes());
}
function userOccs(from, to) {
  const out = [];
  for (const ev of state.events) {
    if (ev.del) continue;
    const s0 = fromLocal(ev.start);
    if (!ev.rr) { const o = occOf(ev, s0, false); if (o.end > from && o.start < to) out.push(o); continue; }
    const until = ev.rr.until ? addDays(fromLocal(ev.rr.until), 1) : null;
    const stepDays = ev.rr.f === 'd' ? 1 : ev.rr.f === '2w' ? 14 : ev.rr.f === 'w' ? 7 : 0;
    let i = stepDays ? Math.max(0, Math.floor(dayDiff(s0, from) / stepDays) - 1 - Math.ceil(dayDiff(s0, fromLocal(ev.end)) / stepDays)) : 0;
    for (let guard = 0; guard < 4000; guard++, i++) {
      const s = stepDate(s0, ev.rr.f, i);
      if (!s) continue;
      if (s >= to || (until && s >= until)) break;
      if ((ev.ex || []).includes(ymd(s))) continue;
      const o = occOf(ev, s, true);
      if (o.end > from) out.push(o);
    }
  }
  return out;
}
function occurrences(from, to, all) {
  const list = courseOccs().filter((o) => o.end > from && o.start < to).concat(userOccs(from, to));
  return (all ? list : list.filter((o) => visible(o.calId))).sort((a, b) => a.start - b.start || b.end - a.end);
}
function findOcc(key) {
  key = String(key);
  if (key.includes(':')) return courseOccs().find((o) => o.key === key) || null;
  const [id, date] = key.split('@');
  const ev = state.events.find((x) => x.id === id && !x.del); if (!ev) return null;
  if (date) { const d = fromLocal(date); return userOccs(d, addDays(d, 1)).find((o) => o.key === key) || null; }
  return occOf(ev, fromLocal(ev.start), false);
}

/* ---------- changes ---------- */
const modelTimes = (v) => v.allDay
  ? { start: ymd(v.start) + 'T00:00', end: ymd(addDays(v.end, -1)) + 'T00:00' }
  : { start: toLocal(v.start), end: toLocal(v.end) };
function applyNew(v) {
  const ev = { id: uid(), title: v.title || 'Ny händelse', loc: v.loc || '', notes: v.notes || '', allDay: !!v.allDay, ...modelTimes(v),
    cal: state.cals.some((c) => c.id === v.cal) ? v.cal : 'privat', rr: v.rr || null, ex: [], upd: Date.now() };
  state.events.push(ev); state.lastCal = ev.cal; return ev.id;
}
/* scope: 'one' changes only this occurrence of a repeating event, 'all' the whole series */
function applyEdit(o, v, scope) {
  if (o.src === 'course') {
    const p = pristine.get(o.key); if (!p) return;
    const t = modelTimes(v), pt = modelTimes(p), ov = {};
    if (v.title !== p.title) ov.title = v.title;
    if ((v.loc || '') !== p.loc) ov.loc = v.loc || '';
    if ((v.notes || '') !== p.notes) ov.notes = v.notes || '';
    if (t.start !== pt.start || t.end !== pt.end || !!v.allDay !== p.allDay) { ov.start = t.start; ov.end = t.end; ov.allDay = !!v.allDay; }
    if (Object.keys(ov).length) state.over[o.key] = ov; else delete state.over[o.key];
    return;
  }
  const ev = state.events.find((x) => x.id === o.id); if (!ev) return;
  if (ev.rr && o.occ && scope === 'one') { ev.ex = (ev.ex || []).concat(o.occ); ev.upd = Date.now(); applyNew({ ...v, rr: null }); return; }
  ev.title = v.title || 'Ny händelse'; ev.loc = v.loc || ''; ev.notes = v.notes || ''; ev.allDay = !!v.allDay;
  if (state.cals.some((c) => c.id === v.cal)) ev.cal = v.cal;
  const rr = v.rr === undefined ? ev.rr : v.rr;
  if (ev.rr && rr && o.occ) {   /* move the whole series by as much as this occurrence moved */
    const bs = fromLocal(ev.start);
    const ns = new Date(bs.getFullYear(), bs.getMonth(), bs.getDate() + dayDiff(o.start, v.start), v.start.getHours(), v.start.getMinutes());
    const ne = new Date(ns.getFullYear(), ns.getMonth(), ns.getDate() + dayDiff(v.start, v.end), v.end.getHours(), v.end.getMinutes());
    Object.assign(ev, modelTimes({ allDay: v.allDay, start: ns, end: ne }));
  } else Object.assign(ev, modelTimes(v));
  ev.rr = rr || null; ev.upd = Date.now();
}
function applyDelete(o, scope) {
  if (o.src === 'course') { state.over[o.key] = { hidden: true }; return; }
  const i = state.events.findIndex((x) => x.id === o.id); if (i < 0) return;
  const ev = state.events[i];
  if (ev.rr && o.occ && scope === 'one') { ev.ex = (ev.ex || []).concat(o.occ); ev.upd = Date.now(); }
  else state.events[i] = { id: ev.id, del: true, upd: Date.now() };
}
const snapshot = () => JSON.stringify(state);
function restore(snap) { state = JSON.parse(snap); save(); render(); }
function mutate(fn, msg) {
  const snap = snapshot(); fn(); save(); render();
  if (msg) toast(msg, 'Ångra', () => restore(snap));
}
function moveOcc(o, ns, ne) {
  if (+ns === +o.start && +ne === +o.end) return;
  mutate(() => applyEdit(o, { title: o.title, loc: o.loc, notes: o.notes, allDay: o.allDay, start: ns, end: ne, cal: o.calId, rr: o.rec ? null : undefined }, 'one'),
    'Flyttad till ' + fmtShort(ns) + (o.allDay ? '' : ' ' + hm(o.kind === 'deadline' ? ne : ns)));
}

/* free time between `from` and `to` (dates), inside the hours given, at least `minMin` long */
function freeSlots(from, to, minMin, dayFrom, dayTo, weekends) {
  const out = [], now = new Date();
  const [fh, fm] = (dayFrom || '08:00').split(':').map(Number), [th, tm] = (dayTo || '21:00').split(':').map(Number);
  for (let d = dayStart(from); d <= to && out.length < 80; d = addDays(d, 1)) {
    if (weekends === false && (d.getDay() === 0 || d.getDay() === 6)) continue;
    let a = new Date(d.getFullYear(), d.getMonth(), d.getDate(), fh, fm); const b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), th, tm);
    if (a < now) a = new Date(Math.ceil(now.getTime() / 9e5) * 9e5);
    const busy = occurrences(a, b).filter((o) => !o.allDay && o.kind !== 'deadline');
    let cur = a;
    for (const o of busy) { if (o.start - cur >= minMin * 6e4) out.push({ start: cur, end: o.start }); if (o.end > cur) cur = o.end; }
    if (b - cur >= minMin * 6e4) out.push({ start: cur, end: b });
  }
  return out;
}

/* ---------- toast ---------- */
let toastT = null;
function toast(msg, action, fn) {
  const box = $('#toast'); box.innerHTML = '';
  const el = h('div', { class: 'toast' }, h('span', null, msg), action && h('button', { type: 'button', onclick: () => { box.innerHTML = ''; fn(); } }, action));
  box.append(el); clearTimeout(toastT); toastT = setTimeout(() => { if (el.isConnected) el.remove(); }, action ? 6000 : 3000);
}

/* ---------- sheets ---------- */
const openSheets = [];
function sheet({ title, left, right, body, cls }) {
  const wrap = h('div', { class: 'sheet-wrap ' + (cls || '') });
  const api = { wrap, close() { const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1); wrap.classList.add('out'); setTimeout(() => wrap.remove(), 240); } };
  const btn = (b, side) => b ? h('button', { type: 'button', class: 'bar-btn ' + side + (b.strong ? ' strong' : ''), onclick: () => b.fn(api) }, b.label) : h('span', { class: 'bar-btn ' + side });
  api.el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-bar' }, btn(left, 'l'), h('b', null, title), btn(right, 'r')),
    h('div', { class: 'sheet-body' }, body));
  wrap.append(api.el);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) api.close(); });
  $('#sheets').append(wrap); openSheets.push(api); $('#toast').innerHTML = '';
  return api;
}
function choose(title, options) {
  return new Promise((res) => {
    const wrap = h('div', { class: 'sheet-wrap choose' });
    const done = (v) => { wrap.remove(); res(v); };
    wrap.append(h('div', { class: 'choose-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'choose-grp' }, h('p', null, title),
        options.map((o, i) => h('button', { type: 'button', class: o.danger ? 'danger' : '', onclick: () => done(i) }, o.label || o))),
      h('button', { type: 'button', class: 'choose-cancel', onclick: () => done(null) }, 'Avbryt')));
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
    $('#sheets').append(wrap);
  });
}
const grp = (label, ...rows) => h('div', { class: 'grp' }, label && h('div', { class: 'grp-l' }, label), h('div', { class: 'grp-c' }, rows));
const row = (label, ...ctl) => h('label', { class: 'row' }, label && h('span', { class: 'row-l' }, label), ctl);

/* ---------- editor ---------- */
function openEditor(o) {
  const isNew = o.src === 'new', course = o.src === 'course';
  const ev = !isNew && !course ? state.events.find((x) => x.id === o.id) : null;
  let dur = o.end - o.start;
  const lastDay = o.allDay ? addDays(o.end, -1) : o.end;
  const title = h('input', { type: 'text', class: 'in', placeholder: 'Titel', value: o.title || '', enterkeyhint: 'done' });
  const loc = h('input', { type: 'text', class: 'in', placeholder: 'Plats', value: o.loc || '' });
  const allDay = h('input', { type: 'checkbox', class: 'sw', checked: !!o.allDay });
  const sd = h('input', { type: 'date', class: 'pill', value: ymd(o.start) }), st = h('input', { type: 'time', class: 'pill', step: 300, value: hm(o.start) });
  const ed = h('input', { type: 'date', class: 'pill', value: ymd(lastDay) }), et = h('input', { type: 'time', class: 'pill', step: 300, value: hm(o.end) });
  const notes = h('textarea', { class: 'in', rows: 4, placeholder: 'Anteckningar' }); notes.value = o.notes || '';
  const rep = h('select', { class: 'pick' }, Object.keys(REPEAT).map((k) => h('option', { value: k }, REPEAT[k]))); rep.value = (ev && ev.rr && ev.rr.f) || '';
  const until = h('input', { type: 'date', class: 'pill', value: (ev && ev.rr && ev.rr.until) || '' });
  const cal = h('select', { class: 'pick' }, state.cals.map((c) => h('option', { value: c.id }, c.name))); cal.value = isNew ? (o.calId || state.lastCal || 'privat') : o.calId;
  const untilRow = row('Sluta upprepa', until);
  const read = () => {
    const a = allDay.checked;
    const s = fromLocal(sd.value + (a ? '' : 'T' + (st.value || '09:00')));
    let e = fromLocal((ed.value || sd.value) + (a ? '' : 'T' + (et.value || '10:00')));
    if (a) e = addDays(e, 1);
    return { s, e };
  };
  const sync = () => { st.hidden = et.hidden = allDay.checked; untilRow.hidden = !rep.value; };
  const startChanged = () => { if (!sd.value) return; const { s } = read(); const e = new Date(s.getTime() + dur); const last = allDay.checked ? addDays(e, -1) : e; ed.value = ymd(last); et.value = hm(e); };
  const endChanged = () => { const { s, e } = read(); if (e > s) dur = e - s; };
  sd.addEventListener('change', startChanged); st.addEventListener('change', startChanged);
  ed.addEventListener('change', endChanged); et.addEventListener('change', endChanged);
  allDay.addEventListener('change', () => { sync(); dur = allDay.checked ? 864e5 * Math.max(1, dayDiff(fromLocal(sd.value), fromLocal(ed.value || sd.value)) + 1) : 36e5; if (!allDay.checked) startChanged(); });
  rep.addEventListener('change', sync);

  const c = calOf(o.calId);
  const body = [
    course && h('div', { class: 'ed-src' }, h('i', { style: '--c:' + c.color }), h('span', null, c.name + (o.changed ? ' · ändrad' : ''))),
    grp(null, row(null, title), row(null, loc)),
    grp(null, row('Heldag', allDay), row('Börjar', sd, st), row('Slutar', ed, et), !course && row('Upprepa', rep), !course && untilRow),
    !course && grp(null, row('Kalender', cal)),
    grp(null, row(null, notes)),
    course && o.changed && h('button', { type: 'button', class: 'big-btn', onclick: () => { s.close(); mutate(() => { delete state.over[o.key]; }, 'Återställd till schemat'); } }, 'Återställ till schemat'),
    !isNew && h('button', { type: 'button', class: 'big-btn danger', onclick: del }, course ? 'Dölj händelsen' : 'Radera händelsen'),
  ];
  async function del() {
    let scope = 'all';
    if (o.rec && o.occ) {
      const i = await choose('Den här händelsen upprepas.', [{ label: 'Radera bara den här', danger: true }, { label: 'Radera alla', danger: true }]);
      if (i == null) return; scope = i === 0 ? 'one' : 'all';
    }
    s.close(); mutate(() => applyDelete(o, scope), course ? 'Händelsen dold' : 'Händelsen raderad');
  }
  async function done() {
    if (!sd.value) { toast('Välj ett startdatum'); return; }
    const { s: ns, e } = read(); let ne = e;
    if (ne <= ns) ne = allDay.checked ? addDays(ns, 1) : addMin(ns, 60);
    const v = { title: title.value.trim() || (isNew ? 'Ny händelse' : o.title), loc: loc.value.trim(), notes: notes.value.trim(), allDay: allDay.checked, start: ns, end: ne,
      cal: cal.value, rr: course ? undefined : rep.value ? { f: rep.value, until: until.value || null } : null };
    let scope = 'all';
    if (!isNew && o.rec && o.occ) {
      const i = await choose('Den här händelsen upprepas.', ['Spara bara för den här', 'Spara för alla']);
      if (i == null) return; scope = i === 0 ? 'one' : 'all';
    }
    s.close();
    mutate(() => { if (isNew) applyNew(v); else applyEdit(o, v, scope); });
    if (isNew && !visible(v.cal)) toast('Kalendern ”' + calOf(v.cal).name + '” är dold');
  }
  const s = sheet({ title: isNew ? 'Ny händelse' : course ? 'Schemahändelse' : 'Ändra händelse', cls: 'editor',
    left: { label: 'Avbryt', fn: (x) => x.close() }, right: { label: isNew ? 'Lägg till' : 'Klar', strong: true, fn: done }, body });
  sync();
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
  if (isNew) setTimeout(() => title.focus(), 60);
}
function newEventAt(start, allDay) {
  const s = start || (() => { const n = new Date(); return sameDay(ui.date, n) ? new Date(n.getFullYear(), n.getMonth(), n.getDate(), Math.min(23, n.getHours() + 1)) : new Date(ui.date.getFullYear(), ui.date.getMonth(), ui.date.getDate(), 9); })();
  openEditor({ src: 'new', title: '', start: allDay ? dayStart(s) : s, end: allDay ? addDays(dayStart(s), 1) : addMin(s, 60), allDay: !!allDay, calId: state.lastCal });
}

/* ---------- timeline (day and week) ---------- */
function layoutDay(segs) {
  segs.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = 0;
  const flush = () => { const n = Math.max(...cluster.map((x) => x.col)) + 1; cluster.forEach((x) => { x.cols = n; }); cluster = []; };
  for (const sg of segs) {
    if (cluster.length && sg.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((x) => x.e > sg.s).map((x) => x.col));
    let col = 0; while (used.has(col)) col++;
    sg.col = col; cluster.push(sg); clusterEnd = Math.max(clusterEnd, sg.e);
  }
  if (cluster.length) flush();
  return segs;
}
const subOf = (o) => [o.loc, o.course].filter(Boolean).join(' · ');
function evBlock(o, sg) {
  const top = sg.s / 60 * HOUR, height = Math.max(20, (sg.e - sg.s) / 60 * HOUR - 2);
  const time = o.kind === 'deadline' ? 'senast ' + hm(o.end) : hm(o.start) + '–' + hm(o.end);
  const el = h('div', { class: 'ev' + (o.kind === 'deadline' ? ' dl' : '') + (height < 34 ? ' tiny' : ''), tabindex: 0, role: 'button', 'aria-label': o.title + ', ' + time,
    style: `--c:${o.color};top:${top}px;height:${height}px;left:calc(${sg.col / sg.cols * 100}% + 1px);width:calc(${100 / sg.cols}% - 3px)` },
    h('b', { 'data-short': !o.changed && o.short || o.title }, o.title), h('span', { class: 'ev-sub' }, o.kind === 'deadline' ? hm(o.end) : subOf(o)), height >= 64 && o.kind !== 'deadline' && h('span', { class: 'ev-time' }, time),
    sg.whole && h('i', { class: 'rz' }));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(o); } });
  bindDrag(el, o, sg.whole);
  return el;
}
function renderTimeline(view) {
  const week = ui.view === 'week', mon = mondayOf(ui.date), now = new Date();
  const days = week ? range(7).map((i) => addDays(mon, i)) : [ui.date];
  const occs = occurrences(days[0], addDays(days[days.length - 1], 1));
  ui.occs = new Map(occs.map((o) => [o.key, o]));
  const old = $('.tl-scroll'); if (old) ui.scroll = old.scrollTop;

  const strip = h('div', { class: 'strip' }, h('div', { class: 'wk' }, 'v' + isoWeek(mon)),
    range(7).map((i) => { const d = addDays(mon, i);
      return h('button', { type: 'button', class: 'sd' + (sameDay(d, now) ? ' today' : '') + (!week && sameDay(d, ui.date) ? ' sel' : ''), 'aria-label': fmtDay(d),
        onclick: () => { ui.date = d; if (week) ui.view = 'day'; render(); } }, h('span', { class: 'sd-w' }, WD[i]), h('span', { class: 'sd-n' }, d.getDate())); }));

  const allDayOf = (d) => occs.filter((o) => o.allDay && o.start < addDays(d, 1) && o.end > d);
  const hasAllDay = days.some((d) => allDayOf(d).length);
  const allday = h('div', { class: 'allday' + (hasAllDay ? '' : ' empty') }, h('div', { class: 'ad-l' }, hasAllDay ? 'heldag' : ''),
    days.map((d) => h('div', { class: 'ad-col' }, allDayOf(d).map((o) => h('button', { type: 'button', class: 'chip', style: '--c:' + o.color, onclick: () => openEditor(o) }, o.title)))));

  const grid = h('div', { class: 'tl-grid' });
  for (let hr = 0; hr <= 24; hr++) grid.append(h('div', { class: 'hr', style: `top:${hr * HOUR}px` }, hr > 0 && hr < 24 && h('span', null, pad(hr) + ':00')));
  const cols = h('div', { class: 'tl-cols' });
  for (const d of days) {
    const d1 = addDays(d, 1);
    const col = h('div', { class: 'tl-col' + (sameDay(d, now) ? ' today' : ''), 'data-date': ymd(d) });
    const createAt = (y) => {
      const min = Math.floor(((y - col.getBoundingClientRect().top) / HOUR * 60) / 30) * 30;
      newEventAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, clamp(min, 0, 23 * 60)));
    };
    /* mouse: click an empty time; touch: press and hold it (a plain tap does nothing, as on the phone's own calendar) */
    col.addEventListener('click', (e) => { if (e.target === col && Date.now() - dragEndedAt > 350 && Date.now() - lastTouch > 800) createAt(e.clientY); });
    let hold = null, hp = null;
    col.addEventListener('touchstart', (e) => {
      lastTouch = Date.now(); clearTimeout(hold);
      if (e.target !== col || e.touches.length !== 1) return;
      hp = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      hold = setTimeout(() => { if (navigator.vibrate) navigator.vibrate(8); createAt(hp.y); }, 480);
    }, { passive: true });
    col.addEventListener('touchmove', (e) => { if (hp && Math.hypot(e.touches[0].clientX - hp.x, e.touches[0].clientY - hp.y) > 8) clearTimeout(hold); }, { passive: true });
    col.addEventListener('touchend', () => { lastTouch = Date.now(); clearTimeout(hold); }, { passive: true });
    col.addEventListener('touchcancel', () => clearTimeout(hold), { passive: true });
    const segs = occs.filter((o) => !o.allDay && o.start < d1 && o.end > d).map((o) => ({ o, s: o.start < d ? 0 : minOf(o.start), e: o.end >= d1 ? 1440 : Math.max(minOf(o.end), minOf(o.start) + 15), whole: o.start >= d && o.end <= d1 }));
    for (const sg of layoutDay(segs)) col.append(evBlock(sg.o, sg));
    cols.append(col);
  }
  grid.append(cols, h('div', { class: 'now', hidden: true }, h('span')));
  const scroller = h('div', { class: 'tl-scroll' }, grid);
  view.append(h('div', { class: 'tl ' + (week ? 'week' : 'day') }, strip, !week && h('div', { class: 'dayline' }, fmtDay(ui.date) + ' ' + ui.date.getFullYear()), allday, scroller));
  scroller.scrollTop = ui.scroll != null ? ui.scroll : Math.max(0, (Math.min(minOf(now), 17 * 60) - 90) / 60 * HOUR);
  ui.scroll = scroller.scrollTop;
  updateNow();
}
function updateNow() {
  const line = $('.now'); if (!line) return;
  const col = $('.tl-col.today'), now = new Date();
  line.hidden = !col; if (!col) return;
  line.style.top = minOf(now) / 60 * HOUR + 'px';
  line.firstChild.textContent = hm(now);
  const gr = col.parentNode.getBoundingClientRect(), cr = col.getBoundingClientRect();
  line.style.setProperty('--x', cr.left - gr.left + 'px'); line.style.setProperty('--w', cr.width + 'px');
}

/* ---------- drag to move, drag the lower edge to change the length ---------- */
let drag = null, dragEndedAt = 0, lastTouch = 0;
function beginDrag(o, el, x, y, mode) {
  const r = el.getBoundingClientRect();
  drag = { o, el, mode, home: el.parentNode, col: el.parentNode, offY: y - r.top, startMin: minOf(o.start), dur: Math.round((o.end - o.start) / 6e4), css: el.style.cssText, min: null, end: null };
  el.classList.add('dragging'); document.body.classList.add('is-dragging');
  drag.label = h('span', { class: 'ev-drag' }); el.append(drag.label);
}
function moveDrag(x, y) {
  const d = drag, scroller = $('.tl-scroll'); if (!d || !scroller) return;
  const cols = [...document.querySelectorAll('.tl-col')];
  if (d.mode === 'move') {
    const col = cols.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; }) || d.col;
    const top = col.getBoundingClientRect().top;
    d.min = clamp(Math.round(((y - d.offY - top) / HOUR * 60) / SNAP) * SNAP, 0, 1440 - SNAP);
    if (d.el.parentNode !== col) col.append(d.el);
    d.col = col;
    d.el.style.top = d.min / 60 * HOUR + 'px'; d.el.style.left = '1px'; d.el.style.width = 'calc(100% - 3px)';
    d.label.textContent = d.o.kind === 'deadline' ? 'senast ' + mm(d.min + d.dur) : mm(d.min) + '–' + mm(d.min + d.dur);
  } else {
    const top = d.col.getBoundingClientRect().top;
    d.end = clamp(Math.round(((y - top) / HOUR * 60) / SNAP) * SNAP, d.startMin + SNAP, 1440);
    d.el.style.height = (d.end - d.startMin) / 60 * HOUR - 2 + 'px';
    d.label.textContent = mm(d.startMin) + '–' + mm(d.end);
  }
  const sr = scroller.getBoundingClientRect();
  if (y < sr.top + 36) scroller.scrollTop -= 10; else if (y > sr.bottom - 36) scroller.scrollTop += 10;
}
const mm = (m) => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
function endDrag(cancel) {
  const d = drag; if (!d) return; drag = null; dragEndedAt = Date.now();
  document.body.classList.remove('is-dragging'); d.el.classList.remove('dragging'); d.label.remove();
  const day = fromLocal(d.col.getAttribute('data-date'));
  let ns = d.o.start, ne = d.o.end;
  if (!cancel && d.mode === 'move' && d.min != null) { ns = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, d.min); ne = addMin(ns, d.dur); }
  if (!cancel && d.mode === 'resize' && d.end != null) ne = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, d.end);
  if (+ns === +d.o.start && +ne === +d.o.end) { if (d.el.parentNode !== d.home) d.home.append(d.el); d.el.style.cssText = d.css; return; }
  moveOcc(d.o, ns, ne);
}
function bindDrag(el, o, whole) {
  /* mouse: drag straight away; a plain click opens the event */
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY, mode = e.target.classList.contains('rz') ? 'resize' : 'move';
    let started = false;
    const move = (m) => {
      if (!started) { if (!whole || Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return; started = true; beginDrag(o, el, x0, y0, mode); }
      m.preventDefault(); moveDrag(m.clientX, m.clientY);
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (started) endDrag(false); else openEditor(o); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  /* touch: hold to pick up, then drag; a tap opens the event; a swipe scrolls as usual */
  let timer = null, t0 = null, held = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY, moved: false }; held = false;
    clearTimeout(timer);
    if (whole) timer = setTimeout(() => { held = true; beginDrag(o, el, t0.x, t0.y, 'move'); if (navigator.vibrate) navigator.vibrate(8); }, 380);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t0) return;
    if (held) { e.preventDefault(); moveDrag(t.clientX, t.clientY); return; }
    if (Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 8) { t0.moved = true; clearTimeout(timer); }
  }, { passive: false });
  const finish = (e, cancel) => {
    clearTimeout(timer);
    if (held) { e.preventDefault(); held = false; endDrag(cancel); }
    else if (t0 && !t0.moved && !cancel) { e.preventDefault(); openEditor(o); }
    t0 = null;
  };
  el.addEventListener('touchend', (e) => finish(e, false), { passive: false });
  el.addEventListener('touchcancel', (e) => finish(e, true), { passive: false });
}

/* ---------- month ---------- */
function agendaRow(o, day) {
  const d1 = day ? addDays(day, 1) : null;
  const t = o.allDay ? ['heldag', ''] : o.kind === 'deadline' ? ['senast', hm(o.end)]
    : [day && o.start < day ? '00:00' : hm(o.start), day && o.end > d1 ? '24:00' : hm(o.end)];
  return h('button', { type: 'button', class: 'ag', style: '--c:' + o.color, onclick: () => openEditor(o) },
    h('span', { class: 'ag-t' }, h('b', null, t[0]), h('span', null, t[1])), h('i'),
    h('span', { class: 'ag-m' }, h('b', null, o.title), h('span', null, subOf(o) || calOf(o.calId).short)));
}
function renderMonth(view) {
  const first = new Date(ui.date.getFullYear(), ui.date.getMonth(), 1), start = mondayOf(first), now = new Date();
  const weeks = Math.ceil((dayDiff(start, new Date(first.getFullYear(), first.getMonth() + 1, 0)) + 1) / 7);
  const occs = occurrences(start, addDays(start, weeks * 7));
  ui.occs = new Map(occs.map((o) => [o.key, o]));
  const of = (d) => occs.filter((o) => o.start < addDays(d, 1) && o.end > d);
  const grid = h('div', { class: 'mv-grid', style: `--rows:${weeks}` });
  for (let w = 0; w < weeks; w++) {
    grid.append(h('div', { class: 'mv-wk' }, isoWeek(addDays(start, w * 7))));
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, w * 7 + i), list = of(d);
      const cell = h('button', { type: 'button', 'data-date': ymd(d), 'aria-label': fmtDay(d) + (list.length ? ', ' + list.length + ' händelser' : ''),
        class: 'mv-day' + (d.getMonth() !== first.getMonth() ? ' out' : '') + (sameDay(d, now) ? ' today' : '') + (sameDay(d, ui.date) ? ' sel' : ''),
        onclick: () => { ui.date = d; render(); }, ondblclick: () => newEventAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9)) },
        h('span', { class: 'n' }, d.getDate()),
        h('span', { class: 'dots' }, [...new Set(list.map((o) => o.color))].slice(0, 4).map((c) => h('i', { style: '--c:' + c }))),
        h('span', { class: 'chips' }, list.slice(0, 3).map((o) => {
          const chip = h('span', { class: 'chip' + (o.allDay ? ' solid' : ''), style: '--c:' + o.color, draggable: 'true', 'data-key': o.key }, !o.allDay && h('em', null, hm(o.kind === 'deadline' ? o.end : o.start)), o.title);
          chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', o.key); e.dataTransfer.effectAllowed = 'move'; });
          chip.addEventListener('click', (e) => { e.stopPropagation(); openEditor(o); });
          return chip; }), list.length > 3 && h('span', { class: 'more' }, '+' + (list.length - 3) + ' till')));
      cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
      cell.addEventListener('drop', (e) => {
        e.preventDefault(); cell.classList.remove('drop');
        const o = ui.occs.get(e.dataTransfer.getData('text/plain')); if (!o) return;
        const dd = dayDiff(o.start, d); if (dd) moveOcc(o, addDays(o.start, dd), addDays(o.end, dd));
      });
      grid.append(cell);
    }
  }
  const list = of(ui.date);
  view.append(h('div', { class: 'mv' },
    h('div', { class: 'mv-cal' }, h('div', { class: 'mv-head' }, h('span'), WD.map((w) => h('span', null, w))), grid),
    h('div', { class: 'mv-list' },
      h('div', { class: 'mv-list-h' }, h('b', null, fmtDay(ui.date)), h('button', { type: 'button', class: 'ib small', 'aria-label': 'Ny händelse den här dagen', html: svg('<path d="M12 5v14M5 12h14"/>'), onclick: () => newEventAt() })),
      list.length ? list.map((o) => agendaRow(o, ui.date)) : h('p', { class: 'empty' }, 'Inga händelser'))));
}

/* ---------- frame ---------- */
function render() {
  const view = $('#view');
  const keep = $('.tl-scroll'); if (keep) ui.scroll = keep.scrollTop;
  view.innerHTML = '';
  $('#title').innerHTML = cap(fmt(ui.date, { month: 'long' })) + ' <span>' + ui.date.getFullYear() + '</span>';
  document.querySelectorAll('#seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === ui.view)));
  $('#today').disabled = ui.view === 'week' ? sameDay(mondayOf(ui.date), mondayOf(new Date())) : sameDay(ui.date, new Date());
  if (ui.view === 'month') renderMonth(view); else renderTimeline(view);
  if (state.view !== ui.view) { state.view = ui.view; try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) { /* ignore */ } }
}
function go(dir) {
  const d = ui.date;
  if (ui.view === 'month') { const last = new Date(d.getFullYear(), d.getMonth() + dir + 1, 0).getDate(); ui.date = new Date(d.getFullYear(), d.getMonth() + dir, Math.min(d.getDate(), last)); }
  else ui.date = addDays(d, dir * (ui.view === 'week' ? 7 : 1));
  render();
}

/* ---------- calendars and settings ---------- */
function openCalendars() {
  const body = h('div');
  const s = sheet({ title: 'Kalendrar', right: { label: 'Klar', strong: true, fn: (x) => x.close() }, body });
  const check = (c) => h('button', { type: 'button', class: 'cal-check', role: 'checkbox', 'aria-checked': String(visible(c.id)), 'aria-label': 'Visa ' + c.name, style: '--c:' + c.color,
    onclick: () => { state.hidden = visible(c.id) ? state.hidden.concat(c.id) : state.hidden.filter((x) => x !== c.id); save(); render(); draw(); } });
  function draw() {
    const all = calendars(), courses = all.filter((c) => c.course), mine = all.filter((c) => !c.course);
    const nOver = Object.keys(state.over).length;
    let aiKey = ''; try { aiKey = localStorage.getItem('kalender-ai-key') || ''; } catch (e) { /* ignore */ }
    const keyIn = h('input', { type: 'password', class: 'in', placeholder: 'sk-ant-…', autocomplete: 'off', value: aiKey, 'aria-label': 'Anthropic API-nyckel' });
    keyIn.addEventListener('change', () => { try { const v = keyIn.value.trim(); if (v) localStorage.setItem('kalender-ai-key', v); else localStorage.removeItem('kalender-ai-key'); toast(v ? 'Nyckeln sparad på den här enheten' : 'Nyckeln borttagen'); } catch (e) { /* ignore */ } });
    body.replaceChildren(...[
      grp('SSE-schema', courses.map((c) => h('div', { class: 'row' }, check(c), h('span', { class: 'row-l grow' }, c.name),
        c.course.groups ? (() => { const sel = h('select', { class: 'pick', 'aria-label': 'Seminariegrupp i ' + c.short }, h('option', { value: '' }, 'Ingen grupp'), range(c.course.groups).map((i) => h('option', { value: i + 1 }, 'Grupp ' + (i + 1))));
          sel.value = state.groups[c.course.id] || ''; sel.addEventListener('change', () => { if (sel.value) state.groups[c.course.id] = +sel.value; else delete state.groups[c.course.id]; save(); render(); }); return sel; })() : null))),
      h('p', { class: 'note' }, schedule ? 'Schemat kommer från ' + schedule.source + '. Seminarier visas för din grupp. Canvas gäller om något har ändrats.' : 'Schemat kunde inte laddas. Kontrollera uppkopplingen.'),
      nOver ? h('button', { type: 'button', class: 'big-btn', onclick: () => mutate(() => { state.over = {}; }, 'Schemat återställt') || draw() }, 'Återställ ' + nOver + (nOver === 1 ? ' ändrad schemahändelse' : ' ändrade schemahändelser')) : null,
      grp('Mina kalendrar', mine.map((c) => h('div', { class: 'row' }, check(c), h('span', { class: 'row-l grow' }, c.name),
        state.cals.length > 1 && !state.events.some((e) => e.cal === c.id && !e.del) ? h('button', { type: 'button', class: 'link danger', onclick: () => { state.cals = state.cals.filter((x) => x.id !== c.id); save(); render(); draw(); } }, 'Ta bort') : null)),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: () => {
          const name = (prompt('Vad ska kalendern heta?') || '').trim(); if (!name) return;
          state.cals.push({ id: 'k' + uid(), name: name.slice(0, 30), color: PALETTE.find((p) => !calendars().some((c) => c.color === p)) || PALETTE[state.cals.length % PALETTE.length] }); save(); draw(); } }, 'Lägg till kalender'))),
      grp('AI-assistent', row(null, keyIn)),
      h('p', { class: 'note' }, 'Assistenten använder din egen nyckel från console.anthropic.com. Den sparas bara på den här enheten och skickas bara till Anthropic.'),
      grp('Säkerhetskopia', h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: exportData }, 'Exportera mina händelser')),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: importData }, 'Importera från fil'))),
      h('p', { class: 'note' }, 'Dina egna händelser sparas på den här enheten. Kalender ' + VERSION + (schedule ? ' · schema ' + schedule.version : ''))].filter(Boolean));
  }
  draw();
  return s;
}
function exportData() {
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' })), download: 'kalender-' + ymd(new Date()) + '.json' });
  document.body.append(a); a.click(); a.remove();
}
function importData() {
  const inp = h('input', { type: 'file', accept: 'application/json,.json' });
  inp.addEventListener('change', async () => {
    try {
      const j = JSON.parse(await inp.files[0].text());
      if (!Array.isArray(j.events) || !Array.isArray(j.cals)) throw new Error('fel format');
      const n = j.events.filter((e) => !e.del).length;
      const i = await choose('Ersätta allt på den här enheten med filens ' + n + ' händelser?', [{ label: 'Ersätt', danger: true }]);
      if (i !== 0) return;
      const snap = snapshot(); state = Object.assign(blank(), j); save(); render();
      toast('Importerat', 'Ångra', () => restore(snap));
    } catch (e) { toast('Filen gick inte att läsa'); }
  });
  inp.click();
}

/* ---------- search ---------- */
function openSearch() {
  const inp = h('input', { type: 'search', class: 'in search-in', placeholder: 'Sök i händelser', enterkeyhint: 'search' });
  const res = h('div', { class: 'search-res' });
  const s = sheet({ title: 'Sök', right: { label: 'Klar', strong: true, fn: (x) => x.close() }, body: [grp(null, row(null, inp)), res], cls: 'tall' });
  const all = occurrences(addDays(today(), -200), addDays(today(), 400));
  const draw = () => {
    const q = inp.value.trim().toLowerCase(); res.innerHTML = '';
    if (!q) { res.append(h('p', { class: 'empty' }, 'Sök på titel, plats eller anteckning')); return; }
    const hits = all.filter((o) => (o.title + ' ' + o.loc + ' ' + o.notes + ' ' + (o.course || '')).toLowerCase().includes(q));
    const first = hits.findIndex((o) => o.end >= new Date());
    const shown = hits.slice(Math.max(0, (first < 0 ? hits.length : first) - 5)).slice(0, 60);
    if (!shown.length) { res.append(h('p', { class: 'empty' }, 'Inga träffar')); return; }
    let last = '';
    for (const o of shown) {
      const k = ymd(o.start); if (k !== last) { last = k; res.append(h('div', { class: 'grp-l' }, fmtDay(o.start) + (o.start.getFullYear() !== new Date().getFullYear() ? ' ' + o.start.getFullYear() : ''))); }
      const r = agendaRow(o); r.addEventListener('click', () => { ui.date = dayStart(o.start); s.close(); render(); }, true); res.append(r);
    }
  };
  inp.addEventListener('input', draw); draw(); setTimeout(() => inp.focus(), 60);
}

/* ---------- first run ---------- */
function onboard() {
  if (state.onboarded || !schedule || openSheets.length) return;
  const pick = (g) => { for (const c of schedule.courses) if (c.groups) { if (g) state.groups[c.id] = g; } state.onboarded = true; save(); s.close(); render(); if (g) toast('Grupp ' + g + ' vald. Ändra per kurs under Kalendrar.'); };
  const s = sheet({ title: 'Välkommen', right: { label: 'Hoppa över', fn: () => pick(0) }, body: [
    h('p', { class: 'lead' }, 'Vilken seminariegrupp går du i?'),
    h('p', { class: 'note center' }, 'Då hämtas rätt tid och sal för dina seminarier i ' + schedule.courses.filter((c) => c.groups).map((c) => c.code).join(', ') + '.'),
    h('div', { class: 'gp' }, range(8).map((i) => h('button', { type: 'button', onclick: () => pick(i + 1) }, i + 1)))] });
}

/* ---------- assistant ---------- */
const api = {
  h, sheet, grp, row, toast, render, save, snapshot, restore, calendars, calOf, findOcc, freeSlots, applyNew, applyEdit, applyDelete,
  occurrences, fromLocal, toLocal, ymd, hm, addDays, dayStart, fmtDay, fmtShort, openCalendars,
  get state() { return state; }, get ui() { return ui; },
};
window.kalender = api;   /* handy in the browser console */
async function openAI() {
  try { const m = await import('./ai.js'); m.openAssistant(api); }
  catch (e) { console.error(e); toast('Assistenten kunde inte laddas'); }
}

/* ---------- wiring ---------- */
$('#seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; ui.view = b.dataset.view; render(); });
$('#prev').addEventListener('click', () => go(-1));
$('#next').addEventListener('click', () => go(1));
$('#today').addEventListener('click', () => { ui.date = today(); ui.scroll = null; render(); });
$('#add').addEventListener('click', () => newEventAt());
$('#cals').addEventListener('click', openCalendars);
$('#search').addEventListener('click', openSearch);
$('#ai').addEventListener('click', openAI);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (drag) endDrag(true); else if (openSheets.length) openSheets[openSheets.length - 1].close(); return; }
  if (openSheets.length || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 't') $('#today').click(); else if (e.key === 'n') newEventAt();
  else if (e.key === 'd' || e.key === 'v' || e.key === 'm') { ui.view = { d: 'day', v: 'week', m: 'month' }[e.key]; render(); }
});
/* swipe sideways to change day, week or month */
{
  let sw = null; const view = $('#view');
  view.addEventListener('touchstart', (e) => { sw = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null; }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!sw || drag || Date.now() - dragEndedAt < 300) { sw = null; return; }
    const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50 && Date.now() - sw.t < 600) go(dx < 0 ? 1 : -1);
    sw = null;
  }, { passive: true });
}
setInterval(() => { updateNow(); if (!sameDay(lastTick, new Date())) { lastTick = new Date(); render(); } }, 30000);
let lastTick = new Date();
window.addEventListener('resize', updateNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateNow(); loadSchedule(); } });

async function loadSchedule() {
  try {
    const r = await fetch('data/schedule.json', { cache: 'no-cache' }); if (!r.ok) return;
    const j = await r.json(); const changed = JSON.stringify(j) !== JSON.stringify(schedule);
    if (changed) { schedule = j; courseCache = null; try { localStorage.setItem(LS_SCHED, JSON.stringify(j)); } catch (e) { /* ignore */ } render(); }
  } catch (e) { /* offline: keep the copy we have */ }
  onboard();
}
render();
loadSchedule();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
