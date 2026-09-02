#!/usr/local/bin/node
/**
 * MOBero native messaging host.
 *
 * Chrome speaks to this over stdio: 4-byte little-endian length prefix, then
 * UTF-8 JSON. All it does is translate those frames into calls on the shared
 * mining core (miner.js) and frame the result back. The miner itself keeps
 * running even after the service worker sleeps and this host exits, because
 * xmrig is spawned detached — see miner.js.
 */

'use strict';

const miner = require('./miner');

process.on('uncaughtException', (err) => {
  miner.log('crash', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  miner.log('crash-async', { message: String(err) });
  process.exit(1);
});

miner.log('launch', { argv: process.argv.slice(1), node: process.version, pid: process.pid });

// ---------------------------------------------------------------- stdio frames

function send(msg) {
  const buf = Buffer.from(JSON.stringify(msg), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([len, buf]));
}

let inbox = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4) {
    const len = inbox.readUInt32LE(0);
    if (inbox.length < 4 + len) break;
    const body = inbox.subarray(4, 4 + len).toString('utf8');
    inbox = inbox.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      send({ ok: false, error: `bad json: ${err.message}` });
      continue;
    }
    miner.log('cmd', { cmd: msg.cmd });
    send(handle(msg));
  }
});
process.stdin.on('end', () => {
  miner.log('stdin-end');
  process.exit(0);
});

// -------------------------------------------------------------------- commands

function handle(msg) {
  switch (msg.cmd) {
    case 'ping':
      return { ok: true, cmd: 'ping', host: '0.1.0', node: process.version };
    case 'probe':
      return miner.probe();
    case 'start':
      return miner.start(msg.config || {});
    case 'stop':
      return miner.stop();
    case 'status':
      return miner.status();
    default:
      return { ok: false, error: `unknown cmd: ${msg.cmd}` };
  }
}

send({ ok: true, cmd: 'hello', host: '0.1.0' });
