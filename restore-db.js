'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const backupPath = path.resolve(ROOT, process.argv[2] || '');
const requestedDataDir = process.env.MAFIA_DATA_DIR;
const dataDir = requestedDataDir ? path.resolve(ROOT, requestedDataDir) : path.join(ROOT, 'data');
if (dataDir !== ROOT && !dataDir.startsWith(ROOT + path.sep)) throw new Error('Папка данных должна находиться внутри проекта');
const targetPath = path.join(dataDir, 'mafia.sqlite');
if (!process.argv[2] || !backupPath.startsWith(ROOT + path.sep) || !fs.existsSync(backupPath)) {
  throw new Error('Укажите существующий файл .sqlite с резервной копией внутри папки проекта');
}
if (backupPath === targetPath) throw new Error('Файл источника совпадает с рабочей базой');
const check = new DatabaseSync(backupPath, { readOnly: true });
try {
  const result = check.prepare('PRAGMA integrity_check').get();
  if (result.integrity_check !== 'ok') throw new Error(`Копия повреждена: ${result.integrity_check}`);
} finally { check.close(); }
if (fs.existsSync(targetPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(targetPath, `${targetPath}.before-restore-${stamp}`);
}
fs.copyFileSync(backupPath, targetPath);
console.log('Резервная копия восстановлена. Перед запуском игры проверьте базу и сохранённые аккаунты.');
