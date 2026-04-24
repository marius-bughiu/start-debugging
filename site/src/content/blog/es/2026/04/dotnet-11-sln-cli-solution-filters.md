---
title: "dotnet sln por fin edita filtros de solución desde la CLI en .NET 11 Preview 3"
description: ".NET 11 Preview 3 le enseña a dotnet sln a crear, añadir, remover y listar proyectos en filtros de solución .slnf, así los mono-repos grandes pueden cargar un subconjunto sin abrir Visual Studio."
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "sdk"
  - "dotnet-cli"
  - "msbuild"
lang: "es"
translationOf: "2026/04/dotnet-11-sln-cli-solution-filters"
translatedBy: "claude"
translationDate: 2026-04-24
---

Los filtros de solución (`.slnf`) existen desde Visual Studio 2019, pero editarlos fuera del IDE significaba escribir JSON a mano. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) lo arregla: `dotnet sln` ahora crea, edita y lista los contenidos de archivos `.slnf` directamente, vía [dotnet/sdk #51156](https://github.com/dotnet/sdk/pull/51156). Para repositorios grandes esta es la diferencia entre abrir un subconjunto de veinte proyectos desde el terminal y mantener un shell script que trastea el JSON a mano.

## Qué es realmente un filtro de solución

Un `.slnf` es un puntero JSON a un `.sln` padre más una lista de rutas de proyectos. Cuando una herramienta carga el filtro, descarga todo proyecto en la solución padre que no está en la lista. Eso mantiene los grafos de build, analyzers e IntelliSense enfocados en el subconjunto que te importa, que es la principal palanca que las code bases grandes tienen para mantener los tiempos de carga del IDE sanos. Hasta Preview 3 la CLI podía felizmente `build` un filtro pero no editar uno.

## Los nuevos comandos

La superficie refleja los verbos existentes de `dotnet sln`. Puedes crear un filtro, añadir y remover proyectos, y listar qué está incluido actualmente:

```bash
# Create a filter that points at the current .sln
dotnet new slnf --name MyApp.slnf

# Target a specific parent solution
dotnet new slnf --name MyApp.slnf --solution-file ./MyApp.sln

# Add and remove projects
dotnet sln MyApp.slnf add src/Lib/Lib.csproj
dotnet sln MyApp.slnf add src/Api/Api.csproj src/Web/Web.csproj
dotnet sln MyApp.slnf remove src/Lib/Lib.csproj

# Inspect what the filter currently loads
dotnet sln MyApp.slnf list
```

Los comandos aceptan las mismas formas de glob y multi-argumento que `dotnet sln` ya soporta para archivos `.sln`, y escriben JSON `.slnf` que coincide con lo que emite Visual Studio, así que un filtro que edites desde la CLI abre limpiamente en el IDE.

## Por qué esto importa para los mono-repos

Dos flujos de trabajo se vuelven mucho más baratos. El primero es CI: un pipeline puede checkout el repo completo pero buildear solo el filtro relevante a las rutas cambiadas. Antes de Preview 3 la mayoría de los equipos hacían esto con un script custom que escribía JSON o mantenían archivos `.slnf` mantenidos a mano junto al `.sln`. Ahora el mismo pipeline puede regenerar filtros al vuelo:

```bash
dotnet new slnf --name ci-api.slnf --solution-file MonoRepo.sln
dotnet sln ci-api.slnf add \
  src/Api/**/*.csproj \
  src/Shared/**/*.csproj \
  test/Api/**/*.csproj

dotnet build ci-api.slnf -c Release
```

El segundo es el desarrollo local. Los repos grandes a menudo envían un puñado de filtros "starter" para que una ingeniera nueva pueda abrir el backend sin esperar a que carguen los proyectos de mobile y docs. Mantener esos filtros precisos solía requerir abrir cada uno en Visual Studio después de un movimiento de proyecto, porque los renombrados `.sln` no actualizaban `.slnf` automáticamente. Con los nuevos comandos la actualización es un one-liner:

```bash
dotnet sln backend.slnf remove src/Legacy/OldService.csproj
dotnet sln backend.slnf add src/Services/NewService.csproj
```

## Una pequeña nota sobre rutas

`dotnet sln` resuelve rutas de proyecto relativas al filtro, no al llamador, lo que coincide con cómo las lee el IDE. Si el `.slnf` vive en `build/filters/` y apunta a proyectos bajo `src/`, la ruta almacenada será `..\..\src\Foo\Foo.csproj`, y `dotnet sln list` la muestra de la misma forma. Vale la pena recordarlo cuando scripteas ediciones de filtros desde un directorio de trabajo distinto.

Combinado con [`dotnet run -e` para variables de entorno inline](https://github.com/dotnet/sdk/pull/52664) y las [migraciones de EF Core en un solo paso anteriores](https://startdebugging.net/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), Preview 3 sigue picando al conjunto de "tengo que abrir Visual Studio para hacer esto". La lista completa está en las [notas del SDK de .NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md).
