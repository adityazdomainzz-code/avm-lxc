// Thin wrapper around the `docker` CLI + the Docker Engine API (unix socket) for stats
'use strict';
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');

const BIN = process.env.DOCKER_BIN || 'docker';
const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { maxBuffer: 64 * 1048576, timeout: opts.timeout || 120000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.toString().trim()) || err.message;
        return reject(Object.assign(new Error(msg.replace(/^Error( response from daemon)?:\s*/i, '')), { code: err.code, stdout }));
      }
      resolve(stdout);
    });
    child.stdin.end(opts.input !== undefined ? opts.input : undefined);
  });
}

// GET/POST against the Engine API (faster than `docker stats`, which always waits ~2s)
function api(method, path, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path, method, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let j = null; try { j = body ? JSON.parse(body) : null; } catch { j = { message: body }; }
        if (res.statusCode >= 400) return reject(Object.assign(new Error((j && j.message) || `docker api ${res.statusCode}`), { status: res.statusCode }));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker api timeout')));
    req.on('error', reject);
    req.end();
  });
}

let availCache = { at: 0, ok: false, version: null };
async function available() {
  if (Date.now() - availCache.at < 15000) return availCache;
  let ok = false, version = null;
  if (fs.existsSync(SOCK)) {
    try { const v = await api('GET', '/version', 4000); ok = true; version = v && v.Version; } catch {}
  }
  availCache = { at: Date.now(), ok, version };
  return availCache;
}

// run a shell command inside the container
function exec(name, script, args = [], opts = {}) {
  const flags = opts.input !== undefined ? ['-i'] : [];
  return run(['exec', ...flags, name, 'sh', '-c', script, 'sh', ...args], opts);
}

const inspect = (name) => api('GET', `/containers/${encodeURIComponent(name)}/json`);

module.exports = { BIN, SOCK, run, api, available, exec, inspect };
