---
title: "Dependiente del framework vs autocontenido vs Native AOT para una imagen de contenedor de .NET 11"
description: "Dependiente del framework sobre una imagen aspnet chiseled es el valor por defecto correcto para un servicio ASP.NET Core en .NET 11, porque la capa del runtime se comparte entre servicios y una CVE del runtime se corrige actualizando la imagen base. Autocontenido con trimming y Native AOT compran una imagen de 2x a 5x más pequeña y un arranque en frío mucho más rápido, y te cuestan eso. Tamaños publicados reales, las cuentas de las capas compartidas y el bug de inferencia de imagen base de .NET 11 que rompe la ruta AOT."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "containers"
  - "docker"
  - "native-aot"
  - "deployment"
lang: "es"
translationOf: "2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image"
translatedBy: "claude"
translationDate: 2026-09-01
---

Para un servicio ASP.NET Core normal y de larga duración en .NET 11, publica **dependiente del framework sobre una imagen `aspnet` chiseled**. Es lo más pequeño que realmente envías (unos pocos megabytes de aplicación encima de una capa de runtime que tus otros servicios ya descargaron), y una CVE del runtime se corrige recompilando sobre una nueva etiqueta de imagen base en lugar de recompilar, volver a probar y volver a implementar la aplicación. Cambia a **autocontenido con trimming** cuando la aplicación deba fijar un parche concreto del runtime o ejecutarse sobre una imagen base sin .NET alguno. Recurre a **Native AOT** solo cuando el arranque en frío o la memoria por pod sea la restricción dominante y `dotnet publish` no reporte ninguna advertencia AOT en todo tu árbol de dependencias. Las cifras de tamaño que la gente cita para AOT son reales, pero para una flota miden lo que no toca: las imágenes dependientes del framework comparten una sola capa de runtime entre todos los servicios de un nodo, y las autocontenidas y AOT no.

Todo lo de aquí apunta a `<TargetFramework>net11.0</TargetFramework>`. .NET 11 está en Preview 7 (`11.0.100-preview.7.26381.103`, publicada el 2026-08-11) mientras escribo esto, con [la versión final prevista para noviembre de 2026](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview). Las etiquetas de imagen de la versión preliminar llevan un calificador `-preview` que la versión final elimina, así que `11.0-preview-resolute-chiseled` hoy se convierte en `11.0-resolute-chiseled` en noviembre. Los mecanismos de abajo son estables desde .NET 8, así que casi todo aplica sin cambios en .NET 9 y .NET 10.

## Los tres modos como imágenes de contenedor

| Propiedad | Dependiente del framework | Autocontenido + trimming | Native AOT |
| --- | --- | --- | --- |
| Repositorio de imagen base | `dotnet/aspnet` o `dotnet/runtime` | `dotnet/runtime-deps` | `dotnet/runtime-deps` |
| El runtime vive en | la capa de la imagen base | la capa de tu aplicación | compilado dentro del binario |
| Capa de runtime compartida entre servicios | Sí | No | No |
| Una CVE del runtime se corrige con | descargar una nueva etiqueta base, recompilar | nuevo SDK, recompilar, volver a probar, volver a implementar | nuevo SDK, recompilar, volver a probar, volver a implementar |
| Avanza al parche instalado | Sí | No | No |
| Se activa con | nada (es el valor por defecto) | `--self-contained -p:PublishTrimmed=true` | `-p:PublishAot=true` |
| Necesita un RID | No | Sí | Sí |
| La máquina de compilación necesita toolchain de C | No | No | Sí (clang, zlib1g-dev) |
| Reflexión, `Reflection.Emit`, carga de plugins | Completa | Advertencias de trimming, posibles fallos en ejecución | Restringida o no disponible |
| Imagen de ejemplo, comprimida | 52.81 MB | 21.86 MB | 11.60 MB |

