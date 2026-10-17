/* Scheda allenamento — app per clienti e coach. Dati su Google Sheets tramite Apps Script. */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const API = String(CFG.apiUrl || '');
  const COACH = CFG.coachName || 'il coach';
  const APP_NAME = CFG.appName || 'Scheda allenamento';

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  function richBlock(arr) {
    if (!Array.isArray(arr)) arr = arr ? [String(arr)] : [];
    let html = '', list = null;
    for (const raw of arr) {
      const t = String(raw);
      if (t.startsWith('- ')) { (list = list || []).push('<li>' + rich(t.slice(2)) + '</li>'); continue; }
      if (list) { html += '<ul>' + list.join('') + '</ul>'; list = null; }
      html += '<p>' + rich(t) + '</p>';
    }
    if (list) html += '<ul>' + list.join('') + '</ul>';
    return html;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o == null ? null : o));
  const num = (v) => { const t = String(v == null ? '' : v).trim().replace(',', '.'); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  const fmt = (n) => (n == null || n === '' ? '' : String(n).replace('.', ','));
  const GG = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const MM = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  function parseISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function shortDate(s) { const d = parseISO(s); return d ? d.getDate() + ' ' + MM[d.getMonth()] : ''; }
  function longDate(s) { const d = parseISO(s); return d ? GG[d.getDay()] + ' ' + d.getDate() + ' ' + MM[d.getMonth()] : ''; }
  function stamp(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getDate() + ' ' + MM[d.getMonth()] + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  const weekNum = (id) => { const m = /^w(\d+)$/.exec(id || ''); return m ? Number(m[1]) : 0; };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* spazio non disponibile */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignora */ } }
  };
  const K = { code: 'sc:code', role: 'sc:role', bundle: 'sc:bundle', outbox: 'sc:outbox', view: 'sc:view' };

  /* ---------- state ---------- */
  const S = {
    screen: 'boot', shell: null, code: null, role: null,
    online: navigator.onLine !== false,
    // cliente
    bundle: null, docs: {}, readOnly: false, netError: false, saveError: '', loadError: false,
    // coach
    clienti: null, coachClient: null, coachBundle: null, coachMeta: null, lastSync: '',
    ui: { importOpen: false, importText: '', parsed: null, importError: '', confirm: null, msg: '', busy: false },
    // vista
    weekId: null, dayId: null, weekManual: false, openNotes: {}, needsRender: false, loginError: ''
  };
  const savedView = store.get(K.view, null);

  /* ---------- API ---------- */
  async function api(action, payload) {
    const body = Object.assign({ action: action, code: S.code }, payload || {});
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 25000);
    let res, j;
    try {
      res = await fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
      j = await res.json();
    } catch (e) {
      const err = new Error('Connessione non disponibile.'); err.code = 'rete'; throw err;
    } finally { clearTimeout(timer); }
    if (!j || !j.ok) { const err = new Error((j && j.message) || 'Errore del server.'); err.code = (j && j.error) || 'errore'; throw err; }
    return j;
  }

  /* ---------- codice ---------- */
  function codeFromText(t) { const m = String(t || '').match(/[a-f0-9]{32,64}/i); return m ? m[0].toLowerCase() : null; }
  function codeFromUrl() { try { return codeFromText(new URLSearchParams(location.search).get('c')); } catch (e) { return null; } }
  function clientLink(code) { const u = new URL('./', location.href); u.search = ''; u.hash = ''; return u.toString() + '?c=' + code; }

  function logout(message) {
    store.del(K.code); store.del(K.role); store.del(K.bundle);
    S.code = null; S.role = null; S.bundle = null; S.docs = {}; S.clienti = null; S.coachBundle = null; S.coachClient = null;
    S.loginError = message || '';
    try { if (location.search) history.replaceState(null, '', new URL('./', location.href).pathname); } catch (e) { /* ignora */ }
    go('login');
  }

  /* ---------- program accessors ---------- */
  function weeksOf(b) {
    return (b && b.weeks ? b.weeks : []).filter((w) => w && w.program)
      .map((w) => Object.assign({}, w.program, { id: w.id, _stato: w.stato, _note: w.note || '' }))
      .sort((a, b2) => (a.n || weekNum(a.id)) - (b2.n || weekNum(b2.id)));
  }
  function ctx() {
    if (S.role === 'coach') {
      const b = S.coachBundle;
      return { b: b, weeks: weeksOf(b), docs: (b && b.logs) || {}, readOnly: !canEdit(), coach: true, current: b && b.cliente.settimanaCorrente };
    }
    const b = S.bundle;
    return { b: b, weeks: weeksOf(b), docs: S.docs, readOnly: S.readOnly, coach: false, current: b && b.cliente.settimanaCorrente };
  }
  function curWeek(c) { return c.weeks.find((w) => w.id === S.weekId) || null; }
  function pickWeek(c) {
    if (!c.weeks.length) { S.weekId = null; return; }
    if (S.weekId && c.weeks.some((w) => w.id === S.weekId) && (S.weekManual || c.coach)) return;
    if (c.coach) { S.weekId = c.weeks[c.weeks.length - 1].id; return; }
    S.weekId = (c.current && c.weeks.some((w) => w.id === c.current)) ? c.current : c.weeks[c.weeks.length - 1].id;
  }
  function pickDay(c, w) {
    const ids = (w.days || []).map((d) => d.id).concat(['week']);
    if (S.dayId && ids.includes(S.dayId)) return;
    if (!c.coach && savedView && savedView.weekId === w.id && ids.includes(savedView.dayId)) { S.dayId = savedView.dayId; return; }
    const firstOpen = (w.days || []).find((d) => { const doc = c.docs[w.id + '_' + d.id]; return !(doc && doc.done); });
    S.dayId = firstOpen ? firstOpen.id : (w.days && w.days[0] ? w.days[0].id : 'week');
  }
  /* chi può scrivere: il cliente sulla sua scheda, il coach sulla scheda del cliente aperto */
  function canEdit() {
    if (S.role === 'cliente') return !S.readOnly;
    return S.role === 'coach' && S.screen === 'coach-client' && !!S.coachBundle;
  }
  /* documenti modificabili: quelli del cliente, oppure quelli del cliente aperto dal coach */
  function docsMap() {
    if (S.role === 'coach') { if (!S.coachBundle.logs) S.coachBundle.logs = {}; return S.coachBundle.logs; }
    return S.docs;
  }
  /* chiave di salvataggio: per il coach include il cliente (es. "alessio-b/w01_LUN") */
  const wkey = (doc) => (S.role === 'coach' ? S.coachClient + '/' + doc : doc);
  function splitKey(key) {
    const i = key.indexOf('/');
    return i < 0 ? { cliente: null, doc: key } : { cliente: key.slice(0, i), doc: key.slice(i + 1) };
  }
  function ensureSession(w, d) {
    const id = w + '_' + d; const m = docsMap();
    if (!m[id]) m[id] = { week: w, day: d, date: '', done: false, ex: {}, painMax: null, painWhere: '', morning: '', note: '', updatedAt: '' };
    if (!m[id].ex) m[id].ex = {};
    return m[id];
  }
  function ensureCheckin(w) {
    const id = w + '_week'; const m = docsMap();
    if (!m[id]) m[id] = { week: w, day: 'week', daily: '', volley: '', nextSunday: '', note: '', updatedAt: '' };
    return m[id];
  }
  function ensureEx(doc, key) { if (!doc.ex[key]) doc.ex[key] = { sets: [], done: false, note: '', extra: '' }; if (!Array.isArray(doc.ex[key].sets)) doc.ex[key].sets = []; return doc.ex[key]; }

  const FIELD_META = {
    kg: { label: 'kg', mode: 'decimal' }, reps: { label: 'rip', mode: 'numeric' }, rpe: { label: 'RPE', mode: 'decimal' },
    sec: { label: 'sec', mode: 'numeric' }, reps_sx: { label: 'rip sx', mode: 'numeric' }, reps_dx: { label: 'rip dx', mode: 'numeric' },
    sec_sx: { label: 'sec sx', mode: 'numeric' }, sec_dx: { label: 'sec dx', mode: 'numeric' }
  };
  function logFields(ex) {
    const lg = ex.log; if (!lg) return [];
    const out = [];
    for (const f of (lg.fields || ['kg', 'reps'])) {
      if (lg.sides && (f === 'reps' || f === 'sec')) out.push(f + '_sx', f + '_dx'); else out.push(f);
    }
    return out.filter((f) => FIELD_META[f] && f !== 'rpe' && f !== 'rir');
  }
  function exComplete(ex, entry) {
    if (!entry) return false;
    if (!ex.log) return !!entry.done;
    return (entry.sets || []).some((s) => s && ['reps', 'sec', 'reps_sx', 'reps_dx', 'sec_sx', 'sec_dx'].some((k) => s[k] != null));
  }
  function dayProgress(c, w, day) {
    const doc = c.docs[w.id + '_' + day.id];
    const exs = day.exercises || [];
    return { done: exs.filter((ex) => exComplete(ex, doc && doc.ex && doc.ex[ex.key])).length, total: exs.length, doc: doc };
  }
  function setSummary(entry) {
    if (!entry || !Array.isArray(entry.sets)) return '';
    return entry.sets.filter((s) => s && Object.values(s).some((v) => v != null)).map((s) => {
      const kg = s.kg != null ? fmt(s.kg) + ' kg × ' : '';
      if (s.reps_sx != null || s.reps_dx != null) return kg + fmt(s.reps_sx) + '/' + fmt(s.reps_dx);
      if (s.sec != null) return fmt(s.sec) + ' s';
      if (s.sec_sx != null || s.sec_dx != null) return fmt(s.sec_sx) + '/' + fmt(s.sec_dx) + ' s';
      return kg + fmt(s.reps) + (s.rpe != null ? ' @' + fmt(s.rpe) : '');
    }).join(' · ');
  }
  function previousFor(c, w, dayId, key) {
    const pubs = c.weeks.filter((x) => x._stato === 'pubblicata' || !c.coach);
    const i = pubs.findIndex((x) => x.id === w.id);
    const prev = i > 0 ? pubs[i - 1] : (i === -1 ? pubs[pubs.length - 1] : null);
    if (!prev || prev.id === w.id) return null;
    const days = [dayId].concat((prev.days || []).map((d) => d.id).filter((d) => d !== dayId));
    for (const d of days) {
      const doc = c.docs[prev.id + '_' + d];
      const s = doc && doc.ex && setSummary(doc.ex[key]);
      if (s) return { week: prev, text: s };
    }
    return null;
  }

  /* ---------- salvataggio (cliente e coach) ---------- */
  const W = { dirty: new Set(), inflight: new Set(), timers: {}, backoff: 0 };
  function outbox() { const o = store.get(K.outbox, {}) || {}; return o[S.code] || {}; }
  function outboxSet(id, data) {
    const o = store.get(K.outbox, {}) || {};
    o[S.code] = o[S.code] || {};
    if (data) o[S.code][id] = data; else delete o[S.code][id];
    store.set(K.outbox, o);
  }
  function touch(id) {
    const d = docsMap()[id]; if (!d) return;
    d.updatedAt = new Date().toISOString();
    const key = wkey(id);
    outboxSet(key, d);
    W.dirty.add(key);
    clearTimeout(W.timers[key]);
    W.timers[key] = setTimeout(() => flush(key), 900);
    renderStatus(); refreshIndicators();
    if (S.role === 'coach') refreshSummarySoon();
  }
  async function flush(key) {
    if (!S.role || (S.role === 'cliente' && S.readOnly)) return;
    if (W.inflight.has(key) || !W.dirty.has(key)) return;
    if (!S.online) { renderStatus(); return; }
    const k = splitKey(key);
    // il coach salva dalla copia locale: così i dati partono anche se nel frattempo ha aperto un altro cliente
    const data = S.role === 'coach' ? outbox()[key] : S.docs[key];
    if (!data) { W.dirty.delete(key); renderStatus(); return; }
    W.dirty.delete(key); W.inflight.add(key); renderStatus();
    let delay = 0;
    try {
      const r = S.role === 'coach'
        ? await api('salva', { cliente: k.cliente, doc: k.doc, data: clone(data) })
        : await api('save', { doc: key, data: clone(data) });
      S.netError = false; W.backoff = 0; S.saveError = '';
      if (r.stale && r.data && !W.dirty.has(key)) {
        // sul server c'è una versione più recente (es. il cliente ha compilato dopo): vince quella
        if (S.role === 'coach') { if (S.coachBundle && S.coachClient === k.cliente) { docsMap()[k.doc] = r.data; requestRender(); } }
        else { S.docs[key] = r.data; requestRender(); }
      }
      if (!W.dirty.has(key)) outboxSet(key, null);
      persistCache();
    } catch (e) {
      if (e.code === 'codice') {
        W.inflight.delete(key);
        if (S.role === 'coach') logout('Codice coach non valido.');
        else logout('Il tuo codice non è più attivo. Chiedi un nuovo link a ' + COACH + '.');
        return;
      }
      if (e.code === 'rete' || e.code === 'errore' || e.code === 'setup') {
        W.dirty.add(key); S.netError = true;
        W.backoff = Math.min(W.backoff ? W.backoff * 2 : 10000, 120000); delay = W.backoff;
      } else {
        S.saveError = e.message || 'Dati non accettati.';
      }
    } finally {
      W.inflight.delete(key);
      renderStatus(); renderBanner();
      if (W.dirty.has(key)) { clearTimeout(W.timers[key]); W.timers[key] = setTimeout(() => flush(key), delay || 400); }
    }
  }
  function flushAll() { for (const id of Array.from(W.dirty)) flush(id); }
  /* coach: riprende gli invii rimasti in sospeso (app chiusa o senza rete) */
  function resumeCoachOutbox() {
    Object.keys(outbox()).forEach((key, i) => { if (key.includes('/')) { W.dirty.add(key); setTimeout(() => flush(key), 600 + i * 300); } });
  }
  /* coach: dopo un ricaricamento, rimette sopra i dati locali non ancora inviati */
  function mergeCoachOutbox() {
    if (!S.coachBundle) return;
    const pend = outbox(); const logs = docsMap(); const pre = S.coachClient + '/';
    for (const key of Object.keys(pend)) {
      if (!key.startsWith(pre)) continue;
      const doc = key.slice(pre.length); const r = logs[doc];
      if (!r || String(pend[key].updatedAt || '') > String(r.updatedAt || '')) {
        logs[doc] = clone(pend[key]);
        if (!W.inflight.has(key) && !W.dirty.has(key)) { W.dirty.add(key); setTimeout(() => flush(key), 600); }
      } else if (!W.dirty.has(key) && !W.inflight.has(key)) outboxSet(key, null);
    }
  }
  const coachPending = () => Array.from(W.dirty).concat(Array.from(W.inflight)).some((k) => k.includes('/'));
  let sumTimer = null;
  function refreshSummarySoon() {
    clearTimeout(sumTimer);
    sumTimer = setTimeout(() => {
      if (S.screen !== 'coach-client') return;
      const a = document.activeElement; if (a && a.id === 'coachText') return;
      const c = ctx(); const w = curWeek(c); if (w) { renderSummary(c, w); renderDayTabs(c, w); }
    }, 700);
  }
  function mergeOutbox() {
    const pend = outbox(); const server = (S.bundle && S.bundle.logs) || {};
    for (const id of Object.keys(pend)) {
      const local = pend[id]; const r = server[id];
      if (!r || String(local.updatedAt || '') > String(r.updatedAt || '')) {
        S.docs[id] = local; W.dirty.add(id); setTimeout(() => flush(id), 600);
      } else outboxSet(id, null);
    }
  }
  window.addEventListener('online', () => { S.online = true; W.backoff = 0; renderStatus(); flushAll(); });
  window.addEventListener('offline', () => { S.online = false; renderStatus(); });

  /* copia locale del programma e dei dati, per aprire l'app anche senza rete */
  function persistCache() {
    if (!S.bundle || S.role !== 'cliente') return;
    store.set(K.bundle, { code: S.code, data: Object.assign({}, S.bundle, { logs: S.docs }) });
  }

  /* ---------- caricamento ---------- */
  function applyBundle(data) {
    const prevCur = S.bundle && S.bundle.cliente && S.bundle.cliente.settimanaCorrente;
    S.bundle = data;
    const logs = data.logs || {};
    for (const id of Object.keys(logs)) if (!W.dirty.has(id) && !W.inflight.has(id)) S.docs[id] = clone(logs[id]);
    const cur = data.cliente && data.cliente.settimanaCorrente;
    if (prevCur && cur && cur !== prevCur && !S.weekManual) { S.weekId = cur; S.dayId = null; }
  }
  async function refreshClient() {
    try {
      const r = await api('load');
      S.loadError = false;
      applyBundle(r.data);
      mergeOutbox();
      persistCache();
      requestRender();
    } catch (e) {
      if (e.code === 'codice') { logout('Il codice non è valido o è stato disattivato. Chiedi un nuovo link a ' + COACH + '.'); return; }
      S.loadError = true; renderStatus(); renderBanner();
    }
  }
  async function refreshCoachList() {
    try {
      const r = await api('clienti');
      S.clienti = r.clienti; S.lastSync = new Date().toISOString();
      requestRender();
    } catch (e) { coachError(e); }
  }
  async function loadCoachClient(id, silent) {
    try {
      const r = await api('cliente', { cliente: id });
      if (S.coachClient !== id) return;
      S.coachBundle = r.data; S.coachMeta = { codice: r.codice, attivo: r.attivo }; S.lastSync = new Date().toISOString();
      mergeCoachOutbox();
      if (silent) requestRender(); else renderAll(true);
    } catch (e) { coachError(e); }
  }
  function coachError(e) {
    if (e.code === 'codice') { logout('Codice coach non valido.'); return; }
    S.ui.msg = e.code === 'rete' ? 'Connessione non disponibile: riprova.' : (e.message || 'Errore.');
    S.ui.busy = false;
    renderAll(true);
  }

  /* ---------- rendering: struttura ---------- */
  function isEditing() { const a = document.activeElement; return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')); }
  function requestRender() { if (isEditing()) { S.needsRender = true; return; } renderAll(); }
  document.addEventListener('focusout', () => setTimeout(() => { if (S.needsRender && !isEditing()) renderAll(); }, 250));

  function go(screen) { S.screen = screen; S.weekId = null; S.dayId = null; S.weekManual = false; renderAll(true); }

  const SHELLS = {
    login: '<div id="login"></div>',
    setup: '<div id="login"></div>',
    client: '<header class="header" id="hdr"></header><div id="banner"></div><nav class="phase-tabs" id="weekTabs" aria-label="Settimane"></nav><section class="phase-info" id="weekInfo" hidden></section><div id="coachNote"></div><div id="notes"></div><nav class="day-tabs" id="dayTabs" aria-label="Sedute"></nav><main class="day-view" id="dayView"></main><div class="footer" id="footer"></div>',
    'coach-home': '<header class="header" id="hdr"></header><div id="banner"></div><div id="tools"></div><div class="client-list" id="clientList"></div><div class="footer" id="footer"></div>',
    'coach-client': '<header class="header" id="hdr"></header><div id="banner"></div><div id="tools"></div><nav class="phase-tabs" id="weekTabs" aria-label="Settimane"></nav><div id="draftBar"></div><div id="summary"></div><section class="phase-info" id="weekInfo" hidden></section><div id="notes"></div><nav class="day-tabs" id="dayTabs" aria-label="Sedute"></nav><main class="day-view" id="dayView"></main><div class="footer" id="footer"></div>'
  };
  function ensureShell() {
    if (S.shell === S.screen) return;
    $('app').innerHTML = SHELLS[S.screen] || '';
    S.shell = S.screen;
  }
  function setHTML(id, html) { const el = $(id); if (el) el.innerHTML = html; }

  function renderAll(force) {
    if (!force && isEditing()) { S.needsRender = true; return; }
    S.needsRender = false;
    ensureShell();
    if (S.screen === 'setup') return renderSetup();
    if (S.screen === 'login') return renderLogin();
    if (S.screen === 'boot') return;
    renderHeader(); renderBanner();
    if (S.screen === 'coach-home') return renderCoachHome();
    const c = ctx();
    if (!c.b) { ['weekTabs', 'dayTabs', 'dayView', 'notes'].forEach((id) => setHTML(id, '')); renderFooter(); if (S.screen === 'coach-client') renderClientTools(); return; }
    pickWeek(c);
    const w = curWeek(c);
    if (w) pickDay(c, w);
    renderWeekTabs(c);
    if (S.screen === 'coach-client') { renderClientTools(); renderDraftBar(c, w); renderSummary(c, w); }
    else renderCoachNote(w);
    renderWeekInfo(w); renderNotes(c, w); renderDayTabs(c, w); renderDay(c, w); renderFooter();
  }

  function renderSetup() {
    setHTML('login', '<div class="login"><h1>' + esc(APP_NAME) + '</h1><div class="banner warn"><strong>App non ancora collegata.</strong> Inserisci l\'indirizzo dello script Google nel file config.js, come indicato nella guida.</div></div>');
  }

  function renderLogin() {
    setHTML('login', '<form class="login" id="loginForm" autocomplete="off">' +
      '<h1>' + esc(APP_NAME) + '</h1>' +
      '<p>Incolla il link o il codice che ti ha mandato ' + esc(COACH) + '.</p>' +
      '<div class="field"><label for="codeInput">Link o codice</label><input type="text" id="codeInput" autocapitalize="off" spellcheck="false" placeholder="https://… oppure il codice"></div>' +
      (S.loginError ? '<p class="err" role="alert">' + esc(S.loginError) + '</p>' : '') +
      '<button type="submit" class="btn primary" id="loginBtn">Entra</button>' +
      '</form>');
  }

  function renderHeader() {
    let eyebrow = '', title = '', sub = '', back = '';
    if (S.screen === 'client') {
      const b = S.bundle || {}; const cfg = b.config || {};
      eyebrow = b.cliente ? 'Programma di ' + b.cliente.nome : APP_NAME;
      title = cfg.title || APP_NAME; sub = cfg.subtitle || '';
    } else if (S.screen === 'coach-home') {
      eyebrow = 'Area coach'; title = 'I tuoi clienti'; sub = S.lastSync ? 'Aggiornato ' + stamp(S.lastSync) : '';
    } else if (S.screen === 'coach-client') {
      const b = S.coachBundle;
      back = '<button type="button" class="btn link back" data-act="c-back">← Tutti i clienti</button>';
      eyebrow = 'Area coach'; title = b ? b.cliente.nome : 'Caricamento…';
      sub = b ? ((b.config && b.config.title) || '') + (S.lastSync ? ' · aggiornato ' + stamp(S.lastSync) : '') : '';
    }
    setHTML('hdr', '<div>' + back + '<p class="eyebrow">' + esc(eyebrow) + '</p><h1>' + esc(title) + '</h1>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + '</div><span class="status" id="status" role="status"></span>');
    renderStatus();
  }

  function renderStatus() {
    const el = $('status'); if (!el) return;
    let cls = '', txt = '';
    if (S.role === 'coach') {
      const pending = coachPending();
      if (!S.online) { cls = 'busy'; txt = pending ? 'Offline · dati sul telefono' : 'Offline'; }
      else if (pending && S.netError) { cls = 'busy'; txt = 'Non inviato · riprovo'; }
      else if (pending) { cls = 'busy'; txt = 'Salvataggio…'; }
      else if (S.ui.busy) { cls = 'busy'; txt = 'Aggiorno…'; } else { cls = 'ok'; txt = S.screen === 'coach-client' && S.coachBundle ? 'Salvato' : 'Collegato'; }
    } else {
      const pending = W.dirty.size + W.inflight.size;
      if (S.readOnly) { cls = 'bad'; txt = 'Sola lettura'; }
      else if (!S.online) { cls = 'busy'; txt = pending ? 'Offline · dati sul telefono' : 'Offline'; }
      else if (pending && S.netError) { cls = 'busy'; txt = 'Non inviato · riprovo'; }
      else if (pending) { cls = 'busy'; txt = 'Salvataggio…'; }
      else if (!S.bundle) { txt = 'Caricamento…'; }
      else { cls = 'ok'; txt = 'Salvato'; }
    }
    el.className = 'status ' + cls; el.textContent = txt;
  }

  function renderBanner() {
    const el = $('banner'); if (!el) return;
    let html = '';
    if (S.role === 'cliente') {
      if (S.saveError) html = '<div class="banner bad"><strong>Alcuni dati non sono stati accettati.</strong> Restano su questo telefono. Avvisa ' + esc(COACH) + ' (' + esc(S.saveError) + ').</div>';
      else if (!S.bundle && S.loadError) html = '<div class="banner warn"><strong>Serve la connessione per scaricare il programma.</strong> Riapri l\'app quando hai campo.</div>';
      else if (!S.bundle) html = '<div class="banner">Caricamento del programma…</div>';
      else if (!weeksOf(S.bundle).length) html = '<div class="banner"><strong>Il programma non è ancora pronto.</strong> Appena ' + esc(COACH) + ' pubblica la settimana, la trovi qui.</div>';
      else if (S.loadError) html = '<div class="banner warn">Stai vedendo l\'ultima versione scaricata. I dati che inserisci vengono inviati quando torna la connessione.</div>';
    } else if (S.saveError) {
      html = '<div class="banner bad"><strong>Alcuni dati non sono stati salvati.</strong> Restano su questo dispositivo (' + esc(S.saveError) + ').</div>';
    } else if (S.ui.msg) {
      html = '<div class="banner bad">' + esc(S.ui.msg) + '</div>';
    }
    el.innerHTML = html;
  }

  function renderFooter() {
    const confirm = S.ui.confirm === 'logout';
    setHTML('footer', confirm
      ? '<div class="confirm"><span>Uscire da questo telefono? Per rientrare servirà di nuovo il link o il codice.</span><div class="row"><button type="button" class="btn danger" data-act="logout-yes">Esci</button><button type="button" class="btn" data-act="cancel">Annulla</button></div></div>'
      : '<button type="button" class="btn link" data-act="logout">Esci</button>');
  }

  /* ---------- rendering: scheda ---------- */
  function renderWeekTabs(c) {
    const el = $('weekTabs'); if (!el) return;
    if (c.weeks.length < 2 && !c.coach) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = c.weeks.map((w) => '<button type="button" class="phase-tab' + (w.id === S.weekId ? ' active' : '') + (w._stato !== 'pubblicata' ? ' draft' : '') + '" data-week="' + esc(w.id) + '">' +
      esc(w.label || w.id) + (w._stato !== 'pubblicata' ? ' · bozza' : '') + '<small>' + esc(w.dates || '') + '</small></button>').join('');
  }
  function renderWeekInfo(w) {
    const el = $('weekInfo'); if (!el) return;
    if (!w) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML =
      '<div class="phase-stat"><div class="label">' + esc(w.label || 'Settimana') + '</div><div class="value">' + esc(w.dates || '') + '</div></div>' +
      '<div class="phase-stat"><div class="label">' + esc(w.phase || 'Fase') + '</div><div class="value">' + esc(w.focus || '') + '</div></div>' +
      '<div class="phase-stat"><div class="label">Intensità</div><div class="value">' + esc(w.rpe || '—') + '</div></div>' +
      '<div class="phase-stat"><div class="label">Recupero</div><div class="value">' + esc(w.rest || '—') + '</div></div>';
  }
  function renderCoachNote(w) {
    setHTML('coachNote', w && w._note ? '<div class="note-box coach-note"><div class="label">Nota di ' + esc(COACH) + '</div>' + esc(w._note) + '</div>' : '');
  }
  function renderNotes(c, w) {
    const cfg = (c.b && c.b.config) || {};
    if (!w) { setHTML('notes', ''); return; }
    let html = '';
    if (w.note && w.note.length) html += '<details class="note-box" data-note="week"' + (S.openNotes.week === false ? '' : ' open') + '><summary>Indicazioni della settimana</summary>' + richBlock(w.note) + '</details>';
    if (cfg.howTo && cfg.howTo.length) html += '<details class="note-box" data-note="how"' + (S.openNotes.how ? ' open' : '') + '><summary>Come funziona il programma</summary>' + richBlock(cfg.howTo) + '</details>';
    if (cfg.safety && cfg.safety.length) html += '<details class="note-box warn" data-note="safety"' + (S.openNotes.safety ? ' open' : '') + '><summary>Regole di sicurezza</summary>' + richBlock(cfg.safety) + '</details>';
    setHTML('notes', html ? '<div class="stack">' + html + '</div>' : '');
  }
  function renderDayTabs(c, w) {
    if (!w) { setHTML('dayTabs', ''); return; }
    const tabs = (w.days || []).map((d) => {
      const doc = c.docs[w.id + '_' + d.id];
      return '<button type="button" class="day-tab' + (d.id === S.dayId ? ' active' : '') + '" data-day="' + esc(d.id) + '">' +
        esc(d.label) + ' ' + esc(shortDate(d.date)) + (doc && doc.done ? '<span class="tick" aria-label="completata">✓</span>' : '') +
        '<small>' + esc(d.title || '') + '</small></button>';
    });
    const ci = c.docs[w.id + '_week'];
    const ciDone = ci && (ci.daily || ci.nextSunday || ci.volley || ci.note);
    tabs.push('<button type="button" class="day-tab' + (S.dayId === 'week' ? ' active' : '') + '" data-day="week">Check-in' + (ciDone ? '<span class="tick" aria-label="compilato">✓</span>' : '') + '<small>fine settimana</small></button>');
    setHTML('dayTabs', tabs.join(''));
  }
  const dis = (c) => (c.readOnly ? ' disabled' : '');

  function renderExercise(c, w, day, ex, idx, doc) {
    const entry = doc && doc.ex ? doc.ex[ex.key] : null;
    const badgeMap = { compound: 'Compound', warn: '⚠ Attenzione', iso: 'Isolamento' };
    const badge = ex.tag && badgeMap[ex.tag] ? '<span class="badge ' + esc(ex.tag) + '">' + badgeMap[ex.tag] + '</span>' : '';
    const base = day.id + '-' + ex.key;
    let log = '';
    const prev = ex.log ? previousFor(c, w, day.id, ex.key) : null;
    if (prev) log += '<p class="prev">' + esc(prev.week.label || 'Settimana precedente') + ': <b>' + esc(prev.text) + '</b></p>';
    if (ex.log) {
      const fields = logFields(ex); const n = Math.max(1, Math.min(10, ex.log.n || 3));
      let g = '<div class="log-grid" style="--cols:' + fields.length + '"><span></span>' + fields.map((f) => '<span class="gh">' + FIELD_META[f].label + '</span>').join('');
      for (let i = 0; i < n; i++) {
        const s = entry && entry.sets && entry.sets[i] ? entry.sets[i] : {};
        g += '<span class="rl">Serie ' + (i + 1) + '</span>';
        g += fields.map((f) => '<input type="text" inputmode="' + FIELD_META[f].mode + '" autocomplete="off" aria-label="Serie ' + (i + 1) + ' ' + FIELD_META[f].label + '" id="in-' + esc(base) + '-' + i + '-' + f + '" data-k="set" data-ex="' + esc(ex.key) + '" data-i="' + i + '" data-f="' + f + '" value="' + esc(fmt(s[f])) + '"' + dis(c) + '>').join('');
      }
      log += g + '</div>';
      if (ex.log.extra) {
        log += '<div class="field"><label for="ex-' + esc(base) + '-extra">' + esc(ex.log.extra) + '</label><input type="text" autocomplete="off" id="ex-' + esc(base) + '-extra" data-k="exf" data-ex="' + esc(ex.key) + '" data-f="extra" value="' + esc((entry && entry.extra) || '') + '"' + dis(c) + '></div>';
      }
    }
    const noteVal = entry && entry.note ? entry.note : '';
    const noteOpen = !!noteVal || !!S.openNotes['ex-' + base];
    let actions = '<div class="ex-actions">';
    if (!ex.log) actions += '<button type="button" class="btn" data-act="exdone" data-ex="' + esc(ex.key) + '" aria-pressed="' + (entry && entry.done ? 'true' : 'false') + '"' + dis(c) + '>' + (entry && entry.done ? '✓ Fatto' : 'Segna come fatto') + '</button>';
    if (!noteOpen && !c.readOnly) actions += '<button type="button" class="btn link" data-act="note" data-target="' + esc(base) + '">+ Aggiungi una nota</button>';
    actions += '</div>';
    const noteField = '<div class="field"' + (noteOpen ? '' : ' hidden') + ' data-notefield="' + esc(base) + '"><label for="ex-' + esc(base) + '-note">Note (sensazioni, fastidi, profondità)</label><textarea rows="2" id="ex-' + esc(base) + '-note" data-k="exf" data-ex="' + esc(ex.key) + '" data-f="note"' + dis(c) + '>' + esc(noteVal) + '</textarea></div>';
    return '<article class="exercise-card' + (exComplete(ex, entry) ? ' complete' : '') + '" data-card="' + esc(ex.key) + '">' +
      '<div class="exercise-header"><div class="exercise-num">' + (idx + 1) + '</div><div class="exercise-name">' + esc(ex.name) + '</div>' + badge + '</div>' +
      '<div class="exercise-params">' +
      '<div class="param"><div class="p-label">Serie×Rip</div><div class="p-value">' + esc(ex.sets || '—') + '</div></div>' +
      '<div class="param"><div class="p-label">Intensità</div><div class="p-value">' + esc(ex.rpe || '—') + '</div></div>' +
      '<div class="param"><div class="p-label">Recupero</div><div class="p-value">' + esc(ex.rest || '—') + '</div></div></div>' +
      (ex.note ? '<div class="exercise-note">' + rich(ex.note) + '</div>' : '') +
      '<div class="ex-log">' + log + actions + noteField + '</div></article>';
  }
  function segButtons(c, act, current, options) {
    return '<div class="seg">' + options.map((o) => '<button type="button" class="btn" data-act="' + act + '" data-v="' + o[0] + '" aria-pressed="' + (current === o[0] ? 'true' : 'false') + '"' + dis(c) + '>' + esc(o[1]) + '</button>').join('') + '</div>';
  }
  function renderSession(c, w, day) {
    const doc = c.docs[w.id + '_' + day.id] || {};
    let html = '<section class="session-head"><div><h2>' + esc(day.label) + ' · ' + esc(day.title || '') + '</h2><p>Prevista ' + esc(longDate(day.date)) + '</p></div>' +
      '<div class="field"><label for="date-' + esc(day.id) + '">Data in cui la fai</label><input type="date" id="date-' + esc(day.id) + '" data-k="s" data-f="date" value="' + esc(doc.date || day.date || '') + '"' + dis(c) + '></div></section>';
    const exs = day.exercises || [];
    exs.forEach((ex, i) => {
      const next = exs[i + 1];
      if (next && next.superset && !ex.superset) html += '<div class="superset-label">⟳ Superset</div>';
      html += renderExercise(c, w, day, ex, i, doc);
    });
    const pv = doc.painMax == null ? null : doc.painMax;
    let scale = '<div class="scale" role="group" aria-label="Dolore massimo da 0 a 10">';
    for (let v = 0; v <= 10; v++) scale += '<button type="button" class="' + (v <= 3 ? 'lo' : v <= 6 ? 'mid' : 'hi') + '" data-act="pain" data-v="' + v + '" aria-pressed="' + (pv === v ? 'true' : 'false') + '"' + dis(c) + '>' + v + '</button>';
    scale += '</div><div class="scale-legend"><span>0 nessuno</span><span>3 limite accettabile</span><span>10 massimo</span></div>';
    html += '<section class="panel" aria-label="Fine seduta"><h3>Fine seduta</h3>' +
      '<p class="hint">Durante l\'esercizio un fastidio fino a 3 su 10 va bene, se la mattina dopo è tornato com\'era prima. Oltre 3, o se il giorno dopo è peggio, nella seduta successiva riduci profondità e carico di quell\'esercizio.</p>' +
      '<div class="field"><span class="label">Dolore massimo durante la seduta</span>' + scale + '</div>' +
      '<div class="field"><label for="pw-' + esc(day.id) + '">Dove, e in quale esercizio</label><input type="text" autocomplete="off" placeholder="Es. gluteo destro nel goblet squat, ultima serie" id="pw-' + esc(day.id) + '" data-k="s" data-f="painWhere" value="' + esc(doc.painWhere || '') + '"' + dis(c) + '></div>' +
      '<div class="field"><span class="label">La mattina dopo (compila il giorno seguente)</span>' +
      segButtons(c, 'morning', doc.morning || '', [['none', 'Nessun fastidio'], ['same', 'Come prima della seduta'], ['worse', 'Peggio']]) + '</div>' +
      '<div class="field"><label for="sn-' + esc(day.id) + '">Note sulla seduta</label><textarea rows="2" placeholder="Stanchezza, tempi, cosa è andato bene o male" id="sn-' + esc(day.id) + '" data-k="s" data-f="note"' + dis(c) + '>' + esc(doc.note || '') + '</textarea></div>' +
      '<button type="button" class="btn done-btn" data-act="done" aria-pressed="' + (doc.done ? 'true' : 'false') + '"' + dis(c) + '>' + (doc.done ? '✓ Seduta completata' : 'Segna la seduta come completata') + '</button></section>';
    return html;
  }
  function renderCheckin(c, w) {
    const ci = c.docs[w.id + '_week'] || {};
    return '<section class="panel" aria-label="Check-in di fine settimana"><h3>Check-in di fine settimana</h3>' +
      '<p class="hint">Serve a ' + esc(COACH) + ' per preparare la settimana successiva.</p>' +
      '<div class="field"><span class="label">Dolore nelle attività quotidiane (camminare, scale, a riposo, di notte)</span>' + segButtons(c, 'ci-daily', ci.daily || '', [['no', 'No'], ['si', 'Sì']]) + '</div>' +
      '<div class="field"><label for="ci-volley">Sport e attività della settimana</label><input type="text" autocomplete="off" placeholder="Es. 3 allenamenti + partita venerdì, tanti salti mercoledì" id="ci-volley" data-k="ci" data-f="volley" value="' + esc(ci.volley || '') + '"' + dis(c) + '></div>' +
      '<div class="field"><span class="label">Partita la domenica della prossima settimana</span>' + segButtons(c, 'ci-nextSunday', ci.nextSunday || '', [['no', 'No'], ['si', 'Sì'], ['forse', 'Non so']]) + '</div>' +
      '<div class="field"><label for="ci-note">Note per ' + esc(COACH) + '</label><textarea rows="3" placeholder="Come ti sei sentito, cosa vuoi chiedere" id="ci-note" data-k="ci" data-f="note"' + dis(c) + '>' + esc(ci.note || '') + '</textarea></div></section>';
  }
  function renderDay(c, w) {
    if (!w) { setHTML('dayView', ''); return; }
    const who = c.coach && !c.readOnly ? '<div class="banner coach-edit">Stai compilando per <strong>' + esc(c.b.cliente.nome) + '</strong>: i dati finiscono nella sua scheda e li vede anche lui.' +
      (w._stato !== 'pubblicata' ? ' Questa settimana è ancora in bozza.' : '') + '</div>' : '';
    if (S.dayId === 'week') { setHTML('dayView', who + renderCheckin(c, w)); return; }
    const day = (w.days || []).find((d) => d.id === S.dayId);
    setHTML('dayView', day ? who + renderSession(c, w, day) : '');
  }
  function refreshIndicators() {
    if (!canEdit()) return;
    const c = ctx(); const w = curWeek(c); if (!w) return;
    const day = (w.days || []).find((d) => d.id === S.dayId);
    if (day) {
      const doc = c.docs[w.id + '_' + day.id];
      for (const ex of day.exercises || []) {
        const card = document.querySelector('[data-card="' + CSS.escape(ex.key) + '"]');
        if (card) card.classList.toggle('complete', exComplete(ex, doc && doc.ex && doc.ex[ex.key]));
      }
    }
  }

  /* ---------- rendering: coach ---------- */
  function morningLabel(v) { return ({ none: 'nessun fastidio', same: 'come prima', worse: 'peggio' })[v] || ''; }
  function painChip(v) { if (v == null) return ''; const k = v <= 3 ? 'ok' : v <= 6 ? 'warn' : 'bad'; return '<span class="chip ' + k + '">dolore ' + esc(v) + '/10</span>'; }

  function importPanel(withClose) {
    const u = S.ui;
    if (!u.importOpen) return '';
    let html = '<section class="panel" aria-label="Incolla da Claude"><h2>Incolla da Claude</h2>' +
      '<p class="hint">Incolla il blocco che ti ha preparato Claude (nuovo cliente, settimana o regole). Prima di salvare vedi cosa contiene.</p>' +
      '<textarea id="importText" data-k="import" rows="6" placeholder="Incolla qui…">' + esc(u.importText) + '</textarea>';
    if (u.importError) html += '<p class="hint" style="color:var(--color-danger-text)">' + esc(u.importError) + '</p>';
    if (u.parsed) {
      html += '<div class="confirm"><span>' + esc(describeImport(u.parsed)) + '</span><div class="row"><button type="button" class="btn primary" data-act="c-import-do"' + (u.busy ? ' disabled' : '') + '>Salva</button><button type="button" class="btn" data-act="c-import-reset">Annulla</button></div></div>';
    } else {
      html += '<div class="row"><button type="button" class="btn primary" data-act="c-import-check">Controlla</button>' + (withClose ? '<button type="button" class="btn" data-act="c-import-close">Chiudi</button>' : '') + '</div>';
    }
    return html + '</section>';
  }
  function describeImport(p) {
    const wk = p.settimana;
    const wdesc = wk ? (wk.label || wk.id) + (wk.dates ? ' (' + wk.dates + ')' : '') + ', ' + (wk.days || []).length + ' sedute' : '';
    if (p.tipo === 'cliente') return 'Nuovo cliente: ' + (p.nome || p.id) + (wk ? '. Prima settimana: ' + wdesc + ', salvata come bozza.' : '.') + ' Verrà creato un link personale.';
    if (p.tipo === 'settimana') {
      const known = S.coachBundle && S.coachBundle.cliente.id === p.cliente ? weeksOf(S.coachBundle).find((w) => w.id === (wk && wk.id)) : null;
      const who = (S.clienti || []).find((x) => x.id === p.cliente);
      const name = who ? who.nome : p.cliente;
      if (known && known._stato === 'pubblicata') return 'Attenzione: ' + wdesc + ' per ' + name + ' è già pubblicata. Salvando la sostituisci e il cliente vede subito la nuova versione.';
      return wdesc + ' per ' + name + ', salvata come bozza: il cliente non la vede finché non la pubblichi.';
    }
    if (p.tipo === 'config') return 'Nuove istruzioni e regole generali per ' + p.cliente + '.';
    return 'Contenuto sconosciuto.';
  }
  function parseImport(text) {
    const t = String(text || '');
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('Non trovo il blocco da importare: incolla tutto il testo che ti ha dato Claude.');
    let p;
    try { p = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error('Il blocco è incompleto o modificato: copialo di nuovo per intero.'); }
    if (!p || !['cliente', 'settimana', 'config'].includes(p.tipo)) throw new Error('Questo blocco non è da importare (forse è un\'esportazione per Claude).');
    if ((p.tipo === 'settimana' || p.tipo === 'config') && !p.cliente) throw new Error('Nel blocco manca il cliente.');
    return p;
  }

  function renderCoachHome() {
    const u = S.ui;
    setHTML('tools', importPanel(true) || '<div class="row"><button type="button" class="btn" data-act="c-import-open">Incolla da Claude</button><button type="button" class="btn" data-act="c-refresh">Aggiorna</button></div>');
    if (!S.clienti) { setHTML('clientList', '<div class="banner">Caricamento clienti…</div>'); renderFooter(); return; }
    if (!S.clienti.length) { setHTML('clientList', '<div class="banner"><strong>Nessun cliente.</strong> Chiedi a Claude di prepararti il blocco "nuovo cliente" e incollalo con "Incolla da Claude".</div>'); renderFooter(); return; }
    setHTML('clientList', S.clienti.map((cl) => '<button type="button" class="client-item" data-act="c-open" data-id="' + esc(cl.id) + '"><div><div class="name">' + esc(cl.nome) + '</div>' +
      '<div class="meta">' + (cl.settimanaCorrente ? 'In corso: ' + esc(cl.settimanaCorrente.replace('w', 'settimana ')) : 'Nessuna settimana pubblicata') + (cl.ultimaAttivita ? ' · ultimo dato ' + esc(stamp(cl.ultimaAttivita)) : '') + '</div></div>' +
      '<div class="row">' + (cl.bozze && cl.bozze.length ? '<span class="chip warn">' + cl.bozze.length + ' bozza da pubblicare</span>' : '') + (cl.attivo ? '' : '<span class="chip bad">accesso disattivato</span>') + '</div></button>').join(''));
    renderFooter();
    void u;
  }

  function renderClientTools() {
    const u = S.ui; const m = S.coachMeta;
    let html = '';
    if (u.importOpen) html += importPanel(true);
    let access = '';
    if (m) {
      if (u.confirm === 'deactivate') access = '<div class="confirm"><span>' + (m.attivo ? 'Disattivare l\'accesso? Il cliente non potrà più aprire la scheda finché non lo riattivi.' : 'Riattivare l\'accesso con il link attuale?') + '</span><div class="row"><button type="button" class="btn danger" data-act="c-active-yes">' + (m.attivo ? 'Disattiva' : 'Riattiva') + '</button><button type="button" class="btn" data-act="cancel">Annulla</button></div></div>';
      else if (u.confirm === 'newcode') access = '<div class="confirm"><span>Generare un nuovo link? Quello vecchio smette subito di funzionare e dovrai mandare quello nuovo al cliente.</span><div class="row"><button type="button" class="btn danger" data-act="c-newcode-yes">Genera nuovo link</button><button type="button" class="btn" data-act="cancel">Annulla</button></div></div>';
    }
    html += '<section class="panel" aria-label="Strumenti"><div class="row">' +
      '<button type="button" class="btn" data-act="c-copylink"' + (m ? '' : ' disabled') + '>Copia link del cliente</button>' +
      '<button type="button" class="btn" data-act="c-export"' + (S.coachBundle ? '' : ' disabled') + '>Copia dati per Claude</button>' +
      (u.importOpen ? '' : '<button type="button" class="btn" data-act="c-import-open">Incolla da Claude</button>') +
      '<button type="button" class="btn" data-act="c-refresh">Aggiorna</button></div>' +
      (u.copied ? '<p class="hint">' + esc(u.copied) + '</p>' : '') +
      (m ? '<div class="row"><span class="chip ' + (m.attivo ? 'ok' : 'bad') + '">accesso ' + (m.attivo ? 'attivo' : 'disattivato') + '</span><button type="button" class="btn link" data-act="c-active">' + (m.attivo ? 'Disattiva accesso' : 'Riattiva accesso') + '</button><button type="button" class="btn link" data-act="c-newcode">Genera nuovo link</button></div>' : '') +
      access + '</section>';
    setHTML('tools', html);
  }

  function renderDraftBar(c, w) {
    if (!w || w._stato === 'pubblicata') { setHTML('draftBar', ''); return; }
    const u = S.ui;
    setHTML('draftBar', '<div class="banner warn"><div class="stack"><span><strong>Bozza: il cliente non la vede.</strong> Controllala qui sotto: è esattamente quello che vedrà.</span>' +
      (u.confirm === 'publish'
        ? '<div class="row"><span>Pubblicare ' + esc(w.label || w.id) + '? Il cliente la trova subito aprendo l\'app.</span><button type="button" class="btn primary" data-act="c-publish-yes"' + (u.busy ? ' disabled' : '') + '>Pubblica</button><button type="button" class="btn" data-act="cancel">Annulla</button></div>'
        : '<div class="row"><button type="button" class="btn primary" data-act="c-publish">Pubblica questa settimana</button></div>') +
      '</div></div>');
  }

  function renderSummary(c, w) {
    if (!w) { setHTML('summary', ''); return; }
    const rows = (w.days || []).map((d) => {
      const p = dayProgress(c, w, d); const doc = p.doc || {};
      return '<div class="sum-row"><b>' + esc(d.label) + ' ' + esc(shortDate(d.date)) + '</b><span>' + p.done + '/' + p.total + ' esercizi</span>' +
        (doc.done ? '<span class="chip ok">completata ' + esc(longDate(doc.date || d.date)) + '</span>' : '<span class="chip">da fare</span>') + painChip(doc.painMax) +
        (doc.morning ? '<span class="chip ' + (doc.morning === 'worse' ? 'bad' : 'ok') + '">mattina dopo: ' + esc(morningLabel(doc.morning)) + '</span>' : '') +
        (doc.painWhere ? '<span>' + esc(doc.painWhere) + '</span>' : '') + '</div>';
    }).join('');
    const ci = c.docs[w.id + '_week'] || {};
    const bits = [];
    if (ci.daily) bits.push('<span class="chip ' + (ci.daily === 'si' ? 'bad' : 'ok') + '">dolore quotidiano: ' + (ci.daily === 'si' ? 'sì' : 'no') + '</span>');
    if (ci.nextSunday) bits.push('<span class="chip ' + (ci.nextSunday === 'si' ? 'warn' : '') + '">partita domenica prossima: ' + esc({ si: 'sì', no: 'no', forse: 'non so' }[ci.nextSunday] || '') + '</span>');
    setHTML('summary', '<section class="panel" aria-label="Riepilogo"><h2>Riepilogo ' + esc(w.label || w.id) + '</h2><div class="sum-rows">' + rows +
      '<div class="sum-row"><b>Check-in</b>' + (bits.join('') || '<span>non compilato</span>') + (ci.note ? '<span>' + esc(ci.note) + '</span>' : '') + '</div></div>' +
      '<div class="field"><label for="coachText">Nota per ' + esc(c.b.cliente.nome.split(' ')[0]) + ' (la vede in cima alla settimana)</label>' +
      '<textarea id="coachText" data-k="coach" rows="3" placeholder="Es. ottimo controllo, sabato aumenta il goblet di 2 kg">' + esc(w._note || '') + '</textarea>' +
      '<p class="hint" id="noteState"></p></div></section>');
  }

  /* ---------- esportazione per Claude ---------- */
  function exportForClaude(b) {
    const weeks = weeksOf(b);
    const pubs = weeks.filter((w) => w._stato === 'pubblicata');
    const ids = new Set(pubs.slice(-2).map((w) => w.id).concat(weeks.filter((w) => w._stato !== 'pubblicata').map((w) => w.id)));
    const logs = {};
    Object.keys(b.logs || {}).forEach((k) => { if (ids.has(k.split('_')[0])) logs[k] = b.logs[k]; });
    const out = {
      tipo: 'export', esportato: new Date().toISOString(),
      cliente: { id: b.cliente.id, nome: b.cliente.nome, settimanaCorrente: b.cliente.settimanaCorrente },
      settimane: weeks.map((w) => ({ id: w.id, stato: w._stato, label: w.label, dates: w.dates })),
      dettaglio: weeks.filter((w) => ids.has(w.id)).map((w) => {
        const prog = Object.assign({}, w); delete prog._stato; delete prog._note;
        return { id: w.id, stato: w._stato, nota_coach: w._note, programma: prog };
      }),
      dati: logs
    };
    return 'Dati della scheda di ' + b.cliente.nome + ' da analizzare:\n\n```json\n' + JSON.stringify(out) + '\n```';
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); let ok = false;
      try { ok = document.execCommand('copy'); } catch (x) { ok = false; }
      document.body.removeChild(ta); return ok;
    }
  }

  /* ---------- eventi ---------- */
  document.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'loginForm') return;
    ev.preventDefault();
    const code = codeFromText($('codeInput').value);
    if (!code) { S.loginError = 'Non trovo un codice valido: incolla il link completo.'; renderAll(true); return; }
    $('loginBtn').disabled = true;
    await enter(code);
  });

  async function enter(code) {
    S.code = code;
    try {
      const r = await api('login');
      store.set(K.code, code); store.set(K.role, { code: code, role: r.role });
      S.loginError = '';
      if (r.role === 'coach') { S.role = 'coach'; S.clienti = r.clienti; S.lastSync = new Date().toISOString(); go('coach-home'); resumeCoachOutbox(); }
      else { S.role = 'cliente'; applyBundle(r.data); store.set(K.bundle, { code: code, data: r.data }); mergeOutbox(); go('client'); }
    } catch (e) {
      S.code = null;
      S.loginError = e.code === 'codice' ? 'Codice non valido o disattivato.' : 'Serve la connessione per il primo accesso. Riprova quando hai campo.';
      go('login');
    }
  }

  document.addEventListener('click', async (ev) => {
    const wk = ev.target.closest('[data-week]');
    if (wk) {
      const c = ctx(); S.weekId = wk.dataset.week; S.weekManual = !c.coach && S.weekId !== c.current; S.dayId = null; S.ui.confirm = null;
      if (!c.coach) store.set(K.view, { weekId: S.weekId, dayId: S.dayId });
      renderAll(true); return;
    }
    const dy = ev.target.closest('[data-day]');
    if (dy) {
      S.dayId = dy.dataset.day;
      if (S.role === 'cliente') store.set(K.view, { weekId: S.weekId, dayId: S.dayId });
      renderAll(true);
      const t = $('dayTabs'); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
      return;
    }
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;

    // comuni
    if (act === 'logout') { S.ui.confirm = 'logout'; renderFooter(); return; }
    if (act === 'logout-yes') { S.ui.confirm = null; logout(''); return; }
    if (act === 'cancel') { S.ui.confirm = null; renderAll(true); return; }
    if (act === 'note') {
      const t = btn.dataset.target; S.openNotes['ex-' + t] = true;
      const f = document.querySelector('[data-notefield="' + CSS.escape(t) + '"]');
      if (f) { f.hidden = false; btn.hidden = true; const ta = f.querySelector('textarea'); if (ta) ta.focus(); }
      return;
    }

    // coach
    if (act.startsWith('c-')) return coachAction(act, btn);

    // compilazione della scheda (cliente, o coach per conto del cliente)
    if (!canEdit()) return;
    const c = ctx(); const w = curWeek(c); if (!w) return;
    if (act.startsWith('ci-')) {
      const ci = ensureCheckin(w.id); const f = act.slice(3); const v = btn.dataset.v;
      ci[f] = ci[f] === v ? '' : v;
      btn.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === ci[f])));
      touch(w.id + '_week'); renderDayTabs(ctx(), w); return;
    }
    const doc = ensureSession(w.id, S.dayId); const id = w.id + '_' + S.dayId;
    if (act === 'exdone') {
      const e = ensureEx(doc, btn.dataset.ex); e.done = !e.done;
      btn.setAttribute('aria-pressed', String(e.done)); btn.textContent = e.done ? '✓ Fatto' : 'Segna come fatto';
    } else if (act === 'pain') {
      const v = Number(btn.dataset.v); doc.painMax = doc.painMax === v ? null : v;
      btn.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === doc.painMax)));
    } else if (act === 'morning') {
      const v = btn.dataset.v; doc.morning = doc.morning === v ? '' : v;
      btn.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === doc.morning)));
    } else if (act === 'done') {
      doc.done = !doc.done;
      btn.setAttribute('aria-pressed', String(doc.done)); btn.textContent = doc.done ? '✓ Seduta completata' : 'Segna la seduta come completata';
      touch(id); renderDayTabs(ctx(), w); return;
    } else return;
    touch(id);
  });

  async function coachAction(act, btn) {
    const u = S.ui;
    if (act === 'c-open') { S.coachClient = btn.dataset.id; S.coachBundle = null; S.coachMeta = null; u.copied = ''; u.msg = ''; u.confirm = null; go('coach-client'); loadCoachClient(S.coachClient); return; }
    if (act === 'c-back') { S.coachClient = null; S.coachBundle = null; u.copied = ''; u.msg = ''; u.confirm = null; u.importOpen = false; go('coach-home'); refreshCoachList(); return; }
    if (act === 'c-refresh') { u.msg = ''; if (S.screen === 'coach-home') refreshCoachList(); else loadCoachClient(S.coachClient); return; }
    if (act === 'c-import-open') { u.importOpen = true; u.importText = ''; u.parsed = null; u.importError = ''; renderAll(true); const t = $('importText'); if (t) t.focus(); return; }
    if (act === 'c-import-close') { u.importOpen = false; u.parsed = null; u.importError = ''; renderAll(true); return; }
    if (act === 'c-import-reset') { u.parsed = null; renderAll(true); return; }
    if (act === 'c-import-check') {
      const t = $('importText'); if (t) u.importText = t.value;
      try { u.parsed = parseImport(u.importText); u.importError = ''; } catch (e) { u.parsed = null; u.importError = e.message; }
      renderAll(true); return;
    }
    if (act === 'c-import-do') {
      if (!u.parsed) return;
      u.busy = true; renderAll(true);
      try {
        const r = await api('importa', { payload: u.parsed });
        u.busy = false; u.importOpen = false; u.parsed = null; u.importText = ''; u.importError = '';
        if (r.cliente) { S.coachClient = r.cliente; S.coachBundle = null; S.coachMeta = null; u.copied = r.tipo === 'cliente' ? 'Cliente creato. Controlla la bozza, pubblicala e poi copia il link da mandargli.' : ''; go('coach-client'); await loadCoachClient(r.cliente); if (r.settimana) { S.weekId = r.settimana.id; renderAll(true); } }
      } catch (e) { u.busy = false; u.parsed = null; u.importError = e.message || 'Errore durante il salvataggio.'; renderAll(true); }
      return;
    }
    if (act === 'c-copylink') {
      if (!S.coachMeta) return;
      const ok = await copyText(clientLink(S.coachMeta.codice));
      u.copied = ok ? 'Link copiato: mandalo al cliente su WhatsApp o per email.' : 'Copia non riuscita. Link: ' + clientLink(S.coachMeta.codice);
      renderClientTools(); return;
    }
    if (act === 'c-export') {
      if (!S.coachBundle) return;
      const ok = await copyText(exportForClaude(S.coachBundle));
      u.copied = ok ? 'Dati copiati: incollali nella chat con Claude.' : 'Copia non riuscita: riprova da un altro browser.';
      renderClientTools(); return;
    }
    if (act === 'c-publish') { u.confirm = 'publish'; renderAll(true); return; }
    if (act === 'c-publish-yes') {
      u.busy = true; renderAll(true);
      try {
        const r = await api('pubblica', { cliente: S.coachClient, settimana: S.weekId });
        S.coachBundle = r.data; S.coachMeta = { codice: r.codice, attivo: r.attivo }; u.busy = false; u.confirm = null; u.copied = 'Settimana pubblicata: il cliente la vede subito.'; renderAll(true);
      } catch (e) { u.confirm = null; coachError(e); }
      return;
    }
    if (act === 'c-active') { u.confirm = 'deactivate'; renderClientTools(); return; }
    if (act === 'c-active-yes') {
      try { const r = await api('attivo', { cliente: S.coachClient, attivo: !S.coachMeta.attivo }); S.coachMeta.attivo = r.attivo; u.confirm = null; renderClientTools(); } catch (e) { coachError(e); }
      return;
    }
    if (act === 'c-newcode') { u.confirm = 'newcode'; renderClientTools(); return; }
    if (act === 'c-newcode-yes') {
      try { const r = await api('nuovoCodice', { cliente: S.coachClient }); S.coachMeta.codice = r.codice; u.confirm = null; u.copied = 'Nuovo link creato: copialo e mandalo al cliente.'; renderClientTools(); } catch (e) { coachError(e); }
    }
  }

  const noteTimer = { t: null, busy: false, again: false };
  async function saveCoachNote() {
    if (noteTimer.busy) { noteTimer.again = true; return; }
    const ta = $('coachText'); if (!ta || !S.coachBundle) return;
    noteTimer.busy = true;
    const week = S.weekId; const text = ta.value;
    const st = $('noteState'); if (st) st.textContent = 'Salvataggio…';
    try {
      await api('nota', { cliente: S.coachClient, settimana: week, testo: text });
      const wk = (S.coachBundle.weeks || []).find((w) => w.id === week); if (wk) wk.note = text;
      const st2 = $('noteState'); if (st2) st2.textContent = 'Nota salvata.';
    } catch (e) { const st3 = $('noteState'); if (st3) st3.textContent = 'Nota non salvata: ' + (e.code === 'rete' ? 'connessione assente.' : e.message); }
    noteTimer.busy = false;
    if (noteTimer.again) { noteTimer.again = false; saveCoachNote(); }
  }

  document.addEventListener('input', (ev) => {
    const el = ev.target; const k = el.dataset && el.dataset.k;
    if (!k) return;
    if (k === 'import') { S.ui.importText = el.value; return; }
    if (k === 'coach') { clearTimeout(noteTimer.t); noteTimer.t = setTimeout(saveCoachNote, 1200); return; }
    if (!canEdit()) return;
    const c = ctx(); const w = curWeek(c); if (!w) return;
    if (k === 'ci') { ensureCheckin(w.id)[el.dataset.f] = el.value; touch(w.id + '_week'); return; }
    const doc = ensureSession(w.id, S.dayId); const id = w.id + '_' + S.dayId;
    if (k === 's') doc[el.dataset.f] = el.value;
    else if (k === 'exf') ensureEx(doc, el.dataset.ex)[el.dataset.f] = el.value;
    else if (k === 'set') {
      const e = ensureEx(doc, el.dataset.ex); const i = Number(el.dataset.i);
      while (e.sets.length <= i) e.sets.push({});
      e.sets[i] = e.sets[i] || {}; e.sets[i][el.dataset.f] = num(el.value);
    } else return;
    touch(id);
  });

  document.addEventListener('toggle', (ev) => { const d = ev.target; if (d && d.dataset && d.dataset.note) S.openNotes[d.dataset.note] = d.open; }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.online) return;
    if (S.role === 'cliente' && S.screen === 'client') refreshClient();
    if (S.role === 'coach' && S.screen === 'coach-home') refreshCoachList();
    if (S.role === 'coach' && S.screen === 'coach-client' && !S.ui.confirm && !S.ui.importOpen) loadCoachClient(S.coachClient, true);
  });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !S.online || isEditing()) return;
    if (S.role === 'coach' && S.screen === 'coach-client' && !S.ui.confirm && !S.ui.importOpen && !S.ui.busy && !coachPending()) loadCoachClient(S.coachClient, true);
  }, 60000);

  /* ---------- avvio ---------- */
  function start() {
    if (!/^https:\/\//.test(API) && !/^http:\/\/localhost/.test(API)) { go('setup'); return; }
    const urlCode = codeFromUrl();
    const saved = store.get(K.code, null);
    const savedRole = store.get(K.role, null);
    if (urlCode && urlCode !== saved) { S.screen = 'boot'; enter(urlCode); return; }
    S.code = saved;
    if (!S.code) { go('login'); return; }
    const role = savedRole && savedRole.code === S.code ? savedRole.role : null;
    if (role === 'coach') { S.role = 'coach'; go('coach-home'); refreshCoachList(); resumeCoachOutbox(); return; }
    if (role === 'cliente') {
      S.role = 'cliente';
      const cached = store.get(K.bundle, null);
      if (cached && cached.code === S.code) { applyBundle(cached.data); mergeOutbox(); }
      go('client'); refreshClient(); return;
    }
    enter(S.code);
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* app funziona anche senza */ }); });
  }
  start();
})();
