# Estudio Resto / La Refineria API precheck · 2026-06-22

## Hechos

- El SAT de Estudio Informatico envio documentacion `Api Resto` v1 para consulta local.
- El documento incluye credenciales en claro. No se versionan ni se repiten en este informe.
- Endpoints documentados:
  - `POST /api/token`: obtiene JWT Bearer.
  - `GET /api/restaurantRequest/stock-items`: lista items de stock.
  - `GET /api/restaurantRequest/menu`: lista menu/carta del restaurante.
- La URL de ejemplo es una IP privada local `192.168.x.x` con HTTPS y puerto `9998`.
- La conversacion previa indica que originalmente no existia API publica; el SAT propuso crear un endpoint en la API interna usada por la aplicacion de mozos.

## Evaluacion

- Viabilidad actual: parcial, solo lectura.
- Lo que cubre:
  - leer carta/menu;
  - leer stock agregado por item;
  - autenticar con JWT.
- Lo que no cubre aun para el flujo Winerim completo:
  - lectura de ventas cerradas/tickets/facturas con lineas;
  - id unico de documento y linea para idempotencia;
  - devoluciones/anulaciones/cancelaciones;
  - fecha de negocio/cierre;
  - escritura o actualizacion de productos/precios desde Winerim;
  - activacion/desactivacion de productos;
  - separacion formal de formatos copa/botella/magnum;
  - endpoint de ajuste de stock o trazabilidad de movimientos.

## Riesgos

- Al ser una IP privada local, Lovable Cloud no puede conectarse directamente salvo que haya VPN, tunel, IP publica/puerto expuesto o conector local.
- `https://IP-local` puede implicar certificado autofirmado; las funciones backend pueden rechazar TLS si el certificado no es valido.
- Un endpoint de stock agregado no sustituye a ventas: no permite generar historial de venta ni deducciones idempotentes por linea.
- Sin endpoint de escritura, no se puede prometer que altas/cambios de precio en Winerim suban al POS.

## Peticion tecnica recomendada al SAT

1. Confirmar acceso remoto seguro:
   - URL accesible desde backend;
   - certificado TLS valido o alternativa de tunel/VPN;
   - si el acceso sera local, definir conector local.
2. Documentar respuesta real de `POST /api/token`:
   - campo del token;
   - expiracion;
   - renovacion;
   - codigos de error.
3. Añadir endpoint de ventas cerradas:
   - rango por fecha de negocio;
   - documentos cerrados;
   - lineas con productId/itemId, cantidad, precio, descuentos, impuestos, anulaciones;
   - ids estables de documento y linea.
4. Añadir endpoint de escritura de menu/productos si el objetivo incluye Winerim -> POS:
   - crear/actualizar producto;
   - precio;
   - categoria;
   - activo/inactivo;
   - barcode/codigo;
   - canal de preparacion;
   - formato de venta.
5. Confirmar multi-restaurante:
   - uso de `restaurantId`;
   - si se filtra por token o por parametro.

## Conclusión

- Con la documentacion actual se puede hacer un conector de lectura de carta/stock, pero no una integracion completa Winerim <-> POS.
- Para el flujo operativo del middleware hace falta, como minimo, endpoint de ventas cerradas.
- Para automatizar catalogo Winerim -> POS hace falta endpoint de escritura/actualizacion de menu/productos.
