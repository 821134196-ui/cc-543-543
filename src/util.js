'use strict';
const crypto = require('node:crypto');

let counter = 0;
function id(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${process.pid.toString(36)}${counter.toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function now(clock) {
  return clock ? clock() : new Date().toISOString();
}

function yuan(cents) {
  return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { id, now, yuan };
