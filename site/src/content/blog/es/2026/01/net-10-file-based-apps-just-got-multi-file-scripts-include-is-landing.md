---
title: "Las apps basadas en archivos de .NET 10 ahora soportan scripts multi-archivo: llega `#:include`"
description: ".NET 10 añade soporte para #:include en aplicaciones basadas en archivos, permitiendo que los scripts ejecutados con dotnet run abarquen varios archivos .cs sin crear un proyecto completo."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing"
translatedBy: "claude"
translationDate: 2026-04-30
---
La historia de las "aplicaciones basadas en archivos" de .NET 10 sigue volviéndose más práctica. Un nuevo pull request del SDK añade soporte para `#:include`, lo que significa que `dotnet run foo.cs` ya no tiene que ser "un archivo o nada".

Esto se rastrea en el SDK como "File-based apps: add support for `#:include`" y está pensado para resolver el caso de uso obvio del scripting: dividir el código en un script principal más ayudantes sin crear un proyecto completo.

## Por qué importa el multi-archivo para `dotnet run file.cs`

El dolor es simple. Si tu script crece más allá de un único archivo, tienes dos opciones:

-   Copiar/pegar los ayudantes en el mismo archivo (rápidamente ilegible), o
-   Rendirte y crear un proyecto completo (mata el flujo de "script rápido").

El comportamiento deseado está descrito en el issue del SDK: `dotnet run file.cs` debería poder usar código de un `util.cs` adyacente sin ceremonia adicional.

## Qué cambia con `#:include`

Con `#:include`, el archivo principal puede traer otros archivos `.cs` para que el compilador vea una única unidad de compilación en la ejecución. Es el puente que faltaba entre la "sensación de script" y la "organización real del código".

Esto no es una característica del lenguaje C#; es una capacidad del SDK de .NET para apps basadas en archivos. Eso importa porque puede evolucionar rápidamente en las versiones preliminares de .NET 10 sin esperar a una versión del lenguaje.

## Un script multi-archivo diminuto que puedes ejecutar de verdad

Directorio:

```bash
app\
  file.cs
  util.cs
```

`file.cs`:

```cs
#:include "util.cs"

Console.WriteLine(Util.GetMessage());
```

`util.cs`:

```cs
static class Util
{
    public static string GetMessage() => ".NET 10 file-based apps can include files now.";
}
```

Ejecútalo con un SDK de versión preliminar de .NET 10:

```bash
dotnet run app/file.cs
```

## Dos detalles del mundo real a vigilar

### El caché puede ocultar cambios

Las apps basadas en archivos dependen del caché para que las ejecuciones del bucle interno sean rápidas. Si sospechas que estás viendo salida obsoleta, vuelve a ejecutar con `--no-cache` para forzar una recompilación.

### Los ítems no `.cs` pueden complicar el "camino rápido"

Si estás haciendo apps basadas en archivos con piezas del Web SDK (por ejemplo `.razor` o `.cshtml`), hay un issue abierto sobre la invalidación del caché cuando cambian elementos por defecto distintos de `.cs`. Tenlo presente antes de tratar las apps basadas en archivos como un reemplazo de un proyecto de aplicación real.

Si quieres seguir el despliegue exacto, empieza aquí:

-   PR: [https://github.com/dotnet/sdk/pull/52347](https://github.com/dotnet/sdk/pull/52347)
-   Issue del escenario multi-archivo: [https://github.com/dotnet/sdk/issues/48174](https://github.com/dotnet/sdk/issues/48174)
