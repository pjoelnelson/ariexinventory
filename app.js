'use strict';
/* Barcode Inventory - cloud version (static site on GitHub Pages + Supabase database) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RANK = { pending: 0, disabled: 0, viewer: 1, operator: 2, admin: 3 };
const app = $('#app');
let me = null;        // { id, email, role }
let cleanup = null;   // called when leaving a page (timers, key handlers, camera)

// ------------------------------------------------------------ Supabase connection
const CFG = window.INVENTORY_CONFIG || {};
const configured = Boolean(CFG.supabaseUrl && CFG.supabaseKey && !CFG.supabaseUrl.includes('YOUR-PROJECT') && !CFG.supabaseKey.startsWith('YOUR-'));
const sb = configured && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

function friendly(error) {
  const m = String((error && (error.message || error.error_description)) || error || 'Something went wrong');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Can't reach the database. Check the internet connection. (If it persists, the Supabase project may be paused: restore it at supabase.com.)";
  if (/items_barcode_key|duplicate key.*barcode/i.test(m)) return 'That barcode is already registered to another item';
  if (/row-level security|permission denied|multiple \(or no\) rows/i.test(m)) return 'Your account is not allowed to do this';
  if (/Invalid login credentials/i.test(m)) return 'Wrong email or password';
  if (/Email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox), then sign in';
  return m;
}
async function must(query) {
  const { data, error } = await query;
  if (error) throw new Error(friendly(error));
  return data;
}
async function mustCount(query) {
  const { data, error, count } = await query;
  if (error) throw new Error(friendly(error));
  return { data, count };
}
// Text for PostgREST "or" filters: drop characters that have meaning in that syntax.
const cleanTerm = (s) => String(s || '').replace(/[,()%*\\:"']/g, ' ').trim();

const db = {
  async loadMe() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const p = await must(sb.from('profiles').select('id, email, role').eq('id', session.user.id).maybeSingle());
    return p || { id: session.user.id, email: session.user.email, role: 'pending' };
  },
  scan: (barcode, direction, qty, note) => must(sb.rpc('scan_item', { p_barcode: barcode, p_direction: direction, p_qty: qty, p_note: note })),
  stats: (since) => must(sb.rpc('dashboard_stats', { p_since: since })),
  items(term) {
    let q = sb.from('items').select('*').order('name').limit(1000);
    const s = cleanTerm(term);
    if (s) q = q.or(`barcode.ilike.%${s}%,name.ilike.%${s}%,location.ilike.%${s}%,description.ilike.%${s}%`);
    return must(q);
  },
  item: (id) => must(sb.from('items').select('*').eq('id', id).maybeSingle()),
  createItem: (d) => must(sb.from('items').insert(itemPayload(d)).select().single()),
  updateItem: (id, d) => must(sb.from('items').update(itemPayload(d)).eq('id', id).select().single()),
  deleteItem: (id) => must(sb.from('items').delete().eq('id', id)),
  adjust: (id, quantity, note) => must(sb.rpc('adjust_stock', { p_item_id: id, p_quantity: quantity, p_note: note })),
  txQuery(f, opts) {
    let q = sb.from('transactions').select('*', opts).order('id', { ascending: false });
    const s = cleanTerm(f.q);
    if (s) q = q.or(`barcode.ilike.%${s}%,item_name.ilike.%${s}%,note.ilike.%${s}%,username.ilike.%${s}%`);
    if (f.direction) q = q.eq('direction', f.direction);
    if (f.itemId) q = q.eq('item_id', f.itemId);
    if (f.from) q = q.gte('created_at', f.from);
    if (f.to) q = q.lt('created_at', f.to);
    return q;
  },
  users: () => must(sb.from('profiles').select('*').order('created_at')),
  setRole: (id, role) => must(sb.rpc('set_user_role', { p_user: id, p_role: role })),
};
function itemPayload(d) {
  return {
    name: String(d.name || '').trim().slice(0, 120),
    barcode: String(d.barcode || '').trim().slice(0, 120) || null,
    location: String(d.location || '').trim().slice(0, 120),
    description: String(d.description || '').trim().slice(0, 1000),
    min_quantity: Math.max(0, parseInt(d.min_quantity, 10) || 0),
  };
}
// Supabase returns at most 1000 rows per request, so big exports are fetched in pages.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; out.length < 200000; from += 1000) {
    const rows = await must(build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ------------------------------------------------------------ helpers
function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtNum = (n) => Number(n).toLocaleString();
const can = (role) => me && RANK[me.role] >= RANK[role];
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function localDayBounds(dateStr, endOfDay) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
const scriptLoads = {};
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve();
  scriptLoads[src] = scriptLoads[src] || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { delete scriptLoads[src]; s.remove(); reject(new Error('Could not load ' + src + ' (is the internet connected?)')); };
    document.head.appendChild(s);
  });
  return scriptLoads[src];
}
function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function hashParams() { return new URLSearchParams(location.hash.split('?')[1] || ''); }
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, cols) {
  return '﻿' + [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n');
}
function downloadFile(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const today = () => new Date().toISOString().slice(0, 10);

let audioCtx;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = ok ? [[880, 0, 0.09]] : [[220, 0, 0.18], [180, 0.22, 0.25]];
    for (const [freq, start, dur] of tones) {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.frequency.value = freq; o.type = ok ? 'sine' : 'square';
      g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + start; o.start(t0); o.stop(t0 + dur);
    }
  } catch { /* sound is optional */ }
}

