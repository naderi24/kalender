/* Kalender: a small personal calendar in the style of the iPhone one.
   - Course timetable comes from data/schedule.json (all seminar groups); the user's group picks the right slot.
   - Own events, edits to course events and settings live in localStorage on the device.
   - ics.js reads calendar links (subscriptions), which show up as read-only calendars.
   - sync.js keeps several devices the same through a private GitHub repo, when the user has switched that on.
   - ai.js adds the assistant (the user's own Anthropic API key). */
import { createSync, toDoc, applyDoc, stampDoc, TOKEN_URL } from './sync.js';
import { parseICS, expandICS } from './ics.js';
const VERSION = 'v4';
const LS = 'kalender-v1', LS_SCHED = 'kalender-schedule-v1', LS_FEED = 'kalender-feed-', LS_FEEDLIST = 'kalender-feedlist';
let HOUR = 56;            /* px per hour in the timeline; set from the row-height setting, mirrored in --hh */
const SNAP = 15;          /* minutes */
const DAY1 = ['S', 'M', 'T', 'O', 'T', 'F', 'L'];   /* by Date.getDay() */
const REPEAT = { '': 'Aldrig', d: 'Varje dag', w: 'Varje vecka', '2w': 'Varannan vecka', m: 'Varje månad' };
const PALETTE = ['#007aff', '#ff2d55', '#34c759', '#ff9500', '#af52de', '#5ac8fa', '#a2845e', '#ffcc00'];
const ACCENTS = [['red', '#ff3b30', 'Röd'], ['orange', '#ff9500', 'Orange'], ['green', '#28a745', 'Grön'], ['blue', '#007aff', 'Blå'], ['purple', '#af52de', 'Lila'], ['pink', '#ff2d55', 'Rosa']];
const KIND = { lecture: 'Föreläsning', seminar: 'Seminarium', deadline: 'Inlämning', exam: 'Tenta', office: 'Handledning' };
const KWORD = { Lecture: 'Föreläsning', Seminar: 'Seminarium', 'Case Seminar': 'Caseseminarium', 'Project seminar': 'Projektseminarium', 'Project tutorial': 'Projekthandledning' };
/* settings that belong to the device (not synced), with their defaults */
const PREFS = { weekStart: 1, weekNums: true, h24: true, open: 'last', days: 'auto', dayStart: 7, density: 'normal', dimPast: true, dur: 60, cal: 'last', accent: 'red' };

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
const chevron = () => h('span', { class: 'chev', html: svg('<path d="M9 5l7 7-7 7"/>') });
const narrow = matchMedia('(max-width: 700px)'), reduced = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- dates (all local time) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());      /* always 24 h: this is the stored form */
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
const weekStartOf = (d) => addDays(dayStart(d), -((d.getDay() - pref('weekStart') + 7) % 7));
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
/* a time as shown to the user: 24 h, or 12 h when that is chosen in the settings */
const tm = (d) => pref('h24') ? hm(d) : (d.getHours() % 12 || 12) + ':' + pad(d.getMinutes()) + (d.getHours() < 12 ? ' fm' : ' em');
const tmMin = (m) => tm(new Date(2000, 0, 1, Math.floor(m / 60) % 24, m % 60));
const range = (n) => Array.from({ length: n }, (_, i) => i);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = (p = 'e') => p + Math.random().toString(36).slice(2, 10);

/* ---------- state ---------- */
const blank = () => ({
  events: [],            /* {id,title,loc,notes,allDay,start,end,cal,rr:{f,until}|null,ex:[ymd],upd} or {id,del:true,upd} */
  over: {},              /* edits to course events: key -> {hidden} | {title,loc,notes,start,end,allDay} */
  cals: [{ id: 'privat', name: 'Privat', color: '#007aff' }, { id: 'plugg', name: 'Plugg', color: '#ff2d55' }],
  subs: [],              /* calendar links: {id,name,url,color} */
  hidden: [],            /* calendar ids switched off */
  groups: {},            /* course id -> seminar group */
  ou: {}, cu: {}, su: {}, fu: {},   /* when each course edit, calendar, link and setting last changed (for sync); deleted ones stay listed here */
  prefs: {},             /* settings for this device, see PREFS */
  onboarded: false, view: '', lastCal: 'privat', theme: 'auto', upd: 0,
});
function load() { try { const raw = localStorage.getItem(LS); if (raw) return Object.assign(blank(), JSON.parse(raw)); } catch (e) { /* private mode */ } return blank(); }
let state = load();
let schedule = null;
try { schedule = JSON.parse(localStorage.getItem(LS_SCHED) || 'null'); } catch (e) { /* ignore */ }
let courseCache = null, pristine = new Map();
const pref = (k) => { const p = state.prefs; return p && p[k] !== undefined ? p[k] : PREFS[k]; };
function persist() { courseCache = null; try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) { /* ignore */ } }
/* `known` is everything that syncs, as it was at the last save. save() compares against it and time-stamps whatever
   changed (an undo and an import included), which is what lets two devices merge their changes. */
let known = toDoc(state);
function save() {
  state.upd = Date.now();
  known = stampDoc(toDoc(state), known, state.upd); applyDoc(state, known);
  persist(); sync.changed();
}

const today = () => dayStart(new Date());
const VIEWS = ['list', 'day', 'week', 'month'];
const startView = () => { const o = pref('open'), v = o === 'last' ? state.view : o; return VIEWS.includes(v) ? v : narrow.matches ? 'day' : 'week'; };
/* scroll: where the timeline is scrolled to (kept from page to page); rescroll: forget it and go to the usual place */
const ui = { date: today(), view: startView(), scroll: null, rescroll: false, listDays: 30, occs: new Map() };

/* ---------- theme and settings that change the look ---------- */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const root = document.documentElement;
  const t = state.theme === 'light' || state.theme === 'dark' ? state.theme : '';
  if (t) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
  const dark = t ? t === 'dark' : darkQuery.matches;
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', dark ? '#000000' : '#ffffff');
  HOUR = { compact: 44, normal: 56, large: 72 }[pref('density')] || 56;
  root.style.setProperty('--hh', HOUR + 'px');
  root.classList.toggle('h12', !pref('h24'));
  if (pref('accent') === 'red') root.removeAttribute('data-accent'); else root.setAttribute('data-accent', pref('accent'));
}
darkQuery.addEventListener('change', applyTheme);
function setPref(k, v) {
  state.prefs = { ...(state.prefs || {}), [k]: v }; persist();
  if (k === 'density' || k === 'dayStart') ui.rescroll = true;
  applyTheme(); render();
}

/* ---------- sync between devices (sync.js) ---------- */
let syncDraw = null;      /* redraws the sync rows of the open settings sheet */
let calDraw = null;       /* redraws the open Kalendrar sheet */
const sync = createSync({
  getDoc: () => toDoc(state),
  busy: () => !!drag,
  /* another device changed something: take the merged calendar, and mend what no longer fits */
  adopt(doc) {
    applyDoc(state, doc); known = toDoc(state);
    let mended = false;
    if (!state.cals.length) { state.cals = [blank().cals[0]]; mended = true; }
    for (const ev of state.events) if (!ev.del && !state.cals.some((c) => c.id === ev.cal)) { ev.cal = state.cals[0].id; mended = true; }
    if (!state.cals.some((c) => c.id === state.lastCal)) state.lastCal = state.cals[0].id;
    if (mended) save(); else persist();
    render();
    if (calDraw) calDraw();
    refreshFeeds();
  },
  onStatus(st) {
    $('#settings').classList.toggle('warn', st.on && st.state === 'error');
    if (syncDraw) syncDraw();
    if (st.on && st.state === 'idle') pushFeedList();
  },
});

