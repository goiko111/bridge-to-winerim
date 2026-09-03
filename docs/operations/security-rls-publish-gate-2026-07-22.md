# Gate de publicación RLS/Storage - 2026-07-22

## Alcance

Revisión de los cinco hallazgos críticos que impiden publicar el frontend del
commit `7001cfed3f6ef93812051c935faf42639ec5469e`. No se modificaron policies,
datos, configuración ni código durante esta revisión.

## Hechos

- Los cinco hallazgos son preexistentes (13 y 16 de julio) y no fueron
  introducidos por `7001cfed`.
- Afectan `pos_connections`, `provider_credentials`, tablas operativas y de
  ventas, buckets de imports y `user_roles`.
- Existen policies públicas permisivas sobre credenciales y datos de negocio.
- El frontend actual no tiene login ni protección de rutas y consume Lovable
  Cloud directamente. Se localizaron `68` consultas a `pos_connections`,
  además de lecturas/escrituras directas sobre colas, ventas, alertas,
  catálogo, mappings, configuración y Storage.
- Revocar acceso anónimo de golpe rompería onboarding, Settings, dashboard,
  wizards, Sync Monitor, Alerts y uploads HIOPOS/TouchBistro.
- El intento de publicar solo el frontend seguro fue detenido: Lovable Cloud
  exige resolver o ignorar los findings. No se forzó ni se marcaron resueltos.

## Riesgo por superficie

| Superficie | Exposición | Riesgo de cierre inmediato |
|---|---|---|
| `provider_credentials` | tokens OAuth/secretos | bajo para UI; primera candidata a cerrar |
| `user_roles` | posible escalada de rol | bajo para UI; requiere autorización real |
| `pos_connections` | tokens POS/Winerim y URLs | crítico: gran parte de la UI depende de acceso directo |
| ventas, catálogo, mappings, alertas y colas | datos y mutaciones operativas | alto/crítico: dashboard y wizards quedarían inoperativos |
| buckets de imports | lectura/escritura/borrado público | alto: primero se necesitan URLs firmadas/BFF |

Ocultar las tablas detrás de funciones sin validar JWT y permiso por
`connection_id` solo trasladaría la vulnerabilidad: varias funciones actuales
aceptan acciones y `connectionId` sin autorización de usuario.

## Secuencia aprobada

1. Añadir autenticación y roles `admin`, `operator`, `viewer` con alcance por
   conexión, sin cambiar todavía RLS.
2. Añadir autorización compartida a las Edge Functions; separar usuario, cron,
   webhook y OAuth.
3. Cerrar primero `provider_credentials` y `user_roles`.
4. Crear BFF administrativo con DTO redacted; los tokens serán write-only.
5. Migrar mutaciones del navegador y retirar permisos de escritura públicos.
6. Migrar uploads a rutas firmadas por conexión.
7. Migrar lecturas con dual-read temporal y comparación de resultados.
8. Revocar acceso anónimo a las tablas operativas y mantener service role solo
   en backend.

## Validación obligatoria

- `anon` no puede leer/mutar tablas sensibles ni objetos.
- Un usuario no accede a otra `connection_id`; viewer no escribe; operator no
  administra roles.
- Dashboard, Integrations, wizards, Sync Monitor, Alerts y Settings conservan
  comportamiento sin devolver secretos.
- OAuth, webhooks, cron de cinco minutos, monitor y colas siguen funcionando.
- Los uploads rechazan rutas cruzadas, MIME/tamaño inválidos y acceso sin rol.
- Tests estáticos impiden nuevas consultas frontend a tablas restringidas y
  respuestas BFF con tokens.

## Rollback

Cada fase tendrá migración y despliegue propios, frontend anterior disponible y
dual-read bajo flag. El rollback revierte solo la tabla o endpoint afectado y
nunca restaura una policy `USING (true)` para `anon`. El rol interno de cron y
proxies se mantiene durante toda la migración.
