# Requisitos de cliente - tSpoonLab y Holded

Fecha: 2026-07-14

## Flujo acordado

- `Agora -> middleware -> Holded`: enviar ventas cerradas a Holded.
- `tSpoonLab -> middleware`: leer pedidos de compra, albaranes, almacenes e inventario/stock.
- `Winerim -> Agora`: mantener catalogo y precios de vino.
- `Agora -> Winerim`: mantener historial de ventas y stock de vino.

Holded no debe convertirse en una segunda fuente de stock. Las lineas contables de venta se configuraran para no alterar inventario en Holded.

## Datos y accesos tSpoonLab

1. Usuario tecnico de integracion y password, preferiblemente dedicado y de solo lectura durante el piloto.
2. Nombre e identificador del centro de coste/restaurante (`idOrderCenter`).
3. Almacenes que deben consultarse y cual es el almacen principal.
4. Confirmacion del stock que se desea recibir:
   - stock teorico actual;
   - ultimo inventario fisico;
   - ambos, mostrando su fecha y diferencia.
5. Confirmacion de que `pedidos` significa pedidos de compra a proveedores y que estados interesan: pendientes, todos o solo recepcionados.
6. Si deben incluirse proveedores/traspasos internos.
7. Fecha inicial de lectura y frecuencia deseada.
8. Codigos de producto/SKU/EAN usados para relacionar productos tSpoonLab con Winerim.
9. Confirmacion de que tSpoonLab sera la fuente maestra de compras y stock operativo que se consulta.
10. Durante el piloto no se marcaran pedidos/albaranes como procesados ni se escribira en tSpoonLab.

## Datos y accesos Holded

1. API Token v2 dedicado creado en `Configuracion -> Desarrolladores -> Credenciales`.
2. Permisos minimos:
   - tickets/recibos de venta: lectura y escritura;
   - contactos: lectura;
   - canales de venta: lectura;
   - productos/servicios, impuestos y cuentas necesarias: lectura;
   - sin escritura de inventario.
3. Empresa/cuenta de Holded y moneda del restaurante.
4. Documento destino preferido:
   - recomendado: un ticket/recibo de venta resumido por dia operativo;
   - alternativa: un documento por factura cerrada de Agora.
5. Serie o numeracion, canal de venta y estado inicial: borrador o aprobado.
6. Cliente generico para venta de mostrador y tratamiento de facturas nominativas.
7. Mapeo de tipos de IVA.
8. Mapeo de formas de pago de Agora con caja/banco/cuentas de Holded.
9. Nivel de detalle: por producto, familia o resumen por IVA.
10. Tratamiento de descuentos, propinas, devoluciones, anulaciones y facturas rectificativas.
11. Fecha de inicio. El piloto empieza sin historico.
12. Confirmacion del limite mensual de API contratado.

## Recomendacion para el piloto

- Leer tSpoonLab sin modificar ningun estado.
- Generar un `dry-run` de un dia cerrado de Agora.
- Comparar bases, IVA, cobros y total con el cierre real.
- Crear un unico ticket de venta en Holded en borrador.
- Repetir la misma operacion para comprobar que no duplica el documento.
- Probar una anulacion mediante documento compensatorio; no borrar el original.
- Activar automatizacion solo despues de conciliacion contable.
