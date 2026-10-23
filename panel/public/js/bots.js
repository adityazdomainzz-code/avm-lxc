/* AVM Panel - Discord bot hosting pages (Node.js / TypeScript / Python).
   Loaded before app.js; only declares functions - it uses the helpers from app.js at run time. */
'use strict';

const BOT_LANG = {
  node: { label: 'Node.js', short: 'JS', c: '#3c873a', versions: ['22', '20', '24'], main: 'index.js', deps: 'package.json', run: 'node index.js' },
  ts: { label: 'TypeScript', short: 'TS', c: '#3178c6', versions: ['22', '20', '24'], main: 'index.ts', deps: 'package.json', run: 'tsx index.ts' },
  python: { label: 'Python', short: 'PY', c: '#3776ab', versions: ['3.12', '3.13', '3.11'], main: 'main.py', deps: 'requirements.txt', run: 'python main.py' },
};
const botLang = (x) => BOT_LANG[x.lang] || BOT_LANG.node;
function botIcon(x) { const l = botLang(x); return `<div class="os-icon" style="background:linear-gradient(140deg,#fff,${l.c}22);color:${l.c};font-size:12px">${l.short}</div>`; }
function botBadge(st, suspended) {
  if (suspended || (st && st.state === 'suspended')) return '<span class="badge bad"><i class="pulse"></i>suspended</span>';
  if (!st) return '<span class="badge off">…</span>';
  const m = { running: ['ok', 'online'], installing: ['warn', 'preparing'], restarting: ['warn', 'restarting'], stopped: ['off', 'offline'], error: ['bad', 'error'] }[st.state] || ['off', st.state];
  return `<span class="badge ${m[0]}"><i class="pulse"></i>${esc(m[1])}</span>`;
}
const fmtUptime = (ms) => { if (!ms) return '-'; const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };

// ---------- my bots ----------
async function pageBots() {
  const list = await api('GET', '/api/bots');
  $('#content').innerHTML = head('My Discord bots', `${list.length} bot${list.length === 1 ? '' : 's'}`, state.me.admin ? `<a class="btn" href="#/admin/createbot">${icon('plus')}Create bot</a>` : '') +
    (list.length ? `<div class="grid g3">${list.map((x) => `
      <a class="card vm-card" href="#/bot/${x.id}/console">
        <div class="top"><div style="display:flex;gap:12px;align-items:center;min-width:0">${botIcon(x)}<div style="min-width:0"><h3 class="trunc">${esc(x.name)}</h3><span class="muted">${esc(botLang(x).label)} ${esc(x.version || '')}</span></div></div><span data-bst="${x.id}">${botBadge(null, x.suspended)}</span></div>
        <div class="meta"><span><b>${x.cpu}</b> vCPU</span><span><b>${fmtBytes(x.memory * 1048576)}</b> RAM</span><span><b>${x.disk} GB</b> disk</span></div>
      </a>`).join('')}</div>`
      : `<div class="card empty-state">${icon('bot')}<h3>No bots yet</h3><p>${state.me.admin ? 'Create your first Discord bot from the admin area.' : 'An admin will create a bot for you.'}</p>${state.me.admin ? `<a class="btn" href="#/admin/createbot">${icon('plus')}Create bot</a>` : ''}</div>`);
  list.filter((x) => !x.suspended).forEach(async (x) => {
    const el = () => $(`[data-bst="${x.id}"]`);
    try { const st = await api('GET', `/api/bots/${x.id}/status`); if (el()) el().innerHTML = botBadge(st); } catch { if (el()) el().innerHTML = '<span class="badge bad">node offline</span>'; }
  });
}