/* ---------- calendars ---------- */
function calendars() {
  const out = (schedule ? schedule.courses : []).map((c) => ({ id: 'c:' + c.id, name: c.code + ' ' + c.name, short: c.code, color: c.color, course: c }));
  return out.concat(state.cals.map((c) => ({ ...c, short: c.name })), state.subs.map((s) => ({ id: 's:' + s.id, name: s.name, short: s.name, color: s.color, sub: s })));
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

/* ---------- calendar links: fetched as .ics, cached on the device, shown read-only ---------- */
const feeds = new Map();   /* link id -> { at, via, err, parsed, memo } */
function feedOf(id) {
  let f = feeds.get(id);
  if (!f) {
    f = { at: 0, via: '', err: '', parsed: null, memo: new Map(), tried: 0, waiting: false };
    try { const j = JSON.parse(localStorage.getItem(LS_FEED + id) || 'null'); if (j && j.parsed) { f.at = j.at || 0; f.via = j.via || ''; f.parsed = j.parsed; } } catch (e) { /* ignore */ }
    feeds.set(id, f);
  }
  return f;
}
function feedOccs(from, to) {
  const out = [];
  for (const sub of state.subs) {
    const f = feedOf(sub.id); if (!f.parsed) continue;
    const k = +from + ':' + +to; let list = f.memo.get(k);
    if (!list) { if (f.memo.size > 16) f.memo.clear(); list = expandICS(f.parsed, from, to); f.memo.set(k, list); }
    for (const x of list) out.push({ key: 's:' + sub.id + ':' + x.key, src: 'feed', calId: 's:' + sub.id, color: sub.color, kind: 'event', title: x.title, loc: x.loc, notes: x.notes, url: x.url,
      start: x.start, end: x.end, allDay: x.allDay, rec: x.rec, feed: sub.name });
  }
  return out;
}
const httpsUrl = (u) => String(u).trim().replace(/^webcals?:/i, 'https:');
/* Most calendar hosts do not let a web page read their files. So: try the link directly, and otherwise read the copy
   that the workflow in the user's data repo downloads (needs sync to be on). Returns the text, or null. */
async function fetchFeed(sub, f) {
  if (f.via !== 'repo' || !sync.on) {
    try {
      const r = await fetch(httpsUrl(sub.url), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (r.ok) { const t = await r.text(); if (/BEGIN:VCALENDAR/i.test(t)) { f.via = 'direct'; return t; } }
    } catch (e) { /* blocked by the other site, or offline */ }
  }
  if (!sync.on) {
    if (!f.parsed) f.err = navigator.onLine === false ? 'Ingen uppkoppling.' : 'Länken går inte att hämta direkt i webbläsaren. Slå på synk under Inställningar, så hämtas den via ditt GitHub-repo.';
    return null;
  }
  try {
    const t = await sync.readFile('feeds/' + sub.id + '.ics');
    if (t == null) {
      f.waiting = true; f.since = f.since || Date.now();
      if (!f.parsed) f.err = Date.now() - f.since < 6 * 60000 ? 'Väntar på första hämtningen. Det brukar ta någon minut.' : 'Ingen kopia finns i GitHub-repot än. Kontrollera att hämtningen av kalenderlänkar är inlagd i kalender-data.';
      return null;
    }
    f.via = 'repo'; f.waiting = false; return t;
  } catch (e) { if (!f.parsed) f.err = (e && e.kind && e.message) || 'Kunde inte hämtas.'; return null; }
}
let feedBusy = false, feedTimer = null;
async function refreshFeeds(force) {
  for (const id of [...feeds.keys()]) if (!state.subs.some((s) => s.id === id)) { feeds.delete(id); try { localStorage.removeItem(LS_FEED + id); } catch (e) { /* ignore */ } }
  if (feedBusy || !state.subs.length) return;
  feedBusy = true; let changed = false, renamed = false;
  try {
    for (const sub of [...state.subs]) {
      const f = feedOf(sub.id), now = Date.now();
      if (!force && f.parsed && now - f.at < 30 * 60000) continue;
      if (!force && now - f.tried < 45000) continue;
      f.tried = now;
      const text = await fetchFeed(sub, f);
      if (text == null) continue;
      const parsed = parseICS(text);
      f.parsed = parsed; f.at = Date.now(); f.err = ''; f.memo.clear(); changed = true;
      try { localStorage.setItem(LS_FEED + sub.id, JSON.stringify({ at: f.at, via: f.via, parsed })); } catch (e) { /* too large for this device's storage: kept in memory until the app closes */ }
      const live = state.subs.find((s) => s.id === sub.id);
      if (live && live.auto) { if (parsed.name) live.name = parsed.name.slice(0, 40); delete live.auto; renamed = true; }
    }
  } finally { feedBusy = false; }
  if (renamed) save();
  if (changed || renamed) render();
  if (calDraw) calDraw();
  clearTimeout(feedTimer);
  if (state.subs.some((s) => feedOf(s.id).waiting)) feedTimer = setTimeout(() => refreshFeeds(), 50000);
}
/* tell the workflow in the data repo which links to download */
async function pushFeedList() {
  if (!sync.on) return;
  let last = ''; try { last = localStorage.getItem(LS_FEEDLIST) || ''; } catch (e) { /* ignore */ }
  if (!state.subs.length && !last) return;
  const want = JSON.stringify({ feeds: state.subs.map((s) => ({ id: s.id, url: httpsUrl(s.url) })).sort((a, b) => (a.id < b.id ? -1 : 1)) }, null, 1) + '\n';
  if (want === last) return;
  try { if (await sync.writeFile('feeds.json', want, 'Kalender: kalenderlänkar')) { try { localStorage.setItem(LS_FEEDLIST, want); } catch (e) { /* ignore */ } refreshFeeds(); } } catch (e) { /* tried again after the next sync */ }
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
  const list = courseOccs().filter((o) => o.end > from && o.start < to).concat(userOccs(from, to), feedOccs(from, to));
  return (all ? list : list.filter((o) => visible(o.calId))).sort((a, b) => a.start - b.start || b.end - a.end);
}
function findOcc(key) {
  key = String(key);
  if (key.startsWith('s:')) return ui.occs.get(key) || null;
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
    cal: state.cals.some((c) => c.id === v.cal) ? v.cal : state.cals[0].id, rr: v.rr || null, ex: [], upd: Date.now() };
  state.events.push(ev); state.lastCal = ev.cal; return ev.id;
}
/* scope: 'one' changes only this occurrence of a repeating event, 'all' the whole series */
function applyEdit(o, v, scope) {
  if (o.src === 'feed') return;
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
  if (o.src === 'feed') return;
  if (o.src === 'course') { state.over[o.key] = { hidden: true }; return; }
  const i = state.events.findIndex((x) => x.id === o.id); if (i < 0) return;
  const ev = state.events[i];
  if (ev.rr && o.occ && scope === 'one') { ev.ex = (ev.ex || []).concat(o.occ); ev.upd = Date.now(); }
  else state.events[i] = { id: ev.id, del: true, upd: Date.now() };
}
const snapshot = () => JSON.stringify(state);
function restore(snap) { state = JSON.parse(snap); save(); applyTheme(); render(); }
function mutate(fn, msg) {
  const snap = snapshot(); fn(); save(); render();
  if (msg) toast(msg, 'Ångra', () => restore(snap));
}
function moveOcc(o, ns, ne) {
  if (o.src === 'feed' || (+ns === +o.start && +ne === +o.end)) return;
  mutate(() => applyEdit(o, { title: o.title, loc: o.loc, notes: o.notes, allDay: o.allDay, start: ns, end: ne, cal: o.calId, rr: o.rec ? null : undefined }, 'one'),
    'Flyttad till ' + fmtShort(ns) + (o.allDay ? '' : ' ' + tm(o.kind === 'deadline' ? ne : ns)));
}
/* asks about the whole series when needed, then removes (or, for a course event, hides) */
async function removeOcc(o, after) {
  let scope = 'all';
  if (o.rec && o.occ) {
    const i = await choose('Den här händelsen upprepas.', [{ label: 'Radera bara den här', danger: true }, { label: 'Radera alla', danger: true }]);
    if (i == null) return; scope = i === 0 ? 'one' : 'all';
  }
  if (after) after();
  mutate(() => applyDelete(o, scope), o.src === 'course' ? 'Händelsen dold' : 'Händelsen raderad');
}

/* free time between `from` and `to` (dates), inside the hours given, at least `minMin` long */
function freeSlots(from, to, minMin, dayFrom, dayTo, weekends) {
  const out = [], now = new Date();
  const [fh, fm] = (dayFrom || '08:00').split(':').map(Number), [th, tmin] = (dayTo || '21:00').split(':').map(Number);
  for (let d = dayStart(from); d <= to && out.length < 80; d = addDays(d, 1)) {
    if (weekends === false && (d.getDay() === 0 || d.getDay() === 6)) continue;
    let a = new Date(d.getFullYear(), d.getMonth(), d.getDate(), fh, fm); const b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), th, tmin);
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
  const el = h('div', { class: 'toast glass' }, h('span', null, msg), action && h('button', { type: 'button', onclick: () => { box.innerHTML = ''; fn(); } }, action));
  box.append(el); clearTimeout(toastT); toastT = setTimeout(() => { if (el.isConnected) el.remove(); }, action ? 6000 : 3200);
}

/* ---------- sheets ---------- */
const openSheets = [];
function sheet({ title, left, right, body, cls }) {
  const wrap = h('div', { class: 'sheet-wrap ' + (cls || '') });
  const api = { wrap, close() { const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1); wrap.classList.add('out'); setTimeout(() => wrap.remove(), 260); } };
  const btn = (b, side) => b ? h('button', { type: 'button', class: 'bar-btn ' + side + (b.strong ? ' strong' : ''), onclick: () => b.fn(api) }, b.label) : h('span', { class: 'bar-btn ' + side });
  api.el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Händelse' },
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
/* a row of choices with a thumb that slides to the chosen one */
function segment(options, value, onpick, label) {
  const el = h('div', { class: 'seg', role: 'tablist', 'aria-label': label, style: `--n:${options.length};--i:${Math.max(0, options.findIndex((o) => o[0] === value))}` }, h('i', { class: 'thumb' }),
    options.map(([k, text]) => h('button', { type: 'button', role: 'tab', 'data-k': k, 'aria-selected': String(k === value), onclick: () => { el.pick(k); onpick(k); } }, text)));
  el.pick = (k) => { [...el.querySelectorAll('button')].forEach((b, i) => { const on = b.dataset.k === k; b.setAttribute('aria-selected', String(on)); if (on) el.style.setProperty('--i', i); }); };
  return el;
}
const swatches = (colors, value, onpick, label) => h('div', { class: 'swatches', role: 'group', 'aria-label': label },
  colors.map(([k, c, name]) => h('button', { type: 'button', class: 'swatch', style: '--c:' + c, 'aria-label': name || c, 'aria-pressed': String(k === value), onclick: () => onpick(k) })));

