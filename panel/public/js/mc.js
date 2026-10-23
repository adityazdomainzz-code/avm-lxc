/* AVM Panel - Minecraft server hosting pages (Paper, Purpur, Spigot, Vanilla, Forge, Fabric).
   Loaded before app.js; only declares functions - it uses the helpers from app.js at run time. */
'use strict';

const MC_SOFT = {
  paper: { label: 'Paper', short: 'PA', c: '#e8473f', kind: 'plugins', desc: 'Fast, most plugins work' },
  purpur: { label: 'Purpur', short: 'PU', c: '#9b5de5', kind: 'plugins', desc: 'Paper + extra settings' },
  spigot: { label: 'Spigot', short: 'SP', c: '#f29f05', kind: 'plugins', desc: 'Classic plugins · built on 1st start' },
  vanilla: { label: 'Vanilla', short: 'VA', c: '#5b8c32', kind: 'none', desc: 'Official Mojang server' },
  forge: { label: 'Forge', short: 'FO', c: '#3b4a6b', kind: 'mods', desc: 'Forge mods' },
  fabric: { label: 'Fabric', short: 'FA', c: '#c6a26a', kind: 'mods', desc: 'Lightweight Fabric mods' },
};
const mcSoft = (x) => MC_SOFT[x.software] || MC_SOFT.paper;
const mcKind = (x) => mcSoft(x).kind; // plugins | mods | none
function mcIcon(x) { const s = mcSoft(x); return `<div class="os-icon" style="background:linear-gradient(140deg,#fff,${s.c}26);color:${s.c};font-size:12px">${s.short}</div>`; }
function mcBadge(st, suspended) {
  if (suspended || (st && st.state === 'suspended')) return '<span class="badge bad"><i class="pulse"></i>suspended</span>';
  if (!st) return '<span class="badge off">…</span>';
  const m = { running: ['ok', 'online'], installing: ['warn', 'installing'], restarting: ['warn', 'restarting'], stopped: ['off', 'offline'], error: ['bad', 'error'] }[st.state] || ['off', st.state];
  return `<span class="badge ${m[0]}"><i class="pulse"></i>${esc(m[1])}</span>`;
}
const mcVersionsCache = {};
async function mcVersions(software) {
  if (!mcVersionsCache[software]) mcVersionsCache[software] = api('GET', `/api/mc-versions?software=${software}`).catch((e) => { delete mcVersionsCache[software]; throw e; });
  return mcVersionsCache[software];
}
const fmtNext = (t) => { if (!t) return '-'; const s = Math.round((t - Date.now()) / 1000); if (s < 60) return 'in <1 min'; const m = Math.round(s / 60); return m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : new Date(t).toLocaleString(); };

// ---------- my servers ----------
async function pageMcs() {
  const list = await api('GET', '/api/mc');
  $('#content').innerHTML = head('My Minecraft servers', `${list.length} server${list.length === 1 ? '' : 's'}`, state.me.admin ? `<a class="btn" href="#/admin/createmc">${icon('plus')}Create server</a>` : '') +
    (list.length ? `<div class="grid g3">${list.map((x) => `
      <a class="card vm-card" href="#/mc/${x.id}/console">
        <div class="top"><div style="display:flex;gap:12px;align-items:center;min-width:0">${mcIcon(x)}<div style="min-width:0"><h3 class="trunc">${esc(x.name)}</h3><span class="muted mono">${esc(x.address)}</span></div></div><span data-mst="${x.id}">${mcBadge(null, x.suspended)}</span></div>
        <div class="meta"><span><b>${esc(mcSoft(x).label)}</b> ${esc(x.version)}</span><span><b>${x.cpu}</b> vCPU</span><span><b>${fmtBytes(x.memory * 1048576)}</b> RAM</span><span><b>${x.disk} GB</b> disk</span></div>
      </a>`).join('')}</div>`
      : `<div class="card empty-state">${icon('cube')}<h3>No Minecraft servers yet</h3><p>${state.me.admin ? 'Create your first server from the admin area.' : 'An admin will create a server for you.'}</p>${state.me.admin ? `<a class="btn" href="#/admin/createmc">${icon('plus')}Create server</a>` : ''}</div>`);
  list.filter((x) => !x.suspended).forEach(async (x) => {
    const el = () => $(`[data-mst="${x.id}"]`);
    try { const st = await api('GET', `/api/mc/${x.id}/status`); if (el()) el().innerHTML = mcBadge(st); } catch { if (el()) el().innerHTML = '<span class="badge bad">node offline</span>'; }
  });
}