// ---------- single bot ----------
async function pageBot(id, tab) {
  const x = await api('GET', `/api/bots/${id}`);
  state.botCache[id] = x;
  renderSidebar();
  const c = $('#content');
  const locked = x.suspended && !state.me.admin;
  c.innerHTML = `
    <div class="vm-bar"><div class="title">${botIcon(x)}<div style="min-width:0"><h1>${esc(x.name)}</h1><div class="sub">${esc(botLang(x).label)} ${esc(x.version || '')} · Discord bot · ${esc(x.nodeName)}</div></div><span id="bot-state">${botBadge(null, x.suspended)}</span></div>
      <div class="btn-row">
        <button class="btn ok" data-p="start" ${locked ? 'disabled' : ''}>${icon('play')}Start</button>
        <button class="btn deep" data-p="restart" ${locked ? 'disabled' : ''}>${icon('refresh')}Restart</button>
        <button class="btn stop" data-p="stop" ${locked ? 'disabled' : ''}>${icon('stop')}Stop</button>
        <button class="btn ghost" data-p="kill" title="Force stop" ${locked ? 'disabled' : ''}>${icon('zap')}Kill</button>
      </div></div>
    ${x.suspended ? `<div class="alert bad"><b>This bot is suspended.</b> ${state.me.admin ? 'Unsuspend it in Admin → Discord bots.' : 'Please contact an administrator.'}</div>` : ''}
    <div id="tab"></div>`;
  const ss = { st: null, listeners: [] };
  const poll = async () => {
    try {
      const st = await api('GET', `/api/bots/${id}/status`);
      const changed = !ss.st || ss.st.state !== st.state;
      ss.st = st;
      const el = $('#bot-state');
      if (el) el.innerHTML = botBadge(st, x.suspended) + (st.busy && st.step ? ` <span class="muted" style="font-size:12px">${esc(st.step)}…</span>` : '') + (st.error && !st.busy ? ` <span class="badge bad" title="${esc(st.error)}">error</span>` : '') + (st.state === 'stopped' && st.exitCode ? ` <span class="badge warn" title="exit code">exit ${st.exitCode}</span>` : '');
      ss.listeners.forEach((fn) => fn(st, changed));
    } catch { const el = $('#bot-state'); if (el) el.innerHTML = '<span class="badge bad">node offline</span>'; }
  };
  const iv = setInterval(poll, 3000);
  state.cleanup.push(() => clearInterval(iv));
  $$('[data-p]', c).forEach((b) => (b.onclick = () => {
    const a = b.dataset.p;
    act(b, () => api('POST', `/api/bots/${id}/power`, { action: a }), { start: 'Bot started', restart: 'Bot restarted', stop: 'Bot stopped', kill: 'Bot killed' }[a]).then(() => setTimeout(poll, 500)).catch(() => {});
    if (a === 'start' || a === 'restart') { const el = $('#bot-state'); if (el) el.innerHTML = botBadge({ state: 'installing' }) + ' <span class="muted" style="font-size:12px">starting… (first start downloads the runtime)</span>'; }
  }));
  const t = $('#tab');
  await poll();
  const ctx = { onStatus: (fn) => ss.listeners.push(fn), get st() { return ss.st; }, poll };
  const fn = { console: botConsole, files: botFiles, usage: botUsage, settings: botSettings }[tab] || botConsole;
  await fn(x, t, ctx);
}

