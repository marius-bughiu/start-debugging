---
title: "Как использовать Native AOT с минимальными API ASP.NET Core"
description: "Minimal API для Native AOT с генерируемыми метаданными JSON. Выбор builder, инструменты публикации, предупреждения и ограничения функций."
pubDate: 2026-04-27
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "ru"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Native AOT компилирует приложение в машинный код при публикации. Время запуска, размер и расход памяти могут измениться, но результат зависит от приложения и платформы. Не все функции ASP.NET Core и зависимости становятся совместимыми автоматически.

**Исправление — 2 ноября 2026 года:** прежний текст объявлял `CreateSlimBuilder` обязательным, исключал все серверы SignalR, связывал генерацию с `Program.cs` и преувеличивал ограничения JSON и глобализации. Новый пример ориентирован на .NET 10; выполнение на .NET 11 не заявляется.

## Приложение с явными метаданными JSON

Создайте проект `MyApi` с таким файлом проекта:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Используйте следующий `Program.cs`:

```csharp
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));

var app = builder.Build();
app.MapGet("/todos", () => TypedResults.Ok(new[] { new Todo(1, "Write docs", false) }));
app.MapPost("/todos", (Todo todo) => TypedResults.Ok(todo));
app.Run();

public record Todo(int Id, string Title, bool IsComplete);

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

`PublishAot` включает анализ AOT и генерацию делегатов запросов в этом проекте Web SDK. Контекст JSON предоставляет метаданные используемых корневых типов. Добавляйте другие корни и полиморфные типы согласно контрактам: регистрация `object` не охватывает любой тип времени выполнения.

Генератор обрабатывает исходные файлы проекта. Перенос расширения маршрутов из `Program.cs` сам по себе не вызывает несовместимость. Отдельной библиотеке нужны подходящие ссылки ASP.NET Core и поддержка генератора; одной настройки недостаточно для произвольного кода.

## Публикация для конкретной платформы

```sh
# Use the RID and native toolchain for your deployment target.
# This command is for an Apple Silicon Mac:
dotnet publish -c Release -r osx-arm64 -o ./publish
./publish/MyApi --urls http://127.0.0.1:5080
# Replace MyApi with your project's executable name.
```

Установите требуемую нативную цепочку инструментов. Публикация Native AOT для другой ОС в общем случае не поддерживается; используйте подходящий хост или контейнер. Самодостаточность означает отсутствие необходимости отдельно устанавливать управляемый runtime, а не полную статическую линковку или независимость от системных библиотек.

Запустите опубликованный файл и проверьте конечные точки, сериализацию, аутентификацию и ошибки. Обычный `dotnet run` использует JIT и не заменяет такую проверку. Разберите все предупреждения trimming и AOT. Они не останавливают публикацию автоматически без настройки предупреждений как ошибок. `IL2026` касается требований trimming, `IL3050` — динамического кода. Атрибуты вроде `RequiresDynamicCode` передают требования вызывающему коду, но не исправляют несовместимость.

## Builder, JSON и глобализация

`CreateSlimBuilder` включает меньше функций по умолчанию и удобен как основа, но не обязателен. `CreateBuilder` допустим при совместимых функциях и зависимостях. Slim builder по умолчанию не настраивает HTTPS и HTTP/3: добавьте поддержку Kestrel либо завершайте TLS на доверенном прокси. Одной конфигурации конечных точек недостаточно для добавления отсутствующего протокола.

Регистрация генерируемого resolver сама по себе не отключает отражение во всех режимах выполнения. Native AOT нужны подходящие метаданные; неизвестные JSON-типы могут вызвать ошибку. `Results.Json(value)` и `ReadFromJsonAsync<T>()` могут использовать настроенные параметры и генерируемые метаданные, поэтому не запрещены сами по себе. Перегрузки с `JsonTypeInfo<T>` явно задают контракт в месте вызова.

`InvariantGlobalization` меняет поведение приложения, а не управляет предупреждениями AOT. Для культурозависимых операций сохраните поддержку и обеспечьте зависимости платформы. Не включайте инвариантный режим только ради подавления предупреждений и не рассчитывайте на сохранение всей культурной семантики.

## Проверка поддержки по версии

MVC-контроллеры и Razor Pages не являются общей возможностью Native AOT в документированной матрице. SignalR отличается: .NET 9 добавил поддержку клиентских и серверных сценариев с описанными ограничениями и требованиями генерации JSON. Не переносите старый полный запрет на новые версии.

Доступ к данным требует проверки конкретного провайдера. AOT в EF Core зависит от версии и обработки запросов; обычный Dapper не становится безопасным только благодаря меньшему размеру. Публикуйте и проверяйте точные зависимости будущего развёртывания.

Для организации совместимых обработчиков см. [модули ресурсов с MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Источники

- [ASP.NET Core Native AOT support](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [.NET Native AOT deployment and prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [.NET 9 SignalR Native AOT support and limitations](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-9.0?view=aspnetcore-9.0#signalr-supports-trimming-and-native-aot)
