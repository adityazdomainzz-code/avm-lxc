/* AVM Panel front-end (vanilla JS, no build step) */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (b) => { if (!b || b < 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024))); return (b / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]; };
const fmtDate = (t) => (t ? new Date(t).toLocaleString() : '-');
const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);

const P = {
  vm: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14.6c2.4.6 4 2.4 4 5.4"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  node: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  plug: '<path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 01-12 0zM12 17v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  file: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/>',
  link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  refresh: '<path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  external: '<path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M15 8l2 2"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6M2 13v2M22 13v2"/>',
  archive: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
  snow: '<path d="M12 2v20M4.9 6l14.2 12M19.1 6L4.9 18M9 4l3 2 3-2M9 20l3-2 3 2"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[n] || ''}</svg>`;
const GH = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .5z"/></svg>';
const DC = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.3 4.4A19.8 19.8 0 0015.4 3l-.6 1.3a18.4 18.4 0 00-5.6 0L8.6 3a19.7 19.7 0 00-4.9 1.4C.6 9 -.3 13.5.1 18a19.9 19.9 0 006 3l1.3-2.1a12.9 12.9 0 01-2-1l.5-.4a14.2 14.2 0 0012.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 006-3c.5-5.2-.8-9.7-3.6-13.6zM8 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>';
const MARK = '<svg viewBox="0 0 64 64"><defs><linearGradient id="mk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9fe6f5"/><stop offset="1" stop-color="#0a6a86"/></linearGradient></defs><path d="M32 4 56 18v28L32 60 8 46V18z" fill="url(#mk)"/><path d="M32 16v32M18 24l28 16M46 24 18 40" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>';

// OS families shown first in the picker (versions come live from the node's image server)
const OS_META = {
  ubuntu: { name: 'Ubuntu', c: '#e95420' }, debian: { name: 'Debian', c: '#a80030' }, alpine: { name: 'Alpine', c: '#0d597f' },
  rockylinux: { name: 'Rocky Linux', c: '#10b981' }, almalinux: { name: 'AlmaLinux', c: '#0f4266' }, archlinux: { name: 'Arch Linux', c: '#1793d1' },
  fedora: { name: 'Fedora', c: '#294172' }, centos: { name: 'CentOS', c: '#932279' }, opensuse: { name: 'openSUSE', c: '#73ba25' },
  kali: { name: 'Kali', c: '#367bf0' }, devuan: { name: 'Devuan', c: '#4a4a6a' }, oracle: { name: 'Oracle Linux', c: '#c74634' },
  amazonlinux: { name: 'Amazon Linux', c: '#ff9900' }, gentoo: { name: 'Gentoo', c: '#54487a' }, nixos: { name: 'NixOS', c: '#5277c3' }, voidlinux: { name: 'Void', c: '#478061' },
  // Docker app images
  nginx: { name: 'Nginx', c: '#009639' }, httpd: { name: 'Apache', c: '#d22128' }, redis: { name: 'Redis', c: '#dc382d' }, node: { name: 'Node.js', c: '#3c873a' },
  python: { name: 'Python', c: '#3776ab' }, golang: { name: 'Go', c: '#00add8' }, mariadb: { name: 'MariaDB', c: '#003545' }, postgres: { name: 'PostgreSQL', c: '#336791' },
};
// Docker images offered in Create VM. shell=true -> kept running with a shell (images like ubuntu exit at once otherwise)
const DOCKER_IMAGES = [
  { id: 'ubuntu:24.04', os: 'ubuntu', version: '24.04', shell: true }, { id: 'ubuntu:22.04', os: 'ubuntu', version: '22.04', shell: true },
  { id: 'debian:13', os: 'debian', version: '13', shell: true }, { id: 'debian:12', os: 'debian', version: '12', shell: true },
  { id: 'alpine:latest', os: 'alpine', version: 'latest', shell: true },
  { id: 'rockylinux:9', os: 'rockylinux', version: '9', shell: true }, { id: 'almalinux:9', os: 'almalinux', version: '9', shell: true },
  { id: 'fedora:latest', os: 'fedora', version: 'latest', shell: true }, { id: 'archlinux:latest', os: 'archlinux', version: 'latest', shell: true },
  { id: 'node:22', os: 'node', version: '22', shell: true }, { id: 'node:20', os: 'node', version: '20', shell: true },
  { id: 'python:3.13', os: 'python', version: '3.13', shell: true }, { id: 'python:3.12', os: 'python', version: '3.12', shell: true },
  { id: 'nginx:latest', os: 'nginx', version: 'latest', shell: false }, { id: 'httpd:latest', os: 'httpd', version: 'latest', shell: false },
  { id: 'redis:latest', os: 'redis', version: 'latest', shell: false },
];
const OS_ORDER = ['ubuntu', 'debian', 'alpine', 'rockylinux', 'almalinux', 'archlinux', 'fedora'];
const UBUNTU_LTS = /^(\d\d)\.04$/;
function osOf(img, type) {
  if (type === 'docker') {
    // ghcr.io/user/app:1.2  ->  app / 1.2
    const s = String(img || '').split('@')[0];
    const i = s.lastIndexOf(':'), slash = s.lastIndexOf('/');
    const repo = i > slash ? s.slice(0, i) : s, tag = i > slash ? s.slice(i + 1) : 'latest';
    const base = repo.split('/').pop() || '?';
    const m = OS_META[base] || { name: base[0].toUpperCase() + base.slice(1), c: '#1d63ed' };
    return { name: m.name, ver: tag, c: m.c };
  }
  const [os, ver] = String(img || '').replace(/^[^:]*:/, '').split('/');
  const m = OS_META[os] || { name: os ? os[0].toUpperCase() + os.slice(1) : '?', c: '#0a6a86' };
  const lts = os === 'ubuntu' && UBUNTU_LTS.test(ver || '') && +ver.slice(0, 2) % 2 === 0;
  return { name: m.name, ver: (ver || '') + (lts ? ' LTS' : ''), c: m.c };
}
const typeLabel = (t) => ({ vm: 'KVM', docker: 'Docker' }[t] || 'LXC');
const typeLong = (t) => ({ vm: 'KVM virtual machine', docker: 'Docker container' }[t] || 'LXC container');

// ---------- api / ui helpers ----------
async function api(method, url, body) {
  const o = { method, headers: {} };
  if (body instanceof FormData) o.body = body;
  else if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(url, o);
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401 && !url.includes('/auth/')) { state.me = null; render(); }
  if (!r.ok) throw new Error((j && j.error) || 'Request failed (' + r.status + ')');
  return j;
}
function toast(msg, ok) {
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? ' ok' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500);
}
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(okMsg, true); return r; }
  catch (e) { toast(e.message); throw e; }
  finally { if (btn) btn.disabled = false; }
}
const quiet = (p) => p.catch(() => {});
function modal({ title, body, footer, wide, onMount, onClose }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}"><div class="modal-h"><h3>${esc(title)}</h3><button class="icon-btn" data-close>${icon('x')}</button></div><div class="modal-b">${body}</div>${footer ? `<div class="modal-f">${footer}</div>` : ''}</div></div>`;
  const bg = root.firstElementChild;
  const close = () => { if (root.firstElementChild === bg) { root.innerHTML = ''; if (onClose) onClose(); } };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  if (onMount) onMount(bg, close);
  const f = $('input:not([type=hidden]),select,textarea', bg); if (f) f.focus();
  return close;
}
function confirmBox(title, text, okLabel = 'Delete', cls = 'stop') {
  return new Promise((res) => {
    let done = false;
    modal({ title, body: `<p style="margin:0">${text}</p>`, footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${cls}" id="cf-ok">${esc(okLabel)}</button>`,
      onMount: (el, close) => { $('#cf-ok', el).onclick = () => { done = true; close(); res(true); }; },
      onClose: () => { if (!done) res(false); } });
  });
}
function promptBox(title, label, value, onOk, type = 'text') {
  modal({ title, body: `<form id="pb"><label class="f"><span>${esc(label)}</span><input class="input" type="${type}" name="v" value="${esc(value)}" required></label></form>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" form="pb">OK</button>`,
    onMount: (el, close) => { $('#pb', el).onsubmit = (e) => { e.preventDefault(); act(null, () => onOk(e.target.v.value.trim())).then(close).catch(() => {}); }; } });
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const copy = (txt) => { navigator.clipboard?.writeText(txt); toast('Copied', true); };

// ---------- state / router ----------
const state = { me: null, settings: {}, vms: [], vmCache: {}, sites: [], siteCache: {}, bots: [], botCache: {}, cleanup: [], ice: null };
function cleanup() { state.cleanup.forEach((f) => { try { f(); } catch {} }); state.cleanup = []; }
const route = () => (location.hash.replace(/^#\/?/, '') || 'vms').split('/');
window.addEventListener('hashchange', () => { document.body.classList.remove('nav-open'); render(); });

function applyBranding() {
  const s = state.settings;
  document.title = s.panelName || 'AVM Panel';
  if (s.logo) { const f = $('#favicon'); if (f) f.href = s.logo; }
  const bg = $('#bg');
  document.body.classList.toggle('has-bg', !!s.background);
  const want = s.background ? `${s.backgroundType}:${s.background}` : '';
  if (bg.dataset.cur !== want) {
    bg.dataset.cur = want;
    bg.innerHTML = !s.background ? '' : s.backgroundType === 'video'
      ? `<video src="${esc(s.background)}" autoplay muted loop playsinline></video>` : `<img src="${esc(s.background)}" alt="">`;
  }
}
const logoHtml = () => (state.settings.logo ? `<img src="${esc(state.settings.logo)}" alt="">` : MARK);

async function boot() {
  try { const j = await api('GET', '/api/me'); state.me = j.user; state.settings = j.settings; }
  catch { try { state.settings = await api('GET', '/api/settings/public'); } catch {} }
  const err = new URLSearchParams(location.search).get('oauth_error');
  if (err) { history.replaceState(null, '', '/' + location.hash); setTimeout(() => toast(err), 300); }
  render();
}

function render() {
  cleanup();
  $('#modal-root').innerHTML = ''; // close any open dialog when the page changes
  applyBranding();
  if (!state.me) return renderLogin();
  document.body.classList.remove('login-page');
  if (!$('.layout')) renderShell();
  const [a, b, c] = route();
  const content = $('#content');
  content.innerHTML = '<div class="boot" style="height:50vh"><div class="spinner"></div></div>';
  let page;
  if (a === 'vm' && b) page = () => pageVm(b, c || 'console');
  else if (a === 'site' && b) page = () => pageSite(b, c || 'files');
  else if (a === 'sites') page = pageSites;
  else if (a === 'bot' && b) page = () => pageBot(b, c || 'console');
  else if (a === 'bots') page = pageBots;
  else if (a === 'account') page = pageAccount;
  else if (a === 'admin' && state.me.admin) page = { overview: pageAdminOverview, nodes: pageNodes, create: pageCreateVm, vms: pageAdminVms, createweb: pageCreateSite, websites: pageAdminSites, createbot: pageCreateBot, bots: pageAdminBots, ports: pageAdminPorts, users: pageUsers, settings: pageSettings }[b || 'overview'] || pageAdminOverview;
  else page = pageVms;
  renderSidebar();
  page().catch((e) => { content.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="muted">${esc(e.message)}</p></div>`; });
}

// ---------- login / register ----------
function renderLogin(mode = 'login') {
  if (state.ice) { state.ice.stop(); state.ice = null; }
  document.body.classList.add('login-page');
  const s = state.settings;
  const reg = mode === 'register' && s.registration;
  const media = s.background ? (s.backgroundType === 'video' ? `<video src="${esc(s.background)}" autoplay muted loop playsinline></video>` : `<img src="${esc(s.background)}" alt="">`) : '';
  const oauth = (s.github || s.discord) ? `<div class="oauth">
      ${s.github ? `<a class="btn github lg block" href="/auth/github">${GH}Continue with GitHub</a>` : ''}
      ${s.discord ? `<a class="btn discord lg block" href="/auth/discord">${DC}Continue with Discord</a>` : ''}
    </div><div class="or">or</div>` : '';
  $('#app').innerHTML = `
  <div class="login">
    <div class="login-art ${media ? 'custom' : ''}">${media ? `<div class="media">${media}</div>` : ''}<canvas></canvas>
      <div class="txt"><h2>Cloud machines,<br>cold and clean.</h2>
      <p>Launch LXC containers, KVM virtual machines and Docker containers in seconds. Console, files, ports and live usage in one place.</p>
      <div class="chips"><span>LXC</span><span>KVM</span><span>Docker</span><span>Web console</span><span>sshx</span></div></div>
    </div>
    <div class="login-form"><form class="box" id="auth">
      <div class="brand" style="padding:0 0 26px"><div class="brand-mark">${logoHtml()}</div><div>${esc(s.panelName || 'AVM Panel')}<small>Virtual machines</small></div></div>
      ${reg ? `<h1>Create account</h1><p class="muted" style="margin:0 0 20px">It only takes a few seconds.</p>${oauth}
        <label class="f"><span>Username</span><input class="input" name="username" autocomplete="username" pattern="[A-Za-z0-9_.\\-]{3,24}" title="3-24 letters, numbers, _ . -" required></label>
        <label class="f"><span>Email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
        <label class="f"><span>Password</span><input class="input" type="password" name="password" minlength="6" autocomplete="new-password" required></label>
        <label class="f"><span>Confirm password</span><input class="input" type="password" name="password2" minlength="6" autocomplete="new-password" required></label>
        <button class="btn lg block">Create account</button>
        <p class="muted" style="text-align:center;margin:18px 0 0;font-size:14px">Already have an account? <a href="#" id="sw">Sign in</a></p>`
      : `<h1>Welcome back</h1><p class="muted" style="margin:0 0 20px">Sign in to manage your machines.</p>${oauth}
        <label class="f"><span>Username or email</span><input class="input" name="username" autocomplete="username" required></label>
        <label class="f"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn lg block">Sign in</button>
        ${s.registration ? `<p class="muted" style="text-align:center;margin:18px 0 0;font-size:14px">New here? <a href="#" id="sw">Create an account</a></p>` : ''}`}
    </form></div>
  </div>`;
  state.ice = IceDrift($('.login-art canvas'), { count: 70 });
  if ($('#sw')) $('#sw').onclick = (e) => { e.preventDefault(); renderLogin(reg ? 'login' : 'register'); };
  $('#auth').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (reg && d.password !== d.password2) return toast('Passwords do not match');
    await act($('#auth > button'), async () => {
      if (reg) { delete d.password2; await api('POST', '/api/auth/register', d); }
      else await api('POST', '/api/auth/login', d);
      if (state.ice) { state.ice.stop(); state.ice = null; }
      $('#app').innerHTML = '';
      if (!location.hash || location.hash === '#/') location.hash = '#/vms';
      await boot();
    }).catch(() => {});
  };
}

// ---------- shell + sidebar ----------
function renderShell() {
  $('#app').innerHTML = `
  <div class="layout">
    <aside class="sidebar"><canvas></canvas>
      <div class="brand"><div class="brand-mark" id="logo">${logoHtml()}</div><div><span id="pname">${esc(state.settings.panelName)}</span><small>Virtual machines</small></div></div>
      <div id="side"></div>
      <div class="side-user"><div class="avatar">${state.me.avatar ? `<img src="${esc(state.me.avatar)}" alt="">` : esc(state.me.username[0].toUpperCase())}</div>
        <div class="who"><b>${esc(state.me.username)}</b><span>${state.me.admin ? 'Administrator' : 'User'}</span></div>
        <button class="icon-btn" id="logout" title="Log out">${icon('logout')}</button></div>
    </aside>
    <div class="main">
      <div class="topbar"><button class="icon-btn" id="burger">${icon('menu')}</button><span>${esc(state.settings.panelName)}</span></div>
      <div class="content" id="content"></div>
    </div>
  </div>`;
  state.ice = IceDrift($('.sidebar canvas'));
  $('#logout').onclick = async () => { await quiet(api('POST', '/api/auth/logout')); state.me = null; location.hash = ''; if (state.ice) state.ice.stop(); state.ice = null; render(); };
  $('#burger').onclick = () => document.body.classList.toggle('nav-open');
  document.addEventListener('click', (e) => { if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar,#burger')) document.body.classList.remove('nav-open'); });
}
const navLink = (href, ic, label, active, extra = '') => `<a href="#/${href}" class="${active ? 'active' : ''}">${ic}<span class="trunc">${esc(label)}</span>${extra}</a>`;
async function renderSidebar() {
  const [a, b, c] = route();
  const side = $('#side');
  if (a === 'vm' && b) {
    const v = state.vmCache[b];
    const tab = c || 'console';
    side.innerHTML = `<div class="ctx"><a class="back" href="#/vms">${icon('back')}All machines</a><b>${esc(v ? v.name : 'Loading…')}</b>
      <div class="row">${v ? `<span class="badge">${typeLabel(v.type)}</span><span class="badge off">${esc(osOf(v.image, v.type).name)}</span>${v.suspended ? '<span class="badge bad">suspended</span>' : ''}` : ''}</div></div>
      <nav class="nav"><div class="nav-label">Machine</div>
      ${navLink(`vm/${b}/console`, icon('terminal'), 'Console', tab === 'console')}
      ${navLink(`vm/${b}/files`, icon('folder'), 'File manager', tab === 'files')}
      ${navLink(`vm/${b}/ports`, icon('plug'), 'Ports', tab === 'ports')}
      ${navLink(`vm/${b}/usage`, icon('chart'), 'System usage', tab === 'usage')}
      ${navLink(`vm/${b}/settings`, icon('gear'), 'Settings', tab === 'settings')}
      ${state.me.admin && v && v.ownerId !== state.me.id ? `<div class="nav-label">Admin</div>${navLink('admin/vms', icon('shield'), 'Back to admin VMs', false)}` : ''}
      </nav>`;
    return;
  }
  if (a === 'bot' && b) {
    const x = state.botCache[b];
    const tab = c || 'console';
    side.innerHTML = `<div class="ctx"><a class="back" href="#/bots">${icon('back')}All bots</a><b class="trunc" style="display:block">${esc(x ? x.name : 'Loading…')}</b>
      <div class="row">${x ? `<span class="badge">${botLang(x).label} ${esc(x.version || '')}</span>${x.suspended ? '<span class="badge bad">suspended</span>' : ''}` : ''}</div></div>
      <nav class="nav"><div class="nav-label">Discord bot</div>
      ${navLink(`bot/${b}/console`, icon('terminal'), 'Console', tab === 'console')}
      ${navLink(`bot/${b}/files`, icon('folder'), 'File manager', tab === 'files')}
      ${navLink(`bot/${b}/usage`, icon('chart'), 'System usage', tab === 'usage')}
      ${navLink(`bot/${b}/settings`, icon('gear'), 'Startup & settings', tab === 'settings')}
      ${state.me.admin && x && x.ownerId !== state.me.id ? `<div class="nav-label">Admin</div>${navLink('admin/bots', icon('shield'), 'Back to admin bots', false)}` : ''}
      </nav>`;
    return;
  }
  if (a === 'site' && b) {
    const x = state.siteCache[b];
    const tab = c || 'files';
    side.innerHTML = `<div class="ctx"><a class="back" href="#/sites">${icon('back')}All websites</a><b class="trunc" style="display:block">${esc(x ? x.name : 'Loading…')}</b>
      <div class="row">${x ? `<span class="badge">${siteKind(x).label}${x.php ? ' ' + esc(x.php) : ''}</span><span class="badge off trunc" style="max-width:150px">${esc(x.host)}</span>${x.suspended ? '<span class="badge bad">suspended</span>' : ''}` : ''}</div></div>
      <nav class="nav"><div class="nav-label">Website</div>
      ${navLink(`site/${b}/files`, icon('folder'), 'File manager', tab === 'files')}
      ${navLink(`site/${b}/usage`, icon('chart'), 'System usage', tab === 'usage')}
      ${x && x.kind === 'php' ? navLink(`site/${b}/database`, icon('db'), 'Databases', tab === 'database') : ''}
      ${navLink(`site/${b}/logs`, icon('file'), 'Logs', tab === 'logs')}
      ${navLink(`site/${b}/settings`, icon('gear'), 'Settings & domain', tab === 'settings')}
      ${state.me.admin && x && x.ownerId !== state.me.id ? `<div class="nav-label">Admin</div>${navLink('admin/websites', icon('shield'), 'Back to admin websites', false)}` : ''}
      </nav>`;
    return;
  }
  if (a === 'admin') {
    const t = b || 'overview';
    side.innerHTML = `<div class="ctx"><a class="back" href="#/vms">${icon('back')}Back to panel</a><b>Admin area</b></div>
      <nav class="nav"><div class="nav-label">Manage</div>
      ${navLink('admin/overview', icon('shield'), 'Overview', t === 'overview')}
      ${navLink('admin/nodes', icon('node'), 'Nodes', t === 'nodes')}
      ${navLink('admin/create', icon('plus'), 'Create VM', t === 'create')}
      ${navLink('admin/vms', icon('vm'), 'Virtual machines', t === 'vms')}
      ${navLink('admin/createweb', icon('globe'), 'Create website', t === 'createweb')}
      ${navLink('admin/websites', icon('globe'), 'Websites', t === 'websites')}
      ${navLink('admin/createbot', icon('bot'), 'Create Discord bot', t === 'createbot')}
      ${navLink('admin/bots', icon('bot'), 'Discord bots', t === 'bots')}
      ${navLink('admin/ports', icon('plug'), 'Ports', t === 'ports')}
      ${navLink('admin/users', icon('users'), 'User management', t === 'users')}
      ${navLink('admin/settings', icon('gear'), 'Settings', t === 'settings')}
      </nav>`;
    return;
  }
  try { state.vms = await api('GET', '/api/vms'); state.vms.forEach((v) => { state.vmCache[v.id] = v; }); } catch {}
  try { state.sites = await api('GET', '/api/sites'); state.sites.forEach((x) => { state.siteCache[x.id] = x; }); } catch {}
  try { state.bots = await api('GET', '/api/bots'); state.bots.forEach((x) => { state.botCache[x.id] = x; }); } catch {}
  if (['vm', 'site', 'bot', 'admin'].includes(route()[0])) return; // route changed meanwhile
  side.innerHTML = `<nav class="nav"><div class="nav-label">Machines</div>
    ${navLink('vms', icon('home'), 'All machines', a === 'vms')}
    ${state.vms.length ? state.vms.map((v) => navLink(`vm/${v.id}/console`, `<i class="dot ${v.suspended ? 'suspended' : ''}" data-dot="${v.id}"></i>`, v.name, false)).join('') : '<div class="empty">No machines yet</div>'}
    <div class="nav-label">Web hosting</div>
    ${navLink('sites', icon('globe'), 'All websites', a === 'sites')}
    ${state.sites.map((x) => navLink(`site/${x.id}/files`, `<i class="dot ${x.suspended ? 'suspended' : 'running'}"></i>`, x.name, false)).join('')}
    <div class="nav-label">Discord bots</div>
    ${navLink('bots', icon('bot'), 'All bots', a === 'bots')}
    ${state.bots.map((x) => navLink(`bot/${x.id}/console`, `<i class="dot ${x.suspended ? 'suspended' : ''}" data-bdot="${x.id}"></i>`, x.name, false)).join('')}
    <div class="nav-label">Account</div>${navLink('account', icon('user'), 'Account', a === 'account')}
    ${state.me.admin ? `<div class="nav-label">Admin</div>${navLink('admin/overview', icon('shield'), 'Admin area', false)}` : ''}
  </nav>`;
  state.bots.forEach(async (x) => { try { const st = await api('GET', `/api/bots/${x.id}/status`); const d = $(`[data-bdot="${x.id}"]`); if (d && st.state === 'running') d.classList.add('running'); } catch {} });
  state.vms.forEach(async (v) => { try { const st = await api('GET', `/api/vms/${v.id}/status`); const d = $(`[data-dot="${v.id}"]`); if (d && st.state === 'running') d.classList.add('running'); } catch {} });
}
function head(title, sub, actions = '', crumbs = '') {
  return `<div class="page-head"><div>${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="btn-row">${actions}</div></div>`;
}
function stateBadge(st, suspended) {
  if (suspended) return '<span class="badge bad"><i class="pulse"></i>suspended</span>';
  const m = { running: 'ok', installing: 'warn', stopped: 'off', frozen: 'warn', missing: 'bad', error: 'bad' };
  return `<span class="badge ${m[st] || 'off'}"><i class="pulse"></i>${esc(st === 'installing' ? 'creating' : st || 'unknown')}</span>`;
}
function osIcon(v) { const o = osOf(v.image, v.type); return `<div class="os-icon" style="background:linear-gradient(140deg,#fff,${o.c}22);color:${o.c}">${esc(o.name[0])}</div>`; }

// ---------- my VMs ----------
async function pageVms() {
  const list = await api('GET', '/api/vms');
  const c = $('#content');
  c.innerHTML = head('My machines', `${list.length} machine${list.length === 1 ? '' : 's'}`, state.me.admin ? `<a class="btn" href="#/admin/create">${icon('plus')}Create VM</a>` : '') +
    (list.length ? `<div class="grid g3">${list.map((v) => `
      <a class="card vm-card" href="#/vm/${v.id}/console">
        <div class="top"><div style="display:flex;gap:12px;align-items:center;min-width:0">${osIcon(v)}<div style="min-width:0"><h3 class="trunc">${esc(v.name)}</h3><span class="muted mono">${esc(v.publicIp || v.nodeIp)}</span></div></div><span data-st="${v.id}">${stateBadge(v.suspended ? '' : '…', v.suspended)}</span></div>
        <div class="meta"><span><b>${typeLabel(v.type)}</b> ${esc(osOf(v.image, v.type).name)} ${esc(osOf(v.image, v.type).ver)}</span><span><b>${v.cpu}</b> vCPU</span><span><b>${fmtBytes(v.memory * 1048576)}</b> RAM</span><span><b>${v.disk} GB</b> disk</span></div>
      </a>`).join('')}</div>`
      : `<div class="card empty-state">${icon('snow')}<h3>No machines yet</h3><p>${state.me.admin ? 'Create your first VM from the admin area.' : 'An admin will create a machine for you.'}</p>${state.me.admin ? `<a class="btn" href="#/admin/create">${icon('plus')}Create VM</a>` : ''}</div>`);
  list.filter((v) => !v.suspended).forEach(async (v) => {
    try { const st = await api('GET', `/api/vms/${v.id}/status`); const el = $(`[data-st="${v.id}"]`); if (el) el.innerHTML = stateBadge(st.state); }
    catch { const el = $(`[data-st="${v.id}"]`); if (el) el.innerHTML = '<span class="badge bad">node offline</span>'; }
  });
}

// ---------- single VM ----------
async function pageVm(id, tab) {
  const v = await api('GET', `/api/vms/${id}`);
  state.vmCache[id] = v;
  renderSidebar();
  const c = $('#content');
  const locked = v.suspended && !state.me.admin;
  c.innerHTML = `
    <div class="vm-bar"><div class="title">${osIcon(v)}<div style="min-width:0"><h1>${esc(v.name)}</h1><div class="sub">${esc(v.privateIp || '')}${v.publicIp ? ' · ' + esc(v.publicIp) : ''} · ${typeLabel(v.type)} · ${esc(osOf(v.image, v.type).name)} ${esc(osOf(v.image, v.type).ver)}</div></div><span id="vm-state">${stateBadge('…', v.suspended)}</span></div>
      <div class="btn-row">
        <button class="btn ok" data-p="start" ${locked ? 'disabled' : ''}>${icon('play')}Start</button>
        <button class="btn stop" data-p="stop" ${locked ? 'disabled' : ''}>${icon('stop')}Stop</button>
        <button class="btn deep" data-p="restart" ${locked ? 'disabled' : ''}>${icon('refresh')}Restart</button>
        <button class="btn purple" id="sshx" ${locked ? 'disabled' : ''}>${icon('link')}sshx</button>
      </div></div>
    ${v.suspended ? `<div class="alert bad"><b>This machine is suspended.</b> ${state.me.admin ? 'Users cannot start or manage it until you unsuspend it in Admin → Virtual machines.' : 'Please contact an administrator.'}</div>` : ''}
    <div id="tab"></div>`;

  const vmState = { st: null, listeners: [] };
  const onStatus = (fn) => vmState.listeners.push(fn);
  const poll = async () => {
    try {
      const st = await api('GET', `/api/vms/${id}/status`);
      const changed = !vmState.st || vmState.st.state !== st.state;
      vmState.st = st;
      const el = $('#vm-state');
      if (el) el.innerHTML = stateBadge(st.state, v.suspended) + (st.installing && st.step ? ` <span class="muted" style="font-size:12px">${esc(st.step)}…</span>` : '') + (st.error && !st.installing ? ` <span class="badge bad" title="${esc(st.error)}">error</span>` : '');
      vmState.listeners.forEach((fn) => fn(st, changed));
    } catch (e) { const el = $('#vm-state'); if (el) el.innerHTML = '<span class="badge bad">node offline</span>'; }
  };
  const iv = setInterval(poll, 3000);
  state.cleanup.push(() => clearInterval(iv));
  $$('[data-p]', c).forEach((b) => (b.onclick = () => act(b, () => api('POST', `/api/vms/${id}/power`, { action: b.dataset.p }), { start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…' }[b.dataset.p]).then(() => setTimeout(poll, 800)).catch(() => {})));
  $('#sshx').onclick = () => sshxFlow(v, () => vmState.st, poll);

  const t = $('#tab');
  const fn = { console: tabConsole, files: tabFiles, ports: tabPorts, usage: tabUsage, settings: tabVmSettings }[tab] || tabConsole;
  await poll();
  await fn(v, t, { onStatus, get st() { return vmState.st; }, poll });
}

function sshxFlow(v, getSt, poll) {
  const st = getSt();
  if (!st || st.state !== 'running') {
    modal({ title: 'sshx', body: `<div style="text-align:center;padding:8px 0"><div class="os-icon" style="margin:0 auto 12px;background:#ede5ff;color:var(--purple)">${icon('link')}</div><h3 style="margin:0 0 6px">Start VM to get it</h3><p class="muted" style="margin:0">Your machine is not running right now.</p></div>`,
      footer: `<button class="btn ghost" data-close>Close</button><button class="btn ok" id="sx-start">${icon('play')}Start VM</button>`,
      onMount: (el, close) => { $('#sx-start', el).onclick = () => act($('#sx-start', el), () => api('POST', `/api/vms/${v.id}/power`, { action: 'start' }), 'Starting…').then(() => { close(); setTimeout(poll, 800); }).catch(() => {}); } });
    return;
  }
  const run = (el, fresh) => {
    const box = $('#sx-body', el);
    box.innerHTML = `<div style="text-align:center;padding:18px 0"><div class="spinner" style="margin:0 auto 14px;border-top-color:var(--purple)"></div><b>Getting your sshx link…</b><p class="muted" style="margin:4px 0 0;font-size:13px">First time can take up to a minute.</p></div>`;
    $('#sx-new', el).disabled = true;
    api('POST', `/api/vms/${v.id}/sshx`, { fresh }).then((r) => {
      box.innerHTML = `<p class="muted" style="margin:0 0 10px">Open this link to share a live terminal of <b>${esc(v.name)}</b> in your browser.</p>
        <div class="copy sshx-link"><span>${esc(r.url)}</span><button class="icon-btn" id="sx-copy" title="Copy">${icon('copy')}</button></div>
        <div class="btn-row" style="margin-top:14px"><a class="btn purple" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('external')}Open sshx</a></div>`;
      $('#sx-copy', el).onclick = () => copy(r.url);
    }).catch((e) => { box.innerHTML = `<div class="alert bad" style="margin:0">${esc(e.message)}</div>`; })
      .finally(() => { const b = $('#sx-new', el); if (b) b.disabled = false; });
  };
  modal({ title: 'sshx', body: '<div id="sx-body"></div>', footer: `<button class="btn ghost" id="sx-new">${icon('refresh')}New link</button><button class="btn ghost" data-close>Close</button>`,
    onMount: (el) => { $('#sx-new', el).onclick = () => run(el, true); run(el, false); } });
}

// console (xterm.js loaded on demand)
let xtermLoading = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (xtermLoading) return xtermLoading;
  const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load terminal library')); document.head.appendChild(s); });
  xtermLoading = load('/vendor/xterm/lib/xterm.js').then(() => load('/vendor/xterm-fit/lib/addon-fit.js'));
  return xtermLoading;
}
async function tabConsole(v, t, vm) {
  let term = null, ws = null, ro = null, mode = null;
  const teardown = () => { try { ws && ws.close(); } catch {} try { ro && ro.disconnect(); } catch {} try { term && term.dispose(); } catch {} ws = term = ro = null; };
  state.cleanup.push(teardown);
  const shell = (inner, status) => { t.innerHTML = `<div class="term-wrap"><div class="term-head"><div class="lights"><i></i><i></i><i></i></div><span>root@${esc(v.hostname)}</span><span id="t-status">${status || ''}</span></div>${inner}</div>`; };
  const offline = (st) => {
    if (mode === 'off') return; mode = 'off'; teardown();
    const creating = st && st.state === 'installing';
    const failed = st && st.state === 'missing';
    const title = creating ? 'Creating your machine…' : failed ? 'This machine could not be created' : 'Machine is not running';
    const text = creating ? esc(st.step || 'Please wait') : failed ? esc(st.error || 'Unknown error') + (state.me.admin ? '<br><span style="opacity:.7">Delete it in Admin → Virtual machines and create it again with another OS version.</span>' : '<br><span style="opacity:.7">Please contact an administrator.</span>') : 'Start it to open the console.';
    shell(`<div class="term-off"><div>${icon(creating ? 'snow' : 'terminal')}<h3 style="margin:10px 0 4px;color:#fff">${title}</h3><p style="margin:0 0 16px;opacity:.85;max-width:560px">${text}</p>${creating || failed ? '' : `<button class="btn ok" id="t-start" ${v.suspended && !state.me.admin ? 'disabled' : ''}>${icon('play')}Start</button>`}</div></div>`);
    const b = $('#t-start'); if (b) b.onclick = () => act(b, () => api('POST', `/api/vms/${v.id}/power`, { action: 'start' }), 'Starting…').then(() => setTimeout(vm.poll, 1500)).catch(() => {});
  };
  const online = async () => {
    if (mode === 'on') return; mode = 'on';
    shell('<div id="term"></div>', '<span class="badge ok" style="font-size:11px"><i class="pulse"></i>live</span>');
    try { await loadXterm(); } catch (e) { $('#term').innerHTML = `<p style="color:#fff;padding:20px">${esc(e.message)}</p>`; return; }
    term = new window.Terminal({ cursorBlink: true, fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13.5, lineHeight: 1.2, scrollback: 5000,
      theme: { background: '#062530', foreground: '#dff6fb', cursor: '#7fe0f2', selectionBackground: '#1b6a80', black: '#062530', blue: '#4fb6e8', cyan: '#5ee0f0', green: '#5fe0a8', magenta: '#b794f6', red: '#ff7a85', white: '#dff6fb', yellow: '#ffd479', brightBlack: '#4b7584' } });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit); term.open($('#term')); fit.fit(); term.focus();
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/vms/${v.id}/console?cols=${term.cols}&rows=${term.rows}`);
      ws.onmessage = (e) => term && term.write(e.data);
      ws.onclose = () => { if (!term) return; const s = $('#t-status'); if (s) s.innerHTML = '<button class="btn sm ghost" id="t-re">Reconnect</button>'; const r = $('#t-re'); if (r) r.onclick = () => { s.innerHTML = '<span class="badge ok" style="font-size:11px"><i class="pulse"></i>live</span>'; term.reset(); connect(); }; };
    };
    connect();
    term.onData((d) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data: d })));
    ro = new ResizeObserver(() => { try { fit.fit(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {} });
    ro.observe($('#term'));
  };
  const apply = (st) => (st && st.state === 'running' ? online() : offline(st));
  apply(vm.st);
  vm.onStatus((st, changed) => { if (changed) { mode = null; apply(st); } });
}

// files
async function tabFiles(v, t, vm, opts = {}) {
  const base = opts.base || `/api/vms/${v.id}`;
  let cwd = opts.start || '/root';
  t.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="path" id="path"></div>
      <div class="btn-row">
        <button class="btn ghost sm" id="f-go">${icon('folder')}Go to…</button>
        <button class="btn ghost sm" id="f-newdir">${icon('plus')}Folder</button>
        <button class="btn ghost sm" id="f-newfile">${icon('file')}File</button>
        <label class="btn sm">${icon('upload')}Upload<input type="file" multiple hidden id="f-up"></label>
      </div></div>
    <div class="drop" id="drop" style="margin-bottom:14px">Drop files here to upload into this folder</div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody id="flist"></tbody></table></div></div>`;
  const join = (a, b) => (a.replace(/\/$/, '') + '/' + b).replace(/\/+/g, '/');
  const load = async () => {
    const parts = cwd.split('/').filter(Boolean);
    $('#path').innerHTML = `<a href="#" data-go="/">/</a>` + parts.map((p, i) => `<a href="#" data-go="/${parts.slice(0, i + 1).join('/')}">${esc(p)}</a>${i < parts.length - 1 ? '/' : ''}`).join('');
    $$('[data-go]', t).forEach((a) => (a.onclick = (e) => { e.preventDefault(); cwd = a.dataset.go; load(); }));
    const tb = $('#flist');
    tb.innerHTML = '<tr><td colspan="4" class="muted">Loading…</td></tr>';
    let files;
    try { files = await api('GET', `${base}/files?path=${encodeURIComponent(cwd)}`); }
    catch (e) {
      const st = vm.st || {};
      const msg = st.state === 'installing' ? 'The machine is still being created - files will appear when it is ready.'
        : st.state === 'missing' ? 'This machine could not be created: ' + (st.error || e.message)
        : /not running|instance is not/i.test(e.message) ? 'Start the machine to browse its files.' : e.message;
      tb.innerHTML = `<tr><td colspan="4"><div class="alert warn" style="margin:0">${esc(msg)}</div></td></tr>`; return;
    }
    const up = cwd !== '/' ? `<tr class="file-row" data-up><td><div class="fname">${icon('arrowUp')}..</div></td><td></td><td></td><td></td></tr>` : '';
    tb.innerHTML = up + (files.length ? files.map((f) => `
      <tr class="file-row" data-name="${esc(f.name)}" data-dir="${f.dir ? 1 : ''}">
        <td><div class="fname">${icon(f.dir ? 'folder' : 'file')}<span>${esc(f.name)}</span>${f.link ? ' <span class="badge off">link</span>' : ''}</div></td>
        <td class="muted nowrap">${f.dir ? '-' : fmtBytes(f.size)}</td><td class="muted nowrap">${fmtDate(f.mtime)}</td>
        <td class="right nowrap">${opts.extract && !f.dir && /\.zip$/i.test(f.name) ? `<button class="icon-btn" data-ex title="Extract here">${icon('archive')}</button>` : ''}${f.dir ? '' : `<button class="icon-btn" data-dl title="Download">${icon('download')}</button>`}<button class="icon-btn" data-rn title="Rename">${icon('edit')}</button><button class="icon-btn" data-del title="Delete">${icon('trash')}</button></td></tr>`).join('') : (up ? '' : '<tr><td colspan="4" class="muted">Empty folder</td></tr>'));
    const ur = $('[data-up]', tb); if (ur) ur.onclick = () => { cwd = cwd.split('/').slice(0, -1).join('/') || '/'; load(); };
    $$('tr[data-name]', tb).forEach((tr) => {
      const name = tr.dataset.name, p = join(cwd, name);
      tr.onclick = (e) => { if (e.target.closest('button')) return; if (tr.dataset.dir) { cwd = p; load(); } else openEditor(p); };
      const ex = $('[data-ex]', tr); if (ex) ex.onclick = () => act(ex, () => api('POST', `${base}/files/extract`, { path: p }), 'Extracted').then(load).catch(() => {});
      const dl = $('[data-dl]', tr); if (dl) dl.onclick = () => { location.href = `${base}/files/download?path=${encodeURIComponent(p)}`; };
      $('[data-rn]', tr).onclick = () => promptBox('Rename', 'New name', name, async (n) => { await api('POST', `${base}/files/rename`, { from: p, to: join(cwd, n) }); load(); });
      $('[data-del]', tr).onclick = async () => { if (await confirmBox(`Delete ${name}?`, 'This cannot be undone.')) act(null, () => api('POST', `${base}/files/delete`, { paths: [p] }), 'Deleted').then(load).catch(() => {}); };
    });
  };
  const openEditor = async (p) => {
    if (/\.(gz|tgz|zip|xz|bz2|tar|png|jpe?g|gif|webp|iso|img|qcow2|deb|rpm|so|bin|exe|jar|mp4|mp3)$/i.test(p)) { location.href = `${base}/files/download?path=${encodeURIComponent(p)}`; return; }
    let content;
    try { content = (await api('GET', `${base}/files/content?path=${encodeURIComponent(p)}`)).content; } catch (e) { return toast(e.message); }
    modal({ title: p, wide: true, body: '<textarea class="editor" spellcheck="false" id="ed"></textarea>',
      footer: '<button class="btn ghost" data-close>Close</button><button class="btn" id="ed-save">Save</button>',
      onMount: (el) => {
        const ed = $('#ed', el); ed.value = content;
        ed.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); ed.setRangeText('    ', ed.selectionStart, ed.selectionEnd, 'end'); } if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#ed-save', el).click(); } });
        $('#ed-save', el).onclick = () => act($('#ed-save', el), () => api('POST', `${base}/files/write`, { path: p, content: ed.value }), 'Saved').then(load).catch(() => {});
      } });
  };
  const uploadFiles = async (files) => {
    if (!files || !files.length) return;
    const fd = new FormData(); [...files].forEach((f) => fd.append('files', f));
    toast(`Uploading ${files.length} file(s)…`, true);
    await act(null, () => api('POST', `${base}/files/upload?path=${encodeURIComponent(cwd)}`, fd), 'Uploaded').catch(() => {});
    load();
  };
  $('#f-up').onchange = (e) => uploadFiles(e.target.files);
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); };
  $('#f-go').onclick = () => promptBox('Go to folder', 'Path', cwd, async (p) => { cwd = p.startsWith('/') ? p : join(cwd, p); load(); });
  $('#f-newdir').onclick = () => promptBox('New folder', 'Folder name', '', async (n) => { await api('POST', `${base}/files/mkdir`, { path: join(cwd, n) }); load(); });
  $('#f-newfile').onclick = () => promptBox('New file', 'File name', '', async (n) => { await api('POST', `${base}/files/write`, { path: join(cwd, n), content: '' }); load(); openEditor(join(cwd, n)); });
  load();
  vm.onStatus((st, changed) => { if (changed && st.state === 'running') load(); });
}

// ports
async function tabPorts(v, t) {
  const { max, list } = await api('GET', `/api/vms/${v.id}/ports`);
  const locked = v.suspended && !state.me.admin;
  const full = !state.me.admin && list.length >= max;
  t.innerHTML = `<div class="grid g2" style="align-items:start">
    <div class="card"><h3>Expose a port</h3><p class="sub">Make a service inside the machine reachable from the internet. Used <b>${list.length}/${max}</b>.</p>
      ${v.publicIp ? `<div class="alert">This machine has its own IP <b class="mono">${esc(v.publicIp)}</b> - every port is already reachable on it. Forwards below are for the shared node IP.</div>` : ''}
      <form id="pf"><div class="grid g2" style="gap:12px">
        <label class="f"><span>Port inside VM</span><input class="input" type="number" name="vmPort" min="1" max="65535" placeholder="e.g. 80" required ${locked || full ? 'disabled' : ''}></label>
        <label class="f"><span>Protocol</span><select class="input" name="proto" ${locked || full ? 'disabled' : ''}><option value="tcp">TCP</option><option value="udp">UDP</option></select></label></div>
        <label class="f"><span>Label (optional)</span><input class="input" name="label" maxlength="40" placeholder="Website, Minecraft…" ${locked || full ? 'disabled' : ''}></label>
        <label class="f"><span>Public port (optional)</span><input class="input" type="number" name="hostPort" placeholder="auto" ${locked || full ? 'disabled' : ''}><small>Leave empty to pick a free one automatically.</small></label>
        <button class="btn" ${locked || full ? 'disabled' : ''}>${icon('plus')}Expose port</button></form>
      ${full ? '<div class="alert warn" style="margin:14px 0 0">Port limit reached - remove one to add another.</div>' : ''}
    </div>
    <div class="card"><h3>Open ports</h3><p class="sub">Firewall (ufw) rules are added automatically.</p>
      <div class="list">${list.length ? list.map((p) => `<div class="item"><div class="os-icon" style="width:38px;height:38px">${icon('plug')}</div>
        <div class="info"><b class="mono">${esc(p.address)}</b><p>→ VM port ${p.vmPort}/${p.proto.toUpperCase()}${p.label ? ' · ' + esc(p.label) : ''}</p></div>
        <button class="icon-btn" data-copy="${esc(p.address)}" title="Copy">${icon('copy')}</button><button class="icon-btn" data-del="${p.id}" title="Remove" ${locked ? 'disabled' : ''}>${icon('trash')}</button></div>`).join('') : '<div class="muted">No ports exposed yet.</div>'}</div></div></div>`;
  $('#pf').onsubmit = (e) => { e.preventDefault(); act($('#pf .btn'), () => api('POST', `/api/vms/${v.id}/ports`, formData(e.target)), 'Port exposed').then(() => tabPorts(v, t)).catch(() => {}); };
  $$('[data-copy]', t).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  $$('[data-del]', t).forEach((b) => (b.onclick = async () => { if (await confirmBox('Remove this port?', 'The service will no longer be reachable from outside.', 'Remove')) act(b, () => api('DELETE', `/api/vms/${v.id}/ports/${b.dataset.del}`), 'Port removed').then(() => tabPorts(v, t)).catch(() => {}); }));
}

// usage
function sparkline(canvas, data, max) {
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const m = max || Math.max(...data, 1), step = w / 39;
  const pts = data.map((d, i) => [w - (data.length - 1 - i) * step, h - 4 - (Math.min(d, m) / m) * (h - 8)]);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(34,181,208,.35)'); g.addColorStop(1, 'rgba(34,181,208,0)');
  ctx.beginPath(); ctx.moveTo(pts[0][0], h); pts.forEach((p) => ctx.lineTo(p[0], p[1])); ctx.lineTo(pts[pts.length - 1][0], h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.strokeStyle = '#14a0bd'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}
async function tabUsage(v, t, vm) {
  t.innerHTML = `<div class="grid g4" style="margin-bottom:18px">
    <div class="card stat"><div class="k">CPU</div><div class="v" id="u-cpu">0%</div><div class="s">${v.cpu} vCPU</div><canvas class="spark" id="sp-cpu"></canvas></div>
    <div class="card stat"><div class="k">Memory</div><div class="v" id="u-mem">0 B</div><div class="s" id="u-mem-s">of ${fmtBytes(v.memory * 1048576)}</div><canvas class="spark" id="sp-mem"></canvas></div>
    <div class="card stat"><div class="k">Disk</div><div class="v" id="u-disk">-</div><div class="s" id="u-disk-s">of ${v.disk} GB</div><div class="bar"><i id="u-disk-b" style="width:0"></i></div></div>
    <div class="card stat"><div class="k">Network</div><div class="v" style="font-size:18px;margin-top:8px">↓ <span id="u-rx">0 B</span></div><div class="v" style="font-size:18px">↑ <span id="u-tx">0 B</span></div><div class="s">since boot</div></div>
  </div>
  <div class="card"><h3>Machine</h3><p class="sub">Live numbers from inside this machine (not the host). Updates every 3 seconds.</p>
    <dl class="kv"><dt>Status</dt><dd id="u-state">-</dd><dt>Type</dt><dd>${typeLong(v.type)}</dd><dt>OS</dt><dd>${esc(osOf(v.image, v.type).name)} ${esc(osOf(v.image, v.type).ver)}</dd>
    <dt>Private IP</dt><dd class="mono">${esc(v.privateIp || '-')}</dd><dt>Public IP</dt><dd class="mono">${esc(v.publicIp || v.nodeIp + ' (shared, use Ports)')}</dd><dt>Processes</dt><dd id="u-proc">-</dd><dt>Node</dt><dd>${esc(v.nodeName)}</dd></dl></div>`;
  const hist = { cpu: [], mem: [] };
  const upd = (st) => {
    if (!st || !$('#u-cpu')) return;
    const run = st.state === 'running';
    hist.cpu.push(run ? st.cpu : 0); hist.mem.push(run ? st.memory : 0);
    if (hist.cpu.length > 40) { hist.cpu.shift(); hist.mem.shift(); }
    $('#u-cpu').textContent = (run ? st.cpu : 0) + '%';
    $('#u-mem').textContent = fmtBytes(run ? st.memory : 0);
    $('#u-mem-s').textContent = `of ${fmtBytes(st.memLimit)} · ${pct(st.memory, st.memLimit).toFixed(0)}%`;
    $('#u-disk').textContent = st.disk ? fmtBytes(st.disk) : '-';
    $('#u-disk-s').textContent = `of ${fmtBytes(st.diskLimit)}`;
    const dp = pct(st.disk, st.diskLimit); $('#u-disk-b').style.width = dp + '%'; $('#u-disk-b').parentElement.classList.toggle('hot', dp > 85);
    $('#u-rx').textContent = fmtBytes(st.netRx); $('#u-tx').textContent = fmtBytes(st.netTx);
    $('#u-state').innerHTML = stateBadge(st.state, v.suspended); $('#u-proc').textContent = st.processes || '-';
    sparkline($('#sp-cpu'), hist.cpu, 100); sparkline($('#sp-mem'), hist.mem, st.memLimit);
  };
  upd(vm.st);
  vm.onStatus((st) => upd(st));
}

// vm settings
async function tabVmSettings(v, t) {
  const locked = v.suspended && !state.me.admin;
  t.innerHTML = `<div class="grid g2" style="align-items:start">
    <div class="card"><h3>Details</h3><p class="sub">Resources assigned to this machine.</p>
      <dl class="kv"><dt>Name</dt><dd>${esc(v.name)}</dd><dt>Hostname</dt><dd class="mono">${esc(v.hostname)}</dd><dt>Type</dt><dd>${typeLong(v.type)}</dd>
      <dt>OS image</dt><dd class="mono">${esc(v.image)}</dd><dt>CPU</dt><dd>${v.cpu} vCPU</dd><dt>Memory</dt><dd>${fmtBytes(v.memory * 1048576)}</dd><dt>Disk</dt><dd>${v.disk} GB</dd>
      <dt>Private IP</dt><dd class="mono">${esc(v.privateIp || '-')}</dd><dt>Public IP</dt><dd class="mono">${esc(v.publicIp || '-')}</dd><dt>Owner</dt><dd>${esc(v.ownerName)}</dd><dt>Created</dt><dd>${fmtDate(v.createdAt)}</dd></dl></div>
    <div class="card"><h3>Root password</h3><p class="sub">Set a new password for the <span class="mono">root</span> user (for SSH or console login).</p>
      <form id="pw"><label class="f"><span>New password</span><input class="input" type="password" name="password" minlength="6" autocomplete="new-password" required ${locked ? 'disabled' : ''}></label>
      <div class="btn-row"><button class="btn" ${locked ? 'disabled' : ''}>${icon('key')}Set password</button><button type="button" class="btn ghost" id="pw-gen" ${locked ? 'disabled' : ''}>Generate</button></div></form></div></div>`;
  $('#pw-gen').onclick = () => { const p = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join(''); const i = $('#pw input'); i.type = 'text'; i.value = p; };
  $('#pw').onsubmit = (e) => { e.preventDefault(); act($('#pw .btn'), () => api('POST', `/api/vms/${v.id}/password`, formData(e.target)), 'Root password updated').catch(() => {}); };
}

// ---------- account ----------
async function pageAccount() {
  const u = state.me, s = state.settings;
  $('#content').innerHTML = head('Account', 'Your profile, login and connected accounts') + `
  <div class="grid g2" style="align-items:start">
    <div class="card"><div style="display:flex;gap:14px;align-items:center;margin-bottom:18px"><div class="avatar" style="width:58px;height:58px;font-size:22px">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc(u.username[0].toUpperCase())}</div><div><h3>${esc(u.username)}</h3><span class="badge">${u.admin ? 'Administrator' : 'User'}</span></div></div>
      <dl class="kv"><dt>Username</dt><dd>${esc(u.username)}</dd><dt>Email</dt><dd>${esc(u.email || '-')}</dd><dt>Member since</dt><dd>${fmtDate(u.createdAt)}</dd><dt>Machines</dt><dd>${state.vms.length}</dd></dl>
      <form id="em" style="margin-top:20px"><label class="f"><span>Email</span><input class="input" type="email" name="email" value="${esc(u.email)}"></label><button class="btn ghost">Update email</button></form></div>
    <div><div class="card"><h3>Password</h3><p class="sub">At least 6 characters.</p>
      <form id="pw"><label class="f"><span>Current password</span><input class="input" type="password" name="currentPassword" placeholder="leave empty if you signed up with GitHub/Discord"></label>
      <label class="f"><span>New password</span><input class="input" type="password" name="newPassword" minlength="6" required></label><button class="btn">Change password</button></form></div>
    ${s.github || s.discord ? `<div class="card"><h3>Connected accounts</h3><p class="sub">Log in with one click.</p><div class="list">
      ${s.github ? `<div class="item"><div class="avatar" style="background:#1f2933">${GH}</div><div class="info"><b>GitHub</b><p>${u.github ? 'Connected' : 'Not connected'}</p></div>${u.github ? '<button class="btn sm ghost" data-unlink="github">Disconnect</button>' : '<a class="btn sm" href="/auth/github?link=1">Connect</a>'}</div>` : ''}
      ${s.discord ? `<div class="item"><div class="avatar" style="background:#5865f2">${DC}</div><div class="info"><b>Discord</b><p>${u.discord ? 'Connected' : 'Not connected'}</p></div>${u.discord ? '<button class="btn sm ghost" data-unlink="discord">Disconnect</button>' : '<a class="btn sm" href="/auth/discord?link=1">Connect</a>'}</div>` : ''}
    </div></div>` : ''}</div></div>`;
  $$('.item .avatar svg').forEach((s2) => { s2.style.width = '18px'; s2.style.height = '18px'; });
  $('#em').onsubmit = (e) => { e.preventDefault(); act($('#em button'), () => api('PATCH', '/api/me', formData(e.target)), 'Email updated').then((r) => { state.me = r.user; }).catch(() => {}); };
  $('#pw').onsubmit = (e) => { e.preventDefault(); act($('#pw button'), () => api('PATCH', '/api/me', formData(e.target)), 'Password changed').then(() => e.target.reset()).catch(() => {}); };
  $$('[data-unlink]').forEach((b) => (b.onclick = () => act(b, () => api('POST', `/api/me/unlink/${b.dataset.unlink}`), 'Disconnected').then((r) => { state.me = r.user; pageAccount(); }).catch(() => {})));
}

// ---------- admin ----------
async function pageAdminOverview() {
  const o = await api('GET', '/api/admin/overview');
  const card = (k, v, s, href) => `<a class="card stat vm-card" href="#/admin/${href}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></a>`;
  $('#content').innerHTML = head('Overview', `Everything running on ${esc(state.settings.panelName)}`) +
    `<div class="grid g4">${card('Machines', o.vms, `${o.lxc} LXC · ${o.kvm} KVM · ${o.docker || 0} Docker`, 'vms')}${card('Websites', o.sites || 0, `${(o.sites || 0) - (o.phpSites || 0)} HTML · ${o.phpSites || 0} PHP`, 'websites')}${card('Discord bots', o.bots || 0, 'Node.js · TS · Python', 'bots')}${card('Users', o.users, 'accounts', 'users')}${card('Open ports', o.ports, `${o.suspended} suspended VM${o.suspended === 1 ? '' : 's'}`, 'ports')}</div>
    <div class="card" style="margin-top:18px"><h3>Quick actions</h3><p class="sub">Common admin tasks</p><div class="btn-row">
      <a class="btn" href="#/admin/create">${icon('plus')}Create VM</a><a class="btn" href="#/admin/createweb">${icon('globe')}Create website</a><a class="btn" href="#/admin/createbot">${icon('bot')}Create bot</a><a class="btn ghost" href="#/admin/users">${icon('users')}Add user</a><a class="btn ghost" href="#/admin/nodes">${icon('node')}Add node</a><a class="btn ghost" href="#/admin/settings">${icon('gear')}Login & branding</a></div></div>`;
}

