const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const fees = { near: 2000, middle: 3000, far: 4000 };
const state = {
  user: null,
  stores: [],
  products: [],
  category: 'Todos',
  storeId: null,
  cart: {},
  location: null,
  orders: [],
  storeProducts: [],
  storeOrderFilter: 'all',
  notifications: [],
};

const $ = (selector) => document.querySelector(selector);
const productsElement = $('#products');
const storesElement = $('#stores');
const cartDrawer = $('#cart-drawer');
const scrim = $('#scrim');
const locationModal = $('#location-modal');
const checkoutModal = $('#checkout-modal');
const resultModal = $('#result-modal');
let toastTimer;
let notificationTimer;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function loadCart(userId) {
  try {
    const saved = JSON.parse(localStorage.getItem(`comanda-cart-${userId}`) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (error) {
    console.warn('No se pudo recuperar el carrito guardado.', error);
    return {};
  }
}

function loadLocation(userId) {
  try {
    const saved = JSON.parse(localStorage.getItem(`comanda-location-${userId}`) || 'null');
    if (
      saved &&
      Number.isInteger(saved.block) &&
      Number.isInteger(saved.floor) &&
      typeof saved.classroom === 'string'
    ) return saved;
  } catch (error) {
    console.warn('No se pudo recuperar la ubicación guardada.', error);
  }
  return null;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('El servidor devolvió una respuesta no válida.');
  }
  if (!response.ok) {
    const error = new Error(result.error || 'No se pudo completar la solicitud.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function cartEntries() {
  return Object.entries(state.cart)
    .map(([id, quantity]) => ({ product: state.products.find((item) => item.id === id), quantity }))
    .filter(({ product, quantity }) => product && Number.isInteger(quantity) && quantity > 0);
}

function cartSubtotal() {
  return cartEntries().reduce((sum, entry) => sum + entry.product.price * entry.quantity, 0);
}

function saveCart() {
  try {
    if (state.user) localStorage.setItem(`comanda-cart-${state.user.id}`, JSON.stringify(state.cart));
  } catch (error) {
    console.warn('No se pudo guardar el carrito en este navegador.', error);
  }
}

function renderStores() {
  storesElement.innerHTML = state.stores.map((store) => `
    <button class="store-card${state.storeId === store.id ? ' selected' : ''}" type="button" data-store="${escapeHtml(store.id)}" aria-pressed="${state.storeId === store.id}">
      <span class="store-icon" style="background:${escapeHtml(store.color)}">${escapeHtml(store.emoji)}</span>
      <span class="store-copy"><strong>${escapeHtml(store.name)}</strong><small>${escapeHtml(store.type)}</small></span>
      <span class="store-arrow">↗</span>
    </button>
  `).join('');
}

function visibleProducts() {
  const search = $('#search').value.trim().toLocaleLowerCase('es');
  return state.products.filter((product) => {
    const matchesCategory = state.category === 'Todos' || product.category === state.category;
    const matchesStore = !state.storeId || product.storeId === state.storeId;
    const matchesSearch = !search ||
      `${product.name} ${product.storeName} ${product.category}`.toLocaleLowerCase('es').includes(search);
    return matchesCategory && matchesStore && matchesSearch;
  });
}

function renderProducts() {
  const products = visibleProducts();
  productsElement.innerHTML = products.map((product) => `
    <article class="product-card">
      <div class="product-art"><span>${escapeHtml(product.emoji)}</span><small>${escapeHtml(product.category)}</small></div>
      <div class="product-info"><small class="product-store">${escapeHtml(product.storeName)}</small>
        <h4>${escapeHtml(product.name)}</h4><div class="product-bottom"><strong>${money.format(product.price)}</strong>
          <button type="button" class="add-button" data-add="${escapeHtml(product.id)}" aria-label="Agregar ${escapeHtml(product.name)}">+</button>
        </div>
      </div>
    </article>
  `).join('');
  $('#empty-state').hidden = products.length > 0;
  productsElement.hidden = products.length === 0;
  $('#products-title').textContent = state.storeId
    ? `Productos de ${state.stores.find((store) => store.id === state.storeId)?.name || 'este comercio'}`
    : 'Popular en el campus';
}

function renderCart() {
  const entries = cartEntries();
  const count = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  $('#cart-count').textContent = count;
  $('#drawer-count').textContent = `(${count})`;
  $('#cart-items').innerHTML = entries.map(({ product, quantity }) => `
    <div class="cart-item">
      <span class="cart-item-icon">${escapeHtml(product.emoji)}</span>
      <div class="cart-item-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.storeName)}</small><b>${money.format(product.price * quantity)}</b></div>
      <div class="quantity-control"><button type="button" data-change="-1" data-id="${escapeHtml(product.id)}" aria-label="Quitar uno">−</button><span>${quantity}</span><button type="button" data-change="1" data-id="${escapeHtml(product.id)}" aria-label="Agregar uno">+</button></div>
    </div>
  `).join('');
  const empty = count === 0;
  $('#cart-empty').hidden = !empty;
  $('#cart-summary').hidden = empty;
  $('#subtotal').textContent = money.format(cartSubtotal());
  $('#checkout-total').textContent = money.format(cartSubtotal() + fees[$('#zone').value]);
  saveCart();
}

function setCategory(category) {
  state.category = category;
  document.querySelectorAll('.filter').forEach((button) => {
    const selected = button.dataset.category === category;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  renderProducts();
}

function setLocation(location) {
  state.location = location;
  localStorage.setItem(`comanda-location-${state.user.id}`, JSON.stringify(location));
  $('#location-label').textContent = `Bloque ${location.block} · ${location.floor}° · Aula ${location.classroom}`;
  $('#location-modal').hidden = true;
  syncOverlay();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2600);
}

function syncOverlay() {
  const hasModal = [locationModal, checkoutModal, resultModal].some((modal) => !modal.hidden);
  const isOpen = cartDrawer.classList.contains('open') || hasModal;
  scrim.hidden = !isOpen;
  document.body.classList.toggle('locked', isOpen);
  cartDrawer.setAttribute('aria-hidden', String(!cartDrawer.classList.contains('open')));
}

function openLocation() {
  if (state.location) {
    $('#block').value = state.location.block;
    $('#floor').value = state.location.floor;
    $('#classroom').value = state.location.classroom;
  }
  locationModal.hidden = false;
  syncOverlay();
  $('#block').focus();
}

function closeModals() {
  [locationModal, checkoutModal, resultModal].forEach((modal) => { modal.hidden = true; });
  cartDrawer.classList.remove('open');
  syncOverlay();
}

function closeCart() {
  cartDrawer.classList.remove('open');
  syncOverlay();
}

function openCart() {
  cartDrawer.classList.add('open');
  syncOverlay();
  $('#close-cart').focus();
}

const roleLabels = {
  customer: 'Usuario',
  store: 'Tienda',
  rider: 'Domiciliario',
  admin: 'Administrador',
};
const statusLabels = {
  created: 'Recibido',
  confirmed: 'Confirmado',
  preparing: 'Preparando',
  ready: 'Listo para recoger',
  accepted: 'Aceptado por domiciliario',
  on_route: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

function showAuthError(message) {
  $('#auth-error').textContent = message;
  $('#auth-error').hidden = !message;
}

function showDashboardError(message) {
  $('#dashboard-error').textContent = message;
  $('#dashboard-error').hidden = !message;
}

function orderAction(order, role) {
  if (role === 'customer' && ['created', 'confirmed'].includes(order.status)) {
    return [{ status: 'cancelled', label: 'Cancelar pedido' }];
  }
  if (role === 'store') {
    if (order.status === 'created') return [{ status: 'confirmed', label: 'Confirmar' }, { status: 'cancelled', label: 'Rechazar' }];
    if (order.status === 'confirmed') return [{ status: 'preparing', label: 'Iniciar preparación' }];
    if (order.status === 'preparing') return [{ status: 'ready', label: 'Marcar listo' }];
  }
  if (role === 'rider') {
    if (order.status === 'ready') return [{ status: 'accepted', label: 'Aceptar pedido' }];
    if (order.status === 'accepted') return [{ status: 'on_route', label: 'Iniciar entrega' }];
    if (order.status === 'on_route') return [{ status: 'delivered', label: 'Marcar entregado' }];
  }
  if (role === 'admin' && !['delivered', 'cancelled'].includes(order.status)) {
    return [{ status: 'cancelled', label: 'Cancelar pedido' }];
  }
  return [];
}

function renderOrders(element, orders, role) {
  const visibleOrders = role === 'store' && state.storeOrderFilter !== 'all'
    ? orders.filter((order) => {
      if (state.storeOrderFilter === 'created') return order.status === 'created';
      if (state.storeOrderFilter === 'preparing') return ['confirmed', 'preparing'].includes(order.status);
      return order.status === state.storeOrderFilter;
    })
    : orders;
  if (visibleOrders.length === 0) {
    element.innerHTML = '<p class="empty-state">No hay pedidos para mostrar.</p>';
    return;
  }
  element.innerHTML = visibleOrders.map((order) => {
    const actions = orderAction(order, role).map((action) => `
      <button class="button button-dark order-action" type="button" data-order="${escapeHtml(order.orderCode)}" data-status="${escapeHtml(action.status)}">${escapeHtml(action.label)}</button>
    `).join('');
    const products = order.items.map((item) => `${item.quantity} × ${escapeHtml(item.name)}`).join(', ');
    const timeline = (order.events || []).map((item) => `
      <li class="timeline-event">
        <span class="timeline-marker"></span>
        <div><strong>${escapeHtml(statusLabels[item.toStatus] || item.toStatus)}</strong><small>${escapeHtml(formatDate(item.createdAt))}${item.actorName ? ` · ${escapeHtml(item.actorName)}` : ''}</small></div>
      </li>
    `).join('');
    return `
      <article class="order-card">
        <div class="order-card-top"><div><strong>${escapeHtml(order.orderCode)}</strong><small>${escapeHtml(order.storeName)}</small></div><span class="status-badge status-${escapeHtml(order.status)}">${escapeHtml(statusLabels[order.status] || order.status)}</span></div>
        <p>${products}</p>
        <div class="order-meta"><span>Bloque ${escapeHtml(order.block)}, piso ${escapeHtml(order.floor)}, aula ${escapeHtml(order.classroom)}</span><strong>${money.format(order.total)}</strong></div>
        ${order.customerName && role !== 'customer' ? `<small class="rider-assignment">Usuario: ${escapeHtml(order.customerName)}</small>` : ''}
        ${order.note ? `<p class="delivery-note-copy">Indicaciones: ${escapeHtml(order.note)}</p>` : ''}
        ${order.contactPhone ? `<a class="order-contact" href="tel:${escapeHtml(order.contactPhone)}">☎ ${escapeHtml(order.contactPhone)}</a>` : ''}
        ${order.riderName ? `<small class="rider-assignment">Domiciliario: ${escapeHtml(order.riderName)}</small>` : ''}
        ${timeline ? `<details class="order-history"><summary>Seguimiento del pedido</summary><ol class="order-timeline">${timeline}</ol></details>` : ''}
        ${actions ? `<div class="order-actions">${actions}</div>` : ''}
      </article>
    `;
  }).join('');
}

function formatDate(value) {
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function renderNotifications() {
  const unreadCount = state.notifications.filter((notification) => !notification.readAt).length;
  $('#notification-count').textContent = unreadCount ? `· ${unreadCount} nuevas` : '';
  $('#notifications-list').innerHTML = state.notifications.map((notification) => `
    <article class="notification-card ${notification.readAt ? '' : 'unread'}">
      <div class="notification-copy">
        <strong>${escapeHtml(notification.title)}</strong>
        <p>${escapeHtml(notification.message)}</p>
        <small>${escapeHtml(notification.orderCode)} · ${escapeHtml(formatDate(notification.createdAt))}</small>
      </div>
      ${notification.readAt ? '<span class="notification-read-label">Leído</span>' : `<button class="text-link" type="button" data-notification-read="${notification.id}">Marcar leído</button>`}
    </article>
  `).join('') || '<p class="empty-state">Todavía no tienes avisos.</p>';
}

async function loadNotifications() {
  state.notifications = await requestJson('/api/notifications');
  renderNotifications();
}

function renderStoreMetrics(orders) {
  const counts = {
    created: orders.filter((order) => order.status === 'created').length,
    preparing: orders.filter((order) => ['confirmed', 'preparing'].includes(order.status)).length,
    ready: orders.filter((order) => order.status === 'ready').length,
    delivered: orders.filter((order) => order.status === 'delivered').length,
  };
  $('#store-metrics').innerHTML = [
    ['Pedidos nuevos', counts.created, 'Requieren atención'],
    ['En preparación', counts.preparing, 'Confirmados o preparando'],
    ['Listos', counts.ready, 'Esperando domiciliario'],
    ['Entregados', counts.delivered, 'Pedidos completados'],
  ].map(([label, count, note]) => `
    <article class="metric-card"><span>${label}</span><strong>${count}</strong><small>${note}</small></article>
  `).join('');
  $('#store-order-count').textContent = counts.created ? `· ${counts.created}` : '';
}

function renderStoreProducts() {
  $('#store-products').innerHTML = state.storeProducts.map((product) => `
    <form class="store-product-row" data-product-id="${escapeHtml(product.id)}">
      <span class="store-product-icon">${escapeHtml(product.emoji || '🍽️')}</span>
      <div class="store-product-name"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category)}</small></div>
      <label class="price-field">Precio<input name="price" type="number" min="0" max="1000000" step="1" value="${escapeHtml(product.price)}" required /></label>
      <button class="button button-light product-save-button" type="submit">Guardar precio</button>
      <button class="availability-button ${product.isAvailable ? 'available' : ''}" type="button" data-product-availability="${escapeHtml(product.id)}" aria-pressed="${product.isAvailable}">${product.isAvailable ? 'Disponible' : 'Agotado'}</button>
    </form>
  `).join('') || '<p class="empty-state">Aún no tienes productos. Agrega el primero para que aparezca en el catálogo.</p>';
}

function renderAdminMetrics(summary) {
  const activeOrders = Object.entries(summary.orders)
    .filter(([status]) => !['delivered', 'cancelled'].includes(status))
    .reduce((total, [, count]) => total + count, 0);
  const users = Object.values(summary.users).reduce((total, count) => total + count, 0);
  $('#admin-metrics').innerHTML = [
    ['Comercios', summary.stores.total, `${summary.stores.open} abiertos`],
    ['Cuentas activas', users, `${summary.users.customer || 0} usuarios`],
    ['Pedidos activos', activeOrders, 'En curso en la plataforma'],
    ['Domiciliarios', summary.riders.active, 'Perfiles aprobados'],
  ].map(([label, count, note]) => `
    <article class="metric-card"><span>${label}</span><strong>${count}</strong><small>${note}</small></article>
  `).join('');

  const statuses = Object.entries(statusLabels).map(([status, label]) => ({
    label,
    count: summary.orders[status] || 0,
  }));
  $('#admin-status-overview').innerHTML = statuses.map(({ label, count }) => `
    <div class="status-overview-row"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>
  `).join('');
}

function renderAdminStores(stores) {
  $('#admin-stores').innerHTML = stores.map((store) => `
    <article class="admin-store-row">
      <span class="admin-store-icon">${escapeHtml(store.emoji || '🏪')}</span>
      <div class="admin-store-copy"><strong>${escapeHtml(store.name)}</strong><small>${escapeHtml(store.type)} · ${store.productCount} productos</small></div>
      <div class="admin-store-account">${store.accountEmail
        ? `<span>Cuenta de tienda</span><strong>${escapeHtml(store.accountName)}</strong><small>${escapeHtml(store.accountEmail)}</small>`
        : '<span class="unassigned-account">Sin cuenta asignada</span>'}</div>
      <span class="store-status ${store.isOpen ? 'is-open' : 'is-closed'}">${store.isOpen ? 'Abierto' : 'Cerrado'}</span>
    </article>
  `).join('') || '<p class="empty-state">Todavía no hay comercios registrados.</p>';
}

function renderAdminUsers(users, stores) {
  const availableStores = stores.filter((store) => !store.accountEmail);
  $('#new-store').innerHTML = availableStores.map((store) =>
    `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)}</option>`,
  ).join('');
  $('#admin-users').innerHTML = users.map((user) => `
    <article class="user-row">
      <strong>${escapeHtml(user.name)}</strong>
      <span>${escapeHtml(roleLabels[user.role])}${user.storeName ? ` · ${escapeHtml(user.storeName)}` : ''}${user.role === 'customer' && user.riderStatus ? ` · Domiciliario ${user.riderStatus === 'approved' ? 'aprobado' : user.riderStatus === 'pending' ? 'pendiente' : 'rechazado'}` : ''}</span>
      <small>${escapeHtml(user.email)}</small>
      <div class="user-row-actions"><span class="account-state ${user.isActive ? 'active' : 'inactive'}">${user.isActive ? 'Activa' : 'Inactiva'}</span>
        <button class="button button-light account-toggle" type="button" data-account-toggle="${user.id}" data-next-active="${!user.isActive}" ${user.id === state.user.id ? 'disabled' : ''}>${user.id === state.user.id ? 'Tu cuenta' : user.isActive ? 'Desactivar' : 'Activar'}</button>
      </div>
    </article>
  `).join('') || '<p class="empty-state">Aún no hay cuentas de equipo.</p>';
  $('#new-store').disabled = availableStores.length === 0;
  $('#create-user-form button[type="submit"]').disabled = $('#new-role').value === 'store' && availableStores.length === 0;
}

function renderRiderApplications(applications) {
  $('#rider-application-count').textContent = applications.length ? `· ${applications.length}` : '';
  $('#admin-rider-applications').innerHTML = applications.map((application) => `
    <article class="user-row">
      <strong>${escapeHtml(application.name)}</strong>
      <span>Estudiante · Solicitud pendiente</span>
      <small>${escapeHtml(application.email)} · ${escapeHtml(formatDate(application.createdAt))}</small>
      <div class="user-row-actions">
        <button class="button button-dark" type="button" data-rider-application="${application.userId}" data-status="approved">Aprobar</button>
        <button class="button button-light" type="button" data-rider-application="${application.userId}" data-status="rejected">Rechazar</button>
      </div>
    </article>
  `).join('') || '<p class="empty-state">No hay solicitudes pendientes.</p>';
}

function renderRiderEnrollment(user) {
  const section = $('#rider-enrollment');
  const isCustomer = user.role === 'customer';
  section.hidden = !isCustomer || user.riderStatus === 'approved';
  if (!isCustomer) return;
  const button = $('#rider-apply');
  button.disabled = false;
  if (user.riderStatus === 'pending') {
    $('#rider-application-status').textContent = 'Tu solicitud está pendiente de revisión por administración.';
    button.hidden = true;
  } else if (user.riderStatus === 'rejected') {
    $('#rider-application-status').textContent = 'Tu solicitud no fue aprobada. Puedes volver a solicitar acceso.';
    button.textContent = 'Volver a solicitar acceso';
    button.hidden = false;
  } else {
    $('#rider-application-status').textContent = 'Solicita ser domiciliario. Administración revisará tu solicitud y podrás activar tu disponibilidad cuando te aprueben.';
    button.textContent = 'Solicitar acceso como domiciliario';
    button.hidden = false;
  }
}

function renderRiderAvailability(user) {
  const button = $('#rider-availability');
  button.setAttribute('aria-pressed', String(Boolean(user.riderAvailable)));
  button.textContent = user.riderAvailable ? 'Pausar disponibilidad' : 'Activar disponibilidad';
  $('#rider-availability-status').textContent = user.riderAvailable
    ? 'Estás disponible para recibir pedidos listos.'
    : 'Estás pausado y no verás pedidos disponibles. Tus pedidos asignados siguen apareciendo aquí.';
}

function renderAdminReport(report) {
  $('#admin-report-metrics').innerHTML = [
    ['Pedidos recibidos', report.totals.orders, `Últimos ${report.days} días`],
    ['Entregados', report.totals.delivered, 'Pedidos completados'],
    ['Cancelados', report.totals.cancelled, 'En el período'],
    ['Valor entregado', money.format(report.totals.deliveredValue), 'Estimación, no pago procesado'],
  ].map(([label, count, note]) => `
    <article class="metric-card"><span>${label}</span><strong>${count}</strong><small>${note}</small></article>
  `).join('');
  $('#admin-report-stores').innerHTML = report.stores.map((store) => `
    <div class="report-row"><strong>${escapeHtml(store.storeName)}</strong><span>${store.orders} pedidos · ${store.delivered} entregados</span><b>${money.format(store.deliveredValue)}</b></div>
  `).join('') || '<p class="empty-state">No hay pedidos en este período.</p>';
  $('#admin-report-daily').innerHTML = report.daily.map((day) => `
    <div class="report-row"><strong>${escapeHtml(new Date(`${day.date}T00:00:00Z`).toLocaleDateString('es-CO', { timeZone: 'UTC' }))}</strong><span>${day.orders} pedidos · ${day.delivered} entregados</span><b>${money.format(day.deliveredValue)}</b></div>
  `).join('') || '<p class="empty-state">No hay actividad en este período.</p>';
}

async function loadDashboard() {
  showDashboardError('');
  try {
    const hasRiderAccess = state.user.role === 'rider' || state.user.riderStatus === 'approved';
    const isDualRider = state.user.role === 'customer' && hasRiderAccess;
    const [orders, riderOrders] = await Promise.all([
      requestJson(state.user.role === 'customer' ? '/api/orders' : '/api/portal/orders'),
      isDualRider ? requestJson('/api/portal/orders') : Promise.resolve(null),
      loadNotifications(),
    ]);
    state.orders = orders;
    const elementByRole = {
      customer: '#customer-orders',
      store: '#store-orders',
      rider: '#rider-orders',
      admin: '#admin-orders',
    };
    renderOrders($(elementByRole[state.user.role]), orders, state.user.role);
    if (isDualRider) renderOrders($('#rider-orders'), riderOrders, 'rider');
    if (hasRiderAccess) renderRiderAvailability(state.user);
    if (state.user.role === 'store') {
      const [profile, products] = await Promise.all([
        requestJson('/api/store/profile'),
        requestJson('/api/store/products'),
      ]);
      state.storeProducts = products;
      $('#store-name').textContent = profile.name;
      $('#store-type').textContent = profile.type;
      $('#store-avatar').textContent = profile.emoji || '🏪';
      $('#store-state-label').textContent = profile.isOpen ? 'Abierta' : 'Cerrada';
      $('#store-state-dot').classList.toggle('is-closed', !profile.isOpen);
      $('#store-open-toggle').setAttribute('aria-pressed', String(profile.isOpen));
      renderStoreMetrics(orders);
      renderStoreProducts();
    }
    if (state.user.role === 'admin') {
      const [summary, stores, users, applications, report] = await Promise.all([
        requestJson('/api/admin/summary'),
        requestJson('/api/admin/stores'),
        requestJson('/api/admin/users'),
        requestJson('/api/admin/rider-applications'),
        requestJson(`/api/admin/reports?days=${encodeURIComponent($('#report-days').value)}`),
      ]);
      renderAdminMetrics(summary);
      renderAdminStores(stores);
      renderAdminUsers(users, stores);
      renderRiderApplications(applications);
      renderAdminReport(report);
    }
  } catch (error) {
    showDashboardError(error.message);
  }
}

async function showAuthenticatedApp(user) {
  state.user = user;
  state.notifications = [];
  renderNotifications();
  state.cart = loadCart(user.id);
  state.location = loadLocation(user.id);
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#account-label').textContent = `${user.name} · ${roleLabels[user.role]}`;
  const isCustomer = user.role === 'customer';
  $('#app-shell > main').hidden = !isCustomer;
  $('#role-dashboard').hidden = false;
  $('#role-eyebrow').textContent = `${roleLabels[user.role].toUpperCase()} · PANEL`;
  $('#role-title').textContent = isCustomer ? 'Mis pedidos' : `Panel de ${roleLabels[user.role].toLowerCase()}`;
  $('#customer-panel').hidden = user.role !== 'customer';
  $('#store-panel').hidden = user.role !== 'store';
  $('#rider-panel').hidden = !(user.role === 'rider' || user.riderStatus === 'approved');
  $('#admin-panel').hidden = user.role !== 'admin';
  renderRiderEnrollment(user);
  if (user.role === 'rider' || user.riderStatus === 'approved') renderRiderAvailability(user);
  $('.location-pill').hidden = !isCustomer;
  $('#open-cart').hidden = !isCustomer;

  if (isCustomer) {
    try {
      state.stores = await requestJson('/api/stores');
      state.products = await requestJson('/api/products');
      renderStores();
      renderProducts();
      renderCart();
      $('#catalog-error').hidden = true;
    } catch (error) {
      $('#catalog-error').textContent = `No se pudo cargar el catálogo: ${error.message}`;
      $('#catalog-error').hidden = false;
    }
  }

  await loadDashboard();
  clearInterval(notificationTimer);
  notificationTimer = setInterval(() => {
    if (!state.user || document.hidden) return;
    loadNotifications().catch((error) => showDashboardError(error.message));
    if (state.user.role === 'customer' && state.user.riderStatus === 'pending') {
      requestJson('/api/me').then(({ user: updatedUser }) => {
        if (updatedUser.riderStatus !== state.user.riderStatus) {
          state.user = updatedUser;
          renderRiderEnrollment(updatedUser);
          if (updatedUser.riderStatus === 'approved') {
            $('#rider-panel').hidden = false;
            renderRiderAvailability(updatedUser);
            loadDashboard();
          }
        }
      }).catch((error) => showDashboardError(error.message));
    }
  }, 30000);
  if (isCustomer) {
    if (state.location) {
      $('#location-label').textContent = `Bloque ${state.location.block} · ${state.location.floor}° · Aula ${state.location.classroom}`;
    } else {
      openLocation();
    }
  }
}

async function initialize() {
  try {
    const result = await requestJson('/api/me');
    await showAuthenticatedApp(result.user);
  } catch (error) {
    if (error.status === 401) {
      $('#auth-screen').hidden = false;
      $('#app-shell').hidden = true;
    } else {
      showAuthError(`No se pudo conectar con COMANDA: ${error.message}`);
    }
  }
}

storesElement.addEventListener('click', (event) => {
  const button = event.target.closest('[data-store]');
  if (!button) return;
  state.storeId = state.storeId === button.dataset.store ? null : button.dataset.store;
  renderStores();
  renderProducts();
});

$('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (button) setCategory(button.dataset.category);
});

productsElement.addEventListener('click', (event) => {
  const button = event.target.closest('[data-add]');
  if (!button) return;
  const product = state.products.find((item) => item.id === button.dataset.add);
  if (!product) return;
  const existingStoreId = cartEntries()[0]?.product.storeId;
  if (existingStoreId && existingStoreId !== product.storeId) {
    showToast('Un pedido solo puede ser de un establecimiento.');
    return;
  }
  state.cart[product.id] = (state.cart[product.id] || 0) + 1;
  renderCart();
  showToast(`${product.name} se agregó al pedido`);
});

$('#cart-items').addEventListener('click', (event) => {
  const button = event.target.closest('[data-change]');
  if (!button) return;
  const id = button.dataset.id;
  state.cart[id] = (state.cart[id] || 0) + Number(button.dataset.change);
  if (state.cart[id] <= 0) delete state.cart[id];
  renderCart();
});

$('#search').addEventListener('input', renderProducts);
$('#clear-filters').addEventListener('click', () => {
  $('#search').value = '';
  state.storeId = null;
  setCategory('Todos');
  renderStores();
});
$('#zone').addEventListener('change', renderCart);
$('#open-cart').addEventListener('click', openCart);
$('#close-cart').addEventListener('click', closeCart);
$('#continue-shopping').addEventListener('click', () => {
  closeCart();
  $('#catalogo').scrollIntoView({ behavior: 'smooth' });
});
$('#change-location').addEventListener('click', openLocation);
$('#scrim').addEventListener('click', closeModals);
document.querySelectorAll('.modal-close').forEach((button) => button.addEventListener('click', closeModals));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModals();
});

$('#location-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const form = new FormData(event.currentTarget);
  setLocation({
    block: Number(form.get('block')),
    floor: Number(form.get('floor')),
    classroom: String(form.get('classroom')).trim(),
  });
});

$('#checkout-button').addEventListener('click', () => {
  if (!state.location) {
    closeCart();
    openLocation();
    return;
  }
  $('#checkout-location').textContent =
    `Bloque ${state.location.block}, piso ${state.location.floor}, aula ${state.location.classroom}`;
  closeCart();
  checkoutModal.hidden = false;
  renderCart();
  syncOverlay();
  $('#zone').focus();
});

$('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  try {
    const order = await requestJson('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.location,
        note: formData.get('note'),
        contactPhone: formData.get('contactPhone'),
        deliveryZone: formData.get('deliveryZone'),
        paymentMethod: formData.get('paymentMethod'),
        items: cartEntries().map(({ product, quantity }) => ({ productId: product.id, quantity })),
      }),
    });
    $('#result-copy').textContent =
      `${order.orderCode} · ${order.store} · ${money.format(order.total)} estimados. La tienda recibió un aviso dentro de COMANDA; no se realizó ningún cobro.`;
    state.cart = {};
    renderCart();
    form.reset();
    closeModals();
    resultModal.hidden = false;
    syncOverlay();
    await loadDashboard();
  } catch (error) {
    showToast(`No se guardó el pedido: ${error.message}`);
  }
});

