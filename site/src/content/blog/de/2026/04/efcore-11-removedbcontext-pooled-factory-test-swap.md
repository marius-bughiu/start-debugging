---
title: "EF Core 11 Preview 3 bringt RemoveDbContext für saubere Provider-Swaps in Tests"
description: "EF Core 11 Preview 3 führt RemoveDbContext, RemoveExtension und eine parameterlose Überladung von AddPooledDbContextFactory ein - das Boilerplate beim Provider-Wechsel in Tests fällt weg und Pooled-Factory-Konfiguration wird zentralisiert."
pubDate: 2026-04-23
tags:
  - ".NET 11"
  - "EF Core 11"
  - "testing"
  - "dependency injection"
lang: "de"
translationOf: "2026/04/efcore-11-removedbcontext-pooled-factory-test-swap"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 Preview 3 behebt still einen der langjährigsten Ärgernisse im Integrationstesten mit EF Core: die Notwendigkeit, den `AddDbContext`-Aufruf eines übergeordneten Projekts rückgängig zu machen, bevor man einen anderen Provider registriert. Die Release führt die Helfer `RemoveDbContext<TContext>()` und `RemoveExtension<TExtension>()` ein, plus eine parameterlose Überladung für `AddPooledDbContextFactory<TContext>()`, die die im Context selbst deklarierte Konfiguration wiederverwendet.

## Der alte Test-Swap-Tanz

Wenn Ihr Composition Root in `Startup` oder `Program.cs` einen SQL-Server-Context registriert, muss das Integrationstest-Projekt das üblicherweise überschreiben. Bis jetzt erforderte das sauber gemacht entweder, die Produktionsregistrierung in eine Extension-Methode umzubauen, die einen Konfigurations-Delegate annimmt, oder `IServiceCollection` manuell abzulaufen und jeden `ServiceDescriptor`, den EF Core registriert hatte, zu entfernen. Dieser zweite Weg ist spröde, weil er von der exakten Menge interner Services abhängt, die EF Core für einen gegebenen Provider verdrahtet.

```csharp
// EF Core 10 and earlier: manual cleanup before swapping providers
services.RemoveAll<DbContextOptions<AppDbContext>>();
services.RemoveAll(typeof(AppDbContext));
services.RemoveAll(typeof(IDbContextOptionsConfiguration<AppDbContext>));
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

Sie mussten wissen, welche Descriptor-Typen zu schrubben sind, und jede Änderung daran, wie EF Core seine Options-Pipeline verdrahtet, konnte das Test-Setup stillschweigend brechen.

## Was `RemoveDbContext` tatsächlich tut

In Preview 3 kollabiert derselbe Swap auf zwei Zeilen:

```csharp
services.RemoveDbContext<AppDbContext>();
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

`RemoveDbContext<TContext>()` entfernt die Context-Registrierung, das gebundene `DbContextOptions<TContext>` und die Konfigurations-Callbacks, die EF Core für diesen Context angesammelt hat. Es gibt auch ein chirurgischeres `RemoveExtension<TExtension>()` für den Fall, dass Sie die meiste Konfiguration intakt halten, aber eine einzelne Options-Extension fallen lassen wollen, zum Beispiel die SQL-Server-Retry-Strategy entfernen, ohne die ganze Pipeline neu aufzubauen.

## Pooled Factories ohne Konfigurationsduplikat

Die zweite Änderung zielt auf `AddPooledDbContextFactory<TContext>()`. Vorher verlangte der Aufruf einen Options-Delegate, auch wenn der Context `OnConfiguring` bereits überschrieben oder seine Konfiguration über `ConfigureDbContext<TContext>()` registriert hatte. Preview 3 fügt eine parameterlose Überladung hinzu, sodass ein Context, der sich selbst konfigurieren kann, in einer Zeile als Pooled Factory exponiert werden kann:

```csharp
services.ConfigureDbContext<AppDbContext>(o =>
    o.UseSqlServer(connectionString));

services.AddPooledDbContextFactory<AppDbContext>();
```

Kombiniert machen die beiden Änderungen es trivial, eine Produktionsregistrierung zu nehmen, den Provider zu streichen und denselben Context als Pooled Factory erneut hinzuzufügen, der auf einen anderen Store zeigt - genau die Form, die die meisten Multi-Tenant-Test-Fixtures ohnehin wollten.

## Wo Sie mehr lesen

Die vollständigen Notes leben in den [EF Core 11 Preview 3 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md), und die Ankündigung steht im [.NET 11 Preview 3 Post](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/). Wenn Sie eine Test-Fixture-Basisklasse pflegen, die den manuellen `RemoveAll`-Tanz macht, ist das der Moment, sie zu löschen.
