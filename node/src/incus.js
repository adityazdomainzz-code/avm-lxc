// Thin wrapper around the `incus` CLI
'use strict';
const { execFile, spawn } = require('child_process');

const BIN = process.env.INCUS_BIN || 'incus';

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { maxBuffer: 64 * 1048576, timeout: opts.timeout || 120000, encoding: opts.binary ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.toString().trim()) || err.message;
        return reject(Object.assign(new Error(msg.replace(/^Error:\s*/, '')), { code: err.code, stdout }));
      }
      resolve(stdout);
    });
    // ALWAYS close stdin: `incus init/launch` read YAML config from stdin when it is not a
    // terminal and would wait forever ("Downloading image…" that never finishes).
    child.stdin.end(opts.input !== undefined ? opts.input : undefined);
  });
}

async function json(args, opts) { return JSON.parse(await run(args, opts)); }
const query = (path) => json(['query', path]);

// run a shell command inside the instance
function exec(name, script, args = [], opts = {}) {
  return run(['exec', name, '--', 'sh', '-c', script, 'sh', ...args], opts);
}

// spawn for streaming (used by file download)
function spawnIncus(args) { return spawn(BIN, args); }

module.exports = { BIN, run, json, query, exec, spawnIncus };