/* ---------- how an event is shown ---------- */
/* dark or white text on a filled block, whichever reads better on that colour */
function onColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
  const n = parseInt(m[1], 16), f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255) > 0.36 ? '#1c1c1e' : '#fff';
}
const isSolid = (o) => o.kind === 'seminar' || o.kind === 'exam';
const styleOf = (o, solid = isSolid(o)) => '--c:' + o.color + (solid ? ';--on:' + onColor(o.color) : '');
const isPast = (o) => pref('dimPast') && o.end < new Date();
/* "Lecture 5: Pricing" in BE202 -> a small label "BE202 · Föreläsning 5" and the title "Pricing" */
function present(o) {
  if (o.src === 'course') {
    const m = /^(Lecture|Seminar|Case Seminar|Project seminar|Project tutorial)(?: (\d+))?: (.+)$/.exec(o.title);
    if (m) return { tag: o.course + ' · ' + KWORD[m[1]] + (m[2] ? ' ' + m[2] : ''), title: m[3] };
    return { tag: o.course + (KIND[o.kind] ? ' · ' + KIND[o.kind] : ''), title: o.title };
  }
  return { tag: o.src === 'feed' ? o.feed : '', title: o.title };
}
const timeOf = (o) => o.allDay ? 'Heldag' : o.kind === 'deadline' ? 'Senast ' + tm(o.end) : tm(o.start) + '–' + tm(o.end);

