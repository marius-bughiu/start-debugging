---
title: "EF Core 11 Preview 3 добавляет RemoveDbContext для чистых свопов провайдера в тестах"
description: "EF Core 11 Preview 3 вводит RemoveDbContext, RemoveExtension и безпараметровую перегрузку AddPooledDbContextFactory, убирая boilerplate вокруг смены провайдеров в тестах и централизуя конфигурацию pooled factory."
pubDate: 2026-04-23
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "testing"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/04/efcore-11-removedbcontext-pooled-factory-test-swap"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 Preview 3 тихо чинит один из самых давних раздражителей в интеграционном тестировании с EF Core: необходимость отменять вызов `AddDbContext` родительского проекта, прежде чем регистрировать другой провайдер. Релиз вводит хелперы `RemoveDbContext<TContext>()` и `RemoveExtension<TExtension>()`, плюс безпараметровую перегрузку `AddPooledDbContextFactory<TContext>()`, которая переиспользует конфигурацию, объявленную внутри самого context.

## Старый тестовый своп-танец

Если ваш composition root в `Startup` или `Program.cs` регистрирует SQL Server context, проект интеграционных тестов обычно должен это переопределить. До сих пор сделать это чисто требовало либо реструктурировать продовую регистрацию в extension-метод, принимающий configuration delegate, либо вручную обходить `IServiceCollection` и удалять каждый `ServiceDescriptor`, который EF Core зарегистрировал. Второй путь хрупок, потому что зависит от точного набора внутренних сервисов, которые EF Core разводит для данного провайдера.

```csharp
// EF Core 10 and earlier: manual cleanup before swapping providers
services.RemoveAll<DbContextOptions<AppDbContext>>();
services.RemoveAll(typeof(AppDbContext));
services.RemoveAll(typeof(IDbContextOptionsConfiguration<AppDbContext>));
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

Нужно было знать, какие типы descriptor драить, и любое изменение в том, как EF Core разводит свой options-пайплайн, могло молча сломать тестовый setup.

## Что на самом деле делает `RemoveDbContext`

В Preview 3 тот же своп сжимается до двух строк:

```csharp
services.RemoveDbContext<AppDbContext>();
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

`RemoveDbContext<TContext>()` снимает регистрацию context, привязанный `DbContextOptions<TContext>` и configuration callbacks, которые EF Core накопил для этого context. Есть также более хирургический `RemoveExtension<TExtension>()` для случая, когда вы хотите оставить большую часть конфигурации нетронутой, но уронить одну options extension, например убрать retry strategy SQL Server без пересборки всего пайплайна.

## Pooled factory без дублирования конфигурации

Вторая смена целится в `AddPooledDbContextFactory<TContext>()`. Раньше вызов требовал options delegate, даже когда context уже переопределял `OnConfiguring` или зарегистрировал свою конфигурацию через `ConfigureDbContext<TContext>()`. Preview 3 добавляет безпараметровую перегрузку, так что context, который уже знает, как себя настраивать, можно выставить как pooled factory одной строкой:

```csharp
services.ConfigureDbContext<AppDbContext>(o =>
    o.UseSqlServer(connectionString));

services.AddPooledDbContextFactory<AppDbContext>();
```

В сочетании, эти два изменения делают тривиальным взять продовую регистрацию, убрать провайдер и заново добавить тот же context как pooled factory, указывающий на другой store - ровно ту форму, которую большинство multi-tenant тестовых fixtures и так хотели.

## Где почитать больше

Полные заметки живут в [release notes EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md), а анонс - в [посте .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/). Если поддерживаете base-класс test fixture, который делает ручной `RemoveAll`-танец, это момент удалить его.
