// Networking (LXC, KVM and Docker): port forwards (host port -> VM private IP:port) and dedicated public IPs (1:1 NAT)
// Uses iptables (works with iptables-nft) and adds matching ufw rules when ufw is active.
'use strict';
const { execFile } = require('child_process');

const sh = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 20000 }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '') + (stderr || '') }));
});
const TAG = ['-m', 'comment', '--comment', 'avm'];
const DRY = process.env.AVM_NET_DRY === '1'; // for testing without root

async function ipt(table, action, rule) {
  if (DRY) return { ok: true };
  return sh('iptables', ['-w', '-t', table, action, ...rule]);
}
// add a rule once (check first), or delete it
async function ensure(table, chain, rule, insert) {
  const exists = (await ipt(table, '-C', [chain, ...rule])).ok;
  if (!exists) return ipt(table, insert ? '-I' : '-A', insert ? [chain, '1', ...rule] : [chain, ...rule]);
  return { ok: true };
}
async function remove(table, chain, rule) {
  // delete every copy
  for (let i = 0; i < 5; i++) { if (!(await ipt(table, '-D', [chain, ...rule])).ok) break; }
}

let ufwCache = { at: 0, active: false };
async function ufwActive() {
  if (DRY) return false;
  if (Date.now() - ufwCache.at < 30000) return ufwCache.active;
  const r = await sh('ufw', ['status']);
  ufwCache = { at: Date.now(), active: r.ok && /Status: active/i.test(r.out) };
  return ufwCache.active;
}

function portRules(p) {
  return {
    dnat: ['-p', p.proto, '--dport', String(p.hostPort), ...TAG, '-j', 'DNAT', '--to-destination', `${p.ip}:${p.vmPort}`],
    fwd: ['-p', p.proto, '-d', p.ip, '--dport', String(p.vmPort), ...TAG, '-j', 'ACCEPT'],
  };
}

// Docker evaluates DOCKER-USER before its own (dropping) rules, so ACCEPTs must also live there
let dockerUserCache = { at: 0, ok: false };
async function hasDockerUser() {
  if (DRY) return false;
  if (Date.now() - dockerUserCache.at < 30000) return dockerUserCache.ok;
  dockerUserCache = { at: Date.now(), ok: (await ipt('filter', '-nL', ['DOCKER-USER'])).ok };
  return dockerUserCache.ok;
}
async function fwdChains() { return (await hasDockerUser()) ? ['FORWARD', 'DOCKER-USER'] : ['FORWARD']; }

// keep Incus bridge traffic flowing when Docker set the FORWARD policy to DROP
async function dockerCompat(bridge) {
  dockerUserCache.at = 0;
  if (!(await hasDockerUser())) return;
  await ensure('filter', 'DOCKER-USER', ['-i', bridge, ...TAG, '-j', 'ACCEPT'], true);
  await ensure('filter', 'DOCKER-USER', ['-o', bridge, ...TAG, '-j', 'ACCEPT'], true);
}

async function addPort(p, opts = {}) {
  const r = portRules(p);
  const a = await ensure('nat', 'PREROUTING', r.dnat);
  if (!a.ok) throw new Error('iptables failed: ' + a.out.trim());
  for (const c of await fwdChains()) await ensure('filter', c, r.fwd, true);
  if (!opts.quiet && await ufwActive()) {
    await sh('ufw', ['allow', `${p.hostPort}/${p.proto}`, 'comment', `AVM ${p.name}`]);
    await sh('ufw', ['route', 'allow', 'proto', p.proto, 'to', p.ip, 'port', String(p.vmPort), 'comment', `AVM ${p.name}`]);
  }
}
async function removePort(p) {
  const r = portRules(p);
  await remove('nat', 'PREROUTING', r.dnat);
  for (const c of await fwdChains()) await remove('filter', c, r.fwd);
  if (await ufwActive()) {
    await sh('ufw', ['delete', 'allow', `${p.hostPort}/${p.proto}`]);
    await sh('ufw', ['route', 'delete', 'allow', 'proto', p.proto, 'to', p.ip, 'port', String(p.vmPort)]);
  }
}

async function defaultIface() {
  const r = await sh('ip', ['route', 'show', 'default']);
  const m = /dev (\S+)/.exec(r.out);
  return m ? m[1] : 'eth0';
}

function ipRules(x) {
  return {
    dnat: ['-d', x.pub, ...TAG, '-j', 'DNAT', '--to-destination', x.priv],
    snat: ['-s', x.priv, ...TAG, '-j', 'SNAT', '--to-source', x.pub],
    fwd: ['-d', x.priv, ...TAG, '-j', 'ACCEPT'],
  };
}
async function addPublicIp(x, iface) {
  if (!DRY) await sh('ip', ['addr', 'add', `${x.pub}/32`, 'dev', iface || (await defaultIface())]);
  const r = ipRules(x);
  const a = await ensure('nat', 'PREROUTING', r.dnat);
  if (!a.ok) throw new Error('iptables failed: ' + a.out.trim());
  await ensure('nat', 'POSTROUTING', r.snat, true);
  for (const c of await fwdChains()) await ensure('filter', c, r.fwd, true);
  if (await ufwActive()) await sh('ufw', ['route', 'allow', 'to', x.priv, 'comment', `AVM ip ${x.pub}`]);
}
async function removePublicIp(x, iface) {
  const r = ipRules(x);
  await remove('nat', 'PREROUTING', r.dnat);
  await remove('nat', 'POSTROUTING', r.snat);
  for (const c of await fwdChains()) await remove('filter', c, r.fwd);
  if (!DRY) await sh('ip', ['addr', 'del', `${x.pub}/32`, 'dev', iface || (await defaultIface())]);
  if (await ufwActive()) await sh('ufw', ['route', 'delete', 'allow', 'to', x.priv]);
}

module.exports = { addPort, removePort, addPublicIp, removePublicIp, ufwActive, defaultIface, dockerCompat };