async function pageNodes() {
  const nodes = await api('GET', '/api/admin/nodes');
  $('#content').innerHTML = head('Nodes', 'Hosts that run your LXC containers, KVM machines and Docker containers', `<button class="btn" id="add">${icon('plus')}Add node</button>`) +
    `<div class="grid g2">${nodes.map((n) => `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:10px"><div><h3>${esc(n.name)} ${n.local ? '<span class="badge" style="margin-left:4px">local</span>' : ''}</h3><span class="mono muted">${esc(n.url)}</span></div>${n.online ? '<span class="badge ok"><i class="pulse"></i>online</span>' : '<span class="badge bad">offline</span>'}</div>
      <dl class="kv" style="margin-top:14px"><dt>Public IP</dt><dd class="mono">${esc(n.ip)}</dd><dt>Port range</dt><dd class="mono">${n.portStart} – ${n.portEnd}</dd><dt>Machines</dt><dd>${n.vms}</dd>
      ${n.system ? `<dt>Host</dt><dd>${esc(n.system.hostname)} · ${n.system.cpus} CPU · ${fmtBytes(n.system.memTotal)}</dd>
        <dt>Incus (LXC)</dt><dd>${n.system.incus ? '<span class="badge ok">v' + esc(n.system.incusVersion || '?') + '</span>' : '<span class="badge off">not installed</span>'}</dd>
        <dt>KVM</dt><dd>${n.system.kvm ? '<span class="badge ok">available</span>' : `<span class="badge ${n.system.incus ? 'warn' : 'off'}">${n.system.incus ? 'no /dev/kvm · LXC only' : 'not available'}</span>`}</dd>
        <dt>Docker</dt><dd>${n.system.docker ? '<span class="badge ok">v' + esc(n.system.dockerVersion || '?') + '</span>' : '<span class="badge off">not installed</span>'}</dd>
        <dt>Firewall</dt><dd>${n.system.ufw ? 'ufw active' : 'iptables only'}</dd>
        ${n.system.incus ? `<dt>Bridge</dt><dd class="mono">${esc(n.system.bridge)} ${esc(n.system.subnet || '')}</dd>` : ''}
        ${n.system.docker ? `<dt>Docker net</dt><dd class="mono">${esc(n.system.dockerNetwork || '')} ${esc(n.system.dockerSubnet || '')}</dd>` : ''}` : ''}
      <dt>IP pool</dt><dd>${n.ipPool.length ? n.ipPool.map((p) => `<span class="badge ${p.vm ? 'purple' : 'off'}" style="margin:0 4px 4px 0" title="${p.vm ? 'used by ' + esc(p.vm) : 'free'}">${esc(p.ip)}${p.vm ? ' · ' + esc(p.vm) : ''}</span>`).join('') : '<span class="muted">none (NAT only)</span>'}</dd></dl>
      <div class="btn-row" style="margin-top:14px"><button class="btn ghost sm" data-edit="${n.id}">${icon('edit')}Edit</button>${n.local ? '' : `<button class="btn danger sm" data-del="${n.id}">${icon('trash')}Delete</button>`}</div></div>`).join('')}</div>
    <div class="card" style="margin-top:18px"><h3>Add another host</h3><p class="sub" style="margin:0">On the new server run <span class="mono">bash install.sh --node-only</span>. It prints a daemon URL and token - paste them in <b>Add node</b>.</p></div>`;
  const form = (n = {}) => `<form id="nf">
    <label class="f"><span>Name</span><input class="input" name="name" value="${esc(n.name || '')}" required></label>
    <label class="f"><span>Daemon URL</span><input class="input mono" name="url" value="${esc(n.url || 'http://')}" required><small>e.g. http://1.2.3.4:8090</small></label>
    <label class="f"><span>Daemon token</span><input class="input mono" name="token" placeholder="${n.id ? 'leave empty to keep' : ''}" ${n.id ? '' : 'required'}></label>
    <label class="f"><span>Public IP (shared NAT IP)</span><input class="input mono" name="ip" value="${esc(n.ip || '')}" required></label>
    <div class="grid g2" style="gap:12px"><label class="f"><span>Port range start</span><input class="input" type="number" name="portStart" value="${n.portStart || 20000}"></label><label class="f"><span>Port range end</span><input class="input" type="number" name="portEnd" value="${n.portEnd || 30000}"></label></div>
    <label class="f"><span>Dedicated IP pool (optional)</span><textarea class="input mono" name="ipPool" placeholder="203.0.113.10&#10;203.0.113.11">${esc((n.ipPool || []).map((p) => p.ip).join('\n'))}</textarea><small>Extra IPv4s routed to this host, one per line. Admins can give a machine its own IP (1:1 NAT).</small></label></form>`;
  $('#add').onclick = () => modal({ title: 'Add node', body: form(), footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" form="nf">Add node</button>`,
    onMount: (el, close) => { $('#nf', el).onsubmit = (e) => { e.preventDefault(); act(null, () => api('POST', '/api/admin/nodes', formData(e.target)), 'Node added').then(() => { close(); render(); }).catch(() => {}); }; } });
  $$('[data-edit]').forEach((b) => (b.onclick = () => { const n = nodes.find((x) => x.id === b.dataset.edit); modal({ title: 'Edit ' + n.name, body: form(n), footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" form="nf">Save</button>`,
    onMount: (el, close) => { $('#nf', el).onsubmit = (e) => { e.preventDefault(); act(null, () => api('PATCH', `/api/admin/nodes/${n.id}`, formData(e.target)), 'Saved').then(() => { close(); render(); }).catch(() => {}); }; } }); }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmBox('Delete node?', 'It will be removed from the panel.')) act(b, () => api('DELETE', `/api/admin/nodes/${b.dataset.del}`), 'Node removed').then(render).catch(() => {}); }));
}

