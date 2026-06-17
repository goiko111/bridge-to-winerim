# Jardí Parets · Excel Winerim vs Agora

Fecha: 2026-06-17  
Fuente Winerim: `Jardi export_17-06-2026_11-44-46.xlsx`  
Modo: solo lectura

## Qué se ha hecho

- Se leyó el Excel exportado de Winerim.
- Se leyó Agora en vivo por `export-master` (`Families` y `Products`).
- Se cruzaron los formatos soportados por el middleware:
  - `Ampolla Precio` -> botella;
  - `Copa Precio` -> copa;
  - `Magnum Precio` -> magnum.
- No se ejecutó import XML.
- No se modificó Agora.
- No se modificó Lovable Cloud.
- No se descontó stock.

## Resultado Excel

- Filas de vino: `221`.
- Activos: `174`.
- Inactivos: `47`.
- Vinos activos con al menos un formato soportado y precio: `168`.
- Formatos publicables esperados:
  - botella: `166`;
  - copa: `1`;
  - magnum: `1`;
  - total: `168`.
- Activos sin precio/formato soportado: `6`.

Los `6` activos sin precio/formato soportado son fichas de `Vega Sicilia Único`:

- `264536`
- `264537`
- `264538`
- `264539`
- `264540`
- `264541`

Estas fichas no deben aparecer como productos Winerim en Agora mientras no tengan precio soportado.

## Resultado Agora

- Familias Winerim visibles: `8/8`.
- Productos Winerim publicados: `168`.
- Productos Winerim vendibles: `168`.
- Productos Winerim como botón raíz: `0`.

Distribución en Agora:

- `TINTOS WINERIM`: `129`.
- `BLANCOS WINERIM`: `19`.
- `ROSADOS WINERIM`: `7`.
- `ESPUMOSOS WINERIM`: `11`.
- `COPAS WINERIM`: `1`.
- `MAGNUM WINERIM`: `1`.
- `DULCE WINERIM`: `0`.
- `FORTIFICADOS WINERIM`: `0`.

## Cruce Excel -> Agora

- `168/168` formatos esperados desde el Excel están publicados en Agora.
- Faltantes: `0`.
- Problemas de visibilidad: `0`.
- Extras Winerim en Agora no justificados por el Excel: `0`.

Nota: `B PSI 705` no es un extra real. Es la botella del Winerim `269705` (`PSI`) publicada con sufijo de desambiguación porque el Excel contiene varios `PSI`. Por ID determinista corresponde correctamente al Excel.

## Conclusión

Sí: según el Excel entregado por el cliente, todos los vinos/formats Winerim que deben aparecer en Agora están publicados y vendibles dentro de familias Winerim.

La convivencia con legacy sigue siendo otra cuestión distinta:

- Winerim está publicado correctamente.
- El legacy de vino sigue visible.
- La auditoría previa detectó `281` productos legacy vendibles, con `103` matches seguros contra Winerim publicado y `163` sin match fiable.

Por tanto, la recomendación sigue siendo no ocultar legacy en bloque sin revisión por fases.

## Artefactos

- `JARDI_EXCEL_EXPECTED_TO_AGORA_2026-06-17.csv`
- `JARDI_AGORA_WINERIM_NOT_IN_EXCEL_EXPECTED_2026-06-17.csv`

