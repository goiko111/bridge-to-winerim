# Repesaje seguro y certificación de altas/precios en toda la flota

## Objetivo
Desatascar los 3 casos de Taberna del Clinic (incluido Pétalos del Bierzo) y los equivalentes del resto de la flota, y que el resultado final de cada restaurante quede **certificado por lectura real de Ágora** (producto, formato, precio, centro de venta, lista de precios y PDA). Si un paso no se ha confirmado leyendo Ágora, no se da por certificado.

## Fases (cada una con aprobación antes de escribir)

1. **Inventario de candidatos (solo lectura)**
   - Para cada restaurante Ágora activo, excepto Ocean Club (excluido por su identificador): vinos activos en carta, con precio y sin publicar en Ágora, o publicados con precio, formato o visibilidad distintos.
   - Se excluyen los vinos que solo están en inventario, las copas bloqueadas y los casos ambiguos (formato compartido, identidad dudosa).
   - Entregable: un CSV por restaurante con el motivo del corte y la acción propuesta. Sin escrituras.

2. **Corrección en el código (sin desplegar)**
   - Añadir una acción de repesaje unitario: recibe un solo vino y formato, vuelve a comprobar las condiciones y encola una tarea con clave determinista (no duplica si ya existe una pendiente).
   - La lectura de verificación deja de sellar la marca de «verificado» cuando se ejecuta en modo auditoría, para corregir la escritura involuntaria anterior.
   - Certificación: estado `AUTO_SYNC_CERTIFICADA_POR_READBACK` solo si la lectura exacta de Ágora coincide en todo. Si falta un dato, `CONFIGURADA_SIN_CERTIFICAR` o `SOURCE_INCOMPLETE`.
   - Pruebas con datos fijos de ejemplo: Clinic, precio distinto, no visible en la PDA, formato compartido bloqueado y repetición idempotente.

3. **Piloto en Clinic (requiere GO)**
   - Desplegar solo la función afectada; repesar los 3 casos uno a uno; leer Ágora después de cada uno y certificar o parar.

4. **Resto de la flota (requiere GO por restaurante)**
   - Mismo procedimiento, un restaurante cada vez, con un límite por lote y lectura de Ágora tras cada lote. Si algo no cuadra, se para.
   - Al terminar: matriz final de la flota con altas y precios certificados, sin certificar y no operativos.

## Guardarraíles
Sin cron nuevo, sin tocar ventas, stock ni vinculaciones, sin crear ni modificar vinos en Winerim, Ocean Club excluido, copas bloqueadas y sin publicar la app. El único cambio en Ágora son las tareas de repesaje aprobadas.

## Detalles técnicos
- La nueva acción pasa por `fetchWithRetry`, el limitador y el circuit breaker, y usa `fetchAgoraProductsXmlCached` para verificar.
- Clave de la tarea: `connectionId|wineId|formato|precio`.
- Se vuelve a leer la carta justo antes de encolar, para no actuar con datos antiguos.