/* ---------- event details ---------- */
function openDetail(o) {
  const p = present(o), c = calOf(o.calId), course = o.src === 'course', feed = o.src === 'feed';
  const ev = !course && !feed ? state.events.find((x) => x.id === o.id) : null;
  const last = o.allDay ? addDays(o.end, -1) : o.end, multi = !sameDay(o.start, last);
  const when = o.allDay ? (multi ? fmtDay(o.start) + ' – ' + fmtDay(last) : fmtDay(o.start)) + ' · heldag'
    : o.kind === 'deadline' ? fmtDay(o.end) + ' · senast ' + tm(o.end)
    : multi ? cap(fmtShort(o.start)) + ' ' + tm(o.start) + ' – ' + fmtShort(o.end) + ' ' + tm(o.end) : fmtDay(o.start) + ' · ' + tm(o.start) + '–' + tm(o.end);
  const link = o.url && /^https?:\/\//i.test(o.url) ? o.url : '';
  const s = sheet({ title: '', left: { label: 'Stäng', fn: (x) => x.close() }, right: feed ? null : { label: 'Ändra', strong: true, fn: (x) => { x.close(); openEditor(o); } }, body: [
    h('div', { class: 'dt', style: '--c:' + o.color },
      h('div', { class: 'dt-k' }, h('i', { class: 'dot' }), p.tag || c.name),
      h('h2', null, p.title),
      h('p', null, when),
      ev && ev.rr && h('p', { class: 'sub' }, 'Upprepas: ' + REPEAT[ev.rr.f].toLowerCase() + (ev.rr.until ? ' till ' + fmt(fromLocal(ev.rr.until), { day: 'numeric', month: 'long' }) : '')),
      feed && o.rec && h('p', { class: 'sub' }, 'Upprepas'),
      course && o.changed && h('p', { class: 'sub' }, 'Ändrad av dig')),
    grp(null, o.loc && h('div', { class: 'row' }, h('span', { class: 'row-l' }, 'Plats'), h('span', { class: 'val' }, o.loc)),
      h('div', { class: 'row' }, h('span', { class: 'row-l' }, 'Kalender'), h('span', { class: 'val' }, c.name))),
    o.notes && grp('Anteckningar', h('div', { class: 'dt-notes' }, o.notes)),
    link && grp(null, h('div', { class: 'row' }, h('a', { class: 'link', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Öppna länk'))),
    feed && h('p', { class: 'note', style: 'margin-top:0' }, 'Händelsen kommer från kalenderlänken ”' + o.feed + '” och ändras där den skapades.'),
    course && o.changed && h('button', { type: 'button', class: 'big-btn', onclick: () => { s.close(); mutate(() => { delete state.over[o.key]; }, 'Återställd till schemat'); } }, 'Återställ till schemat'),
    !feed && h('button', { type: 'button', class: 'big-btn danger', onclick: () => removeOcc(o, () => s.close()) }, course ? 'Dölj händelsen' : 'Radera händelsen'),
  ] });
}

/* ---------- editor ---------- */
function openEditor(o) {
  if (o.src === 'feed') return openDetail(o);
  const isNew = o.src === 'new', course = o.src === 'course';
  const ev = !isNew && !course ? state.events.find((x) => x.id === o.id) : null;
  let dur = o.end - o.start;
  const lastDay = o.allDay ? addDays(o.end, -1) : o.end;
  const title = h('input', { type: 'text', class: 'in', placeholder: 'Titel', value: o.title || '', enterkeyhint: 'done' });
  const loc = h('input', { type: 'text', class: 'in', placeholder: 'Plats', value: o.loc || '' });
  const allDay = h('input', { type: 'checkbox', class: 'sw', checked: !!o.allDay });
  const sd = h('input', { type: 'date', class: 'pill-in', value: ymd(o.start) }), st = h('input', { type: 'time', class: 'pill-in', step: 300, value: hm(o.start) });
  const ed = h('input', { type: 'date', class: 'pill-in', value: ymd(lastDay) }), et = h('input', { type: 'time', class: 'pill-in', step: 300, value: hm(o.end) });
  const notes = h('textarea', { class: 'in', rows: 4, placeholder: 'Anteckningar' }); notes.value = o.notes || '';
  const rep = h('select', { class: 'pick' }, Object.keys(REPEAT).map((k) => h('option', { value: k }, REPEAT[k]))); rep.value = (ev && ev.rr && ev.rr.f) || '';
  const until = h('input', { type: 'date', class: 'pill-in', value: (ev && ev.rr && ev.rr.until) || '' });
  const cal = h('select', { class: 'pick' }, state.cals.map((c) => h('option', { value: c.id }, c.name))); cal.value = o.calId; if (!cal.value) cal.value = state.cals[0].id;
  const untilRow = row('Sluta upprepa', until);
  const read = () => {
    const a = allDay.checked;
    const s = fromLocal(sd.value + (a ? '' : 'T' + (st.value || '09:00')));
    let e = fromLocal((ed.value || sd.value) + (a ? '' : 'T' + (et.value || '10:00')));
    if (a) e = addDays(e, 1);
    return { s, e };
  };
  const show = () => { st.hidden = et.hidden = allDay.checked; untilRow.hidden = !rep.value; };
  const startChanged = () => { if (!sd.value) return; const { s } = read(); const e = new Date(s.getTime() + dur); const last = allDay.checked ? addDays(e, -1) : e; ed.value = ymd(last); et.value = hm(e); };
  const endChanged = () => { const { s, e } = read(); if (e > s) dur = e - s; };
  sd.addEventListener('change', startChanged); st.addEventListener('change', startChanged);
  ed.addEventListener('change', endChanged); et.addEventListener('change', endChanged);
  allDay.addEventListener('change', () => { show(); dur = allDay.checked ? 864e5 * Math.max(1, dayDiff(fromLocal(sd.value), fromLocal(ed.value || sd.value)) + 1) : pref('dur') * 6e4; if (!allDay.checked) startChanged(); });
  rep.addEventListener('change', show);

  const c = calOf(o.calId);
  const body = [
    course && h('div', { class: 'ed-src' }, h('i', { style: '--c:' + c.color }), h('span', null, c.name + (o.changed ? ' · ändrad' : ''))),
    grp(null, row(null, title), row(null, loc)),
    grp(null, row('Heldag', allDay), row('Börjar', sd, st), row('Slutar', ed, et), !course && row('Upprepa', rep), !course && untilRow),
    !course && grp(null, row('Kalender', cal)),
    grp(null, row(null, notes)),
    !isNew && h('button', { type: 'button', class: 'big-btn danger', onclick: () => removeOcc(o, () => s.close()) }, course ? 'Dölj händelsen' : 'Radera händelsen'),
  ];
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
  show();
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
  if (isNew) setTimeout(() => title.focus(), 60);
}
function newEventAt(start, allDay) {
  const s = start || (() => { const n = new Date(); return sameDay(ui.date, n) ? new Date(n.getFullYear(), n.getMonth(), n.getDate(), Math.min(23, n.getHours() + 1)) : new Date(ui.date.getFullYear(), ui.date.getMonth(), ui.date.getDate(), 9); })();
  const want = pref('cal') === 'last' ? state.lastCal : pref('cal');
  openEditor({ src: 'new', title: '', start: allDay ? dayStart(s) : s, end: allDay ? addDays(dayStart(s), 1) : addMin(s, pref('dur')), allDay: !!allDay,
    calId: state.cals.some((c) => c.id === want) ? want : state.cals[0].id });
}

/* ---------- which days the several-days view shows ---------- */
const nDays = () => { const p = pref('days'); return p === 'auto' ? (narrow.matches ? 3 : 7) : +p || 7; };
function daysOf(date) {
  if (ui.view !== 'week') return [dayStart(date)];
  const n = nDays();
  const first = n === 7 ? weekStartOf(date) : n === 5 ? mondayOf(date) : dayStart(date);
  return range(n).map((i) => addDays(first, i));
}
/* the date one page forward or back */
function shift(date, dir) {
  if (ui.view === 'month') { const last = new Date(date.getFullYear(), date.getMonth() + dir + 1, 0).getDate(); return new Date(date.getFullYear(), date.getMonth() + dir, Math.min(date.getDate(), last)); }
  const n = ui.view === 'day' ? 1 : ui.view === 'week' && nDays() === 3 ? 3 : 7;
  return addDays(dayStart(date), dir * n);
}

/* ---------- timeline (one day, or several) ---------- */
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
function evBlock(o, sg) {
  const top = sg.s / 60 * HOUR, height = Math.max(20, (sg.e - sg.s) / 60 * HOUR - 2);
  const p = present(o), time = timeOf(o), tiny = height < 36, movable = sg.whole && o.src !== 'feed';
  const el = h('div', { class: 'ev k-' + o.kind + (isSolid(o) ? ' solid' : '') + (tiny ? ' tiny' : height < 62 ? ' small' : '') + (isPast(o) ? ' past' : ''), tabindex: 0, role: 'button',
    'aria-label': [p.tag, p.title, time, o.loc].filter(Boolean).join(', '),
    style: `${styleOf(o)};top:${top}px;height:${height}px;left:calc(${sg.col / sg.cols * 100}% + 1px);width:calc(${100 / sg.cols}% - 3px)` },
    p.tag && h('span', { class: 'ev-k' }, p.tag),
    h('b', { 'data-short': (!o.changed && o.short) || p.title }, tiny && o.kind === 'deadline' ? tm(o.end) + ' ' + p.title : p.title),
    h('span', { class: 'ev-sub' }, [time, o.loc].filter(Boolean).join(' · ')),
    movable && h('i', { class: 'rz' }));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(o); } });
  bindDrag(el, o, movable);
  return el;
}
function chipOf(o, withTime) {
  const solid = o.allDay || isSolid(o);
  return h('button', { type: 'button', class: 'chip' + (solid ? ' solid' : '') + (isPast(o) ? ' past' : ''), style: styleOf(o, solid), onclick: (e) => { e.stopPropagation(); openDetail(o); } },
    withTime && !o.allDay && h('em', null, tm(o.kind === 'deadline' ? o.end : o.start)), present(o).title);
}
function stripEl(days, selected, columns) {
  const now = new Date();
  return h('div', { class: 'strip' + (columns ? ' cols' : ''), style: '--n:' + days.length },
    h('div', { class: 'wk' }, pref('weekNums') ? 'v' + isoWeek(addDays(days[0], days.length === 7 ? 3 : 0)) : ''),
    days.map((d) => h('button', { type: 'button', class: 'sd' + (sameDay(d, now) ? ' today' : '') + (!columns && sameDay(d, selected) ? ' sel' : '') + (d.getDay() % 6 === 0 ? ' we' : ''),
      'aria-label': fmtDay(d), 'aria-current': !columns && sameDay(d, selected) ? 'date' : null,
      onclick: () => { const dir = Math.sign(dayDiff(ui.date, d)); ui.date = d; if (columns) { ui.view = 'day'; render('fade'); } else render(dir); } },
      h('span', { class: 'sd-w' }, columns && days.length <= 3 ? fmt(d, { weekday: 'short' }) : DAY1[d.getDay()]), h('span', { class: 'sd-n' }, d.getDate()))));
}
function buildTimeline(el, date) {
  const several = ui.view === 'week', days = daysOf(date), now = new Date();
  const occs = occurrences(days[0], addDays(days[days.length - 1], 1));
  el._occs = new Map(occs.map((o) => [o.key, o])); el._days = days;
  const allDayOf = (d) => occs.filter((o) => o.allDay && o.start < addDays(d, 1) && o.end > d);
  const hasAllDay = days.some((d) => allDayOf(d).length);
  const allday = h('div', { class: 'allday' + (hasAllDay ? '' : ' empty'), style: '--n:' + days.length }, h('div', { class: 'ad-l' }, 'heldag'),
    days.map((d) => h('div', { class: 'ad-col' }, allDayOf(d).map((o) => chipOf(o)))));

  const grid = h('div', { class: 'tl-grid' });
  for (let hr = 0; hr <= 24; hr++) grid.append(h('div', { class: 'hr', style: `top:${hr * HOUR}px` }, hr > 0 && hr < 24 && h('span', null, pref('h24') ? pad(hr) + ':00' : (hr % 12 || 12) + (hr < 12 ? ' fm' : ' em'))));
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
      hold = setTimeout(() => { if (swipe && swipe.lock) return; if (navigator.vibrate) navigator.vibrate(8); createAt(hp.y); }, 480);
    }, { passive: true });
    col.addEventListener('touchmove', (e) => { if (hp && Math.hypot(e.touches[0].clientX - hp.x, e.touches[0].clientY - hp.y) > 8) clearTimeout(hold); }, { passive: true });
    col.addEventListener('touchend', () => { lastTouch = Date.now(); clearTimeout(hold); }, { passive: true });
    col.addEventListener('touchcancel', () => clearTimeout(hold), { passive: true });
    const segs = occs.filter((o) => !o.allDay && o.start < d1 && o.end > d).map((o) => ({ o, s: o.start < d ? 0 : minOf(o.start), e: o.end >= d1 ? 1440 : Math.max(minOf(o.end), minOf(o.start) + 15), whole: o.start >= d && o.end <= d1 }));
    for (const sg of layoutDay(segs)) col.append(evBlock(sg.o, sg));
    cols.append(col);
  }
  grid.append(cols, h('div', { class: 'now', hidden: true }, h('span')));
  el.append(h('div', { class: 'tl ' + (several ? 'week n' + days.length : 'day') }, several && stripEl(days, date, true), allday, h('div', { class: 'tl-scroll' }, grid)));
}
function updateNow() {
  const line = pane && pane.querySelector('.now'); if (!line) return;
  const col = pane.querySelector('.tl-col.today'), now = new Date();
  line.hidden = !col; if (!col) return;
  line.style.top = minOf(now) / 60 * HOUR + 'px';
  line.firstChild.textContent = tm(now);
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
  const d = drag, scroller = pane && pane.querySelector('.tl-scroll'); if (!d || !scroller) return;
  const cols = [...pane.querySelectorAll('.tl-col')];
  if (d.mode === 'move') {
    const col = cols.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; }) || d.col;
    const top = col.getBoundingClientRect().top;
    d.min = clamp(Math.round(((y - d.offY - top) / HOUR * 60) / SNAP) * SNAP, 0, 1440 - SNAP);
    if (d.el.parentNode !== col) col.append(d.el);
    d.col = col;
    d.el.style.top = d.min / 60 * HOUR + 'px'; d.el.style.left = '1px'; d.el.style.width = 'calc(100% - 3px)';
    d.label.textContent = d.o.kind === 'deadline' ? 'senast ' + tmMin(d.min + d.dur) : tmMin(d.min) + '–' + tmMin(d.min + d.dur);
  } else {
    const top = d.col.getBoundingClientRect().top;
    d.end = clamp(Math.round(((y - top) / HOUR * 60) / SNAP) * SNAP, d.startMin + SNAP, 1440);
    d.el.style.height = (d.end - d.startMin) / 60 * HOUR - 2 + 'px';
    d.label.textContent = tmMin(d.startMin) + '–' + tmMin(d.end);
  }
  const sr = scroller.getBoundingClientRect();
  if (y < sr.top + 36) scroller.scrollTop -= 10; else if (y > sr.bottom - 36) scroller.scrollTop += 10;
}
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
function bindDrag(el, o, movable) {
  /* mouse: drag straight away; a plain click opens the event */
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY, mode = e.target.classList.contains('rz') ? 'resize' : 'move';
    let started = false;
    const move = (m) => {
      if (!started) { if (!movable || Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return; started = true; beginDrag(o, el, x0, y0, mode); }
      m.preventDefault(); moveDrag(m.clientX, m.clientY);
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (started) endDrag(false); else openDetail(o); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  /* touch: hold to pick up, then drag; a tap opens the event; a swipe scrolls or turns the page as usual */
  let timer = null, t0 = null, held = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY, moved: false }; held = false;
    clearTimeout(timer);
    if (movable) timer = setTimeout(() => { if (swipe && swipe.lock) return; held = true; beginDrag(o, el, t0.x, t0.y, 'move'); if (navigator.vibrate) navigator.vibrate(8); }, 380);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t0) return;
    if (held) { e.preventDefault(); moveDrag(t.clientX, t.clientY); return; }
    if (Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 8) { t0.moved = true; clearTimeout(timer); }
  }, { passive: false });
  const finish = (e, cancel) => {
    clearTimeout(timer);
    if (held) { e.preventDefault(); held = false; endDrag(cancel); }
    else if (t0 && !t0.moved && !cancel) { e.preventDefault(); openDetail(o); }
    t0 = null;
  };
  el.addEventListener('touchend', (e) => finish(e, false), { passive: false });
  el.addEventListener('touchcancel', (e) => finish(e, true), { passive: false });
}