// Modal form. onSubmit(data) may throw to show an error and keep the dialog open.
function formDialog({ title, body = '', submit = 'Save', danger = false, onSubmit = () => true }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog'); const form = $('#dialogForm');
    form.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="err-msg"></div>
      <div class="row"><button type="button" class="btn" data-cancel>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(submit)}</button></div>`;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]'); btn.disabled = true;
      try { const r = await onSubmit(Object.fromEntries(new FormData(form))); dlg.close(); resolve(r ?? true); }
      catch (err) { form.querySelector('.err-msg').textContent = err.message; btn.disabled = false; }
    };
    form.querySelector('[data-cancel]').onclick = () => { dlg.close(); resolve(null); };
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
    const first = form.querySelector('input, select, textarea'); if (first) first.focus();
  });
}
const confirmDialog = (title, message, submit = 'Delete') =>
  formDialog({ title, body: `<p>${esc(message)}</p>`, submit, danger: true });

function itemFields(item = {}) {
  return `
    <label>Name *<input name="name" required maxlength="120" value="${esc(item.name)}"></label>
    <label>Barcode / QR value<input name="barcode" maxlength="120" value="${esc(item.barcode)}" placeholder="Leave empty to auto-create one (INV-000123)"></label>
    <label>Location<input name="location" maxlength="120" value="${esc(item.location)}" placeholder="e.g. Shelf A3"></label>
    <label>Low-stock alert at<input name="min_quantity" type="number" min="0" value="${esc(item.min_quantity ?? 0)}"></label>
    <label>Description<textarea name="description" rows="2" maxlength="1000">${esc(item.description)}</textarea></label>`;
}

function txTable(rows, { showItem = true, compact = false } = {}) {
  if (!rows.length) return '<div class="empty">No records yet.</div>';
  if (compact) {
    return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Item</th><th class="num">Qty</th><th class="num">Stock</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(new Date(r.created_at).toLocaleTimeString([], { timeStyle: 'short' }))}</td>
        <td><span class="tag ${r.direction}">${r.direction}</span></td><td>${esc(r.item_name)}</td>
        <td class="num">${r.direction === 'OUT' ? '−' : '+'}${fmtNum(r.qty)}</td><td class="num">${fmtNum(r.balance_after)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  return `<div class="table-wrap"><table><thead><tr>
    <th>When</th><th>Type</th>${showItem ? '<th>Item</th><th>Barcode</th>' : ''}<th class="num">Qty</th><th class="num">Stock after</th><th>By</th><th>Note</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${esc(fmtTime(r.created_at))}</td>
      <td><span class="tag ${r.direction}">${r.direction === 'ADJUST' ? 'COUNT' : r.direction}</span></td>
      ${showItem ? `<td>${esc(r.item_name)}</td><td class="code">${esc(r.barcode)}</td>` : ''}
      <td class="num">${r.direction === 'OUT' ? '−' + fmtNum(r.qty) : (r.qty >= 0 ? '+' : '−') + fmtNum(Math.abs(r.qty))}</td>
      <td class="num">${fmtNum(r.balance_after)}</td>
      <td>${esc(r.username)}</td>
      <td class="muted">${esc(r.note)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ------------------------------------------------------------ pages
const PAGES = {
  scan: { title: 'Scan', role: 'operator', render: renderScan },
  dashboard: { title: 'Dashboard', role: 'viewer', render: renderDashboard },
  items: { title: 'Items', role: 'viewer', render: renderItems },
  history: { title: 'History', role: 'viewer', render: renderHistory },
  labels: { title: 'Labels', role: 'operator', render: renderLabels },
  users: { title: 'Users', role: 'admin', render: renderUsers },
  account: { title: 'My account', role: 'viewer', render: renderAccount },
};

async function route() {
  if (cleanup) { const c = cleanup; cleanup = null; c(); }
  if (!sb) { $('#topbar').hidden = true; return renderNotConfigured(); }
  if (!me) { $('#topbar').hidden = true; return renderLogin(); }
  if (RANK[me.role] < 1) { $('#topbar').hidden = true; return renderWaiting(); }
  let name = location.hash.slice(1).split('?')[0];
  if (!PAGES[name] || !can(PAGES[name].role)) {
    name = can('operator') ? 'scan' : 'dashboard';
    history.replaceState(null, '', '#' + name);
  }
  $('#topbar').hidden = false;
  $('#nav').innerHTML = Object.entries(PAGES).filter(([, p]) => can(p.role))
    .map(([k, p]) => `<a href="#${k}" class="${k === name ? 'active' : ''}">${p.title}</a>`).join('');
  $('#who').innerHTML = `${esc(me.email)} <span class="role">${esc(me.role)}</span>`;
  document.title = `${PAGES[name].title} · Inventory`;
  try { await PAGES[name].render(); }
  catch (err) { app.innerHTML = `<div class="card err-msg">${esc(err.message)}</div>`; }
}
window.addEventListener('hashchange', route);
async function signOut() { if (sb) await sb.auth.signOut().catch(() => {}); me = null; history.replaceState(null, '', location.pathname); route(); }
$('#logout').onclick = signOut;

function renderNotConfigured() {
  app.innerHTML = `<div class="auth card"><h1>Almost there</h1>
    <p>This site isn't connected to a database yet. Open <b>config.js</b> and fill in your Supabase project URL and
    publishable (anon) key, then reload this page.</p>
    ${window.supabase ? '' : '<p class="err-msg">The Supabase library also failed to load. Check the internet connection.</p>'}</div>`;
}

function renderWaiting() {
  const disabled = me.role === 'disabled';
  app.innerHTML = `<div class="auth card"><h1>${disabled ? 'Access removed' : 'Waiting for approval'}</h1>
    <p>You're signed in as <b>${esc(me.email)}</b>.</p>
    <p class="muted">${disabled ? 'An admin has removed your access to the inventory.'
      : 'An admin needs to give your account a role before you can use the inventory. Ask them to open <b>Users</b> and set your role, then click Check again.'}</p>
    <div class="row"><button class="btn primary" id="again">Check again</button><button class="btn" id="out">Sign out</button></div></div>`;
  $('#again').onclick = async () => { me = await db.loadMe().catch(() => me); route(); };
  $('#out').onclick = signOut;
}

// ---- sign in / create account / forgot password
function renderLogin(mode = 'signin') {
  const titles = { signin: 'Sign in', signup: 'Create an account', forgot: 'Reset your password' };
  app.innerHTML = `<div class="auth card">
    <h1>${titles[mode]}</h1>
    ${mode === 'signup' ? '<p class="muted">The first account created becomes the admin. Later accounts wait until an admin gives them a role.</p>' : ''}
    ${mode === 'forgot' ? '<p class="muted">We\'ll email you a link to set a new password.</p>' : ''}
    <form id="authForm">
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      ${mode !== 'forgot' ? `<label>Password<input name="password" type="password" required minlength="${mode === 'signup' ? 8 : 1}"
        autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>` : ''}
      <div class="err-msg" id="authErr"></div>
      <button class="btn primary">${mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</button>
    </form>
    <p class="muted" style="margin-bottom:0">
      ${mode !== 'signin' ? '<button class="link" data-mode="signin">Back to sign in</button>'
        : '<button class="link" data-mode="signup">Create an account</button> · <button class="link" data-mode="forgot">Forgot password?</button>'}
    </p></div>`;
  $$('[data-mode]').forEach((b) => (b.onclick = () => renderLogin(b.dataset.mode)));
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      if (mode === 'signin') {
        await must(sb.auth.signInWithPassword({ email: d.email, password: d.password }));
      } else if (mode === 'signup') {
        const r = await must(sb.auth.signUp({ email: d.email, password: d.password }));
        if (!r.session) { $('#authErr').textContent = ''; app.querySelector('form').outerHTML = '<p><b>Check your email</b> and click the confirmation link, then come back and sign in.</p>'; return; }
      } else {
        await must(sb.auth.resetPasswordForEmail(d.email, { redirectTo: location.origin + location.pathname }));
        app.querySelector('form').outerHTML = '<p>If that email has an account, a reset link is on its way. Open it on this device.</p>';
        return;
      }
      me = await db.loadMe(); route();
    } catch (err) { $('#authErr').textContent = err.message; btn.disabled = false; }
  };
  $('#authForm input').focus();
}

