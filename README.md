# COMANDA

Prototipo local de pedidos para la comunidad de la Universidad de La Guajira. Usa Node.js, SQLite integrado y una interfaz web instalable tipo PWA. No requiere paquetes externos.

## Requisitos

- Node.js 22.13 o superior.

## Ejecutar localmente

```powershell
npm start
```

Abre <http://127.0.0.1:3000>. La primera ejecución crea `data/comanda.sqlite` y carga comercios y productos de demostración.

## Roles y cuentas

La aplicación tiene cuatro roles:

- **Usuario:** se registra con correo institucional, consulta el catálogo y el historial, guarda su ubicación habitual en este navegador y puede añadir un celular opcional por pedido. También puede solicitar acceso como domiciliario sin perder su cuenta de usuario.
- **Tienda:** cuenta creada por un administrador; ve y actualiza pedidos de su comercio, abre o cierra la tienda y administra su catálogo.
- **Domiciliario:** puede ser una cuenta creada por administración o un usuario estudiante cuya solicitud fue aprobada. El estudiante activa o pausa su disponibilidad cuando quiera; consulta dirección e indicaciones, acepta pedidos disponibles y actualiza la entrega. Ve el teléfono solo después de aceptar un pedido activo.
- **Administrador:** consulta resúmenes e informes por período, registra comercios, crea y activa/desactiva cuentas, aprueba o rechaza solicitudes de estudiantes y supervisa pedidos.

El dominio de registro inicial es `uniguajira.edu.co`; se puede cambiar con `INSTITUTIONAL_EMAIL_DOMAIN` y debe confirmarse con la Universidad. Crea el primer administrador desde una terminal interactiva:

```powershell
npm run create-admin
```

La contraseña se solicita y confirma sin mostrarla y debe tener al menos 12 caracteres. Luego inicia `npm start` e ingresa con esa cuenta. Las contraseñas se guardan con scrypt; la sesión usa una cookie HttpOnly. En producción, sirve el sitio sobre HTTPS y configura `COOKIE_SECURE=true`.

Para crear una copia consistente de SQLite mientras la app está en uso:

```powershell
npm run backup
```

La copia queda en `backups/` (excluida del control de versiones). Puedes definir `DATABASE_PATH` para indicar otra base y `BACKUP_DIRECTORY` para cambiar el destino. Protege las copias porque contienen datos de pedidos. Los errores internos se registran como JSON en la salida del servidor.

## Pruebas

```powershell
npm test
```

## Alcance actual

- Catálogo de demostración con filtro, búsqueda y carrito.
- Registro e inicio de sesión con contraseñas cifradas y sesiones por rol.
- Selección de bloque, piso y aula.
- Creación de pedido para un solo establecimiento, con importes calculados en el servidor.
- Persistencia local de pedidos y sus productos.
- Seguimiento del historial de estados y avisos internos para tiendas, usuarios y domiciliarios.
- Cancelación por el usuario mientras el pedido esté recibido o confirmado, antes de iniciar la preparación.
- Contacto opcional por pedido y compartido solo con la tienda del pedido y el domiciliario que lo acepta mientras sigue activo.
- Paneles de usuario, tienda, domiciliario y administrador con permisos verificados en la API.
- Solicitud y aprobación administrativa para que estudiantes se sumen como domiciliarios, conservando su cuenta de usuario y controlando su disponibilidad.
- Catálogo editable por tienda; gestión y activación de cuentas; reportes de pedidos y valor estimado entregado para administración.
- Creación manual de copias consistentes de la base de datos SQLite.
- PWA básica con shell estático en caché.

Las tarifas de zona y los comercios/productos son datos de demostración; deben reemplazarse por la matriz y la información acordadas con la Universidad. Los informes muestran valor de pedidos entregados, no pagos procesados. Los avisos son internos a la aplicación y se actualizan mientras el panel está abierto; todavía no hay correo, notificaciones push, pagos reales, soporte de reembolsos ni despliegue productivo. La autenticación no verifica el correo con un enlace. El teléfono es opcional, se guarda por pedido y se oculta al finalizarlo. No usar con datos personales reales ni exponer públicamente como servicio real.

## Decisiones para antes del piloto

- Verificar correo institucional y completar verificación por enlace.
- Validar plano, bloques, aulas, distancias, tarifas y permisos del campus.
- Acordar comisión, liquidaciones y flujo legal de pagos con asesoría contable y laboral.
- Confirmar las reglas de cancelación, reembolsos, privacidad y soporte con la Universidad.
