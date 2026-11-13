const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { createDatabase } = require('../database');
const { hashPassword } = require('../auth');
const { createServer } = require('../server');

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comanda-test-'));
  const database = createDatabase(path.join(directory, 'test.sqlite'));
  const server = createServer(database);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { database, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postJson(baseUrl, route, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function sessionCookie(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

async function registerCustomer(baseUrl, suffix = 'cliente') {
  const domain = process.env.INSTITUTIONAL_EMAIL_DOMAIN || 'uniguajira.edu.co';
  const response = await postJson(baseUrl, '/api/auth/register', {
    name: 'Usuario de prueba',
    email: `${suffix}@${domain}`,
    password: 'contraseña-segura-123',
    role: 'admin',
  });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  return { cookie: sessionCookie(response), user: (await response.json()).user };
}

test('registra usuarios, protege la sesión y guarda pedidos vinculados a su cuenta', async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const unauthenticated = await fetch(`${baseUrl}/api/stores`);
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedNotifications = await fetch(`${baseUrl}/api/notifications`);
  assert.equal(unauthenticatedNotifications.status, 401);

  const registered = await registerCustomer(baseUrl);
  assert.equal(registered.user.role, 'customer');
  const currentUser = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: registered.cookie } });
  assert.equal((await currentUser.json()).user.email, registered.user.email);

  const crossOrigin = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Cookie: registered.cookie,
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
    },
    body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
  const invalidDomain = await postJson(baseUrl, '/api/auth/register', {
    name: 'Usuario externo',
    email: 'externo@example.com',
    password: 'contraseña-segura-123',
  });
  assert.equal(invalidDomain.status, 400);

  const mixedOrder = await postJson(baseUrl, '/api/orders', {
    block: 6,
    floor: 3,
    classroom: '304',
    deliveryZone: 'middle',
    paymentMethod: 'cash',
    items: [
      { productId: 'arepa-huevo', quantity: 1 },
      { productId: 'cafe-casa', quantity: 1 },
    ],
  }, registered.cookie);
  assert.equal(mixedOrder.status, 400);

  const orderResponse = await postJson(baseUrl, '/api/orders', {
    block: 6,
    floor: 3,
    classroom: '304',
    deliveryZone: 'middle',
    paymentMethod: 'transfer',
    items: [{ productId: 'arepa-huevo', quantity: 2 }],
  }, registered.cookie);
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  assert.match(order.orderCode, /^CMD-[A-F0-9]{8}$/);
  assert.equal(order.subtotal, 12000);
  assert.equal(order.deliveryFee, 3000);
  assert.equal(order.total, 15000);
  assert.equal(database.prepare('SELECT customer_user_id FROM orders WHERE order_code = ?').get(order.orderCode).customer_user_id, registered.user.id);

  const ownOrders = await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: registered.cookie } });
  assert.equal((await ownOrders.json()).length, 1);
  const forbiddenPanel = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: registered.cookie } });
  assert.equal(forbiddenPanel.status, 403);
});