// ---- scan station
const scanLog = [];
function renderScan() {
  let mode = store('scanMode') === 'OUT' ? 'OUT' : 'IN';
  app.innerHTML = `<div class="grid two">
    <section class="card">
      <div class="mode">
        <button type="button" class="in" data-mode="IN">⬇ CHECK IN</button>
        <button type="button" class="out" data-mode="OUT">⬆ CHECK OUT</button>
      </div>
      <button type="button" class="btn camera-btn" id="camBtn">📷 Scan with camera</button>
      <div id="reader" hidden></div>
      <form id="scanForm" class="scanbox">
        <input class="code" id="code" autocomplete="off" spellcheck="false" placeholder="Scan a barcode…" aria-label="Barcode">
        <input id="qty" type="number" min="1" value="1" aria-label="Quantity" title="Quantity">
      </form>
      <input id="note" placeholder="Note (optional): job number, who took it, supplier…" style="width:100%;margin-top:10px" maxlength="500">
      <p class="hint">Use a USB scanner, the phone/PC camera, or type a code and press Enter. Change Qty before scanning for multiples.
        Shortcuts: <b>F2</b> = check in, <b>F4</b> = check out, or scan a printed MODE-IN / MODE-OUT card.
        With the camera, move away from an item before scanning the same one again.</p>
      <div class="result" id="result"><div class="muted">Ready. Scan an item.</div></div>
    </section>
    <section class="card"><h2>Scans on this device</h2><div id="log"></div></section>
  </div>`;
  const code = $('#code'); const qty = $('#qty'); const note = $('#note'); const result = $('#result');
  // On phones/tablets, don't keep focusing the text box: it would keep popping up the keyboard.
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const focusCode = () => { if (!touch) code.focus(); };

  // ---- camera scanning (GitHub Pages is https, so phones allow the camera)
  let camera = null; let camBusy = false; let lastCode = ''; let lastSeenAt = 0;
  const camBtn = $('#camBtn'); const reader = $('#reader');
  async function startCamera() {
    if (!window.isSecureContext) { show('err', '<div class="big err-t">Camera needs an https address</div>'); return; }
    camBtn.disabled = true; camBtn.textContent = 'Starting camera…';
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js', 'Html5Qrcode');
      reader.hidden = false;
      camera = new window.Html5Qrcode('reader', { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      await camera.start({ facingMode: 'environment' }, {
        fps: 10,
        qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.75); return { width: s, height: Math.floor(s * 0.75) }; },
      }, onCameraCode, () => {});
      camBtn.textContent = '✕ Stop camera';
      show('', '<div class="muted">Camera on. Point it at a barcode or QR code.</div>');
    } catch (err) {
      camera = null; reader.hidden = true; camBtn.textContent = '📷 Scan with camera';
      const raw = String((err && (err.name || '') + ' ' + (err.message || '')) || err);
      const msg = /NotFound|DevicesNotFound|Requested device not found/i.test(raw) ? 'No camera was found on this device.'
        : /NotAllowed|Permission/i.test(raw) ? 'Camera permission was blocked. Allow the camera for this site in the browser settings, then try again.'
        : /NotReadable|in use/i.test(raw) ? 'The camera is being used by another app. Close it and try again.'
        : raw;
      show('err', `<div class="big err-t">Camera didn't start</div><div>${esc(msg)}</div>`);
    } finally { camBtn.disabled = false; }
  }
  async function stopCamera() {
    if (camera) { const c = camera; camera = null; try { await c.stop(); c.clear(); } catch { /* already stopped */ } }
    reader.hidden = true; camBtn.textContent = '📷 Scan with camera';
  }
  async function onCameraCode(text) {
    // The camera reads the same code many times per second. Only accept it again after it
    // has been out of view for 1.5 s, so holding the phone still never double-counts.
    const now = Date.now();
    const repeat = text === lastCode && now - lastSeenAt < 1500;
    if (text === lastCode) lastSeenAt = now;
    if (repeat || camBusy || $('#dialog').open) return;
    lastCode = text; lastSeenAt = now; camBusy = true;
    try { if (navigator.vibrate) navigator.vibrate(60); await handleValue(text.trim()); }
    finally { camBusy = false; lastSeenAt = Date.now(); }
  }
  camBtn.onclick = () => (camera ? stopCamera() : startCamera());

  function setMode(m) {
    mode = m; store('scanMode', m);
    $$('.mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('#scanForm').className = 'scanbox ' + m.toLowerCase();
    code.placeholder = m === 'IN' ? 'Scan to CHECK IN…' : 'Scan to CHECK OUT…';
    focusCode();
  }
  function show(kind, html) { result.className = 'result ' + kind; result.innerHTML = html; }
  function drawLog() {
    $('#log').innerHTML = scanLog.length ? txTable(scanLog.slice(0, 30), { compact: true }) : '<div class="empty">Nothing scanned yet.</div>';
  }
  async function doScan(barcode, n, noteText) {
    show('', '<div class="muted">Saving…</div>');
    try {
      const r = await db.scan(barcode, mode, n, noteText);
      if (r.unknown) {
        beep(false);
        if (mode !== 'IN') {
          show('err', `<div class="big err-t">Not recorded</div><div>${esc(barcode)} is not in the inventory, so it can't be checked out.</div>`);
          return;
        }
        show('err', `<div class="big err-t">New barcode</div><div>${esc(barcode)} isn't registered yet. Fill in the item details.</div>`);
        const created = await formDialog({
          title: 'Register new item', submit: 'Save and check in',
          body: itemFields({ barcode }),
          onSubmit: (d) => db.createItem(d),
        });
        if (created) return doScan(created.barcode, n, noteText);
        show('', '<div class="muted">Cancelled. Ready for the next scan.</div>');
        return;
      }
      const isIn = mode === 'IN';
      show(isIn ? 'in' : 'out', `<div class="big ${isIn ? 'in-t' : 'out-t'}">${isIn ? 'Checked IN' : 'Checked OUT'} ${n > 1 ? '× ' + n : ''}</div>
        <div><b>${esc(r.item.name)}</b> <span class="muted">${esc(r.item.barcode)}${r.item.location ? ' · ' + esc(r.item.location) : ''}</span></div>
        <div>Now in stock: <b>${fmtNum(r.item.quantity)}</b>
        ${r.item.min_quantity > 0 && r.item.quantity <= r.item.min_quantity ? ' <span class="low">· LOW STOCK</span>' : ''}</div>`);
      beep(true);
      scanLog.unshift(r.transaction); drawLog();
      qty.value = 1; note.value = '';
    } catch (err) {
      beep(false);
      show('err', `<div class="big err-t">Not recorded</div><div>${esc(err.message)}</div>`);
    } finally { focusCode(); }
  }

  $$('.mode button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  // Scanners finish with Enter (some can be set to Tab). The form has two inputs and no submit
  // button, so browsers won't submit it on Enter by themselves - handle the key directly.
  code.onkeydown = (e) => {
    if (e.key === 'Enter' || (e.key === 'Tab' && code.value.trim())) { e.preventDefault(); submitScan(); }
  };
  $('#scanForm').onsubmit = (e) => { e.preventDefault(); submitScan(); };
  function submitScan() {
    const value = code.value.trim(); code.value = '';
    if (value) handleValue(value);
  }
  function handleValue(value) {
    const upper = value.toUpperCase();
    if (upper === 'MODE-IN' || upper === 'MODE-OUT') { setMode(upper === 'MODE-IN' ? 'IN' : 'OUT'); beep(true); return Promise.resolve(); }
    const n = Math.max(1, parseInt(qty.value, 10) || 1);
    return doScan(value, n, note.value.trim());
  }
  qty.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); code.focus(); } };
  note.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); code.focus(); } };

  // keep the scan box focused so a USB scanner always types into it
  const onClick = (e) => {
    if ($('#dialog').open) return;
    if (!e.target.closest('input, select, textarea, button, a, #reader')) focusCode();
  };
  const onKey = (e) => {
    if ($('#dialog').open) return;
    if (e.key === 'F2') { e.preventDefault(); setMode('IN'); }
    if (e.key === 'F4') { e.preventDefault(); setMode('OUT'); }
  };
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  cleanup = () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); stopCamera(); };
  setMode(mode); drawLog();
}

