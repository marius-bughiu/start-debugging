---
title: ".NET 11 RC 1 hace reproducibles las imágenes de contenedor de dotnet publish"
description: "El SDK de .NET 11 RC 1 respeta SOURCE_DATE_EPOCH al publicar imágenes de contenedor, elimina el id de proceso de los encabezados tar de las capas y omite la subida de blobs cuando el registro ya tiene el manifiesto. Mismo commit de entrada, mismo digest de salida."
pubDate: 2026-09-12
tags:
  - "dotnet-11"
  - "containers"
  - "sdk"
  - "dotnet"
lang: "es"
translationOf: "2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch"
translatedBy: "claude"
translationDate: 2026-09-12
---

Publica el mismo commit dos veces con `dotnet publish /t:PublishContainer` en .NET 10 y obtendrás dos digests de imagen distintos. El código es idéntico, pero el SDK estampaba la hora actual en cada entrada de las capas y en la configuración de la imagen. También estampaba el id de proceso en cada tar de capa. Un registro no puede deduplicar eso, y un controlador GitOps que vigila la etiqueta ve una nueva versión. [.NET 11 RC 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/), publicado el 8 de septiembre de 2026, corrige ambas cosas en las herramientas de contenedores integradas en el SDK ([dotnet/sdk#55836](https://github.com/dotnet/sdk/pull/55836)).

## Cuatro lugares por donde el reloj se filtraba al digest

El [PR original](https://github.com/dotnet/sdk/pull/55689) los enumera:

- Cada `PaxTarEntry` de una capa tomaba por defecto como fecha de modificación `DateTime.UtcNow`, muestreada por separado para cada archivo.
- La configuración de la imagen muestreaba `DateTime.UtcNow` para `created` y otra vez para la entrada de historial generada.
- Las etiquetas `org.opencontainers.image.created` y `org.opencontainers.artifact.created` venían de `UtcNow` en el archivo de targets.
- `TarWriter` nombra cada encabezado extendido pax como `./PaxHeaders.<process id>/.`, así que el pid terminaba en cada capa.

El pid bastaba por sí solo para cambiar el digest de la capa aunque el contenido fuera idéntico byte a byte. Solo diferían 13 bytes de la capa, todos causados por ese nombre de encabezado.

## Activarlo con SOURCE_DATE_EPOCH

RC 1 sigue la [convención de reproducible-builds](https://reproducible-builds.org/docs/source-date-epoch/). La propiedad de MSBuild `SOURCE_DATE_EPOCH`, o una variable de entorno con el mismo nombre, que MSBuild recoge automáticamente, se interpreta una sola vez como una única marca de tiempo. Ese valor va luego a cada entrada tar, al campo `created` de la configuración, a la entrada de historial y a ambas etiquetas OCI:

```bash
dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerRegistry=registry.example.com \
  -p:SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
```

Usar la marca de tiempo del commit significa que el digest solo cambia cuando cambia el commit. Lo comprobé con el SDK de RC 1 (`11.0.100-rc.1.26425.128`) publicando una aplicación de consola a un tarball tres veces:

```bash
pub() { dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerArchiveOutputPath=./$1.tar.gz "${@:2}"; }

pub a -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub b -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub c                                   # config 5f24aace..., app layer 2f4f68c1...
```

Las ejecuciones `a` y `b` son idénticas byte a byte, y el campo `created` de la configuración dice `2025-09-12T00:00:00.0000000Z`. La ejecución `c` sigue usando la hora del reloj, así que la reproducibilidad es opcional. Si el valor está mal formado, es negativo o está fuera de rango, el SDK recurre a la hora actual. La compilación no falla.

Dos efectos secundarios que conviene conocer antes de actualizar. El escritor de capas ahora ordena las entradas por ruta del contenedor, porque el orden de enumeración de directorios depende del sistema de archivos. El nombre del encabezado pax es siempre la constante `./PaxHeaders/.`. Ambos se aplican a cada publicación, incluso sin `SOURCE_DATE_EPOCH`, así que tus digests cambiarán una vez al pasar a RC 1.

## Omitir las subidas que el registro ya tiene

El cambio complementario ([dotnet/sdk#55838](https://github.com/dotnet/sdk/pull/55838)) se apoya en esto. Antes de hacer push, el SDK envía una solicitud `HEAD` por el digest del manifiesto calculado. Si el registro ya lo tiene, el SDK omite la subida de las capas y de la configuración, aplica igualmente todas las etiquetas solicitadas y registra `Manifest '...' already exists in repository '...'`. Un job de CI reintentado o una segunda etiqueta sobre un commit sin cambios se reduce a unas pocas llamadas de metadatos.

En los targets de RC 1 esto está activado por defecto: `ContainerPushNoCache` vale `false` por defecto. Si un registro informa mal sobre la existencia de manifiestos, desactiva la comprobación:

```bash
dotnet publish /t:PublishContainer -p:ContainerPushNoCache=true
```

La imagen se sigue compilando localmente, ya que primero hay que calcular el digest, así que esto ahorra transferencia, no tiempo de compilación. Además solo compensa cuando el digest es estable, y por eso los dos PR llegaron juntos.

Para otro cambio de RC 1 que elimina un workaround de larga data, consulta [señales y estado de salida en `Process`](/es/2026/09/dotnet-11-rc-1-process-signal-exit-status/). La lista completa del SDK está en las [notas de la versión del SDK de RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/sdk.md).
