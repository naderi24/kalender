/* The assistant: a small chat that reads and changes the calendar through tools.
   Runs in the browser with the user's own Anthropic API key (kept in localStorage on this device).
   The SDK is bundled in vendor/anthropic-sdk.js (see README.md) and loaded only when the assistant is used. */
const KEY = 'kalender-ai-key';
const MODEL = 'claude-opus-5-5';
const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const REPEAT = { none: null, daily: 'd', weekly: 'w', biweekly: '2w', monthly: 'm' };
let history = [];   /* earlier turns of this conversation, text only */

const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isStamp = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);

function systemPrompt(api) {
  const now = new Date();
  const cals = api.state.cals.map((c) => c.name).join(', ');
  const groups = Object.entries(api.state.groups).map(([k, g]) => k.toUpperCase() + ' grupp ' + g).join(', ');
  return `Du är assistenten i en personlig kalenderapp som används av en student på Handelshögskolan i Stockholm. Användaren skriver till dig från appen, oftast på mobilen, och läser svaret i en smal chattruta. Svara därför kort och på svenska, i vanlig text utan markdown (inga asterisker, rubriker eller tabeller). Skriv tider som 14:15 och datum som "tis 17 nov".

Kalendern innehåller två slags händelser. Kursschemat (föreläsningar, seminarier för användarens grupp, inlämningar och tentor) har id som "be202:S4". Händelser från kalenderlänkar (prenumerationer) har id som börjar med "s:" och kan bara läsas, inte ändras eller tas bort. Användarens egna händelser har id som "e4k2…", och en enskild förekomst av en händelse som upprepas har id som "e4k2…@2026-11-24". Inlämningar visas som ett block på 30 minuter som slutar vid inlämningstiden.

Läs alltid kalendern med verktygen innan du påstår något om den eller ändrar i den. Ändringar du gör syns direkt, och användaren kan ångra allt du gjort i ett svar med en knapp. Genomför därför det användaren ber om när uppdraget är tydligt, och fråga bara när något väsentligt saknas, till exempel vilken dag som menas. När du letar lediga tider: ge två till fyra konkreta förslag som passar det användaren vill göra, och lägg bara in något om användaren bad dig boka. Att flytta eller ta bort en schemahändelse ändrar bara användarens egen vy, inte det riktiga schemat, så nämn det om det är relevant. Avsluta med en mening om vad du gjorde eller hittade.

Nu är det ${WEEKDAYS[now.getDay()]} ${api.ymd(now)} klockan ${api.hm(now)} (svensk tid). Användarens egna kalendrar: ${cals}.${groups ? ' Seminariegrupper: ' + groups + '.' : ''}`;
}