// ---- dashboard
async function renderDashboard() {
  app.innerHTML = `<div class="row"><h1>Dashboard</h1><span class="spacer"></span><span class="muted" id="updated"></span></div><div id="dash"></div>`;
  async function load() {
    const s = await db.stats(startOfToday().toISOString());
    if (!$('#dash')) return;
    $('#dash').innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="n">${fmtNum(s.totals.items)}</div><div class="l">Item types</div></div>
        <div class="card stat"><div class="n">${fmtNum(s.totals.units)}</div><div class="l">Units in stock</div></div>
        <div class="card stat"><div class="n" style="color:var(--in)">+${fmtNum(s.today.ins)}</div><div class="l">Checked in today</div></div>
        <div class="card stat"><div class="n" style="color:var(--out)">−${fmtNum(s.today.outs)}</div><div class="l">Checked out today</div></div>
        <div class="card stat"><div class="n ${s.totals.low ? 'low' : ''}">${fmtNum(s.totals.low)}</div><div class="l">Low-stock items</div></div>
      </div>
      ${s.lowStock.length ? `<section class="card" style="margin-bottom:16px"><h2>Low stock</h2><div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Location</th><th class="num">In stock</th><th class="num">Alert at</th></tr></thead><tbody>
        ${s.lowStock.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.location)}</td><td class="num low">${fmtNum(i.quantity)}</td><td class="num">${fmtNum(i.min_quantity)}</td></tr>`).join('')}
        </tbody></table></div></section>` : ''}
      <section><div class="row" style="margin-bottom:10px"><h2 style="margin:0">Latest activity</h2><span class="spacer"></span><a href="#history">Full history →</a></div>
      ${txTable(s.recent)}</section>`;
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { timeStyle: 'short' }) + ' · refreshes every 30 s';
  }
  await load();
  const timer = setInterval(() => load().catch(() => {}), 30000);
  cleanup = () => clearInterval(timer);
}