function showAuthTab(tab) {
  const isRegister = tab === 'register';
  $('#login-panel').hidden = isRegister;
  $('#register-panel').hidden = !isRegister;
  $('#login-tab').classList.toggle('active', !isRegister);
  $('#register-tab').classList.toggle('active', isRegister);
  $('#login-tab').setAttribute('aria-selected', String(!isRegister));
  $('#register-tab').setAttribute('aria-selected', String(isRegister));
  showAuthError('');
}

$('#login-tab').addEventListener('click', () => showAuthTab('login'));
$('#register-tab').addEventListener('click', () => showAuthTab('register'));

$('#login-panel').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  try {
    const result = await requestJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: formData.get('email'),
        password: formData.get('password'),
      }),
    });
    form.reset();
    showAuthError('');
    await showAuthenticatedApp(result.user);
  } catch (error) {
    showAuthError(error.message);
  }
});

$('#register-panel').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  try {
    const result = await requestJson('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        email: formData.get('email'),
        password: formData.get('password'),
      }),
    });
    form.reset();
    showAuthError('');
    await showAuthenticatedApp(result.user);
  } catch (error) {
    showAuthError(error.message);
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
    closeModals();
    clearInterval(notificationTimer);
    state.user = null;
    state.cart = {};
    state.location = null;
    $('#app-shell').hidden = true;
    $('#auth-screen').hidden = false;
    showAuthTab('login');
  } catch (error) {
    showToast(`No se pudo cerrar sesión: ${error.message}`);
  }
});

