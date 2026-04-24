---
title: "EF Core 11 Preview 3 agrega RemoveDbContext para swaps limpios de provider en tests"
description: "EF Core 11 Preview 3 introduce RemoveDbContext, RemoveExtension, y una sobrecarga sin parámetros de AddPooledDbContextFactory, eliminando el boilerplate para cambiar providers en tests y centralizando la configuración de pooled factory."
pubDate: 2026-04-23
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "testing"
  - "dependency-injection"
lang: "es"
translationOf: "2026/04/efcore-11-removedbcontext-pooled-factory-test-swap"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 Preview 3 arregla discretamente una de las molestias más antiguas en los tests de integración con EF Core: la necesidad de deshacer la llamada `AddDbContext` del proyecto padre antes de registrar un provider diferente. La release introduce los helpers `RemoveDbContext<TContext>()` y `RemoveExtension<TExtension>()`, más una sobrecarga sin parámetros para `AddPooledDbContextFactory<TContext>()` que reutiliza la configuración declarada dentro del propio context.

## El viejo baile del swap en tests

Si tu composition root en `Startup` o `Program.cs` registra un context de SQL Server, el proyecto de tests de integración normalmente necesita sobrescribirlo. Hasta ahora, hacerlo limpiamente requería o bien reestructurar el registro de producción en un método de extensión que tomara un delegate de configuración, o recorrer manualmente `IServiceCollection` y remover cada `ServiceDescriptor` que EF Core hubiera registrado. Esa segunda ruta es frágil, porque depende del conjunto exacto de servicios internos que EF Core cablea para un provider dado.

```csharp
// EF Core 10 and earlier: manual cleanup before swapping providers
services.RemoveAll<DbContextOptions<AppDbContext>>();
services.RemoveAll(typeof(AppDbContext));
services.RemoveAll(typeof(IDbContextOptionsConfiguration<AppDbContext>));
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

Tenías que saber qué tipos de descriptor fregar, y cualquier cambio en cómo EF Core cablea su pipeline de options podía romper el setup de tests en silencio.

## Qué hace realmente `RemoveDbContext`

En Preview 3 el mismo swap se colapsa a dos líneas:

```csharp
services.RemoveDbContext<AppDbContext>();
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

`RemoveDbContext<TContext>()` quita el registro del context, el `DbContextOptions<TContext>` enlazado, y los callbacks de configuración que EF Core ha acumulado para ese context. También hay un `RemoveExtension<TExtension>()` más quirúrgico para el caso donde quieres mantener la mayor parte de la configuración intacta pero soltar una única options extension, por ejemplo removiendo la retry strategy de SQL Server sin reconstruir todo el pipeline.

## Pooled factories sin duplicar configuración

El segundo cambio apunta a `AddPooledDbContextFactory<TContext>()`. Anteriormente la llamada requería un delegate de options, incluso cuando el context ya sobrescribía `OnConfiguring` o había registrado su configuración a través de `ConfigureDbContext<TContext>()`. Preview 3 agrega una sobrecarga sin parámetros, así que un context que ya sabe cómo configurarse a sí mismo puede exponerse como pooled factory en una línea:

```csharp
services.ConfigureDbContext<AppDbContext>(o =>
    o.UseSqlServer(connectionString));

services.AddPooledDbContextFactory<AppDbContext>();
```

Combinados, los dos cambios hacen trivial tomar un registro de producción, quitarle el provider, y re-agregar el mismo context como pooled factory apuntando a un store diferente, que es exactamente la forma que la mayoría de los fixtures de tests multi-tenant ya querían.

## Dónde leer más

Las notas completas viven en las [release notes de EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md), y el anuncio está en el [post de .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/). Si mantienes una clase base de test fixture que hace el baile manual de `RemoveAll`, este es el momento para borrarla.