// ---- items
async function renderItems() {
  app.innerHTML = `<div class="row" style="margin-bottom:12px"><h1 style="margin:0">Items</h1><span class="spacer"></span>
      <button class="btn" id="itemsCsv">Export CSV</button>
      ${can('operator') ? '<button class="btn primary" id="addItem">+ Add item</button>' : ''}</div>
    <div class="filters"><label>Search<input id="search" placeholder="Name, barcode, location…" value="${esc(store('itemSearch') || '')}"></label></div>
    <div id="list"></div>`;
  async function load() {
    const term = $('#search').value.trim(); store('itemSearch', term);
    const items = await db.items(term);
    $('#list').innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Barcode</th><th>Location</th><th class="num">In stock</th><th class="num">Alert at</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr data-id="${i.id}">
        <td><b>${esc(i.name)}</b>${i.description ? `<div class="muted" style="font-size:13px">${esc(i.description)}</div>` : ''}</td>
        <td class="code">${esc(i.barcode)}</td><td>${esc(i.location)}</td>
        <td class="num ${i.min_quantity > 0 && i.quantity <= i.min_quantity ? 'low' : ''}">${fmtNum(i.quantity)}</td>
        <td class="num muted">${i.min_quantity || '–'}</td>
        <td class="actions">
          <a class="btn small" href="#history?item=${i.id}">History</a>
          ${can('operator') ? `<a class="btn small" href="#labels?ids=${i.id}">Label</a><button class="btn small" data-act="edit">Edit</button>` : ''}
          ${can('admin') ? '<button class="btn small" data-act="count">Count</button><button class="btn small danger" data-act="del">Delete</button>' : ''}
        </td></tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty">${term ? 'No items match your search.' : 'No items yet. Scan something on the Scan page, or click “Add item”.'}</div>`;
    $$('#list [data-act]').forEach((btn) => {
      const item = items.find((i) => i.id === Number(btn.closest('tr').dataset.id));
      btn.onclick = () => itemAction(btn.dataset.act, item).then((changed) => changed && load()).catch((err) => toast(err.message));
    });
  }
  async function itemAction(act, item) {
    if (act === 'edit') {
      return formDialog({ title: 'Edit item', body: itemFields(item), onSubmit: (d) => db.updateItem(item.id, d) });
    }
    if (act === 'count') {
      return formDialog({
        title: `Stock count: ${item.name}`, submit: 'Set count',
        body: `<p class="muted">Use this after a physical count. It sets the stock to the number you enter and records a COUNT entry in history.</p>
          <label>Counted quantity<input name="quantity" type="number" min="0" required value="${item.quantity}"></label>
          <label>Note<input name="note" placeholder="Stock count correction"></label>`,
        onSubmit: (d) => db.adjust(item.id, parseInt(d.quantity, 10), d.note || ''),
      });
    }
    if (act === 'del') {
      const ok = await confirmDialog('Delete item?', `Delete “${item.name}”? Its past history records are kept, but the barcode will become unknown.`);
      if (ok) { await db.deleteItem(item.id); toast('Item deleted'); }
      return ok;
    }
  }
  $('#search').oninput = debounce(() => load().catch((err) => toast(err.message)));
  $('#itemsCsv').onclick = async () => {
    try {
      const rows = await fetchAll(() => sb.from('items').select('*').order('name'));
      downloadFile(`inventory-stock-${today()}.csv`, toCsv(rows, ['barcode', 'name', 'location', 'quantity', 'min_quantity', 'description', 'updated_at']), 'text/csv;charset=utf-8');
    } catch (err) { toast(err.message); }
  };
  if ($('#addItem')) $('#addItem').onclick = async () => {
    const r = await formDialog({ title: 'Add item', body: itemFields(), onSubmit: (d) => db.createItem(d) });
    if (r) { toast(`Added ${r.name} (${r.barcode})`); load(); }
  };
  await load();
}

