# Paquete para un solo OK de Goiko — agora-proxy + winerim-proxy (30-sep)

## Estado real ahora mismo
- Desde 16:40 (Madrid) está en producción la versión 862 de agora-proxy = código 743806f2, y winerim-proxy con el control de llamante **bloqueando**. Se publicó sola al editar el código (sin OK). Desde entonces: 0 rechazos por permisos observados.

## Cambios que entran (respecto a la versión anterior a hoy, 4e17ffcf / 2d464ada)
1. Devolución de abiertos (b): solo con día de negocio cerrado (06:00 hora local) y nunca con factura vinculada por GlobalId. (86d6d7f1)
2. El freno de facturas tardías: añadido 16:31 y retirado 16:34 → no queda nada en el código final.
3. Control de llamante (agora-proxy y winerim-proxy): pasa de **bloquear** a **solo registro** (este paquete).
No entra nada más en esas dos funciones.

## Qué hace el modo solo registro
- Calcula la decisión (interna / admin / usuario con acceso / rechazo) y escribe una línea `CALLER_GUARD` con función, acción, restaurante, tipo de llamante, código, origen y navegador. Nunca la clave ni el token.
- Deja pasar todo. Bloquea solo si `CALLER_GUARD_MODE=enforce` (después de revisar 24 h).

## Cambio en código al aplicarlo
- Añadir `callerGuardMode.ts` al final de `_shared/connectionCallerGuard.ts`.
- agora-proxy l.5735 y winerim-proxy l.473, sustituir
  `if (!callerDecision.ok) return callerDeniedResponse(callerDecision, corsHeaders);` por
  ```ts
  const guardMode = callerGuardMode(Deno.env.get("CALLER_GUARD_MODE"));
  const guardEntry = buildCallerLog("<fn>", action, connectionId, callerDecision, guardMode, req.headers);
  if (applyCallerGuard(guardEntry) && !callerDecision.ok) return callerDeniedResponse(callerDecision, corsHeaders);
  ```
- Pruebas: `callerGuardMode.test.ts` (4) + las 9 de connectionCallerGuard + 6 de devolución + 1 del 61080.

## Cómo volver atrás
- Solo el control: poner el modo en solo registro ya no bloquea nada; para quitarlo del todo, borrar las 3 líneas y volver a publicar.
- Todo: restaurar agora-proxy de 4e17ffcf y winerim-proxy de 2d464ada; se publican en 1–2 min. Comprobación: llamada sin sesión a agora-proxy contesta «Connection not found» en vez de `MISSING_AUTH`.
- No toca ventas, stock ni configuración.

## Informe a las 24 h
Consulta de registros por `CALLER_GUARD` con `wouldBlock=true`, agrupada por función, acción, código y origen.

## Aparte (sigue pendiente de OK)
- (a) apagar la devolución de abiertos en 24 locales: solo simulación.
