'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openStore } = require('../storage');

test('storage migrates existing JSON once and keeps source files as backups', (t) => {
  const dir = path.join(__dirname, '..', `.test-storage-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = { R: { code: 'R', players: [] } };
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify(legacy));
  const store = openStore(dir);
  assert.deepEqual(store.load('rooms'), legacy);
  assert.equal(fs.existsSync(path.join(dir, 'rooms.json')), true);
  store.save('rooms', { NEXT: { code: 'NEXT' } });
  store.db.close();
  const reopened = openStore(dir);
  assert.deepEqual(reopened.load('rooms'), { NEXT: { code: 'NEXT' } });
  reopened.db.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')), legacy);
});
