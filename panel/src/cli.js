// Usage: node src/cli.js <username> <password> [email]
// Creates an admin user, or resets the password + grants admin if the user exists.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const D = db.load();
const [username, password, email] = process.argv.slice(2);
if (!username || !password || password.length < 6) { console.log('Usage: node src/cli.js <username> <password(min 6)> [email]'); process.exit(1); }
const u = D.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
if (u) { u.password = bcrypt.hashSync(password, 10); u.admin = true; console.log('Password reset + admin granted for', username); }
else { D.users.push({ id: crypto.randomUUID(), username, email: email || '', password: bcrypt.hashSync(password, 10), admin: true, createdAt: Date.now() }); console.log('Admin created:', username); }
db.save();
console.log('Now run: pm2 restart avm-panel');
