'use strict';

const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  throw new Error(`Для SQLite-хранилища нужна Node.js 22.13 или новее (текущая: ${process.version}): ${error.message}`);
}

const STATE_KEYS = ['rooms', 'accounts', 'sessions', 'bans', 'adminLog', 'gameSettings'];

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'mafia.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const migrations = db.prepare('SELECT version FROM schema_migrations');
  const applied = new Set(migrations.all().map((row) => row.version));
  if (!applied.has(1)) {
    const insert = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
    const legacyFiles = {
      rooms: 'rooms.json', accounts: 'accounts.json', sessions: 'sessions.json',
      bans: 'bans.json', adminLog: 'admin-log.json', gameSettings: 'game-settings.json'
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const key of STATE_KEYS) {
        const file = path.join(dataDir, legacyFiles[key]);
        if (!fs.existsSync(file)) continue;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        insert.run(key, JSON.stringify(value));
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw new Error(`Не удалось безопасно перенести JSON в SQLite; исходные файлы сохранены: ${error.message}`);
    }
  }
  const read = db.prepare('SELECT value FROM app_state WHERE key = ?');
  const write = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    db,
    dbPath,
    load(key, fallback = {}) {
      const row = read.get(key);
      return row ? JSON.parse(row.value) : fallback;
    },
    save(key, value) {
      write.run(key, JSON.stringify(value));
    }
  };
}

module.exports = { openStore, STATE_KEYS };
