/* AVM Panel - website hosting pages (static HTML + PHP, auto SSL, databases, phpMyAdmin).
   Loaded before app.js; only declares functions - it uses the helpers from app.js at run time. */
'use strict';

const SITE_KIND = { static: { label: 'HTML', long: 'Static HTML website', c: '#e44d26' }, php: { label: 'PHP', long: 'PHP website', c: '#777bb3' } };
const siteKind = (x) => SITE_KIND[x.kind] || SITE_KIND.static;
function siteIcon(x) { const k = siteKind(x); return `<div class="os-icon" style="background:linear-gradient(140deg,#fff,${k.c}22);color:${k.c};font-size:12px">${k.label}</div>`; }
function siteBadge(st, suspended) {
  if (suspended || (st && st.state === 'suspended')) return '<span class="badge bad"><i class="pulse"></i>suspended</span>';
  if (!st) return '<span class="badge off">…</span>';
  if (st.overLimit) return '<span class="badge bad"><i class="pulse"></i>bandwidth limit</span>';
  const m = { running: ['ok', 'online'], installing: ['warn', 'setting up'], stopped: ['off', 'stopped'], error: ['bad', 'error'], missing: ['bad', 'missing'] }[st.state] || ['off', st.state];
  return `<span class="badge ${m[0]}"><i class="pulse"></i>${esc(m[1])}</span>`;
}
const siteUrl = (x) => `https://${x.host}`;
const dnsName = (x) => (x.sub && x.sub !== '@' ? x.sub : '@');

// ---------- my websites ----------
async function pageSites() {
  const list = await api('GET', '/api/sites');
  $('#content').innerHTML = head('My websites', `${list.length} website${list.length === 1 ? '' : 's'}`, state.me.admin ? `<a class="btn" href="#/admin/createweb">${icon('plus')}Create website</a>` : '') +
    (list.length ? `<div class="grid g3">${list.map((x) => `
      <a class="card vm-card" href="#/site/${x.id}/files">
        <div class="top"><div style="display:flex;gap:12px;align-items:center;min-width:0">${siteIcon(x)}<div style="min-width:0"><h3 class="trunc">${esc(x.name)}</h3><span class="muted mono trunc" style="display:block">${esc(x.host)}</span></div></div><span data-sst="${x.id}">${siteBadge(null, x.suspended)}</span></div>
        <div class="meta"><span><b>${siteKind(x).label}</b>${x.php ? ' ' + esc(x.php) : ''}</span><span><b>${x.disk} GB</b> disk</span><span><b>${x.bandwidth ? x.bandwidth + ' GB' : '∞'}</b> bandwidth</span>${x.kind === 'php' ? `<span><b>${x.dbLimit}</b> DB</span>` : ''}</div>
      </a>`).join('')}</div>`
      : `<div class="card empty-state">${icon('globe')}<h3>No websites yet</h3><p>${state.me.admin ? 'Create your first website from the admin area.' : 'An admin will create a website for you.'}</p>${state.me.admin ? `<a class="btn" href="#/admin/createweb">${icon('plus')}Create website</a>` : ''}</div>`);
  list.filter((x) => !x.suspended).forEach(async (x) => {
    const el = () => $(`[data-sst="${x.id}"]`);
    try { const st = await api('GET', `/api/sites/${x.id}/status`); if (el()) el().innerHTML = siteBadge(st); }
    catch { if (el()) el().innerHTML = '<span class="badge bad">node offline</span>'; }
  });
}

// ---------- single website ----------
async function pageSite(id, tab) {
  const x = await api('GET', `/api/sites/${id}`);
  state.siteCache[id] = x;
  renderSidebar();
  if (tab === 'database' && x.kind !== 'php') tab = 'files';
  const c = $('#content');
  const locked = x.suspended && !state.me.admin;
  c.innerHTML = `
    <div class="vm-bar"><div class="title">${siteIcon(x)}<div style="min-width:0"><h1>${esc(x.name)}</h1><div class="sub"><a href="${esc(siteUrl(x))}" target="_blank" rel="noopener">${esc(x.host)}</a> · ${esc(siteKind(x).long)}${x.php ? ' ' + esc(x.php) : ''}</div></div><span id="site-state">${siteBadge(null, x.suspended)}</span></div>
      <div class="btn-row">
        <a class="btn purple" href="${esc(siteUrl(x))}" target="_blank" rel="noopener">${icon('external')}Visit</a>
        <button class="btn ok" data-p="start" ${locked ? 'disabled' : ''}>${icon('play')}Start</button>
        <button class="btn stop" data-p="stop" ${locked ? 'disabled' : ''}>${icon('stop')}Stop</button>
        ${x.kind === 'php' ? `<button class="btn deep" data-p="restart" ${locked ? 'disabled' : ''}>${icon('refresh')}Restart</button>` : ''}
      </div></div>
    ${x.suspended ? `<div class="alert bad"><b>This website is suspended.</b> ${state.me.admin ? 'Visitors see a "suspended" page. Unsuspend it in Admin → Websites.' : 'Please contact an administrator.'}</div>` : ''}
    <div id="tab"></div>`;
  const ss = { st: null, listeners: [] };
  const poll = async () => {
    try {
      const st = await api('GET', `/api/sites/${id}/status`);
      const changed = !ss.st || ss.st.state !== st.state;
      ss.st = st;
      const el = $('#site-state');
      if (el) el.innerHTML = siteBadge(st, x.suspended) + (st.installing && st.step ? ` <span class="muted" style="font-size:12px">${esc(st.step)}…</span>` : '') + (st.error && !st.installing ? ` <span class="badge bad" title="${esc(st.error)}">error</span>` : '');
      ss.listeners.forEach((fn) => fn(st, changed));
    } catch { const el = $('#site-state'); if (el) el.innerHTML = '<span class="badge bad">node offline</span>'; }
  };
  const iv = setInterval(poll, 4000);
  state.cleanup.push(() => clearInterval(iv));
  $$('[data-p]', c).forEach((b) => (b.onclick = () => act(b, () => api('POST', `/api/sites/${id}/power`, { action: b.dataset.p }), { start: 'Website started', stop: 'Website stopped', restart: 'Restarting…' }[b.dataset.p]).then(() => setTimeout(poll, 600)).catch(() => {})));
  const t = $('#tab');
  await poll();
  const ctx = { onStatus: (fn) => ss.listeners.push(fn), get st() { return ss.st; }, poll };
  const fn = { files: siteFiles, usage: siteUsage, logs: siteLogs, database: siteDatabase, settings: siteSettings }[tab] || siteFiles;
  await fn(x, t, ctx);
}

