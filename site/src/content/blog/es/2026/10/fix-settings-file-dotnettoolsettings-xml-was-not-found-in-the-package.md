---
title: "Fix: Settings file 'DotnetToolSettings.xml' was not found in the package"
description: "El paquete de la herramienta apunta a una versión de .NET más nueva que el SDK que ejecuta la instalación, o no es una herramienta de .NET. Usa un SDK más nuevo, fija una versión de la herramienta con una carpeta tools compatible, o fuerza --framework."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "dotnet-tools"
  - "ef-core"
lang: "es"
translationOf: "2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package"
translatedBy: "claude"
translationDate: 2026-10-12
---

Casi nunca el paquete está roto, y limpiar la caché de NuGet no ayudará. Este mensaje significa que el SDK que ejecuta `dotnet tool install` no encontró ninguna carpeta `tools/<tfm>/` que pueda usar. La causa habitual es una herramienta compilada solo para un .NET más nuevo que el propio SDK, por ejemplo `dotnet-ef` 10.0.0/10.0.1 o 11.0 en el SDK 8 o 9. Ejecuta `dotnet --version` en la carpeta donde falla la instalación. Luego pasa a un SDK al menos tan nuevo como el framework de destino de la herramienta, o fija una versión de la herramienta que incluya una carpeta `tools/` más antigua (`dotnet-ef` 10.0.2 y posteriores vuelven a incluir `net8.0`). Si el paquete no es una herramienta de .NET en absoluto (`Microsoft.EntityFrameworkCore.Tools`, `Microsoft.EntityFrameworkCore.Design`), instala `dotnet-ef` en su lugar. Todo lo que sigue se reprodujo el 2026-10-12 con los SDK 8.0.425, 9.0.318 y 10.0.302 en macOS arm64, contra nuget.org en vivo.

## El error en contexto

`dotnet tool install` (global, `--tool-path` o local) imprime esto, incluso en una máquina limpia donde no se había instalado nada antes:

```
Tool 'dotnet-ef' failed to update due to the following:
The settings file in the tool's NuGet package is invalid: Settings file 'DotnetToolSettings.xml' was not found in the package.
Tool 'dotnet-ef' failed to install. Contact the tool author for assistance.
```

"Failed to update" es engañoso. Aparece también en una primera instalación. `dotnet tool restore` y `dotnet dnx` pasan por el mismo código pero no envuelven la excepción, así que en un repositorio con un manifiesto de herramientas obtienes la forma sin procesar:

```
Unhandled exception: Settings file 'DotnetToolSettings.xml' was not found in the package.
```

Ambas formas terminan con código de salida 1. Nada más en la salida te dice qué framework buscaba el SDK, y por eso la gente acaba borrando cachés y reinstalando SDK al azar.

## Por qué ocurre

Un paquete de herramienta de .NET guarda su contenido en `tools/<target framework>/<rid>/`, y `DotnetToolSettings.xml` vive en esa carpeta. El archivo existe, pero solo dentro de una carpeta de framework. El SDK no busca el archivo en todo el paquete. Construye un archivo de assets sintético con las reglas de selección de assets de NuGet y pide el elemento en la **carpeta de framework compatible más cercana**. En el código fuente del SDK de .NET 10 (`ToolPackageDownloader.CreateAssetFile`), el framework de destino sale del runtime en el que se ejecuta la CLI:

```csharp
// dotnet/sdk, release/10.0.3xx: src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs
currentTargetFramework = new NuGetFramework(
    FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
    new Version(Environment.Version.Major, Environment.Version.Minor));
```

El SDK 9.0.318 se ejecuta sobre el runtime de .NET 9, así que pide `net9.0`. Un paquete que solo contiene `tools/net10.0/any/` no tiene una carpeta compatible, por lo que la lista de elementos seleccionados queda vacía. Entonces `ToolPackageInstance.DeserializeToolConfiguration` lanza `MissingToolSettingsFile`, que es el mensaje que ves. En la práctica el texto significa "ninguna carpeta `tools/` apunta a un framework que este SDK pueda ejecutar".

Dos consecuencias sorprenden a la gente:

1. **Los runtimes instalados no cuentan.** Agregué el runtime de .NET 10.0.12 junto al SDK 9.0.318 y la instalación simple de `dotnet-ef` 10.0.1 siguió fallando con el mismo mensaje. Solo importa la versión del runtime propio del SDK.
2. **La comprobación del tipo de paquete llega después, y solo en el SDK 10.** El SDK 10 revisa primero el `packageType` del nuspec e imprime un claro "is not a .NET tool" para los paquetes que no son herramientas. Los SDK 8 y 9 se saltan esa comprobación y caen en el mismo mensaje engañoso.

Así que hay tres causas reales detrás de una misma cadena, ordenadas por frecuencia:

- **La herramienta apunta a un .NET más nuevo que tu SDK.** Es la causa habitual después de una nueva versión mayor (`dotnet-ef` 10.0.0/10.0.1, `AzureSignTool` 7.0.0, cualquier herramienta compilada solo para `net10.0` o `net11.0`).
- **La herramienta es una herramienta específica de RID (específica de plataforma) de .NET 10.** Su paquete raíz también tiene solo una carpeta `tools/net10.0/`, así que los SDK más antiguos fallan igual.
- **El paquete no es una herramienta.** Es una biblioteca o un paquete de MSBuild/PowerShell, instalado por error con `dotnet tool install`.

## Reproducción mínima

Estos comandos usan `--tool-path` para que nada toque tu carpeta global de herramientas. Cada bloque muestra la versión del SDK que lo ejecutó.

```bash
# SDK 9.0.318 (also identical on SDK 8.0.425)
dotnet tool install dotnet-ef --version 10.0.1 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --version 11.0.0-rc.1.26425.128 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install AzureSignTool --version 7.0.0 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --tool-path ./tools
# Tool 'dotnet-ef' (version '10.0.12') was successfully installed.  exit 0
```

La última línea importa. El `dotnet tool install dotnet-ef` simple se resuelve hoy a 10.0.12 y funciona en los SDK 8 y 9. El fallo solo aparece cuando se fija una versión, por ejemplo en un manifiesto `dotnet-tools.json` o en un script de CI escrito en noviembre de 2025. Esta es la estructura de `tools/` de cada versión de `dotnet-ef` que revisé en nuget.org:

| versión de dotnet-ef | carpeta tools | Se instala en SDK 8 / 9 | Se instala en SDK 10 |
|---|---|---|---|
| 8.0.21 | `tools/net8.0/any/` | sí | sí |
| 9.0.10 | `tools/net8.0/any/` | sí | sí |
| 10.0.0, 10.0.1 | `tools/net10.0/any/` | **no** | sí |
| 10.0.2 a 10.0.12 | `tools/net8.0/any/` | sí | sí |
| 11.0.0-rc.1.26425.128 | `tools/net10.0/any/` | **no** | sí |

Lo mismo ocurre una versión mayor más arriba. Reempaqueté una herramienta trivial para que su única carpeta fuera `tools/net11.0/any/`, y el SDK 10.0.302 la rechazó con el mismo mensaje. `dotnet dnx` en el SDK 10 imprimió la forma "Unhandled exception" para el mismo paquete.

## La solución, en detalle

### 1. Comprueba qué SDK se ejecuta realmente en esa carpeta

`global.json` elige el SDK por directorio, así que el SDK que ejecuta `dotnet tool restore` en tu repositorio puede no ser el más nuevo instalado:

```bash
# Any SDK. Run in the directory where the install fails.
dotnet --version
dotnet --list-sdks
cat global.json 2>/dev/null
```

Si `dotnet --version` imprime `8.0.x` o `9.0.x` y la herramienta apunta a `net10.0`, esa es tu respuesta. En CI, la misma discrepancia viene de una imagen de runner que solo tiene el SDK antiguo, o de `actions/setup-dotnet` leyendo un `global.json` que fija 8.0. La [guía de CI para "the command dotnet could not be found"](/es/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) explica cómo el runner elige su SDK.

### 2. Recomendado: ejecuta la herramienta con un SDK al menos tan nuevo como su destino

