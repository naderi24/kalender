/* Builds data/schedule.json from the SSE Trainers timetables (courses/<id>/js/c-schedule.js in that artifact).
   Usage: node tools/build_schedule.mjs <folder with courses/be202/js/c-schedule.js etc.>
   Every seminar keeps the slots of all eight groups; the app picks the user's group at run time. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) { console.error('Give the folder that holds courses/<id>/js/c-schedule.js'); process.exit(1); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'schedule.json');

function load(id) {
  const src = fs.readFileSync(path.join(root, 'courses', id, 'js', 'c-schedule.js'), 'utf8');
  const win = { DA: {} };
  vm.runInNewContext(src, { window: win });
  return win.DA;
}
const iso = (s) => new Date(s).toISOString().replace('.000Z', 'Z');
const addMin = (s, m) => iso(new Date(s).getTime() + m * 60000);
const note = (e) => [e.brief, ...(e.know || []).map((k) => '• ' + k)].filter(Boolean).join('\n');

const META = {
  be202: { code: 'BE202', name: 'Strategy', color: '#34c759' },
  be802: { code: 'BE802', name: 'Global Challenges II', color: '#5856d6' },
  be603: { code: 'BE603', name: 'Data Analytics III', color: '#ff9500' },
};

const courses = [];
for (const id of Object.keys(META)) {
  const DA = load(id), D = DA.schedule, ev = [];
  for (const l of D.lectures) {
    ev.push({ id: 'L' + l.n, kind: 'lecture', short: 'L' + l.n, title: 'Lecture ' + l.n + (l.title && !/^Lecture \d+$/.test(l.title) ? ': ' + l.title : ''),
      start: iso(l.start), end: iso(l.end), room: l.room, note: note(l) });
  }
  const otherStarts = new Set(D.other.map((o) => iso(o.start)));
  for (const s of D.seminars) {
    const slots = {};
    for (const g of Object.keys(s.slots)) {
      const v = s.slots[g];
      const start = s.date ? iso(s.date + 'T' + v[0] + ':00Z') : iso(v[0]);
      const slot = { start, end: addMin(start, v[2] || 105), room: v[1] };
      const t = id === 'be202' ? (s.n === 4 ? 'Yalan Wang' : s.n === 3 ? '' : (DA.teachers || [])[+g] || '') : '';
      if (t) slot.teacher = t;
      slots[g] = slot;
    }
    const label = s.short || 'S' + s.n;
    const name = /^CS/.test(label) ? 'Case Seminar ' + s.n : id === 'be202' && s.n === 3 ? 'Project tutorial' : id === 'be202' && s.n >= 7 ? 'Project seminar ' + (s.n - 6) : 'Seminar ' + s.n;
    const e = { id: 'S' + s.n, kind: 'seminar', short: label, title: name + ': ' + s.title, slots, note: note(s) };
    if (s.tba) e.note = 'Exact 20-minute slot for your team is posted on Canvas (19 or 20 Nov).\n' + e.note;
    /* team hand-ins: either a fixed time for every group, or 15:00 Stockholm time the day before your own seminar */
    if (s.due && !otherStarts.has(iso(s.due))) e.due = { at: iso(s.due), title: label + ' hand-in' };
    else if (s.handin === 'daybefore') e.due = { dayBefore: '15:00', title: label + ' hand-in' };
    ev.push(e);
  }
  D.other.forEach((o, i) => {
    const e = { id: 'O' + i, kind: o.kind, title: o.title, start: iso(o.start), note: o.note || '' };
    if (o.kind === 'exam') e.short = 'Tenta';
    if (o.end) e.end = iso(o.end);
    if (o.room) e.room = o.room;
    ev.push(e);
  });
  courses.push({ id, ...META[id], groups: 8, imported: D.imported, events: ev });
}

/* courses whose teaching is over: only the re-take dates the hub lists */
courses.push({ id: 'be102', code: 'BE102', name: 'Management II', color: '#af52de', groups: 0, imported: '2026-11-08', events: [
  { id: 'X', kind: 'exam', title: 'Re-take', allDay: '2027-01-18', note: 'Time and room not announced when this was imported. Check the exam portal.' } ] });
courses.push({ id: 'be302', code: 'BE302', name: 'Accounting II', color: '#a2845e', groups: 0, imported: '2026-11-08', events: [
  { id: 'X', kind: 'exam', title: 'Re-take (date not confirmed)', allDay: '2027-01-12', note: 'The date is the trainer’s guess from earlier years. Check Canvas and the exam office.' } ] });

const doc = { version: new Date().toISOString().slice(0, 10), source: 'SSE Trainers (hämtat från Canvas 27–28 okt 2026)', tz: 'Europe/Stockholm', courses };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 1));
console.log('wrote', out, courses.map((c) => c.code + ':' + c.events.length).join(' '));
