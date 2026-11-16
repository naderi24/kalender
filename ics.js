/* Reads calendar files (iCalendar, .ics) for the calendar links.
   parseICS(text)  -> { name, events }   a compact form that is also what gets cached on the device
   expandICS(parsed, from, to) -> occurrences between two dates, repeats included, as local Date objects

   Times are kept as "wall clock" numbers [y, m, d, H, M] plus the zone they are written in, and only turned into
   real moments when expanded, so a weekly 10:00 meeting stays at 10:00 across a daylight-saving change. */

const WINDOWS_TZ = { 'W. Europe Standard Time': 'Europe/Stockholm', 'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris', 'GMT Standard Time': 'Europe/London', 'FLE Standard Time': 'Europe/Helsinki', 'E. Europe Standard Time': 'Europe/Bucharest',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'Greenwich Standard Time': 'UTC', 'UTC': 'UTC', 'Z': 'UTC', 'Etc/UTC': 'UTC', 'GMT': 'UTC' };
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const unescape = (s) => String(s || '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
/* 'NAME;PARAM=x;P2="a:b":value' -> { name, params, value } */
function splitLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
  if (i >= line.length) return null;
  const head = line.slice(0, i).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/), params = {};
  for (const p of head.slice(1)) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}
/* '20261120T101500Z' -> { w:[2026,11,20,10,15], utc:true, date:false } */
function stamp(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(String(v).trim());
  if (!m) return null;
  return { w: [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0)], utc: !!m[7], date: !m[4] };
}
function zoneOf(params, st) {
  if (st.date) return '';
  if (st.utc) return 'UTC';
  const tz = params.TZID; if (!tz) return '';
  return WINDOWS_TZ[tz] || tz;
}
function duration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0));
}
function rule(v) {
  const r = {};
  for (const part of String(v).split(';')) { const [k, val] = part.split('='); if (k && val != null) r[k.toUpperCase()] = val; }
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(r.FREQ || '')) return null;
  const out = { f: r.FREQ[0], i: Math.max(1, +r.INTERVAL || 1) };
  if (r.COUNT) out.c = +r.COUNT;
  if (r.UNTIL) { const u = stamp(r.UNTIL); if (u) out.u = { w: u.w, utc: u.utc, date: u.date }; }
  if (r.BYDAY) out.bd = r.BYDAY.split(',').map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim()); return m && DAYS[m[2]] != null ? [m[1] ? +m[1] : 0, DAYS[m[2]]] : null; }).filter(Boolean);
  if (r.BYMONTHDAY) out.bm = r.BYMONTHDAY.split(',').map(Number).filter((n) => n && Math.abs(n) <= 31);
  if (r.BYMONTH) out.bmo = r.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12);
  if (r.WKST && DAYS[r.WKST] != null) out.ws = DAYS[r.WKST];
  return out;
}

export function parseICS(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = { name: '', events: [] };
  let ev = null, depth = 0;
  for (const raw of lines) {
    if (!raw) continue;
    const p = splitLine(raw); if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !ev) { ev = { ex: [] }; depth = 0; } else if (ev) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (ev && depth > 0) { depth--; continue; }
      if (ev && p.value.toUpperCase() === 'VEVENT') { finish(ev, out); ev = null; }
      continue;
    }
    if (!ev) { if (p.name === 'X-WR-CALNAME' && !out.name) out.name = unescape(p.value).trim(); continue; }
    if (depth > 0) continue;                       /* inside an alarm */
    switch (p.name) {
      case 'UID': ev.uid = p.value.trim(); break;
      case 'SUMMARY': ev.t = unescape(p.value).trim(); break;
      case 'LOCATION': ev.l = unescape(p.value).trim(); break;
      case 'DESCRIPTION': ev.n = unescape(p.value).trim(); break;
      case 'URL': ev.url = p.value.trim(); break;
      case 'STATUS': ev.st = p.value.trim().toUpperCase(); break;
      case 'DTSTART': { const s = stamp(p.value); if (s) { ev.s = s.w; ev.a = s.date; ev.z = zoneOf(p.params, s); } break; }
      case 'DTEND': { const s = stamp(p.value); if (s) { ev.e = s.w; ev.ez = zoneOf(p.params, s); } break; }
      case 'DURATION': ev.dur = duration(p.value); break;
      case 'RRULE': ev.r = rule(p.value); break;
      case 'EXDATE': for (const v of p.value.split(',')) { const s = stamp(v); if (s) ev.ex.push({ w: s.w, z: zoneOf(p.params, s), d: s.date }); } break;
      case 'RECURRENCE-ID': { const s = stamp(p.value); if (s) ev.rid = { w: s.w, z: zoneOf(p.params, s), d: s.date }; break; }
      default:
    }
  }
  return out;
}
function finish(ev, out) {
  if (!ev.s || ev.st === 'CANCELLED' && !ev.rid) return;
  if (out.events.length >= 6000) return;
  const e = { uid: ev.uid || 'x' + out.events.length, t: ev.t || '(utan titel)', s: ev.s };
  if (ev.a) e.a = 1;
  if (ev.z) e.z = ev.z;
  if (ev.e) { e.e = ev.e; if (ev.ez && ev.ez !== ev.z) e.ez = ev.ez; } else if (ev.dur) e.dur = ev.dur;
  if (ev.l) e.l = ev.l.slice(0, 300);
  if (ev.n) e.n = ev.n.slice(0, 2000);
  if (ev.url) e.url = ev.url.slice(0, 500);
  if (ev.r) e.r = ev.r;
  if (ev.ex.length) e.ex = ev.ex;
  if (ev.rid) e.rid = ev.rid;
  if (ev.st === 'CANCELLED') e.x = 1;
  out.events.push(e);
}