test('administra cuentas y limita pedidos a los cuatro roles', async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const adminPassword = 'clave-admin-prueba-123';
  const adminHash = await hashPassword(adminPassword);
  database.prepare(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Admin de prueba', 'admin@comanda.test', ?, 'admin')
  `).run(adminHash);

  const login = await postJson(baseUrl, '/api/auth/login', {
    email: 'admin@comanda.test',
    password: adminPassword,
  });
  assert.equal(login.status, 200);
  const adminCookie = sessionCookie(login);

  const secondAdminAccount = await postJson(baseUrl, '/api/admin/users', {
    name: 'Otro administrador',
    email: 'admin-secundario@comanda.test',
    password: 'clave-admin-secundario-123',
    role: 'admin',
  }, adminCookie);
  assert.equal(secondAdminAccount.status, 201);
  const secondAdminLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'admin-secundario@comanda.test',
    password: 'clave-admin-secundario-123',
  });
  const secondAdminCookie = sessionCookie(secondAdminLogin);
  const secondAdminId = database.prepare('SELECT id FROM users WHERE email = ?')
    .get('admin-secundario@comanda.test').id;
  const selfAdminId = database.prepare('SELECT id FROM users WHERE email = ?')
    .get('admin@comanda.test').id;
  const selfDeactivation = await fetch(`${baseUrl}/api/admin/users/${selfAdminId}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(selfDeactivation.status, 409);

  const storeAccount = await postJson(baseUrl, '/api/admin/users', {
    name: 'Cuenta tienda',
    email: 'tienda@comanda.test',
    password: 'clave-tienda-prueba-123',
    role: 'store',
    storeId: 'cooperativa',
  }, adminCookie);
  assert.equal(storeAccount.status, 201);
  const riderAccount = await postJson(baseUrl, '/api/admin/users', {
    name: 'Cuenta domiciliario',
    email: 'rider@comanda.test',
    password: 'clave-rider-prueba-123',
    role: 'rider',
  }, adminCookie);
  assert.equal(riderAccount.status, 201);
  const secondStoreAccount = await postJson(baseUrl, '/api/admin/users', {
    name: 'Otra cuenta tienda',
    email: 'otra-tienda@comanda.test',
    password: 'clave-otra-tienda-12345',
    role: 'store',
    storeId: 'cafeteria-central',
  }, adminCookie);
  assert.equal(secondStoreAccount.status, 201);

  const createdStoreResponse = await postJson(baseUrl, '/api/admin/stores', {
    name: 'Tienda de prueba',
    type: 'Cafetería',
    emoji: '☕',
  }, adminCookie);
  assert.equal(createdStoreResponse.status, 201);
  const createdStore = await createdStoreResponse.json();
  const adminStores = await fetch(`${baseUrl}/api/admin/stores`, { headers: { Cookie: adminCookie } });
  assert.ok((await adminStores.json()).some((store) => store.id === createdStore.id && !store.accountEmail));
  const createdStoreAccount = await postJson(baseUrl, '/api/admin/users', {
    name: 'Cuenta nueva tienda',
    email: 'nueva-tienda@comanda.test',
    password: 'clave-nueva-tienda-123',
    role: 'store',
    storeId: createdStore.id,
  }, adminCookie);
  assert.equal(createdStoreAccount.status, 201);

  const customer = await registerCustomer(baseUrl, 'comprador');
  const invalidPhoneOrder = await postJson(baseUrl, '/api/orders', {
    block: 6,
    floor: 3,
    classroom: '304',
    deliveryZone: 'near',
    paymentMethod: 'cash',
    contactPhone: '12345',
    items: [{ productId: 'arepa-huevo', quantity: 1 }],
  }, customer.cookie);
  assert.equal(invalidPhoneOrder.status, 400);
  const createdOrder = await postJson(baseUrl, '/api/orders', {
    block: 6,
    floor: 3,
    classroom: '304',
    note: 'Entrada lateral del bloque',
    contactPhone: '+57 300 123 4567',
    deliveryZone: 'near',
    paymentMethod: 'cash',
    items: [{ productId: 'arepa-huevo', quantity: 1 }],
  }, customer.cookie);
  const order = await createdOrder.json();
  const storeLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'tienda@comanda.test',
    password: 'clave-tienda-prueba-123',
  });
  const storeCookie = sessionCookie(storeLogin);
  const storeNotifications = await fetch(`${baseUrl}/api/notifications`, { headers: { Cookie: storeCookie } });
  assert.equal((await storeNotifications.json())[0].title, 'Nuevo pedido');
  const storeOrderList = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: storeCookie } });
  const storeOrder = (await storeOrderList.json()).find((item) => item.orderCode === order.orderCode);
  assert.equal(storeOrder.customerName, 'Usuario de prueba');
  assert.equal(storeOrder.contactPhone, '+573001234567');
  assert.equal(storeOrder.note, 'Entrada lateral del bloque');
  const adminOrderList = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: adminCookie } });
  const adminOrder = (await adminOrderList.json()).find((item) => item.orderCode === order.orderCode);
  assert.equal(adminOrder.customerName, null);
  assert.equal(adminOrder.contactPhone, null);
  assert.equal(adminOrder.note, '');

  const adminUsersBeforeOrder = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: adminCookie } });
  const storeUserId = (await adminUsersBeforeOrder.json()).find((user) => user.email === 'tienda@comanda.test').id;
  const disableStoreWithOpenOrder = await fetch(`${baseUrl}/api/admin/users/${storeUserId}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(disableStoreWithOpenOrder.status, 409);

  const cancellableOrderResponse = await postJson(baseUrl, '/api/orders', {
    block: 6,
    floor: 3,
    classroom: '304',
    deliveryZone: 'near',
    paymentMethod: 'cash',
    items: [{ productId: 'arepa-huevo', quantity: 1 }],
  }, customer.cookie);
  const cancellableOrder = await cancellableOrderResponse.json();
  const otherCustomer = await registerCustomer(baseUrl, 'otro-comprador');
  const otherOrderCancel = await fetch(`${baseUrl}/api/orders/${cancellableOrder.orderCode}/cancel`, {
    method: 'PATCH',
    headers: { Cookie: otherCustomer.cookie },
  });
  assert.equal(otherOrderCancel.status, 404);
  const confirmCancellableOrder = await postJson(
    baseUrl,
    `/api/portal/orders/${cancellableOrder.orderCode}/status`,
    { status: 'confirmed' },
    storeCookie,
  );
  assert.equal(confirmCancellableOrder.status, 200);
  const cancelledOrder = await fetch(`${baseUrl}/api/orders/${cancellableOrder.orderCode}/cancel`, {
    method: 'PATCH',
    headers: { Cookie: customer.cookie },
  });
  assert.equal((await cancelledOrder.json()).status, 'cancelled');
  const customerOrders = await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: customer.cookie } });
  const history = (await customerOrders.json()).find((item) => item.orderCode === cancellableOrder.orderCode);
  assert.deepEqual(history.events.map((event) => event.toStatus), ['created', 'confirmed', 'cancelled']);

  const otherStoreLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'otra-tienda@comanda.test',
    password: 'clave-otra-tienda-12345',
  });
  const otherStoreCookie = sessionCookie(otherStoreLogin);
  const storeOrders = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: storeCookie } });
  assert.equal((await storeOrders.json()).length, 2);
  const storeProfile = await fetch(`${baseUrl}/api/store/profile`, { headers: { Cookie: storeCookie } });
  assert.equal((await storeProfile.json()).id, 'cooperativa');
  const storeProducts = await fetch(`${baseUrl}/api/store/products`, { headers: { Cookie: storeCookie } });
  const ownProducts = await storeProducts.json();
  assert.ok(ownProducts.length > 0);
  assert.ok(ownProducts.every((product) => !product.id.includes('cafeteria')));
  const createdProduct = await postJson(baseUrl, '/api/store/products', {
    name: 'Producto nuevo',
    category: 'Bebidas',
    price: 2500,
    emoji: '🥤',
  }, storeCookie);
  assert.equal(createdProduct.status, 201);
  const newProduct = await createdProduct.json();
  const updateProduct = await fetch(`${baseUrl}/api/store/products/${newProduct.id}`, {
    method: 'PATCH',
    headers: { Cookie: storeCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: 3000, isAvailable: false }),
  });
  assert.equal(updateProduct.status, 200);
  const otherStoreProductUpdate = await fetch(`${baseUrl}/api/store/products/${newProduct.id}`, {
    method: 'PATCH',
    headers: { Cookie: otherStoreCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: 100 }),
  });
  assert.equal(otherStoreProductUpdate.status, 404);
  const closedStore = await fetch(`${baseUrl}/api/store/profile`, {
    method: 'PATCH',
    headers: { Cookie: storeCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isOpen: false }),
  });
  assert.equal((await closedStore.json()).isOpen, false);
  const reopenedStore = await fetch(`${baseUrl}/api/store/profile`, {
    method: 'PATCH',
    headers: { Cookie: storeCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isOpen: true }),
  });
  assert.equal((await reopenedStore.json()).isOpen, true);

  const forbiddenStoreProducts = await fetch(`${baseUrl}/api/store/products`, { headers: { Cookie: customer.cookie } });
  assert.equal(forbiddenStoreProducts.status, 403);
  const hiddenOrders = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: otherStoreCookie } });
  assert.equal((await hiddenOrders.json()).length, 0);
  const wrongStoreChange = await postJson(
    baseUrl,
    `/api/portal/orders/${order.orderCode}/status`,
    { status: 'confirmed' },
    otherStoreCookie,
  );
  assert.equal(wrongStoreChange.status, 404);
  for (const status of ['confirmed', 'preparing', 'ready']) {
    const changed = await postJson(baseUrl, `/api/portal/orders/${order.orderCode}/status`, { status }, storeCookie);
    assert.equal(changed.status, 200);
  }
  const riderLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'rider@comanda.test',
    password: 'clave-rider-prueba-123',
  });
  const riderCookie = sessionCookie(riderLogin);
  const availableRiderOrders = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: riderCookie } });
  const availableRiderOrder = (await availableRiderOrders.json()).find((item) => item.orderCode === order.orderCode);
  assert.equal(availableRiderOrder.customerName, 'Usuario de prueba');
  assert.equal(availableRiderOrder.contactPhone, null);
  assert.equal(availableRiderOrder.note, 'Entrada lateral del bloque');
  const tooLateToCancel = await fetch(`${baseUrl}/api/orders/${order.orderCode}/cancel`, {
    method: 'PATCH',
    headers: { Cookie: customer.cookie },
  });
  assert.equal(tooLateToCancel.status, 409);

  const customerNotifications = await fetch(`${baseUrl}/api/notifications`, { headers: { Cookie: customer.cookie } });
  const notices = await customerNotifications.json();
  assert.equal(notices.length, 4);
  const orderNotices = notices.filter((notice) => notice.orderCode === order.orderCode);
  assert.equal(orderNotices.length, 3);
  assert.ok(orderNotices.every((notice) => notice.message.includes(order.orderCode)));
  const markRead = await fetch(`${baseUrl}/api/notifications/${notices[0].id}/read`, {
    method: 'PATCH',
    headers: { Cookie: customer.cookie },
  });
  assert.equal(markRead.status, 200);
  const readNotices = await fetch(`${baseUrl}/api/notifications`, { headers: { Cookie: customer.cookie } });
  assert.ok((await readNotices.json()).some((notice) => notice.id === notices[0].id && notice.readAt));
  const otherCustomerRead = await fetch(`${baseUrl}/api/notifications/${notices[0].id}/read`, {
    method: 'PATCH',
    headers: { Cookie: otherCustomer.cookie },
  });
  assert.equal(otherCustomerRead.status, 404);

  const acceptedOrder = await postJson(baseUrl, `/api/portal/orders/${order.orderCode}/status`, { status: 'accepted' }, riderCookie);
  assert.equal(acceptedOrder.status, 200);
  const assignedRiderOrders = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: riderCookie } });
  const assignedRiderOrder = (await assignedRiderOrders.json()).find((item) => item.orderCode === order.orderCode);
  assert.equal(assignedRiderOrder.contactPhone, '+573001234567');
  const disableRiderWithOpenOrder = await fetch(`${baseUrl}/api/admin/users/${database.prepare('SELECT id FROM users WHERE email = ?').get('rider@comanda.test').id}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(disableRiderWithOpenOrder.status, 409);
  for (const status of ['on_route', 'delivered']) {
    const changed = await postJson(baseUrl, `/api/portal/orders/${order.orderCode}/status`, { status }, riderCookie);
    assert.equal(changed.status, 200);
  }
  const completedStoreOrders = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: storeCookie } });
  assert.equal((await completedStoreOrders.json()).find((item) => item.orderCode === order.orderCode).contactPhone, null);
  const completedRiderOrders = await fetch(`${baseUrl}/api/portal/orders`, { headers: { Cookie: riderCookie } });
  assert.equal((await completedRiderOrders.json()).find((item) => item.orderCode === order.orderCode).contactPhone, null);
  const riderNotifications = await fetch(`${baseUrl}/api/notifications`, { headers: { Cookie: riderCookie } });
  assert.equal((await riderNotifications.json())[0].title, 'Pedido disponible');
  assert.equal(database.prepare('SELECT status FROM orders WHERE order_code = ?').get(order.orderCode).status, 'delivered');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM order_events').get().count, 10);

  const reportResponse = await fetch(`${baseUrl}/api/admin/reports?days=30`, { headers: { Cookie: adminCookie } });
  const report = await reportResponse.json();
  assert.equal(report.days, 30);
  assert.equal(report.totals.orders, 2);
  assert.equal(report.totals.delivered, 1);
  assert.equal(report.totals.cancelled, 1);
  assert.equal(report.totals.deliveredValue, 8000);
  assert.equal((await fetch(`${baseUrl}/api/admin/reports?days=12`, { headers: { Cookie: adminCookie } })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/admin/reports`, { headers: { Cookie: storeCookie } })).status, 403);

  const deactivateSecondAdmin = await fetch(`${baseUrl}/api/admin/users/${secondAdminId}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(deactivateSecondAdmin.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Cookie: secondAdminCookie } })).status, 401);
  const reactivateSecondAdmin = await fetch(`${baseUrl}/api/admin/users/${secondAdminId}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: true }),
  });
  assert.equal(reactivateSecondAdmin.status, 200);
  const reactivatedAdminLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'admin-secundario@comanda.test',
    password: 'clave-admin-secundario-123',
  });
  assert.equal(reactivatedAdminLogin.status, 200);

  const deactivateRider = await fetch(`${baseUrl}/api/admin/users/${database.prepare('SELECT id FROM users WHERE email = ?').get('rider@comanda.test').id}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(deactivateRider.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Cookie: riderCookie } })).status, 401);

  const deactivateStore = await fetch(`${baseUrl}/api/admin/users/${storeUserId}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(deactivateStore.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Cookie: storeCookie } })).status, 401);
  const storeAfterDeactivation = await fetch(`${baseUrl}/api/admin/stores`, { headers: { Cookie: adminCookie } });
  assert.equal((await storeAfterDeactivation.json()).find((store) => store.id === 'cooperativa').isOpen, false);
  const reactivateStore = await fetch(`${baseUrl}/api/admin/users/${storeUserId}/active`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: true }),
  });
  assert.equal(reactivateStore.status, 200);

  const adminUsers = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: adminCookie } });
  const roles = (await adminUsers.json()).map((user) => user.role);
  assert.deepEqual(new Set(roles), new Set(['admin', 'customer', 'store', 'rider']));
  const summary = await fetch(`${baseUrl}/api/admin/summary`, { headers: { Cookie: adminCookie } });
  const dashboardSummary = await summary.json();
  assert.equal(dashboardSummary.orders.delivered, 1);
  assert.equal(dashboardSummary.stores.total, 4);
  const forbiddenAdminSummary = await fetch(`${baseUrl}/api/admin/summary`, { headers: { Cookie: otherStoreCookie } });
  assert.equal(forbiddenAdminSummary.status, 403);
});

test('permite a un estudiante solicitar, activar y pausar el acceso de domiciliario', async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const adminPassword = 'clave-admin-estudiantes-123';
  const adminHash = await hashPassword(adminPassword);
  database.prepare(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Admin de prueba', 'admin-estudiantes@comanda.test', ?, 'admin')
  `).run(adminHash);
  const adminLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'admin-estudiantes@comanda.test',
    password: adminPassword,
  });
  const adminCookie = sessionCookie(adminLogin);
  const student = await registerCustomer(baseUrl, 'estudiante-domiciliario');

  const application = await postJson(baseUrl, '/api/rider/applications', {}, student.cookie);
  assert.equal(application.status, 201);
  assert.equal((await application.json()).status, 'pending');
  assert.equal((await fetch(`${baseUrl}/api/portal/orders`, {
    headers: { Cookie: student.cookie },
  })).status, 403);
  const pendingAvailability = await fetch(`${baseUrl}/api/rider/availability`, {
    method: 'PATCH',
    headers: { Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAvailable: true }),
  });
  assert.equal(pendingAvailability.status, 403);

  const applications = await fetch(`${baseUrl}/api/admin/rider-applications`, {
    headers: { Cookie: adminCookie },
  });
  const [pendingApplication] = await applications.json();
  assert.equal(pendingApplication.userId, student.user.id);
  const approval = await fetch(`${baseUrl}/api/admin/rider-applications/${student.user.id}`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(approval.status, 200);
  const currentUserResponse = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: student.cookie } });
  const currentUser = (await currentUserResponse.json()).user;
  assert.equal(currentUser.role, 'customer');
  assert.equal(currentUser.riderStatus, 'approved');
  assert.equal(currentUser.riderAvailable, false);
  assert.equal((await postJson(baseUrl, '/api/rider/applications', {}, student.cookie)).status, 409);

  const secondStudent = await registerCustomer(baseUrl, 'estudiante-rechazado');
  assert.equal((await postJson(baseUrl, '/api/rider/applications', {}, secondStudent.cookie)).status, 201);
  const rejection = await fetch(`${baseUrl}/api/admin/rider-applications/${secondStudent.user.id}`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected' }),
  });
  assert.equal(rejection.status, 200);
  const rejectedStudent = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: secondStudent.cookie } });
  assert.equal((await rejectedStudent.json()).user.riderStatus, 'rejected');
  assert.equal((await postJson(baseUrl, '/api/rider/applications', {}, secondStudent.cookie)).status, 201);

  const storePassword = 'clave-tienda-estudiantes-123';
  const storeHash = await hashPassword(storePassword);
  database.prepare(`
    INSERT INTO users (name, email, password_hash, role, store_id)
    VALUES ('Tienda de prueba', 'tienda-estudiantes@comanda.test', ?, 'store', 'cooperativa')
  `).run(storeHash);
  const storeLogin = await postJson(baseUrl, '/api/auth/login', {
    email: 'tienda-estudiantes@comanda.test',
    password: storePassword,
  });
  const storeCookie = sessionCookie(storeLogin);
  const orderResponse = await postJson(baseUrl, '/api/orders', {
    block: 4,
    floor: 2,
    classroom: '201',
    deliveryZone: 'near',
    paymentMethod: 'cash',
    contactPhone: '+57 300 123 4567',
    items: [{ productId: 'arepa-huevo', quantity: 1 }],
  }, student.cookie);
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  for (const status of ['confirmed', 'preparing', 'ready']) {
    const changed = await postJson(
      baseUrl,
      `/api/portal/orders/${order.orderCode}/status`,
      { status },
      storeCookie,
    );
    assert.equal(changed.status, 200);
  }
  const unavailableOrders = await fetch(`${baseUrl}/api/portal/orders`, {
    headers: { Cookie: student.cookie },
  });
  assert.deepEqual(await unavailableOrders.json(), []);
  const rejectedClaim = await postJson(
    baseUrl,
    `/api/portal/orders/${order.orderCode}/status`,
    { status: 'accepted' },
    student.cookie,
  );
  assert.equal(rejectedClaim.status, 409);

  const activate = await fetch(`${baseUrl}/api/rider/availability`, {
    method: 'PATCH',
    headers: { Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAvailable: true }),
  });
  assert.equal((await activate.json()).isAvailable, true);
  const availableOrders = await fetch(`${baseUrl}/api/portal/orders`, {
    headers: { Cookie: student.cookie },
  });
  const availableOrder = (await availableOrders.json()).find((item) => item.orderCode === order.orderCode);
  assert.equal(availableOrder.contactPhone, null);

  const pause = await fetch(`${baseUrl}/api/rider/availability`, {
    method: 'PATCH',
    headers: { Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAvailable: false }),
  });
  assert.equal((await pause.json()).isAvailable, false);
  const pausedOrders = await fetch(`${baseUrl}/api/portal/orders`, {
    headers: { Cookie: student.cookie },
  });
  assert.deepEqual(await pausedOrders.json(), []);
  const resume = await fetch(`${baseUrl}/api/rider/availability`, {
    method: 'PATCH',
    headers: { Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAvailable: true }),
  });
  assert.equal(resume.status, 200);

  const claim = await postJson(
    baseUrl,
    `/api/portal/orders/${order.orderCode}/status`,
    { status: 'accepted' },
    student.cookie,
  );
  assert.equal(claim.status, 200);
  const assignedOrders = await fetch(`${baseUrl}/api/portal/orders`, {
    headers: { Cookie: student.cookie },
  });
  assert.equal((await assignedOrders.json()).find((item) => item.orderCode === order.orderCode).contactPhone, '+573001234567');
  const customerOrders = await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: student.cookie } });
  assert.equal((await customerOrders.json()).length, 1);
  for (const status of ['on_route', 'delivered']) {
    const changed = await postJson(
      baseUrl,
      `/api/portal/orders/${order.orderCode}/status`,
      { status },
      student.cookie,
    );
    assert.equal(changed.status, 200);
  }
  const summary = await fetch(`${baseUrl}/api/admin/summary`, { headers: { Cookie: adminCookie } });
  assert.equal((await summary.json()).riders.active, 1);
});

