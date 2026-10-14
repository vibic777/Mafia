'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openStore } = require('../storage');

test('SQLite backup can restore state and preserves the replaced database', (t) => {
  const root = path.join(__dirname, '..');
  const dirName = `.test-backup-${process.pid}-${Date.now()}`;
  const dataDir = path.join(root, dirName);
  const backup = path.join(dataDir, 'backup.sqlite');
  fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = openStore(dataDir); first.save('accounts', { alice: { username: 'Alice' } }); first.db.close();
  const env = { ...process.env, MAFIA_DATA_DIR: dirName };
  const created = spawnSync(process.execPath, [path.join(root, 'backup-db.js'), path.relative(root, backup)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const changed = openStore(dataDir); changed.save('accounts', { bob: { username: 'Bob' } }); changed.db.close();
  const restored = spawnSync(process.execPath, [path.join(root, 'restore-db.js'), path.relative(root, backup)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  const check = openStore(dataDir);
  assert.deepEqual(check.load('accounts'), { alice: { username: 'Alice' } });
  check.db.close();
  assert.ok(fs.readdirSync(dataDir).some((name) => name.includes('.before-restore-')));
});
