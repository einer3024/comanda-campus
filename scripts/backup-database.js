const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createBackup(
  databasePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'comanda.sqlite'),
  backupDirectory = process.env.BACKUP_DIRECTORY || path.join(__dirname, '..', 'backups'),
) {
  const sourcePath = path.resolve(databasePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`No se encontró la base de datos: ${sourcePath}`);
  }
  const destinationDirectory = path.resolve(backupDirectory);
  fs.mkdirSync(destinationDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `comanda-${timestamp}`;
  let destinationPath = path.join(destinationDirectory, `${baseName}.sqlite`);
  let suffix = 1;
  while (fs.existsSync(destinationPath)) {
    destinationPath = path.join(destinationDirectory, `${baseName}-${suffix}.sqlite`);
    suffix += 1;
  }

  const database = new DatabaseSync(sourcePath);
  try {
    database.prepare('VACUUM INTO ?').run(destinationPath);
  } finally {
    database.close();
  }
  return destinationPath;
}

if (require.main === module) {
  try {
    console.log(`Copia creada: ${createBackup()}`);
  } catch (error) {
    console.error(`No se pudo crear la copia: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createBackup };