Esas tres últimas cifras vienen del [informe de tamaño de imágenes de contenedor de .NET](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md) en `dotnet/dotnet-docker`, medidas sobre el ejemplo `releasesapi` con .NET 10.0 e imágenes base `noble-chiseled`. Los detalles completos en un momento, porque esa fila es la que confunde a la gente.

## Qué pone realmente cada modo en la imagen

El tooling de contenedores del SDK infiere la imagen base a partir de tu proyecto, y la regla es corta. [Según la referencia de contenerización](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), un proyecto autocontenido recibe `mcr.microsoft.com/dotnet/runtime-deps`, un proyecto ASP.NET Core recibe `mcr.microsoft.com/dotnet/aspnet`, y cualquier otro recibe `mcr.microsoft.com/dotnet/runtime`. La etiqueta es la parte numérica de tu TFM, con `ContainerFamily` añadido como sufijo.

Esa inferencia es toda la historia:

- **Dependiente del framework** aterriza en `aspnet`, que es `runtime-deps` más el runtime de .NET más el shared framework de ASP.NET Core. Tu capa contiene ensamblados IL y recursos estáticos, típicamente megabytes de un solo dígito.
- **Autocontenido** aterriza en `runtime-deps`, que contiene solo las bibliotecas nativas que .NET necesita (libc, OpenSSL y compañía) y nada de .NET. Tu capa lleva el runtime completo y el shared framework, y por eso el trimming importa tanto aquí.
- **Native AOT** también aterriza en `runtime-deps`, pero tu capa es un único ejecutable nativo sin IL y sin JIT. Fíjate en que el sufijo `-aot` sobre `runtime-deps` ya no existe: estaba en .NET 8, y en .NET 10 las etiquetas runtime-deps específicas de AOT se fusionaron con las etiquetas `-chiseled` normales. El sufijo `-aot` ahora vive en las imágenes del **SDK** (`sdk:11.0-preview-aot`, `sdk:11.0-preview-resolute-aot`), que incluyen el toolchain de clang y zlib que el compilador AOT necesita durante la compilación.

Los tres heredan el mismo endurecimiento de las imágenes de Microsoft: el usuario sin privilegios `app` con UID 1654, expuesto mediante `$APP_UID`, y el puerto 8080 en vez del 80, ambos [introducidos en .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers). Las imágenes chiseled además no traen shell, ni gestor de paquetes, ni `curl`, así que la depuración con `docker exec` y los health checks basados en shell no funcionan en ninguno de los tres modos si eliges una familia chiseled.

## Cómo publicar cada uno de los tres

Dependiente del framework, sin necesidad de RID, directo a una base ASP.NET Core chiseled:

```bash
# .NET 11 SDK 11.0.100-preview.7. Framework-dependent onto aspnet:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Autocontenido con trimming. `PublishTrimmed` implica `SelfContained`, pero escribe ambos para que quien lo lea en el futuro no tenga que recordarlo:

```bash
# .NET 11 SDK 11.0.100-preview.7. Self-contained + trimmed onto runtime-deps:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  --self-contained \
  -p PublishTrimmed=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Native AOT. `PublishAot` implica autocontenido, y necesita el toolchain de C de la plataforma en la máquina de compilación:

```bash
# .NET 11 SDK 11.0.100-preview.7. Native AOT onto runtime-deps:11.0-preview-resolute-chiseled.
# Requires clang and zlib1g-dev locally, or build inside sdk:11.0-preview-aot.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Si prefieres hacer esto desde CI sin instalar clang en el agente, la imagen AOT del SDK es la razón por la que existen esas etiquetas:

```dockerfile
# .NET 11 preview. Multi-stage AOT build.
FROM mcr.microsoft.com/dotnet/sdk:11.0-preview-resolute-aot AS build
WORKDIR /src
COPY . .
RUN dotnet publish OrdersApi/OrdersApi.csproj -c Release -r linux-x64 -p:PublishAot=true -o /app

