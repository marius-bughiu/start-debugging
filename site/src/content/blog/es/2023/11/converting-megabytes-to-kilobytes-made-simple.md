---
title: "Convertir Megabytes a Kilobytes de forma simple"
description: "Convierte megabytes a kilobytes multiplicando por 1000. Aprende cuándo usar 1024 para pasar de MiB a KiB, con ejemplos y una tabla de unidades."
pubDate: 2023-11-13
updatedDate: 2026-11-01
tags:
  - "informational"
lang: "es"
translationOf: "2023/11/converting-megabytes-to-kilobytes-made-simple"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para convertir megabytes a kilobytes, multiplica por **1000**: **1 MB = 1000 kB**. Si te refieres a las unidades binarias mebibytes y kibibytes, utiliza **1 MiB = 1024 KiB**. Las unidades determinan qué fórmula debes usar.

## Megabytes, kilobytes y unidades binarias

Los prefijos decimales kilo y mega representan potencias de diez. Los prefijos binarios kibi y mebi representan potencias de dos. La [referencia del NIST sobre prefijos binarios](https://physics.nist.gov/cuu/Units/binary.html) explica la nomenclatura de la IEC y la compara con los prefijos del SI.

| Unidad | Símbolo | Bytes |
| --- | --- | ---: |
| Kilobyte | kB | 1000 |
| Megabyte | MB | 1 000 000 |
| Kibibyte | KiB | 1024 |
| Mebibyte | MiB | 1 048 576 |

Aunque «KB» es habitual en las interfaces de software, aquí utilizamos **kB** como símbolo decimal. Algunos programas etiquetan las medidas binarias como KB o MB, así que comprueba la definición de la herramienta antes de convertir el valor mostrado. Nuestra guía sobre la [diferencia entre MB y MiB](/es/2020/08/mib-vs-mb/) explica esta confusión con más detalle.

## La fórmula: de MB a kB

**Kilobytes = megabytes × 1000**

Por ejemplo:

- 5 MB × 1000 = **5000 kB**
- 10 MB × 1000 = **10 000 kB**
- 0,5 MB × 1000 = **500 kB**

Para convertir en sentido contrario, divide entre 1000. Un archivo de 2500 kB ocupa 2,5 MB.

## Cuándo multiplicar por 1024

Utiliza 1024 para convertir entre las unidades binarias **MiB y KiB**:

**Kibibytes = mebibytes × 1024**

Por ejemplo, 5 MiB equivalen a 5120 KiB. Es una cantidad distinta de 5 MB, por lo que cambiar las unidades sin convertir el valor produce un resultado incorrecto.

## Convertir entre unidades decimales y binarias

Para pasar de un sistema al otro, utiliza los bytes como paso intermedio:

1. Multiplica el valor inicial por el número de bytes de su unidad.
2. Divide el resultado entre el número de bytes de la unidad de destino.

Por ejemplo, 1 MB equivale a 1 000 000 bytes. Al dividir entre 1024, obtenemos **976,5625 KiB**. En sentido contrario, 1 MiB equivale a 1 048 576 bytes, o **1048,576 kB**.

Esto explica por qué un mismo archivo puede mostrar tamaños numéricos distintos en dos herramientas sin que se haya perdido ningún byte.

## Elegir la conversión correcta en la práctica

Antes de usar una calculadora o comparar un archivo con un límite de subida, identifica qué significa cada unidad en ambos lados. Si el límite está documentado en bytes, compara directamente las cantidades de bytes. Si la documentación solo dice «MB», comprueba si emplea unidades decimales o una convención binaria.

Incluye las unidades en los encabezados de las hojas de cálculo, los informes y la documentación de las API. Un valor como «5120» es ambiguo por sí solo; «5120 KiB» deja clara la cantidad.

También debes distinguir bytes de bits: **1 byte = 8 bits**. Una velocidad de transferencia en megabits por segundo no es un tamaño de archivo en megabytes.

_Corregido el 1 de noviembre de 2026: una versión anterior usaba incorrectamente 1024 para convertir MB a kilobytes. Ese factor corresponde a la conversión de MiB a KiB; la conversión decimal de MB a kB utiliza 1000._