function describe(api, o) {
  return { id: o.key, title: o.title, start: o.allDay ? api.ymd(o.start) : api.toLocal(o.start), end: o.allDay ? api.ymd(api.addDays(o.end, -1)) : api.toLocal(o.end),
    all_day: o.allDay || undefined, calendar: api.calOf(o.calId).name, location: o.loc || undefined, kind: o.kind !== 'event' ? o.kind : undefined, repeats: o.rec || undefined };
}
function parseTimes(api, input, fallback) {
  const allDay = input.all_day != null ? !!input.all_day : fallback ? fallback.allDay : false;
  const pick = (v, d) => v == null ? d : allDay ? (isDate(String(v).slice(0, 10)) ? api.fromLocal(String(v).slice(0, 10)) : null) : (isStamp(v) ? api.fromLocal(v) : null);
  let start = pick(input.start, fallback ? fallback.start : null);
  let end = pick(input.end, null);
  if (!start || isNaN(start)) return { error: 'start måste anges som ' + (allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:MM') };
  if (allDay) {
    start = api.dayStart(start);
    if (input.end != null) { if (!end) return { error: 'end måste anges som YYYY-MM-DD' }; end = api.addDays(api.dayStart(end), 1); }
    else end = fallback && fallback.allDay ? new Date(start.getTime() + (fallback.end - fallback.start)) : api.addDays(start, 1);
  } else if (input.end != null) { if (!end || isNaN(end)) return { error: 'end måste anges som YYYY-MM-DDTHH:MM' }; }
  else end = new Date(start.getTime() + (fallback && !fallback.allDay ? fallback.end - fallback.start : 36e5));
  if (end <= start) return { error: 'end måste vara efter start' };
  return { allDay, start, end };
}
const calId = (api, name) => { const c = name && api.state.cals.find((x) => x.name.toLowerCase() === String(name).toLowerCase()); return c ? c.id : null; };

export function makeTools(api, betaTool, ctx) {
  const changed = (label) => { ctx.changes++; ctx.status(label); api.save(); api.render(); };
  const json = (v) => JSON.stringify(v);
  return [
    betaTool({
      name: 'list_events',
      description: 'Listar alla händelser (kursschema och egna) från och med ett datum till och med ett annat. Använd det för att svara på frågor om vad som händer och för att hitta id på händelser som ska ändras.',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Första dag, YYYY-MM-DD' }, to: { type: 'string', description: 'Sista dag, YYYY-MM-DD' } }, required: ['from', 'to'], additionalProperties: false },
      run: (i) => {
        if (!isDate(i.from) || !isDate(i.to)) return 'Fel: from och to måste vara YYYY-MM-DD';
        ctx.status('Läser kalendern');
        const list = api.occurrences(api.fromLocal(i.from), api.addDays(api.fromLocal(i.to), 1)).map((o) => describe(api, o));
        return json(list.length > 250 ? { events: list.slice(0, 250), note: 'Fler än 250 händelser, korta intervallet.' } : { events: list });
      },
    }),
    betaTool({
      name: 'find_free_time',
      description: 'Hittar luckor utan bokade händelser, dag för dag. Heldagshändelser och inlämningar räknas inte som upptagna. Returnerar varje lucka med start, slut och längd i minuter.',
      inputSchema: { type: 'object', properties: {
        from: { type: 'string', description: 'Första dag, YYYY-MM-DD' }, to: { type: 'string', description: 'Sista dag, YYYY-MM-DD' },
        min_minutes: { type: 'integer', description: 'Kortaste lucka som är intressant' },
        earliest: { type: 'string', description: 'Tidigaste klockslag på dagen, HH:MM. Standard 08:00.' }, latest: { type: 'string', description: 'Senaste klockslag, HH:MM. Standard 21:00.' },
        include_weekends: { type: 'boolean', description: 'Standard true' } }, required: ['from', 'to', 'min_minutes'], additionalProperties: false },
      run: (i) => {
        if (!isDate(i.from) || !isDate(i.to)) return 'Fel: from och to måste vara YYYY-MM-DD';
        const t = /^\d{2}:\d{2}$/;
        ctx.status('Letar lediga tider');
        const slots = api.freeSlots(api.fromLocal(i.from), api.fromLocal(i.to), Math.max(5, i.min_minutes | 0), t.test(i.earliest || '') ? i.earliest : '08:00', t.test(i.latest || '') ? i.latest : '21:00', i.include_weekends !== false);
        return json({ free: slots.map((s) => ({ weekday: WEEKDAYS[s.start.getDay()], start: api.toLocal(s.start), end: api.toLocal(s.end), minutes: Math.round((s.end - s.start) / 6e4) })) });
      },
    }),
    betaTool({
      name: 'create_event',
      description: 'Lägger till en egen händelse i kalendern.',
      inputSchema: { type: 'object', properties: {
        title: { type: 'string' }, start: { type: 'string', description: 'YYYY-MM-DDTHH:MM, eller YYYY-MM-DD för heldag' }, end: { type: 'string', description: 'Samma format som start. Utelämnas den blir händelsen en timme (eller en dag).' },
        all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, calendar: { type: 'string', description: 'Namnet på en av användarens egna kalendrar' },
        repeat: { type: 'string', enum: Object.keys(REPEAT) }, repeat_until: { type: 'string', description: 'Sista dag för upprepningen, YYYY-MM-DD' } }, required: ['title', 'start'], additionalProperties: false },
      run: (i) => {
        const t = parseTimes(api, i, null); if (t.error) return 'Fel: ' + t.error;
        const f = REPEAT[i.repeat || 'none'];
        const id = api.applyNew({ title: String(i.title).slice(0, 200), loc: i.location || '', notes: i.notes || '', ...t, cal: calId(api, i.calendar) || 'privat', rr: f ? { f, until: isDate(i.repeat_until) ? i.repeat_until : null } : null });
        changed('Lägger till ' + i.title);
        return json({ created: describe(api, api.findOcc(id)) });
      },
    }),
    betaTool({
      name: 'update_event',
      description: 'Ändrar en händelse. Ange bara de fält som ska ändras. Ett id med @datum ändrar bara den förekomsten av en upprepad händelse; utan @datum ändras hela serien.',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string', description: 'YYYY-MM-DDTHH:MM, eller YYYY-MM-DD för heldag' }, end: { type: 'string' },
        all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, calendar: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: (i) => {
        if (String(i.id).startsWith('s:')) return 'Fel: händelsen kommer från en kalenderlänk och kan inte ändras här.';
        const o = api.findOcc(i.id); if (!o) return 'Fel: hittar ingen händelse med id ' + i.id;
        const t = parseTimes(api, i, o); if (t.error) return 'Fel: ' + t.error;
        api.applyEdit(o, { title: i.title != null ? String(i.title).slice(0, 200) : o.title, loc: i.location != null ? i.location : o.loc, notes: i.notes != null ? i.notes : o.notes, ...t,
          cal: calId(api, i.calendar) || o.calId, rr: o.occ ? null : undefined }, o.occ ? 'one' : 'all');
        changed('Ändrar ' + o.title);
        const after = o.occ ? null : api.findOcc(i.id);
        return json(after ? { updated: describe(api, after) } : { updated: true, note: 'Förekomsten är nu en egen händelse med nytt id.' });
      },
    }),
    betaTool({
      name: 'delete_event',
      description: 'Tar bort en egen händelse, eller döljer en schemahändelse i användarens vy. Ett id med @datum tar bara bort den förekomsten.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: (i) => {
        if (String(i.id).startsWith('s:')) return 'Fel: händelsen kommer från en kalenderlänk och kan inte ändras här.';
        const o = api.findOcc(i.id); if (!o) return 'Fel: hittar ingen händelse med id ' + i.id;
        api.applyDelete(o, o.occ ? 'one' : 'all');
        changed('Tar bort ' + o.title);
        return json({ deleted: o.key, title: o.title });
      },
    }),
  ];
}

async function ask(api, text, ctx) {
  const { Anthropic, betaTool } = await import('./vendor/anthropic-sdk.js');
  const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true });
  try {
    const message = await client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      /* if the model declines a request, the API retries it on a fallback model inside the same call */
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(api),
      tools: makeTools(api, betaTool, ctx),
      messages: [...history, { role: 'user', content: text }],
      max_iterations: 14,
      thread: false,
    });
    if (message.stop_reason === 'refusal') return { error: 'Assistenten kunde inte svara på det. Prova att formulera om.' };
    const reply = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const cut = message.stop_reason === 'max_tokens' || message.stop_reason === 'tool_use';
    return { reply: reply || (cut ? '' : 'Klart.'), note: cut ? 'Svaret blev avbrutet innan assistenten var klar. Kontrollera kalendern och be den fortsätta om något saknas.' : '' };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { error: 'API-nyckeln godkändes inte. Kontrollera den under Kalendrar.', badKey: true };
    if (err instanceof Anthropic.PermissionDeniedError) return { error: 'Nyckeln har inte tillgång till modellen. Kontrollera kontot på console.anthropic.com.' };
    if (err instanceof Anthropic.RateLimitError) return { error: 'För många frågor just nu. Vänta en stund och försök igen.' };
    if (err instanceof Anthropic.APIConnectionError) return { error: 'Ingen kontakt med Anthropic. Kontrollera uppkopplingen.' };
    if (err instanceof Anthropic.APIError) return { error: 'Anthropic svarade med ett fel (' + err.status + '): ' + err.message };
    throw err;
  }
}

