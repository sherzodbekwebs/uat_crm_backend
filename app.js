
'use strict';

require('dotenv/config');

const { start } = require('./dist/main.js');

start().catch((error) => {
  console.error('CRM backend startup error:', error);
  process.exitCode = 1;
});