// ---------- single server ----------
async function pageMc(id, tab) {
  const x = await api('GET', `/api/mc/${id}`);
  state.mcCache[id] = x;
  renderSidebar();
  const c = $('#content');
  const locked = x.suspended && !state.me.admin;
  c.innerHTML = `
    <div class="vm-bar"><div class="title">${mcIcon(x)}<div style="min-width:0"><h1>${esc(x.name)}</h1><div class="sub"><span id="mc-soft">${esc(mcSoft(x).label)} ${esc(x.version)}</span> · <a href="#" id="mc-addr" class="mono mc-addr" title="Copy address">${esc(x.address)} ${icon('copy')}</a></div></div><span id="mc-state">${mcBadge(null, x.suspended)}</span></div>
      <div class="btn-row">
        <button class="btn ok" data-p="start" ${locked ? 'disabled' : ''}>${icon('play')}Start</button>
        <button class="btn deep" data-p="restart" ${locked ? 'disabled' : ''}>${icon('refresh')}Restart</button>
        <button class="btn stop" data-p="stop" ${locked ? 'disabled' : ''}>${icon('stop')}Stop</button>
        <button class="btn ghost" data-p="kill" title="Force stop (worlds are not saved)" ${locked ? 'disabled' : ''}>${icon('zap')}Kill</button>
      </div></div>
    ${x.suspended ? `<div class="alert bad"><b>This server is suspended.</b> ${state.me.admin ? 'Unsuspend it in Admin → Minecraft servers.' : 'Please contact an administrator.'}</div>` : ''}
    <div id="mc-err"></div>
    <div id="tab"></div>`;
  $('#mc-addr').onclick = (e) => { e.preventDefault(); copy(x.address); };
  const ss = { st: null, listeners: [] };
  const poll = async () => {
    try {
      const st = await api('GET', `/api/mc/${id}/status`);
      const changed = !ss.st || ss.st.state !== st.state;
      ss.st = st;
      const el = $('#mc-state');
      if (el) el.innerHTML = mcBadge(st, x.suspended) + (st.busy && st.step ? ` <span class="muted" style="font-size:12px">${esc(st.step)}…</span>` : '') + (st.error && !st.busy && st.state !== 'error' ? ` <span class="badge bad" title="${esc(st.error)}">error</span>` : '') + (st.state === 'stopped' && st.exitCode ? ` <span class="badge warn" title="exit code">exit ${st.exitCode}</span>` : '');
      const er = $('#mc-err');
      if (er) er.innerHTML = st.error && !st.busy ? `<div class="alert bad"><b>Last action failed:</b> ${esc(st.error)}</div>` : '';
      ss.listeners.forEach((fn) => fn(st, changed));
    } catch { const el = $('#mc-state'); if (el) el.innerHTML = '<span class="badge bad">node offline</span>'; }
  };
  const iv = setInterval(poll, 3000);
  state.cleanup.push(() => clearInterval(iv));
  $$('[data-p]', c).forEach((b) => (b.onclick = () => {
    const a = b.dataset.p;
    if (a === 'stop' || a === 'restart') { const el = $('#mc-state'); if (el) el.innerHTML = mcBadge({ state: 'restarting' }) + ' <span class="muted" style="font-size:12px">saving worlds…</span>'; }
    if (a === 'start') { const el = $('#mc-state'); if (el) el.innerHTML = mcBadge({ state: 'installing' }) + ' <span class="muted" style="font-size:12px">starting… (first start downloads Java)</span>'; }
    act(b, () => api('POST', `/api/mc/${id}/power`, { action: a }), { start: 'Server started', restart: 'Server restarted', stop: 'Server stopped', kill: 'Server killed' }[a]).then(() => setTimeout(poll, 500)).catch(() => {});
  }));
  const t = $('#tab');
  await poll();
  const ctx = { onStatus: (fn) => ss.listeners.push(fn), get st() { return ss.st; }, poll, reload: () => pageMc(id, tab) };
  const fn = { console: mcConsole, plugins: mcPlugins, players: mcPlayers, schedules: mcSchedules, files: mcFiles, software: mcSoftware, version: mcVersion }[tab] || mcConsole;
  await fn(x, t, ctx);
}