FROM mcr.microsoft.com/dotnet/runtime-deps:11.0-preview-resolute-chiseled
WORKDIR /app
COPY --from=build /app/OrdersApi .
USER $APP_UID
ENTRYPOINT ["./OrdersApi"]
```

Para el conjunto completo de propiedades `Container*`, el control de etiquetas y la autenticación contra registros, consulta el recorrido sobre [publicar una aplicación .NET 11 como imagen de contenedor sin Dockerfile](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/).

## Las cifras de tamaño publicadas

Microsoft publica tamaños medidos para una API web mínima de ejemplo en cada variante de imagen base, así que no hace falta especular. Estos son los tamaños comprimidos del ejemplo `releasesapi` en .NET 10.0:

| Imagen base | Dependiente del framework | Autocontenido + trimming | Native AOT |
| --- | --- | --- | --- |
| Ubuntu completo (`10.0`) | 92.48 MB | 61.53 MB | 51.27 MB |
| `10.0-noble-chiseled` | 52.81 MB | 21.86 MB | 11.60 MB |
| `10.0-noble-chiseled-extra` | 67.68 MB | 36.82 MB | 26.56 MB |
| `10.0-alpine` | 51.93 MB | 20.95 MB | 10.69 MB |
| `10.0-alpine-extra` | 66.50 MB | 35.52 MB | 25.25 MB |

De esa tabla salen dos cosas de inmediato. Primero, **la familia de imagen base es una palanca más grande que el modo de despliegue**. Mover una aplicación dependiente del framework de la imagen Ubuntu completa a `noble-chiseled` ahorra 39.67 MB, que es más de lo que ahorra cambiar esa misma aplicación de dependiente del framework a Native AOT sobre la imagen completa (41.21 MB) y no requiere nada del trabajo de compatibilidad. Si todavía no has pasado a chiseled, hazlo primero y vuelve a medir antes de considerar cualquier otra cosa.

Segundo, Native AOT sobre chiseled sí es unas 4.5 veces más pequeño que dependiente del framework sobre chiseled. Es una ganancia real, y para una función scale-to-zero o un nodo de muy alta densidad es decisiva.

## Las cuentas de capas compartidas que dan la vuelta al argumento del tamaño

Aquí está la parte que el informe de tamaños no puede mostrarte, porque mide una imagen de forma aislada.

Las imágenes de contenedor son capas direccionadas por contenido. Si diez de tus servicios compilan todos `FROM mcr.microsoft.com/dotnet/aspnet:11.0-preview-resolute-chiseled`, cada nodo que los ejecuta descarga y almacena esa capa de runtime exactamente una vez. El coste marginal del undécimo servicio es su propia capa de aplicación, que para un servicio ASP.NET Core dependiente del framework son unos pocos megabytes de IL.

Haz la aritmética para diez servicios en un nodo, usando la columna chiseled de arriba:

- **Dependiente del framework**: unos 50 MB de capas `aspnet` compartidas, más 10 capas de aplicación de aproximadamente 3 MB. Digamos 80 MB.
- **Autocontenido con trimming**: una capa `runtime-deps` compartida de unos pocos megabytes, más 10 capas de aplicación que cargan cada una su propia copia recortada del runtime. Unos 10 x 20 MB, o sea unos 200 MB.
- **Native AOT**: la misma forma, 10 x 11 MB, o sea unos 110 MB.

Autocontenido es el peor de los tres a escala de flota aunque gane a dependiente del framework por 2.4x en una imagen aislada, porque el trimming es por aplicación y no puede deduplicar entre aplicaciones. Native AOT es lo bastante pequeño como para seguir por delante, pero su ventaja baja de 4.5x a bastante menos de 2x. El almacenamiento del registro, el ancho de banda de descarga entre zonas y la presión de disco del nodo siguen este segundo cálculo, no el primero. Mide tu propia flota antes de migrar nada por motivos de tamaño.

## Parcheo: quién corrige una CVE del runtime

Este es el argumento que debería decidirlo de verdad para la mayoría de los equipos, y es el que la [visión general de publicación](https://learn.microsoft.com/en-us/dotnet/core/deploying/) expone sin rodeos. Una aplicación dependiente del framework "avanza automáticamente al último parche de seguridad de .NET disponible en el entorno", mientras que una implementación autocontenida "no avanza" y "el runtime de .NET solo puede actualizarse publicando una nueva versión de la aplicación".

En términos de contenedores:

- **Dependiente del framework**: cuando Microsoft publica una corrección de runtime fuera de banda, reetiquetas, recompilas y vuelves a implementar. Tu código es idéntico byte a byte, así que el cambio es mecánicamente seguro. Una automatización de actualización de imagen base (Dependabot, Renovate) puede hacerlo sin humanos, y un PR por repositorio lo cubre.
- **Autocontenido y Native AOT**: el runtime está dentro de la capa de tu aplicación, así que la corrección requiere un SDK nuevo en el agente de compilación, una recompilación completa y una pasada completa de pruebas, por servicio. Para AOT en concreto también significa recompilar código nativo, que es la compilación más lenta que tienes.

Si tu organización tiene un control de "parchear CVEs críticas en N días", esa diferencia no es una nota al pie. Es la razón para quedarse en dependiente del framework salvo que algo te obligue a salir.

## La globalización es el interruptor oculto entre chiseled y chiseled-extra

Las imágenes `-chiseled`, `-alpine` y las `-distroless` de Azure Linux vienen sin ICU ni tzdata, así que solo funcionan con aplicaciones en modo de globalización invariante. Las variantes `-extra` devuelven ICU, tzdata y `libstdc++`, que es de donde salen esos 15 MB de diferencia de la tabla de tamaños.

Para las publicaciones autocontenidas y AOT el SDK intenta ayudar: si `InvariantGlobalization` es false te dirige a una variante `-extra`. Para las publicaciones dependientes del framework eliges la familia tú mismo, así que te toca a ti poner la propiedad acorde:

```xml
<!-- .NET 11, net11.0. Required if you target a plain -chiseled or -alpine base. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Si te equivocas aquí, el contenedor muere al arrancar con `Couldn't find a valid ICU package installed on the system`, que tiene [su propio artículo de solución](/es/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/). Y el modo invariante no es gratis: la comparación de cadenas sensible a la cultura, `ToUpper` y `ToLower` para caracteres no ASCII y las búsquedas de `TimeZoneInfo` cambian de comportamiento. Si localizas algo o formateas moneda, paga los 15 MB de `-extra`.