/* ---------- rows of events (list view, the day under the month, search) ---------- */
function agendaRow(o, day) {
  const p = present(o), d1 = day ? addDays(day, 1) : null;
  const t = o.allDay ? ['Heldag', ''] : o.kind === 'deadline' ? ['Senast', tm(o.end)]
    : [day && o.start < day ? tmMin(0) : tm(o.start), day && o.end > d1 ? '24:00' : tm(o.end)];
  return h('button', { type: 'button', class: 'ag k-' + o.kind + (isSolid(o) ? ' solid' : '') + (isPast(o) ? ' past' : ''), style: styleOf(o), onclick: () => openDetail(o) },
    h('span', { class: 'ag-t' }, h('b', null, t[0]), h('span', null, t[1])), h('i'),
    h('span', { class: 'ag-m' }, h('span', { class: 'ag-k' }, p.tag || calOf(o.calId).name), h('b', null, p.title), o.loc && h('span', { class: 'ag-s' }, o.loc)));
}
function buildList(el, date) {
  const from = dayStart(date), n = ui.listDays, now = new Date();
  const occs = occurrences(from, addDays(from, n));
  el._occs = new Map(occs.map((o) => [o.key, o]));
  const inner = h('div', { class: 'lv-in' });
  for (let i = 0; i < n; i++) {
    const d = addDays(from, i), d1 = addDays(d, 1), isToday = sameDay(d, now);
    const list = occs.filter((o) => o.start < d1 && o.end > d);
    if (!list.length && !isToday) continue;
    const rel = dayDiff(now, d), near = rel >= -1 && rel <= 1;
    inner.append(h('div', { class: 'lv-day' + (isToday ? ' today' : '') }, h('b', null, rel === 0 ? 'Idag' : rel === 1 ? 'Imorgon' : rel === -1 ? 'Igår' : cap(fmt(d, { weekday: 'long' }))),
      h('span', null, (near ? fmt(d, { weekday: 'long' }) + ' ' : '') + fmt(d, { day: 'numeric', month: 'long' }) + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''))));
    if (list.length) for (const o of list) inner.append(agendaRow(o, d)); else inner.append(h('p', { class: 'lv-none' }, 'Inget inplanerat'));
  }
  if (!occs.length) inner.append(h('p', { class: 'empty' }, 'Inga händelser de närmaste ' + n + ' dagarna'));
  inner.append(h('button', { type: 'button', class: 'more-btn', onclick: () => { ui.listDays += 30; render(); } }, 'Visa fler dagar'));
  el.append(h('div', { class: 'lv' }, inner));
}

