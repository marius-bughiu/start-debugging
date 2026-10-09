---
title: "Semantic Kernel 1.81 evita que FileIOPlugin filtre archivos fuera de AllowedFolders"
description: "Semantic Kernel .NET 1.81.0 corrige un oráculo en FileIOPlugin: WriteAsync le decía al modelo que un archivo fuera de AllowedFolders existía, era de solo lectura y dónde estaba. Medido antes y después."
pubDate: 2026-10-09
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "es"
translationOf: "2026/10/semantic-kernel-1-81-fileioplugin-no-longer-leaks-paths-outside-allowedfolders"
translatedBy: "claude"
translationDate: 2026-10-09
---

Semantic Kernel .NET [1.81.0](https://github.com/microsoft/semantic-kernel/releases/tag/dotnet-1.81.0) salió el 6 de octubre de 2026, con `Microsoft.SemanticKernel.Plugins.Core` 1.81.0-preview en NuGet el mismo día. Las notas de la versión describen el [PR #14525](https://github.com/microsoft/semantic-kernel/pull/14525) como "Update file handling for FileIOPlugin", lo cual se queda corto. Hasta la 1.80.1, `FileIOPlugin.WriteAsync` comprobaba si un archivo era de solo lectura *antes* de comprobar `AllowedFolders`, y la excepción que lanzaba incluía la ruta canónica completa. Si expones este plugin a un modelo, eso es un oráculo de existencia de archivos para todo el disco.

Es la segunda pasada seguida de endurecimiento de archivos y red, después de que [la 1.80.0 hiciera que los plugins OpenAPI dejaran de seguir redirecciones](/es/2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects/).

## Lo que el modelo podía averiguar en la 1.80.1

Ejecuté la misma prueba basada en archivos contra ambas versiones en el SDK 10.0.302. Crea un `secrets.txt` de solo lectura fuera de la carpeta permitida, un `nope.txt` inexistente junto a él y un `locked.txt` de solo lectura dentro de la carpeta permitida, y luego llama a `WriteAsync` sobre cada uno:

```csharp
#:package Microsoft.SemanticKernel.Plugins.Core@1.80.1-preview
#:property PublishAot=false
#:property NoWarn=SKEXP0050
using Microsoft.SemanticKernel.Plugins.Core;

// allowed, readOnlyOutside, missingOutside, readOnlyInside: temp paths set up earlier
var plugin = new FileIOPlugin { AllowedFolders = [allowed], DisableFileOverwrite = false };

foreach (var f in new[] { readOnlyOutside, missingOutside, readOnlyInside })
{
    try { await plugin.WriteAsync(f, "y"); }
    catch (Exception e) { Console.WriteLine($"{Path.GetFileName(f)}: {e.GetType().Name}: {e.Message}"); }
}
```

Salida en 1.80.1-preview (ruta temporal acortada):

```text
secrets.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/outside/secrets.txt
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/allowed/locked.txt
```

Las dos primeras líneas son el problema. Un archivo fuera del sandbox recibe una excepción distinta a la de uno inexistente, así que la existencia es observable. Lo mismo ocurre con un `new FileIOPlugin()` por defecto cuyo `AllowedFolders` está vacío, la configuración documentada como "no se permite ninguna carpeta".

Ese mensaje sí llega al modelo. Con la llamada automática a funciones, `FunctionCallsProcessor` captura la excepción y devuelve `Error: Exception while invoking function. {e.Message}` como resultado de la herramienta. Un agente con inyección de prompt puede sondear rutas del estilo de `~/.ssh/id_rsa` o `/etc/shadow` y leer la respuesta.

## Qué cambia en la 1.81.0

`TryGetAllowedFilePath` ahora devuelve `false` de inmediato cuando no hay carpetas configuradas, envuelve la canonicalización de rutas en un catch para `IOException`, `UnauthorizedAccessException`, `InvalidOperationException` y `SecurityException` (de modo que los bucles de enlaces simbólicos y los errores de permisos se convierten en una simple denegación), y solo ejecuta la comprobación de solo lectura después de que la ruta coincida con una carpeta permitida. La excepción de solo lectura también perdió la ruta. La misma prueba en 1.81.0-preview:

```text
secrets.txt: InvalidOperationException: Writing to the provided location is not allowed.
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only.
```

Fuera del sandbox, todos los casos son ahora indistinguibles. Dentro, sigues recibiendo un error útil, sin la ruta. El [PR #14476](https://github.com/microsoft/semantic-kernel/pull/14476), también en la 1.81.0, aplica la misma alineación de validación a `DocumentPlugin` y `CloudDrivePlugin`.

## Qué hacer

Actualiza `Microsoft.SemanticKernel.Plugins.Core` a `1.81.0-preview` si algún agente puede llamar a `FileIOPlugin`. La API pública no cambia, así que es solo un cambio de versión. Si envuelves herramientas de archivos propias, copia el patrón: comprueba primero el sandbox, haz que cada denegación devuelva el mismo mensaje y nunca pongas una ruta resuelta en una excepción que el resultado de una herramienta pueda llevar de vuelta al modelo.