function siteFiles(x, t, ctx) {
  return tabFiles(x, t, ctx, { base: `/api/sites/${x.id}`, start: '/public_html' }).then(() => {
    const card = $('.card', t);
    if (card) card.insertAdjacentHTML('afterbegin', `<div class="alert" style="margin:0 0 14px">Put your website in <b class="mono">public_html</b> - it is served at <a href="${esc(siteUrl(x))}" target="_blank" rel="noopener">${esc(x.host)}</a>.${x.kind === 'php' ? ' <span class="mono">.htaccess</span> rewrites work (WordPress, Laravel <span class="mono">public/</span> etc.).' : ''}</div>`);
  });
}

function siteUsage(x, t, ctx) {
  const php = x.kind === 'php';
  t.innerHTML = `<div class="grid g4" style="margin-bottom:18px">
    ${php ? `<div class="card stat"><div class="k">CPU</div><div class="v" id="u-cpu">0%</div><div class="s">${x.cpu} vCPU</div><canvas class="spark" id="sp-cpu"></canvas></div>
    <div class="card stat"><div class="k">Memory</div><div class="v" id="u-mem">0 B</div><div class="s" id="u-mem-s">of ${fmtBytes(x.memory * 1048576)}</div><canvas class="spark" id="sp-mem"></canvas></div>`
    : `<div class="card stat"><div class="k">Requests</div><div class="v" id="u-req">0</div><div class="s">this month</div></div>
    <div class="card stat"><div class="k">Type</div><div class="v" style="font-size:20px;margin-top:8px">Static</div><div class="s">served directly, no CPU limit needed</div></div>`}
    <div class="card stat"><div class="k">Disk</div><div class="v" id="u-disk">-</div><div class="s" id="u-disk-s">of ${x.disk} GB</div><div class="bar"><i id="u-disk-b" style="width:0"></i></div></div>
    <div class="card stat"><div class="k">Bandwidth</div><div class="v" id="u-bw">0 B</div><div class="s" id="u-bw-s">${x.bandwidth ? 'of ' + x.bandwidth + ' GB this month' : 'unlimited · this month'}</div><div class="bar"><i id="u-bw-b" style="width:0"></i></div></div>
  </div>
  <div class="card"><h3>Website</h3><p class="sub">Live numbers, updated every few seconds. Bandwidth counts everything served to visitors this month.</p>
    <dl class="kv"><dt>Status</dt><dd id="u-state">-</dd><dt>Type</dt><dd>${esc(siteKind(x).long)}${x.php ? ' · PHP ' + esc(x.php) : ''}</dd>
    <dt>Domain</dt><dd><a href="${esc(siteUrl(x))}" target="_blank" rel="noopener">${esc(x.host)}</a>${x.www ? ' + www' : ''}</dd>
    ${php ? '<dt>Requests</dt><dd id="u-req">-</dd><dt>Processes</dt><dd id="u-proc">-</dd><dt>Databases</dt><dd id="u-db">-</dd>' : ''}
    <dt>Node</dt><dd>${esc(x.nodeName)} · <span class="mono">${esc(x.nodeIp)}</span></dd><dt>Created</dt><dd>${fmtDate(x.createdAt)}</dd></dl></div>`;
  const hist = { cpu: [], mem: [] };
  const upd = (st) => {
    if (!st || !$('#u-disk')) return;
    $('#u-disk').textContent = fmtBytes(st.disk);
    const dp = pct(st.disk, st.diskLimit); $('#u-disk-b').style.width = dp + '%'; $('#u-disk-b').parentElement.classList.toggle('hot', dp > 85);
    $('#u-bw').textContent = fmtBytes(st.bandwidth);
    const bp = st.bandwidthLimit ? pct(st.bandwidth, st.bandwidthLimit) : 0; $('#u-bw-b').style.width = bp + '%'; $('#u-bw-b').parentElement.classList.toggle('hot', bp > 85);
    $('#u-req').textContent = (st.requests || 0).toLocaleString();
    $('#u-state').innerHTML = siteBadge(st, x.suspended) + (st.error ? ` <span class="muted">${esc(st.error)}</span>` : '');
    if (php) {
      const run = st.state === 'running';
      hist.cpu.push(run ? st.cpu : 0); hist.mem.push(run ? st.memory : 0);
      if (hist.cpu.length > 40) { hist.cpu.shift(); hist.mem.shift(); }
      $('#u-cpu').textContent = (run ? st.cpu : 0) + '%';
      $('#u-mem').textContent = fmtBytes(run ? st.memory : 0);
      $('#u-mem-s').textContent = `of ${fmtBytes(st.memLimit)} · ${pct(st.memory, st.memLimit).toFixed(0)}%`;
      $('#u-proc').textContent = st.processes || '-';
      $('#u-db').textContent = `${st.dbs} of ${st.dbLimit}`;
      sparkline($('#sp-cpu'), hist.cpu, 100); sparkline($('#sp-mem'), hist.mem, st.memLimit);
    }
  };
  upd(ctx.st);
  ctx.onStatus((st) => upd(st));
}

