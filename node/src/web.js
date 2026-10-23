// AVM web hosting: static HTML + PHP websites with automatic SSL (Caddy), MariaDB + phpMyAdmin.
// Everything runs on Docker:
//   avm-caddy     host network, ports 80/443, automatic HTTPS, serves static sites directly
//   avm-web-xxxx  one PHP (Apache) container per PHP site on the avm-docker network
//   avm-mariadb   shared database server       avm-pma  phpMyAdmin (opened through the panel)
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const http = require('http');
const tls = require('tls');
const dns = require('dns').promises;
const crypto = require('crypto');
const { execFile } = require('child_process');

const SITE_RE = /^web-[a-f0-9]{8}$/;
const HOST_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1'];
const CF_RANGES = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];

module.exports = function web(ctx) {
  const { app, docker, cfg, S, save, err, wrap, cleanPath, ensureDockerNet, multer } = ctx;
  const ROOT = cfg.webRoot || '/var/lib/avm-web';
  const SITES = path.join(ROOT, 'sites'), LOGS = path.join(ROOT, 'logs'), CADDY_DIR = path.join(ROOT, 'caddy');
  const IMG = { caddy: cfg.caddyImage || 'caddy:2', mariadb: cfg.mariadbImage || 'mariadb:11', pma: cfg.pmaImage || 'phpmyadmin:5' };
  const PHP_BASE = (v) => (cfg.phpBaseImage || 'php:{v}-apache').replace('{v}', v);
  const WWW_UID = 33; // www-data in the php:*-apache images
  S.sites = S.sites || {};
  S.web = S.web || {};
  const rt = {}; // name -> { installing, step, error }
  const cache = { du: {}, ssl: {}, cpu: {} };

  // ---------- small helpers ----------
  const sh = (bin, args, opts = {}) => new Promise((resolve) => {
    const c = execFile(bin, args, { maxBuffer: 32 * 1048576, timeout: opts.timeout || 60000 }, (e, out, er) => resolve({ ok: !e, out: String(out || ''), err: String(er || ''), code: e && e.code }));
    c.stdin.end(opts.input);
  });
  const ctName = (name) => 'avm-' + name;
  const siteDir = (name) => path.join(SITES, name);
  const site = (req) => {
    const n = req.params.name;
    if (!SITE_RE.test(n) || !S.sites[n]) throw err(404, 'Website not found on this node');
    return n;
  };
  const randPw = (n = 20) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
  const month = () => new Date().toISOString().slice(0, 7);
  async function needDocker() { if (!(await docker.available()).ok) throw err(400, 'Website hosting needs Docker on this node'); }
  async function haveImage(img) { return docker.api('GET', `/images/${encodeURIComponent(img)}/json`).then(() => true).catch(() => false); }
  async function pullIfMissing(img) { if (!(await haveImage(img))) await docker.run(['pull', img], { timeout: 30 * 60000 }); }
  async function ctState(n) { try { const j = await docker.inspect(n); return j.State.Status; } catch { return null; } }
  async function subnetIp(last) { const n = await ensureDockerNet(); const sub = (n.IPAM.Config[0].Subnet || '10.89.0.0/24').split('/')[0]; return sub.split('.').slice(0, 3).join('.') + '.' + last; }

  // ---------- Caddy (automatic HTTPS) ----------
  function caddyfile() {
    const g = ['{', '\tadmin localhost:2019'];
    if (cfg.acmeEmail) g.push('\temail ' + cfg.acmeEmail);
    // requests from cloudflared / local proxies: keep the visitor IP and the https scheme
    g.push('\tservers {\n\t\ttrusted_proxies static private_ranges\n\t\tclient_ip_headers Cf-Connecting-Ip X-Forwarded-For\n\t}');
    g.push('}', '');
    const out = [g.join('\n')];
    for (const [name, s] of Object.entries(S.sites)) {
      if (!HOST_RE.test(s.host)) continue;
      const r = rt[name] || {};
      const body = [];
      body.push(`\tlog {\n\t\toutput file /var/log/avm-web/${name}.log {\n\t\t\troll_size 20MiB\n\t\t\troll_keep 2\n\t\t}\n\t\tformat json\n\t}`);
      body.push('\tencode zstd gzip');
      body.push('\theader -Server');
      if (s.suspended) body.push('\trespond "This website is suspended." 503');
      else if (s.overLimit) body.push('\trespond "Bandwidth limit exceeded for this month." 509');
      else if (s.stopped) body.push('\trespond "This website is stopped." 503');
      else if (r.installing || r.error) body.push('\trespond "This website is being set up. Please check back in a minute." 503');
      else if (s.kind === 'static') body.push(`\troot * /srv/avm-web/sites/${name}/public_html\n\tfile_server {\n\t\thide .htaccess .git .env\n\t}`);
      else body.push(`\treverse_proxy ${s.privateIp}:80`);
      // ssl "cloudflare": plain HTTP on :80 for Cloudflare Tunnel (Cloudflare does HTTPS) - no Let's Encrypt needed
      const pre = s.ssl === 'cloudflare' ? 'http://' : '';
      out.push(`${pre}${s.host} {\n${body.join('\n')}\n}\n`);
      if (s.www) out.push(`${pre}www.${s.host} {\n\tredir https://${s.host}{uri} permanent\n}\n`);
    }
    return out.join('\n');
  }
  let caddyChain = Promise.resolve();
  let caddyError = null;
  function reloadCaddy() {
    caddyChain = caddyChain.then(async () => {
      try {
        if (!Object.keys(S.sites).length && !(await ctState('avm-caddy'))) return; // nothing to serve yet
        await fsp.mkdir(CADDY_DIR, { recursive: true });
        await fsp.mkdir(LOGS, { recursive: true });
        await fsp.writeFile(path.join(CADDY_DIR, 'Caddyfile.tmp'), caddyfile());
        await fsp.rename(path.join(CADDY_DIR, 'Caddyfile.tmp'), path.join(CADDY_DIR, 'Caddyfile'));
        await ensureCaddy();
        const r = await sh(docker.BIN, ['exec', 'avm-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--force']);
        caddyError = r.ok ? null : (r.err || r.out).trim().split('\n').slice(-3).join(' ');
        if (caddyError) console.error('[avm-web] caddy reload failed:', caddyError);
      } catch (e) { caddyError = e.message; console.error('[avm-web] caddy:', e.message); }
    });
    return caddyChain;
  }
  let ufwDone = false;
  async function openWebPorts() { // Let's Encrypt + visitors need 80/443 open in ufw
    if (ufwDone) return;
    const u = await sh('ufw', ['status']);
    if (u.ok && /Status: active/i.test(u.out)) {
      for (const r of ['80/tcp', '443/tcp', '443/udp']) await sh('ufw', ['allow', r, 'comment', 'AVM web hosting']);
      console.log('[avm-web] ufw: opened 80/tcp, 443/tcp, 443/udp for websites');
    }
    ufwDone = true;
  }
  async function ensureCaddy() {
    await openWebPorts();
    const st = await ctState('avm-caddy');
    if (st === 'running') return;
    if (st) { await docker.run(['start', 'avm-caddy']); await new Promise((r) => setTimeout(r, 1500)); return; }
    await pullIfMissing(IMG.caddy);
    await fsp.mkdir(SITES, { recursive: true });
    await docker.run(['run', '-d', '--name', 'avm-caddy', '--network', 'host', '--restart', 'unless-stopped', '--label', 'avm=1',
      '-v', `${CADDY_DIR}:/etc/caddy`, '-v', `${SITES}:/srv/avm-web/sites:ro`, '-v', `${LOGS}:/var/log/avm-web`,
      '-v', 'avm-caddy-data:/data', '-v', 'avm-caddy-config:/config', IMG.caddy, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
    await new Promise((r) => setTimeout(r, 2000));
    if ((await ctState('avm-caddy')) !== 'running') {
      const l = await sh(docker.BIN, ['logs', '--tail', '20', 'avm-caddy']);
      throw new Error('Web server (Caddy) did not start - are ports 80/443 already used? ' + (l.err || l.out).trim().split('\n').pop());
    }
  }

  // ---------- PHP image + container ----------
  const building = {};
  const PHP_IMAGE_REV = 2; // bump when the Dockerfile below changes -> sites are moved to the new image on restart
  function phpImage(ver) { return `avm-php:${ver}-r${PHP_IMAGE_REV}`; }
  async function buildPhp(ver) {
    if (await haveImage(phpImage(ver))) return;
    if (building[ver]) return building[ver];
    const df = `FROM ${PHP_BASE(ver)}
RUN curl -sSLf -o /usr/local/bin/install-php-extensions https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions \\
 && chmod +x /usr/local/bin/install-php-extensions \\
 && install-php-extensions mysqli pdo_mysql gd zip intl opcache exif bcmath
RUN a2enmod rewrite remoteip headers \\
 && printf 'RemoteIPHeader X-Forwarded-For\\nRemoteIPInternalProxy 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1\\nSetEnvIf X-Forwarded-Proto https HTTPS=on\\nServerTokens Prod\\nServerSignature Off\\n' > /etc/apache2/conf-enabled/avm.conf \\
 && sed -ri '/<Directory \\/var\\/www\\/>/,/<\\/Directory>/ s/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf \\
 && printf 'upload_max_filesize=128M\\npost_max_size=128M\\nmemory_limit=256M\\nmax_execution_time=120\\nexpose_php=Off\\nlog_errors=On\\nerror_log=/dev/stderr\\n' > /usr/local/etc/php/conf.d/avm.ini
`;
    building[ver] = docker.run(['build', '-t', phpImage(ver), '-'], { input: df, timeout: 40 * 60000 }).finally(() => { delete building[ver]; });
    return building[ver];
  }
  async function createPhpContainer(name) {
    const s = S.sites[name];
    await docker.run(['rm', '-f', ctName(name)]).catch(() => {});
    await docker.run(['create', '--name', ctName(name), '--hostname', s.host.slice(0, 63), '--network', ctx.DOCKER_NET, '--ip', s.privateIp,
      `--cpus=${s.cpu}`, `--memory=${s.memory}m`, `--memory-swap=${s.memory}m`, '--pids-limit=512', '--restart', 'unless-stopped',
      '--label', 'avm=1', '--label', `avm.site=${name}`, '-v', `${path.join(siteDir(name), 'public_html')}:/var/www/html`, phpImage(s.php)]);
  }

  // ---------- build a site (background) ----------
  async function buildSite(name) {
    const s = S.sites[name];
    const r = rt[name] = { installing: true, step: 'Preparing folders', error: null };
    try {
      const pub = path.join(siteDir(name), 'public_html');
      await fsp.mkdir(pub, { recursive: true });
      await fsp.mkdir(LOGS, { recursive: true });
      const idx = s.kind === 'php' ? 'index.php' : 'index.html';
      if (!fs.readdirSync(pub).length) await fsp.writeFile(path.join(pub, idx), welcomePage(s));
      if (s.kind === 'php') {
        await sh('chown', ['-R', `${WWW_UID}:${WWW_UID}`, siteDir(name)]);
        r.step = `Building PHP ${s.php} (first time only, can take a few minutes)`;
        await buildPhp(s.php);
        r.step = 'Starting PHP container';
        await createPhpContainer(name);
        if (!s.stopped && !s.suspended) await docker.run(['start', ctName(name)], { timeout: 120000 });
      }
      r.step = 'Starting web server + SSL';
      rt[name] = { installing: false, error: null };
      await reloadCaddy();
    } catch (e) {
      console.error('[avm-web] create failed', name, e.message);
      rt[name] = { installing: false, error: e.message };
      reloadCaddy();
    }
  }
  function welcomePage(s) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${s.host}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:linear-gradient(140deg,#e8f8fc,#bfe9f3);color:#063845}
.c{text-align:center;padding:40px}h1{font-size:34px;margin:0 0 8px}p{color:#3d6b78;margin:4px 0}code{background:#fff;padding:2px 8px;border-radius:6px}</style></head>
<body><div class="c"><h1>${s.host}</h1><p>This website is live and served over HTTPS.</p><p>Upload your files to <code>public_html</code> in the panel's File manager.</p>${s.kind === 'php' ? '<p>PHP <?php echo PHP_VERSION; ?> is ready.</p>' : ''}</div></body></html>\n`;
    return html;
  }

  // ---------- create / update / delete ----------
  app.post('/api/sites', wrap(async (req, res) => {
    await needDocker();
    const b = req.body;
    if (!SITE_RE.test(b.name || '')) throw err(400, 'bad site name');
    if (S.sites[b.name]) throw err(409, 'Website already exists');
    const kind = b.kind === 'php' ? 'php' : 'static';
    const host = String(b.host || '').toLowerCase();
    if (!HOST_RE.test(host)) throw err(400, 'Bad domain name');
    if (Object.values(S.sites).some((x) => x.host === host)) throw err(409, 'This domain is already used on this node');
    const php = kind === 'php' ? (PHP_VERSIONS.includes(b.php) ? b.php : PHP_VERSIONS[1]) : null;
    const s = { kind, php, host, www: !!b.www, ssl: b.ssl === 'cloudflare' ? 'cloudflare' : 'auto', cpu: Math.max(1, +b.cpu || 1), memory: Math.max(128, +b.memory || 512), disk: Math.max(1, +b.disk || 5),
      bandwidth: Math.max(0, +b.bandwidth || 0), dbLimit: kind === 'php' ? Math.max(0, +b.dbLimit || 0) : 0, stopped: false, suspended: false,
      createdAt: Date.now(), bw: { month: month(), bytes: 0, requests: 0, offset: 0 }, dbs: {} };
    if (kind === 'php') s.privateIp = await ctx.allocIp('docker');
    S.sites[b.name] = s; save();
    buildSite(b.name);
    res.json({ ok: true, privateIp: s.privateIp || null });
  }));

  app.patch('/api/sites/:name', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name], b = req.body;
    if (b.cpu) s.cpu = Math.max(1, +b.cpu);
    if (b.memory) s.memory = Math.max(128, +b.memory);
    if (b.disk) s.disk = Math.max(1, +b.disk);
    if (b.bandwidth !== undefined) { s.bandwidth = Math.max(0, +b.bandwidth || 0); s.overLimit = s.bandwidth > 0 && s.bw.bytes >= s.bandwidth * 1073741824; }
    if (b.dbLimit !== undefined && s.kind === 'php') s.dbLimit = Math.max(0, +b.dbLimit || 0);
    if (s.kind === 'php' && (b.cpu || b.memory)) await docker.run(['update', `--cpus=${s.cpu}`, `--memory=${s.memory}m`, `--memory-swap=${s.memory}m`, ctName(name)]).catch(() => {});
    save(); await reloadCaddy();
    res.json({ ok: true });
  }));

  app.put('/api/sites/:name/domain', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name];
    const host = String(req.body.host || '').toLowerCase();
    if (!HOST_RE.test(host)) throw err(400, 'Bad domain name');
    if (Object.entries(S.sites).some(([n, x]) => n !== name && x.host === host)) throw err(409, 'This domain is already used on this node');
    s.host = host; s.www = !!req.body.www; delete cache.ssl[name];
    if (req.body.ssl) s.ssl = req.body.ssl === 'cloudflare' ? 'cloudflare' : 'auto';
    save(); await reloadCaddy();
    res.json({ ok: true, caddyError });
  }));

  app.post('/api/sites/:name/power', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name], a = req.body.action;
    if (rt[name] && rt[name].installing) throw err(409, 'Website is still being set up, please wait');
    if (!['start', 'stop', 'restart'].includes(a)) throw err(400, 'bad action');
    if (s.kind === 'php') {
      if (rt[name] && rt[name].error && a !== 'stop') { buildSite(name); return res.json({ ok: true, rebuilding: true }); }
      if (a === 'stop') await docker.run(['stop', '-t', '15', ctName(name)], { timeout: 60000 }).catch(() => {});
      else await docker.run([a === 'start' ? 'start' : 'restart', ctName(name)], { timeout: 90000 });
    }
    s.stopped = a === 'stop'; save(); await reloadCaddy();
    res.json({ ok: true });
  }));

  app.post('/api/sites/:name/suspend', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name];
    s.suspended = !!req.body.suspended;
    if (s.kind === 'php') await docker.run([s.suspended ? 'stop' : 'start', ctName(name)], { timeout: 60000 }).catch(() => {});
    save(); await reloadCaddy();
    res.json({ ok: true });
  }));

  app.delete('/api/sites/:name', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name];
    if (s.kind === 'php') {
      await docker.run(['rm', '-f', ctName(name)]).catch(() => {});
      for (const db of Object.keys(s.dbs || {})) await dropDb(db).catch(() => {});
    }
    delete S.sites[name]; delete rt[name]; delete cache.du[name]; delete cache.ssl[name]; save();
    await reloadCaddy();
    const dir = siteDir(name);
    if (dir.startsWith(SITES + '/') && SITE_RE.test(path.basename(dir))) await fsp.rm(dir, { recursive: true, force: true });
    for (const f of await fsp.readdir(LOGS).catch(() => [])) if (f.startsWith(name + '.') || f.startsWith(name + '-')) await fsp.rm(path.join(LOGS, f), { force: true });
    res.json({ ok: true });
  }));

  // ---------- status / usage ----------
  async function diskUsage(name) {
    const c = cache.du[name];
    if (c && Date.now() - c.at < 60000) return c.bytes;
    const r = await sh('du', ['-sb', siteDir(name)], { timeout: 30000 });
    const bytes = parseInt(r.out, 10) || 0;
    cache.du[name] = { at: Date.now(), bytes };
    return bytes;
  }
  app.get('/api/sites/:name/status', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name], r = rt[name] || {};
    const out = { kind: s.kind, php: s.php, host: s.host, www: s.www, ssl: s.ssl || 'auto', privateIp: s.privateIp || null, installing: !!r.installing, step: r.step || null, error: r.error || null,
      suspended: !!s.suspended, stopped: !!s.stopped, overLimit: !!s.overLimit, caddyError,
      cpu: 0, cpus: s.cpu, memory: 0, memLimit: s.memory * 1048576, disk: await diskUsage(name), diskLimit: s.disk * 1073741824,
      bandwidth: s.bw.bytes, bandwidthLimit: s.bandwidth * 1073741824, requests: s.bw.requests, month: s.bw.month, netRx: 0, netTx: 0, processes: 0, dbs: Object.keys(s.dbs || {}).length, dbLimit: s.dbLimit };
    if (r.installing) out.state = 'installing';
    else if (r.error) out.state = 'error';
    else if (s.suspended) out.state = 'suspended';
    else if (s.stopped) out.state = 'stopped';
    else out.state = 'running';
    if (s.kind === 'php' && out.state === 'running') {
      const st = await ctState(ctName(name));
      if (st !== 'running') out.state = st ? 'stopped' : 'missing';
      else {
        try {
          const j = await docker.api('GET', `/containers/${ctName(name)}/stats?stream=false&one-shot=true`, 8000);
          const ns = j.cpu_stats.cpu_usage.total_usage, now = Date.now(), p = cache.cpu[name];
          if (p && ns >= p.ns) out.cpu = +(((ns - p.ns) / ((now - p.at) * 1e6)) / s.cpu * 100).toFixed(1);
          cache.cpu[name] = { ns, at: now };
          const m = j.memory_stats || {}, ms = m.stats || {};
          out.memory = Math.max(0, (m.usage || 0) - (ms.inactive_file || ms.total_inactive_file || 0));
          out.processes = (j.pids_stats && j.pids_stats.current) || 0;
          for (const x of Object.values(j.networks || {})) { out.netRx += x.rx_bytes || 0; out.netTx += x.tx_bytes || 0; }
        } catch {}
      }
    }
    res.json(out);
  }));

  // ---------- bandwidth accounting (from Caddy access logs) ----------
  async function accountBandwidth() {
    let changed = false, reload = false;
    for (const [name, s] of Object.entries(S.sites)) {
      if (s.bw.month !== month()) { s.bw = { month: month(), bytes: 0, requests: 0, offset: s.bw.offset }; if (s.overLimit) { s.overLimit = false; reload = true; } changed = true; }
      const file = path.join(LOGS, name + '.log');
      let st; try { st = await fsp.stat(file); } catch { continue; }
      if (st.size < s.bw.offset) s.bw.offset = 0; // log rolled over
      if (st.size === s.bw.offset) continue;
      const fh = await fsp.open(file, 'r');
      try {
        const len = Math.min(st.size - s.bw.offset, 32 * 1048576);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, s.bw.offset);
        const text = buf.toString('utf8');
        const end = text.lastIndexOf('\n') + 1;
        for (const line of text.slice(0, end).split('\n')) {
          if (!line) continue;
          try { const j = JSON.parse(line); s.bw.bytes += (j.size || 0) + (j.bytes_read || 0); s.bw.requests++; } catch {}
        }
        s.bw.offset += Buffer.byteLength(text.slice(0, end));
        changed = true;
      } finally { await fh.close(); }
      const over = s.bandwidth > 0 && s.bw.bytes >= s.bandwidth * 1073741824;
      if (over !== !!s.overLimit) { s.overLimit = over; reload = true; }
    }
    if (changed) save();
    if (reload) await reloadCaddy();
  }

  // ---------- logs ----------
  async function tail(file, maxBytes = 512 * 1024) {
    let st; try { st = await fsp.stat(file); } catch { return ''; }
    const start = Math.max(0, st.size - maxBytes);
    const fh = await fsp.open(file, 'r');
    try { const buf = Buffer.alloc(st.size - start); await fh.read(buf, 0, buf.length, start); return buf.toString('utf8'); } finally { await fh.close(); }
  }
  app.get('/api/sites/:name/logs', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name];
    const kind = req.query.kind === 'error' ? 'error' : 'access';
    const lines = (await tail(path.join(LOGS, name + '.log'))).split('\n').filter(Boolean);
    const access = [];
    for (const l of lines.slice(-1000)) {
      try {
        const j = JSON.parse(l), q = j.request || {};
        access.push({ ts: Math.round((j.ts || 0) * 1000), ip: q.client_ip || q.remote_ip || '', method: q.method, host: q.host, uri: q.uri, status: j.status, size: j.size || 0,
          ms: Math.round((j.duration || 0) * 1000), ua: ((q.headers || {})['User-Agent'] || [''])[0] });
      } catch {}
    }
    if (kind === 'access') return res.json({ kind, entries: access.slice(-300).reverse() });
    // error log: PHP / Apache output for PHP sites, failed requests for static sites
    const out = { kind, entries: access.filter((a) => a.status >= 400).slice(-200).reverse(), text: '' };
    if (s.kind === 'php') {
      const r = await sh(docker.BIN, ['logs', '--tail', '400', ctName(name)]);
      out.text = (r.out + r.err).split('\n').filter((l) => l && !/" (2|3)\d\d \d+ "/.test(l)).slice(-300).join('\n');
    }
    if (rt[name] && rt[name].error) out.text = `[setup error] ${rt[name].error}\n` + out.text;
    res.json(out);
  }));

  // ---------- DNS + SSL checks (for the domain setup screen) ----------
  const ipNum = (ip) => ip.split('.').reduce((a, b) => (a * 256) + (+b), 0);
  const inCidr = (ip, c) => { const [base, bits] = c.split('/'); const m = 2 ** (32 - +bits); return Math.floor(ipNum(ip) / m) === Math.floor(ipNum(base) / m); };
  const isCf = (ip) => CF_RANGES.some((c) => inCidr(ip, c));
  async function checkHost(host, want) {
    let ips = [];
    try { ips = await dns.resolve4(host); } catch (e) { return { host, ips: [], ok: false, cloudflare: false, error: e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'No A record found' : e.code || e.message }; }
    const cloudflare = ips.length > 0 && ips.every(isCf);
    return { host, ips, ok: ips.includes(want) || cloudflare, cloudflare };
  }
  function sslInfo(name) {
    const s = S.sites[name], c = cache.ssl[name];
    if (c && Date.now() - c.at < (c.active ? 600000 : 20000)) return Promise.resolve(c);
    return new Promise((resolve) => {
      const done = (v) => { cache.ssl[name] = { ...v, at: Date.now() }; resolve(cache.ssl[name]); };
      const sock = tls.connect({ host: '127.0.0.1', port: 443, servername: s.host, rejectUnauthorized: false, timeout: 5000 }, () => {
        const cert = sock.getPeerCertificate() || {};
        const issuer = (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || '';
        const self = !cert.valid_to || /Caddy Local Authority/i.test(issuer);
        sock.end();
        done({ active: !self && new Date(cert.valid_to) > new Date(), issuer, validTo: cert.valid_to ? new Date(cert.valid_to).getTime() : null });
      });
      sock.on('error', (e) => done({ active: false, error: e.code || e.message }));
      sock.on('timeout', () => { sock.destroy(); done({ active: false, error: 'timeout' }); });
    });
  }
  function localHttp(host) {
    return new Promise((resolve) => {
      const q = http.get({ host: '127.0.0.1', port: 80, path: '/', headers: { Host: host, 'X-Forwarded-Proto': 'https' }, timeout: 5000 }, (r) => { r.resume(); resolve({ ok: r.statusCode < 500 || r.statusCode === 503 || r.statusCode === 509, status: r.statusCode }); });
      q.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
      q.on('timeout', () => { q.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
  }
  app.get('/api/sites/:name/domain-check', wrap(async (req, res) => {
    const name = site(req), s = S.sites[name], want = String(req.query.ip || '');
    if (s.ssl === 'cloudflare') {
      // Cloudflare Tunnel: DNS must point to Cloudflare, and the site must answer on localhost:80
      const [main, www, local] = await Promise.all([checkHost(s.host, want), s.www ? checkHost('www.' + s.host, want) : null, localHttp(s.host)]);
      for (const h of [main, www]) if (h) h.ok = h.cloudflare;
      return res.json({ host: s.host, ip: want, mode: 'cloudflare', main, www, local, ssl: { active: main.cloudflare && local.ok, issuer: 'Cloudflare' }, caddyError });
    }
    const [main, www, ssl] = await Promise.all([checkHost(s.host, want), s.www ? checkHost('www.' + s.host, want) : null, sslInfo(name)]);
    res.json({ host: s.host, ip: want, mode: 'auto', main, www, ssl, caddyError });
  }));

  // ---------- file manager (direct on the host folder, never leaves the site folder) ----------
  function resolveIn(name, p) {
    const base = siteDir(name), rel = cleanPath(p), full = path.join(base, rel);
    if (full !== base && !full.startsWith(base + '/')) throw err(400, 'Bad path');
    return { base, full, rel };
  }
  async function checkReal(base, p) { // p must exist; its real path must stay inside base (no symlink escapes)
    const r = await fsp.realpath(p).catch(() => { throw err(404, 'Not found'); });
    if (r !== base && !r.startsWith(base + '/')) throw err(403, 'That path points outside the website folder');
    return r;
  }
  async function checkParent(base, full) {
    let d = path.dirname(full);
    while (!fs.existsSync(d)) d = path.dirname(d);
    await checkReal(base, d);
  }
  const owned = async (name, p) => { if (S.sites[name].kind === 'php') await sh('chown', ['-R', `${WWW_UID}:${WWW_UID}`, p]); };
  async function checkQuota(name, extra = 0) {
    const s = S.sites[name];
    delete cache.du[name];
    if ((await diskUsage(name)) + extra > s.disk * 1073741824) throw err(507, `Disk limit reached (${s.disk} GB) - delete files or ask an admin for more space`);
  }
  const touched = (name) => { delete cache.du[name]; };

  app.get('/api/sites/:name/files', wrap(async (req, res) => {
    const name = site(req), { base, full } = resolveIn(name, req.query.path);
    const real = await checkReal(base, full);
    if (!(await fsp.stat(real)).isDirectory()) throw err(400, 'Not a folder');
    const list = [];
    for (const d of await fsp.readdir(real, { withFileTypes: true })) {
      try { const st = await fsp.lstat(path.join(real, d.name)); list.push({ name: d.name, dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.size, mtime: st.mtimeMs }); } catch {}
    }
    res.json(list.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)));
  }));
  app.get('/api/sites/:name/files/content', wrap(async (req, res) => {
    const name = site(req), { base, full } = resolveIn(name, req.query.path);
    const real = await checkReal(base, full);
    const st = await fsp.stat(real);
    if (st.isDirectory()) throw err(400, 'That is a folder');
    if (st.size > 5 * 1048576) throw err(413, 'File too large to edit (5MB max) - download it instead');
    res.json({ content: await fsp.readFile(real, 'utf8') });
  }));
  app.post('/api/sites/:name/files/write', wrap(async (req, res) => {
    const name = site(req), { base, full } = resolveIn(name, req.body.path);
    if (full === base) throw err(400, 'Bad path');
    const content = String(req.body.content ?? '');
    await checkQuota(name, Buffer.byteLength(content));
    await checkParent(base, full);
    const st = await fsp.lstat(full).catch(() => null);
    if (st && (st.isSymbolicLink() || st.isDirectory())) throw err(400, 'Cannot write to that path');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
    await owned(name, full); touched(name);
    res.json({ ok: true });
  }));
  app.post('/api/sites/:name/files/mkdir', wrap(async (req, res) => {
    const name = site(req), { base, full } = resolveIn(name, req.body.path);
    await checkParent(base, full);
    await fsp.mkdir(full, { recursive: true });
    await owned(name, full);
    res.json({ ok: true });
  }));
  app.post('/api/sites/:name/files/rename', wrap(async (req, res) => {
    const name = site(req), a = resolveIn(name, req.body.from), b = resolveIn(name, req.body.to);
    if (a.full === a.base || b.full === b.base || a.rel === '/public_html') throw err(400, 'That folder cannot be renamed');
    await checkParent(a.base, a.full); await checkParent(b.base, b.full);
    await fsp.mkdir(path.dirname(b.full), { recursive: true });
    await fsp.rename(a.full, b.full);
    res.json({ ok: true });
  }));
  app.post('/api/sites/:name/files/delete', wrap(async (req, res) => {
    const name = site(req);
    for (const p of req.body.paths || []) {
      const { base, full, rel } = resolveIn(name, p);
      if (full === base || rel === '/public_html') continue;
      await checkParent(base, full);
      await fsp.rm(full, { recursive: true, force: true });
    }
    touched(name);
    res.json({ ok: true });
  }));
  const upload = multer({ dest: path.join(os.tmpdir(), 'avm-web-up'), limits: { fileSize: 2048 * 1048576 } });
  app.post('/api/sites/:name/files/upload', upload.array('files'), wrap(async (req, res) => {
    const name = site(req), { base, full: dir } = resolveIn(name, req.query.path);
    try {
      await checkQuota(name, (req.files || []).reduce((a, f) => a + f.size, 0));
      await checkParent(base, path.join(dir, 'x'));
      await fsp.mkdir(dir, { recursive: true });
      await checkReal(base, dir);
      for (const f of req.files || []) {
        const target = path.join(dir, path.basename(f.originalname));
        const st = await fsp.lstat(target).catch(() => null);
        if (st && st.isSymbolicLink()) continue;
        await fsp.copyFile(f.path, target);
        await owned(name, target);
      }
    } finally { for (const f of req.files || []) fsp.rm(f.path, { force: true }).catch(() => {}); }
    touched(name);
    res.json({ ok: true, count: (req.files || []).length });
  }));
  app.get('/api/sites/:name/files/download', wrap(async (req, res) => {
    const name = site(req), { base, full } = resolveIn(name, req.query.path);
    const real = await checkReal(base, full);
    if ((await fsp.stat(real)).isDirectory()) throw err(400, 'That is a folder - download single files');
    res.download(real, path.basename(real));
  }));

  // ---------- MariaDB ----------
  async function ensureMariadb() {
    if (!S.web.dbRootPassword) { S.web.dbRootPassword = randPw(24); save(); }
    const st = await ctState('avm-mariadb');
    if (st !== 'running') {
      if (st) await docker.run(['start', 'avm-mariadb']);
      else {
        await pullIfMissing(IMG.mariadb);
        await docker.run(['run', '-d', '--name', 'avm-mariadb', '--network', ctx.DOCKER_NET, '--ip', await subnetIp(2), '--restart', 'unless-stopped', '--label', 'avm=1',
          '-e', `MARIADB_ROOT_PASSWORD=${S.web.dbRootPassword}`, '-v', 'avm-mariadb-data:/var/lib/mysql', IMG.mariadb]);
      }
    }
    for (let i = 0; i < 60; i++) {
      const r = await sql('SELECT 1', { quiet: true }).catch(() => null);
      if (r !== null) {
        // hardening once: no anonymous users, no shared "test" database visible to every user
        if (!S.web.dbHardened) {
          await sql("DELETE FROM mysql.global_priv WHERE User=''; DELETE FROM mysql.db WHERE Db='test' OR Db LIKE 'test\\_%'; DROP DATABASE IF EXISTS test; FLUSH PRIVILEGES;", { quiet: true }).catch(() => {});
          S.web.dbHardened = true; save();
        }
        return;
      }
      await new Promise((x) => setTimeout(x, 2000));
    }
    throw err(504, 'Database server did not start in time');
  }
  async function sql(q, opts = {}) {
    const r = await sh(docker.BIN, ['exec', '-i', '-e', `MYSQL_PWD=${S.web.dbRootPassword}`, 'avm-mariadb', 'mariadb', '-uroot', '-N', '-B'], { input: q, timeout: 60000 });
    if (!r.ok) { if (opts.quiet) throw new Error(r.err); throw err(500, 'Database error: ' + r.err.trim().split('\n').pop()); }
    return r.out;
  }
  async function dropDb(db) {
    await ensureMariadb();
    await sql(`DROP DATABASE IF EXISTS \`${db}\`; DROP USER IF EXISTS '${db}'@'%'; FLUSH PRIVILEGES;`);
  }
  const needPhp = (name) => { if (S.sites[name].kind !== 'php') throw err(400, 'Databases are only available for PHP websites'); };
  const dbPrefix = (name) => name.slice(4);

  app.get('/api/sites/:name/dbs', wrap(async (req, res) => {
    const name = site(req); needPhp(name);
    const s = S.sites[name], names = Object.keys(s.dbs || {});
    const sizes = {};
    if (names.length && (await ctState('avm-mariadb')) === 'running') {
      const out = await sql(`SELECT table_schema, SUM(data_length + index_length) FROM information_schema.tables WHERE table_schema IN (${names.map((n) => `'${n}'`).join(',')}) GROUP BY table_schema`).catch(() => '');
      for (const l of out.split('\n').filter(Boolean)) { const [n, sz] = l.split('\t'); sizes[n] = +sz || 0; }
    }
    res.json({ host: 'avm-mariadb', port: 3306, limit: s.dbLimit, list: names.map((n) => ({ name: n, user: s.dbs[n].user, password: s.dbs[n].password, size: sizes[n] || 0, createdAt: s.dbs[n].createdAt })) });
  }));
  app.post('/api/sites/:name/dbs', wrap(async (req, res) => {
    const name = site(req); needPhp(name);
    const s = S.sites[name];
    const short = String(req.body.name || '').toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(short)) throw err(400, 'Database name: 1-40 characters a-z, 0-9, _');
    if (Object.keys(s.dbs).length >= s.dbLimit) throw err(400, `Database limit reached (${s.dbLimit})`);
    const db = `${dbPrefix(name)}_${short}`;
    if (s.dbs[db]) throw err(409, 'Database already exists');
    await ensureMariadb();
    const pw = randPw(20);
    await sql(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER '${db}'@'%' IDENTIFIED BY '${pw}'; GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${db}'@'%'; FLUSH PRIVILEGES;`);
    s.dbs[db] = { user: db, password: pw, createdAt: Date.now() }; save();
    res.json({ ok: true, name: db, user: db, password: pw, host: 'avm-mariadb' });
  }));
  app.delete('/api/sites/:name/dbs/:db', wrap(async (req, res) => {
    const name = site(req); needPhp(name);
    const s = S.sites[name], db = req.params.db;
    if (!s.dbs[db]) throw err(404, 'Database not found');
    await dropDb(db);
    delete s.dbs[db]; save();
    res.json({ ok: true });
  }));
  app.post('/api/sites/:name/dbs/:db/password', wrap(async (req, res) => {
    const name = site(req); needPhp(name);
    const s = S.sites[name], db = req.params.db;
    if (!s.dbs[db]) throw err(404, 'Database not found');
    await ensureMariadb();
    const pw = randPw(20);
    await sql(`ALTER USER '${db}'@'%' IDENTIFIED BY '${pw}'; FLUSH PRIVILEGES;`);
    s.dbs[db].password = pw; save();
    res.json({ ok: true, password: pw });
  }));

  // ---------- phpMyAdmin (reached through the panel at /pma/<nodeId>/) ----------
  let pmaReady = null;
  async function ensurePma(uri) {
    if (pmaReady && pmaReady.uri === uri && (await ctState('avm-pma')) === 'running') return pmaReady.ip;
    await ensureMariadb();
    const ip = await subnetIp(3);
    let cur = null; try { cur = await docker.inspect('avm-pma'); } catch {}
    if (cur && (cur.Config.Labels || {})['avm.pma.uri'] !== uri) { await docker.run(['rm', '-f', 'avm-pma']); cur = null; }
    if (!cur) {
      await pullIfMissing(IMG.pma);
      await docker.run(['run', '-d', '--name', 'avm-pma', '--network', ctx.DOCKER_NET, '--ip', ip, '--restart', 'unless-stopped', '--label', 'avm=1', '--label', `avm.pma.uri=${uri}`,
        '-e', 'PMA_HOST=avm-mariadb', '-e', `PMA_ABSOLUTE_URI=${uri}`, '-e', 'UPLOAD_LIMIT=256M', IMG.pma]);
    } else if (cur.State.Status !== 'running') await docker.run(['start', 'avm-pma']);
    for (let i = 0; i < 30; i++) {
      const up = await new Promise((r) => { const q = http.get({ host: ip, port: 80, path: '/', timeout: 2000 }, (x) => { x.resume(); r(true); }); q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); }); });
      if (up) break;
      await new Promise((x) => setTimeout(x, 1000));
    }
    pmaReady = { uri, ip };
    return ip;
  }
  async function pmaProxy(req, res) {
    try {
      const uri = String(req.headers['x-avm-pma-uri'] || '');
      if (!/^https?:\/\/[^\s]+\/pma\/[a-f0-9-]+\/$/.test(uri)) throw err(400, 'bad phpMyAdmin URL');
      await needDocker();
      const ip = await ensurePma(uri);
      const headers = { ...req.headers };
      for (const h of ['host', 'authorization', 'x-avm-pma-uri', 'connection']) delete headers[h];
      const up = http.request({ host: ip, port: 80, method: req.method, path: req.url || '/', headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: 'phpMyAdmin: ' + e.message }); else res.end(); });
      req.pipe(up);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }

  // ---------- node-wide info ----------
  app.get('/api/web/status', wrap(async (req, res) => {
    res.json({ caddy: await ctState('avm-caddy'), caddyError, mariadb: await ctState('avm-mariadb'), pma: await ctState('avm-pma'), sites: Object.keys(S.sites).length, phpVersions: PHP_VERSIONS });
  }));

  // ---------- boot ----------
  async function boot() {
    if (!Object.keys(S.sites).length) return;
    for (const [name, s] of Object.entries(S.sites)) {
      if (s.kind !== 'php') continue;
      let img = null; try { img = (await docker.inspect(ctName(name))).Config.Image; } catch {}
      if (img !== phpImage(s.php)) buildSite(name); // missing, or still on an older PHP image (files + databases are kept)
    }
    await reloadCaddy();
  }
  setInterval(() => accountBandwidth().catch((e) => console.error('[avm-web] bandwidth:', e.message)), 30000).unref();

  return { pmaProxy, boot, usedIps: () => Object.values(S.sites).map((s) => s.privateIp).filter(Boolean), PHP_VERSIONS };
};
