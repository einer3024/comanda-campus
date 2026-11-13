const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  createSession,
  getUserForSession,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} = require('./auth');
const { createDatabase } = require('./database');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = 'comanda_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DELIVERY_FEES = Object.freeze({ near: 2000, middle: 3000, far: 4000 });
const ROLE_NAMES = Object.freeze({
  customer: 'Usuario',
  store: 'Tienda',
  rider: 'Domiciliario',
  admin: 'Administrador',
});
const ORDER_STATUS_NAMES = Object.freeze({
  created: 'Recibido',
  confirmed: 'Confirmado',
  preparing: 'Preparando',
  ready: 'Listo para recoger',
  accepted: 'Aceptado por domiciliario',
  on_route: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
});
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'El contenido debe enviarse como JSON.');
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpError(413, 'La solicitud supera el tamaño permitido.');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'El JSON de la solicitud no es válido.');
  }
}

function requireRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'El contenido de la solicitud no es válido.');
  }
  return value;
}

function parseCookies(request) {
  const cookies = new Map();
  for (const part of (request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }
  return cookies;
}

function sessionCookie(token, secure = false) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure = false) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleName: ROLE_NAMES[user.role],
    storeId: user.storeId || null,
    riderStatus: user.role === 'rider' ? 'approved' : user.riderStatus || null,
    riderAvailable: Boolean(user.riderAvailable),
  };
}

function requireUser(user) {
  if (!user) throw new HttpError(401, 'Inicia sesión para continuar.');
  return user;
}

function hasRiderAccess(user) {
  return user.role === 'rider' || user.riderStatus === 'approved';
}

function requireRole(user, roles) {
  requireUser(user);
  if (!roles.includes(user.role) && !(roles.includes('rider') && hasRiderAccess(user))) {
    throw new HttpError(403, 'No tienes permiso para esta acción.');
  }
}

function addNotification(database, userId, orderId, title, message) {
  if (!userId) return;
  database.prepare(`
    INSERT INTO notifications (user_id, order_id, title, message)
    VALUES (?, ?, ?, ?)
  `).run(userId, orderId, title, message);
}

function listNotifications(database, userId) {
  return database.prepare(`
    SELECT n.id, n.title, n.message, n.created_at AS createdAt, n.read_at AS readAt,
           o.order_code AS orderCode
    FROM notifications n
    JOIN orders o ON o.id = n.order_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 50
  `).all(userId);
}

function normalizeColombianPhone(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 24 || !/^[+()\d\s-]+$/.test(value.trim())) {
    throw new HttpError(400, 'Escribe un celular colombiano válido.');
  }
  const digits = value.replace(/\D/g, '');
  const localNumber = digits.length === 12 && digits.startsWith('57') ? digits.slice(2) : digits;
  if (!/^3\d{9}$/.test(localNumber)) {
    throw new HttpError(400, 'El celular debe tener 10 dígitos y comenzar por 3.');
  }
  return `+57${localNumber}`;
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
  if (origin !== expected) throw new HttpError(403, 'Origen de solicitud no permitido.');
}

function validateAccount(nameValue, emailValue, password) {
  const name = typeof nameValue === 'string' ? nameValue.trim() : '';
  const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase() : '';
  if (name.length < 2 || name.length > 80) {
    throw new HttpError(400, 'El nombre debe tener entre 2 y 80 caracteres.');
  }
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Escribe un correo electrónico válido.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    throw new HttpError(400, 'La contraseña debe tener entre 12 y 200 caracteres.');
  }
  return { name, email };
}