$('#role-dashboard').addEventListener('click', async (event) => {
  const applicationButton = event.target.closest('[data-rider-application]');
  if (applicationButton) {
    applicationButton.disabled = true;
    try {
      await requestJson(`/api/admin/rider-applications/${encodeURIComponent(applicationButton.dataset.riderApplication)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: applicationButton.dataset.status }),
      });
      showToast(applicationButton.dataset.status === 'approved' ? 'Solicitud aprobada.' : 'Solicitud rechazada.');
      await loadDashboard();
    } catch (error) {
      showDashboardError(error.message);
      applicationButton.disabled = false;
    }
    return;
  }

  if (event.target.closest('#rider-apply')) {
    const button = $('#rider-apply');
    button.disabled = true;
    try {
      await requestJson('/api/rider/applications', { method: 'POST' });
      state.user = { ...state.user, riderStatus: 'pending', riderAvailable: false };
      renderRiderEnrollment(state.user);
      showToast('Solicitud enviada para revisión.');
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
    return;
  }

  if (event.target.closest('#rider-availability')) {
    const button = $('#rider-availability');
    const isAvailable = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true;
    try {
      await requestJson('/api/rider/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAvailable }),
      });
      state.user = { ...state.user, riderAvailable: isAvailable };
      renderRiderAvailability(state.user);
      await loadDashboard();
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
    return;
  }

  const notificationButton = event.target.closest('[data-notification-read]');
  if (notificationButton) {
    notificationButton.disabled = true;
    try {
      await requestJson(`/api/notifications/${encodeURIComponent(notificationButton.dataset.notificationRead)}/read`, {
        method: 'PATCH',
      });
      await loadNotifications();
    } catch (error) {
      showDashboardError(error.message);
      notificationButton.disabled = false;
    }
    return;
  }

  const accountButton = event.target.closest('[data-account-toggle]');
  if (accountButton) {
    const isActive = accountButton.dataset.nextActive === 'true';
    const action = isActive ? 'activar' : 'desactivar';
    if (!window.confirm(`¿Confirmas que deseas ${action} esta cuenta?`)) return;
    accountButton.disabled = true;
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(accountButton.dataset.accountToggle)}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      showToast(`Cuenta ${isActive ? 'activada' : 'desactivada'}.`);
      await loadDashboard();
    } catch (error) {
      showDashboardError(error.message);
      accountButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest('[data-order][data-status]');
  if (!button) return;
  const actionRole = state.user.role === 'customer' && button.closest('#rider-panel')
    ? 'rider'
    : state.user.role;
  if (actionRole === 'customer' && !window.confirm('¿Quieres cancelar este pedido?')) return;
  button.disabled = true;
  try {
    if (actionRole === 'customer') {
      await requestJson(`/api/orders/${encodeURIComponent(button.dataset.order)}/cancel`, {
        method: 'PATCH',
      });
    } else {
      await requestJson(`/api/portal/orders/${encodeURIComponent(button.dataset.order)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: button.dataset.status }),
      });
    }
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

$('#store-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-store-tab]');
  if (!button) return;
  document.querySelectorAll('#store-tabs [data-store-tab]').forEach((tab) =>
    tab.classList.toggle('active', tab === button),
  );
  $('#store-orders-view').hidden = button.dataset.storeTab !== 'orders';
  $('#store-catalog-view').hidden = button.dataset.storeTab !== 'catalog';
});

