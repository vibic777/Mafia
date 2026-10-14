'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function startServer(dataDir) {
  const env = { ...process.env, PORT: '0', MAFIA_DATA_DIR: path.relative(projectRoot, dataDir) };
  delete env.MAFIA_ADMIN_USERNAME; delete env.MAFIA_ADMIN_PASSWORD; delete env.MAFIA_ADMIN_CONFIG_FILE;
  const child = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString(); const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ child, url: `http://127.0.0.1:${match[1]}` }); }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { if (code) { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); } });
  });
}

async function api(baseUrl, route, body, token) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

function fakeSmtp() {
  let delivered = '';
  const server = net.createServer((socket) => {
    socket.write('220 test.local ready\r\n');
    let input = '';
    let inData = false;
    socket.on('data', (chunk) => {
      input += chunk.toString();
      if (inData) {
        const end = input.indexOf('\r\n.\r\n');
        if (end < 0) return;
        delivered = input.slice(0, end); input = input.slice(end + 5); inData = false;
        socket.write('250 queued\r\n');
      }
      while (!inData && input.includes('\r\n')) {
        const index = input.indexOf('\r\n'); const line = input.slice(0, index); input = input.slice(index + 2);
        if (/^EHLO/i.test(line)) socket.write('250-test.local\r\n250 OK\r\n');
        else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) socket.write('250 OK\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 send mail\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  return { server, getDelivered: () => delivered };
}

test('fresh setup creates the first admin and SMTP password recovery is one-time', async (t) => {
  const dataDir = path.join(projectRoot, `.test-setup-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(dataDir);
  const mailer = fakeSmtp();
  mailer.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => mailer.server.once('listening', resolve));
  const smtpPort = mailer.server.address().port;
  let child;
  t.after(async () => {
    mailer.server.close();
    if (child && child.exitCode === null) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const started = await startServer(dataDir); child = started.child;
  const setupStatus = await api(started.url, '/api/setup-status');
  assert.equal(setupStatus.payload.needsSetup, true);
  const first = await api(started.url, '/api/register', { username: 'FirstAdmin', password: 'old-pass', email: 'admin@example.com' });
  assert.equal(first.response.status, 201);
  assert.equal(first.payload.account.isAdmin, true);
  const ordinary = await api(started.url, '/api/register', { username: 'Ordinary', password: 'p', email: 'player@example.com' });
  assert.equal(ordinary.payload.account.isAdmin, false);
  assert.equal((await api(started.url, '/api/setup-status')).payload.needsSetup, false);
  const smtpSave = await api(started.url, '/api/admin/smtp', {
    host: '127.0.0.1', port: smtpPort, encryption: 'none', username: '', password: 'local-secret', from: 'no-reply@example.com',
  }, first.payload.token);
  assert.equal(smtpSave.response.status, 200, JSON.stringify(smtpSave.payload));
  assert.equal('password' in smtpSave.payload.settings.smtp, false, 'SMTP password must not be returned by the settings API');
  assert.equal(smtpSave.payload.settings.smtp.passwordConfigured, true);

  const forgot = await api(started.url, '/api/password/forgot', { email: 'admin@example.com' });
  assert.equal(forgot.response.status, 200);
  const link = mailer.getDelivered().match(/http:\/\/[^\s]+\?reset=([^\s]+)/);
  assert.ok(link, `reset link should be present in delivered message: ${mailer.getDelivered()}`);
  const token = decodeURIComponent(link[1]);
  const reset = await api(started.url, '/api/password/reset', { token, password: 'new-pass' });
  assert.equal(reset.response.status, 200);
  assert.equal((await api(started.url, '/api/me', undefined, first.payload.token)).response.status, 401, 'password reset revokes active sessions');
  assert.equal((await api(started.url, '/api/login', { username: 'FirstAdmin', password: 'old-pass' })).response.status, 401);
  assert.equal((await api(started.url, '/api/login', { username: 'FirstAdmin', password: 'new-pass' })).response.status, 200);
  const replay = await api(started.url, '/api/password/reset', { token, password: 'third-pass' });
  assert.equal(replay.response.status, 400, 'reset links can only be used once');
});
