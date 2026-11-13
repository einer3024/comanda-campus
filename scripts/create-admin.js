const { createInterface } = require('node:readline');
const path = require('node:path');
const { createDatabase } = require('../database');
const { hashPassword } = require('../auth');

function ask(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => readline.question(question, (answer) => {
    readline.close();
    resolve(answer.trim());
  }));
}

function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Ejecuta este comando en una terminal interactiva para proteger la contraseña.');
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          input.setRawMode(false);
          input.off('data', onData);
          reject(new Error('Operación cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          input.setRawMode(false);
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error('Ejecuta `npm run create-admin` desde una terminal interactiva.');
  }
  const databasePath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : undefined;
  const database = createDatabase(databasePath);
  try {
    const adminCount = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
    if (adminCount > 0) {
      throw new Error('Ya existe un administrador. Crea cuentas adicionales desde el panel de administración.');
    }

    const name = await ask('Nombre del administrador: ');
    const email = (await ask('Correo del administrador: ')).toLowerCase();
    const password = await askHidden('Contraseña (mínimo 12 caracteres): ');
    const confirmation = await askHidden('Confirma la contraseña: ');
    if (name.length < 2 || name.length > 80) throw new Error('El nombre debe tener entre 2 y 80 caracteres.');
    if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Escribe un correo electrónico válido.');
    }
    if (password.length < 12 || password.length > 200) {
      throw new Error('La contraseña debe tener entre 12 y 200 caracteres.');
    }
    if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');

    const passwordHash = await hashPassword(password);
    database.prepare(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(name, email, passwordHash);
    console.log(`Administrador creado: ${email}`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