test('migra una base anterior sin perder las tablas de pedidos', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comanda-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, emoji TEXT NOT NULL, color TEXT NOT NULL, is_open INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('customer', 'store', 'rider', 'admin')),
      store_id TEXT UNIQUE REFERENCES stores(id), is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((role = 'store' AND store_id IS NOT NULL) OR (role != 'store' AND store_id IS NULL))
    );
    CREATE TABLE products (id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), name TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL, emoji TEXT NOT NULL, is_available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL REFERENCES stores(id),
      block INTEGER NOT NULL, floor INTEGER NOT NULL, classroom TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      delivery_zone TEXT NOT NULL, delivery_fee INTEGER NOT NULL, payment_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created', subtotal INTEGER NOT NULL, total INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id TEXT NOT NULL REFERENCES products(id), product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL
    );
    INSERT INTO stores (id, name, type, emoji, color) VALUES ('old-store', 'Comercio anterior', 'Cafetería', '☕', '#fff');
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Domiciliario anterior', 'rider-legacy@comanda.test', 'legacy-hash', 'rider');
  `);
  legacy.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const migrated = createDatabase(databasePath);
  assert.ok(migrated.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'customer_user_id'));
  assert.ok(migrated.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'contact_phone'));
  assert.equal(migrated.prepare('SELECT name FROM stores WHERE id = ?').get('old-store').name, 'Comercio anterior');
  const migratedRider = migrated.prepare(`
    SELECT status, is_available AS isAvailable
    FROM rider_profiles WHERE user_id = 1
  `).get();
  assert.equal(migratedRider.status, 'approved');
  assert.equal(migratedRider.isAvailable, 1);
  migrated.close();
});
