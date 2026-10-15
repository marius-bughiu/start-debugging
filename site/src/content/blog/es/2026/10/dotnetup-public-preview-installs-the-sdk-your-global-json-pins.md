---
title: "dotnetup en versión preliminar pública: un comando instala el SDK que fija tu global.json"
description: "dotnetup pasó a versión preliminar pública el 15 de octubre de 2026. Ejecuta dotnetup sdk install en un repositorio y lee global.json, asigna rollForward a un canal de actualización e incluso puede escribir versiones de parche más nuevas de vuelta en el archivo."
pubDate: 2026-10-15
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
  - "global-json"
lang: "es"
translationOf: "2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins"
translatedBy: "claude"
translationDate: 2026-10-15
---

El 15 de octubre de 2026 Microsoft [anunció la versión preliminar pública de dotnetup](https://devblogs.microsoft.com/dotnet/introducing-dotnetup/), el administrador de toolchains al estilo rustup para SDKs y runtimes de .NET. Cuando [escribí sobre él por primera vez en junio](/es/2026/06/dotnetup-official-dotnet-sdk-version-manager/), había que compilarlo desde el código fuente y solo estaba confirmado `dotnetup sdk install preview`. Ahora hay un instalador de una línea, una [referencia completa de comandos en Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnetup/) y una respuesta a la pregunta que más me importaba: qué hace con `global.json`.

## Cómo instalarlo en la máquina

El script de arranque descarga la última compilación `preview`, verifica su suma de comprobación SHA-512 y la coloca en `~/.dotnetup`. Sin `sudo`.

```bash
# macOS / Linux (x64 and Arm64, glibc and musl)
curl -fsSL https://aka.ms/dotnetup/get-dotnetup.sh | bash

# then, non-interactively
dotnetup install latest
dotnetup env set shell
```

En Windows el equivalente de PowerShell es `irm https://aka.ms/dotnetup/get-dotnetup.ps1 | iex`. Ten cuidado con los valores predeterminados de Windows. `dotnetup init` sugiere el modo `everywhere`, que cambia el `PATH` del sistema y establece `DOTNET_ROOT`. La instalación administrada pasa entonces a tener prioridad sobre los SDKs que instaló Visual Studio, así que un proyecto que necesite un SDK de todo el equipo que dotnetup no tenga también dejará de compilar. Elige `shell` o `none` a menos que planees migrar todo.

`none` es el modo más interesante para probarlo. Deja `PATH` y `DOTNET_ROOT` intactos y en su lugar reenvía los comandos:

```bash
dotnetup env set none --dotnetup-on-path true
dotnetup dotnet -- --info
dotnetup dotnet build
```

## global.json se convierte en un requisito rastreado

Dentro de un repositorio, ejecuta `dotnetup sdk install` sin canal. Sube por los directorios desde el actual, usa el `global.json` más cercano y recurre a `latest` si no existe ninguno. Un archivo con formato incorrecto hace fallar el comando. No recurre silenciosamente a un directorio padre.

```json
{
  "sdk": {
    "version": "10.0.103",
    "rollForward": "latestPatch"
  }
}
```

El detalle clave es que dotnetup no instala solo `10.0.103`. Convierte `rollForward` en un canal que `dotnetup update` seguirá refrescando:

| `rollForward` | Canal rastreado |
| --- | --- |
| omitido o `latestPatch` | `10.0.1xx` |
| `latestFeature` | `10.0` |
| `latestMinor` | `10` |
| `latestMajor` | `latest` |
| `disable`, `patch`, `feature`, `minor`, `major` | exacto `10.0.103`, nunca se actualiza |

`allowPrerelease` no afecta al canal. `dotnetup list` muestra la ruta de `global.json` como origen de cada requisito, de modo que puedes saber qué repositorio mantiene vivo un SDK antiguo. Cuando ya nada referencia a un SDK, la siguiente actualización lo elimina.

## Escribir los parches de vuelta en global.json

Esto es nuevo para mí y bastante útil para repositorios que fijan versiones de parche exactas para compilaciones reproducibles:

```bash
dotnetup sdk install --update-global-json
# later, across every tracked repo
dotnetup sdk update --update-global-json
```

Instala el SDK más reciente del canal derivado y reescribe solo `sdk.version`, conservando el formato, las demás propiedades y la codificación de texto del archivo. Eso reemplaza un PR al estilo Dependabot o una edición manual cada Patch Tuesday.

## Asperezas de la versión preliminar

- Si `global.json` tiene `sdk.paths`, dotnetup instala en la primera entrada. En esta versión preliminar trata `$host$` como una ruta literal y no omite las entradas vacías, así que omite `sdk.paths` o pasa `--install-path`.
- `dotnetup sdk uninstall 10.0.1xx --source globaljson` elimina todos los requisitos de `global.json` coincidentes en la raíz de instalación, no solo el del repositorio actual.
- La integración de primera clase con GitHub Actions y Azure DevOps sigue en la hoja de ruta, aunque los comandos ya se ejecutan de forma no interactiva en CI.

Si manejas varios repositorios fijados a distintas bandas de características de .NET 10, `dotnetup sdk install` por repositorio más un `dotnetup update` semanal ya es una mejor opción que los scripts `dotnet-install`. Los comentarios van a las [discusiones de dotnetup en dotnet/sdk](https://github.com/dotnet/sdk/discussions/categories/dotnetup).
