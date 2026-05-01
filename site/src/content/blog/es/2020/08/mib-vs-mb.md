---
title: "¿Cuál es la diferencia entre un MegaByte (MB) y un MebiByte (MiB)?"
description: "Conoce la diferencia entre megabytes (MB) y mebibytes (MiB), por qué 1 MB equivale a 1000 KB (no 1024) y cómo manejan estas unidades los distintos sistemas operativos."
pubDate: 2020-08-07
updatedDate: 2023-10-28
tags:
  - "technology"
lang: "es"
translationOf: "2020/08/mib-vs-mb"
translatedBy: "claude"
translationDate: 2026-05-01
---
Si te enseñaron que 1 MB = 1024 KB, te enseñaron mal. 1 MB equivale en realidad a 1000 KB, mientras que 1 MiB = 1024 KiB. El prefijo "mebi" en MebiByte (MiB) significa _mega_ y _binario_, lo que indica que es una potencia de 2; de ahí valores como 32, 64, 128, 256, 512, 1024, 2048 y así sucesivamente.

El megabyte (MB), por otro lado, siempre es una potencia de 10, así que tienes 1 KB = 1000 bytes, 1 MB = 1000 KB y 1 GB = 1000 MB.

## Diferencias entre sistemas operativos

Casi cada sistema operativo trata estas unidades de forma distinta y, de todos, Windows es el más peculiar. En realidad calcula todo en mebibytes y luego añade KB/MB/GB al final, diciendo básicamente que es un megabyte. Así, un archivo de 1024 bytes aparece como 1.00 KB, cuando en realidad es 1.00 KiB o 1.024 KB.

Puedes comprobarlo tú mismo creando un archivo TXT con 1000 caracteres (1 carácter = 1 byte) y revisando la información del archivo.

![MegaByte vs. MebiByte - Windows mostrando 1024 bytes como 1 KB en lugar de 1 KiB o 1.024 KB](/wp-content/uploads/2020/08/image-2.png)

Windows mostrando 1024 bytes como 1 KB en lugar de 1 KiB o 1.024 KB

Este tipo de presentación lleva a todo tipo de confusiones; los usuarios suelen sentirse estafados al comprar un disco duro de 256 GB y ver que Windows les muestra 238 GB (cuando en realidad quieren decir 238 GiB, que equivalen a 256 GB).

Otros sistemas operativos que usan esta definición basada en potencias de 10 son macOS, iOS, Ubuntu y Debian. Esta forma de medir la memoria también es coherente con los demás usos de los prefijos SI en informática, como las velocidades de reloj de la CPU o las medidas de rendimiento.

Nota: macOS medía la memoria en unidades basadas en potencias de 2 antes de Mac OS X 10.6 Snow Leopard, cuando Apple cambió a unidades basadas en potencias de 10. Lo mismo aplica a partir de iOS 11.

## Tratar con definiciones contradictorias

El mebibyte se diseñó para reemplazar al megabyte porque entraba en conflicto con la definición del prefijo "mega" en el Sistema Internacional de Unidades (SI). Pero, a pesar de haber sido establecido por la International Electrotechnical Commission (IEC) en 1998 y aceptado por todas las grandes organizaciones de estándares, no es ampliamente reconocido en la industria ni en los medios.

Los prefijos del IEC forman parte del Sistema Internacional de Magnitudes y la IEC ha precisado además que el kilobyte solo debería usarse para referirse a 1000 bytes. Esta es la definición moderna actual del kilobyte.

## Comparación de unidades decimales y binarias

Para terminar, te dejo una tabla con todos los nombres de las distintas unidades de medida, múltiplos de bytes. Una nota: los prefijos ronna- y quetta- fueron adoptados recientemente, en 2022, por la Oficina Internacional de Pesas y Medidas (BIPM), pero solo para las unidades de potencias de 10. Sus contrapartes binarias se mencionan en un documento de consulta, pero todavía no han sido adoptadas ni por la IEC ni por la ISO.

| Valor decimal | Métrico | Valor binario | IEC | Memoria |
| --- | --- | --- | --- | --- |
| 1 | B byte | 1 | B byte | B byte |
| 1000 | kB kilobyte | 1024 | KiB kibibyte | kB kilobyte |
| 1000^2 | MB megabyte | 1024^2 | MiB mebibyte | MB megabyte |
| 1000^3 | GB gigabyte | 1024^3 | GiB gibibyte | GB gigabyte |
| 1000^4 | TB terabyte | 1024^4 | TiB tebibyte | TB terabyte |
| 1000^5 | PB petabyte | 1024^5 | PiB pebibyte | |
| 1000^6 | EB exabyte | 1024^6 | EiB exbibyte | |
| 1000^7 | ZB zettabyte | 1024^7 | ZiB zebibyte | |
| 1000^8 | YB yottabyte | 1024^8 | YiB yobibyte | |
| 1000^9 | RB ronnabyte | | | |
| 1000^10 | QB quettabyte | | | |

*Múltiplos de bytes en decimal y binario*