// ---------- console ----------
async function mcConsole(x, t, ctx) {
  let term = null, ws = null, ro = null, fit = null;
  t.innerHTML = `<div class="grid g4" style="margin-bottom:14px">
      <div class="card stat"><div class="k">CPU</div><div class="v" id="u-cpu">0%</div><div class="s">${x.cpu} vCPU</div></div>
      <div class="card stat"><div class="k">Memory</div><div class="v" id="u-mem">0 B</div><div class="s" id="u-mem-s">of ${fmtBytes(x.memory * 1048576)}</div></div>
      <div class="card stat"><div class="k">Disk</div><div class="v" id="u-disk">-</div><div class="s">of ${x.disk} GB</div><div class="bar"><i id="u-disk-b" style="width:0"></i></div></div>
      <div class="card stat"><div class="k">Uptime</div><div class="v" id="u-up">-</div><div class="s" id="u-java">Java -</div></div></div>
    <div class="term-wrap"><div class="term-head"><div class="lights"><i></i><i></i><i></i></div><span>${esc(x.name)} · console</span><span id="t-status"></span></div><div id="term"></div></div>
    <form id="mc-cmd" class="bot-cmd"><input class="input mono" name="cmd" placeholder="Type a server command (e.g. say hello, op Steve, time set day) and press Enter" autocomplete="off"><button class="btn">Send</button></form>
    <p class="muted" style="font-size:12.5px;margin:8px 2px 0">Join with <b class="mono">${esc(x.address)}</b>. Commands are typed without "/". Stop saves the worlds first.</p>`;
  const upd = (st) => {
    if (!st || !$('#u-cpu')) return;
    const run = st.state === 'running';
    $('#u-cpu').textContent = (run ? st.cpu : 0) + '%';
    $('#u-mem').textContent = fmtBytes(run ? st.memory : 0);
    $('#u-mem-s').textContent = `of ${fmtBytes(st.memLimit)} · ${pct(run ? st.memory : 0, st.memLimit).toFixed(0)}%`;
    $('#u-disk').textContent = fmtBytes(st.disk);
    const dp = pct(st.disk, st.diskLimit); $('#u-disk-b').style.width = dp + '%'; $('#u-disk-b').parentElement.classList.toggle('hot', dp > 85);
    $('#u-up').textContent = run ? fmtUptime(st.uptime) : '-';
    $('#u-java').textContent = `Java ${st.java} · max heap ${fmtBytes(st.xmx * 1048576)}`;
  };
  upd(ctx.st); ctx.onStatus((st) => upd(st));
  const teardown = () => { try { ws && ws.close(); } catch {} try { ro && ro.disconnect(); } catch {} try { term && term.dispose(); } catch {} ws = term = ro = null; };
  state.cleanup.push(teardown);
  try { await loadXterm(); } catch (e) { $('#term').innerHTML = `<p style="color:#fff;padding:20px">${esc(e.message)}</p>`; return; }
  term = new window.Terminal({ cursorBlink: false, convertEol: false, fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, scrollback: 8000, disableStdin: true,
    theme: { background: '#062530', foreground: '#dff6fb', cursor: '#7fe0f2', selectionBackground: '#1b6a80', blue: '#4fb6e8', cyan: '#5ee0f0', green: '#5fe0a8', magenta: '#b794f6', red: '#ff7a85', yellow: '#ffd479', brightBlack: '#4b7584' } });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit); term.open($('#term')); fit.fit();
  const status = (html) => { const s = $('#t-status'); if (s) s.innerHTML = html; };
  const connect = () => {
    if (!term) return;
    try { ws && ws.close(); } catch {}
    term.reset();
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/mc/${x.id}/console`);
    ws.onopen = () => status('<span class="badge ok" style="font-size:11px"><i class="pulse"></i>live</span>');
    ws.onmessage = (e) => term && term.write(e.data);
    ws.onclose = () => status('<span class="badge off" style="font-size:11px">offline</span>');
  };
  const hist = []; let hi = 0;
  const inp = $('#mc-cmd').cmd;
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && hi > 0) { hi--; inp.value = hist[hi]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] || ''; e.preventDefault(); }
  });
  $('#mc-cmd').onsubmit = (e) => {
    e.preventDefault();
    const v = inp.value.trim().replace(/^\//, '');
    if (!v) return;
    if (ws && ws.readyState === 1 && ctx.st && ctx.st.state === 'running') { ws.send(JSON.stringify({ type: 'input', data: v + '\r' })); hist.push(v); hi = hist.length; inp.value = ''; }
    else toast('The server is not running');
  };
  ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  ro.observe($('#term'));
  connect();
  ctx.onStatus((st, changed) => { if (changed && (st.state === 'running' || st.state === 'stopped')) setTimeout(connect, st.state === 'running' ? 400 : 1200); });
}

// ---------- plugins / mods ----------
async function mcPlugins(x, t, ctx) {
  const kind = mcKind(x), word = kind === 'mods' ? 'mod' : 'plugin', Word = kind === 'mods' ? 'Mods' : 'Plugins';
  if (kind === 'none') {
    t.innerHTML = `<div class="card empty-state">${icon('puzzle')}<h3>Vanilla has no plugins or mods</h3><p>Switch the server to <b>Paper</b> or <b>Purpur</b> for plugins, or <b>Fabric</b> / <b>Forge</b> for mods. Your worlds are kept.</p><a class="btn" href="#/mc/${x.id}/software">${icon('layers')}Software changer</a></div>`;
    return;
  }
  const locked = x.suspended && !state.me.admin, dis = locked ? 'disabled' : '';
  t.innerHTML = `<div class="grid g2" style="align-items:start">
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><h3>Installed ${Word.toLowerCase()}</h3><p class="sub" style="margin:0">Folder <span class="mono">/${kind}</span> · restart the server after changes.</p></div>
      <label class="btn sm ghost">${icon('upload')}Upload .jar<input type="file" accept=".jar" multiple hidden id="pl-up" ${dis}></label></div>
      <div class="list" id="pl-list" style="margin-top:14px"><div class="muted">Loading…</div></div></div>
    <div class="card"><h3>Find ${Word.toLowerCase()}</h3><p class="sub">From <a href="https://modrinth.com" target="_blank" rel="noopener">Modrinth</a> · only ${word}s for <b>${esc(mcSoft(x).label)} ${esc(x.version)}</b> are shown. Required dependencies are installed too.</p>
      <form id="pl-search" style="display:flex;gap:8px;margin-bottom:12px"><input class="input" name="q" placeholder="Search ${word}s, e.g. ${kind === 'mods' ? 'sodium, journeymap' : 'essentials, luckperms, worldedit'}" autocomplete="off"><button class="btn">${icon('search')}Search</button></form>
      <div class="list" id="pl-results"><div class="muted">Loading popular ${word}s…</div></div></div></div>`;
  const loadInstalled = async () => {
    const el = $('#pl-list'); if (!el) return;
    let r; try { r = await api('GET', `/api/mc/${x.id}/plugins`); } catch (e) { el.innerHTML = `<div class="alert warn" style="margin:0">${esc(e.message)}</div>`; return; }
    el.innerHTML = r.list.length ? r.list.map((p) => `<div class="item" data-f="${esc(p.file)}"><div class="os-icon" style="width:38px;height:38px;${p.enabled ? '' : 'opacity:.45'}">${icon('puzzle')}</div>
        <div class="info"><b class="trunc">${esc(p.name)}</b><p>${fmtBytes(p.size)} · ${p.enabled ? '<span style="color:var(--ok)">enabled</span>' : 'disabled'}</p></div>
        <div class="btn-row"><button class="btn sm ghost" data-tg ${dis}>${p.enabled ? 'Disable' : 'Enable'}</button><button class="icon-btn" data-del title="Delete" style="color:var(--bad)" ${dis}>${icon('trash')}</button></div></div>`).join('')
      : `<div class="muted">No ${word}s yet - search on the right or upload a .jar.</div>`;
    $$('[data-f]', el).forEach((row) => {
      const f = row.dataset.f;
      $('[data-tg]', row).onclick = (e) => act(e.target, () => api('POST', `/api/mc/${x.id}/plugins/toggle`, { file: f }), 'Saved - restart to apply').then(loadInstalled).catch(() => {});
      $('[data-del]', row).onclick = async () => { if (await confirmBox(`Delete ${f}?`, `The ${word} file is removed. Its config folder stays.`)) act(null, () => api('POST', `/api/mc/${x.id}/plugins/delete`, { file: f }), 'Deleted - restart to apply').then(loadInstalled).catch(() => {}); };
    });
  };
  const search = async (q) => {
    const el = $('#pl-results'); if (!el) return;
    el.innerHTML = '<div class="muted">Searching…</div>';
    let r; try { r = await api('GET', `/api/mc/${x.id}/plugins/search?q=${encodeURIComponent(q || '')}`); } catch (e) { el.innerHTML = `<div class="alert warn" style="margin:0">${esc(e.message)}</div>`; return; }
    el.innerHTML = r.hits.length ? r.hits.map((h) => `<div class="item"><div class="os-icon" style="width:38px;height:38px;overflow:hidden">${h.icon ? `<img src="${esc(h.icon)}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy">` : icon('puzzle')}</div>
        <div class="info"><b class="trunc">${esc(h.title)}</b><p class="trunc" title="${esc(h.description)}">${esc(h.description)}</p><p class="muted" style="font-size:12px">${h.downloads.toLocaleString()} downloads · by ${esc(h.author)}</p></div>
        <button class="btn sm" data-inst="${esc(h.id)}" ${dis}>${icon('download')}Install</button></div>`).join('')
      : `<div class="muted">Nothing found for ${esc(mcSoft(x).label)} ${esc(x.version)}.</div>`;
    $$('[data-inst]', el).forEach((b) => (b.onclick = () => act(b, () => api('POST', `/api/mc/${x.id}/plugins/install`, { project: b.dataset.inst }), null).then((res) => { toast(`Installed ${res.installed.join(', ')} - restart the server to load it`, true); loadInstalled(); }).catch(() => {})));
  };
  $('#pl-search').onsubmit = (e) => { e.preventDefault(); search(e.target.q.value.trim()); };
  $('#pl-up').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    const fd = new FormData(); files.forEach((f) => fd.append('files', f));
    await act(null, () => api('POST', `/api/mc/${x.id}/files/upload?path=${encodeURIComponent('/' + kind)}`, fd), 'Uploaded - restart to load').catch(() => {});
    loadInstalled();
  };
  loadInstalled(); search('');
}

// ---------- players ----------
async function mcPlayers(x, t, ctx) {
  const locked = x.suspended && !state.me.admin, dis = locked ? 'disabled' : '';
  t.innerHTML = `<div class="muted">Loading players…</div>`;
  let p;
  const run = (action, extra, okMsg) => act(null, () => api('POST', `/api/mc/${x.id}/players`, { action, ...extra }), okMsg).then(() => setTimeout(load, 900)).catch(() => {});
  const row = (name, sub, btns) => `<div class="item"><div class="os-icon" style="width:38px;height:38px;overflow:hidden"><img src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/38" alt="" style="width:100%;height:100%" loading="lazy" onerror="this.remove()"></div>
    <div class="info"><b>${esc(name)}</b>${sub ? `<p>${sub}</p>` : ''}</div><div class="btn-row">${btns}</div></div>`;
  const load = async () => {
    try { p = await api('GET', `/api/mc/${x.id}/players`); } catch (e) { t.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
    if (!$('#tab') || location.hash.indexOf('/players') < 0) return;
    const opNames = new Set(p.ops.map((o) => o.name.toLowerCase()));
    t.innerHTML = `<div class="grid g2" style="align-items:start">
      <div><div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h3>Online ${p.online ? `<span class="badge ok">${p.online.length} / ${p.max}</span>` : ''}</h3><button class="btn sm ghost" id="pl-ref">${icon('refresh')}Refresh</button></div>
        <div class="list" style="margin-top:10px">${p.online === null ? '<div class="muted">Start the server to see who is online.</div>' : p.online.length ? p.online.map((n) => row(n, opNames.has(n.toLowerCase()) ? '⭐ operator' : '',
          `<button class="btn sm ghost" data-a="kick" data-n="${esc(n)}" ${dis}>Kick</button><button class="btn sm ghost" data-a="${opNames.has(n.toLowerCase()) ? 'deop' : 'op'}" data-n="${esc(n)}" ${dis}>${opNames.has(n.toLowerCase()) ? 'De-op' : 'Op'}</button><button class="btn sm stop" data-a="ban" data-n="${esc(n)}" ${dis}>Ban</button>`)).join('') : '<div class="muted">Nobody is online.</div>'}</div></div>
      <div class="card"><h3>Manage a player</h3><p class="sub">Works when the server is offline too (then the lists are edited directly).</p>
        <form id="pl-form"><div class="grid g2" style="gap:12px"><label class="f"><span>Player name</span><input class="input mono" name="player" maxlength="16" placeholder="Steve" required ${dis}></label>
          <label class="f"><span>Action</span><select class="input" name="action" ${dis}><option value="op">Make operator (op)</option><option value="deop">Remove operator</option><option value="whitelist-add">Add to whitelist</option><option value="whitelist-remove">Remove from whitelist</option><option value="ban">Ban</option><option value="pardon">Unban</option><option value="kick">Kick</option></select></label></div>
          <label class="f"><span>Reason (ban / kick, optional)</span><input class="input" name="reason" maxlength="100" ${dis}></label>
          <button class="btn" ${dis}>${icon('user')}Apply</button></form></div>
      <div class="card"><h3>Recent players</h3><div class="list">${p.recent.length ? p.recent.slice(0, 15).map((u) => row(u.name, '', `<button class="btn sm ghost" data-a="${opNames.has(u.name.toLowerCase()) ? 'deop' : 'op'}" data-n="${esc(u.name)}" ${dis}>${opNames.has(u.name.toLowerCase()) ? 'De-op' : 'Op'}</button>`)).join('') : '<div class="muted">Nobody has joined yet.</div>'}</div></div></div>
      <div><div class="card"><h3>Operators</h3><div class="list">${p.ops.length ? p.ops.map((o) => row(o.name, `level ${o.level || 4}`, `<button class="btn sm ghost" data-a="deop" data-n="${esc(o.name)}" ${dis}>Remove</button>`)).join('') : '<div class="muted">No operators.</div>'}</div></div>
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h3>Whitelist</h3><label class="check" style="margin:0"><input type="checkbox" id="wl-on" ${p.whitelistOn ? 'checked' : ''} ${dis}> Only whitelisted players can join</label></div>
        <div class="list" style="margin-top:10px">${p.whitelist.length ? p.whitelist.map((o) => row(o.name, '', `<button class="btn sm ghost" data-a="whitelist-remove" data-n="${esc(o.name)}" ${dis}>Remove</button>`)).join('') : '<div class="muted">Whitelist is empty.</div>'}</div></div>
      <div class="card"><h3>Banned players</h3><div class="list">${p.banned.length ? p.banned.map((o) => row(o.name, esc(o.reason || ''), `<button class="btn sm ghost" data-a="pardon" data-n="${esc(o.name)}" ${dis}>Unban</button>`)).join('') : '<div class="muted">Nobody is banned.</div>'}</div></div>
      <div class="card"><h3>Banned IPs</h3>
        <form id="ip-form" style="display:flex;gap:8px;margin-bottom:10px"><input class="input mono" name="ip" placeholder="1.2.3.4" required ${dis}><button class="btn sm stop" ${dis}>Ban IP</button></form>
        <div class="list">${p.bannedIps.length ? p.bannedIps.map((o) => `<div class="item"><div class="info"><b class="mono">${esc(o.ip)}</b><p>${esc(o.reason || '')}</p></div><button class="btn sm ghost" data-ip="${esc(o.ip)}" ${dis}>Unban</button></div>`).join('') : '<div class="muted">No banned IPs.</div>'}</div></div>
      ${p.onlineMode ? '' : '<div class="alert warn">online-mode=false: anyone can join with any name (cracked). Use the whitelist or an auth plugin.</div>'}</div></div>`;
    $('#pl-ref').onclick = load;
    $$('[data-a]', t).forEach((b) => (b.onclick = async () => {
      const a = b.dataset.a, n = b.dataset.n;
      if (a === 'ban' && !(await confirmBox(`Ban ${n}?`, 'They are kicked and cannot join again until unbanned.', 'Ban'))) return;
      run(a, { player: n }, { kick: `Kicked ${n}`, op: `${n} is now an operator`, deop: `${n} is no longer an operator`, ban: `Banned ${n}`, pardon: `Unbanned ${n}`, 'whitelist-remove': `Removed ${n} from the whitelist` }[a]);
    }));
    $$('[data-ip]', t).forEach((b) => (b.onclick = () => run('pardon-ip', { ip: b.dataset.ip }, 'IP unbanned')));
    $('#pl-form').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); run(f.action, { player: f.player.trim(), reason: f.reason }, 'Done'); };
    $('#ip-form').onsubmit = (e) => { e.preventDefault(); run('ban-ip', { ip: e.target.ip.value.trim() }, 'IP banned'); };
    $('#wl-on').onchange = (e) => run(e.target.checked ? 'whitelist-on' : 'whitelist-off', {}, e.target.checked ? 'Whitelist on' : 'Whitelist off');
  };
  await load();
}

// ---------- schedules ----------
const MC_PRESETS = [
  ['*/30 * * * *', 'Every 30 minutes'], ['0 * * * *', 'Every hour'], ['0 */3 * * *', 'Every 3 hours'], ['0 */6 * * *', 'Every 6 hours'], ['0 */12 * * *', 'Every 12 hours'],
  ['0 4 * * *', 'Every day at 04:00'], ['0 0 * * *', 'Every day at midnight'], ['0 4 * * 1', 'Every Monday at 04:00'], ['custom', 'Custom (cron)…'],
];
const MC_ACTIONS = { restart: 'Restart server', say: 'Announce message (say)', command: 'Run console command', start: 'Start server', stop: 'Stop server' };
const cronLabel = (c) => (MC_PRESETS.find((p) => p[0] === c) || [0, `cron ${c}`])[1];
async function mcSchedules(x, t, ctx) {
  const locked = x.suspended && !state.me.admin, dis = locked ? 'disabled' : '';
  const render = (srv) => {
    const list = srv.schedules || [];
    t.innerHTML = `<div class="grid g2" style="align-items:start">
      <div class="card"><h3>Schedules</h3><p class="sub">Automatic tasks. Times use the panel server's clock (now ${new Date().toTimeString().slice(0, 5)} in your browser).</p>
        <div class="list">${list.length ? list.map((s) => `<div class="item" data-s="${s.id}"><div class="os-icon" style="width:38px;height:38px;${s.enabled ? '' : 'opacity:.45'}">${icon('clock')}</div>
          <div class="info"><b>${esc(s.name)}</b><p>${esc(cronLabel(s.cron))} · ${esc(MC_ACTIONS[s.action])}${s.payload ? `: <span class="mono">${esc(s.payload)}</span>` : ''}</p>
            <p class="muted" style="font-size:12px">${s.enabled ? `next ${fmtNext(s.next)}` : 'paused'}${s.lastRun ? ` · last ${fmtDate(s.lastRun)} ${s.lastResult === 'ok' ? '✅' : `⚠️ ${esc(s.lastResult)}`}` : ''}</p></div>
          <div class="btn-row"><button class="btn sm ghost" data-run ${dis}>${icon('play')}Run now</button><button class="btn sm ghost" data-tg ${dis}>${s.enabled ? 'Pause' : 'Resume'}</button><button class="icon-btn" data-del style="color:var(--bad)" title="Delete" ${dis}>${icon('trash')}</button></div></div>`).join('')
        : '<div class="muted">No schedules yet. A daily restart + an announcement before it is a good start.</div>'}</div></div>
      <div class="card"><h3>New schedule</h3><p class="sub">What should happen, and when.</p>
        <form id="sc-form"><label class="f"><span>Name</span><input class="input" name="name" maxlength="40" placeholder="Daily restart" ${dis}></label>
          <div class="grid g2" style="gap:12px"><label class="f"><span>When</span><select class="input" name="preset" ${dis}>${MC_PRESETS.map((p) => `<option value="${p[0]}">${p[1]}</option>`).join('')}</select></label>
            <label class="f" id="sc-cron-l" style="display:none"><span>Cron (min hour day month weekday)</span><input class="input mono" name="cron" placeholder="0 4 * * *" ${dis}></label></div>
          <label class="f"><span>Action</span><select class="input" name="action" ${dis}>${Object.entries(MC_ACTIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="f" id="sc-pay-l" style="display:none"><span id="sc-pay-t">Command</span><input class="input mono" name="payload" maxlength="500" ${dis}></label>
          <button class="btn" ${dis}>${icon('plus')}Add schedule</button></form>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">Tip: add "Announce: Server restarts in 5 minutes" at <span class="mono">55 3 * * *</span> and "Restart" at <span class="mono">0 4 * * *</span>.</p></div></div>`;
    const f = $('#sc-form');
    const sync = () => {
      $('#sc-cron-l').style.display = f.preset.value === 'custom' ? '' : 'none';
      const a = f.action.value;
      $('#sc-pay-l').style.display = a === 'command' || a === 'say' ? '' : 'none';
      $('#sc-pay-t').textContent = a === 'say' ? 'Message' : 'Command (without /)';
      f.payload.placeholder = a === 'say' ? 'Server restarts in 5 minutes!' : 'save-all';
    };
    f.preset.onchange = sync; f.action.onchange = sync; sync();
    f.onsubmit = (e) => {
      e.preventDefault();
      const d = formData(f);
      const body = { name: d.name || MC_ACTIONS[d.action], cron: d.preset === 'custom' ? d.cron : d.preset, action: d.action, payload: d.payload || '', enabled: true };
      act($('button.btn', f), () => api('POST', `/api/mc/${x.id}/schedules`, body), 'Schedule added').then(render).catch(() => {});
    };
    $$('[data-s]', t).forEach((row) => {
      const s = list.find((y) => y.id === row.dataset.s);
      $('[data-run]', row).onclick = (e) => act(e.target.closest('button'), () => api('POST', `/api/mc/${x.id}/schedules/${s.id}/run`), 'Done').then(render).catch(() => {});
      $('[data-tg]', row).onclick = (e) => act(e.target, () => api('PUT', `/api/mc/${x.id}/schedules/${s.id}`, { enabled: !s.enabled }), s.enabled ? 'Paused' : 'Resumed').then(render).catch(() => {});
      $('[data-del]', row).onclick = async () => { if (await confirmBox(`Delete "${s.name}"?`, 'The schedule is removed.')) act(null, () => api('DELETE', `/api/mc/${x.id}/schedules/${s.id}`), 'Deleted').then(render).catch(() => {}); };
    });
  };
  render(x);
}

// ---------- files ----------
function mcFiles(x, t, ctx) {
  return tabFiles(x, t, ctx, { base: `/api/mc/${x.id}`, start: '/', extract: true, folders: true }).then(() => {
    const card = $('.card', t);
    if (card) card.insertAdjacentHTML('afterbegin', `<div class="alert" style="margin:0 0 14px">Your server folder: worlds, <span class="mono">server.properties</span>, ${mcKind(x) === 'mods' ? '<span class="mono">mods</span>' : '<span class="mono">plugins</span>'} and configs. Upload a world as a folder or a <b>.zip</b> (use the extract button), then restart. Stop the server before replacing worlds.</div>`);
  });
}

// ---------- software changer ----------
async function mcSoftware(x, t, ctx) {
  const locked = x.suspended && !state.me.admin, dis = locked ? 'disabled' : '';
  t.innerHTML = `<form id="sw"><div class="grid g2" style="align-items:start">
    <div class="card"><h3>Server software</h3><p class="sub">Now: <b>${esc(mcSoft(x).label)} ${esc(x.version)}</b>. Switching downloads the new software - worlds and configs are kept.</p>
      <div class="pick-grid types3" style="margin-bottom:12px">${Object.entries(MC_SOFT).map(([k, s]) => `<button type="button" class="pick ${k === x.software ? 'sel' : ''}" data-soft="${k}" ${dis}><div class="os"><i style="background:${s.c}">${s.short}</i><div><b>${s.label}</b><span>${esc(s.desc)}</span></div></div></button>`).join('')}</div>
      <input type="hidden" name="software" value="${esc(x.software)}">
      <label class="f"><span>Minecraft version</span><select class="input" name="version" ${dis}><option>Loading…</option></select></label>
      <label class="check"><input type="checkbox" name="wipe" ${dis}><span><b style="color:var(--bad)">Delete all files</b> (fresh server - worlds, plugins and configs are removed)</span></label>
      <button class="btn lg" style="margin-top:12px" ${dis}>${icon('layers')}Install</button></div>
    <div class="card"><h3>Good to know</h3><dl class="kv mc-kv">
      <dt>Paper / Purpur</dt><dd>Best for plugins and performance. Spigot plugins work.</dd>
      <dt>Spigot</dt><dd>Built with BuildTools on the first start (5-15 min).</dd>
      <dt>Forge / Fabric</dt><dd>For mods. Players need the same mods + loader.</dd>
      <dt>Plugins ↔ mods</dt><dd>When you switch between plugin and mod software, the old <span class="mono">plugins</span>/<span class="mono">mods</span> folder is renamed to <span class="mono">…-disabled-…</span>, not deleted.</dd>
      <dt>Downgrading</dt><dd>Older versions may not load worlds made by newer ones - back up first (File manager → download).</dd></dl></div></div></form>`;
  const f = $('#sw');
  const loadVersions = async () => {
    f.version.innerHTML = '<option>Loading…</option>';
    try {
      const list = await mcVersions(f.software.value);
      f.version.innerHTML = list.map((v) => `<option ${v === x.version ? 'selected' : ''}>${esc(v)}</option>`).join('');
    } catch (e) { f.version.innerHTML = `<option value="">${esc(e.message)}</option>`; }
  };
  $$('[data-soft]', f).forEach((b) => (b.onclick = () => { f.software.value = b.dataset.soft; $$('[data-soft]', f).forEach((y) => y.classList.toggle('sel', y === b)); loadVersions(); }));
  loadVersions();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const s = MC_SOFT[f.software.value], v = f.version.value;
    if (!v) return toast('Pick a version');
    const wipe = f.wipe.checked;
    if (!(await confirmBox(`Install ${s.label} ${v}?`, `The server is stopped and ${s.label} ${v} is downloaded.${wipe ? ' ALL files are deleted first!' : ' Worlds and configs are kept.'}`, 'Install', wipe ? 'stop' : 'deep'))) return;
    act($('.btn.lg', f), () => api('POST', `/api/mc/${x.id}/software`, { software: f.software.value, version: v, wipe }), `Installing ${s.label} ${v} - press Start when it is ready`).then(() => { location.hash = `#/mc/${x.id}/console`; }).catch(() => {});
  };
}

