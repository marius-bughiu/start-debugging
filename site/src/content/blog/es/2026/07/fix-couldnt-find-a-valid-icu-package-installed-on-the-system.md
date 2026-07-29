---
title: "Solución: Couldn't find a valid ICU package installed on the system en un contenedor .NET"
description: "Tu imagen base no tiene ICU. Instala icu-libs e icu-data-full, cambia a una variante de imagen -extra, o activa InvariantGlobalization=true y acepta el comportamiento ordinal de las cadenas."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "globalization"
  - "alpine"
lang: "es"
translationOf: "2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system"
translatedBy: "claude"
translationDate: 2026-07-29
---

La imagen base de tu contenedor no incluye ICU, y .NET se niega a arrancar sin él. Elige una de dos respuestas. Si tu aplicación formatea fechas, compara cadenas de forma lingüística o toca cualquier cultura distinta de la invariante, instala ICU: `RUN apk add --no-cache icu-libs icu-data-full` en Alpine, o cambia a una variante de imagen `-extra` que ya lo trae. Si tu aplicación realmente nunca necesita datos de cultura, pon `<InvariantGlobalization>true</InvariantGlobalization>` en el archivo del proyecto y conserva la imagen pequeña. No configures la variable de entorno esperando que baste, porque es el más débil de los tres interruptores.

```text
Process terminated. Couldn't find a valid ICU package installed on the system.
Please install libicu (or icu-libs) using your package manager and try again.
Alternatively you can set the configuration flag System.Globalization.Invariant
to true if you want to run with no globalization support. Please see
https://aka.ms/dotnet-missing-libicu for more information.
```

Todo lo que sigue está verificado contra .NET 10 (`10.0`, publicado el 2025-11-11) y las versiones preliminares de .NET 11. El mecanismo es idéntico desde .NET 5, así que las mismas soluciones aplican sin cambios a imágenes `net8.0` y `net9.0`. Solo cambian los nombres de paquetes y las etiquetas de imagen.

## Por qué el runtime mata el proceso en lugar de degradarse

La pila de globalización de .NET en Unix es una capa fina sobre ICU (International Components for Unicode). Los datos de cultura, la comparación lingüística de cadenas, las reglas de mayúsculas y minúsculas más allá de ASCII, el formato de calendarios, el manejo de IDN: todo eso viene de `libicuuc` y `libicui18n`, que no forman parte de .NET. Son una dependencia nativa que se espera que provea tu imagen base.

Al arrancar, el constructor estático de `GlobalizationMode` recorre una lista de decisiones fija:

1. ¿Está activo el modo de globalización invariante? Si es así, omite ICU por completo y usa los datos invariantes integrados.
2. ¿Está configurado ICU local a la aplicación? Si es así, carga `libicuuc.so.<version>` y `libicui18n.so.<version>` desde el directorio de la aplicación.
3. ¿Está definida `DOTNET_ICU_VERSION_OVERRIDE`? Si es así, intenta esa versión exacta.
4. En caso contrario, carga la versión de ICU instalada en el sistema con el número más alto.

Si el paso 4 no encuentra nada, el runtime llama a `Environment.FailFast`. Ese es el detalle que confunde a la gente: esto no es una excepción. No hay `try`/`catch` que te salve, ni gancho en `AppDomain.UnhandledException`, ni retroceso elegante al modo invariante. El proceso aborta antes de que `Main` empiece de verdad, lo que en Linux aparece como SIGABRT y un código de salida 134 en el contenedor. El diseño es deliberado: degradarse en silencio a comparación ordinal de cadenas cambiaría el orden, las mayúsculas y el análisis de fechas de maneras que producen datos incorrectos en lugar de un fallo ruidoso.

Las imágenes con más probabilidad de toparse con esto son justo las que elegiste porque son pequeñas. Alpine, Azure Linux distroless y Ubuntu chiseled omiten ICU y tzdata, y la documentación de contenedores de .NET es explícita en que esas imágenes solo funcionan con aplicaciones configuradas para el modo de globalización invariante. Las imágenes completas de Debian y Ubuntu sí incluyen ICU, y por eso la aplicación funcionaba en tu máquina y en la imagen `sdk`, y murió en cuanto aterrizó en la etapa de runtime.

