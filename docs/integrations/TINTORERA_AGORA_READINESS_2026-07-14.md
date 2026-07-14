# Tintorera - Preparacion de la integracion Agora

Fecha de comprobacion: 2026-07-14 12:36 CEST

## Hechos verificados

- La conexion Tintorera existe en Lovable Cloud con frecuencia prevista de 5 minutos.
- Permanece desactivada y sin escritura: `enabled=false`, `sync_mode=PULL_ONLY`, `write_mode=NONE`.
- La creacion de familias y el auto-push de altas/cambios estan apagados.
- El legacy de Agora permanece visible y no se ha modificado ningun producto.
- El token Winerim responde correctamente.
- Winerim devuelve 302 vinos activos y con algun precio:
  - 190 tintos;
  - 67 blancos;
  - 27 espumosos;
  - 10 postre/dulces;
  - 6 rosados;
  - 2 fortificados.
- Formatos con precio detectados: 278 botella, 13 copa, 15 magnum, 5 botella pequena, 4 media botella y 3 botella tienda.
- El hostname `tintorera.dyndns.org` resuelve a `88.17.22.193`.
- El puerto TCP `8984` no responde desde Internet ni desde Lovable Cloud/backend. Las sondas HTTP a `/api/`, familias y productos terminan en timeout.

## Bloqueo actual

No se puede auditar el catalogo Agora, leer ventas ni publicar productos hasta que el servidor acepte conexiones externas en el puerto `8984`. Las causas compatibles con el resultado son servidor/TPV apagado, DDNS desactualizado, servicio de integracion detenido, regla NAT ausente o firewall bloqueando.

## Comprobaciones solicitadas al SAT

1. Confirmar que el servidor principal de Agora esta encendido y que el servicio de integracion esta iniciado.
2. Confirmar que el Modulo de Servicios de Integracion y la API HTTP estan habilitados.
3. Confirmar que Agora escucha en TCP `8984` en el servidor.
4. Confirmar que el servidor mantiene una IP local fija o una reserva DHCP.
5. Revisar la redireccion TCP `8984` del router hacia la IP local del servidor.
6. Revisar el firewall de Windows y del router.
7. Confirmar que el DDNS `tintorera.dyndns.org` apunta a la IP publica actual.
8. Probar el acceso desde una red externa, no desde el Wi-Fi del restaurante.

## Activacion segura cuando recupere conectividad

1. Probar `/api/` y leer Families, Products, IVA, listas de precios, preparacion, almacenes, centros de venta e Invoices.
2. Guardar una instantanea de familias/productos y documentar la estructura legacy.
3. Comparar el catalogo Winerim con Agora y revisar posibles coincidencias antes de crear duplicados.
4. Crear familias Winerim y publicar sus productos manteniendo visible el legacy.
5. Validar precios y orden por formato. Botella, copa y magnum tienen correspondencia directa.
6. Decidir expresamente el destino de botella pequena, media botella y botella tienda; no se convierten silenciosamente en botella estandar.
7. Hacer una prueba real de botella y otra de copa.
8. Comprobar historial de venta Winerim y descuento por variante cuando el stock este activo; si no lo esta, registrar la venta sin tocar stock.
9. Validar alta nueva, cambio de precio e inactivacion/sin precio con una ventana maxima de 5 minutos.
10. Activar la conexion y los automatismos solo despues de estas pruebas.

## Reversion

- No se borra legacy.
- Las familias/productos Winerim pueden ocultarse de forma reversible.
- Los flags de auto-push y ventas pueden apagarse por conexion.
- No se ejecuta backfill historico con impacto en stock.
