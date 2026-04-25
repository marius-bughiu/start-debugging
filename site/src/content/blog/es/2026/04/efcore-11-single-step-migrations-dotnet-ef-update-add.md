---
title: "EF Core 11 te permite crear y aplicar una migración en un solo comando"
description: "El comando dotnet ef database update ahora acepta --add para crear y aplicar una migración en un solo paso. Aquí está cómo funciona, por qué importa para contenedores y .NET Aspire, y qué tener en cuenta."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add"
translatedBy: "claude"
translationDate: 2026-04-25
---

Si alguna vez has alternado entre `dotnet ef migrations add` y `dotnet ef database update` docenas de veces durante una sesión de prototipado, EF Core 11 Preview 2 tiene una pequeña victoria de calidad de vida: el flag `--add` en `database update`.

## Un comando en lugar de dos

El nuevo flujo colapsa el baile de dos pasos en una sola invocación:

```bash
dotnet ef database update InitialCreate --add
```

Ese comando crea una migración llamada `InitialCreate`, la compila con Roslyn en tiempo de ejecución, y la aplica a la base de datos. Los archivos de migración aún aterrizan en disco, así que terminan en control de fuente como cualquier otra migración.

Si necesitas personalizar el directorio de salida o el namespace, las mismas opciones de `migrations add` se transfieren:

```bash
dotnet ef database update AddProducts --add \
  --output-dir Migrations/Products \
  --namespace MyApp.Migrations
```

Los usuarios de PowerShell obtienen el switch equivalente `-Add` en `Update-Database`:

```powershell
Update-Database -Migration InitialCreate -Add
```

## Por qué importa la compilación en tiempo de ejecución

La verdadera recompensa no es ahorrar algunas pulsaciones de teclas en el desarrollo local. Es habilitar flujos de trabajo de migración en entornos donde la recompilación no es una opción.

Piensa en la orquestación de .NET Aspire o pipelines de CI contenerizados: el proyecto compilado ya está horneado en la imagen. Sin `--add`, necesitarías un paso de build separado solo para crear una migración, recompilar el proyecto, y luego aplicarla. Con la compilación en tiempo de ejecución de Roslyn, el comando `database update` maneja todo el ciclo de vida en su lugar.

## Eliminación offline de migraciones

EF Core 11 también agrega un flag `--offline` a `migrations remove`. Si la base de datos es inalcanzable, o sabes con certeza que la migración nunca se aplicó, puedes saltarte la verificación de conexión por completo:

```bash
dotnet ef migrations remove --offline
```

Ten en cuenta que `--offline` y `--force` son mutuamente excluyentes: `--force` necesita una conexión viva para verificar si la migración fue aplicada antes de revertirla.

Ambos comandos también aceptan un parámetro `--connection` ahora, así puedes apuntar a una base de datos específica sin tocar tu configuración de `DbContext`:

```bash
dotnet ef migrations remove --connection "Server=staging;Database=App;..."
```

## Cuándo recurrir a esto

Para prototipado y desarrollo de inner-loop, `--add` elimina la fricción. Para pipelines de despliegue basados en contenedores, elimina toda una etapa de build. Solo ten en mente que las migraciones compiladas en tiempo de ejecución se saltan tus advertencias normales de build, así que trata los archivos generados como artefactos que aún merecen una revisión antes de llegar a `main`.

Los detalles completos están en los [docs de novedades de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