export function openAssistant(api) {
  const { h } = api;
  const chat = h('div', { class: 'chat' });
  const input = h('textarea', { rows: 1, placeholder: 'Be om något…', enterkeyhint: 'send', 'aria-label': 'Meddelande till assistenten' });
  const sendBtn = h('button', { type: 'button', 'aria-label': 'Skicka', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' });
  const bar = h('div', { class: 'chat-in' }, input, sendBtn);
  const body = h('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0' });
  let busy = false;
  const s = api.sheet({ title: 'Assistent', cls: 'assistant', left: { label: 'Stäng', fn: (x) => x.close() }, right: { label: 'Rensa', fn: () => { if (!busy) { history = []; intro(); } } }, body });
  const bottom = () => { chat.scrollTop = chat.scrollHeight; };
  const bubble = (cls, text) => { const el = h('div', { class: 'msg ' + cls }, text); chat.append(el); bottom(); return el; };

  function intro() {
    chat.replaceChildren(
      h('p', { class: 'chat-intro' }, 'Be mig lägga in, flytta eller ta bort saker, eller hitta lediga tider. Allt jag ändrar kan du ångra.'),
      h('div', { class: 'sugg' }, ['Vad har jag i morgon?', 'Hitta två lediga timmar för plugg den här veckan', 'Lägg in gym tisdagar och torsdagar 18–19', 'När är nästa inlämning?']
        .map((t) => h('button', { type: 'button', onclick: () => send(t) }, t))));
  }
  function needKey() {
    const inp = h('input', { type: 'password', class: 'in', placeholder: 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Anthropic API-nyckel' });
    const saveKey = () => { const v = inp.value.trim(); if (!v) return; try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ } show(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
    body.replaceChildren(h('div', { class: 'key-box' },
      h('p', { class: 'lead' }, 'Koppla assistenten'),
      h('p', { class: 'note center' }, 'Assistenten använder Claude via din egen API-nyckel. Skapa en på console.anthropic.com under API Keys och klistra in den här. Den sparas bara på den här enheten.'),
      api.grp(null, api.row(null, inp)),
      h('button', { type: 'button', class: 'big-btn danger', onclick: saveKey }, 'Spara nyckeln')));
  }
  function show() { if (!getKey()) { needKey(); return; } body.replaceChildren(chat, bar); if (!chat.childNodes.length || !history.length) intro(); setTimeout(() => input.focus(), 80); }

  async function send(text) {
    text = (text || input.value).trim(); if (!text || busy) return;
    if (!history.length) chat.replaceChildren();
    busy = true; sendBtn.disabled = true; input.value = ''; input.style.height = '';
    bubble('me', text);
    const work = bubble('work', 'Tänker');
    const snap = api.snapshot();
    const ctx = { changes: 0, status: (t) => { work.textContent = t; bottom(); } };
    let res;
    try { res = await ask(api, text, ctx); }
    catch (err) { console.error(err); res = { error: 'Något gick fel: ' + (err && err.message || err) }; }
    work.remove();
    if (res.reply) { bubble('ai', res.reply); history.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply }); }
    if (res.note) bubble('err', res.note);
    if (res.error) bubble('err', res.error);
    if (ctx.changes) {
      const rowEl = h('div', { class: 'done-row' }, h('span', null, ctx.changes === 1 ? '1 ändring gjord' : ctx.changes + ' ändringar gjorda'));
      rowEl.append(h('button', { type: 'button', onclick: () => { api.restore(snap); rowEl.replaceChildren(h('span', null, 'Ångrat')); history.push({ role: 'user', content: '(Jag ångrade ändringarna du just gjorde.)' }, { role: 'assistant', content: 'Uppfattat, ändringarna är borttagna.' }); } }, 'Ångra'));
      chat.append(rowEl); bottom();
    }
    if (res.badKey) { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
    busy = false; sendBtn.disabled = false;
  }
  sendBtn.addEventListener('click', () => send());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  show();
  return s;
}