## La reproducción mínima

Dos etapas, una compilación estándar con el SDK, un runtime Alpine. Este Dockerfile basta:

```dockerfile
# .NET 10. Fails at startup with the ICU error.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

La aplicación en sí no tiene que hacer nada exótico. El fallo ocurre durante la inicialización del runtime, antes de que corra tu código, así que incluso esto se cae:

```csharp
// .NET 10, C# 14. Never reaches the WriteLine.
Console.WriteLine("hello");
```

Vale la pena interiorizarlo, porque el primer instinto es buscar la llamada a `CultureInfo` que lo provocó. No la hay. La inicialización de la globalización es temprana.

## Solución 1: instalar ICU en la imagen

Esta es la solución correcta para la mayoría de aplicaciones, y la que documentan los ejemplos de contenedores de .NET. En Alpine:

```dockerfile
# .NET 10 on Alpine 3.22. Adds ICU and disables invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
RUN apk add --no-cache icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`icu-data-full` no es relleno opcional. Desde Alpine 3.16 el paquete de datos de ICU se dividió y `icu-libs` por sí solo trae únicamente la configuración regional `en`, lo que produce un fallo mucho más confuso que aquel con el que empezaste: el runtime arranca bien y luego todas las culturas que no son inglés se formatean en silencio como inglés. Las pruebas que verifican formatos de fecha `fr-FR` empiezan a fallar sin ningún mensaje de error. Instala ambos paquetes.

La línea `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` solo importa si algo aguas arriba lo puso en `true`, cosa que hacen varias imágenes base y plantillas de CI. Definirlo de forma explícita no cuesta nada y elimina toda una clase de errores por entorno heredado.

El equivalente en imágenes basadas en Debian o Ubuntu, que solo necesitarías para una imagen `runtime-deps` que armaste tú:

```dockerfile
# .NET 10 on Ubuntu 24.04 (noble).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu74 tzdata \
    && rm -rf /var/lib/apt/lists/*
```

Fija el nombre del paquete `libicu` al que realmente incluye tu versión de la distribución (`libicu74` en Ubuntu 24.04, `libicu72` en Debian bookworm). Si prefieres no rastrear eso, `apt-get install -y libicu-dev` arrastra la biblioteca de runtime correcta a costa de una capa más grande.

## Solución 2: cambiar a una variante de imagen `-extra`

Microsoft publica imágenes optimizadas en tamaño en tres sabores, y el sufijo `-extra` es exactamente "la imagen pequeña, más ICU, tzdata y `libstdc++`". Si estás en chiseled o Azure Linux, es una línea en vez de una instalación de paquetes:

```dockerfile
# .NET 10, Ubuntu chiseled with globalization support.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

Hay una asimetría de disponibilidad que conviene conocer antes de planear en torno a ella. Para Ubuntu chiseled y Azure Linux, `-extra` existe en los repositorios `runtime-deps`, `runtime` y `aspnet`. Para Alpine, `-extra` solo se publica en `runtime-deps`, lo que significa que solo puedes usarlo con una publicación autocontenida o Native AOT. Una aplicación Alpine dependiente del framework tiene que instalar los paquetes a mano como en la Solución 1.

Si construyes imágenes con el soporte de contenedores integrado del SDK en lugar de un Dockerfile, selecciona la variante mediante `ContainerFamily` en vez de una línea `FROM`:

```xml
<!-- .NET 10 SDK. Applies to dotnet publish /t:PublishContainer. -->
<PropertyGroup>
  <ContainerFamily>noble-chiseled-extra</ContainerFamily>