async function pageCreateVm() {
  const [nodes, users] = await Promise.all([api('GET', '/api/admin/nodes'), api('GET', '/api/admin/users')]);
  const c = $('#content');
  if (!nodes.length) { c.innerHTML = head('Create VM', '') + `<div class="card empty-state">${icon('node')}<h3>No nodes yet</h3><p>Add a node first.</p><a class="btn" href="#/admin/nodes">Go to nodes</a></div>`; return; }
  c.innerHTML = head('Create VM', 'Pick a host, a type (KVM, LXC or Docker), an image and resources') + `
  <form id="cv"><div class="grid g2" style="align-items:start">
    <div class="card"><h3>Basics</h3><p class="sub">Who owns it and where it runs.</p>
      <label class="f"><span>Machine name</span><input class="input" name="name" maxlength="40" placeholder="web-server-1" required></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === state.me.id ? 'selected' : ''}>${esc(u.username)}${u.admin ? ' (admin)' : ''}</option>`).join('')}</select></label>
      <label class="f"><span>Node</span><select class="input" name="nodeId">${nodes.map((n) => `<option value="${n.id}">${esc(n.name)} · ${esc(n.ip)}${n.online ? '' : ' (offline)'}</option>`).join('')}</select></label>
      <div class="f-label">Type</div>
      <div class="pick-grid types3" id="types" style="margin-bottom:14px">
        <button type="button" class="pick" data-type="vm"><b>KVM</b><span>Full VM, own kernel</span></button>
        <button type="button" class="pick sel" data-type="container"><b>LXC</b><span>Light system container</span></button>
        <button type="button" class="pick" data-type="docker"><b>Docker</b><span>Any Docker image</span></button>
      </div><input type="hidden" name="type" value="container">
      <label class="f"><span>Dedicated IP</span><select class="input" name="publicIp"></select><small>NAT = shared node IP + port forwarding.</small></label>
      <div id="docker-opts" style="display:none">
        <label class="check" style="margin-bottom:6px"><input type="checkbox" name="keepAlive" id="keep" checked> Keep running with a shell</label>
        <small class="muted" style="display:block;margin:0 0 14px">Turn on for OS images (ubuntu, debian, alpine…) that would exit at once. Turn off for app images (nginx, redis…) so their own command runs.</small>
        <label class="f"><span>Environment variables (optional)</span><textarea class="input mono" name="env" rows="3" placeholder="TZ=Asia/Kolkata&#10;MYSQL_ROOT_PASSWORD=change-me"></textarea><small>One <span class="mono">KEY=value</span> per line.</small></label>
      </div>
    </div>
    <div class="card"><h3>Resources</h3><p class="sub" id="res-sub">Limits enforced by Incus.</p>
      <div class="grid g3" style="gap:12px">
        <label class="f"><span>vCPU</span><input class="input" type="number" name="cpu" min="1" max="64" value="1"></label>
        <label class="f"><span>RAM (MB)</span><input class="input" type="number" name="memory" min="128" step="128" value="1024"></label>
        <label class="f"><span>Disk (GB)</span><input class="input" type="number" name="disk" min="1" value="10"></label></div>
      <div class="f-label" id="os-label">Operating system</div>
      <div class="pick-grid" id="oses"></div>
      <label class="f" id="ver-wrap" style="display:none;margin-top:12px"><span>Version</span><select class="input" id="ver"></select></label>
      <input type="hidden" name="image" value="">
      <label class="f" id="custom-img" style="display:none;margin-top:12px"><span id="img-label">Image alias</span><input class="input mono" id="img-in" placeholder="images:fedora/42"><small id="img-help"></small></label>
      <button class="btn lg block" style="margin-top:16px">${icon('plus')}Create machine</button>
    </div></div></form>`;
  const f = $('#cv');
  const nodeSel = $('[name=nodeId]', f);
  const curType = () => $('[name=type]', f).value;
  const isDocker = () => curType() === 'docker';
  const TYPE_SUB = { vm: 'Full VM, own kernel', container: 'Light system container', docker: 'Any Docker image' };
  const setType = (t) => {
    $$('[data-type]', f).forEach((x) => x.classList.toggle('sel', x.dataset.type === t));
    $('[name=type]', f).value = t;
    const d = t === 'docker';
    $('#docker-opts').style.display = d ? 'block' : 'none';
    $('#res-sub').textContent = d ? 'Limits enforced by Docker (disk only where the storage driver supports quotas).' : 'Limits enforced by Incus.';
    $('#os-label').textContent = d ? 'Docker image' : 'Operating system';
    $('#img-label').textContent = d ? 'Docker image' : 'Image alias';
    $('#img-in').placeholder = d ? 'ghcr.io/user/app:1.0' : 'images:fedora/42';
    $('#img-help').innerHTML = d ? 'Any image from Docker Hub or another registry, e.g. <span class="mono">mariadb:11</span>. Must be lowercase.' : 'Run <span class="mono">incus image list images:</span> on the node to see every alias.';
    family = null;
    loadImages();
  };
  const syncNode = () => {
    const n = nodes.find((x) => x.id === nodeSel.value);
    const sys = n && n.system;
    // older nodes do not report "types": they are Incus-only
    const types = sys ? (sys.types || ['container', ...(sys.kvm ? ['vm'] : [])]) : [];
    const why = { vm: sys && sys.incus ? 'No /dev/kvm on node' : 'Incus not installed', container: 'Incus not installed', docker: 'Docker not installed' };
    $$('[data-type]', f).forEach((b) => { const ok = types.includes(b.dataset.type) || !sys; b.disabled = !ok; b.querySelector('span').textContent = ok ? TYPE_SUB[b.dataset.type] : why[b.dataset.type]; });
    const cur = $(`[data-type=${curType()}]`, f);
    if (cur.disabled) { const first = $$('[data-type]', f).find((b) => !b.disabled); if (first) { setType(first.dataset.type); } }
    const free = (n ? n.ipPool : []).filter((p) => !p.vm);
    $('[name=publicIp]', f).innerHTML = '<option value="">None - NAT (shared IP)</option>' + free.map((p) => `<option>${esc(p.ip)}</option>`).join('');
  };
  // ---- image picker (Incus: live list from the node · Docker: presets + images already on the node) ----
  const imgCache = {};
  let family = null;
  const imgInput = $('[name=image]', f), verSel = $('#ver'), oses = $('#oses');
  const cacheKey = () => nodeSel.value + ':' + (isDocker() ? 'docker' : 'incus');
  const usable = () => (isDocker() ? (imgCache[cacheKey()] || DOCKER_IMAGES) : (imgCache[cacheKey()] || []).filter((i) => (curType() === 'vm' ? i.vm : i.container)));
  const order = () => (isDocker() ? [...new Set(DOCKER_IMAGES.map((i) => i.os))] : OS_ORDER);
  const pickFamily = (fam) => {
    family = fam;
    $$('[data-fam]', oses).forEach((x) => x.classList.toggle('sel', x.dataset.fam === fam));
    const custom = fam === 'custom';
    $('#custom-img').style.display = custom ? 'block' : 'none';
    $('#ver-wrap').style.display = custom ? 'none' : 'block';
    if (custom) { imgInput.value = $('#img-in').value.trim(); $('#img-in').focus(); return; }
    const vers = usable().filter((i) => (fam === 'other' ? !order().includes(i.os) : i.os === fam));
    verSel.innerHTML = vers.map((i) => `<option value="${esc(i.id)}">${fam === 'other' && !isDocker() ? esc(osOf(i.id).name) + ' ' : ''}${esc(isDocker() ? i.id : osOf(i.id).ver)}${i.local ? ' · on node' : ''}${i.release && i.release !== i.version ? ' (' + esc(i.release) + ')' : ''}</option>`).join('');
    syncImage();
  };
  const syncImage = () => {
    imgInput.value = verSel.value || '';
    if (isDocker()) { const p = usable().find((i) => i.id === verSel.value); if (p && p.shell !== undefined) $('#keep').checked = p.shell; }
  };
  const renderOses = () => {
    const list = usable(), ord = order();
    const fams = ord.filter((o) => list.some((i) => i.os === o));
    const others = list.some((i) => !ord.includes(i.os));
    const t = curType();
    const card = (fam, name, sub, color, letter) => `<button type="button" class="pick" data-fam="${fam}"><div class="os"><i style="background:${color}">${letter}</i><div><b>${esc(name)}</b><span>${esc(sub)}</span></div></div></button>`;
    oses.innerHTML = fams.map((o) => { const n = list.filter((i) => i.os === o).length; const m = OS_META[o] || osOf(o, t); return card(o, m.name, `${n} version${n > 1 ? 's' : ''}`, m.c, m.name[0]); }).join('')
      + (others ? card('other', isDocker() ? 'On this node' : 'More', isDocker() ? 'downloaded images' : 'other distros', '#2e6f82', '…') : '')
      + card('custom', 'Custom', isDocker() ? 'any registry image' : 'any Incus image', '#5d8795', '+');
    $$('[data-fam]', oses).forEach((b) => (b.onclick = () => pickFamily(b.dataset.fam)));
    pickFamily(fams.includes(family) || (family === 'other' && others) || family === 'custom' ? family : (fams[0] || 'custom'));
  };
  const pending = {};
  const loadImages = async () => {
    const key = cacheKey(), nid = nodeSel.value;
    if (pending[key]) return;
    if (!imgCache[key]) {
      pending[key] = true;
      if (isDocker()) {
        // presets first, then whatever the node already has downloaded (shown under "On this node")
        renderOses();
        try {
          const local = await api('GET', `/api/admin/nodes/${nid}/docker-images`);
          const known = new Set(DOCKER_IMAGES.map((i) => i.id));
          imgCache[key] = [...DOCKER_IMAGES.map((i) => ({ ...i, local: local.some((l) => l.image === i.id) })),
            ...local.filter((l) => !known.has(l.image)).map((l) => ({ id: l.image, os: '~local', version: l.image, local: true }))];
        } catch { imgCache[key] = DOCKER_IMAGES; }
      } else {
        oses.innerHTML = '<div class="muted" style="grid-column:1/-1"><span class="spinner sm" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>Loading available images…</div>';
        try { imgCache[key] = await api('GET', `/api/admin/nodes/${nid}/images`); }
        catch (e) { imgCache[key] = []; toast('Image list: ' + e.message); }
      }
      delete pending[key];
    }
    if (cacheKey() === key) renderOses();
  };
  verSel.onchange = syncImage;
  $('#img-in').oninput = (e) => { imgInput.value = e.target.value.trim(); };
  $$('[data-type]', f).forEach((b) => (b.onclick = () => { if (!b.disabled && curType() !== b.dataset.type) setType(b.dataset.type); }));
  nodeSel.onchange = () => { syncNode(); loadImages(); };
  syncNode(); loadImages();
  f.onsubmit = (e) => {
    e.preventDefault();
    if (!imgInput.value) return toast(isDocker() ? 'Choose a Docker image' : 'Choose an operating system');
    const body = formData(f);
    body.keepAlive = $('#keep').checked;
    act($('.btn.lg', f), () => api('POST', '/api/admin/vms', body), 'Machine is being created - the first image download can take a few minutes')
      .then((v) => { if (v.warning) toast(v.warning); location.hash = `#/vm/${v.id}/console`; }).catch(() => {});
  };
}