// ---------- version changer (+ Java) ----------
async function mcVersion(x, t, ctx) {
  const locked = x.suspended && !state.me.admin, dis = locked ? 'disabled' : '';
  const st = ctx.st || {};
  t.innerHTML = `<div class="grid g2" style="align-items:start">
    <form class="card" id="vf"><h3>Minecraft version</h3><p class="sub">${esc(mcSoft(x).label)} - now <b>${esc(x.version)}</b>. Changing keeps your worlds, plugins and configs.</p>
      <label class="f"><span>Version</span><select class="input" name="version" ${dis}><option>Loading…</option></select></label>
      <div class="btn-row" id="v-quick" style="margin-bottom:12px"></div>
      <button class="btn lg" ${dis}>${icon('tag')}Change version</button></form>
    <form class="card" id="jf"><h3>Java & startup</h3><p class="sub">Java is picked automatically for the version (now <b>Java ${st.java || '-'}</b>).</p>
      <label class="f"><span>Java version</span><select class="input" name="java" ${dis}>
        <option value="0">Automatic (Java ${st.autoJava || '-'})</option>${[8, 11, 17, 21, 25].map((j) => `<option value="${j}" ${st.javaSetting === j ? 'selected' : ''}>Java ${j}</option>`).join('')}</select>
        <small>1.12 and older: Java 8 · 1.17-1.20.4: Java 17 · 1.20.5+: Java 21 · 26.x: Java 25</small></label>
      <label class="check"><input type="checkbox" name="autoRestart" ${st.autoRestart !== false ? 'checked' : ''} ${dis}> Restart automatically after a crash or a server reboot</label>
      <dl class="kv" style="margin-top:12px"><dt>Max heap (-Xmx)</dt><dd>${st.xmx ? fmtBytes(st.xmx * 1048576) : '-'} of ${fmtBytes(x.memory * 1048576)}</dd><dt>Image</dt><dd class="mono">${esc(st.image || '-')}</dd><dt>Port</dt><dd class="mono">${esc(x.address)}</dd></dl>
      <button class="btn" ${dis}>${icon('gear')}Save</button></form></div>`;
  const vf = $('#vf'), jf = $('#jf');
  try {
    const list = await mcVersions(x.software);
    vf.version.innerHTML = list.map((v) => `<option ${v === x.version ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const quick = [...new Set([list[0], ...list.filter((v) => /^1\.(21|20|19|18|16|12|8)(\.\d+)?$/.test(v)).filter((v, i, a) => a.findIndex((y) => y.split('.').slice(0, 2).join('.') === v.split('.').slice(0, 2).join('.')) === i)])].slice(0, 7);
    $('#v-quick').innerHTML = quick.map((v) => `<button type="button" class="btn sm ghost" data-q="${esc(v)}" ${dis}>${esc(v)}</button>`).join('');
    $$('[data-q]', vf).forEach((b) => (b.onclick = () => { vf.version.value = b.dataset.q; }));
  } catch (e) { vf.version.innerHTML = `<option value="">${esc(e.message)}</option>`; }
  vf.onsubmit = async (e) => {
    e.preventDefault();
    const v = vf.version.value;
    if (!v || v === x.version) return toast(v ? 'That is the current version' : 'Pick a version');
    const down = v.localeCompare(x.version, undefined, { numeric: true }) < 0;
    if (!(await confirmBox(`Change to ${v}?`, `The server is stopped and ${mcSoft(x).label} ${v} is installed. Worlds are kept.${down ? ' ⚠️ This is a downgrade - worlds made on a newer version may not load. Back up first.' : ''}`, 'Change', 'deep'))) return;
    act($('.btn.lg', vf), () => api('POST', `/api/mc/${x.id}/software`, { software: x.software, version: v }), `Installing ${v} - press Start when it is ready`).then(() => { location.hash = `#/mc/${x.id}/console`; }).catch(() => {});
  };
  jf.onsubmit = (e) => { e.preventDefault(); act($('.btn', jf), () => api('PUT', `/api/mc/${x.id}/settings`, { java: +jf.java.value, autoRestart: jf.autoRestart.checked }), 'Saved - restart the server to apply').then(() => ctx.poll()).catch(() => {}); };
}

// ---------- admin: create server ----------
async function pageCreateMc() {
  const [nodes, users] = await Promise.all([api('GET', '/api/admin/nodes'), api('GET', '/api/admin/users')]);
  const c = $('#content');
  const ok = nodes.filter((n) => n.system && n.system.docker);
  if (!nodes.length) { c.innerHTML = head('Create Minecraft server', '') + `<div class="card empty-state">${icon('node')}<h3>No nodes yet</h3><p>Add a node first.</p><a class="btn" href="#/admin/nodes">Go to nodes</a></div>`; return; }
  c.innerHTML = head('Create Minecraft server', 'Paper · Purpur · Spigot · Vanilla · Forge · Fabric') + `
  <form id="cm"><div class="grid g2" style="align-items:start">
    <div class="card"><h3>Basics</h3><p class="sub">Owner, node and software.</p>
      <label class="f"><span>Server name</span><input class="input" name="name" maxlength="40" placeholder="Survival SMP" required></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === state.me.id ? 'selected' : ''}>${esc(u.username)}${u.admin ? ' (admin)' : ''}</option>`).join('')}</select></label>
      <label class="f"><span>Node</span><select class="input" name="nodeId">${nodes.map((n) => `<option value="${n.id}" ${n.system && n.system.docker ? '' : 'disabled'}>${esc(n.name)} · ${esc(n.ip)}${!n.online ? ' (offline)' : n.system.docker ? '' : ' (needs Docker)'}</option>`).join('')}</select>
        ${ok.length ? '' : '<small style="color:var(--bad)">No node has Docker - Minecraft servers run on Docker.</small>'}</label>
      <div class="f-label">Software</div>
      <div class="pick-grid types3" style="margin-bottom:12px">${Object.entries(MC_SOFT).map(([k, s], i) => `<button type="button" class="pick ${i === 0 ? 'sel' : ''}" data-soft="${k}"><div class="os"><i style="background:${s.c}">${s.short}</i><div><b>${s.label}</b><span>${esc(s.desc)}</span></div></div></button>`).join('')}</div>
      <input type="hidden" name="software" value="paper">
      <label class="f"><span>Minecraft version</span><select class="input" name="version"><option>Loading…</option></select></label>
    </div>
    <div class="card"><h3>Server</h3><p class="sub">Limits and address.</p>
      <div class="grid g3" style="gap:12px">
        <label class="f"><span>vCPU</span><input class="input" type="number" name="cpu" min="0.5" step="0.5" max="64" value="2"></label>
        <label class="f"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="512" step="512" value="4096"></label>
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="20"></label></div>
      <div class="grid g2" style="gap:12px">
        <label class="f"><span>Port (optional)</span><input class="input" type="number" name="port" min="1024" max="65535" placeholder="auto (25565…)"></label>
        <label class="f"><span>Max players</span><input class="input" type="number" name="maxPlayers" min="1" max="1000" value="20"></label></div>
      <label class="f"><span>MOTD (server list text)</span><input class="input" name="motd" maxlength="59" placeholder="A Minecraft Server on AVM"></label>
      <p class="muted" style="font-size:12.5px">By creating a server you accept the <a href="https://www.minecraft.net/eula" target="_blank" rel="noopener">Minecraft EULA</a> (eula=true is set). RAM: 2 GB is fine for a few players, 4-8 GB for modpacks.</p>
      <button class="btn lg block" style="margin-top:12px" ${ok.length ? '' : 'disabled'}>${icon('plus')}Create server</button>
    </div></div></form>`;
  const f = $('#cm');
  if (f.nodeId.selectedOptions[0] && f.nodeId.selectedOptions[0].disabled && ok[0]) f.nodeId.value = ok[0].id;
  const loadVersions = async () => {
    f.version.innerHTML = '<option>Loading…</option>';
    try { const list = await mcVersions(f.software.value); f.version.innerHTML = list.map((v, i) => `<option ${i === 0 ? 'selected' : ''}>${esc(v)}</option>`).join(''); }
    catch (e) { f.version.innerHTML = `<option value="">${esc(e.message)}</option>`; }
  };
  $$('[data-soft]', f).forEach((b) => (b.onclick = () => { f.software.value = b.dataset.soft; $$('[data-soft]', f).forEach((y) => y.classList.toggle('sel', y === b)); loadVersions(); }));
  loadVersions();
  f.onsubmit = (e) => {
    e.preventDefault();
    if (!f.version.value) return toast('Pick a version');
    act($('.btn.lg', f), () => api('POST', '/api/admin/mc', formData(f)), 'Server created - downloading the software, then press Start').then((x) => { location.hash = `#/mc/${x.id}/console`; }).catch(() => {});
  };
}

