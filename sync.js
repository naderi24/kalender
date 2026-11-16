/* Sync between devices through one JSON file in a private GitHub repo (<user>/kalender-data, file kalender.json).

   The file is a "doc": four collections whose entries each carry the time they last changed,
     { app:'kalender', v:2, events:{id:{u,v}}, over:{key:{u,v}}, cals:{id:{u,v}}, subs:{id:{u,v}}, set:{groups:{u,v}, hidden:{u,v}} }
   u = time of the last change (ms), v = the value, or null when the thing was deleted.
   Two docs merge entry by entry: the newer one wins, and on a tie the copy on GitHub wins, so every device ends up the same.
   Nothing is ever dropped from the file; a deleted entry stays as {u, v:null} so an old device cannot bring it back.

   The same repo also relays calendar links: the app writes the list to feeds.json, a GitHub Actions workflow there
   downloads each link to feeds/<id>.ics, and the app reads those files (readFile/writeFile below). */

const API = 'https://api.github.com', FILE = 'kalender.json', REPO_NAME = 'kalender-data', LS_CFG = 'kalender-sync';
const COLS = ['events', 'over', 'cals', 'subs', 'set'];
const DOC_V = 2;       /* 2 added subs; a device still on version 1 refuses to write rather than drop them */
export const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Kalender-synk&description=' +
  encodeURIComponent('Låter Kalender-appen läsa och skriva i ' + REPO_NAME) + '&contents=write&expires_in=none';

/* JSON with the keys in a fixed order, so equal values always give equal text */
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const clone = (v) => JSON.parse(JSON.stringify(v));
export const emptyDoc = () => ({ app: 'kalender', v: DOC_V, events: {}, over: {}, cals: {}, subs: {}, set: {} });

/* ---------- state <-> doc ---------- */
export function toDoc(s) {
  const d = emptyDoc(), ou = s.ou || {}, cu = s.cu || {}, fu = s.fu || {}, su = s.su || {};
  for (const ev of s.events) {
    if (ev.del) d.events[ev.id] = { u: ev.upd || 0, v: null };
    else { const v = { ...ev }; delete v.upd; d.events[ev.id] = { u: ev.upd || 0, v }; }
  }
  for (const k of new Set([...Object.keys(s.over), ...Object.keys(ou)])) d.over[k] = { u: ou[k] || 0, v: s.over[k] || null };
  for (const c of s.cals) d.cals[c.id] = { u: cu[c.id] || 0, v: c };
  for (const k of Object.keys(cu)) if (!d.cals[k]) d.cals[k] = { u: cu[k], v: null };
  for (const c of (s.subs || [])) d.subs[c.id] = { u: su[c.id] || 0, v: c };
  for (const k of Object.keys(su)) if (!d.subs[k]) d.subs[k] = { u: su[k], v: null };
  d.set.groups = { u: fu.groups || 0, v: s.groups || {} };
  d.set.hidden = { u: fu.hidden || 0, v: s.hidden || [] };
  return clone(d);     /* a doc never shares objects with the state it was read from */
}
/* writes a doc into the state object; things keep the order they already had, new ones go last */
export function applyDoc(s, d) {
  d = clone(d);
  const inOrder = (have, col) => { const seen = new Set(have); return have.filter((k) => col[k]).concat(Object.keys(col).filter((k) => !seen.has(k)).sort()); };
  s.events = inOrder(s.events.map((e) => e.id), d.events).map((id) => { const e = d.events[id]; return e.v ? { ...e.v, id, upd: e.u } : { id, del: true, upd: e.u }; });
  s.over = {}; s.ou = {};
  for (const k of Object.keys(d.over)) { s.ou[k] = d.over[k].u; if (d.over[k].v) s.over[k] = d.over[k].v; }
  const cals = []; s.cu = {};
  for (const id of inOrder(s.cals.map((c) => c.id), d.cals)) { s.cu[id] = d.cals[id].u; if (d.cals[id].v) cals.push({ ...d.cals[id].v, id }); }
  s.cals = cals;
  const subs = []; s.su = {};
  for (const id of inOrder((s.subs || []).map((c) => c.id), d.subs || {})) { s.su[id] = d.subs[id].u; if (d.subs[id].v) subs.push({ ...d.subs[id].v, id }); }
  s.subs = subs;
  s.fu = {};
  if (d.set.groups) { s.groups = d.set.groups.v || {}; s.fu.groups = d.set.groups.u; }
  if (d.set.hidden) { s.hidden = d.set.hidden.v || []; s.fu.hidden = d.set.hidden.u; }
  return s;
}
/* marks what differs from `known` (the doc as it was at the last save) as changed now; things that vanished become deletions */
export function stampDoc(d, known, now) {
  for (const c of COLS) {
    if (!d[c]) d[c] = {};
    for (const k of new Set([...Object.keys(d[c]), ...Object.keys(known[c] || {})])) {
      const cur = d[c][k], old = known[c] && known[c][k];
      if (!cur) d[c][k] = old.v != null ? { u: now, v: null } : old;
      else if (!old) { if (cur.v != null && !cur.u) cur.u = now; }
      else if (stable(cur.v) !== stable(old.v)) cur.u = now;
      else if (cur.u < old.u) cur.u = old.u;
    }
  }
  return d;
}
export function mergeDocs(local, remote) {
  const doc = emptyDoc();
  for (const c of COLS) {
    const a = local[c] || {}, b = remote[c] || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) doc[c][k] = !a[k] ? b[k] : !b[k] ? a[k] : (b[k].u >= a[k].u ? b[k] : a[k]);
  }
  const text = stable(doc);
  return { doc, localChanged: text !== stable(pick(local)), remoteChanged: text !== stable(pick(remote)) };
}
const pick = (d) => ({ app: 'kalender', v: DOC_V, events: d.events || {}, over: d.over || {}, cals: d.cals || {}, subs: d.subs || {}, set: d.set || {} });
function checkDoc(d) {
  if (!d || typeof d !== 'object' || d.app !== 'kalender') throw new SyncError('Filen i ' + REPO_NAME + ' är inte en kalenderfil.', 'data');
  if (d.v > DOC_V) throw new SyncError('Kalendern är sparad av en nyare version av appen. Ladda om sidan.', 'data');
  for (const c of COLS) {
    if (d[c] == null) d[c] = {};
    if (typeof d[c] !== 'object' || Array.isArray(d[c])) throw new SyncError('Filen i ' + REPO_NAME + ' är skadad.', 'data');
    for (const k of Object.keys(d[c])) { const e = d[c][k]; if (!e || typeof e !== 'object' || typeof e.u !== 'number') throw new SyncError('Filen i ' + REPO_NAME + ' är skadad.', 'data'); }
  }
  return pick(d);
}