async function pageAdminVms() {
  const list = await api('GET', '/api/admin/vms');
  $('#content').innerHTML = head('Virtual machines', `${list.length} total`, `<a class="btn" href="#/admin/create">${icon('plus')}Create VM</a>`) +
    `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Machine</th><th>Owner</th><th>Type</th><th>Node</th><th>IP</th><th>Resources</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((v) => `<tr>
      <td><a href="#/vm/${v.id}/console"><b>${esc(v.name)}</b></a><div class="muted mono" style="font-size:12px">${esc(v.hostname)}</div></td>
      <td>${esc(v.ownerName)}</td><td><span class="badge">${typeLabel(v.type)}</span> <span class="muted">${esc(osOf(v.image, v.type).name)}</span></td><td>${esc(v.nodeName)}</td>
      <td class="mono" style="font-size:12.5px">${esc(v.privateIp || '-')}${v.publicIp ? `<br><span class="badge purple">${esc(v.publicIp)}</span>` : ''}</td>
      <td class="nowrap">${v.cpu} vCPU · ${fmtBytes(v.memory * 1048576)} · ${v.disk} GB</td>
      <td data-vst="${v.id}">${v.suspended ? stateBadge('', true) : '<span class="badge off">…</span>'}</td>
      <td class="right nowrap"><a class="btn sm" href="#/vm/${v.id}/console">Manage</a>
        <button class="btn sm ghost" data-susp="${v.id}" data-on="${v.suspended ? '' : 1}">${icon('pause')}${v.suspended ? 'Unsuspend' : 'Suspend'}</button>
        <button class="icon-btn" data-more="${v.id}" title="Edit / IP">${icon('edit')}</button>
        <button class="icon-btn" data-del="${v.id}" title="Delete" style="color:var(--bad)">${icon('trash')}</button></td></tr>`).join('') : '<tr><td colspan="8" class="muted">No machines yet.</td></tr>'}
    </tbody></table></div></div>`;
  list.filter((v) => !v.suspended).forEach(async (v) => { try { const st = await api('GET', `/api/vms/${v.id}/status`); const el = $(`[data-vst="${v.id}"]`); if (el) el.innerHTML = stateBadge(st.state); } catch { const el = $(`[data-vst="${v.id}"]`); if (el) el.innerHTML = '<span class="badge bad">offline</span>'; } });
  $$('[data-susp]').forEach((b) => (b.onclick = async () => {
    const on = !!b.dataset.on;
    if (on && !(await confirmBox('Suspend this machine?', 'It will be stopped and the owner cannot start or manage it until you unsuspend it.', 'Suspend'))) return;
    act(b, () => api('POST', `/api/admin/vms/${b.dataset.susp}/suspend`, { suspended: on }), on ? 'Suspended' : 'Unsuspended').then(render).catch(() => {});
  }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    const v = list.find((x) => x.id === b.dataset.del);
    if (!(await confirmBox(`Delete ${v.name}?`, 'The machine, its disk and all its port forwards will be permanently deleted.'))) return;
    try { await act(b, () => api('DELETE', `/api/admin/vms/${v.id}`), 'Machine deleted'); render(); }
    catch (e) { if (/force/.test(e.message) && (await confirmBox('Force delete?', 'The node could not be reached. Remove the machine from the panel anyway?', 'Force delete'))) act(b, () => api('DELETE', `/api/admin/vms/${v.id}?force=1`), 'Removed').then(render).catch(() => {}); }
  }));
  $$('[data-more]').forEach((b) => (b.onclick = async () => {
    const v = list.find((x) => x.id === b.dataset.more);
    const [users, nodes] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/nodes')]);
    const n = nodes.find((x) => x.id === v.nodeId);
    const free = (n ? n.ipPool : []).filter((p) => !p.vm || p.ip === v.publicIp);
    modal({ title: 'Edit ' + v.name, body: `<form id="ev">
      <label class="f"><span>Name</span><input class="input" name="name" maxlength="40" value="${esc(v.name)}" required></label>
      <label class="f"><span>Owner</span><select class="input" name="ownerId">${users.map((u) => `<option value="${u.id}" ${u.id === v.ownerId ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}</select></label>
      <label class="f"><span>Dedicated IP</span><select class="input" name="ip"><option value="">None - NAT</option>${free.map((p) => `<option ${p.ip === v.publicIp ? 'selected' : ''}>${esc(p.ip)}</option>`).join('')}</select><small>${free.length ? '' : 'Add IPs to the node pool in Nodes → Edit.'}</small></label></form>`,
      footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" form="ev">Save</button>`,
      onMount: (el, close) => { $('#ev', el).onsubmit = (e) => { e.preventDefault(); const d = formData(e.target);
        act(null, async () => { await api('PATCH', `/api/admin/vms/${v.id}`, { name: d.name, ownerId: d.ownerId }); if ((d.ip || null) !== (v.publicIp || null)) await api('POST', `/api/admin/vms/${v.id}/ip`, { ip: d.ip || null }); }, 'Saved').then(() => { close(); render(); }).catch(() => {}); }; } });
  }));
}

