'use strict';
const fs = require('node:fs');
const path = require('node:path');
function status(stage, error) {
  const message = String(error?.message || '');
  const known = ['JWT_SECRET must contain at least 32 random characters', 'DATABASE_URL is required', 'Set explicit FRONTEND_ORIGIN values in production', 'Production FRONTEND_ORIGIN must use HTTPS', 'Invalid PORT', 'Invalid TRUST_PROXY_HOPS'];
  const reason = known.find(value => message.includes(value)) ||
    (message.includes('Cannot find module') ? 'MODULE_NOT_FOUND' :
    message.includes('password authentication failed') ? 'DATABASE_AUTH_FAILED' :
    message.includes('no pg_hba.conf entry') ? 'DATABASE_ACCESS_DENIED' : 'UNCLASSIFIED');
  const code = /^[A-Z0-9_]{1,40}$/.test(error?.code || '') ? error.code : undefined;
  try { fs.writeFileSync(path.join(__dirname, 'startup-status.json'), JSON.stringify({stage, reason: error ? reason : undefined, code, time: new Date().toISOString()}), {mode: 0o600}); } catch {}
}
status('entry');
try {
  require('dotenv').config({path: path.join(__dirname, '.env')});
  status('environment-loaded');
  const { start } = require('./dist/main.js');
  status('module-loaded');
  start().then(() => status('running')).catch(error => {
    status('start-failed', error);
    console.error('CRM startup failed; see startup-status.json and Passenger log');
    process.exitCode = 1;
  });
} catch (error) {
  status('load-failed', error);
  console.error('CRM module load failed; see startup-status.json and Passenger log');
  throw error;
}