async function botConsole(x, t, ctx) {
  let term = null, ws = null, ro = null, fit = null;
  t.innerHTML = `<div class="term-wrap"><div class="term-head"><div class="lights"><i></i><i></i><i></i></div><span>${esc(x.name)} · console</span><span id="t-status"></span></div><div id="term"></div></div>
    <form id="bot-cmd" class="bot-cmd"><input class="input mono" name="cmd" placeholder="Type a command for the bot's stdin and press Enter" autocomplete="off"><button class="btn">Send</button></form>
    <p class="muted" style="font-size:12.5px;margin:8px 2px 0">Shows the bot's output live (last 300 lines on open). Typing goes to the bot's input (stdin).</p>`;
  const teardown = () => { try { ws && ws.close(); } catch {} try { ro && ro.disconnect(); } catch {} try { term && term.dispose(); } catch {} ws = term = ro = null; };
  state.cleanup.push(teardown);
  try { await loadXterm(); } catch (e) { $('#term').innerHTML = `<p style="color:#fff;padding:20px">${esc(e.message)}</p>`; return; }
  term = new window.Terminal({ cursorBlink: false, convertEol: false, fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, scrollback: 5000, disableStdin: false,
    theme: { background: '#062530', foreground: '#dff6fb', cursor: '#7fe0f2', selectionBackground: '#1b6a80', blue: '#4fb6e8', cyan: '#5ee0f0', green: '#5fe0a8', magenta: '#b794f6', red: '#ff7a85', yellow: '#ffd479', brightBlack: '#4b7584' } });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit); term.open($('#term')); fit.fit();
  const status = (html) => { const s = $('#t-status'); if (s) s.innerHTML = html; };
  const connect = () => {
    if (!term) return;
    try { ws && ws.close(); } catch {}
    term.reset();
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/bots/${x.id}/console`);
    ws.onopen = () => status('<span class="badge ok" style="font-size:11px"><i class="pulse"></i>live</span>');
    ws.onmessage = (e) => term && term.write(e.data);
    ws.onclose = () => status('<span class="badge off" style="font-size:11px">offline</span>');
  };
  term.onData((d) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data: d })));
  $('#bot-cmd').onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.cmd.value;
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'input', data: v + '\r' })); e.target.cmd.value = ''; }
    else toast('The bot is not running');
  };
  ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  ro.observe($('#term'));
  connect();
  ctx.onStatus((st, changed) => { if (changed && (st.state === 'running' || st.state === 'stopped')) setTimeout(connect, st.state === 'running' ? 400 : 1200); });
}

function botFiles(x, t, ctx) {
  const l = botLang(x);
  return tabFiles(x, t, ctx, { base: `/api/bots/${x.id}`, start: '/', extract: true }).then(() => {
    const card = $('.card', t);
    if (card) card.insertAdjacentHTML('afterbegin', `<div class="alert" style="margin:0 0 14px">Upload your bot here. Main file: <b class="mono">${esc((ctx.st && ctx.st.main) || l.main)}</b>. Packages from <b class="mono">${l.deps}</b> are installed automatically on start. Upload a <b>.zip</b> and use the extract button to unpack it. Don't upload <span class="mono">node_modules</span> / <span class="mono">.venv</span>.</div>`);
  });
}

