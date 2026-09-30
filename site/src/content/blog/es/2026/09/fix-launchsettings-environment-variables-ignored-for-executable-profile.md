---
title: "Solución: las variables de entorno de launchSettings.json se ignoran en un perfil con commandName: Executable"
description: "Si tu perfil Executable ejecuta dotnet run o dotnet watch, el comando interno aplica el perfil predeterminado y sobrescribe tus variables. Agrega --no-launch-profile y usa el SDK 10.0.200+."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dotnet-cli"
  - "launchsettings"
  - "dotnet-watch"
  - "dotnet-10"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/fix-launchsettings-environment-variables-ignored-for-executable-profile"
translatedBy: "claude"
translationDate: 2026-09-30
---

Si tu perfil `commandName: "Executable"` lanza `dotnet run` o `dotnet watch run`, agrega `--no-launch-profile` (o `--launch-profile <name>`) a su `commandLineArgs`. De lo contrario, el comando interno elige el perfil predeterminado del proyecto, y las `environmentVariables` de ese perfil sobrescriben las que tu perfil Executable acaba de establecer. Si la CLI muestra "The launch profile type 'Executable' is not supported", estás en un SDK anterior a 10.0.200. Actualiza, porque esos SDK omiten el perfil completo. Medí todo lo que sigue en macOS con los SDK 10.0.112, 10.0.302, 10.0.401 y 11.0.100-rc.1.

## El error en contexto

Hay dos versiones de este problema, y cuál encuentras depende de tu SDK.

En un SDK 10.0.1xx (y en SDK anteriores, que solo entendían perfiles Project), `dotnet run --launch-profile` te lo dice directamente y después ejecuta el proyecto de todos modos:

```
Using launch settings from /src/app/Properties/launchSettings.json...
The launch profile "Exe" could not be applied.
The launch profile type 'Executable' is not supported.
MY_MODE=<null> DOTNET_ENVIRONMENT=<null> DOTNET_LAUNCH_PROFILE=<null> args=[] cwd=/src/app
```

Ese mensaje es fácil de pasar por alto porque la aplicación arranca. Solo que arranca sin ningún perfil: sin variables de entorno, sin `commandLineArgs`, ni siquiera `DOTNET_LAUNCH_PROFILE`.

