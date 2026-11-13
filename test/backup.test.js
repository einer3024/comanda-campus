const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { createBackup } = require('../scripts/backup-database');
const { createDatabase } = require('../database');

test('crea una copia SQLite íntegra sin cerrar la base original', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comanda-backup-'));
  const databasePath = path.join(directory, 'source.sqlite');
  const database = createDatabase(databasePath);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const backupPath = createBackup(databasePath, path.join(directory, 'backups'));
  const backup = new DatabaseSync(backupPath);
  try {
    assert.equal(Object.values(backup.prepare('PRAGMA integrity_check').get())[0], 'ok');
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM stores').get().count, 3);
  } finally {
    backup.close();
  }
});