function botUsage(x, t, ctx) {
  t.innerHTML = `<div class="grid g4" style="margin-bottom:18px">
    <div class="card stat"><div class="k">CPU</div><div class="v" id="u-cpu">0%</div><div class="s">${x.cpu} vCPU</div><canvas class="spark" id="sp-cpu"></canvas></div>
    <div class="card stat"><div class="k">Memory</div><div class="v" id="u-mem">0 B</div><div class="s" id="u-mem-s">of ${fmtBytes(x.memory * 1048576)}</div><canvas class="spark" id="sp-mem"></canvas></div>
    <div class="card stat"><div class="k">Disk</div><div class="v" id="u-disk">-</div><div class="s">of ${x.disk} GB</div><div class="bar"><i id="u-disk-b" style="width:0"></i></div></div>
    <div class="card stat"><div class="k">Uptime</div><div class="v" id="u-up">-</div><div class="s" id="u-rs">restarts: 0</div></div>
  </div>
  <div class="card"><h3>Bot</h3><p class="sub">Live numbers from the bot's container, updated every 3 seconds.</p>
    <dl class="kv"><dt>Status</dt><dd id="u-state">-</dd><dt>Runtime</dt><dd id="u-img" class="mono">-</dd><dt>Main file</dt><dd id="u-main" class="mono">-</dd>
    <dt>Network</dt><dd>↓ <span id="u-rx">0 B</span> · ↑ <span id="u-tx">0 B</span></dd><dt>Processes</dt><dd id="u-proc">-</dd><dt>Node</dt><dd>${esc(x.nodeName)}</dd><dt>Created</dt><dd>${fmtDate(x.createdAt)}</dd></dl></div>`;
  const hist = { cpu: [], mem: [] };
  const upd = (st) => {
    if (!st || !$('#u-cpu')) return;
    const run = st.state === 'running';
    hist.cpu.push(run ? st.cpu : 0); hist.mem.push(run ? st.memory : 0);
    if (hist.cpu.length > 40) { hist.cpu.shift(); hist.mem.shift(); }
    $('#u-cpu').textContent = (run ? st.cpu : 0) + '%';
    $('#u-mem').textContent = fmtBytes(run ? st.memory : 0);
    $('#u-mem-s').textContent = `of ${fmtBytes(st.memLimit)} · ${pct(st.memory, st.memLimit).toFixed(0)}%`;
    $('#u-disk').textContent = fmtBytes(st.disk);
    const dp = pct(st.disk, st.diskLimit); $('#u-disk-b').style.width = dp + '%'; $('#u-disk-b').parentElement.classList.toggle('hot', dp > 85);
    $('#u-up').textContent = run ? fmtUptime(st.uptime) : '-';
    $('#u-rs').textContent = `restarts: ${st.restarts || 0}${st.exitCode ? ' · last exit ' + st.exitCode : ''}`;
    $('#u-state').innerHTML = botBadge(st, x.suspended) + (st.error ? ` <span class="muted">${esc(st.error)}</span>` : '');
    $('#u-img').textContent = st.image; $('#u-main').textContent = st.startCmd || st.main;
    $('#u-rx').textContent = fmtBytes(st.netRx); $('#u-tx').textContent = fmtBytes(st.netTx); $('#u-proc').textContent = st.processes || '-';
    sparkline($('#sp-cpu'), hist.cpu, 100); sparkline($('#sp-mem'), hist.mem, st.memLimit);
  };
  upd(ctx.st);
  ctx.onStatus((st) => upd(st));
}