/* ---------- month ---------- */
function buildMonth(el, date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1), start = weekStartOf(first), now = new Date();
  const weeks = Math.ceil((dayDiff(start, new Date(first.getFullYear(), first.getMonth() + 1, 0)) + 1) / 7);
  const occs = occurrences(start, addDays(start, weeks * 7));
  el._occs = new Map(occs.map((o) => [o.key, o])); el._rows = weeks;
  const of = (d) => occs.filter((o) => o.start < addDays(d, 1) && o.end > d);
  const grid = h('div', { class: 'mv-grid', style: `--rows:${weeks}` });
  for (let w = 0; w < weeks; w++) {
    grid.append(h('div', { class: 'mv-wk' }, isoWeek(addDays(start, w * 7 + 3))));
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, w * 7 + i), list = of(d);
      const cell = h('button', { type: 'button', 'data-date': ymd(d), 'aria-label': fmtDay(d) + (list.length ? ', ' + list.length + ' händelser' : ''),
        class: 'mv-day' + (d.getMonth() !== first.getMonth() ? ' out' : '') + (sameDay(d, now) ? ' today' : '') + (sameDay(d, date) ? ' sel' : ''),
        onclick: () => { const dm = (d.getFullYear() - ui.date.getFullYear()) * 12 + d.getMonth() - ui.date.getMonth(); ui.date = d; render(Math.sign(dm) || undefined); },
        ondblclick: () => newEventAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9)) },
        h('span', { class: 'n' }, d.getDate()),
        h('span', { class: 'dots' }, [...new Set(list.map((o) => o.color))].slice(0, 4).map((c) => h('i', { style: '--c:' + c }))),
        h('span', { class: 'chips' }, list.slice(0, 3).map((o) => {
          const chip = chipOf(o, true); chip.setAttribute('draggable', o.src === 'feed' ? 'false' : 'true'); chip.setAttribute('data-key', o.key);
          chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', o.key); e.dataTransfer.effectAllowed = 'move'; });
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
  el.append(grid);
}

/* ---------- frame: a fixed head, a pager whose panes slide, and (in the month) the chosen day's list ---------- */
const view = $('#view');
const head = h('div', { class: 'v-head' }), pager = h('div', { class: 'pager' }), side = h('div', { class: 'v-side' });
view.append(head, h('div', { class: 'v-body' }, pager, side));
let pane = null, anim = null, swipe = null;
const seg = segment(VIEWS.map((v) => [v, '']), ui.view, (v) => { if (v === ui.view) return; ui.view = v; ui.rescroll = true; render('fade'); }, 'Vy');
$('#seg').append(seg);

function buildPane(date) {
  const el = h('div', { class: 'pane v-' + ui.view });
  if (ui.view === 'month') buildMonth(el, date); else if (ui.view === 'list') buildList(el, date); else buildTimeline(el, date);
  return el;
}
function chrome() {
  const n = nDays(), now = new Date();
  $('#title').innerHTML = cap(fmt(ui.date, { month: 'long' })) + ' <span>' + ui.date.getFullYear() + '</span>';
  const names = { list: 'Lista', day: 'Dag', week: n === 7 ? 'Vecka' : n + ' dagar', month: 'Månad' };
  seg.querySelectorAll('button').forEach((b) => { b.textContent = names[b.dataset.k]; });
  seg.pick(ui.view);
  $('#today').disabled = ui.view === 'week' ? daysOf(ui.date).some((d) => sameDay(d, now)) : sameDay(ui.date, now);
  view.dataset.view = ui.view; view.classList.toggle('nowk', !pref('weekNums'));
}
function drawHead() {
  const s = weekStartOf(ui.date);
  if (ui.view === 'day') head.replaceChildren(stripEl(range(7).map((i) => addDays(s, i)), ui.date, false), h('div', { class: 'dayline' }, fmtDay(ui.date) + ' ', h('span', null, ui.date.getFullYear())));
  else if (ui.view === 'month') head.replaceChildren(h('div', { class: 'mv-head' }, h('span'), range(7).map((i) => { const d = addDays(s, i); return h('span', { class: d.getDay() % 6 === 0 ? 'we' : '' }, DAY1[d.getDay()]); })));
  else head.replaceChildren();
}
function drawSide() {
  if (ui.view !== 'month') { side.replaceChildren(); return; }
  const list = occurrences(ui.date, addDays(ui.date, 1));
  side.replaceChildren(h('div', { class: 'side-h' }, h('b', null, fmtDay(ui.date)),
    h('button', { type: 'button', class: 'ib small', 'aria-label': 'Ny händelse den här dagen', html: svg('<path d="M12 5v14M5 12h14"/>'), onclick: () => newEventAt() })),
    ...(list.length ? list.map((o) => agendaRow(o, ui.date)) : [h('p', { class: 'empty' }, 'Inga händelser')]));
}
/* once a pane is in the page: scroll it to where the last one was, and tell the month how many rows it has */
function settle(p, listTop) {
  const sc = p.querySelector('.tl-scroll');
  if (sc) {
    if (ui.scroll == null) {
      const now = new Date(), hasToday = (p._days || []).some((d) => sameDay(d, now));
      ui.scroll = Math.max(0, (hasToday ? clamp(minOf(now) - 90, 0, 17 * 60) : pref('dayStart') * 60 - 15) / 60 * HOUR);
    }
    sc.scrollTop = ui.scroll;
  }
  const lv = p.querySelector('.lv'); if (lv && listTop) lv.scrollTop = listTop;
  if (p._rows) view.style.setProperty('--rows', p._rows);
}
function finishAnim() { if (anim) anim.done(); }
/* slides `old` out and `next` in; dir 1 = forward (the new page comes from the right). `from` is where a finger left the old page. */
function slide(old, next, dir, from) {
  const w = pager.clientWidth || 1;
  if (next.parentNode !== pager) pager.append(next);
  old.style.transition = next.style.transition = 'none';
  old.style.transform = `translate3d(${from}px,0,0)`; next.style.transform = `translate3d(${from + dir * w}px,0,0)`;
  void next.offsetWidth;
  const ms = Math.round(240 + 180 * (1 - Math.min(1, Math.abs(from) / w)));
  old.style.transition = next.style.transition = `transform ${ms}ms cubic-bezier(.22,.8,.24,1)`;
  old.style.transform = `translate3d(${-dir * w}px,0,0)`; next.style.transform = 'translate3d(0,0,0)';
  let timer = 0;
  const token = { done() { if (anim !== token) return; anim = null; clearTimeout(timer); old.remove(); next.style.transition = ''; next.style.transform = ''; } };
  timer = setTimeout(token.done, ms + 60);
  anim = token;
}
/* how: 1 or -1 slides to the next or previous page, 'fade' is a change of view, nothing means "same place, new content" */
function render(how) {
  const sc = pane && pane.querySelector('.tl-scroll'); if (sc) ui.scroll = sc.scrollTop;
  if (ui.rescroll) { ui.scroll = null; ui.rescroll = false; }
  const lv = pane && pane.querySelector('.lv'), listTop = lv && !how ? lv.scrollTop : 0;
  finishAnim();
  if (swipe) { if (swipe.peek) swipe.peek.remove(); swipe = null; }
  chrome(); drawHead(); drawSide();
  const old = pane, next = buildPane(ui.date);
  pane = next; ui.occs = next._occs || new Map();
  if ((how === 1 || how === -1) && old && old.isConnected && !reduced.matches) { pager.append(next); settle(next, 0); slide(old, next, how, 0); }
  else { pager.replaceChildren(next); if (how === 'fade' && !reduced.matches) next.classList.add('fade-in'); settle(next, listTop); }
  updateNow();
  if (state.view !== ui.view) { state.view = ui.view; persist(); }
}
function go(dir) { ui.date = shift(ui.date, dir); render(dir); }

/* turning the page with a finger: the next page follows the finger, and a short flick is enough */
pager.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || drag || anim || openSheets.length) { swipe = null; return; }
  const t = e.touches[0]; swipe = { x: t.clientX, y: t.clientY, lock: '', dx: 0, dir: 0, peek: null, lastX: t.clientX, lastT: e.timeStamp, v: 0 };
}, { passive: true });
pager.addEventListener('touchmove', (e) => {
  const s = swipe; if (!s || drag) return;
  const t = e.touches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
  if (!s.lock) { if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return; s.lock = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'x' : 'y'; }
  if (s.lock !== 'x') return;
  if (e.cancelable) e.preventDefault();
  const dt = e.timeStamp - s.lastT; if (dt > 0) { s.v = 0.6 * s.v + 0.4 * (t.clientX - s.lastX) / dt; s.lastX = t.clientX; s.lastT = e.timeStamp; }
  const dir = dx < 0 ? 1 : -1, w = pager.clientWidth || 1;
  if (dir !== s.dir) {
    if (s.peek) s.peek.remove();
    s.dir = dir; s.peek = buildPane(shift(ui.date, dir)); pager.append(s.peek);
    const a = pane.querySelector('.tl-scroll'), b = s.peek.querySelector('.tl-scroll'); if (a && b) b.scrollTop = a.scrollTop;
  }
  s.dx = dx;
  pane.style.transform = `translate3d(${dx}px,0,0)`; s.peek.style.transform = `translate3d(${dx + dir * w}px,0,0)`;
}, { passive: false });
function endSwipe(cancel) {
  const s = swipe; swipe = null;
  if (!s || s.lock !== 'x' || !s.peek) return;
  const w = pager.clientWidth || 1, flick = Math.abs(s.v) > 0.35 && Math.sign(s.v) === Math.sign(s.dx);
  if (!cancel && (Math.abs(s.dx) > w * 0.3 || flick)) {
    const old = pane, sc = old.querySelector('.tl-scroll'); if (sc) ui.scroll = sc.scrollTop;
    pane = s.peek; ui.date = shift(ui.date, s.dir); ui.occs = pane._occs || new Map();
    chrome(); drawHead(); drawSide(); settle(pane, 0);
    slide(old, pane, s.dir, s.dx); updateNow();
  } else slide(s.peek, pane, -s.dir, s.dx + s.dir * w);      /* not far enough: the page falls back */
}
pager.addEventListener('touchend', () => endSwipe(false), { passive: true });
pager.addEventListener('touchcancel', () => endSwipe(true), { passive: true });
/* trackpad: a sideways two-finger swipe turns the page */
{
  let acc = 0, last = 0;
  view.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2 || drag) return;
    e.preventDefault();
    if (e.timeStamp - last < 650) { acc = 0; return; }
    acc += e.deltaX;
    if (Math.abs(acc) > 60) { last = e.timeStamp; go(acc > 0 ? 1 : -1); acc = 0; }
  }, { passive: false });
}

