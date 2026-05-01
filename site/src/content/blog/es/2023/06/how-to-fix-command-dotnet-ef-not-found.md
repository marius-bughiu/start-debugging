---
title: "Cómo solucionar: dotnet ef not found (dotnet-ef does not exist)"
description: "Soluciona el error 'dotnet-ef does not exist' / 'dotnet ef command not found' instalando la CLI de EF Core como herramienta global o local de .NET."
pubDate: 2023-06-11
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "entity-framework"
lang: "es"
translationOf: "2023/06/how-to-fix-command-dotnet-ef-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Could not execute because the specified command or file was not found.  
> Possible reasons for this include:  
> -- You misspelled a built-in dotnet command.  
> -- You intended to execute a .NET Core program, but dotnet-ef does not exist.  
> -- You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.

La causa más probable de este mensaje de error es que no tengas la herramienta **dotnet ef** instalada.

A partir de ASP.NET Core 3, la herramienta de comando **dotnet ef** ya no forma parte del SDK de .NET Core. Este cambio permite al equipo distribuir dotnet ef como una herramienta normal de la CLI de .NET, que puede instalarse como herramienta global o local. Esto es válido para todas las distribuciones, ya sea que trabajes con Visual Studio en Windows o uses `dotnet` en Mac o Ubuntu Linux.

Por ejemplo, para poder gestionar migraciones o generar un **DbContext**, instala **dotnet ef** como herramienta global escribiendo el siguiente comando:

```shell
dotnet tool install --global dotnet-ef
```

Si quieres instalar una versión específica, puedes indicar el parámetro **--version**. Por ejemplo:

```shell
dotnet tool install --global dotnet-ef --version 3.*
dotnet tool install --global dotnet-ef --version 5.*
dotnet tool install --global dotnet-ef --version 6.*
dotnet tool install --global dotnet-ef --version 7.*
dotnet tool install --global dotnet-ef --version 8.*
```

## Desinstalar dotnet-ef

Si terminaste de usar la herramienta y quieres desinstalar `dotnet-ef`, puedes hacerlo con el comando `dotnet tool uninstall`.

```shell
dotnet tool uninstall dotnet-ef --global
```