function botSettings(x, t, ctx) {
  const st = ctx.st || {};
  const locked = x.suspended && !state.me.admin;
  const dis = locked ? 'disabled' : '';
  const langPicks = (cur) => Object.entries(BOT_LANG).map(([k, l]) => `<button type="button" class="pick ${k === cur ? 'sel' : ''}" data-lang="${k}" ${dis}><div class="os"><i style="background:${l.c}">${l.short}</i><div><b>${l.label}</b><span>${esc(l.run)}</span></div></div></button>`).join('');
  t.innerHTML = `<form id="bs"><div class="grid g2" style="align-items:start">
    <div class="card"><h3>Startup</h3><p class="sub">How the bot is started. Changes apply on the next <b>Restart</b>.</p>
      <div class="f-label">Language</div><div class="pick-grid types3" style="margin-bottom:12px">${langPicks(st.lang || x.lang)}</div><input type="hidden" name="lang" value="${esc(st.lang || x.lang)}">
      <div class="grid g2" style="gap:12px">
        <label class="f"><span>Version</span><select class="input" name="version" ${dis}></select></label>
        <label class="f"><span>Main file</span><input class="input mono" name="main" value="${esc(st.main || botLang(x).main)}" ${dis}></label></div>
      <label class="f"><span>Custom start command (optional)</span><input class="input mono" name="startCmd" value="${esc(st.startCmd || '')}" placeholder="e.g. npm run start  ·  python bot/run.py --prod" ${dis}><small>Leave empty to run the main file. Runs inside the bot folder after packages are installed.</small></label>
      <label class="check"><input type="checkbox" name="install" ${st.install !== false ? 'checked' : ''} ${dis}><span>Install packages on start (<span class="mono" id="deps-file"></span>)</span></label>
      <label class="check"><input type="checkbox" name="autoRestart" ${st.autoRestart !== false ? 'checked' : ''} ${dis}> Restart automatically if the bot crashes (and after a server reboot)</label>
      <div class="btn-row" style="margin-top:14px"><button class="btn" ${dis}>${icon('gear')}Save</button><button type="button" class="btn ghost" id="bs-save-restart" ${dis}>${icon('refresh')}Save & restart</button></div>
    </div>
    <div><div class="card"><h3>Environment variables</h3><p class="sub">Secrets like your bot token. One <span class="mono">KEY=value</span> per line - read them with <span class="mono" id="env-hint"></span>.</p>
      <textarea class="input mono" name="env" rows="7" spellcheck="false" placeholder="DISCORD_TOKEN=your-bot-token&#10;PREFIX=!" ${dis}>${esc((st.env || []).join('\n'))}</textarea>
      <p class="muted" style="font-size:12.5px;margin:8px 0 0">Get a token: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a> → your app → Bot → Reset Token. Turn on <b>Message Content Intent</b> there if the bot reads messages.</p></div>
    <div class="card"><h3>Packages</h3><p class="sub">Broken install? Delete <span class="mono">node_modules</span> / <span class="mono">.venv</span> and install fresh on the next start.</p>
      <button type="button" class="btn ghost" id="bs-reinstall" ${dis}>${icon('trash')}Reinstall packages</button></div>
    <div class="card"><h3>Plan</h3><p class="sub">Limits set by the administrator.</p>
      <dl class="kv"><dt>CPU</dt><dd>${x.cpu} vCPU</dd><dt>Memory</dt><dd>${fmtBytes(x.memory * 1048576)}</dd><dt>Disk</dt><dd>${x.disk} GB</dd><dt>Owner</dt><dd>${esc(x.ownerName)}</dd><dt>Node</dt><dd>${esc(x.nodeName)}</dd></dl></div></div>
  </div></form>`;
  const f = $('#bs');
  const syncLang = (keepMain) => {
    const lang = f.lang.value, l = BOT_LANG[lang];
    $$('[data-lang]', f).forEach((b) => b.classList.toggle('sel', b.dataset.lang === lang));
    const cur = lang === (st.lang || x.lang) ? (st.version || x.version) : l.versions[0];
    f.version.innerHTML = l.versions.map((v) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
    if (!keepMain) f.main.value = l.main;
    $('#deps-file').textContent = l.deps;
    $('#env-hint').textContent = lang === 'python' ? 'os.environ["DISCORD_TOKEN"]' : 'process.env.DISCORD_TOKEN';
  };
  $$('[data-lang]', f).forEach((b) => (b.onclick = () => { f.lang.value = b.dataset.lang; syncLang(false); }));
  syncLang(true);
  const save = () => api('PUT', `/api/bots/${x.id}/settings`, { lang: f.lang.value, version: f.version.value, main: f.main.value, startCmd: f.startCmd.value, env: f.env.value, install: f.install.checked, autoRestart: f.autoRestart.checked });
  f.onsubmit = (e) => { e.preventDefault(); act($('button.btn:not(.ghost)', f), save, 'Saved - restart the bot to apply').then(() => { x.lang = f.lang.value; x.version = f.version.value; ctx.poll(); }).catch(() => {}); };
  $('#bs-save-restart').onclick = () => act($('#bs-save-restart'), async () => { await save(); await api('POST', `/api/bots/${x.id}/power`, { action: 'restart' }); }, 'Saved and restarted').then(() => ctx.poll()).catch(() => {});
  $('#bs-reinstall').onclick = async () => { if (await confirmBox('Reinstall packages?', 'node_modules / .venv are deleted. They are installed again on the next start (the bot is not stopped now).', 'Reinstall', 'deep')) act($('#bs-reinstall'), () => api('POST', `/api/bots/${x.id}/reinstall`), 'Packages removed - restart the bot to install fresh').catch(() => {}); };
}

// ---------- admin: create bot ----------
async function pageCreateBot() {
  const [nodes, users] = await Promise.all([api('GET', '/api/admin/nodes'), api('GET', '/api/admin/users')]);
  const c = $('#content');
  const ok = nodes.filter((n) => n.system && n.system.docker);
  if (!nodes.length) { c.innerHTML = head('Create Discord bot', '') + `<div class="card empty-state">${icon('node')}<h3>No nodes yet</h3><p>Add a node first.</p><a class="btn" href="#/admin/nodes">Go to nodes</a></div>`; return; }
  c.innerHTML = head('Create Discord bot', 'Node.js, TypeScript or Python · live console · auto install') + `
  <form id="cb"><div class="grid g2" style="align-items:start">
    <div class="card"><h3>Basics</h3><p class="sub">Owner, server and language.</p>
      <label class="f"><span>Bot name</span><input class="input" name="name" maxlength="40" placeholder="Music bot" required></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === state.me.id ? 'selected' : ''}>${esc(u.username)}${u.admin ? ' (admin)' : ''}</option>`).join('')}</select></label>
      <label class="f"><span>Node</span><select class="input" name="nodeId">${nodes.map((n) => `<option value="${n.id}" ${n.system && n.system.docker ? '' : 'disabled'}>${esc(n.name)} · ${esc(n.ip)}${!n.online ? ' (offline)' : n.system.docker ? '' : ' (needs Docker)'}</option>`).join('')}</select>
        ${ok.length ? '' : '<small style="color:var(--bad)">No node has Docker - bots run on Docker.</small>'}</label>
      <div class="f-label">Language</div>
      <div class="pick-grid types3" style="margin-bottom:12px">${Object.entries(BOT_LANG).map(([k, l], i) => `<button type="button" class="pick ${i === 0 ? 'sel' : ''}" data-lang="${k}"><div class="os"><i style="background:${l.c}">${l.short}</i><div><b>${l.label}</b><span>${esc(l.run)}</span></div></div></button>`).join('')}</div>
      <input type="hidden" name="lang" value="node">
      <label class="f"><span>Version</span><select class="input" name="version"></select></label>
    </div>
    <div class="card"><h3>Bot</h3><p class="sub">Token and limits.</p>
      <label class="f"><span>Discord bot token (optional)</span><input class="input mono" type="password" name="token" placeholder="can be added later in Settings" autocomplete="off"><small>Saved as the environment variable <span class="mono">DISCORD_TOKEN</span>.</small></label>
      <label class="check"><input type="checkbox" name="starter" checked><span>Add a ready "!ping" example bot (<span class="mono" id="cb-files"></span>)</span></label>
      <div class="grid g3" style="gap:12px;margin-top:12px">
        <label class="f"><span>vCPU</span><input class="input" type="number" name="cpu" min="0.25" step="0.25" max="32" value="0.5"></label>
        <label class="f"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="64" step="64" value="512"></label>
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="2"></label></div>
      <button class="btn lg block" style="margin-top:16px" ${ok.length ? '' : 'disabled'}>${icon('plus')}Create bot</button>
    </div></div></form>`;
  const f = $('#cb');
  if (f.nodeId.selectedOptions[0] && f.nodeId.selectedOptions[0].disabled && ok[0]) f.nodeId.value = ok[0].id;
  const sync = () => {
    const l = BOT_LANG[f.lang.value];
    $$('[data-lang]', f).forEach((b) => b.classList.toggle('sel', b.dataset.lang === f.lang.value));
    f.version.innerHTML = l.versions.map((v, i) => `<option ${i === 0 ? 'selected' : ''}>${v}</option>`).join('');
    $('#cb-files').textContent = `${l.main} + ${l.deps}`;
  };
  $$('[data-lang]', f).forEach((b) => (b.onclick = () => { f.lang.value = b.dataset.lang; sync(); }));
  sync();
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = formData(f); body.starter = f.starter.checked;
    act($('.btn.lg', f), () => api('POST', '/api/admin/bots', body), 'Bot created - press Start').then((x) => { location.hash = `#/bot/${x.id}/console`; }).catch(() => {});
  };
}