async function siteLogs(x, t) {
  let kind = 'access';
  t.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="btn-row"><button class="btn sm" data-k="access">${icon('globe')}Access log</button><button class="btn sm ghost" data-k="error">${icon('zap')}Error log</button></div>
      <button class="btn sm ghost" id="lg-re">${icon('refresh')}Refresh</button></div>
    <div id="lg"></div></div>`;
  const load = async () => {
    const box = $('#lg');
    box.innerHTML = '<p class="muted">Loading…</p>';
    let r; try { r = await api('GET', `/api/sites/${x.id}/logs?kind=${kind}`); } catch (e) { box.innerHTML = `<div class="alert bad" style="margin:0">${esc(e.message)}</div>`; return; }
    const sc = (s) => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'off' : 'ok');
    const table = (rows) => (rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th>Status</th><th>Request</th><th>IP</th><th>Size</th><th>Time taken</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td class="muted nowrap">${fmtDate(e.ts)}</td><td><span class="badge ${sc(e.status)}">${e.status}</span></td>
        <td class="mono" style="font-size:12.5px;word-break:break-all"><b>${esc(e.method)}</b> ${esc(e.uri)}${e.host && e.host !== x.host ? ` <span class="muted">(${esc(e.host)})</span>` : ''}</td>
        <td class="mono nowrap" style="font-size:12.5px" title="${esc(e.ua)}">${esc(e.ip)}</td><td class="muted nowrap">${fmtBytes(e.size)}</td><td class="muted nowrap">${e.ms} ms</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted" style="margin:0">Nothing logged yet.</p>');
    if (kind === 'access') box.innerHTML = `<p class="sub" style="margin-top:0">Latest ${r.entries.length} requests (newest first).</p>` + table(r.entries);
    else box.innerHTML = (x.kind === 'php' ? `<h3 style="margin:0 0 6px">PHP / Apache</h3><p class="sub">Errors and warnings printed by PHP and Apache.</p><pre class="logbox">${esc(r.text || 'No errors 🎉')}</pre>` : (r.text ? `<pre class="logbox">${esc(r.text)}</pre>` : ''))
      + `<h3 style="margin:18px 0 6px">Failed requests</h3><p class="sub">Requests that ended with a 4xx / 5xx status.</p>` + table(r.entries);
  };
  $$('[data-k]', t).forEach((b) => (b.onclick = () => { kind = b.dataset.k; $$('[data-k]', t).forEach((y) => y.classList.toggle('ghost', y !== b)); load(); }));
  $('#lg-re').onclick = load;
  load();
}

async function siteDatabase(x, t) {
  const locked = x.suspended && !state.me.admin;
  t.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  let r;
  try { r = await api('GET', `/api/sites/${x.id}/dbs`); } catch (e) { t.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
  const full = r.list.length >= r.limit;
  const prefix = x.siteName.slice(4) + '_';
  const secret = (v) => `<span class="secret mono" data-v="${esc(v)}">••••••••••</span><button class="icon-btn" data-reveal title="Show">${icon('key')}</button><button class="icon-btn" data-copy="${esc(v)}" title="Copy">${icon('copy')}</button>`;
  t.innerHTML = `<div class="grid g2" style="align-items:start">
    <div><div class="card"><h3>Create database</h3><p class="sub">A user with the same name and a strong password is created for it. Used <b>${r.list.length}/${r.limit}</b>.</p>
      <form id="dbf"><label class="f"><span>Database name</span><div style="display:flex;align-items:center;gap:6px"><span class="mono muted">${esc(prefix)}</span><input class="input mono" name="name" pattern="[a-z0-9_]{1,40}" placeholder="wordpress" required ${full || locked ? 'disabled' : ''}></div><small>a-z, 0-9 and _ only.</small></label>
      <button class="btn" ${full || locked ? 'disabled' : ''}>${icon('plus')}Create database</button></form>
      ${full ? `<div class="alert warn" style="margin:14px 0 0">${r.limit ? 'Database limit reached.' : 'This website has no databases in its plan - ask an admin.'}</div>` : ''}</div>
    <div class="card"><h3>Connect from PHP</h3><p class="sub">Use these settings in your app (e.g. <span class="mono">wp-config.php</span>).</p>
      <dl class="kv"><dt>Host</dt><dd class="mono">${esc(r.host)}</dd><dt>Port</dt><dd class="mono">${r.port}</dd><dt>Database / user</dt><dd>shown in the list</dd></dl>
      <a class="btn purple" style="margin-top:14px" href="${esc(r.pma)}" target="_blank" rel="noopener">${icon('external')}Open phpMyAdmin</a>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">Log in to phpMyAdmin with the database user + password. The first start can take a minute.</p></div></div>
    <div class="card"><h3>Databases</h3><p class="sub">${r.list.length} database${r.list.length === 1 ? '' : 's'}</p>
      <div class="list">${r.list.length ? r.list.map((d) => `<div class="item db-item">
        <div class="db-top"><div class="os-icon" style="width:38px;height:38px">${icon('db')}</div>
          <div class="info"><b class="mono">${esc(d.name)}</b><p>${fmtBytes(d.size)} · created ${fmtDate(d.createdAt)}</p></div>
          <button class="icon-btn" data-del="${esc(d.name)}" title="Delete database" style="color:var(--bad)" ${locked ? 'disabled' : ''}>${icon('trash')}</button></div>
        <div class="db-cred"><span class="muted">User</span><span class="mono">${esc(d.user)}</span><button class="icon-btn" data-copy="${esc(d.user)}" title="Copy">${icon('copy')}</button></div>
        <div class="db-cred"><span class="muted">Password</span>${secret(d.password)}</div>
        <div class="btn-row"><a class="btn sm ghost" href="${esc(r.pma)}" target="_blank" rel="noopener">${icon('external')}phpMyAdmin</a>
          <button class="btn sm ghost" data-pw="${esc(d.name)}" ${locked ? 'disabled' : ''}>${icon('refresh')}New password</button></div></div>`).join('') : '<div class="muted">No databases yet.</div>'}</div></div></div>`;
  const again = () => siteDatabase(x, t);
  $('#dbf').onsubmit = (e) => {
    e.preventDefault();
    act($('#dbf .btn'), () => api('POST', `/api/sites/${x.id}/dbs`, formData(e.target)), 'Database created (first one starts the database server - can take a minute)').then(again).catch(() => {});
  };
  $$('[data-reveal]', t).forEach((b) => (b.onclick = () => { const s = b.previousElementSibling; s.textContent = s.textContent.startsWith('•') ? s.dataset.v : '••••••••••'; }));
  $$('[data-copy]', t).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  $$('[data-pw]', t).forEach((b) => (b.onclick = async () => { if (await confirmBox('New password?', `A new password is generated for <b>${esc(b.dataset.pw)}</b>. Update your app config afterwards.`, 'Generate', 'deep')) act(b, () => api('POST', `/api/sites/${x.id}/dbs/${b.dataset.pw}/password`), 'Password changed').then(again).catch(() => {}); }));
  $$('[data-del]', t).forEach((b) => (b.onclick = async () => { if (await confirmBox(`Delete ${b.dataset.del}?`, 'The database, its user and all data are permanently deleted.')) act(b, () => api('DELETE', `/api/sites/${x.id}/dbs/${b.dataset.del}`), 'Database deleted').then(again).catch(() => {}); }));
}

// DNS records the user has to add at their domain provider (CloudPanel style)
function dnsRecordsHtml(x, sub, www) {
  const name = sub || dnsName(x), rows = [['A', name, x.nodeIp]];
  if (www && name === '@') rows.push(['A', 'www', x.nodeIp]);
  return `<div class="table-wrap"><table class="t"><thead><tr><th>Type</th><th>Name / Host</th><th>Value / Points to</th><th>TTL</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${r[0]}</b></td><td class="mono">${esc(r[1])}</td><td class="mono"><div class="copy" style="padding:4px 4px 4px 10px"><span>${esc(r[2])}</span><button type="button" class="icon-btn" data-copy="${esc(r[2])}">${icon('copy')}</button></div></td><td class="muted">Auto</td></tr>`).join('')}
  </tbody></table></div>`;
}
// Cloudflare Tunnel mode: public hostnames to add to the tunnel (same tunnel as the panel works)
function tunnelRowsHtml(domain, sub, www) {
  const rows = [[sub && sub !== '@' ? sub : '', domain]];
  if (www && (!sub || sub === '@')) rows.push(['www', domain]);
  return `<div class="table-wrap"><table class="t"><thead><tr><th>Subdomain</th><th>Domain</th><th>Type</th><th>URL</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="mono">${r[0] ? esc(r[0]) : '<span class="muted">(leave empty)</span>'}</td><td class="mono">${esc(r[1])}</td><td><b>HTTP</b></td><td class="mono nowrap"><div class="copy" style="padding:4px 4px 4px 10px;white-space:nowrap"><span>localhost:80</span><button type="button" class="icon-btn" data-copy="localhost:80">${icon('copy')}</button></div></td></tr>`).join('')}
  </tbody></table></div>`;
}
function domainStepsHtml(x, ssl, domain, sub, www) {
  if (ssl === 'cloudflare') return `<div class="dns-steps">
    <div><b>1.</b> Domain <span class="mono">${esc(domain)}</span> must be on <b>Cloudflare</b>. Open <b>Zero Trust → Networks → Tunnels</b>, pick the tunnel running on this server (the panel's tunnel works) → <b>Public Hostname → Add</b>:</div>
    ${tunnelRowsHtml(domain, sub, www)}
    <div><b>2.</b> Save - Cloudflare creates the DNS record and gives HTTPS automatically. No ports need to be open.</div>
    <div class="muted" style="font-size:12.5px">If an old A record exists for this name, delete it first. Service type must be <b>HTTP</b> (not HTTPS).</div></div>`;
  return `<div class="dns-steps">
    <div><b>1.</b> At your domain provider (Cloudflare, GoDaddy, Hostinger…) open <b>DNS</b> for <span class="mono">${esc(domain)}</span> and add:</div>
    ${dnsRecordsHtml(x, sub, www)}
    <div><b>2.</b> Wait a few minutes. Below should turn green - then HTTPS works. Ports <b>80 + 443</b> must be open on the server.</div>
    <div class="muted" style="font-size:12.5px">Cloudflare: use <b>DNS only</b> (grey cloud) until SSL is active. If you keep the orange cloud, set SSL/TLS mode to <b>Full</b>.</div></div>`;
}
const SSL_PICK = (cur, attrs = '') => `<div class="pick-grid" data-sslpick style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:12px">
  <button type="button" class="pick ${cur !== 'cloudflare' ? 'sel' : ''}" data-ssl="auto" ${attrs}><b>Let's Encrypt</b><span>Server needs ports 80 + 443 open</span></button>
  <button type="button" class="pick ${cur === 'cloudflare' ? 'sel' : ''}" data-ssl="cloudflare" ${attrs}><b>Cloudflare Tunnel</b><span>No open ports needed (LXC / NAT VPS)</span></button></div>`;
async function siteSettings(x, t) {
  const locked = x.suspended && !state.me.admin;
  t.innerHTML = `<div class="grid g2" style="align-items:start">
    <div><div class="card"><h3>Domain</h3><p class="sub">${x.ssl === 'cloudflare' ? 'HTTPS by <b>Cloudflare Tunnel</b> - connect the domain in your tunnel.' : 'Point your domain to this server, then SSL (HTTPS) is issued automatically (Let\'s Encrypt).'}</p>
      ${domainStepsHtml(x, x.ssl, x.domain, x.sub, x.www)}
      <div id="dns-check" class="list" style="margin-top:14px"><div class="muted">Checking DNS and SSL…</div></div>
      <button class="btn sm ghost" id="dns-re" style="margin-top:10px">${icon('refresh')}Check again</button></div>
    </div>
    <div><div class="card"><h3>Change domain</h3><p class="sub">Type <b>@</b> as subdomain for the main domain (example.com), or a name like <b>blog</b> for blog.example.com.</p>
      <form id="dm"><label class="f"><span>Domain</span><input class="input mono" name="domain" value="${esc(x.domain)}" placeholder="example.com" required ${locked ? 'disabled' : ''}></label>
      <label class="f"><span>Subdomain</span><input class="input mono" name="sub" value="${esc(x.sub || '@')}" placeholder="@" required ${locked ? 'disabled' : ''}><small id="dm-full"></small></label>
      <label class="check" id="dm-www-wrap"><input type="checkbox" name="www" ${x.www ? 'checked' : ''} ${locked ? 'disabled' : ''}> Also serve <span class="mono">www.</span> (redirects to the main domain)</label>
      <div class="f-label" style="margin-top:14px">SSL / HTTPS</div>${SSL_PICK(x.ssl, locked ? 'disabled' : '')}
      <button class="btn" style="margin-top:4px" ${locked ? 'disabled' : ''}>${icon('globe')}Save domain</button></form></div>
    <div class="card"><h3>Plan</h3><p class="sub">Limits set by the administrator.</p>
      <dl class="kv"><dt>Type</dt><dd>${esc(siteKind(x).long)}${x.php ? ' · PHP ' + esc(x.php) : ''}</dd>${x.kind === 'php' ? `<dt>CPU</dt><dd>${x.cpu} vCPU</dd><dt>Memory</dt><dd>${fmtBytes(x.memory * 1048576)}</dd><dt>Databases</dt><dd>${x.dbLimit}</dd>` : ''}
      <dt>Disk</dt><dd>${x.disk} GB</dd><dt>Bandwidth</dt><dd>${x.bandwidth ? x.bandwidth + ' GB / month' : 'unlimited'}</dd><dt>Owner</dt><dd>${esc(x.ownerName)}</dd><dt>Node</dt><dd>${esc(x.nodeName)}</dd></dl></div></div></div>`;
  $$('[data-copy]', t).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  const f = $('#dm');
  const syncForm = () => {
    const d = f.domain.value.trim().toLowerCase(), s = f.sub.value.trim().toLowerCase() || '@';
    $('#dm-full').innerHTML = d ? `Website address: <b class="mono">${esc(s === '@' ? d : s + '.' + d)}</b>` : '';
    $('#dm-www-wrap').style.display = s === '@' ? '' : 'none';
  };
  f.oninput = syncForm; syncForm();
  let ssl = x.ssl || 'auto';
  $$('[data-ssl]', f).forEach((b) => (b.onclick = () => { ssl = b.dataset.ssl; $$('[data-ssl]', f).forEach((y) => y.classList.toggle('sel', y === b)); }));
  f.onsubmit = (e) => {
    e.preventDefault();
    act($('button.btn', f), () => api('PUT', `/api/sites/${x.id}/domain`, { domain: f.domain.value, sub: f.sub.value || '@', www: f.www.checked, ssl }), ssl === 'cloudflare' ? 'Saved - add the hostname to your Cloudflare Tunnel (left)' : 'Domain saved - add the DNS record shown on the left')
      .then((nx) => { Object.assign(x, nx); state.siteCache[x.id] = nx; siteSettings(x, t); const sub = $('.vm-bar .sub a'); if (sub) { sub.textContent = nx.host; sub.href = siteUrl(nx); } }).catch(() => {});
  };
  const check = async () => {
    const box = $('#dns-check'); if (!box) return;
    let r; try { r = await api('GET', `/api/sites/${x.id}/domain-check`); } catch (e) { box.innerHTML = `<div class="alert bad" style="margin:0">${esc(e.message)}</div>`; return; }
    const row = (ok, title, text) => `<div class="item"><span class="badge ${ok === true ? 'ok' : ok === null ? 'warn' : 'bad'}" style="min-width:66px;justify-content:center">${ok === true ? 'OK' : ok === null ? 'waiting' : 'not yet'}</span><div class="info"><b>${title}</b><p>${text}</p></div></div>`;
    const dnsText = (h) => (h.ips.length ? `${esc(h.host)} → <span class="mono">${esc(h.ips.join(', '))}</span>${h.cloudflare ? ' (Cloudflare proxy)' : h.ok ? '' : ` - should be <span class="mono">${esc(r.ip)}</span>`}` : `${esc(h.host)}: ${esc(h.error || 'no record')}`);
    if (r.mode === 'cloudflare') {
      const cfText = (h) => (h.cloudflare ? `${esc(h.host)} → Cloudflare ✓` : h.ips.length ? `${esc(h.host)} → <span class="mono">${esc(h.ips.join(', '))}</span> - not through Cloudflare yet` : `${esc(h.host)}: not connected yet - add it to the tunnel`);
      box.innerHTML = row(r.main.ok, 'Domain on Cloudflare', cfText(r.main)) + (r.www ? row(r.www.ok, 'www on Cloudflare', cfText(r.www)) : '')
        + row(r.local.ok, 'Website on this server', r.local.ok ? `Answers on <span class="mono">localhost:80</span> (HTTP ${r.local.status})` : `No answer on localhost:80 (${esc(r.local.error || r.local.status)})`)
        + row(r.ssl.active ? true : r.local.ok ? null : false, 'HTTPS', r.ssl.active ? 'Provided by Cloudflare' : 'Works as soon as the hostname is added to the tunnel')
        + (r.caddyError ? `<div class="alert bad" style="margin:0">Web server: ${esc(r.caddyError)}</div>` : '');
      return;
    }
    box.innerHTML = row(r.main.ok, 'DNS', dnsText(r.main)) + (r.www ? row(r.www.ok, 'DNS (www)', dnsText(r.www)) : '')
      + row(r.ssl.active ? true : r.main.ok ? null : false, 'SSL certificate', r.ssl.active ? `Active · ${esc(r.ssl.issuer)} · valid until ${fmtDate(r.ssl.validTo)}` : r.main.ok ? 'Being issued automatically - usually under a minute after DNS is correct.' : 'Issued automatically once DNS points to this server.')
      + (r.caddyError ? `<div class="alert bad" style="margin:0">Web server: ${esc(r.caddyError)}</div>` : '');
  };
  $('#dns-re').onclick = check;
  check();
  const iv = setInterval(check, 20000);
  state.cleanup.push(() => clearInterval(iv));
}

// ---------- admin: create website ----------
async function pageCreateSite() {
  const [nodes, users] = await Promise.all([api('GET', '/api/admin/nodes'), api('GET', '/api/admin/users')]);
  const c = $('#content');
  const ok = nodes.filter((n) => n.system && n.system.docker);
  if (!nodes.length) { c.innerHTML = head('Create website', '') + `<div class="card empty-state">${icon('node')}<h3>No nodes yet</h3><p>Add a node first.</p><a class="btn" href="#/admin/nodes">Go to nodes</a></div>`; return; }
  c.innerHTML = head('Create website', 'Static HTML or PHP · free SSL · databases + phpMyAdmin for PHP') + `
  <form id="cw"><div class="grid g2" style="align-items:start">
    <div class="card"><h3>Basics</h3><p class="sub">Owner, server and type.</p>
      <label class="f"><span>Website name</span><input class="input" name="name" maxlength="40" placeholder="My shop" required></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === state.me.id ? 'selected' : ''}>${esc(u.username)}${u.admin ? ' (admin)' : ''}</option>`).join('')}</select></label>
      <label class="f"><span>Node</span><select class="input" name="nodeId">${nodes.map((n) => `<option value="${n.id}" ${n.system && n.system.docker ? '' : 'disabled'}>${esc(n.name)} · ${esc(n.ip)}${!n.online ? ' (offline)' : n.system.docker ? '' : ' (needs Docker)'}</option>`).join('')}</select>
        ${ok.length ? '' : '<small style="color:var(--bad)">No node has Docker - website hosting runs on Docker.</small>'}</label>
      <div class="f-label">Type</div>
      <div class="pick-grid" id="kinds" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:14px">
        <button type="button" class="pick sel" data-kind="static"><b>Static HTML</b><span>HTML, CSS, JS - super fast</span></button>
        <button type="button" class="pick" data-kind="php"><b>PHP (dynamic)</b><span>WordPress, Laravel, any PHP + MySQL</span></button>
      </div><input type="hidden" name="kind" value="static">
      <label class="f php-only" style="display:none"><span>PHP version</span><select class="input" name="php"><option>8.4</option><option selected>8.3</option><option>8.2</option><option>8.1</option></select></label>
    </div>
    <div class="card"><h3>Domain</h3><p class="sub">Like CloudPanel: enter the domain, and <b>@</b> for the main domain or a subdomain name.</p>
      <label class="f"><span>Domain</span><input class="input mono" name="domain" placeholder="example.com" required></label>
      <label class="f"><span>Subdomain</span><input class="input mono" name="sub" value="@" required><small id="cw-full">@ = main domain · blog = blog.example.com</small></label>
      <label class="check" id="cw-www"><input type="checkbox" name="www" checked> Also serve <span class="mono">www.</span> (redirects to the main domain)</label>
      <div class="f-label" style="margin-top:14px">SSL / HTTPS</div>${SSL_PICK('auto')}
      <div id="cw-dns" style="margin-top:6px"></div>
      <h3 style="margin-top:20px">Resources</h3><p class="sub">Limits for this website.</p>
      <div class="grid g2" style="gap:12px">
        <label class="f php-only" style="display:none"><span>vCPU</span><input class="input" type="number" name="cpu" min="1" max="32" value="1"></label>
        <label class="f php-only" style="display:none"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="128" step="128" value="512"></label>
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="5"></label>
        <label class="f"><span>Bandwidth (GB / month)</span><input class="input" type="number" name="bandwidth" min="0" value="100"><small>0 = unlimited</small></label>
        <label class="f php-only" style="display:none"><span>Databases</span><input class="input" type="number" name="dbLimit" min="0" max="100" value="3"></label>
      </div>
      <button class="btn lg block" style="margin-top:16px" ${ok.length ? '' : 'disabled'}>${icon('plus')}Create website</button>
    </div></div></form>`;
  const f = $('#cw');
  const nodeSel = f.nodeId;
  if (nodeSel.selectedOptions[0] && nodeSel.selectedOptions[0].disabled && ok[0]) nodeSel.value = ok[0].id;
  $$('[data-kind]', f).forEach((b) => (b.onclick = () => {
    $$('[data-kind]', f).forEach((y) => y.classList.toggle('sel', y === b));
    f.kind.value = b.dataset.kind;
    $$('.php-only', f).forEach((el) => { el.style.display = b.dataset.kind === 'php' ? '' : 'none'; });
  }));
  const sync = () => {
    const n = nodes.find((y) => y.id === nodeSel.value) || {};
    const d = f.domain.value.trim().toLowerCase() || 'example.com', s = f.sub.value.trim().toLowerCase() || '@';
    $('#cw-full').innerHTML = `Website address: <b class="mono">${esc(s === '@' ? d : s + '.' + d)}</b>`;
    $('#cw-www').style.display = s === '@' ? '' : 'none';
    $('#cw-dns').innerHTML = cwSsl === 'cloudflare'
      ? `<div class="f-label">Add to your Cloudflare Tunnel (Public Hostname)</div>` + tunnelRowsHtml(d, s, s === '@' && f.www.checked)
      : `<div class="f-label">DNS record to add at the domain provider</div>` + dnsRecordsHtml({ nodeIp: n.ip || 'NODE_IP', sub: s }, s, s === '@' && f.www.checked);
    $$('[data-copy]', f).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  };
  let cwSsl = 'auto';
  $$('[data-ssl]', f).forEach((b) => (b.onclick = () => { cwSsl = b.dataset.ssl; $$('[data-ssl]', f).forEach((y) => y.classList.toggle('sel', y === b)); sync(); }));
  f.oninput = sync; nodeSel.onchange = sync; sync();
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = formData(f); body.www = f.www.checked; body.ssl = cwSsl;
    act($('.btn.lg', f), () => api('POST', '/api/admin/sites', body), 'Website created - add the DNS record, SSL follows automatically')
      .then((x) => { location.hash = `#/site/${x.id}/settings`; }).catch(() => {});
  };
}