$('#admin-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-admin-tab]');
  if (!button) return;
  document.querySelectorAll('#admin-tabs [data-admin-tab]').forEach((tab) =>
    tab.classList.toggle('active', tab === button),
  );
  ['overview', 'stores', 'accounts', 'rider-applications', 'orders', 'reports'].forEach((view) => {
    $(`#admin-${view}-view`).hidden = button.dataset.adminTab !== view;
  });
});

$('#report-days').addEventListener('change', async () => {
  try {
    const report = await requestJson(`/api/admin/reports?days=${encodeURIComponent($('#report-days').value)}`);
    renderAdminReport(report);
  } catch (error) {
    showDashboardError(error.message);
  }
});

$('#store-order-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-filter]');
  if (!button) return;
  state.storeOrderFilter = button.dataset.orderFilter;
  document.querySelectorAll('#store-order-filters [data-order-filter]').forEach((filter) =>
    filter.classList.toggle('active', filter === button),
  );
  renderOrders($('#store-orders'), state.orders, 'store');
});

$('#store-open-toggle').addEventListener('click', async () => {
  const button = $('#store-open-toggle');
  button.disabled = true;
  try {
    await requestJson('/api/store/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isOpen: button.getAttribute('aria-pressed') !== 'true' }),
    });
    await loadDashboard();
  } catch (error) {
    showDashboardError(error.message);
  } finally {
    button.disabled = false;
  }
});