// ---------- admin: all servers ----------
async function pageAdminMc() {
  const list = await api('GET', '/api/admin/mc');
  $('#content').innerHTML = head('Minecraft servers', `${list.length} total`, `<a class="btn" href="#/admin/createmc">${icon('plus')}Create server</a>`) +
    `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Server</th><th>Owner</th><th>Software</th><th>Address</th><th>Limits</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((x) => `<tr>
      <td><a href="#/mc/${x.id}/console"><b>${esc(x.name)}</b></a><div class="muted mono" style="font-size:12px">${esc(x.mcName)} · ${esc(x.nodeName)}</div></td>
      <td>${esc(x.ownerName)}</td><td><span class="badge">${esc(mcSoft(x).label)}</span> <span class="muted">${esc(x.version)}</span></td><td class="mono nowrap">${esc(x.address)}</td>
      <td class="nowrap">${x.cpu} vCPU · ${fmtBytes(x.memory * 1048576)} · ${x.disk} GB</td>
      <td data-amst="${x.id}">${x.suspended ? mcBadge(null, true) : '<span class="badge off">…</span>'}</td>
      <td class="right nowrap"><a class="btn sm" href="#/mc/${x.id}/console">Manage</a>
        <button class="btn sm ghost" data-susp="${x.id}" data-on="${x.suspended ? '' : 1}">${icon('pause')}${x.suspended ? 'Unsuspend' : 'Suspend'}</button>
        <button class="icon-btn" data-edit="${x.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-del="${x.id}" title="Delete" style="color:var(--bad)">${icon('trash')}</button></td></tr>`).join('') : '<tr><td colspan="7" class="muted">No Minecraft servers yet.</td></tr>'}
    </tbody></table></div></div>`;
  list.filter((x) => !x.suspended).forEach(async (x) => { const el = () => $(`[data-amst="${x.id}"]`); try { const st = await api('GET', `/api/mc/${x.id}/status`); if (el()) el().innerHTML = mcBadge(st); } catch { if (el()) el().innerHTML = '<span class="badge bad">offline</span>'; } });
  $$('[data-susp]').forEach((b) => (b.onclick = async () => {
    const on = !!b.dataset.on;
    if (on && !(await confirmBox('Suspend this server?', 'It is stopped (worlds are saved) and the owner cannot start or manage it.', 'Suspend'))) return;
    act(b, () => api('POST', `/api/admin/mc/${b.dataset.susp}/suspend`, { suspended: on }), on ? 'Suspended' : 'Unsuspended').then(render).catch(() => {});
  }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    const x = list.find((y) => y.id === b.dataset.del);
    if (!(await confirmBox(`Delete ${x.name}?`, 'The server, its worlds and all files are permanently deleted.'))) return;
    try { await act(b, () => api('DELETE', `/api/admin/mc/${x.id}`), 'Server deleted'); render(); }
    catch (e) { if (/force/.test(e.message) && (await confirmBox('Force delete?', 'The node could not be reached. Remove the server from the panel anyway?', 'Force delete'))) act(b, () => api('DELETE', `/api/admin/mc/${x.id}?force=1`), 'Removed').then(render).catch(() => {}); }
  }));
  $$('[data-edit]').forEach((b) => (b.onclick = async () => {
    const x = list.find((y) => y.id === b.dataset.edit);
    const users = await api('GET', '/api/admin/users');
    modal({ title: 'Edit ' + x.name, body: `<form id="em">
      <label class="f"><span>Name</span><input class="input" name="name" value="${esc(x.name)}" maxlength="40"></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === x.ownerId ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}</select></label>
      <div class="grid g3" style="gap:12px"><label class="f"><span>vCPU</span><input class="input" type="number" name="cpu" min="0.5" step="0.5" value="${x.cpu}"></label>
        <label class="f"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="512" step="512" value="${x.memory}"></label>
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="${x.disk}"></label></div>
      <p class="muted" style="font-size:12.5px">RAM changes apply to Java (-Xmx) on the next restart.</p></form>`,
      footer: '<button class="btn ghost" data-close>Cancel</button><button class="btn" form="em">Save</button>',
      onMount: (el, close) => { $('#em', el).onsubmit = (e) => { e.preventDefault(); act(null, () => api('PATCH', `/api/admin/mc/${x.id}`, formData(e.target)), 'Saved').then(() => { close(); render(); }).catch(() => {}); }; } });
  }));
}