/* ---------- wall clock -> a real moment ---------- */
const fmts = new Map();
function offsetAt(tz, t) {
  let f = fmts.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
    catch (e) { f = null; }
    fmts.set(tz, f);
  }
  if (!f) return null;
  const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
export function toDate(w, z) {
  if (z === 'UTC') return new Date(Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4]));
  if (z) {
    const guess = Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4]);
    let off = offsetAt(z, guess);
    if (off != null) { const off2 = offsetAt(z, guess - off); return new Date(guess - (off2 == null ? off : off2)); }
  }
  return new Date(w[0], w[1] - 1, w[2], w[3], w[4]);          /* no zone, or one we do not know: the device's own time */
}

/* ---------- repeats ---------- */
const wallMs = (w) => Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4]);
const fromMs = (ms) => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]; };
const DAY = 864e5;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/* every start of the series as wall-clock ms (UTC used as a plain calendar), in order, between two wall-clock limits */
function* series(e, loMs, hiMs) {
  const r = e.r, s0 = wallMs(e.s), tod = s0 % DAY < 0 ? s0 % DAY + DAY : s0 % DAY, d0 = s0 - tod;
  const until = r.u ? (r.u.date ? wallMs(r.u.w) + DAY - 1 : Infinity) : Infinity;      /* a timed UNTIL is checked on the real moment by the caller */
  let n = 0;
  const ok = (ms) => ms >= s0 && ms <= until;
  if (r.f === 'D' || (r.f === 'W' && !r.bd)) {
    const step = (r.f === 'D' ? 1 : 7) * r.i * DAY;
    let k = 0;
    if (!r.c && loMs > s0) k = Math.max(0, Math.floor((loMs - s0) / step) - 1);
    for (let guard = 0; guard < 6000; guard++, k++) { const ms = s0 + k * step; if (ms > hiMs || ms > until) return; if (r.c && n >= r.c) return; n++; yield ms; }
    return;
  }
  if (r.f === 'W') {
    const ws = r.ws == null ? 1 : r.ws, dow0 = new Date(d0).getUTCDay();
    const weekStart = d0 - ((dow0 - ws + 7) % 7) * DAY;
    const offs = [...new Set(r.bd.map((b) => (b[1] - ws + 7) % 7))].sort((a, b) => a - b);
    let k = 0;
    if (!r.c && loMs > s0) k = Math.max(0, Math.floor((loMs - weekStart) / (7 * r.i * DAY)) - 1);
    for (let guard = 0; guard < 6000; guard++, k++) {
      for (const o of offs) { const ms = weekStart + k * 7 * r.i * DAY + o * DAY + tod; if (ms > hiMs || ms > until) return; if (!ok(ms)) continue; if (r.c && n >= r.c) return; n++; yield ms; }
    }
    return;
  }
  const [y0, m0, dd0] = e.s;
  for (let k = 0, guard = 0; guard < 2400; guard++, k++) {
    let y = y0, m = m0;
    if (r.f === 'M') { const t = (m0 - 1) + k * r.i; y = y0 + Math.floor(t / 12); m = t % 12 + 1; } else y = y0 + k * r.i;
    const months = r.f === 'Y' && r.bmo ? r.bmo : [m];
    const found = [];
    for (const mo of months) {
      const len = daysIn(y, mo);
      if (r.bd && (r.f === 'M' || r.bmo)) {
        for (const [ord, dow] of r.bd) {
          const all = []; for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === dow) all.push(d);
          if (!ord) found.push(...all.map((d) => [mo, d])); else { const d = ord > 0 ? all[ord - 1] : all[all.length + ord]; if (d) found.push([mo, d]); }
        }
      } else if (r.bm) { for (const b of r.bm) { const d = b > 0 ? b : len + b + 1; if (d >= 1 && d <= len) found.push([mo, d]); } }
      else if (dd0 <= len) found.push([mo, dd0]);
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [mo, d] of found) { const ms = Date.UTC(y, mo - 1, d) + tod; if (ms > hiMs || ms > until) return; if (!ok(ms)) continue; if (r.c && n >= r.c) return; n++; yield ms; }
    if (Date.UTC(y, 0, 1) > hiMs) return;
  }
}