$('#show-product-form').addEventListener('click', () => {
  $('#create-product-form').hidden = false;
  $('#product-name').focus();
});
$('#cancel-product-form').addEventListener('click', () => {
  $('#create-product-form').reset();
  $('#create-product-form').hidden = true;
});

$('#create-product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  try {
    await requestJson('/api/store/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.get('name'),
        category: data.get('category'),
        price: Number(data.get('price')),
        emoji: data.get('emoji'),
      }),
    });
    form.reset();
    form.hidden = true;
    showToast('Producto agregado al catálogo.');
    await loadDashboard();
  } catch (error) {
    showDashboardError(error.message);
  }
});

$('#store-products').addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-product-id]');
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const data = new FormData(form);
    await requestJson(`/api/store/products/${encodeURIComponent(form.dataset.productId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: Number(data.get('price')) }),
    });
    showToast('Precio actualizado.');
    await loadDashboard();
  } catch (error) {
    showDashboardError(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

$('#store-products').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-product-availability]');
  if (!button) return;
  button.disabled = true;
  const product = state.storeProducts.find((item) => item.id === button.dataset.productAvailability);
  if (!product) {
    button.disabled = false;
    return;
  }
  try {
    await requestJson(`/api/store/products/${encodeURIComponent(product.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAvailable: !product.isAvailable }),
    });
    await loadDashboard();
  } catch (error) {
    showDashboardError(error.message);
    button.disabled = false;
  }
});

