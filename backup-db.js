'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync, backup } = require('node:sqlite');

const ROOT = __dirname;
const requested = process.argv[2];
const requestedDataDir = process.env.MAFIA_DATA_DIR;
const dataDir = requestedDataDir ? path.resolve(ROOT, requestedDataDir) : path.join(ROOT, 'data');
if (dataDir !== ROOT && !dataDir.startsWith(ROOT + path.sep)) throw new Error('Папка данных должна находиться внутри проекта');
const source = path.join(dataDir, 'mafia.sqlite');
if (!fs.existsSync(source)) throw new Error(`База данных не найдена: ${source}`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.resolve(ROOT, requested || path.join(path.relative(ROOT, dataDir), 'backups', `mafia-${stamp}.sqlite`));
if (!destination.startsWith(ROOT + path.sep)) throw new Error('Файл резервной копии должен находиться внутри папки проекта');
fs.mkdirSync(path.dirname(destination), { recursive: true });

async function main() {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); }
  finally { db.close(); }
  console.log(`Резервная копия создана: ${path.relative(ROOT, destination)}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