## El problema de .NET 11: la inferencia de imagen base sigue diciendo noble

El tooling de contenedores calcula el nombre en clave de Ubuntu para la etiqueta inferida a partir de la versión del SDK, y a día de hoy en las versiones preliminares de .NET 11 esa búsqueda solo conoce `jammy` (SDK por debajo de 8.0.300) y `noble` (8.0.300 en adelante). Como `11.0.100` cumple la segunda condición devuelve `noble`, pero las imágenes de .NET 11 en MCR se publican bajo `resolute` (Ubuntu 26.04). El resultado, [reportado como dotnet/sdk#53553](https://github.com/dotnet/sdk/issues/53553):

```console
error CONTAINER1015: Unable to access the repository 'dotnet/runtime-deps' at tag '11.0.0-preview.2-noble-chiseled-extra'
```

El radio de impacto son exactamente las rutas de las que trata este artículo. La publicación dependiente del framework va bien, porque no pasa por la rama de inferencia del nombre en clave. Las publicaciones autocontenidas con trimming y las de `PublishAot=true` lo sufren las dos. La solución es dejar de depender de la inferencia y nombrar la familia de forma explícita, que es por lo que todos los comandos de arriba la pasan:

```bash
# .NET 11 SDK 11.0.100-preview.7. Explicit family, no codename inference.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled
```

Poner `ContainerBaseImage` con un nombre totalmente cualificado también funciona y salta `ContainerFamily` por completo. Fijar la familia de forma explícita es buena práctica en cualquier caso: es lo que impide que un SDK futuro mueva tu flota a otra distribución en silencio. La [rotación de etiquetas de Ubuntu 26.04](/es/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) es la misma lección desde el lado de .NET 10.

## La restricción que decide por ti

La mayoría de los equipos nunca llega a sopesar tamaños, porque una restricción dura lo decide:

- **Dependencias que usan mucha reflexión.** Proxies dinámicos, serializadores basados en reflexión, contenedores de inyección de dependencias que emiten código en ejecución, carga de plugins. Native AOT queda descartado y el trimming es arriesgado. Trata las advertencias de publicación como la señal de sí o no, no la documentación. [El código seguro para trimming](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) es el requisito previo para ambos.
- **Un reloj de cumplimiento para remediar CVEs.** Dependiente del framework, porque actualizar la imagen base es un cambio mecánico y una recompilación no lo es.
- **Scale-to-zero o facturación por petición.** El arranque en frío domina la factura. Native AOT arranca unas 3 veces más rápido que el JIT normal y usa menos de la mitad del working set, según las mediciones de [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Un único artefacto de compilación para varias plataformas.** Dependiente del framework sin RID es el único modo que produce un solo artefacto; los otros dos son por RID y necesitan una matriz de compilación.
- **Una imagen base sin .NET, que no controlas.** Autocontenido, porque es el único modo que corre sobre una imagen de distribución arbitraria con las bibliotecas nativas correctas y nada más.

## Recomendación, repetida

Por defecto, **dependiente del framework sobre `aspnet:11.0-<family>-chiseled`**. Es la imagen más barata a escala de flota, es el único modo en el que una CVE del runtime es una actualización de imagen base en vez de una release, y es el único que envía un solo artefacto agnóstico al RID. Pasa a **Native AOT sobre `runtime-deps:11.0-<family>-chiseled`** cuando el arranque en frío o la densidad de memoria sea la restricción que manda y tu árbol de dependencias publique limpio. Usa **autocontenido con trimming** como opción intermedia cuando necesites fijar la versión del runtime o una imagen base sin .NET, entendiendo que es el peor de los tres para el almacenamiento de toda la flota. Elijas lo que elijas, define `ContainerFamily` de forma explícita, y pasa la imagen a chiseled antes de optimizar cualquier otra cosa.

## Relacionado

- [Cómo publicar una aplicación .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) cubre toda la superficie de propiedades `Container*` en la que se apoyan estos comandos.
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) es la comparación de modelos de compilación que hay debajo de esta comparación de empaquetado, con mediciones de arranque y throughput.
- [Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) enumera las restricciones de API y bibliotecas antes de que te comprometas.
- [Qué es el código seguro para trimming y cómo lo escribo?](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) es el requisito previo tanto para autocontenido con trimming como para AOT.
- [Cuál es la diferencia entre dotnet build y dotnet publish?](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) explica por qué todo esto ocurre solo en tiempo de publicación.

## Fuentes

- [Visión general de publicación de aplicaciones .NET](https://learn.microsoft.com/en-us/dotnet/core/deploying/), MS Learn (compromisos entre dependiente del framework y autocontenido, roll-forward, AOT).
- [Referencia de contenerización de una aplicación .NET](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), MS Learn (inferencia de `ContainerBaseImage`, `ContainerFamily`, `ContainerUser`).
- [Imágenes de contenedor de .NET](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images), MS Learn (repositorios, variantes chiseled y extra, globalización).
- [Informe de tamaño de imágenes de ejemplo](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md), `dotnet/dotnet-docker` (tamaños medidos del ejemplo `releasesapi`).
- [La inferencia de imagen base usa el nombre en clave de Ubuntu equivocado para .NET 11](https://github.com/dotnet/sdk/issues/53553), `dotnet/sdk` (CONTAINER1015, workaround con `ContainerFamily`).
- [Novedades en contenedores para .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers), MS Learn (usuario `app` sin privilegios, `APP_UID`, puerto 8080).
- [Novedades en .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), MS Learn (estado de versión preliminar, fecha de versión final, cambios de contenedores del SDK).