/* ---------- calendars ---------- */
const relTime = (at) => { const d = new Date(at), m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'nyss' : m < 60 ? 'för ' + m + ' min sedan' : sameDay(d, new Date()) ? 'idag ' + tm(d) : fmt(d, { day: 'numeric', month: 'short' }) + ' ' + tm(d); };
function feedStatus(sub) {
  const f = feedOf(sub.id);
  if (f.parsed) return f.parsed.events.length + (f.parsed.events.length === 1 ? ' händelse' : ' händelser') + ' · uppdaterad ' + relTime(f.at);
  return f.err || 'Hämtar…';
}
function openCalendars() {
  const body = h('div');
  const s = sheet({ title: 'Kalendrar', right: { label: 'Klar', strong: true, fn: (x) => x.close() }, body });
  const check = (c) => h('button', { type: 'button', class: 'cal-check', role: 'checkbox', 'aria-checked': String(visible(c.id)), 'aria-label': 'Visa ' + c.name, style: '--c:' + c.color,
    onclick: () => { state.hidden = visible(c.id) ? state.hidden.concat(c.id) : state.hidden.filter((x) => x !== c.id); save(); render(); draw(); } });
  function draw() {
    const all = calendars(), courses = all.filter((c) => c.course), mine = all.filter((c) => !c.course && !c.sub), links = all.filter((c) => c.sub);
    const nOver = Object.keys(state.over).length;
    body.replaceChildren(...[
      grp('SSE-schema', courses.map((c) => h('div', { class: 'row' }, check(c), h('span', { class: 'row-l grow' }, c.name),
        c.course.groups ? (() => { const sel = h('select', { class: 'pick', 'aria-label': 'Seminariegrupp i ' + c.short }, h('option', { value: '' }, 'Ingen grupp'), range(c.course.groups).map((i) => h('option', { value: i + 1 }, 'Grupp ' + (i + 1))));
          sel.value = state.groups[c.course.id] || ''; sel.addEventListener('change', () => { if (sel.value) state.groups[c.course.id] = +sel.value; else delete state.groups[c.course.id]; save(); render(); }); return sel; })() : null))),
      h('div', { class: 'legend' }, h('span', null, h('i'), 'Föreläsning'), h('span', null, h('i', { class: 'solid' }), 'Seminarium och tenta'), h('span', null, h('i', { class: 'dash' }), 'Inlämning')),
      h('p', { class: 'note' }, schedule ? 'Schemat kommer från ' + schedule.source + '. Seminarier visas för din grupp. Canvas gäller om något har ändrats.' : 'Schemat kunde inte laddas. Kontrollera uppkopplingen.'),
      nOver ? h('button', { type: 'button', class: 'big-btn', onclick: () => { mutate(() => { state.over = {}; }, 'Schemat återställt'); draw(); } }, 'Återställ ' + nOver + (nOver === 1 ? ' ändrad schemahändelse' : ' ändrade schemahändelser')) : null,
      grp('Mina kalendrar', mine.map((c) => h('div', { class: 'row' }, check(c), h('span', { class: 'row-l grow' }, c.name),
        state.cals.length > 1 && !state.events.some((e) => e.cal === c.id && !e.del) ? h('button', { type: 'button', class: 'link danger', onclick: () => { state.cals = state.cals.filter((x) => x.id !== c.id); save(); render(); draw(); } }, 'Ta bort') : null)),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: () => {
          const name = (prompt('Vad ska kalendern heta?') || '').trim(); if (!name) return;
          state.cals.push({ id: uid('k'), name: name.slice(0, 30), color: PALETTE.find((p) => !calendars().some((c) => c.color === p)) || PALETTE[state.cals.length % PALETTE.length] }); save(); draw(); } }, 'Lägg till kalender'))),
      grp('Kalenderlänkar', links.map((c) => h('div', { class: 'row' }, check(c),
        h('button', { type: 'button', class: 'row-l grow', onclick: () => openLink(c.sub) }, c.name, h('small', null, feedStatus(c.sub))), chevron())),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: () => openLink(null) }, 'Lägg till kalenderlänk'))),
      h('p', { class: 'note' }, 'Klistra in en prenumerationslänk (ICS eller webcal) från till exempel Google Kalender, Outlook, Canvas eller TimeEdit. Händelserna hämtas sedan automatiskt och går inte att ändra här.')].filter(Boolean));
  }
  calDraw = () => { if (!body.isConnected) { calDraw = null; return; } if (!/INPUT|SELECT/.test((document.activeElement || {}).tagName || '')) draw(); };
  draw();
  return s;
}
/* add a calendar link (sub = null), or change one */
function openLink(sub) {
  const isNew = !sub;
  let color = isNew ? PALETTE.find((p) => !calendars().some((c) => c.color === p)) || PALETTE[(state.subs.length + 2) % PALETTE.length] : sub.color;
  const url = h('input', { type: 'url', class: 'in', placeholder: 'https:// eller webcal://', value: isNew ? '' : sub.url, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url', 'aria-label': 'Kalenderlänk' });
  const name = h('input', { type: 'text', class: 'in', placeholder: isNew ? 'Namn (valfritt)' : 'Namn', value: isNew ? '' : sub.name, maxlength: 40, 'aria-label': 'Namn' });
  const msg = h('p', { class: 'note err', role: 'alert', hidden: true });
  const colors = h('div', { style: 'flex:1;display:flex' });
  const drawColors = () => colors.replaceChildren(swatches(PALETTE.map((c) => [c, c]), color, (c) => { color = c; drawColors(); }, 'Färg'));
  drawColors();
  const f = isNew ? null : feedOf(sub.id);
  function done(x) {
    const u = url.value.trim();
    if (!/^(https?|webcals?):\/\/[^\s/]+\/\S*$/i.test(u)) { msg.textContent = 'Det där ser inte ut som en kalenderlänk. Den ska börja med https:// eller webcal://.'; msg.hidden = false; return; }
    if (isNew && state.subs.some((s) => httpsUrl(s.url) === httpsUrl(u))) { msg.textContent = 'Den länken finns redan.'; msg.hidden = false; return; }
    let host = 'Kalender'; try { host = new URL(httpsUrl(u)).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
    const n = name.value.trim();
    x.close();
    if (isNew) {
      const item = { id: uid('f'), name: n || host, url: u, color }; if (!n) item.auto = true;
      mutate(() => { state.subs.push(item); });
      toast('Kalenderlänken är tillagd. Hämtar…');
      refreshFeeds(true).then(() => { const ff = feedOf(item.id); toast(ff.parsed ? ff.parsed.events.length + ' händelser hämtade' : sync.on ? 'Länken hämtas via GitHub. Det brukar ta någon minut.' : 'Länken kan inte hämtas direkt. Slå på synk under Inställningar.'); });
    } else {
      const changedUrl = httpsUrl(u) !== httpsUrl(sub.url);
      mutate(() => { const it = state.subs.find((s) => s.id === sub.id); if (!it) return; it.name = n || it.name; it.color = color; it.url = u; delete it.auto; });
      if (changedUrl) { const ff = feedOf(sub.id); ff.parsed = null; ff.at = 0; ff.via = ''; ff.memo.clear(); try { localStorage.removeItem(LS_FEED + sub.id); } catch (e) { /* ignore */ } render(); refreshFeeds(true); }
    }
    if (calDraw) calDraw();
  }
  const s = sheet({ title: isNew ? 'Ny kalenderlänk' : 'Kalenderlänk', left: { label: 'Avbryt', fn: (x) => x.close() }, right: { label: isNew ? 'Lägg till' : 'Klar', strong: true, fn: done }, body: [
    grp('Länk', row(null, url)),
    isNew && h('p', { class: 'note' }, 'I Google Kalender heter den ”Hemlig adress i iCal-format”, i Outlook ”Publicera kalender” (ICS) och i Canvas ”Kalenderflöde”. Länken sparas bara hos dig, och i ditt privata GitHub-repo om synk är på.'),
    grp('Namn och färg', row(null, name), h('div', { class: 'row' }, colors)),
    !isNew && h('p', { class: 'note' + (f.err && !f.parsed ? ' err' : '') }, f.parsed ? cap(feedStatus(sub)) + (f.via === 'repo' ? '. Hämtas via GitHub-repot ungefär varannan timme.' : '.') : f.err || 'Inte hämtad än.'),
    msg,
    !isNew && h('button', { type: 'button', class: 'big-btn', onclick: () => { s.close(); toast('Uppdaterar…'); refreshFeeds(true).then(() => toast(feedOf(sub.id).parsed ? 'Uppdaterad' : feedOf(sub.id).err || 'Kunde inte hämtas')); } }, 'Uppdatera nu'),
    !isNew && h('button', { type: 'button', class: 'big-btn danger', onclick: () => { s.close(); mutate(() => { state.subs = state.subs.filter((x) => x.id !== sub.id); state.hidden = state.hidden.filter((x) => x !== 's:' + sub.id); }, 'Kalenderlänken borttagen'); refreshFeeds(); if (calDraw) calDraw(); } }, 'Ta bort länken'),
  ] });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(s); } });
  if (isNew) setTimeout(() => url.focus(), 80);
}

