# Infra QA / Security - 2026-08-02 - Segunda ola

## Veredicto

| Superficie | Veredicto | Motivo |
|---|---|---|
| Local | `GO` | Esquema reproducible, roles separados, handlers/adapters presentes y suite completa verde. |
| Staging privado | `NO_GO_REMOTE_GATES` | Falta materializar Postgres, logins, Hyperdrive, Access/DNS/secrets y wiring remoto. |
| Produccion | `NO_GO` | Falta staging end-to-end, export consistente de Lovable, canary y rollback probado. |

La segunda ola cierra los findings locales anteriores sobre Access solo en
staging, rol DB compartido, redirects, puertos, limites de payload y ausencia de
handlers/adapters. El bloqueo actual ya no es el codigo local: son los recursos
administrados, la configuracion remota y la migracion consistente de datos.

## Alcance

- Worktree: `/private/tmp/winerim-own-infra-clean`.
- Revision independiente de esquema/RLS/grants, API/Access/SSRF, workflow,
  runtime, handlers, adapters, queues, idempotencia, breaker y gates remotos.
- No se desplego, no se aplicaron migraciones remotas, no se consultaron
  secretos y no se modificaron archivos distintos de este informe.

## Findings restantes

### H-01 - Falta provisionar Postgres administrado y principals LOGIN

**Severidad:** Alta. **Gate:** bloquea staging funcional.

El bootstrap crea correctamente tres roles de capacidad separados y `NOLOGIN`:

- `middleware_api`: lecturas de control-plane e INSERT de onboarding.
- `middleware_runtime`: operaciones del runtime y RPC revisadas.
- `middleware_readonly`: diagnostico por SELECT.

El empty replay demuestra RLS y grants minimos, pero todavia no existe un
Postgres administrado del middleware con proveedor, region, version, TLS,
backups/PITR y restore test aprobados. Tampoco existen principals LOGIN externos
asociados uno-a-uno a `middleware_api`, `middleware_runtime` y
`middleware_readonly`, ni un usuario migrador separado.

**Aceptacion:** provisionar DB aislada, crear los LOGIN fuera del repositorio,
conceder un solo rol de capacidad por principal y ejecutar
`validate-readonly.sql` comprobando `current_user`, RLS, grants, funciones y
sentinel `environment=staging`.

### H-02 - Falta Hyperdrive propio y prueba DB remota

**Severidad:** Alta. **Gate:** bloquea API/runtime con datos de staging.

El adapter PostgreSQL/Hyperdrive esta implementado y probado, pero no existe un
Hyperdrive propio del middleware enlazado como `MIDDLEWARE_DB`. Los tres tests
de integracion DB se omiten precisamente porque no hay URL remota segura.

No debe reutilizarse un Hyperdrive de otro sistema ni conectar la API y el
runtime con la misma credencial LOGIN.

**Aceptacion:** crear Hyperdrive API y runtime con identidades distintas,
verificar TLS y limites de conexion, ejecutar los `3/3` tests DB remotos y
obtener `/ready` verde con el sentinel correcto.

### H-03 - Access, DNS y secrets siguen sin evidencia remota completa

**Severidad:** Alta. **Gate:** bloquea abrir staging al equipo.

El codigo y Wrangler ya exigen `REQUIRE_ACCESS_JWT="true"` en staging y
produccion; `workers_dev=false` tambien esta fijado en ambos entornos. El Worker
valida RS256, firma, `kid`, audiencia, issuer, `exp` y `nbf`.

Falta materializar y demostrar remotamente:

- DNS de API y Pages staging.
- Aplicaciones/policies Access sobre dominio API, Pages, `pages.dev` y previews.
- `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, service token CI y secrets Worker.
- Denegacion `401/403` sin Access y acceso permitido solo con identidad valida.
- Ausencia real de endpoint `workers.dev` tras desplegar el artefacto nuevo.

### H-04 - Runtime local completo, pero wiring remoto aun inerte

**Severidad:** Alta. **Gate:** bloquea procesamiento real.

Ya existen y se exportan:

- handlers de catalogo, ventas, stock y outbound;
- adapters PostgreSQL de catalogo, ventas, stock y outbound;
- adapters HTTP seguros para Agora y Winerim;
- executor provider-neutral y service adapter;
- contratos de claim, retry, breaker `POS_DOWN`, superseded, redaccion,
  idempotencia y limitador de `2 req/s`.

El runtime desplegable sigue deliberadamente inerte:
`RUNTIME_EXECUTION_ENABLED=false`, sin `MIDDLEWARE_DB`, sin `RUNTIME_EXECUTOR`,
sin consumers y sin DLQ enlazada. El workflow hace dry-run del runtime, pero no
lo despliega ni configura sus recursos.

**Aceptacion:** desplegar primero el Worker inerte, comprobar cero trafico,
enlazar Hyperdrive/executor, añadir consumers y DLQ con execution aun apagada,
validar `/ready`, y activar una unica conexion sintetica mediante canary con
snapshot, idempotencia, breaker, limite `2 req/s`, logs redacted y rollback.

### H-05 - Falta export consistente de Lovable y reconciliacion

**Severidad:** Alta. **Gate:** bloquea migracion de datos y produccion.

La incidencia del data-plane de Lovable impide acreditar un export consistente
de produccion. Sin un snapshot coherente no se pueden validar conteos, claves,
FK, cursores, tareas, idempotencia, tracking, credenciales ni reconciliaciones
post-import. Copiar tablas por lecturas parciales podria mezclar estados de
momentos distintos.

**Aceptacion:** obtener export transaccional o snapshot consistente identificado
por fecha y hash; importarlo con crons, queues y red saliente desactivados;
reconciliar tablas/constraints; ejecutar validacion read-only y canaries antes
de cualquier cambio de trafico. Los secretos se migran por canal seguro, nunca
dentro del dump versionado.

### M-01 - Workflow aun no cubre todo el rollout remoto

**Severidad:** Media.

El workflow ya incluye SHA/destino/sentinel, orden serial, API y runtime
dry-run, smoke PostgreSQL local, `/ready`, comprobacion de rechazo sin Access,
Pages privada y rollback del Worker API. Aun falta automatizar o documentar con
evidencia equivalente:

- provision y verificacion de Hyperdrive/LOGIN roles;
- deploy inerte del Worker runtime;
- consumers/DLQ y rollback de sus bindings;
- smoke del executor y queues;
- rollback/recuperacion de Pages y compatibilidad de migraciones DB.

### M-02 - Hardening operativo a demostrar en canary

**Severidad:** Media.

Los contratos y adapters tienen cobertura local, pero el comportamiento
distribuido debe probarse en Cloudflare/Postgres reales: lease de claims,
redelivery, poison messages, DLQ, concurrencia de breaker, transicion tras fallo
parcial, limite global `2 req/s` e idempotencia ante timeout con commit incierto.
Este finding no cuestiona los tests unitarios; exige evidencia operacional.

## Findings superados en segunda ola

- `SUPERADO`: Access requerido solo en staging. Ahora staging y produccion lo
  exigen en Wrangler.
- `SUPERADO`: API y runtime compartian privilegios globales. Existe
  `middleware_api` separado con grants acotados.
- `SUPERADO`: redirects POS seguidos automaticamente. API usa
  `redirect="error"`; runtime usa `redirect="manual"` y bloquea `3xx`.
- `SUPERADO`: puertos arbitrarios. Onboarding limita a `80`, `443` y `8984` y
  mantiene allowlist exacta de host.
- `SUPERADO`: requests/responses sin limite. API limita request a `64 KiB` y
  respuesta POS a `128 KiB`; adapters runtime tienen timeout y limite de body.
- `SUPERADO`: handlers sin adapters ni executor. Estan presentes, exportados y
  cubiertos por pruebas de persistencia, claims, readback, dry-run y ejecucion.
- `SUPERADO`: ausencia de dry-run runtime en CI. El workflow lo ejecuta.

## Controles positivos

- Bootstrap reproducible y empty replay OK.
- RLS habilitado en todas las tablas publicas tras hardening.
- Grants revocados a `PUBLIC`, `authenticated` y `service_role`.
- RPC privilegiadas limitadas al rol runtime.
- Roles API/runtime/read-only separados y con policies propias.
- SQL parametrizado, identificadores allowlisteados y errores sanitizados.
- Access JWT criptograficamente validado y obligatorio en ambos entornos.
- URL sin userinfo, IP privadas literales bloqueadas, hosts/puertos
  allowlisteados y redirects bloqueados.
- Runtime sin fallback a Lovable REST.
- HTTP adapters con timeout, limites de respuesta y redaccion estructural.
- Claims e idempotencia persistentes, retry tipado y breaker provider-neutral.
- Runtime remoto permanece fail-closed mientras faltan sus bindings.

## Evidencia fresca

| Gate | Resultado |
|---|---|
| Vitest | `380/380` tests pasan en `64` files; `3` tests DB remotos skipped en `1` file. |
| TypeScript | `npx tsc --noEmit --pretty false` OK. |
| ESLint acotado | API, runtime, helpers y tests OK. |
| Frontend | Build OK. |
| Wrangler API | Dry-run OK. |
| Wrangler runtime | Dry-run OK. |
| PostgreSQL | Validate y empty replay OK. |
| Smoke PostgreSQL local | `3/3` OK. |
| Workflow | YAML OK. |
| Diff | `git diff --check` OK. |

## Gates finales

1. Seleccionar y provisionar Postgres administrado.
2. Crear principals LOGIN separados y probar grants/RLS en staging.
3. Crear Hyperdrive propio para API y runtime; pasar `3/3` tests DB remotos.
4. Configurar DNS, Access y secrets; probar rechazo y acceso autorizado.
5. Desplegar runtime inerte y verificar que no consume ni produce trabajo.
6. Enlazar executor, consumers y DLQ; ejecutar canary sintetico reversible.
7. Obtener export consistente de Lovable y reconciliarlo en staging aislado.
8. Ejecutar canary por integracion, observabilidad y rollback antes de produccion.

## Cierre

`INFRA_QA_SECOND_WAVE_RESULT=GO_LOCAL_NO_GO_REMOTE_STAGING_NO_GO_PRODUCTION`

El codigo local esta preparado para comenzar la materializacion controlada de
staging. No esta autorizado el go-live hasta cerrar Postgres/LOGIN roles,
Hyperdrive, Access/DNS/secrets, wiring remoto, canary y export consistente.