function createOrder(database, payload, customer) {
  const body = requireRecord(payload);
  const block = Number(body.block);
  const floor = Number(body.floor);
  const classroom = typeof body.classroom === 'string' ? body.classroom.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const contactPhone = normalizeColombianPhone(body.contactPhone);
  const deliveryZone = body.deliveryZone;
  const paymentMethod = body.paymentMethod;

  if (!Number.isInteger(block) || block < 1 || block > 99) {
    throw new HttpError(400, 'Selecciona un bloque válido.');
  }
  if (!Number.isInteger(floor) || floor < 1 || floor > 4) {
    throw new HttpError(400, 'Selecciona un piso entre 1 y 4.');
  }
  if (!/^[\p{L}\p{N}-]{1,12}$/u.test(classroom)) {
    throw new HttpError(400, 'Escribe un aula válida.');
  }
  if (note.length > 120) {
    throw new HttpError(400, 'La indicación no puede superar 120 caracteres.');
  }
  if (!Object.hasOwn(DELIVERY_FEES, deliveryZone)) {
    throw new HttpError(400, 'Selecciona una zona de entrega válida.');
  }
  if (!['cash', 'transfer'].includes(paymentMethod)) {
    throw new HttpError(400, 'Selecciona un método de pago válido.');
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 30) {
    throw new HttpError(400, 'El pedido debe incluir entre 1 y 30 productos.');
  }

  const quantities = new Map();
  for (const item of body.items) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      item.productId.length > 40 ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 30
    ) {
      throw new HttpError(400, 'Hay un producto o una cantidad no válida.');
    }
    quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  }

  const findProduct = database.prepare(`
    SELECT p.id, p.name, p.price, p.store_id AS storeId, s.name AS storeName
    FROM products p
    JOIN stores s ON s.id = p.store_id
    WHERE p.id = ? AND p.is_available = 1 AND s.is_open = 1
  `);
  const selectedProducts = [];
  const storeIds = new Set();
  let subtotal = 0;
  for (const [productId, quantity] of quantities) {
    if (quantity > 30) {
      throw new HttpError(400, 'La cantidad máxima por producto es 30.');
    }
    const product = findProduct.get(productId);
    if (!product) {
      throw new HttpError(400, 'Uno de los productos no está disponible.');
    }
    storeIds.add(product.storeId);
    subtotal += product.price * quantity;
    selectedProducts.push({ ...product, quantity });
  }
  if (storeIds.size !== 1) {
    throw new HttpError(400, 'Cada pedido debe incluir productos de un solo establecimiento.');
  }

  const storeId = selectedProducts[0].storeId;
  const deliveryFee = DELIVERY_FEES[deliveryZone];
  const total = subtotal + deliveryFee;
  const orderCode = `CMD-${randomUUID().slice(0, 8).toUpperCase()}`;
  let orderId;

  database.exec('BEGIN IMMEDIATE');
  try {
    const orderResult = database.prepare(`
      INSERT INTO orders (
        order_code, store_id, customer_user_id, contact_phone, block, floor, classroom,
        note, delivery_zone, delivery_fee, payment_method, subtotal, total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderCode, storeId, customer.id, contactPhone, block, floor, classroom, note, deliveryZone,
      deliveryFee, paymentMethod, subtotal, total,
    );
    orderId = Number(orderResult.lastInsertRowid);
    database.prepare(`
      INSERT INTO order_events (order_id, actor_user_id, from_status, to_status)
      VALUES (?, ?, NULL, 'created')
    `).run(orderId, customer.id);

    const insertItem = database.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const product of selectedProducts) {
      insertItem.run(orderId, product.id, product.name, product.quantity, product.price);
    }
    const storeUser = database.prepare(`
      SELECT id FROM users WHERE store_id = ? AND role = 'store' AND is_active = 1
    `).get(storeId);
    addNotification(
      database,
      storeUser && storeUser.id,
      orderId,
      'Nuevo pedido',
      `Recibiste el pedido ${orderCode}. Revisa los detalles y confírmalo.`,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return {
    orderCode,
    store: selectedProducts[0].storeName,
    block,
    floor,
    classroom,
    note,
    deliveryZone,
    deliveryFee,
    paymentMethod,
    status: 'created',
    subtotal,
    total,
    items: selectedProducts,
  };
}

function listOrders(database, user, { asRider = false } = {}) {
  const riderView = asRider || user.role === 'rider';
  let where;
  let values;
  if (user.role === 'customer' && !asRider) {
    where = 'o.customer_user_id = ?';
    values = [user.id];
  } else if (user.role === 'store') {
    where = 'o.store_id = ?';
    values = [user.storeId];
  } else if (riderView) {
    where = "((o.status = 'ready' AND o.rider_user_id IS NULL AND ? = 1) OR o.rider_user_id = ?)";
    values = [user.riderAvailable ? 1 : 0, user.id];
  } else {
    where = '1 = 1';
    values = [];
  }
  const orders = database.prepare(`
    SELECT o.id, o.order_code AS orderCode, s.name AS storeName, o.block, o.floor,
           o.classroom, o.note, o.contact_phone AS contactPhone,
           o.rider_user_id AS riderUserId,
           customer.name AS customerName,
           o.delivery_zone AS deliveryZone, o.delivery_fee AS deliveryFee,
           o.payment_method AS paymentMethod, o.status, o.subtotal, o.total,
           o.created_at AS createdAt, rider.name AS riderName
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    LEFT JOIN users rider ON rider.id = o.rider_user_id
    LEFT JOIN users customer ON customer.id = o.customer_user_id
    WHERE ${where}
    ORDER BY o.created_at DESC
    LIMIT 100
  `).all(...values);
  const findItems = database.prepare(`
    SELECT product_name AS name, quantity, unit_price AS unitPrice
    FROM order_items WHERE order_id = ?
  `);
  const findEvents = database.prepare(`
    SELECT e.from_status AS fromStatus, e.to_status AS toStatus,
           e.created_at AS createdAt, u.name AS actorName, u.role AS actorRole
    FROM order_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.order_id = ?
    ORDER BY e.id
  `);
  for (const order of orders) {
    if (user.role === 'admin') {
      order.customerName = null;
      order.contactPhone = null;
      order.note = '';
    } else if (
      ((user.role === 'store' || riderView) && ['delivered', 'cancelled'].includes(order.status)) ||
      (riderView && order.riderUserId !== user.id)
    ) {
      order.contactPhone = null;
    }
    delete order.riderUserId;
    order.items = findItems.all(order.id);
    order.events = findEvents.all(order.id);
  }
  return orders;
}

function changeOrderStatus(database, orderCode, nextStatus, actor, actorRole = actor.role) {
  const order = database.prepare(`
    SELECT id, store_id AS storeId, customer_user_id AS customerUserId,
           rider_user_id AS riderUserId, status
    FROM orders WHERE order_code = ?
  `).get(orderCode);
  if (!order) throw new HttpError(404, 'No se encontró el pedido.');

  const storeTransitions = {
    created: ['confirmed', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['ready'],
  };
  const riderTransitions = {
    accepted: ['on_route'],
    on_route: ['delivered'],
  };

  if (actorRole === 'customer') {
    if (order.customerUserId !== actor.id) throw new HttpError(404, 'No se encontró el pedido.');
    if (nextStatus !== 'cancelled' || !['created', 'confirmed'].includes(order.status)) {
      throw new HttpError(409, 'Solo puedes cancelar el pedido antes de que la tienda inicie la preparación.');
    }
  } else if (actorRole === 'store') {
    if (order.storeId !== actor.storeId) throw new HttpError(404, 'No se encontró el pedido.');
    if (!(storeTransitions[order.status] || []).includes(nextStatus)) {
      throw new HttpError(409, 'El pedido no puede avanzar a ese estado.');
    }
  } else if (actorRole === 'rider') {
    const mayClaim = order.status === 'ready' && !order.riderUserId && nextStatus === 'accepted';
    const ownsOrder = order.riderUserId === actor.id;
    if (mayClaim && !actor.riderAvailable) {
      throw new HttpError(409, 'Activa tu disponibilidad antes de aceptar pedidos.');
    }
    if (!mayClaim && !ownsOrder) throw new HttpError(409, 'El pedido ya no está disponible para ti.');
    if (!mayClaim && !(riderTransitions[order.status] || []).includes(nextStatus)) {
      throw new HttpError(409, 'El pedido no puede avanzar a ese estado.');
    }
  } else if (actorRole === 'admin') {
    if (nextStatus !== 'cancelled' || ['delivered', 'cancelled'].includes(order.status)) {
      throw new HttpError(409, 'El cambio de estado no está permitido.');
    }
  } else {
    throw new HttpError(403, 'No tienes permiso para cambiar pedidos.');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    if (actorRole === 'rider' && nextStatus === 'accepted') {
      const result = database.prepare(`
        UPDATE orders SET rider_user_id = ?, status = 'accepted'
        WHERE id = ? AND status = 'ready' AND rider_user_id IS NULL
      `).run(actor.id, order.id);
      if (result.changes !== 1) throw new HttpError(409, 'Otro domiciliario aceptó primero este pedido.');
    } else {
      const result = database.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?')
        .run(nextStatus, order.id, order.status);
      if (result.changes !== 1) throw new HttpError(409, 'El pedido cambió. Actualiza la lista e inténtalo de nuevo.');
    }
    database.prepare(`
      INSERT INTO order_events (order_id, actor_user_id, from_status, to_status)
      VALUES (?, ?, ?, ?)
    `).run(order.id, actor.id, order.status, nextStatus);
    const updatedStatus = ORDER_STATUS_NAMES[nextStatus] || nextStatus;
    if (actorRole === 'customer') {
      const storeUser = database.prepare(`
        SELECT id FROM users WHERE store_id = ? AND role = 'store' AND is_active = 1
      `).get(order.storeId);
      addNotification(
        database,
        storeUser && storeUser.id,
        order.id,
        'Pedido cancelado',
        `El usuario canceló el pedido ${orderCode}.`,
      );
    } else {
      addNotification(
        database,
        order.customerUserId,
        order.id,
        `Pedido ${updatedStatus.toLowerCase()}`,
        `Tu pedido ${orderCode} ahora está: ${updatedStatus}.`,
      );
    }
    if (nextStatus === 'ready') {
      const riders = database.prepare(`
        SELECT rp.user_id AS id
        FROM rider_profiles rp
        JOIN users u ON u.id = rp.user_id
        WHERE rp.status = 'approved' AND rp.is_available = 1 AND u.is_active = 1
      `).all();
      for (const rider of riders) {
        addNotification(
          database,
          rider.id,
          order.id,
          'Pedido disponible',
          `El pedido ${orderCode} está listo para recoger.`,
        );
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { orderCode, status: nextStatus };
}

function applyToBeRider(database, userId) {
  const profile = database.prepare(`
    SELECT status FROM rider_profiles WHERE user_id = ?
  `).get(userId);
  if (profile && profile.status !== 'rejected') {
    throw new HttpError(409, profile.status === 'approved'
      ? 'Tu perfil de domiciliario ya está aprobado.'
      : 'Tu solicitud ya está pendiente de revisión.');
  }
  database.prepare(`
    INSERT INTO rider_profiles (user_id, status, is_available)
    VALUES (?, 'pending', 0)
    ON CONFLICT(user_id) DO UPDATE SET
      status = 'pending',
      is_available = 0,
      created_at = datetime('now'),
      reviewed_at = NULL,
      reviewed_by = NULL
  `).run(userId);
  return { status: 'pending' };
}

function listRiderApplications(database) {
  return database.prepare(`
    SELECT rp.user_id AS userId, u.name, u.email,
           rp.status, rp.created_at AS createdAt
    FROM rider_profiles rp
    JOIN users u ON u.id = rp.user_id
    WHERE rp.status = 'pending' AND u.is_active = 1
    ORDER BY rp.created_at, rp.user_id
  `).all();
}

function reviewRiderApplication(database, userId, status, reviewerId) {
  if (!['approved', 'rejected'].includes(status)) {
    throw new HttpError(400, 'La decisión de la solicitud no es válida.');
  }
  const application = database.prepare(`
    SELECT rp.status, u.role, u.is_active AS isActive
    FROM rider_profiles rp
    JOIN users u ON u.id = rp.user_id
    WHERE rp.user_id = ?
  `).get(userId);
  if (!application) throw new HttpError(404, 'No se encontró la solicitud.');
  if (!application.isActive) throw new HttpError(409, 'La cuenta está inactiva y no puede recibir una decisión.');
  if (application.role !== 'customer' || application.status !== 'pending') {
    throw new HttpError(409, 'La solicitud ya fue revisada o no está disponible.');
  }
  const result = database.prepare(`
    UPDATE rider_profiles
    SET status = ?, is_available = 0, reviewed_at = datetime('now'), reviewed_by = ?
    WHERE user_id = ? AND status = 'pending'
  `).run(status, reviewerId, userId);
  if (result.changes !== 1) throw new HttpError(409, 'La solicitud ya fue revisada.');
  return { userId, status, isAvailable: false };
}

function setRiderAvailability(database, userId, isAvailable) {
  if (typeof isAvailable !== 'boolean') {
    throw new HttpError(400, 'Indica si quieres activar o pausar tu disponibilidad.');
  }
  const result = database.prepare(`
    UPDATE rider_profiles
    SET is_available = ?
    WHERE user_id = ? AND status = 'approved'
  `).run(isAvailable ? 1 : 0, userId);
  if (result.changes !== 1) {
    throw new HttpError(403, 'Tu perfil de domiciliario todavía no está aprobado.');
  }
  return { status: 'approved', isAvailable };
}

function listAdminUsers(database) {
  return database.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.store_id AS storeId,
           s.name AS storeName, u.is_active AS isActive, u.created_at AS createdAt,
           rp.status AS riderStatus
    FROM users u LEFT JOIN stores s ON s.id = u.store_id
    LEFT JOIN rider_profiles rp ON rp.user_id = u.id
    ORDER BY u.created_at DESC
  `).all().map((user) => ({
    ...user,
    roleName: ROLE_NAMES[user.role],
    riderStatus: user.role === 'rider' ? 'approved' : user.riderStatus,
  }));
}