En 10.0.200 y posteriores no hay advertencia. El perfil se ejecuta, pero la aplicación ve valores incorrectos. Este es el caso reportado en [dotnet/sdk#56023](https://github.com/dotnet/sdk/issues/56023): un perfil "Watch" establece `ASPNETCORE_ENVIRONMENT=Development`, y la aplicación sigue reportando `Production`. La única pista es que la línea "Using launch settings" se imprime dos veces:

```
Using launch settings from /src/app/Properties/launchSettings.json...
Using launch settings from /src/app/Properties/launchSettings.json...
MY_MODE=from-Default DOTNET_ENVIRONMENT=Production DOTNET_LAUNCH_PROFILE=Default args=[] cwd=/src/app
```

## Por qué se pierden las variables

Estas son las causas, de la más común a la menos común:

1. **Un comando anidado del SDK vuelve a aplicar un perfil.** `dotnet run` aplica correctamente un perfil Executable. Inicia `executablePath` con las `environmentVariables` del perfil ya establecidas. Pero cuando ese ejecutable es `dotnet` mismo (`run`, `watch run`), el proceso hijo es un `dotnet run` nuevo sin `--launch-profile`. Lee el mismo `launchSettings.json`, selecciona el *primer* perfil con un `commandName` compatible y establece las variables de ese perfil en el proceso de la aplicación. Las variables del perfil ganan sobre las heredadas (consulta `SetEnvironmentVariables` en [`RunCommand.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Cli/dotnet/Commands/Run/RunCommand.cs)), así que tus valores externos se reemplazan en silencio.
2. **El SDK es anterior a 10.0.200.** La compatibilidad con Executable en `dotnet run` y `dotnet watch` llegó con [dotnet/sdk#51727](https://github.com/dotnet/sdk/pull/51727), fusionado en `release/10.0.2xx` el 12 de diciembre de 2025. Antes de eso, la CLI solo conocía `commandName: "Project"`. Visual Studio siempre admitió perfiles Executable, por eso el mismo archivo "funciona en VS".
3. **El IDE nunca lee perfiles Executable.** La extensión de C# para VS Code documenta que "Only profiles with `"commandName": "Project"` are supported" en su [configuración del depurador](https://code.visualstudio.com/docs/csharp/debugger-settings). Elegir un perfil Executable allí no hace nada con sus variables.

## Cómo dotnet run elige un perfil y superpone variables

Conviene conocer el orden exacto que sigue la CLI, porque cada solución alternativa de abajo es solo una forma de controlar uno de estos pasos. En el SDK 10.0.200 y posteriores, `dotnet run` hace lo siguiente:

1. Si pasas `--no-launch-profile`, no usa ningún perfil. Se detiene aquí.
2. De lo contrario, busca `Properties/launchSettings.json` (`My Project/launchSettings.json` para VB, o `<app>.run.json` junto a una aplicación basada en archivo).
3. Con `--launch-profile <name>` elige ese perfil. La búsqueda distingue mayúsculas y minúsculas primero, y luego recurre a una coincidencia que no las distingue. Sin la opción, elige el primer perfil cuyo `commandName` sea `Project` o `Executable`. Cualquier otro nombre de comando (`IISExpress`, `Docker`, `DotNetCore`) se omite.
4. Construye el entorno del proceso hijo en tres capas. Primero, el entorno heredado del proceso `dotnet`. Luego `DOTNET_LAUNCH_PROFILE`, además de `ASPNETCORE_URLS` a partir de `applicationUrl` para los perfiles Project, y cada entrada de `environmentVariables`. Por último, cualquier `-e KEY=VALUE` de la línea de comandos. Las capas posteriores ganan.

El paso 4 es la razón por la que falla el caso anidado. El `dotnet run` externo coloca tus valores en la capa uno del `dotnet run` interno, y la capa dos del comando interno los reemplaza. Nada en el proceso interno sabe que fue iniciado desde un perfil de lanzamiento. Toda solución consiste en lograr que el paso 1 o el paso 3 del comando interno se comporte como necesitas.

## Reproducción mínima

Una aplicación de consola que imprime lo que realmente recibió:

```csharp
// .NET 10, C# 14 - Program.cs (ImplicitUsings enabled)
Console.WriteLine($"MY_MODE={Environment.GetEnvironmentVariable("MY_MODE") ?? "<null>"} " +
                  $"DOTNET_ENVIRONMENT={Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "<null>"} " +
                  $"DOTNET_LAUNCH_PROFILE={Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE") ?? "<null>"} " +
                  $"args=[{string.Join(",", args)}] cwd={Environment.CurrentDirectory}");
```

Y un `Properties/launchSettings.json` con un perfil Project normal primero, y luego tres perfiles Executable:

```json
{
  "profiles": {
    "Default": {
      "commandName": "Project",
      "environmentVariables": { "MY_MODE": "from-Default", "DOTNET_ENVIRONMENT": "Production" }
    },
    "Exe": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "bin/Debug/net10.0/app.dll hello",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Exe", "DOTNET_ENVIRONMENT": "Development" }
    },
    "ExeDotnetRun": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "run --no-build",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-ExeDotnetRun", "DOTNET_ENVIRONMENT": "Development" }
    },
    "Watch": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "watch run --non-interactive",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
    }
  }
}
```

Al ejecutar `dotnet run --no-build --launch-profile <name>` con cada SDK se imprimió esto:

| Perfil | 10.0.112 | 10.0.302 / 10.0.401 / 11.0.100-rc.1 |
| --- | --- | --- |
| `Default` (Project) | `from-Default` | `from-Default` |
| `Exe` (ejecuta `app.dll`) | advertencia "not supported", `<null>` | `from-Exe`, `Development`, args `[hello]` |
| `ExeDotnetRun` | advertencia "not supported", `<null>` | `from-Default`, `Production` |
| `Watch` | advertencia "not supported", `<null>` | `from-Default`, `Production` (10.0.302) |

La fila `Exe` muestra que la compatibilidad con perfiles Executable funciona en los SDK modernos. Las filas `ExeDotnetRun` y `Watch` muestran la sobrescritura: el comando interno reporta `DOTNET_LAUNCH_PROFILE=Default`, lo que significa que tomó por su cuenta el primer perfil.

## La solución, paso a paso

1. **Revisa el SDK.** Ejecuta `dotnet --version` en el directorio del proyecto, porque `global.json` puede fijar una banda anterior. Necesitas 10.0.200 o posterior para que `dotnet run` y `dotnet watch` respeten los perfiles Executable. En 10.0.1xx, mantén las variables en un perfil `Project`.
2. **Evita que el comando anidado elija un perfil.** Si `executablePath` es `dotnet` y los argumentos comienzan con `run` o `watch`, agrega `--no-launch-profile`:

   ```json
   // .NET SDK 10.0.200+ - Properties/launchSettings.json
   "Watch": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "watch run --non-interactive --no-launch-profile",
     "workingDirectory": "..",
     "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
   }
   ```

   Con ese cambio, la aplicación imprimió `MY_MODE=from-WatchNoProfile DOTNET_ENVIRONMENT=Development` bajo `dotnet watch` en 10.0.302. `DOTNET_LAUNCH_PROFILE` sigue mostrando el nombre del perfil externo, porque el `dotnet run` externo lo estableció y nada lo sobrescribió.

3. **O apunta el comando anidado a un perfil específico.** Si las variables ya viven en un perfil Project, haz referencia a él en lugar de duplicarlas:

   ```json
   // .NET SDK 10.0.200+
   "ExeDotnetRunPinned": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "run --no-build --launch-profile Dev",
     "workingDirectory": ".."
   }
   ```

   Esto imprimió `MY_MODE=from-Dev DOTNET_ENVIRONMENT=Development DOTNET_LAUNCH_PROFILE=Dev`. En esta configuración, el perfil interno es el dueño de las variables. Todo lo que pongas en las `environmentVariables` del perfil externo pierde cuando ambos perfiles establecen la misma clave.

4. **En VS Code, mueve las variables a `launch.json`.** La extensión de C# solo lee perfiles Project y únicamente sus `environmentVariables`, `applicationUrl` y `commandLineArgs`. En su lugar, coloca un bloque `env` en una configuración de lanzamiento `coreclr`. De todos modos, los valores de `launch.json` tienen prioridad sobre `launchSettings.json`.

## Detalles y casos similares

**Un perfil Executable listado primero se convierte en el predeterminado y puede bifurcarse para siempre.** En 10.0.200+, el perfil predeterminado es el primero cuyo `commandName` es `Project` *o* `Executable` (`IsDefaultProfileType` en [`LaunchSettings.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Microsoft.DotNet.ProjectTools/LaunchSettings/LaunchSettings.cs), y la misma regla en `dotnet watch`). Si pones `"commandLineArgs": "run --no-build"` en el primer perfil y ejecutas un `dotnet run` simple, cada proceso hijo selecciona de nuevo el mismo perfil. En 10.0.302 conté 53 procesos `dotnet run` después de 12 segundos, antes de terminarlos. La solución con `--no-launch-profile` de arriba también rompe el ciclo. Mantener un perfil Project al inicio del archivo es un seguro barato.

