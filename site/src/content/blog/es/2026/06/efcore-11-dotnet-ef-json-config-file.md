---
title: "EF Core 11 Preview 4: Deja de reescribir --project y --startup-project con .config/dotnet-ef.json"
description: "EF Core 11 Preview 4 permite que la herramienta dotnet ef lea los valores de opciones predeterminados desde un archivo .config/dotnet-ef.json, para que las soluciones divididas ya no te obliguen a pasar --project y --startup-project en cada comando."
pubDate: 2026-06-01
tags:
  - "ef-core"
  - "dotnet-11"
  - "dotnet-cli"
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2026/06/efcore-11-dotnet-ef-json-config-file"
translatedBy: "claude"
translationDate: 2026-06-01
---

Cualquiera que ejecute migraciones de EF Core en una solución por capas conoce el ritual: el `DbContext` vive en un proyecto de infraestructura, la cadena de conexión y el cableado de DI viven en el proyecto de API, y por eso cada comando `dotnet ef` se convierte en un párrafo. `dotnet ef migrations add AddOrders --project src/App.Infrastructure --startup-project src/App.Api --context AppDbContext`. O lo memorizas, o lo conviertes en un alias, o lo pegas desde un archivo de notas. EF Core 11 Preview 4, lanzado el 12 de mayo de 2026 como parte de [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), por fin te permite anotar esos valores predeterminados una sola vez.

## Un archivo de configuración que la herramienta encuentra subiendo por el árbol

La herramienta de línea de comandos `dotnet ef` ahora lee los valores de opciones predeterminados desde un archivo `.config/dotnet-ef.json`. La búsqueda funciona igual que con `.editorconfig` o `global.json`: la herramienta sube por el árbol de directorios desde tu directorio de trabajo actual y usa el primer archivo que encuentra. Coloca uno en la raíz de la solución y cada comando ejecutado desde cualquier lugar dentro del árbol lo hereda.

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "framework": "net11.0",
  "configuration": "Debug",
  "context": "AppDbContext",
  "runtime": "win-x64",
  "verbose": true,
  "noColor": false,
  "prefixOutput": false
}
```

Con ese archivo en su lugar, el párrafo vuelve a reducirse a lo que siempre debería haber sido:

```console
dotnet ef migrations add AddOrders
dotnet ef database update
```

Las claves admitidas se asignan directamente a los flags conocidos: `project`, `startupProject`, `framework`, `configuration`, `context`, `runtime`, `verbose`, `noColor` y `prefixOutput`. Una cosa que conviene hacer bien: los valores de ruta de `project` y `startupProject` se resuelven en relación con el padre del directorio `.config` que contiene el archivo, no en relación con donde te encuentres al ejecutar el comando. Coloca el archivo en la raíz del repositorio dentro de `.config/`, y las rutas se leen como si se hubieran escrito desde la raíz.

## Los flags explícitos siguen ganando

Esto es un archivo de valores predeterminados, no un archivo de bloqueo. Cualquier opción que pases en la línea de comandos anula el valor del JSON, así que puedes mantener `AppDbContext` como tu predeterminado y aun así ejecutar algo puntual contra un segundo contexto:

```console
dotnet ef migrations add AddAudit --context AuditDbContext
```

Esa precedencia es la razón misma por la que esto es seguro para confirmar. Agrega `.config/dotnet-ef.json` al control de código fuente y cada desarrollador, además de CI, obtiene los mismos valores predeterminados sin que nadie edite un script compartido. El patrón refleja cómo `dotnet tool` ya usa `.config/dotnet-tools.json`, así que la ubicación resultará familiar a cualquiera que use manifiestos de herramientas locales.

Hay un cambio complementario más pequeño en la misma versión preliminar que combina bien con el scripting: la herramienta de EF ahora escribe todos los mensajes de registro y de estado en la salida de error estándar, reservando la salida estándar para el resultado real del comando. Así que `dotnet ef migrations script > schema.sql` te da SQL limpio sin ruido de banner mezclado.

Esto llega junto con el trabajo de ergonomía de tablas temporales tratado en [EF Core 11 Preview 4: las columnas de período de las tablas temporales por fin pueden ser propiedades reales](/2026/05/ef-core-11-temporal-tables-clr-period-properties/). Para el resumen completo, consulta la [sección Archivo de configuración en la documentación de dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#configuration-file) y la [página de novedades de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
