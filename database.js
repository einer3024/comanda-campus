const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const stores = [
  { id: 'cafeteria-central', name: 'Cafetería Central', type: 'Cafetería', emoji: '☕', color: '#f3e5cf', isOpen: 1 },
  { id: 'cooperativa', name: 'La Cooperativa', type: 'Comidas y snacks', emoji: '🥪', color: '#e5ecd9', isOpen: 1 },
  { id: 'papeleria-campus', name: 'Punto y Papel', type: 'Papelería', emoji: '📚', color: '#e6e7f1', isOpen: 1 },
];

const products = [
  { id: 'cafe-casa', storeId: 'cafeteria-central', name: 'Café de la casa', category: 'Bebidas', price: 3500, emoji: '☕' },
  { id: 'jugo-corozo', storeId: 'cafeteria-central', name: 'Jugo de corozo', category: 'Bebidas', price: 5000, emoji: '🧃' },
  { id: 'arepa-huevo', storeId: 'cooperativa', name: 'Arepa de huevo', category: 'Comidas', price: 6000, emoji: '🫓' },
  { id: 'sandwich-pollo', storeId: 'cooperativa', name: 'Sándwich de pollo', category: 'Comidas', price: 9000, emoji: '🥪' },
  { id: 'empanadas', storeId: 'cooperativa', name: 'Empanadas (x2)', category: 'Snacks', price: 4500, emoji: '🥟' },
  { id: 'cuaderno', storeId: 'papeleria-campus', name: 'Cuaderno universitario', category: 'Papelería', price: 8000, emoji: '📓' },
  { id: 'lapicero', storeId: 'papeleria-campus', name: 'Lapicero tinta negra', category: 'Papelería', price: 2000, emoji: '🖊️' },
];

function createDatabase(databasePath = path.join(__dirname, 'data', 'comanda.sqlite')) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);

  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL,
      is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('customer', 'store', 'rider', 'admin')),
      store_id TEXT UNIQUE REFERENCES stores(id),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((role = 'store' AND store_id IS NOT NULL) OR (role != 'store' AND store_id IS NULL))
    );

    CREATE TABLE IF NOT EXISTS rider_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      is_available INTEGER NOT NULL DEFAULT 0 CHECK (is_available IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL REFERENCES stores(id),
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      emoji TEXT NOT NULL,
      is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL UNIQUE,
      store_id TEXT NOT NULL REFERENCES stores(id),
      customer_user_id INTEGER REFERENCES users(id),
      rider_user_id INTEGER REFERENCES users(id),
      contact_phone TEXT,
      block INTEGER NOT NULL CHECK (block BETWEEN 1 AND 99),
      floor INTEGER NOT NULL CHECK (floor BETWEEN 1 AND 4),
      classroom TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      delivery_zone TEXT NOT NULL CHECK (delivery_zone IN ('near', 'middle', 'far')),
      delivery_fee INTEGER NOT NULL CHECK (delivery_fee >= 0),
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'transfer')),
      status TEXT NOT NULL DEFAULT 'created',
      subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
      total INTEGER NOT NULL CHECK (total >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES users(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 30),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
    );

  `);

  const orderColumns = new Set(database.prepare('PRAGMA table_info(orders)').all().map((column) => column.name));
  if (!orderColumns.has('customer_user_id')) {
    database.exec('ALTER TABLE orders ADD COLUMN customer_user_id INTEGER REFERENCES users(id)');
  }
  if (!orderColumns.has('rider_user_id')) {
    database.exec('ALTER TABLE orders ADD COLUMN rider_user_id INTEGER REFERENCES users(id)');
  }
  if (!orderColumns.has('contact_phone')) {
    database.exec('ALTER TABLE orders ADD COLUMN contact_phone TEXT');
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_rider_profiles_status_availability ON rider_profiles(status, is_available);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  database.prepare(`
    INSERT OR IGNORE INTO rider_profiles (user_id, status, is_available, created_at, reviewed_at)
    SELECT id, 'approved', 1, created_at, created_at
    FROM users WHERE role = 'rider'
  `).run();

  const insertStore = database.prepare(`
    INSERT OR IGNORE INTO stores (id, name, type, emoji, color, is_open)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProduct = database.prepare(`
    INSERT OR IGNORE INTO products (id, store_id, name, category, price, emoji)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  database.exec('BEGIN');
  try {
    for (const store of stores) {
      insertStore.run(store.id, store.name, store.type, store.emoji, store.color, store.isOpen);
    }
    for (const product of products) {
      insertProduct.run(product.id, product.storeId, product.name, product.category, product.price, product.emoji);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }

  return database;
}

module.exports = { createDatabase };