$('#refresh-dashboard').addEventListener('click', loadDashboard);

function updateStoreField() {
  const isStoreAccount = $('#new-role').value === 'store';
  $('#new-store-label').hidden = !isStoreAccount;
  $('#new-store').hidden = !isStoreAccount;
  $('#new-store').required = isStoreAccount;
  $('#create-user-form button[type="submit"]').disabled = isStoreAccount && $('#new-store').options.length === 0;
}

$('#new-role').addEventListener('change', updateStoreField);
updateStoreField();

$('#create-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  try {
    await requestJson('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        email: formData.get('email'),
        role: formData.get('role'),
        storeId: formData.get('storeId'),
        password: formData.get('password'),
      }),
    });
    form.reset();
    updateStoreField();
    showToast('Cuenta creada. Comparte las credenciales de forma segura.');
    await loadDashboard();
  } catch (error) {
    showDashboardError(error.message);
  }
});

$('#create-store-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  try {
    await requestJson('/api/admin/stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.get('name'),
        type: data.get('type'),
        emoji: data.get('emoji'),
      }),
    });
    form.reset();
    showToast('Comercio agregado. Ya puedes asignarle una cuenta.');
    await loadDashboard();
  } catch (error) {
    showDashboardError(error.message);
  }
});

initialize();