async function pageAdminPorts() {
  const list = await api('GET', '/api/admin/ports');
  $('#content').innerHTML = head('Ports', `${list.length} exposed port${list.length === 1 ? '' : 's'} across all nodes`) +
    `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Public address</th><th>VM port</th><th>Machine</th><th>Owner</th><th>Node</th><th>Firewall</th><th>Label</th><th>Added</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((p) => `<tr><td class="mono"><b>${esc(p.address)}</b></td><td class="mono">${p.vmPort}/${p.proto.toUpperCase()}</td>
      <td><a href="#/vm/${p.vmId}/ports">${esc(p.vmName)}</a></td><td>${esc(p.owner)}</td><td>${esc(p.nodeName)}</td>
      <td>${p.ufw === true ? '<span class="badge ok">ufw allowed</span>' : p.ufw === false ? '<span class="badge off">iptables</span>' : '<span class="badge bad">node offline</span>'}</td>
      <td>${esc(p.label || '-')}</td><td class="muted nowrap">${fmtDate(p.createdAt)}</td>
      <td class="right"><button class="icon-btn" data-del="${p.id}" title="Remove" style="color:var(--bad)">${icon('trash')}</button></td></tr>`).join('') : '<tr><td colspan="9" class="muted">No ports exposed yet.</td></tr>'}
    </tbody></table></div></div>`;
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmBox('Remove this port?', 'The forward and its firewall rule will be deleted.', 'Remove')) act(b, () => api('DELETE', `/api/admin/ports/${b.dataset.del}`), 'Port removed').then(render).catch(() => {}); }));
}