```json
// global.json, .NET 10 SDK. rollForward keeps you on the newest 10.0 feature band.
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

Un SDK de .NET 10 compila proyectos `net8.0` y `net9.0` sin ningún cambio, así que subir el SDK no te obliga a cambiar el destino de tu aplicación. Es la solución más limpia porque todas las demás herramientas de tu manifiesto también se benefician. Si de todos modos estás planeando la migración completa, la [lista de verificación de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) enumera los cambios incompatibles a nivel de SDK que debes esperar.

### 3. Si no puedes cambiar el SDK: fija una versión de la herramienta con una carpeta compatible

Para `dotnet-ef`, cualquier compilación 10.0.2 o posterior incluye `tools/net8.0/` y se instala en los SDK 8 y 9:

```bash
# SDK 8.0.425 or 9.0.318
dotnet tool install --global dotnet-ef --version 10.0.12
```

```json
// .config/dotnet-tools.json, works with SDK 8, 9 and 10
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "10.0.12", "commands": [ "dotnet-ef" ], "rollForward": false }
  }
}
```

La herramienta sigue necesitando un runtime en el que pueda ejecutarse. La compilación `net8.0` de `dotnet-ef` 10.0.12 funcionó sin problemas en el SDK 8.0.425 con solo el runtime de .NET 8 instalado. Para otras herramientas, mira dentro del paquete antes de fijar la versión. La pestaña "Frameworks" en nuget.org lo muestra, o puedes listar el archivo directamente:

```bash
# Any OS with curl and unzip. Replace the id and version.
curl -sL https://api.nuget.org/v3-flatcontainer/dotnet-ef/10.0.1/dotnet-ef.10.0.1.nupkg -o t.nupkg
unzip -l t.nupkg | grep DotnetToolSettings
#   tools/net10.0/any/DotnetToolSettings.xml
```

Si todas las versiones que puedes usar solo tienen una carpeta más nueva, vuelve a la solución 2.

### 4. Salida de emergencia: fuerza el framework con `--framework`

`dotnet tool install` y `dotnet tool update` aceptan `--framework`, y ese valor reemplaza a `Environment.Version` en la selección de assets descrita arriba. Si el runtime más nuevo está instalado en paralelo, un SDK antiguo puede instalar una herramienta portable más nueva:

```bash
# SDK 9.0.318 with the .NET 10.0.12 runtime installed next to it
dotnet tool install --global dotnet-ef --version 10.0.1 --framework net10.0
# Tool 'dotnet-ef' (version '10.0.1') was successfully installed.
dotnet-ef --version
# 10.0.1
```

Sin el runtime de .NET 10 la instalación igualmente "tiene éxito", pero la herramienta falla en su primera ejecución. En el SDK 8.0.425 con solo .NET 8 presente, `dotnet-ef` informó "You must install or update .NET to run this application" y pidió `Microsoft.NETCore.App` 10.0.0. `dotnet tool restore` no tiene la opción `--framework`, así que esto solo ayuda en las instalaciones globales y con `--tool-path`. Tómalo como un parche temporal, no como una solución para un pipeline.

### 5. Si el paquete no es una herramienta: instala el paquete correcto

`Microsoft.EntityFrameworkCore.Tools` es el paquete de la Package Manager Console para Visual Studio, y `Microsoft.EntityFrameworkCore.Design` es la biblioteca de tiempo de diseño que referencia tu proyecto de inicio. Ninguno es una herramienta de .NET. Lo que imprime cada SDK depende de la versión:

```bash
# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.

# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Design
# Unhandled exception: System.IO.DirectoryNotFoundException: Could not find a part
# of the path '.../microsoft.entityframeworkcore.design/10.0.12/tools'.