// ---------- admin: all websites ----------
async function pageAdminSites() {
  const list = await api('GET', '/api/admin/sites');
  $('#content').innerHTML = head('Websites', `${list.length} total`, `<a class="btn" href="#/admin/createweb">${icon('plus')}Create website</a>`) +
    `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Website</th><th>Owner</th><th>Type</th><th>Node</th><th>Limits</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((x) => `<tr>
      <td><a href="#/site/${x.id}/files"><b>${esc(x.name)}</b></a><div class="mono" style="font-size:12px"><a href="${esc(siteUrl(x))}" target="_blank" rel="noopener">${esc(x.host)}</a></div></td>
      <td>${esc(x.ownerName)}</td><td><span class="badge">${siteKind(x).label}</span>${x.php ? ` <span class="muted">${esc(x.php)}</span>` : ''}</td><td>${esc(x.nodeName)}</td>
      <td class="nowrap">${x.kind === 'php' ? `${x.cpu} vCPU · ${fmtBytes(x.memory * 1048576)} · ` : ''}${x.disk} GB · ${x.bandwidth ? x.bandwidth + ' GB/mo' : '∞'}${x.kind === 'php' ? ` · ${x.dbLimit} DB` : ''}</td>
      <td data-wst="${x.id}">${x.suspended ? siteBadge(null, true) : '<span class="badge off">…</span>'}</td>
      <td class="right nowrap"><a class="btn sm" href="#/site/${x.id}/files">Manage</a>
        <button class="btn sm ghost" data-susp="${x.id}" data-on="${x.suspended ? '' : 1}">${icon('pause')}${x.suspended ? 'Unsuspend' : 'Suspend'}</button>
        <button class="icon-btn" data-edit="${x.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-del="${x.id}" title="Delete" style="color:var(--bad)">${icon('trash')}</button></td></tr>`).join('') : '<tr><td colspan="7" class="muted">No websites yet.</td></tr>'}
    </tbody></table></div></div>`;
  list.filter((x) => !x.suspended).forEach(async (x) => { const el = () => $(`[data-wst="${x.id}"]`); try { const st = await api('GET', `/api/sites/${x.id}/status`); if (el()) el().innerHTML = siteBadge(st); } catch { if (el()) el().innerHTML = '<span class="badge bad">offline</span>'; } });
  $$('[data-susp]').forEach((b) => (b.onclick = async () => {
    const on = !!b.dataset.on;
    if (on && !(await confirmBox('Suspend this website?', 'Visitors will see a "suspended" page and the owner cannot manage it.', 'Suspend'))) return;
    act(b, () => api('POST', `/api/admin/sites/${b.dataset.susp}/suspend`, { suspended: on }), on ? 'Suspended' : 'Unsuspended').then(render).catch(() => {});
  }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    const x = list.find((y) => y.id === b.dataset.del);
    if (!(await confirmBox(`Delete ${x.name}?`, `All files${x.kind === 'php' ? ', databases' : ''} and logs of <b>${esc(x.host)}</b> are permanently deleted.`))) return;
    try { await act(b, () => api('DELETE', `/api/admin/sites/${x.id}`), 'Website deleted'); render(); }
    catch (e) { if (/force/.test(e.message) && (await confirmBox('Force delete?', 'The node could not be reached. Remove the website from the panel anyway?', 'Force delete'))) act(b, () => api('DELETE', `/api/admin/sites/${x.id}?force=1`), 'Removed').then(render).catch(() => {}); }
  }));
  $$('[data-edit]').forEach((b) => (b.onclick = async () => {
    const x = list.find((y) => y.id === b.dataset.edit);
    const users = await api('GET', '/api/admin/users');
    modal({ title: 'Edit ' + x.name, body: `<form id="ew">
      <label class="f"><span>Name</span><input class="input" name="name" value="${esc(x.name)}" maxlength="40"></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === x.ownerId ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}</select></label>
      <div class="grid g2" style="gap:12px">
        ${x.kind === 'php' ? `<label class="f"><span>vCPU</span><input class="input" type="number" name="cpu" min="1" value="${x.cpu}"></label><label class="f"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="128" step="128" value="${x.memory}"></label>` : ''}
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="${x.disk}"></label>
        <label class="f"><span>Bandwidth (GB/mo, 0 = ∞)</span><input class="input" type="number" name="bandwidth" min="0" value="${x.bandwidth}"></label>
        ${x.kind === 'php' ? `<label class="f"><span>Databases</span><input class="input" type="number" name="dbLimit" min="0" value="${x.dbLimit}"></label>` : ''}
      </div></form>`,
      footer: '<button class="btn ghost" data-close>Cancel</button><button class="btn" form="ew">Save</button>',
      onMount: (el, close) => { $('#ew', el).onsubmit = (e) => { e.preventDefault(); act(null, () => api('PATCH', `/api/admin/sites/${x.id}`, formData(e.target)), 'Saved').then(() => { close(); render(); }).catch(() => {}); }; } });
  }));
}