// ---- history
async function renderHistory() {
  const itemId = hashParams().get('item');
  const item = itemId ? await db.item(Number(itemId)).catch(() => null) : null;
  let offset = 0; const limit = 50;
  app.innerHTML = `<div class="row" style="margin-bottom:12px"><h1 style="margin:0">History</h1><span class="spacer"></span><button class="btn" id="csv">Export CSV</button></div>
    ${itemId ? `<p>Showing item: <b>${esc(item ? item.name : '#' + itemId)}</b> ${item ? `(in stock: ${fmtNum(item.quantity)})` : ''} · <a href="#history">show all items</a></p>` : ''}
    <div class="filters">
      <label>Search<input id="fq" placeholder="Item, barcode, person, note…"></label>
      <label>Type<select id="fdir"><option value="">All</option><option value="IN">Check in</option><option value="OUT">Check out</option><option value="ADJUST">Stock count</option></select></label>
      <label>From<input id="ffrom" type="date"></label>
      <label>To<input id="fto" type="date"></label>
    </div>
    <div id="rows"></div>
    <div class="pager"><span class="muted" id="pinfo"></span><button class="btn" id="prev">← Newer</button><button class="btn" id="next">Older →</button></div>`;
  const filters = () => ({
    q: $('#fq').value.trim(), direction: $('#fdir').value,
    from: localDayBounds($('#ffrom').value, false), to: localDayBounds($('#fto').value, true),
    itemId: itemId ? Number(itemId) : null,
  });
  async function load() {
    const { data: rows, count: total } = await mustCount(db.txQuery(filters(), { count: 'exact' }).range(offset, offset + limit - 1));
    $('#rows').innerHTML = txTable(rows, { showItem: !itemId });
    $('#pinfo').textContent = total ? `${offset + 1}–${offset + rows.length} of ${fmtNum(total)}` : '';
    $('#prev').disabled = offset === 0;
    $('#next').disabled = offset + rows.length >= total;
  }
  const reload = () => { offset = 0; load().catch((err) => toast(err.message)); };
  $('#fq').oninput = debounce(reload);
  ['#fdir', '#ffrom', '#fto'].forEach((s) => ($(s).onchange = reload));
  $('#prev').onclick = () => { offset = Math.max(0, offset - limit); load(); };
  $('#next').onclick = () => { offset += limit; load(); };
  $('#csv').onclick = async () => {
    const btn = $('#csv'); btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const f = filters();
      const rows = await fetchAll(() => db.txQuery(f));
      downloadFile(`inventory-history-${today()}.csv`,
        toCsv(rows, ['id', 'created_at', 'direction', 'qty', 'balance_after', 'barcode', 'item_name', 'username', 'note']), 'text/csv;charset=utf-8');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Export CSV'; }
  };
  await load();
}