// ---------- admin: all bots ----------
async function pageAdminBots() {
  const list = await api('GET', '/api/admin/bots');
  $('#content').innerHTML = head('Discord bots', `${list.length} total`, `<a class="btn" href="#/admin/createbot">${icon('plus')}Create bot</a>`) +
    `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Bot</th><th>Owner</th><th>Language</th><th>Node</th><th>Limits</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((x) => `<tr>
      <td><a href="#/bot/${x.id}/console"><b>${esc(x.name)}</b></a><div class="muted mono" style="font-size:12px">${esc(x.botName)}</div></td>
      <td>${esc(x.ownerName)}</td><td><span class="badge">${botLang(x).label}</span> <span class="muted">${esc(x.version || '')}</span></td><td>${esc(x.nodeName)}</td>
      <td class="nowrap">${x.cpu} vCPU · ${fmtBytes(x.memory * 1048576)} · ${x.disk} GB</td>
      <td data-abst="${x.id}">${x.suspended ? botBadge(null, true) : '<span class="badge off">…</span>'}</td>
      <td class="right nowrap"><a class="btn sm" href="#/bot/${x.id}/console">Manage</a>
        <button class="btn sm ghost" data-susp="${x.id}" data-on="${x.suspended ? '' : 1}">${icon('pause')}${x.suspended ? 'Unsuspend' : 'Suspend'}</button>
        <button class="icon-btn" data-edit="${x.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-del="${x.id}" title="Delete" style="color:var(--bad)">${icon('trash')}</button></td></tr>`).join('') : '<tr><td colspan="7" class="muted">No bots yet.</td></tr>'}
    </tbody></table></div></div>`;
  list.filter((x) => !x.suspended).forEach(async (x) => { const el = () => $(`[data-abst="${x.id}"]`); try { const st = await api('GET', `/api/bots/${x.id}/status`); if (el()) el().innerHTML = botBadge(st); } catch { if (el()) el().innerHTML = '<span class="badge bad">offline</span>'; } });
  $$('[data-susp]').forEach((b) => (b.onclick = async () => {
    const on = !!b.dataset.on;
    if (on && !(await confirmBox('Suspend this bot?', 'It is stopped and the owner cannot start or manage it.', 'Suspend'))) return;
    act(b, () => api('POST', `/api/admin/bots/${b.dataset.susp}/suspend`, { suspended: on }), on ? 'Suspended' : 'Unsuspended').then(render).catch(() => {});
  }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    const x = list.find((y) => y.id === b.dataset.del);
    if (!(await confirmBox(`Delete ${x.name}?`, 'The bot and all its files are permanently deleted.'))) return;
    try { await act(b, () => api('DELETE', `/api/admin/bots/${x.id}`), 'Bot deleted'); render(); }
    catch (e) { if (/force/.test(e.message) && (await confirmBox('Force delete?', 'The node could not be reached. Remove the bot from the panel anyway?', 'Force delete'))) act(b, () => api('DELETE', `/api/admin/bots/${x.id}?force=1`), 'Removed').then(render).catch(() => {}); }
  }));
  $$('[data-edit]').forEach((b) => (b.onclick = async () => {
    const x = list.find((y) => y.id === b.dataset.edit);
    const users = await api('GET', '/api/admin/users');
    modal({ title: 'Edit ' + x.name, body: `<form id="eb">
      <label class="f"><span>Name</span><input class="input" name="name" value="${esc(x.name)}" maxlength="40"></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === x.ownerId ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}</select></label>
      <div class="grid g3" style="gap:12px"><label class="f"><span>vCPU</span><input class="input" type="number" name="cpu" min="0.25" step="0.25" value="${x.cpu}"></label>
        <label class="f"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="64" step="64" value="${x.memory}"></label>
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="${x.disk}"></label></div></form>`,
      footer: '<button class="btn ghost" data-close>Cancel</button><button class="btn" form="eb">Save</button>',
      onMount: (el, close) => { $('#eb', el).onsubmit = (e) => { e.preventDefault(); act(null, () => api('PATCH', `/api/admin/bots/${x.id}`, formData(e.target)), 'Saved').then(() => { close(); render(); }).catch(() => {}); }; } });
  }));
}