</PropertyGroup>
```

Eso se conecta al mismo flujo descrito en [publicar una aplicación .NET como imagen de contenedor con PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/), y mantiene la elección de la imagen base en el archivo del proyecto, donde vive el resto de tu configuración de publicación.

## Solución 3: activar la globalización invariante, de forma deliberada

Si la aplicación de verdad no depende de la cultura (una API interna que intercambia marcas de tiempo ISO-8601 y números en formato invariante es el caso clásico), el modo invariante no es un parche, es la configuración correcta. Elimina la dependencia por completo y te compra una imagen más pequeña y un arranque más rápido.

```xml
<!-- .NET 10, C# 14. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Configúralo en el archivo del proyecto, no en el Dockerfile. Según el documento de diseño del modo de globalización invariante del runtime, los valores del archivo del proyecto y de `runtimeconfig.json` tienen precedencia sobre `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT`, así que la propiedad de MSBuild es la que siempre gana y la variable de entorno es la que pierde en silencio. El archivo del proyecto además viaja con la aplicación: nadie puede meter tu contenedor en otro orquestador, olvidar el bloque de entorno y resucitar el fallo.

Ten claro a qué estás accediendo. En modo invariante:

- `ToUpper` y `ToLower` solo transforman el rango ASCII. Las reglas de la I turca con y sin punto desaparecen.
- `String.Compare`, `IndexOf` y `LastIndexOf` hacen comparación ordinal sin importar el `CompareOptions` o `StringComparison` que pases. El orden lingüístico se convierte en silencio en orden de bytes.
- `String.Normalize` devuelve la cadena sin cambios.
- Los nombres para mostrar de las zonas horarias en Linux caen al nombre estándar en vez del nombre localizado de ICU.
- `TimeZoneInfo.TryConvertIanaIdToWindowsId` y su inverso fallan, porque se apoyan en ICU.
- La enumeración de culturas devuelve exactamente una cultura, y todos los LCID colapsan a `0x1000`.

El cambio que más duele en la práctica es la creación de culturas. Desde .NET 6, `PredefinedCulturesOnly` vale `true` por defecto en modo invariante, así que `new CultureInfo("fr-FR")` lanza:

```text
System.Globalization.CultureNotFoundException: Only the invariant culture is supported
in globalization-invariant mode.
```

Si necesitas que la construcción funcione (un middleware de localización de solicitudes que analiza `Accept-Language` hará esto aunque nunca uses el resultado), puedes relajarlo:

```xml
<!-- .NET 10. Cultures can be created, but all behave as invariant. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
  <PredefinedCulturesOnly>false</PredefinedCulturesOnly>
</PropertyGroup>
```

Eso detiene la excepción. No restaura el comportamiento específico de cada cultura: cada cultura que crees se comporta exactamente como la invariante. `1234.56m.ToString("C", new CultureInfo("de-DE"))` sigue devolviendo la forma de moneda invariante con el signo genérico de moneda, no un importe en euros con formato alemán. Tratar este par como "la solución" para una aplicación realmente localizada es la forma de publicar una aplicación cuya salida está mal en todas partes menos en en-US.

## Solución 4: llevar tu propio ICU con ICU local a la aplicación

La opción de nicho pero legítima: fijar una versión exacta de ICU y enviarla con la aplicación, para que el comportamiento sea idéntico byte a byte en cada host donde implementes. Los saltos de versión de ICU cambian los datos de CLDR, y los datos de CLDR cambian el orden y el formato, así que una aplicación con pruebas de archivo de referencia sobre salida formateada puede desestabilizarse por una actualización de la imagen base que nunca pidió.

```xml
<!-- .NET 10. Ships ICU 72.1 with the app instead of using the system copy. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Globalization.AppLocalIcu" Value="72.1" />
  <PackageReference Include="Microsoft.ICU.ICU4C.Runtime" Version="72.1.0.3" />
</ItemGroup>
```

Con el interruptor activo, .NET carga `libicuuc.so.72.1` y `libicui18n.so.72.1` desde las rutas de sondeo nativas de la aplicación y nunca mira la copia del sistema. La variable de entorno correspondiente es `DOTNET_SYSTEM_GLOBALIZATION_APPLOCALICU`, y el formato del valor es `<version>` o `<suffix>:<version>`, donde el sufijo corresponde a una compilación personalizada de ICU. Si faltan las bibliotecas obtienes un fallo distinto y más específico: `Failed to load app-local ICU: <library name>`. Haz coincidir la versión del `PackageReference` con el valor del interruptor o verás exactamente eso.

## Trampas que llevan a la solución equivocada