// ---- QR labels
async function loadQrLib() {
  try { await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js', 'qrcode'); }
  catch { throw new Error('Could not load the QR code generator. Labels need an internet connection.'); }
  window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
}
function qrImg(text) {
  const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createDataURL(6, 2);
}
async function renderLabels() {
  const preselect = new Set((hashParams().get('ids') || '').split(',').filter(Boolean).map(Number));
  const items = await db.items('');
  app.innerHTML = `<div class="no-print">
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Print QR labels</h1><span class="spacer"></span>
      <button class="btn" id="all">Select all</button><button class="btn" id="none">Clear</button>
      <button class="btn primary" id="print">Print</button></div>
    <p class="muted">Tick the items, set how many labels each needs, then Print. Stick a label on each item or shelf bin. Tip: in the print dialog turn off “Headers and footers”.</p>
    <label class="row" style="display:flex;color:var(--text);font-size:15px;margin-bottom:10px"><input type="checkbox" id="modeCards"> Include MODE-IN / MODE-OUT cards (scan these to switch the station's mode)</label>
    ${items.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>Barcode</th><th>Location</th><th class="num">Copies</th></tr></thead><tbody>
      ${items.map((i) => `<tr><td><input type="checkbox" class="pick" data-id="${i.id}" ${preselect.has(i.id) ? 'checked' : ''}></td>
        <td>${esc(i.name)}</td><td class="code">${esc(i.barcode)}</td><td>${esc(i.location)}</td>
        <td class="num"><input type="number" class="copies" data-id="${i.id}" min="1" max="200" value="1" style="width:72px"></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card empty">No items yet. Add items first.</div>'}
  </div>
  <div class="label-sheet" id="sheet"></div>`;
  async function draw() {
    const sheet = $('#sheet'); if (!sheet) return;
    const picks = $$('.pick:checked').map((c) => items.find((i) => i.id === Number(c.dataset.id)));
    if (!picks.length && !$('#modeCards').checked) { sheet.innerHTML = ''; return; }
    try { await loadQrLib(); } catch (err) { sheet.innerHTML = `<div class="err-msg">${esc(err.message)}</div>`; return; }
    let html = '';
    if ($('#modeCards').checked) {
      html += `<div class="label mode-in"><img src="${qrImg('MODE-IN')}" alt=""><div class="ln">SWITCH TO CHECK IN</div><div class="lc">MODE-IN</div></div>`;
      html += `<div class="label mode-out"><img src="${qrImg('MODE-OUT')}" alt=""><div class="ln">SWITCH TO CHECK OUT</div><div class="lc">MODE-OUT</div></div>`;
    }
    for (const it of picks) {
      const n = Math.min(200, Math.max(1, parseInt($(`.copies[data-id="${it.id}"]`).value, 10) || 1));
      const one = `<div class="label"><img src="${qrImg(it.barcode)}" alt=""><div class="ln">${esc(it.name)}</div><div class="lc">${esc(it.barcode)}</div>${it.location ? `<div class="lc">${esc(it.location)}</div>` : ''}</div>`;
      html += one.repeat(n);
    }
    sheet.innerHTML = html;
  }
  const drawSoon = debounce(draw, 300);
  app.addEventListener('change', draw);
  app.addEventListener('input', drawSoon);
  cleanup = () => { app.removeEventListener('change', draw); app.removeEventListener('input', drawSoon); };
  $('#all').onclick = () => { $$('.pick').forEach((c) => (c.checked = true)); draw(); };
  $('#none').onclick = () => { $$('.pick').forEach((c) => (c.checked = false)); draw(); };
  $('#print').onclick = async () => { await draw(); window.print(); };
  await draw();
}

// ---- users (admin)
async function renderUsers() {
  app.innerHTML = `<h1>Users</h1>
    <div class="card" style="margin-bottom:16px"><b>Adding someone</b>
      <p style="margin:6px 0">Send them this site's address. They click <b>Create an account</b>, then appear below as
      <b>pending</b>. Pick their role and they're in.</p>
      <ul style="margin:6px 0 0;padding-left:20px">
        <li><b>viewer</b>: can see the dashboard, items and history (for the responsible party). Can't change anything.</li>
        <li><b>operator</b>: can also scan items in and out, add or edit items, and print labels.</li>
        <li><b>admin</b>: everything, including stock counts, deleting items, managing users and backups.</li>
        <li><b>disabled</b>: removes their access (their past scans stay in history).</li>
      </ul></div>
    <div id="ulist"></div>
    <section class="card" style="margin-top:16px"><h2>Backup</h2>
      <p class="muted" style="margin-top:0">Download a copy of everything (items, history, users). Do this regularly and keep the file safe.</p>
      <button class="btn" id="backup">Download backup</button></section>`;
  async function load() {
    const users = await db.users();
    const pending = users.filter((u) => u.role === 'pending').length;
    $('#ulist').innerHTML = `${pending ? `<p class="low">${pending} account${pending > 1 ? 's are' : ' is'} waiting for a role.</p>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>
      ${users.map((u) => `<tr data-id="${u.id}"><td><b>${esc(u.email)}</b>${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
        <td><select data-act="role" ${u.id === me.id ? 'disabled' : ''}>${['pending', 'viewer', 'operator', 'admin', 'disabled']
          .filter((r) => r !== 'pending' || u.role === 'pending')
          .map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="muted">${esc(fmtTime(u.created_at))}</td></tr>`).join('')}
      </tbody></table></div>`;
    $$('#ulist [data-act=role]').forEach((el) => {
      const u = users.find((x) => x.id === el.closest('tr').dataset.id);
      el.onchange = async () => {
        try { await db.setRole(u.id, el.value); toast(`${u.email} is now ${el.value}`); load(); }
        catch (err) { toast(err.message); load(); }
      };
    });
  }
  $('#backup').onclick = async () => {
    const btn = $('#backup'); btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const [items, transactions, profiles] = await Promise.all([
        fetchAll(() => sb.from('items').select('*').order('id')),
        fetchAll(() => sb.from('transactions').select('*').order('id')),
        fetchAll(() => sb.from('profiles').select('*').order('created_at')),
      ]);
      downloadFile(`inventory-backup-${today()}.json`,
        JSON.stringify({ exported_at: new Date().toISOString(), items, transactions, profiles }, null, 1), 'application/json');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Download backup'; }
  };
  await load();
}

// ---- my account
function renderAccount() {
  app.innerHTML = `<div class="card auth" style="margin-top:0"><h1>My account</h1>
    <p class="muted">Signed in as <b>${esc(me.email)}</b> (${esc(me.role)}).</p>
    <form id="pwForm">
      <label>New password (8+ characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>Type it again<input name="again" type="password" minlength="8" required autocomplete="new-password"></label>
      <div class="err-msg" id="pwErr"></div>
      <button class="btn primary">Change password</button></form></div>`;
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (d.password !== d.again) { $('#pwErr').textContent = "The two passwords don't match"; return; }
    try { await must(sb.auth.updateUser({ password: d.password })); e.target.reset(); $('#pwErr').textContent = ''; toast('Password changed'); }
    catch (err) { $('#pwErr').textContent = err.message; }
  };
}

// ------------------------------------------------------------ start
(async function start() {
  if (sb) {
    sb.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        // Arrived from a "reset password" email link: ask for the new password.
        setTimeout(() => formDialog({
          title: 'Set a new password', submit: 'Save password',
          body: '<label>New password (8+ characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>',
          onSubmit: (d) => must(sb.auth.updateUser({ password: d.password })),
        }).then(async (ok) => { if (ok) { toast('Password changed'); me = await db.loadMe(); route(); } }), 0);
      }
      if (event === 'SIGNED_OUT' && me) { me = null; route(); }
    });
    try { me = await db.loadMe(); } catch (err) { me = null; console.error(err); }
  }
  route();
})();