async function pageUsers() {
  const users = await api('GET', '/api/admin/users');
  $('#content').innerHTML = head('User management', `${users.length} users`, `<button class="btn" id="nu">${icon('plus')}Create user</button>`) +
    `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Login</th><th>Machines</th><th>Joined</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td><div style="display:flex;gap:10px;align-items:center"><div class="avatar" style="width:30px;height:30px;font-size:13px">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc(u.username[0].toUpperCase())}</div><b>${esc(u.username)}</b></div></td>
      <td>${esc(u.email || '-')}</td><td>${u.admin ? '<span class="badge">admin</span>' : '<span class="badge off">user</span>'}</td>
      <td>${u.github ? '<span class="badge off">GitHub</span> ' : ''}${u.discord ? '<span class="badge off">Discord</span>' : ''}${!u.github && !u.discord ? '<span class="muted">password</span>' : ''}</td>
      <td>${u.vms}</td><td class="muted nowrap">${fmtDate(u.createdAt)}</td>
      <td class="right nowrap"><button class="btn ghost sm" data-edit="${u.id}">${icon('edit')}Edit</button> ${u.id === state.me.id ? '' : `<button class="icon-btn" data-del="${u.id}" style="color:var(--bad)">${icon('trash')}</button>`}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#nu').onclick = () => modal({ title: 'Create user', body: `<form id="uf"><label class="f"><span>Username</span><input class="input" name="username" required></label><label class="f"><span>Email</span><input class="input" type="email" name="email"></label><label class="f"><span>Password</span><input class="input" type="password" name="password" minlength="6" required></label><label class="check"><input type="checkbox" name="admin"> Administrator</label></form>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" form="uf">Create user</button>`,
    onMount: (el, close) => { $('#uf', el).onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); d.admin = !!d.admin; act(null, () => api('POST', '/api/admin/users', d), 'User created').then(() => { close(); render(); }).catch(() => {}); }; } });
  $$('[data-edit]').forEach((b) => (b.onclick = () => { const u = users.find((x) => x.id === b.dataset.edit); modal({ title: 'Edit ' + u.username,
    body: `<form id="uf"><label class="f"><span>Email</span><input class="input" type="email" name="email" value="${esc(u.email)}"></label><label class="f"><span>New password</span><input class="input" type="password" name="password" placeholder="leave empty to keep"></label><label class="check"><input type="checkbox" name="admin" ${u.admin ? 'checked' : ''}> Administrator</label></form>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" form="uf">Save</button>`,
    onMount: (el, close) => { $('#uf', el).onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); d.admin = !!d.admin; if (!d.password) delete d.password; act(null, () => api('PATCH', `/api/admin/users/${u.id}`, d), 'Saved').then(() => { close(); render(); }).catch(() => {}); }; } }); }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmBox('Delete user?', 'This cannot be undone.')) act(b, () => api('DELETE', `/api/admin/users/${b.dataset.del}`), 'User deleted').then(render).catch(() => {}); }));
}