**`dotnet run -e` tampoco sobrevive al salto anidado.** Revisé `dotnet run -e KEY=VALUE` en el SDK 10.0.112 y posteriores (consulta [`dotnet run -e`](/es/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)). Sobrescribe el perfil para el proceso que inicia el `dotnet run` externo. Cuando ese proceso es otro `dotnet run`, el perfil predeterminado interno también lo sobrescribe: `-lp ExeDotnetRun -e MY_MODE=from-cli` siguió imprimiendo `from-Default`. Lo mismo aplica a un export simple del shell. `MY_MODE=from-shell dotnet run -lp Default` imprime `from-Default`, porque los valores del perfil de lanzamiento siempre le ganan a los heredados.

**`%VAR%` se expande, `$(Property)` no (todavía).** La CLI pasa cada valor por `Environment.ExpandEnvironmentVariables`, así que `%HOME%` funciona también en macOS y Linux. `$(HOME)` y `${HOME}` pasan literalmente. Las propiedades de MSBuild como `$(TargetPath)` o `$(ProjectDir)` no se expanden en ningún SDK publicado que probé (10.0.302, 10.0.401, 11.0.100-rc.1). En lugar de una variable ignorada en silencio, obtienes `An error occurred trying to start process '$(TargetPath)' ... No such file or directory`. El `ProjectLaunchTargetsProvider` de Visual Studio sí las expande (según la [documentación de perfiles de lanzamiento de project-system](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)), por eso un perfil copiado de una configuración de VS falla en la CLI. [dotnet/sdk#56074](https://github.com/dotnet/sdk/pull/56074) agrega la expansión. Se fusionó en `main` el 4 de septiembre de 2026, pero a día de hoy no está en `release/11.0.1xx-rc2` ni en ninguna banda de 10.0. Hasta que se publique, usa rutas relativas.

**`workingDirectory` es relativo a la carpeta `Properties`, no al proyecto.** La CLI lo resuelve con `Path.Combine(Path.GetDirectoryName(launchSettingsPath), value)`, así que `".."` significa el directorio del proyecto. Visual Studio y Rider lo resuelven de forma distinta, algo que [dotnet/sdk#56129](https://github.com/dotnet/sdk/pull/56129) está discutiendo actualmente. Para los perfiles Project, la CLI ignora por completo `workingDirectory` en los SDK actuales.

**Hay una corrección para el caso anidado en revisión.** [dotnet/sdk#56087](https://github.com/dotnet/sdk/pull/56087) hace que `dotnet run` establezca un marcador `DOTNET_LAUNCH_PROFILE_APPLIED=1` en los procesos que inicia desde un perfil Executable. Entonces, un `dotnet run` anidado sin un perfil explícito omite el perfil predeterminado. Seguía abierta el 30 de septiembre de 2026. Incluso cuando se publique, solo cubre los perfiles iniciados a través de la CLI. El PR señala que los IDE que inician el perfil Executable directamente siguen necesitando `--no-launch-profile`.

**`hotReloadEnabled` en un perfil Project no hace nada en `dotnet run`.** El autor del reporte #56023 también lo notó. Hot reload viene de `dotnet watch`, no de una propiedad del perfil. Esa es exactamente la razón por la que la gente envuelve `dotnet watch` en un perfil Executable. Consulta [en qué se diferencia `dotnet watch` de `dotnet run`](/es/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) para ver qué agrega el observador.

## Relacionado

- [.NET 11 Preview 3: dotnet run -e establece variables de entorno sin perfiles de lanzamiento](/es/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [¿Cuál es la diferencia entre dotnet watch y dotnet run?](/es/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)
- [Solución: el WebSocket de hot reload de Blazor con dotnet watch falla en un dominio local personalizado](/es/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/), otro caso en el que las variables del perfil de lanzamiento no llegan al proceso que esperas
- [Cómo ejecutar una aplicación C# basada en archivo con `dotnet run app.cs`](/es/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), que lee perfiles de lanzamiento `<app>.run.json` a través del mismo código
- [Cómo agregar Aspire a una solución ASP.NET Core existente](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), donde el perfil de lanzamiento propio del AppHost decide qué entorno recibe cada servicio

## Fuentes

- [dotnet/sdk#56023: `launchSettings.json` environment variables are not propagated for `commandName: Executable`](https://github.com/dotnet/sdk/issues/56023)
- [dotnet/sdk#51727: Add Executable launch profile support to dotnet run and dotnet watch](https://github.com/dotnet/sdk/pull/51727)
- [dotnet/sdk#56087: Preserve Executable launch profile environment in nested dotnet run](https://github.com/dotnet/sdk/pull/56087)
- [dotnet/sdk#56074: Expand MSBuild properties across launch profiles](https://github.com/dotnet/sdk/pull/56074)
- [dotnet/sdk#49131: Allow `dotnet run` to use launch profiles with `commandName: Executable`](https://github.com/dotnet/sdk/issues/49131)
- [dotnet/project-system: launch profiles documentation](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)
- [VS Code C# debugger settings: launchSettings.json support](https://code.visualstudio.com/docs/csharp/debugger-settings)
- [`dotnet run` command reference on Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)