function getStoreProfile(database, storeId) {
  const store = database.prepare(`
    SELECT id, name, type, emoji, color, is_open AS isOpen
    FROM stores WHERE id = ?
  `).get(storeId);
  if (!store) throw new HttpError(404, 'No se encontró la tienda.');
  return { ...store, isOpen: Boolean(store.isOpen) };
}

function listStoreProducts(database, storeId) {
  return database.prepare(`
    SELECT id, name, category, price, emoji, is_available AS isAvailable
    FROM products WHERE store_id = ?
    ORDER BY category, name
  `).all(storeId).map((product) => ({ ...product, isAvailable: Boolean(product.isAvailable) }));
}

function createStoreProduct(database, storeId, payload) {
  const body = requireRecord(payload);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const price = body.price;
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (name.length < 2 || name.length > 100) {
    throw new HttpError(400, 'El nombre del producto debe tener entre 2 y 100 caracteres.');
  }
  if (!['Comidas', 'Bebidas', 'Snacks', 'Papelería'].includes(category)) {
    throw new HttpError(400, 'Selecciona una categoría válida.');
  }
  if (!Number.isInteger(price) || price < 0 || price > 1000000) {
    throw new HttpError(400, 'El precio debe ser un valor entero entre $0 y $1.000.000.');
  }
  if (emoji.length > 12) throw new HttpError(400, 'El ícono no es válido.');
  const productId = `store-${randomUUID()}`;
  database.prepare(`
    INSERT INTO products (id, store_id, name, category, price, emoji)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(productId, storeId, name, category, price, emoji || '🍽️');
  return { id: productId, name, category, price, emoji: emoji || '🍽️', isAvailable: true };
}

function updateStoreProduct(database, storeId, productId, payload) {
  const body = requireRecord(payload);
  const updates = [];
  const values = [];
  if (Object.hasOwn(body, 'price')) {
    if (!Number.isInteger(body.price) || body.price < 0 || body.price > 1000000) {
      throw new HttpError(400, 'El precio debe ser un valor entero entre $0 y $1.000.000.');
    }
    updates.push('price = ?');
    values.push(body.price);
  }
  if (Object.hasOwn(body, 'isAvailable')) {
    if (typeof body.isAvailable !== 'boolean') throw new HttpError(400, 'La disponibilidad debe ser verdadera o falsa.');
    updates.push('is_available = ?');
    values.push(body.isAvailable ? 1 : 0);
  }
  if (updates.length === 0) throw new HttpError(400, 'Indica el precio o la disponibilidad que deseas cambiar.');
  values.push(productId, storeId);
  const result = database.prepare(`
    UPDATE products SET ${updates.join(', ')}
    WHERE id = ? AND store_id = ?
  `).run(...values);
  if (result.changes !== 1) throw new HttpError(404, 'No se encontró el producto de esta tienda.');
  return database.prepare(`
    SELECT id, name, category, price, emoji, is_available AS isAvailable
    FROM products WHERE id = ?
  `).get(productId);
}

function listAdminStores(database) {
  return database.prepare(`
    SELECT s.id, s.name, s.type, s.emoji, s.is_open AS isOpen,
           u.name AS accountName, u.email AS accountEmail,
           (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS productCount
    FROM stores s
    LEFT JOIN users u ON u.store_id = s.id AND u.role = 'store'
    ORDER BY s.name
  `).all().map((store) => ({ ...store, isOpen: Boolean(store.isOpen) }));
}

function createAdminStore(database, payload) {
  const body = requireRecord(payload);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'El nombre del comercio debe tener entre 2 y 80 caracteres.');
  if (type.length < 2 || type.length > 50) throw new HttpError(400, 'Escribe el tipo de comercio.');
  if (emoji.length > 12) throw new HttpError(400, 'El ícono no es válido.');
  const store = {
    id: `store-${randomUUID()}`,
    name,
    type,
    emoji: emoji || '🏪',
    isOpen: true,
  };
  database.prepare(`
    INSERT INTO stores (id, name, type, emoji, color, is_open)
    VALUES (?, ?, ?, ?, '#eee7dc', 1)
  `).run(store.id, store.name, store.type, store.emoji);
  return store;
}

function getAdminSummary(database) {
  const users = database.prepare(`
    SELECT role, COUNT(*) AS count FROM users WHERE is_active = 1 GROUP BY role
  `).all();
  const riderCounts = database.prepare(`
    SELECT
      SUM(CASE WHEN rp.status = 'approved' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN rp.status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM rider_profiles rp
    JOIN users u ON u.id = rp.user_id
    WHERE u.is_active = 1
  `).get();
  const orders = database.prepare(`
    SELECT status, COUNT(*) AS count FROM orders GROUP BY status
  `).all();
  const storeTotals = database.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN is_open = 1 THEN 1 ELSE 0 END) AS open
    FROM stores
  `).get();
  return {
    users: Object.fromEntries(users.map((row) => [row.role, row.count])),
    riders: { active: riderCounts.active || 0, pending: riderCounts.pending || 0 },
    orders: Object.fromEntries(orders.map((row) => [row.status, row.count])),
    stores: { total: storeTotals.total, open: storeTotals.open || 0 },
  };
}

function changeAdminUserStatus(database, targetUserId, isActive, actor) {
  if (typeof isActive !== 'boolean') throw new HttpError(400, 'El estado de la cuenta no es válido.');
  if (targetUserId === actor.id) throw new HttpError(409, 'No puedes cambiar el estado de tu propia cuenta.');
  const target = database.prepare(`
    SELECT id, role, store_id AS storeId, is_active AS isActive
    FROM users WHERE id = ?
  `).get(targetUserId);
  if (!target) throw new HttpError(404, 'No se encontró la cuenta.');
  if (!isActive && target.role === 'admin' && target.isActive) {
    const activeAdmins = database.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1
    `).get().count;
    if (activeAdmins <= 1) throw new HttpError(409, 'Debe quedar al menos un administrador activo.');
  }
  if (!isActive && target.role === 'store') {
    const activeOrders = database.prepare(`
      SELECT COUNT(*) AS count FROM orders
      WHERE store_id = ? AND status NOT IN ('delivered', 'cancelled')
    `).get(target.storeId).count;
    if (activeOrders > 0) {
      throw new HttpError(409, 'Resuelve los pedidos activos de la tienda antes de desactivar la cuenta.');
    }
  }
  const hasApprovedRiderProfile = database.prepare(`
    SELECT 1 FROM rider_profiles WHERE user_id = ? AND status = 'approved'
  `).get(targetUserId);
  if (!isActive && (target.role === 'rider' || hasApprovedRiderProfile)) {
    const activeOrders = database.prepare(`
      SELECT COUNT(*) AS count FROM orders
      WHERE rider_user_id = ? AND status NOT IN ('delivered', 'cancelled')
    `).get(targetUserId).count;
    if (activeOrders > 0) {
      throw new HttpError(409, 'Completa los pedidos asignados antes de desactivar la cuenta.');
    }
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE users SET is_active = ? WHERE id = ?')
      .run(isActive ? 1 : 0, targetUserId);
    if (!isActive) {
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
      database.prepare('UPDATE rider_profiles SET is_available = 0 WHERE user_id = ?').run(targetUserId);
      if (target.role === 'store') {
        database.prepare('UPDATE stores SET is_open = 0 WHERE id = ?').run(target.storeId);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { id: targetUserId, isActive };
}

function getAdminReport(database, daysValue) {
  const days = Number(daysValue || 30);
  if (![7, 30, 90].includes(days)) {
    throw new HttpError(400, 'El período debe ser de 7, 30 o 90 días.');
  }
  const interval = `-${days} days`;
  const totals = database.prepare(`
    SELECT COUNT(*) AS orders,
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN status = 'delivered' THEN total ELSE 0 END) AS deliveredValue
    FROM orders
    WHERE created_at >= datetime('now', ?)
  `).get(interval);
  const byStore = database.prepare(`
    SELECT s.name AS storeName, COUNT(*) AS orders,
           SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN o.status = 'delivered' THEN o.total ELSE 0 END) AS deliveredValue
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    WHERE o.created_at >= datetime('now', ?)
    GROUP BY s.id
    ORDER BY deliveredValue DESC, orders DESC
  `).all(interval);
  const daily = database.prepare(`
    SELECT date(created_at) AS date, COUNT(*) AS orders,
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN status = 'delivered' THEN total ELSE 0 END) AS deliveredValue
    FROM orders
    WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at)
    ORDER BY date DESC
  `).all(interval);
  return {
    days,
    totals: {
      orders: totals.orders,
      delivered: totals.delivered || 0,
      cancelled: totals.cancelled || 0,
      deliveredValue: totals.deliveredValue || 0,
    },
    stores: byStore,
    daily,
  };
}

async function serveStatic(request, response, url, webRoot) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Método no permitido.' });
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: 'La ruta no es válida.' });
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const rootPath = path.resolve(webRoot);
  const filePath = path.resolve(rootPath, relativePath);
  const rootPrefix = `${rootPath}${path.sep}`.toLowerCase();
  if (filePath.toLowerCase() !== rootPath.toLowerCase() && !filePath.toLowerCase().startsWith(rootPrefix)) {
    sendJson(response, 403, { error: 'Acceso denegado.' });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const contentType = CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      sendJson(response, 404, { error: 'No se encontró el recurso solicitado.' });
      return;
    }
    throw error;
  }
}

function createServer(database, webRoot = path.join(__dirname, 'public')) {
  const loginAttempts = new Map();
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        assertSameOrigin(request);
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        database.prepare('SELECT 1').get();
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        const body = requireRecord(await readJsonBody(request));
        const account = validateAccount(body.name, body.email, body.password);
        const domain = (process.env.INSTITUTIONAL_EMAIL_DOMAIN || 'uniguajira.edu.co').trim().toLowerCase();
        if (!account.email.endsWith(`@${domain}`)) {
          throw new HttpError(400, `Regístrate con un correo @${domain}.`);
        }
        const passwordHash = await hashPassword(body.password);
        let result;
        try {
          result = database.prepare(`
            INSERT INTO users (name, email, password_hash, role)
            VALUES (?, ?, ?, 'customer')
          `).run(account.name, account.email, passwordHash);
        } catch (error) {
          if (/UNIQUE constraint failed/i.test(error.message)) {
            throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
          }
          throw error;
        }
        const session = createSession(database, Number(result.lastInsertRowid));
        const createdUser = database.prepare(`
          SELECT id, name, email, role, store_id AS storeId FROM users WHERE id = ?
        `).get(Number(result.lastInsertRowid));
        response.setHeader('Set-Cookie', sessionCookie(session.token, process.env.COOKIE_SECURE === 'true'));
        sendJson(response, 201, { user: publicUser(createdUser) });
        return;
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const body = requireRecord(await readJsonBody(request));
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length > 200) {
          throw new HttpError(400, 'Revisa el correo y la contraseña.');
        }
        const attemptKey = `${request.socket.remoteAddress || 'local'}:${email}`;
        const current = loginAttempts.get(attemptKey);
        if (current && current.expiresAt > Date.now() && current.count >= 5) {
          throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
        }
        const account = database.prepare(`
          SELECT u.id, u.name, u.email, u.role, u.store_id AS storeId,
                 rp.status AS riderStatus, rp.is_available AS riderAvailable,
                 u.password_hash AS passwordHash
          FROM users u
          LEFT JOIN rider_profiles rp ON rp.user_id = u.id
          WHERE u.email = ? AND u.is_active = 1
        `).get(email);
        if (!account || !(await verifyPassword(password, account.passwordHash))) {
          const attempts = current && current.expiresAt > Date.now()
            ? { count: current.count + 1, expiresAt: current.expiresAt }
            : { count: 1, expiresAt: Date.now() + 15 * 60 * 1000 };
          loginAttempts.set(attemptKey, attempts);
          throw new HttpError(401, 'Correo o contraseña incorrectos.');
        }
        loginAttempts.delete(attemptKey);
        const session = createSession(database, account.id);
        response.setHeader('Set-Cookie', sessionCookie(session.token, process.env.COOKIE_SECURE === 'true'));
        sendJson(response, 200, { user: publicUser(account) });
        return;
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const sessionToken = parseCookies(request).get(SESSION_COOKIE);
        if (sessionToken) {
          database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(sessionToken));
        }
        response.setHeader('Set-Cookie', clearSessionCookie(process.env.COOKIE_SECURE === 'true'));
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      const sessionToken = parseCookies(request).get(SESSION_COOKIE);
      const user = getUserForSession(database, sessionToken);
      if (url.pathname === '/api/me' && request.method === 'GET') {
        requireUser(user);
        sendJson(response, 200, { user: publicUser(user) });
        return;
      }
      if (url.pathname === '/api/notifications' && request.method === 'GET') {
        requireUser(user);
        sendJson(response, 200, listNotifications(database, user.id));
        return;
      }
      if (url.pathname === '/api/rider/applications' && request.method === 'POST') {
        requireRole(user, ['customer']);
        sendJson(response, 201, applyToBeRider(database, user.id));
        return;
      }
      if (url.pathname === '/api/rider/availability' && request.method === 'PATCH') {
        requireRole(user, ['rider']);
        const body = requireRecord(await readJsonBody(request));
        const availability = setRiderAvailability(database, user.id, body.isAvailable);
        sendJson(response, 200, availability);
        return;
      }
      const notificationReadRoute = url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (notificationReadRoute && request.method === 'PATCH') {
        requireUser(user);
        const notification = database.prepare(`
          SELECT id FROM notifications WHERE id = ? AND user_id = ?
        `).get(Number(notificationReadRoute[1]), user.id);
        if (!notification) throw new HttpError(404, 'No se encontró el aviso.');
        database.prepare(`
          UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ?
        `).run(notification.id);
        sendJson(response, 200, { status: 'read' });
        return;
      }

      if (url.pathname === '/api/stores' && request.method === 'GET') {
        requireUser(user);
        const stores = database.prepare(`
          SELECT id, name, type, emoji, color, is_open AS isOpen
          FROM stores ORDER BY name
        `).all();
        sendJson(response, 200, stores);
        return;
      }
      if (url.pathname === '/api/products' && request.method === 'GET') {
        requireUser(user);
        const products = database.prepare(`
          SELECT p.id, p.store_id AS storeId, p.name, p.category, p.price, p.emoji,
                 s.name AS storeName
          FROM products p JOIN stores s ON s.id = p.store_id
          WHERE p.is_available = 1 AND s.is_open = 1
          ORDER BY p.name
        `).all();
        sendJson(response, 200, products);
        return;
      }
      if (url.pathname === '/api/store/profile' && request.method === 'GET') {
        requireRole(user, ['store']);
        sendJson(response, 200, getStoreProfile(database, user.storeId));
        return;
      }
      if (url.pathname === '/api/store/profile' && request.method === 'PATCH') {
        requireRole(user, ['store']);
        const body = requireRecord(await readJsonBody(request));
        if (typeof body.isOpen !== 'boolean') throw new HttpError(400, 'Indica si la tienda está abierta o cerrada.');
        database.prepare('UPDATE stores SET is_open = ? WHERE id = ?')
          .run(body.isOpen ? 1 : 0, user.storeId);
        sendJson(response, 200, getStoreProfile(database, user.storeId));
        return;
      }
      if (url.pathname === '/api/store/products' && request.method === 'GET') {
        requireRole(user, ['store']);
        sendJson(response, 200, listStoreProducts(database, user.storeId));
        return;
      }
      if (url.pathname === '/api/store/products' && request.method === 'POST') {
        requireRole(user, ['store']);
        sendJson(response, 201, createStoreProduct(database, user.storeId, await readJsonBody(request)));
        return;
      }
      const storeProductRoute = url.pathname.match(/^\/api\/store\/products\/([A-Za-z0-9-]+)$/);
      if (storeProductRoute && request.method === 'PATCH') {
        requireRole(user, ['store']);
        const product = updateStoreProduct(
          database,
          user.storeId,
          storeProductRoute[1],
          await readJsonBody(request),
        );
        sendJson(response, 200, product);
        return;
      }
      if (url.pathname === '/api/orders' && request.method === 'GET') {
        requireRole(user, ['customer']);
        sendJson(response, 200, listOrders(database, user));
        return;
      }
      const orderCancelRoute = url.pathname.match(/^\/api\/orders\/([A-Z0-9-]+)\/cancel$/i);
      if (orderCancelRoute && request.method === 'PATCH') {
        requireRole(user, ['customer']);
        const result = changeOrderStatus(database, orderCancelRoute[1], 'cancelled', user);
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === '/api/orders' && request.method === 'POST') {
        requireRole(user, ['customer']);
        const order = createOrder(database, await readJsonBody(request), user);
        sendJson(response, 201, order);
        return;
      }
      if (url.pathname === '/api/portal/orders' && request.method === 'GET') {
        requireRole(user, ['store', 'rider', 'admin']);
        sendJson(response, 200, listOrders(database, user, { asRider: user.role === 'customer' }));
        return;
      }
      const orderStatusRoute = url.pathname.match(/^\/api\/portal\/orders\/([A-Z0-9-]+)\/status$/i);
      if (orderStatusRoute && request.method === 'POST') {
        requireRole(user, ['store', 'rider', 'admin']);
        const body = requireRecord(await readJsonBody(request));
        const actorRole = user.role === 'customer' ? 'rider' : user.role;
        const result = changeOrderStatus(database, orderStatusRoute[1], body.status, user, actorRole);
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === '/api/admin/rider-applications' && request.method === 'GET') {
        requireRole(user, ['admin']);
        sendJson(response, 200, listRiderApplications(database));
        return;
      }
      const riderApplicationRoute = url.pathname.match(/^\/api\/admin\/rider-applications\/(\d+)$/);
      if (riderApplicationRoute && request.method === 'PATCH') {
        requireRole(user, ['admin']);
        const body = requireRecord(await readJsonBody(request));
        sendJson(
          response,
          200,
          reviewRiderApplication(database, Number(riderApplicationRoute[1]), body.status, user.id),
        );
        return;
      }
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        requireRole(user, ['admin']);
        sendJson(response, 200, listAdminUsers(database));
        return;
      }
      if (url.pathname === '/api/admin/summary' && request.method === 'GET') {
        requireRole(user, ['admin']);
        sendJson(response, 200, getAdminSummary(database));
        return;
      }
      if (url.pathname === '/api/admin/reports' && request.method === 'GET') {
        requireRole(user, ['admin']);
        sendJson(response, 200, getAdminReport(database, url.searchParams.get('days')));
        return;
      }
      const adminUserStatusRoute = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/active$/);
      if (adminUserStatusRoute && request.method === 'PATCH') {
        requireRole(user, ['admin']);
        const body = requireRecord(await readJsonBody(request));
        sendJson(
          response,
          200,
          changeAdminUserStatus(database, Number(adminUserStatusRoute[1]), body.isActive, user),
        );
        return;
      }
      if (url.pathname === '/api/admin/stores' && request.method === 'GET') {
        requireRole(user, ['admin']);
        sendJson(response, 200, listAdminStores(database));
        return;
      }
      if (url.pathname === '/api/admin/stores' && request.method === 'POST') {
        requireRole(user, ['admin']);
        sendJson(response, 201, createAdminStore(database, await readJsonBody(request)));
        return;
      }
      if (url.pathname === '/api/admin/users' && request.method === 'POST') {
        requireRole(user, ['admin']);
        const body = requireRecord(await readJsonBody(request));
        const account = validateAccount(body.name, body.email, body.password);
        const role = body.role;
        if (!['store', 'rider', 'admin'].includes(role)) {
          throw new HttpError(400, 'El administrador solo puede crear cuentas de tienda, domiciliario o administrador.');
        }
        let storeId = null;
        if (role === 'store') {
          storeId = typeof body.storeId === 'string' ? body.storeId : '';
          if (!database.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) {
            throw new HttpError(400, 'Selecciona un comercio válido para esta cuenta.');
          }
        }
        const passwordHash = await hashPassword(body.password);
        let accountTransactionStarted = false;
        try {
          database.exec('BEGIN IMMEDIATE');
          accountTransactionStarted = true;
          const result = database.prepare(`
              INSERT INTO users (name, email, password_hash, role, store_id)
              VALUES (?, ?, ?, ?, ?)
            `).run(account.name, account.email, passwordHash, role, storeId);
          if (role === 'rider') {
            database.prepare(`
              INSERT INTO rider_profiles (user_id, status, is_available, reviewed_at, reviewed_by)
              VALUES (?, 'approved', 1, datetime('now'), ?)
            `).run(Number(result.lastInsertRowid), user.id);
          }
          database.exec('COMMIT');
          accountTransactionStarted = false;
        } catch (error) {
          if (accountTransactionStarted) database.exec('ROLLBACK');
          if (/UNIQUE constraint failed/i.test(error.message)) {
            throw new HttpError(409, 'El correo o el comercio ya tiene una cuenta.');
          }
          throw error;
        }
        sendJson(response, 201, { status: 'created' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'La ruta de la API no existe.' });
        return;
      }
      await serveStatic(request, response, url, webRoot);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) {
        console.error(JSON.stringify({
          level: 'error',
          timestamp: new Date().toISOString(),
          method: request.method,
          path: request.url.split('?')[0],
          message: error.message,
          stack: error.stack,
        }));
      }
      sendJson(response, status, {
        error: status === 500 ? 'Ocurrió un error interno.' : error.message,
      });
    }
  });
}

if (require.main === module) {
  const databasePath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(__dirname, 'data', 'comanda.sqlite');
  const database = createDatabase(databasePath);
  const server = createServer(database);
  server.listen(PORT, HOST, () => {
    console.log(`COMANDA disponible en http://${HOST}:${PORT}`);
    console.log(`Base SQLite: ${databasePath}`);
  });
  server.on('close', () => database.close());
}

module.exports = { createServer };