# SDK 10.0.302
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Package microsoft.entityframeworkcore.tools is not a .NET tool.
```

La herramienta de CLI es `dotnet-ef`. Agrega `Microsoft.EntityFrameworkCore.Design` a tu proyecto de inicio como un `PackageReference` normal. Si `dotnet ef` se queja de eso más adelante, la solución está en [your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/es/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

## Trampas y errores parecidos

**Las herramientas específicas de RID de .NET 10 esconden un mensaje mejor.** .NET 10 permite a los autores distribuir [herramientas específicas de plataforma](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools): un paquete raíz pequeño cuyo `DotnetToolSettings.xml` usa `Version="2"` y apunta a paquetes por RID. Empaqueté una con `<RuntimeIdentifiers>osx-arm64;linux-x64;win-x64</RuntimeIdentifiers>` en el SDK 10.0.302. Los SDK 8.0.425 y 9.0.318 la rechazaron con el texto genérico "was not found", porque el paquete raíz solo tiene una carpeta `net10.0`. Microsoft retrocedió un error más claro al SDK 8.0.21 ([dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414)), pero solo llegas a él una vez que la carpeta se resuelve. Con `--framework net10.0`, el SDK 9.0.318 imprimió "Format version is higher than supported. This tool may not be supported in this SDK version. Update your SDK." `--framework` no puede rescatar una herramienta específica de RID. La única solución es un SDK de .NET 10.

**Limpiar las cachés no lo arregla.** `dotnet nuget locals all --clear` es el consejo más común para este mensaje. No puede ayudar en ninguno de los tres casos anteriores, porque el paquete se descargó correctamente. El archivo está en el paquete, solo que no en una carpeta que tu SDK seleccione. Una descarga truncada es posible en teoría, pero está muy abajo en la lista. Revisa `dotnet --version` y la carpeta `tools/` del paquete antes de recurrir a la caché.

**"Tool 'dotnet-ef' is already installed", "is not found in NuGet feeds" y los conflictos de shim son fallos distintos** con banderas distintas. Los seis se cubren en [every way dotnet tool install --global dotnet-ef fails](/es/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/).

**La instalación funcionó pero `dotnet ef` "no se encuentra".** Eso es un problema de `PATH`, no del paquete. Consulta [cómo arreglar "dotnet ef" not found](/es/2023/06/how-to-fix-command-dotnet-ef-not-found/).

**Los autores de herramientas pueden evitarles esto a sus usuarios.** Haz que la herramienta tenga varios destinos (`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` con `<PackAsTool>true</PackAsTool>`) para que los SDK antiguos encuentren una carpeta que puedan ejecutar, como hizo `dotnet-ef` desde la 10.0.2. Para las herramientas específicas de RID, Andrew Lock documenta un paquete raíz de compromiso que también incluye una compilación dependiente del framework para los SDK antiguos. El equipo del SDK coincide en que el mensaje no ayuda. [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172) y [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878) siguen abiertos al momento de escribir esto.

## Relacionado

- [Fix: dotnet tool install --global dotnet-ef throws an error](/es/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/), para los otros fallos de instalación y la discrepancia de runtime que solo aparece después de una instalación exitosa.
- [Cómo arreglar "dotnet ef" not found](/es/2023/06/how-to-fix-command-dotnet-ef-not-found/), para el lado de `PATH` de la misma herramienta.
- [Fix: the command dotnet could not be found on CI](/es/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), para saber cómo los runners de CI eligen y exponen un SDK.
- [Fix: your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/es/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/), para el paquete que la gente intenta instalar como herramienta por error.
- [Migrar de .NET 8 a .NET 11: la lista de verificación completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), si subir el SDK es parte de una actualización más grande.

## Fuentes

- [dotnet/sdk `ToolPackageDownloader.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs) y [`ToolPackageInstance.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageInstance.cs), para la selección del framework y el `throw` de `MissingToolSettingsFile`.
- [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172), "Installing a tool that targets a framework not installed gives a non-actionable error message".
- [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878), el reporte de `AzureSignTool` 7.0.0 y la explicación de que la regresión data de .NET 7, cuando las descargas de herramientas dejaron de pasar por restore.
- [dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414), el backport a 8.0.4xx del error "Format version is higher than supported".
- [Create RID-specific, self-contained, and AOT .NET tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools) en Microsoft Learn.
- [dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), para `--framework`, `--tool-path` y el comportamiento del manifiesto.
- Andrew Lock, [Supporting platform-specific .NET tools on old SDKs](https://andrewlock.net/exploring-dotnet-10-preview-features-8-supporting-platform-specific-dotnet-tools-on-old-sdks/), para los esquemas de `DotnetToolSettings.xml` de versión 1 frente a versión 2.