async function pageSettings() {
  const s = await api('GET', '/api/admin/settings');
  const base = s.publicUrl || s.detectedUrl;
  const oauthCard = (key, label, logo, color, doc) => `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px">
      <h3 style="display:flex;gap:10px;align-items:center;margin:0"><span class="avatar" style="width:30px;height:30px;background:${color}">${logo}</span>${label}</h3>
      <label class="switch"><input type="checkbox" data-en="${key}" ${s[key].enabled ? 'checked' : ''}><i></i></label></div>
    <p class="sub">Sign up and log in with ${label}. Create an app at <a href="${doc}" target="_blank" rel="noopener">${doc.replace('https://', '')}</a>.</p>
    <form data-oauth="${key}"><label class="f"><span>Client ID</span><input class="input mono" name="clientId" value="${esc(s[key].clientId)}"></label>
    <label class="f"><span>Client secret</span><input class="input mono" type="password" name="clientSecret" placeholder="${s[key].hasSecret ? 'saved - leave empty to keep' : ''}"></label>
    <div class="f"><span class="f-label">Callback / redirect URL</span><div class="copy"><span>${esc(base)}/auth/${key}/callback</span><button type="button" class="icon-btn" data-copy="${esc(base)}/auth/${key}/callback">${icon('copy')}</button></div></div>
    <button class="btn">Save ${label}</button></form></div>`;
  $('#content').innerHTML = head('Settings', 'Only admins can change these') + `
  <div class="grid g2" style="align-items:start">
    <div>
      <div class="card"><h3>Panel name</h3><p class="sub">Shown in the sidebar, login page and browser tab.</p>
        <form id="nf"><label class="f"><span>Name</span><input class="input" name="panelName" maxlength="40" value="${esc(s.panelName)}" required></label><button class="btn">Save name</button></form></div>
      <div class="card"><h3>Logo</h3><p class="sub">Images only (PNG, JPG, WEBP, GIF · max 5 MB). Square works best.</p>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div class="logo-prev">${s.logo ? `<img src="${esc(s.logo)}" alt="">` : 'none'}</div>
        <div class="btn-row"><label class="btn">${icon('upload')}Upload logo<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden id="up-logo"></label>${s.logo ? '<button class="btn ghost" id="rm-logo">Remove</button>' : ''}</div></div></div>
      <div class="card"><h3>Background</h3><p class="sub">An image (max 15 MB) or a video (MP4/WEBM, max 60 MB). Shown on the login page and softly behind the panel.</p>
        <div class="media-prev" style="margin-bottom:14px">${s.background ? (s.backgroundType === 'video' ? `<video src="${esc(s.background)}" autoplay muted loop playsinline></video>` : `<img src="${esc(s.background)}" alt="">`) : 'default glacier'}</div>
        <div class="btn-row"><label class="btn">${icon('upload')}Upload image or video<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" hidden id="up-bg"></label>${s.background ? '<button class="btn ghost" id="rm-bg">Remove</button>' : ''}</div></div>
    </div>
    <div>
      <div class="card"><h3>Sign up</h3><p class="sub">Let people create their own account. New accounts are normal users with no machines.</p>
        <label class="switch"><input type="checkbox" id="reg" ${s.registration ? 'checked' : ''}><i></i>Allow registration (password, GitHub and Discord)</label></div>
      ${oauthCard('github', 'GitHub', GH, '#1f2933', 'https://github.com/settings/developers')}
      ${oauthCard('discord', 'Discord', DC, '#5865f2', 'https://discord.com/developers/applications')}
      <div class="card"><h3>Panel URL</h3><p class="sub">Public address of this panel, used for the GitHub/Discord callback. Leave empty to auto-detect (<span class="mono">${esc(s.detectedUrl)}</span>).</p>
        <form id="uf"><label class="f"><input class="input mono" name="publicUrl" value="${esc(s.publicUrl)}" placeholder="https://panel.example.com"></label>
        <label class="f"><span>Max exposed ports per machine</span><input class="input" type="number" min="0" max="100" name="maxPortsPerVm" value="${s.maxPortsPerVm}"></label><button class="btn">Save</button></form></div>
    </div></div>`;
  const reload = async (msg) => { if (msg) toast(msg, true); state.settings = await api('GET', '/api/settings/public'); applyBranding(); $('#logo').innerHTML = logoHtml(); $('#pname').textContent = state.settings.panelName; pageSettings(); };
  $$('.card .avatar svg').forEach((x) => { x.style.width = '17px'; x.style.height = '17px'; });
  $$('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  $('#nf').onsubmit = (e) => { e.preventDefault(); act($('#nf .btn'), () => api('PUT', '/api/admin/settings', formData(e.target))).then(() => reload('Name saved')).catch(() => {}); };
  $('#uf').onsubmit = (e) => { e.preventDefault(); act($('#uf .btn'), () => api('PUT', '/api/admin/settings', formData(e.target))).then(() => reload('Saved')).catch(() => {}); };
  $('#reg').onchange = (e) => act(null, () => api('PUT', '/api/admin/settings', { registration: e.target.checked }), e.target.checked ? 'Registration opened' : 'Registration closed').catch(() => { e.target.checked = !e.target.checked; });
  $$('[data-oauth]').forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); const d = formData(f); if (!d.clientSecret) delete d.clientSecret; act($('.btn', f), () => api('PUT', '/api/admin/settings', { [f.dataset.oauth]: d })).then(() => reload('Saved')).catch(() => {}); }));
  $$('[data-en]').forEach((cb) => (cb.onchange = () => act(null, () => api('PUT', '/api/admin/settings', { [cb.dataset.en]: { enabled: cb.checked } }), cb.checked ? 'Enabled' : 'Disabled').catch(() => { cb.checked = !cb.checked; })));
  const up = (kind) => async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    toast('Uploading…', true);
    await act(null, () => api('POST', `/api/admin/settings/${kind}`, fd)).then(() => reload(kind === 'logo' ? 'Logo updated' : 'Background updated')).catch(() => {});
  };
  $('#up-logo').onchange = up('logo'); $('#up-bg').onchange = up('background');
  mountCfSaas();
  if ($('#rm-logo')) $('#rm-logo').onclick = () => act($('#rm-logo'), () => api('DELETE', '/api/admin/settings/logo')).then(() => reload('Logo removed')).catch(() => {});
  if ($('#rm-bg')) $('#rm-bg').onclick = () => act($('#rm-bg'), () => api('DELETE', '/api/admin/settings/background')).then(() => reload('Background removed')).catch(() => {});
}

boot();
