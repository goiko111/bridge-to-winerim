# Orden y color de COPAS WINERIM

## Objetivo
- Cambiar únicamente `Order` y `Color` de las 50 copas de Albariza.
- Ordenarlas por tipo (tinto, blanco, rosado, espumoso, fortificado, dulce) y alfabéticamente dentro de cada bloque.
- Ajustar las altas futuras de copas en todos los locales para usar el color del tipo y ocupar una posición coherente sin reordenar productos existentes.

## Ejecución
1. Leer el catálogo fresco de Albariza y cruzar las 50 copas con su tipo Winerim.
2. Generar una actualización limitada a `Order` y `Color`, aplicarla una vez y releer Ágora.
3. Incorporar al puente una regla de presentación para nuevas copas: color semántico por tipo y orden calculado respecto a los productos existentes de la familia, sin modificar estos últimos.
4. Añadir pruebas de bloques, orden alfabético, colores y preservación de atributos no autorizados; publicar solo `agora-proxy`.
5. Entregar el readback final con las 50 copas, orden y color.

## Detalles técnicos
- Colores: tinto `#800040`, blanco `#FFFFFF`, rosado `#DC82EF`, espumoso `#FF8080`, fortificado `#F1C097`, dulce `#F5A623`.
- La actualización operativa reutilizará el producto XML actual y cambiará exclusivamente los dos atributos autorizados.
- Si una copa no tiene tipo reconocible o el catálogo no contiene exactamente 50 productos, se detendrá sin aplicar cambios parciales.
