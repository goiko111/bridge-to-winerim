
## Don Quijote Marbella — recuperación historial septiembre 2026 (conn 8466c229-773d-4ad9-a747-9bb862d7ae6b)
- [x] SOLO LECTURA: Ágora 01–18/09 + historial completo Winerim (includeLegacy)
- [x] Listado definitivo aprobado por Goiko (GO 19/09)
- [x] Ticket 42431 importado con soldAt 2026-09-16 17:45:16 (4 líneas, 57 uds, historial + stock)
- [x] Día 11/09 recuperado con save-sales (20 líneas, 21 uds, historial + stock, copas vía ajuste Winerim)
- [ ] Déficit de inventario Conde de Haro Brut Rosé (>=1 botella): resolver con el restaurante
- [ ] 45 líneas AMBIGUAS (53 uds) sin importar: requieren criterio del restaurante
- [ ] Septiembre no cerrado: corte actual 19/09 exclusivo; 19/09 en adelante pendiente

## Luruna + Cienvinos Écija — auditoría septiembre 2026 (SOLO LECTURA, sin GO)
- [x] Cobertura: Cienvinos 19/19 días Ágora; Luruna solo 18–19/09 (su TPV no sirve días pasados)
- [x] Historial Winerim completo includeLegacy (Luruna 35, Cienvinos 1278)
- [x] Alerta factura 44572 resuelta (1 sola línea; el CSV antiguo repetía snapshot)
- [x] Informe + 3 CSV entregados para aprobación
- [ ] GO de Goiko para importar faltantes (Cienvinos 268 uds, Luruna 2 uds)
- [ ] Decidir sobre doble registro en Winerim (109 uds) y exceso 17–18/09 Cienvinos
- [ ] Luruna: mapeo de productos incompleto + bucle de reintentos con stock 0 (360 FAILED)
- [ ] Confirmar con los restaurantes si regularizaron existencias (stock previo DESCONOCIDO)

## Taberna de Elia — vinos activos que no aparecían en el TPV (Mahaia y más) — 2026-09-20
- [x] Diagnóstico: ocultación automática por error momentáneo de lectura de precio, sin reactivación
- [x] Paso 1: 6 vinos con precio vivo vueltos a mostrar y verificados en el TPV
- [x] Paso 2: los 21 vinos "con error" son 404 reales en Winerim (borrados en esa cuenta): el ocultado fue correcto
- [x] Paso 3a: winerim-proxy ya no desactiva ni oculta con una lectura truncada/vacía/masiva y re-muestra solo lo oculto automáticamente cuando el precio vuelve
- [x] Paso 3b: el evaluador automático ya carga precios de media botella/botella pequeña/benjamín (antes los leía como "sin precio" y los ocultaba)
- [x] 4 órdenes de ocultación erróneas bloqueadas y visibilidad restaurada (5 formatos)
- [ ] Costalara magnum sigue oculto a propósito (retirada controlada, sin precio)