/* ---------- settings ---------- */
function openSettings() {
  const body = h('div'), syncBox = h('div');
  sheet({ title: 'Inställningar', cls: 'tall', right: { label: 'Klar', strong: true, fn: (x) => x.close() }, body });
  const pick = (key, options, cast) => {
    const el = h('select', { class: 'pick' }, options.map(([v, l]) => h('option', { value: String(v) }, l))); el.value = String(pref(key));
    el.addEventListener('change', () => setPref(key, cast ? cast(el.value) : el.value)); return el;
  };
  const flip = (key) => { const el = h('input', { type: 'checkbox', class: 'sw', checked: !!pref(key) }); el.addEventListener('change', () => setPref(key, el.checked)); return el; };
  function drawSync() {
    const st = sync.status;
    if (!st.on) {
      syncBox.replaceChildren(grp('Synk mellan enheter', h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: openSync }, 'Slå på synk'))),
        h('p', { class: 'note' }, 'Samma kalender på mobilen och datorn. Den sparas då i ett privat repo på ditt GitHub-konto, och kalenderlänkar som inte går att hämta direkt hämtas den vägen.'));
      return;
    }
    const text = st.state === 'busy' ? 'Synkar…' : st.state === 'offline' ? 'Ingen uppkoppling' : st.state === 'error' ? 'Synken har stannat' : st.at ? 'Synkad ' + relTime(st.at) : 'Inte synkad än';
    syncBox.replaceChildren(grp('Synk mellan enheter',
      h('div', { class: 'row' }, h('span', { class: 'row-l grow' + (st.state === 'error' ? ' err' : ''), role: 'status' }, text), h('button', { type: 'button', class: 'link', disabled: st.state === 'busy', onclick: () => sync.now() }, 'Synka nu')),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'link danger', onclick: async () => {
        const i = await choose('Sluta synka på den här enheten? Dina händelser finns kvar här och på GitHub.', [{ label: 'Koppla från', danger: true }]);
        if (i === 0) { sync.disconnect(); toast('Synken är avstängd på den här enheten'); } } }, 'Koppla från'))),
      h('p', { class: 'note' + (st.state === 'error' ? ' err' : '') }, st.state === 'error' ? st.error : st.state === 'offline' ? 'Ändringar sparas här och skickas när du är uppkopplad igen.' : 'Synkar med ' + st.repo + ' på GitHub. Ändringar skickas efter ett par sekunder.'));
  }
  syncDraw = () => { if (!body.isConnected) { syncDraw = null; return; } drawSync(); };
  function draw() {
    let aiKey = ''; try { aiKey = localStorage.getItem('kalender-ai-key') || ''; } catch (e) { /* ignore */ }
    const keyIn = h('input', { type: 'password', class: 'in', placeholder: 'sk-ant-…', autocomplete: 'off', value: aiKey, 'aria-label': 'Anthropic API-nyckel' });
    keyIn.addEventListener('change', () => { try { const v = keyIn.value.trim(); if (v) localStorage.setItem('kalender-ai-key', v); else localStorage.removeItem('kalender-ai-key'); toast(v ? 'Nyckeln sparad på den här enheten' : 'Nyckeln borttagen'); } catch (e) { /* ignore */ } });
    body.replaceChildren(
      grp('Utseende',
        h('div', { class: 'row' }, segment([['auto', 'Automatiskt'], ['light', 'Ljust'], ['dark', 'Mörkt']], state.theme || 'auto', (k) => { state.theme = k; persist(); applyTheme(); }, 'Utseende')),
        h('div', { class: 'row' }, h('span', { class: 'row-l' }, 'Färg'), swatches(ACCENTS, pref('accent'), (k) => { setPref('accent', k); draw(); }, 'Accentfärg'))),
      grp('Kalender',
        row('Veckan börjar på', pick('weekStart', [[1, 'Måndag'], [0, 'Söndag'], [6, 'Lördag']], Number)),
        row('Visa veckonummer', flip('weekNums')),
        row('Öppna appen i', pick('open', [['last', 'Senaste vyn'], ['list', 'Lista'], ['day', 'Dag'], ['week', 'Vecka'], ['month', 'Månad']])),
        row('Dagar i veckovyn', pick('days', [['auto', 'Automatiskt'], ['3', '3 dagar'], ['5', 'Måndag–fredag'], ['7', 'Hela veckan']])),
        row('24-timmarsklocka', flip('h24'))),
      h('p', { class: 'note' }, 'Automatiskt visar tre dagar på mobilen och hela veckan på större skärmar.'),
      grp('Dagens tider',
        row('Dagen börjar', pick('dayStart', range(13).map((i) => [i, tmMin(i * 60)]), Number)),
        row('Radhöjd', pick('density', [['compact', 'Kompakt'], ['normal', 'Normal'], ['large', 'Stor']])),
        row('Tona ner det som har varit', flip('dimPast'))),
      grp('Nya händelser',
        row('Längd', pick('dur', [[15, '15 minuter'], [30, '30 minuter'], [45, '45 minuter'], [60, '1 timme'], [90, '1,5 timme'], [120, '2 timmar']], Number)),
        row('Kalender', pick('cal', [['last', 'Senast använda']].concat(state.cals.map((c) => [c.id, c.name]))))),
      syncBox,
      grp('AI-assistent', row(null, keyIn)),
      h('p', { class: 'note' }, 'Assistenten använder din egen nyckel från console.anthropic.com. Den sparas bara på den här enheten och skickas bara till Anthropic.'),
      grp('Säkerhetskopia', h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: exportData }, 'Exportera mina händelser')),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'link', onclick: importData }, 'Importera från fil'))),
      h('p', { class: 'note' }, 'Kalender ' + VERSION + (schedule ? ' · schema ' + schedule.version : '') + '. Inställningarna här gäller den här enheten.'));
    drawSync();
  }
  draw();
}
/* switching sync on: the user makes a key on GitHub that reaches only the data repo, and pastes it here */
function openSync() {
  const key = h('input', { type: 'password', class: 'in', placeholder: 'github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Nyckel från GitHub' });
  const msg = h('p', { class: 'note err', role: 'alert', hidden: true });
  let working = false;
  async function connect(x) {
    if (working) return;
    working = true; msg.hidden = true; const btn = x.el.querySelector('.bar-btn.r'); btn.textContent = 'Kopplar…'; btn.disabled = true;
    try { await sync.connect(key.value); x.close(); toast('Synken är på'); if (syncDraw) syncDraw(); refreshFeeds(true); }
    catch (e) { msg.textContent = e && e.kind ? e.message : 'Det gick inte att koppla. Försök igen.'; msg.hidden = false; if (!(e && e.kind)) console.error(e); }
    finally { working = false; btn.textContent = 'Koppla'; btn.disabled = false; }
  }
  const s = sheet({ title: 'Synk', left: { label: 'Avbryt', fn: (x) => x.close() }, right: { label: 'Koppla', strong: true, fn: connect }, body: [
    h('p', { class: 'lead' }, 'Samma kalender på alla enheter'),
    h('p', { class: 'note center' }, 'Kalendern sparas i ditt privata GitHub-repo kalender-data. Gör så här på varje enhet du vill synka.'),
    grp('1. Skapa en nyckel', h('div', { class: 'row' }, h('a', { class: 'link', href: TOKEN_URL, target: '_blank', rel: 'noopener' }, 'Öppna GitHub'))),
    h('p', { class: 'note' }, 'Logga in. Under Repository access väljer du ”Only select repositories” och kalender-data. Tryck Generate token och kopiera nyckeln. Samma nyckel fungerar på flera enheter, men GitHub visar den bara en gång.'),
    grp('2. Klistra in nyckeln', row(null, key)),
    h('p', { class: 'note' }, 'Nyckeln sparas bara på den här enheten och skickas bara till GitHub. Den kommer bara åt kalender-data.'),
    msg] });
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(s); } });
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
      const snap = snapshot(); state = Object.assign(blank(), j); save(); applyTheme(); render(); refreshFeeds();
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
    const hits = all.filter((o) => (o.title + ' ' + o.loc + ' ' + o.notes + ' ' + (o.course || '') + ' ' + (KIND[o.kind] || '')).toLowerCase().includes(q));
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
  const pickGroup = (g) => { for (const c of schedule.courses) if (c.groups) { if (g) state.groups[c.id] = g; } state.onboarded = true; save(); s.close(); render(); if (g) toast('Grupp ' + g + ' vald. Ändra per kurs under Kalendrar.'); };
  const s = sheet({ title: 'Välkommen', right: { label: 'Hoppa över', fn: () => pickGroup(0) }, body: [
    h('p', { class: 'lead' }, 'Vilken seminariegrupp går du i?'),
    h('p', { class: 'note center' }, 'Då hämtas rätt tid och sal för dina seminarier i ' + schedule.courses.filter((c) => c.groups).map((c) => c.code).join(', ') + '.'),
    h('div', { class: 'gp' }, range(8).map((i) => h('button', { type: 'button', onclick: () => pickGroup(i + 1) }, i + 1)))] });
}

/* ---------- assistant ---------- */
const api = {
  h, sheet, grp, row, toast, render, save, snapshot, restore, calendars, calOf, findOcc, freeSlots, applyNew, applyEdit, applyDelete,
  occurrences, fromLocal, toLocal, ymd, hm, addDays, dayStart, fmtDay, fmtShort, openCalendars, openSettings, openDetail, refreshFeeds, feedOf, pref, setPref, go,
  get state() { return state; }, get ui() { return ui; }, get sync() { return sync; },
};
window.kalender = api;   /* handy in the browser console */
async function openAI() {
  try { const m = await import('./ai.js'); m.openAssistant(api); }
  catch (e) { console.error(e); toast('Assistenten kunde inte laddas'); }
}

/* ---------- wiring ---------- */
$('#prev').addEventListener('click', () => go(-1));
$('#next').addEventListener('click', () => go(1));
$('#today').addEventListener('click', () => { const t = today(), dir = Math.sign(t - dayStart(ui.date)); ui.date = t; ui.rescroll = true; render(dir || undefined); });
$('#add').addEventListener('click', () => newEventAt());
$('#cals').addEventListener('click', openCalendars);
$('#settings').addEventListener('click', openSettings);
$('#search').addEventListener('click', openSearch);
$('#ai').addEventListener('click', openAI);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (drag) endDrag(true); else if (openSheets.length) openSheets[openSheets.length - 1].close(); return; }
  if (openSheets.length || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 't') $('#today').click(); else if (e.key === 'n') newEventAt();
  else if (e.key.length === 1 && 'ldvm'.includes(e.key)) { const v = { l: 'list', d: 'day', v: 'week', m: 'month' }[e.key]; if (v !== ui.view) { ui.view = v; ui.rescroll = true; render('fade'); } }
});
let lastTick = new Date();
setInterval(() => { updateNow(); if (!sameDay(lastTick, new Date())) { lastTick = new Date(); render(); } }, 30000);
window.addEventListener('resize', updateNow);
narrow.addEventListener('change', () => render());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateNow(); loadSchedule(); sync.poll(); refreshFeeds(); } });
window.addEventListener('online', () => { sync.poll(); refreshFeeds(); });
setInterval(() => sync.poll(), 60000);          /* picks up what other devices saved; GitHub answers "nothing new" for free */
setInterval(() => { if (!document.hidden) refreshFeeds(); }, 10 * 60000);

async function loadSchedule() {
  try {
    const r = await fetch('data/schedule.json', { cache: 'no-cache' }); if (!r.ok) return;
    const j = await r.json(); const changed = JSON.stringify(j) !== JSON.stringify(schedule);
    if (changed) { schedule = j; courseCache = null; try { localStorage.setItem(LS_SCHED, JSON.stringify(j)); } catch (e) { /* ignore */ } render(); }
  } catch (e) { /* offline: keep the copy we have */ }
  onboard();
}
applyTheme();
render();
loadSchedule();
sync.poll();
refreshFeeds();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
