# Brief para infraestructura propia (Codex) — formatos de Winerim

Fecha: 2026-09-07. Contexto: el middleware ya soporta todos los formatos de
Winerim (no solo botella/copa/magnum) y necesita que la API de Winerim exponga
esa información de forma cerrada, explícita y consultable.

## 1. Lista cerrada de variantes

Cada precio de vino (`prices[]`) debe usar exactamente uno de estos `variant`
(minúsculas, guiones, sin acentos). La capacidad nominal en litros es obligatoria.

| variant           | etiqueta        | litros |
|-------------------|-----------------|--------|
| `copa`            | Copa            | 0,15   |
| `media-copa`      | Media copa      | 0,075  |
| `benjamin`        | Benjamín        | 0,2    |
| `media-botella`   | Media botella   | 0,375  |
| `botella-pequena` | Botella pequeña | 0,5    |
| `botella`         | Botella         | 0,75   |
| `botella-tienda`  | Botella tienda  | 0,75   |
| `litro`           | Litro           | 1      |
| `magnum`          | Magnum          | 1,5    |
| `doble-magnum`    | Doble magnum    | 3      |
| `jeroboam`        | Jeroboam        | 3      |
| `rehoboam`        | Rehoboam        | 4,5    |
| `matusalem`       | Matusalem       | 6      |
| `salmanazar`      | Salmanazar      | 9      |
| `baltasar`        | Baltasar        | 12     |
| `nabucodonosor`   | Nabucodonosor   | 15     |
| `botella-grande`  | Botella grande  | (sin capacidad fija — evitar) |

Erratas toleradas hoy por el middleware (`salmanzar`, `rehoboham`, `jeroboham`,
`matusalén`, `botella-pequeña`), pero **no deben** llegar: normalizar en origen.

## 2. Capacidad explícita, no deducida del nombre

El middleware traduce etiquetas de TPV tipo `CLOE 3L`, `VEUVE 1,5 L`,
`BENJAMIN 20CL` a formato Winerim usando la capacidad. Como **3 L puede ser
doble magnum o jeroboam**, la equivalencia no es única y hoy se resuelve así:

1. nombre exacto de la variante → decide;
2. capacidad con un único formato posible (6 L = matusalem) → decide;
3. capacidad ambigua → se restringe a los formatos que **ese vino** tiene en
   Winerim; si queda uno, decide;
4. si sigue habiendo dos → no descuenta nada (fail-closed) y lo reporta.

Lo que necesitamos de la infra para cerrar el caso 4:

- `capacityLiters` numérico por cada entrada de `prices[]`;
- `variant` canónica siempre presente (no solo el nombre comercial);
- opcional y muy útil: `aliases` o `posLabel` con los nombres que el cliente usa
  en su TPV (`"3L"`, `"Jeroboam 3L"`), para poder aprender equivalencias por
  cliente en vez de adivinarlas.

## 3. Stock independiente por variante

Cada variante debe tener su propia línea de stock (`erpStock.id` distinto) y su
propio `stock`. Nunca compartir el `stock_id` de botella con media botella o
jeroboam: el descuento es absoluto por línea de stock. Si una variante no tiene
stock propio, indicarlo explícitamente (`erpStock: null`) para que el middleware
la ignore en lugar de descontar botella por error.

## 4. Precio y actividad por variante

- `price` positivo = publicable en el TPV; `null`/0 = no se publica.
- `isActive` (o `active`) por variante, para poder retirar un formato concreto
  sin desactivar el vino.
- Un vino inactivo desactiva todas sus variantes.

## 5. Aviso de variantes nuevas

Si aparece una variante fuera de la lista, el middleware la registra como
`unknownWinerimVariants` y **no** la usa (no descuenta stock). Petición: avisar
antes de introducir una variante nueva y añadirla a la lista con capacidad.

## 6. Estado en el middleware (ya implementado)

- Catálogo de 17 formatos con identidades deterministas por formato
  (namespaces de 1M en 1M; botella/copa/magnum conservan 2M/3M/4M).
- Tabla `winerim_wine_formats`: precio, coste, `stock_id` y actividad por
  formato y conexión.
- Resolución de ventas y descuento de stock por formato, incluida la
  equivalencia por capacidad con fail-closed en caso de ambigüedad.
- Publicación de formatos ampliados activada por defecto, con exclusión
  explícita de Ocean Club y opt-out por conexión y por formato.