**`ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` en el Dockerfile no hizo nada.** Revisa el archivo del proyecto. Si `<InvariantGlobalization>true</InvariantGlobalization>` está definido ahí o en `runtimeconfig.json`, tiene precedencia y tu variable de entorno es inerte. Busca en toda la solución, incluido `Directory.Build.props`, donde suele vivir una optimización de tamaño bienintencionada.

**`Failed to load system ICU: libicuuc.so.<n>` en lugar del mensaje anterior.** Esa es otra rama. Significa que el sondeo por versión encontró ICU pero no se pudo cargar el soname concreto, normalmente por una instalación parcial o una discrepancia de arquitectura (una capa `amd64` corriendo bajo emulación `arm64`). Verifícalo con `ldconfig -p | grep icu` dentro del contenedor.

**El error solo aparece en publicaciones Native AOT o con trimming.** Entonces probablemente no sea la imagen en absoluto. `PublishAot` y `PublishTrimmed` interactúan con los interruptores de características, e `InvariantGlobalization` es uno de los que se activan a menudo por tamaño en las plantillas de AOT. La misma clase de problema de "el SDK cambió un interruptor a tus espaldas" se cubre en [por qué se desactiva la serialización basada en reflexión](/es/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) y en el tratamiento más amplio del [código seguro para trimming](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**Las fechas se formatean bien pero las zonas horarias no se resuelven.** ICU y tzdata son paquetes separados. `TimeZoneInfo.FindSystemTimeZoneById` lee `/usr/share/zoneinfo`, que las imágenes optimizadas en tamaño también omiten. Instala `tzdata` junto a `icu-libs`, o usa la variante `-extra`, que incluye ambos.

**Todo funciona salvo las pruebas específicas de cultura.** Instalaste `icu-libs` sin `icu-data-full` en Alpine. Solo están presentes los datos de `en`.

**La imagen del SDK funciona y la de runtime no.** Es lo esperado. Las imágenes `sdk` están basadas en Debian por defecto y traen ICU; tu etapa final `aspnet` o `runtime` es la que necesita la dependencia. Diagnostica dentro de la capa de runtime real, no en la de compilación.

Para confirmar en qué modo terminaste, sin adivinar:

```csharp
// .NET 10, C# 14. Prints 1 in invariant mode, several hundred with ICU loaded.
using System.Globalization;

Console.WriteLine(CultureInfo.GetCultures(CultureTypes.AllCultures).Length);
Console.WriteLine(AppContext.TryGetSwitch("System.Globalization.Invariant", out bool inv) && inv);
```

## Relacionado

- [Cómo publicar una aplicación .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [¿Qué es Native AOT y cuánto te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [¿Qué es el código seguro para trimming y cómo lo escribo?](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Fuentes

- [Modo de globalización invariante de .NET](https://github.com/dotnet/runtime/blob/main/docs/design/features/globalization-invariant-mode.md), para la lista de comportamientos y la precedencia de configuración - dotnet/runtime
- [`GlobalizationMode.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Globalization/GlobalizationMode.Unix.cs), para el orden de carga y el `FailFast` cuando falta ICU - dotnet/runtime
- [Opciones de configuración de globalización](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/globalization) - MS Learn
- [Globalización de .NET e ICU](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu), para ICU local a la aplicación y la secuencia de sondeo en Linux - MS Learn
- [Habilitar la globalización en imágenes de contenedor .NET](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) - dotnet/dotnet-docker
- [Variantes de imagen de .NET](https://github.com/dotnet/dotnet-docker/blob/main/documentation/image-variants.md), para saber qué repositorios publican `-extra` - dotnet/dotnet-docker
- [Imágenes de contenedor de .NET](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) - MS Learn
- [Instalar .NET en Alpine](https://learn.microsoft.com/en-us/dotnet/core/install/linux-alpine), para la lista de dependencias incluido `icu-data-full` - MS Learn
- [Alpine 3.16 icu-libs ahora contiene solo en](https://github.com/dotnet/dotnet-docker/issues/3844) - dotnet/dotnet-docker
- [Creación de culturas y mapeo de mayúsculas en modo de globalización invariante](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode) - MS Learn
