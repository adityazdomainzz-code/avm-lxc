// JSON file database (no native modules)
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.PANEL_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');
const DEFAULTS = {
  users: [],
  sessions: {},
  nodes: [],
  vms: [],
  ports: [],
  sites: [],
  bots: [],
  mc: [],
  settings: {
    panelName: 'AVM Panel',
    logo: '', background: '', backgroundType: '',
    registration: true,
    maxPortsPerVm: 5,
    publicUrl: '',
    github: { enabled: false, clientId: '', clientSecret: '' },
    discord: { enabled: false, clientId: '', clientSecret: '' },
    cfSaas: { ready: false, token: '', zone: '', zoneId: '', accountId: '', sub: 'sites', fallback: '', tunnelId: '', tunnelName: '', nodeId: '' },
  },
};

let data;
function load() {
  fs.mkdirSync(path.join(DIR, 'uploads'), { recursive: true });
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (data[k] === undefined) data[k] = JSON.parse(JSON.stringify(v));
    else if (k === 'settings') for (const [sk, sv] of Object.entries(v)) if (data.settings[sk] === undefined) data.settings[sk] = JSON.parse(JSON.stringify(sv));
  }
  save();
  return data;
}
function save() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
module.exports = { load, save, DIR, UPLOADS: path.join(DIR, 'uploads'), get data() { return data; } };