const pad = (n) => String(n).padStart(2, '0');
export function expandICS(parsed, from, to) {
  const out = [];
  if (!parsed || !parsed.events) return out;
  /* single changed or cancelled occurrences of a series: the series itself must skip those moments */
  const moved = new Map();
  for (const e of parsed.events) if (e.rid) { if (!moved.has(e.uid)) moved.set(e.uid, new Set()); moved.get(e.uid).add(e.rid.d ? 'd' + e.rid.w.slice(0, 3).join('-') : +toDate(e.rid.w, e.rid.z)); }
  const lo = +from - 2 * DAY, hi = +to + 2 * DAY;
  for (const e of parsed.events) {
    if (e.x) continue;
    let lenMin;                                   /* length in minutes on the wall clock */
    if (e.e) lenMin = e.ez ? (toDate(e.e, e.ez) - toDate(e.s, e.z)) / 6e4 : (wallMs(e.e) - wallMs(e.s)) / 6e4;
    else lenMin = e.dur || (e.a ? 1440 : 0);
    if (e.a && lenMin < 1440) lenMin = 1440;
    if (lenMin < 0) lenMin = 0;
    const push = (w, isOcc) => {
      const start = e.a ? new Date(w[0], w[1] - 1, w[2]) : toDate(w, e.z);
      const end = e.a ? new Date(w[0], w[1] - 1, w[2] + Math.round(lenMin / 1440)) : e.ez ? new Date(+start + lenMin * 6e4) : toDate(fromMs(wallMs(w) + lenMin * 6e4), e.z);
      if (+end <= +from && !(+end === +start && +start >= +from) || +start >= +to) return;
      out.push({ uid: e.uid, key: e.uid + (isOcc || e.rid ? '@' + w[0] + '-' + pad(w[1]) + '-' + pad(w[2]) + (e.a ? '' : 'T' + pad(w[3]) + pad(w[4])) : ''),
        title: e.t, loc: e.l || '', notes: e.n || '', url: e.url || '', allDay: !!e.a, start, end, rec: !!(e.r || e.rid) });
    };
    if (!e.r) { push(e.s, false); continue; }
    const skip = moved.get(e.uid);
    const ex = new Set((e.ex || []).map((x) => (x.d ? 'd' + x.w.slice(0, 3).join('-') : +toDate(x.w, x.z))));
    const untilAt = e.r.u && !e.r.u.date ? +toDate(e.r.u.w, e.r.u.utc ? 'UTC' : e.z) : Infinity;
    for (const ms of series(e, lo - lenMin * 6e4, hi)) {
      const w = fromMs(ms), at = e.a ? null : +toDate(w, e.z), dkey = 'd' + w.slice(0, 3).join('-');
      if (at != null && at > untilAt) break;
      if (ex.has(dkey) || (at != null && ex.has(at))) continue;
      if (skip && (skip.has(dkey) || (at != null && skip.has(at)))) continue;
      push(w, true);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
