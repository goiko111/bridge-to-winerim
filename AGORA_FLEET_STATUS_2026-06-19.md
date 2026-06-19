# Agora fleet status · 2026-06-19

## Resumen operativo

- Auditoria viva de conexiones Agora en Lovable Cloud tras activar Katsu.
- No se tocaron colas de conexiones con fallo de red/API, salvo el drenaje normal de Katsu.
- Katsu queda en modo definitivo Winerim y cola limpia.

## Estado por conexion

1. **Katsu Izakaya**
   - Estado: activo, modo `XML_IMPORT`, familias Winerim dedicadas, copas activas.
   - Catalogo: `131/131` formatos Winerim presentes y vendibles.
   - Legacy: oculto reversible, `198` productos legacy no vendibles.
   - Ventas: cursor en `2026-06-18`.
   - Cola: `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
   - Accion: validar primera venta real posterior desde boton Winerim.

2. **Casa Nene**
   - Estado: activo, Agora responde.
   - Ventas: cursor en `2026-06-18`.
   - Stock reciente: `66 SUCCESS`.
   - Cola: `1 FAILED`.
   - Accion: inspeccionar la tarea fallida sin reintentar en bloque.

3. **Kava**
   - Estado: activo, Agora responde.
   - Ventas: cursor en `2026-06-18`.
   - Stock reciente: `77 SUCCESS`, `23 BLOCKED`.
   - Cola: `7 FAILED`, `9 BLOCKED`.
   - Accion: clasificar deuda antigua; no hay cola viva `QUEUED/RUNNING`.

4. **La Candela de Triana**
   - Estado: activo, Agora responde.
   - Ventas: cursor en `2026-06-18`.
   - Cola: limpia.
   - Accion: validar primera venta Winerim con stock, porque no hay stock reciente en la muestra.

5. **Luruna**
   - Estado: activo, Agora responde en la auditoria actual.
   - Ventas: cursor en `2026-06-18`.
   - Stock reciente: `9 SUCCESS`.
   - Cola: `10 FAILED`, `58 BLOCKED`.
   - Accion: clasificar deuda antigua y confirmar con cliente que no vuelve la saturacion.

6. **Sa Pedrera**
   - Estado: activo, Agora responde.
   - Ventas: cursor en `2026-06-17`.
   - Stock reciente: `87 SUCCESS`, `13 FAILED`.
   - Cola historica: `298 FAILED`, `1000 BLOCKED` en la muestra.
   - Accion: no reintentar masivo; clasificar fallos historicos y validar ventas nuevas Winerim.

7. **Restaurante Jardi**
   - Estado: activo en configuracion, pero test actual falla `502 No route to the Agora server`.
   - Ventas: cursor en `2026-06-17`.
   - Cola: `1 QUEUED`, `3 FAILED`.
   - Accion: recuperar ruta/firewall/DDNS antes de procesar la cola. No drenar mientras Agora no responda.

8. **Restaurante Cienvinos Ecija**
   - Estado: activo en configuracion, pero test actual termina en timeout.
   - Ventas: cursor en `2026-05-27`.
   - Cola: `131 QUEUED`, `4 BLOCKED`.
   - Accion: revisar conectividad/latencia antes de tocar cola.

9. **Sa Vida**
   - Estado: activo en configuracion, pero Agora devuelve `501`.
   - Ventas: cursor en `2026-05-03`.
   - Cola: `552 QUEUED`, mas de `1000 FAILED` y mas de `1000 BLOCKED` en la muestra.
   - Accion: no reintentar; el modulo/API publica sigue sin responder con los endpoints esperados.

10. **Baco Getafe**
    - Estado: desactivado/revertido a legacy.
    - Cola: limpia.
    - Stock historico reciente: `41 SUCCESS`.
    - Accion: no tratarlo como automatico Winerim mientras siga apagado.

## Regla de seguridad

- No reintentar ni drenar colas de conexiones con test fallido (`Jardi`, `Cienvinos`, `Sa Vida`) hasta que `Families`/`Products` respondan de forma estable.
- No limpiar deuda historica (`FAILED/BLOCKED`) en bloque sin clasificar por conexion y tipo de tarea.
