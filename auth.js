const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, keyHex] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createSession(database, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashSessionToken(token), userId, expiresAt);
  return { token, expiresAt };
}

function getUserForSession(database, token) {
  if (!token || token.length > 100) return null;
  const tokenHash = hashSessionToken(token);
  const now = new Date().toISOString();
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  const user = database.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.store_id AS storeId,
           CASE WHEN u.role = 'rider' THEN 'approved' ELSE rp.status END AS riderStatus,
           CASE WHEN rp.is_available = 1 THEN 1 ELSE 0 END AS riderAvailable
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN rider_profiles rp ON rp.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1
  `).get(tokenHash, now);
  return user ? { ...user, riderAvailable: Boolean(user.riderAvailable) } : null;
}

module.exports = {
  createSession,
  getUserForSession,
  hashPassword,
  hashSessionToken,
  verifyPassword,
};