/* ---------- GitHub ---------- */
export class SyncError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }
const b64encode = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s); };
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(token, method, path, { body, etag, raw } = {}) {
  const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' };
  if (body) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  let r;
  /* no-store: GitHub lets browsers reuse an answer for a minute, which would hide what another device just saved */
  try { r = await fetch(API + path, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new SyncError('Ingen kontakt med GitHub.', 'offline'); }
  if (r.status === 401) throw new SyncError('Nyckeln gäller inte längre. Koppla synken på nytt med en ny nyckel.', 'auth');
  if (r.status === 403 || r.status === 429) {
    if (r.headers.get('X-RateLimit-Remaining') === '0' || r.headers.get('Retry-After')) throw new SyncError('GitHub tar en paus. Synken fortsätter om en stund.', 'rate');
    throw new SyncError('Nyckeln får inte skriva i ' + REPO_NAME + '. Den behöver Contents: Read and write.', 'perm');
  }
  if (r.status >= 500) throw new SyncError('GitHub svarar inte just nu.', 'offline');
  return r;
}

/* host: { getDoc(), adopt(doc), busy(), onStatus(status) } */
export function createSync(host) {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch (e) { /* ignore */ }
  if (cfg && !(cfg.token && cfg.repo)) cfg = null;
  const status = { on: !!cfg, state: 'idle', kind: '', at: (cfg && cfg.at) || 0, error: '', repo: cfg ? cfg.repo : '' };
  let running = false, queued = false, timer = null, cache = null, etag = null;
  const keep = () => { try { if (cfg) localStorage.setItem(LS_CFG, JSON.stringify(cfg)); else localStorage.removeItem(LS_CFG); } catch (e) { /* ignore */ } };
  const set = (state, error, kind) => { status.on = !!cfg; status.state = state; status.error = error || ''; status.kind = kind || ''; status.at = (cfg && cfg.at) || 0; status.repo = cfg ? cfg.repo : ''; host.onStatus(status); };
  const filePath = () => '/repos/' + cfg.repo + '/contents/' + FILE;

  async function pull() {
    const r = await gh(cfg.token, 'GET', filePath(), { etag: cache ? etag : null });
    if (r.status === 304 && cache) return cache;
    if (r.status === 404) { etag = null; return (cache = { doc: emptyDoc(), sha: null }); }
    if (!r.ok) throw new SyncError('GitHub svarade ' + r.status + '.', 'http');
    const j = await r.json();
    let text = j.content ? b64decode(j.content) : '';
    if (!text && j.size) { const rr = await gh(cfg.token, 'GET', filePath(), { raw: true }); text = await rr.text(); }   /* over 1 MB */
    let doc;
    try { doc = text.trim() ? JSON.parse(text) : emptyDoc(); } catch (e) { throw new SyncError('Filen i ' + REPO_NAME + ' går inte att läsa.', 'data'); }
    etag = r.headers.get('ETag');
    return (cache = { doc: checkDoc(doc), sha: j.sha });
  }
  async function push(doc, sha) {
    const body = { message: 'Kalender: synk', content: b64encode(JSON.stringify(doc, null, 1) + '\n') };
    if (sha) body.sha = sha;
    const r = await gh(cfg.token, 'PUT', filePath(), { body });
    if (r.status === 409 || r.status === 422) return false;      /* someone else saved in between: read again and retry */
    if (r.status === 404) throw new SyncError('Hittar inte ' + cfg.repo + ', eller så når nyckeln inte dit.', 'perm');
    if (!r.ok) throw new SyncError('GitHub svarade ' + r.status + '.', 'http');
    const j = await r.json();
    cache = { doc, sha: j.content.sha }; etag = null;
    return true;
  }
  /* any other text file in the repo: null when it is not there */
  async function readFile(path) {
    if (!cfg) return null;
    const r = await gh(cfg.token, 'GET', '/repos/' + cfg.repo + '/contents/' + path);
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncError('GitHub svarade ' + r.status + '.', 'http');
    const j = await r.json();
    if (j.content) return { text: b64decode(j.content), sha: j.sha };
    if (!j.size) return { text: '', sha: j.sha };
    const rr = await gh(cfg.token, 'GET', '/repos/' + cfg.repo + '/contents/' + path, { raw: true });        /* over 1 MB */
    return { text: await rr.text(), sha: j.sha };
  }
  async function writeFile(path, text, message) {
    if (!cfg) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await readFile(path);
      if (cur && cur.text === text) return true;
      const body = { message: message || 'Kalender: ' + path, content: b64encode(text) };
      if (cur) body.sha = cur.sha;
      const r = await gh(cfg.token, 'PUT', '/repos/' + cfg.repo + '/contents/' + path, { body });
      if (r.ok) return true;
      if (r.status !== 409 && r.status !== 422) throw new SyncError('GitHub svarade ' + r.status + '.', 'http');
      await sleep(400);
    }
    return false;
  }
  /* the first sync on a device: settings already on GitHub win over the ones here, unless GitHub has none */
  function firstTime(local, remote) {
    for (const k of ['groups', 'hidden']) {
      const r = remote.set[k], l = local.set[k]; if (!l) continue;
      const has = (e) => e && e.v && Object.keys(e.v).length > 0;
      if (has(r)) l.u = 0; else if (has(l) && !l.u) l.u = Date.now();
    }
  }
  async function run() {
    if (!cfg) return false;
    if (running) { queued = true; return false; }
    if (host.busy()) { later(900); return false; }
    running = true; set('busy');
    let ok = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const remote = await pull();
        if (!cfg) return false;
        const local = host.getDoc();
        if (cfg.first) firstTime(local, remote.doc);
        const m = mergeDocs(local, remote.doc);
        if (m.localChanged) host.adopt(m.doc);
        if (!m.remoteChanged || await push(m.doc, remote.sha)) break;
        cache = null; etag = null;
        if (attempt >= 3) throw new SyncError('Kunde inte spara till GitHub. Försöker igen snart.', 'conflict');
        await sleep(350 * (attempt + 1));
      }
      if (!cfg) return false;
      delete cfg.first; cfg.at = Date.now(); keep(); set('idle'); ok = true;
    } catch (e) {
      if (!(e instanceof SyncError)) console.error(e);
      if (cfg) set(e.kind === 'offline' ? 'offline' : 'error', e instanceof SyncError ? e.message : 'Synken gick fel.', e.kind);
    } finally {
      running = false;
      if (queued) { queued = false; later(300); }
    }
    return ok;
  }
  function later(ms) { clearTimeout(timer); timer = setTimeout(run, ms); }

  return {
    status,
    get on() { return !!cfg; },
    changed() { if (cfg) later(2000); },          /* a local change: push shortly, so a burst of edits becomes one save */
    now() { clearTimeout(timer); return run(); },
    poll() { if (cfg && !running && !document.hidden && navigator.onLine !== false && status.kind !== 'auth' && status.kind !== 'data') run(); },
    async connect(token) {
      token = String(token || '').trim();
      if (!token) throw new SyncError('Klistra in nyckeln först.', 'auth');
      let r;
      try { r = await gh(token, 'GET', '/user'); } catch (e) { if (e.kind === 'auth') throw new SyncError('GitHub känner inte igen nyckeln. Kopiera den en gång till.', 'auth'); throw e; }
      if (!r.ok) throw new SyncError('GitHub svarade ' + r.status + '.', 'http');
      const login = (await r.json()).login;
      const repo = login + '/' + REPO_NAME;
      r = await gh(token, 'GET', '/repos/' + repo);
      if (r.status === 404) throw new SyncError('Nyckeln når inte ' + repo + '. Välj ”Only select repositories” och ' + REPO_NAME + ' när du skapar den.', 'perm');
      if (!r.ok) throw new SyncError('GitHub svarade ' + r.status + '.', 'http');
      cfg = { token, repo, first: true, at: 0 }; cache = null; etag = null; keep();
      const ok = await run();
      if (!ok) { const msg = status.error || 'Synken gick fel.'; cfg = null; keep(); set('idle'); throw new SyncError(msg, 'http'); }
      return repo;
    },
    readFile: async (path) => { const f = await readFile(path); return f ? f.text : null; },
    writeFile,
    disconnect() { clearTimeout(timer); cfg = null; cache = null; etag = null; keep(); set('idle'); },
  };
}
