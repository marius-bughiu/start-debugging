---
title: "Как генерировать строго типизированный клиентский код из спецификации OpenAPI в .NET 11"
description: "Используйте Kiota, официальный генератор OpenAPI от Microsoft, для создания fluent-клиента на C# со строгой типизацией из любой спецификации OpenAPI. Пошагово: установка, генерация, подключение к DI в ASP.NET Core и настройка аутентификации."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "aspnet"
  - "openapi"
lang: "ru"
translationOf: "2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

В тот момент, когда API публикует документ OpenAPI, поддержка вручную написанного обёртки `HttpClient` становится проигрышной ставкой. Каждое новое поле, переименованный путь или дополнительный код статуса требует ручного обновления, и спецификация с клиентом молча расходятся. Правильное решение -- инвертировать отношения: рассматривать спецификацию как единственный источник истины и генерировать из неё типы C#.

В .NET 11 каноническим инструментом для этого является [Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview), генератор клиентов на основе OpenAPI от Microsoft. Установите его как .NET-инструмент, направьте на спецификацию, и он создаст fluent-клиент C#, ориентированный на ресурсы, с реальными строго типизированными классами запросов и ответов. Единственный метапакет управляет HTTP, JSON и промежуточным ПО аутентификации. Вся настройка занимает менее десяти минут на чистой спецификации.

## Почему вручную написанные обёртки HttpClient перестают работать

Типичная обёртка, написанная вручную, выглядит так: вы пишете POCO для ответа, добавляете метод в класс сервиса, жёстко кодируете сегмент URL. Повторяете для каждого endpoint. Затем повторяете снова, когда владелец API добавляет новое поле ответа, изменяет имя параметра пути или ужесточает nullable-контракт. Ни одно из этих изменений не вызывает ошибку компилятора. Они проявляются как неожиданности во время выполнения -- исключения нулевой ссылки в продакшене, несоответствующие имена JSON-свойств, которые молча обнуляют значение.

Сгенерированный клиент инвертирует это. Спецификация компилируется непосредственно в типы C#. Если спецификация говорит, что поле `nullable: false`, свойство -- это `string`, а не `string?`. Если спецификация добавляет новый путь, следующий запуск `kiota generate` добавляет метод. Разница в сгенерированных файлах показывает, что именно изменилось в контракте API.

## Kiota vs NSwag: какой генератор выбрать

Два генератора доминируют в .NET-пространстве: NSwag (зрелый, создаёт один монолитный файл класса) и Kiota (более новый, ориентированный на ресурсы, создаёт много небольших сфокусированных файлов).

Kiota строит иерархию путей, отражающую структуру URL. Вызов `GET /repos/{owner}/{repo}/releases` становится `client.Repos["owner"]["repo"].Releases.GetAsync()`. Каждый сегмент пути -- это отдельный класс C#. Это создаёт больше файлов, но делает сгенерированный код навигируемым и допускающим mock на любом уровне пути.

NSwag генерирует один класс с методом на операцию: `GetReposOwnerRepoReleasesAsync(owner, repo)`. Это просто для небольших API, но становится неудобным, когда спецификация имеет сотни путей. Полная спецификация OpenAPI GitHub генерирует файл, приближающийся к 400 000 строк с NSwag.

Kiota -- это то, что Microsoft использует для Microsoft Graph SDK и Azure SDK для .NET. Он был объявлен общедоступным в 2024 году и является генератором, на который ссылаются официальные краткие руководства по документации. Оба инструмента показаны ниже; раздел NSwag охватывает минимальную альтернативу для команд, уже вложившихся в эту цепочку инструментов.

## Шаг 1: Установить Kiota

**Глобальная установка** (самый простой вариант для машины разработчика):

```bash
dotnet tool install --global Microsoft.OpenApi.Kiota
```

**Локальная установка** (рекомендуется для командных проектов -- воспроизводимо на CI-машинах):

```bash
dotnet new tool-manifest   # creates .config/dotnet-tools.json
dotnet tool install Microsoft.OpenApi.Kiota
```

После локальной установки `dotnet tool restore` на любой машине разработчика или CI-задании устанавливает точно зафиксированную версию. Никакого дрейфа версий в команде.

Проверить установку:

```bash
kiota --version
# 1.x.x
```

## Шаг 2: Сгенерировать клиент

```bash
# .NET 11 / Kiota 1.x
kiota generate \
  -l CSharp \
  -c WeatherClient \
  -n MyApp.ApiClient \
  -d ./openapi.yaml \
  -o ./src/ApiClient
```

Ключевые параметры:

| Параметр | Назначение |
|----------|------------|
| `-l CSharp` | Целевой язык. Kiota также поддерживает Go, Java, TypeScript, Python, PHP, Ruby. |
| `-c WeatherClient` | Имя корневого класса клиента. |
| `-n MyApp.ApiClient` | Корневое пространство имён C# для всех сгенерированных файлов. |
| `-d ./openapi.yaml` | Путь или HTTPS URL к документу OpenAPI. Kiota принимает YAML и JSON. |
| `-o ./src/ApiClient` | Выходной каталог. Kiota перезаписывает его при каждом запуске -- не редактируйте сгенерированные файлы вручную. |

Для больших публичных спецификаций (GitHub, Stripe, Azure) добавьте `--include-path`, чтобы ограничить клиент путями, которые вы действительно вызываете:

```bash
# Only generate the /releases subtree from GitHub's spec
kiota generate \
  -l CSharp \
  -c GitHubClient \
  -n MyApp.GitHub \
  -d https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o ./src/GitHub \
  --include-path "/repos/{owner}/{repo}/releases/*"
```

Без `--include-path` полная спецификация GitHub генерирует примерно 600 файлов. С ним вы получаете дюжину файлов для поддерева releases. Вы всегда можете расширить фильтр позже.

Зафиксируйте сгенерированные файлы в системе контроля версий. URL спецификации или локальный путь достаточны для их регенерации, и рецензенты могут видеть точные типы при проверке кода.

## Шаг 3: Добавить NuGet-пакет

```bash
dotnet add package Microsoft.Kiota.Bundle
```

`Microsoft.Kiota.Bundle` -- это метапакет, который включает:

- `Microsoft.Kiota.Abstractions` -- контракты адаптера запросов и интерфейсы сериализации
- `Microsoft.Kiota.Http.HttpClientLibrary` -- `HttpClientRequestAdapter`, стандартный HTTP-бэкенд
- `Microsoft.Kiota.Serialization.Json` -- сериализация System.Text.Json
- `Microsoft.Kiota.Authentication.Azure` -- опционально, для провайдеров аутентификации Azure Identity

Пакет ориентирован на `netstandard2.0`, поэтому совместим с .NET 8, .NET 9, .NET 10 и .NET 11 (в настоящее время в предварительной версии) без дополнительных настроек `<TargetFramework>`.

## Шаг 4: Использовать клиент в консольном приложении

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

var adapter = new HttpClientRequestAdapter(new AnonymousAuthenticationProvider());
var client = new WeatherClient(adapter);

// GET /forecasts
var all = await client.Forecasts.GetAsync();
Console.WriteLine($"Received {all?.Count} forecasts.");

// GET /forecasts/{location}
var specific = await client.Forecasts["lon=51.5,lat=-0.1"].GetAsync();
Console.WriteLine($"Temperature: {specific?.Temperature}");

// POST /forecasts
var created = await client.Forecasts.PostAsync(new()
{
    Location = "lon=51.5,lat=-0.1",
    TemperatureC = 21,
});
Console.WriteLine($"Created forecast ID: {created?.Id}");
```

`AnonymousAuthenticationProvider` не добавляет заголовки аутентификации -- правильно для публичных API. Для Bearer-токенов смотрите раздел аутентификации ниже.

Каждый сгенерированный асинхронный метод принимает необязательный `CancellationToken`. Передайте его из своего контекста:

```csharp
// .NET 11, Kiota 1.x
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var forecasts = await client.Forecasts.GetAsync(cancellationToken: cts.Token);
```

Токен передаётся через HTTP-адаптер и отменяет базовый вызов `HttpClient`. Никакой дополнительной настройки не требуется.

## Шаг 5: Подключить клиент к внедрению зависимостей ASP.NET Core

Создание адаптера запросов в каждом обработчике расходует сокеты (обходя пул соединений `IHttpClientFactory`) и делает клиент непригодным для тестирования. Правильный паттерн -- класс-фабрика, принимающий управляемый `HttpClient` через внедрение зависимостей в конструктор.

Создать фабрику:

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

public class WeatherClientFactory(HttpClient httpClient)
{
    public WeatherClient GetClient() =>
        new(new HttpClientRequestAdapter(
            new AnonymousAuthenticationProvider(),
            httpClient: httpClient));
}
```

Зарегистрировать всё в `Program.cs`:

```csharp
// .NET 11
using Microsoft.Kiota.Http.HttpClientLibrary;

// Зарегистрировать встроенные HTTP-обработчики Kiota в контейнере DI
builder.Services.AddKiotaHandlers();

// Зарегистрировать именованный HttpClient и присоединить эти обработчики
builder.Services.AddHttpClient<WeatherClientFactory>(client =>
{
    client.BaseAddress = new Uri("https://api.weather.example.com");
})
.AttachKiotaHandlers();

// Предоставить сгенерированный клиент непосредственно для внедрения
builder.Services.AddTransient(sp =>
    sp.GetRequiredService<WeatherClientFactory>().GetClient());
```

`AddKiotaHandlers` и `AttachKiotaHandlers` -- методы расширения из `Microsoft.Kiota.Http.HttpClientLibrary`. Они регистрируют стандартные делегирующие обработчики Kiota -- повторные попытки, перенаправление, инспекцию заголовков -- и связывают их с жизненным циклом `IHttpClientFactory` для корректного освобождения ресурсов.

Внедрить `WeatherClient` непосредственно в конечные точки Minimal API:

```csharp
// .NET 11
app.MapGet("/weather", async (WeatherClient client, CancellationToken ct) =>
{
    var forecasts = await client.Forecasts.GetAsync(cancellationToken: ct);
    return forecasts;
});
```

Параметр `CancellationToken` в обработчике Minimal API автоматически привязывается к токену отмены HTTP-запроса. Если клиент отключается, выполняемый вызов Kiota аккуратно отменяется без дополнительного кода.

## Шаг 6: Аутентификация

Для API, требующих Bearer-токен, реализуйте `IAccessTokenProvider` и передайте его в `BaseBearerTokenAuthenticationProvider`:

```csharp
// .NET 11, Kiota 1.x
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;

public class StaticTokenProvider(string token) : IAccessTokenProvider
{
    public Task<string> GetAuthorizationTokenAsync(
        Uri uri,
        Dictionary<string, object>? additionalContext = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(token);

    public AllowedHostsValidator AllowedHostsValidator { get; } = new();
}
```

Подключить в фабрике:

```csharp
// .NET 11, Kiota 1.x
var authProvider = new BaseBearerTokenAuthenticationProvider(
    new StaticTokenProvider(apiKey));

return new WeatherClient(new HttpClientRequestAdapter(authProvider, httpClient: httpClient));
```

В продакшене замените `StaticTokenProvider` реализацией, которая читает токен из текущего HTTP-контекста, значения `IOptions<>` или `DefaultAzureCredential` от Azure Identity (пакет `Microsoft.Kiota.Authentication.Azure` предоставляет `AzureIdentityAuthenticationProvider` именно для этого случая).

## Использование NSwag при предпочтении более простой структуры файлов

Если ваш проект уже использует NSwag или был создан с помощью `dotnet-openapi`, переходить не нужно. Установите CLI NSwag и регенерируйте:

```bash
dotnet tool install --global NSwag.ConsoleCore

nswag openapi2csclient \
  /input:openapi.yaml \
  /classname:WeatherClient \
  /namespace:MyApp.ApiClient \
  /output:WeatherClient.cs
```

NSwag создаёт один файл C#, содержащий класс клиента и соответствующий интерфейс `IWeatherClient`. Этот интерфейс упрощает модульное тестирование -- вы можете напрямую создавать mock для `IWeatherClient` без уровня косвенного обращения по пути. Для небольших, стабильных спецификаций, где весь сгенерированный файл помещается на один экран, NSwag -- практичный выбор. Для больших или часто меняющихся спецификаций файловая структура Kiota по пути упрощает проверку diff API.

## Подводные камни перед фиксацией сгенерированных файлов

**Качество спецификации определяет точность типов.** Kiota проверяет документ OpenAPI во время генерации. Отсутствующая аннотация `nullable: true` становится `string`, где вы ожидали `string?`. Неверный `type: integer` становится `int`, где API на самом деле отправляет числа с плавающей точкой. Если вы владелец сервера, запустите [Spectral](https://stoplight.io/open-source/spectral) против спецификации перед генерацией.

**`--include-path` не опционален для больших публичных API.** Без него спецификация GitHub генерирует сотни файлов, спецификация Stripe -- ещё больше. Ограничьте клиент во время генерации до путей, которые вы используете. Фильтр всегда можно расширить позже; клиент из 600 файлов, который растёт со временем, сложнее сократить.

**Коллизии имён моделей автоматически разрешаются через пространства имён.** Если `GET /posts/{id}` и `GET /users/{id}` оба ссылаются на схему с именем `Item`, Kiota генерирует `Posts.Item.Item` и `Users.Item.Item`. Проверьте операторы `using`, если имена кажутся конфликтующими.

**`CancellationToken` в конечных точках Minimal API бесплатен.** Объявите его как параметр, и ASP.NET Core привяжет его к токену отмены запроса без каких-либо атрибутов. Передавайте его в каждый вызов Kiota, и HTTP-клиент автоматически отменяется, когда браузер закрывает соединение или срабатывает таймаут шлюза. Механика кооперативной отмены задач в C# подробно рассмотрена в статье [как отменить долго выполняющуюся Task в C# без взаимной блокировки](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**Регенерируйте в CI, а не только локально.** Добавьте `dotnet tool restore && kiota generate [...]` как шаг пайплайна. Если спецификация изменится, а сгенерированный код в репозитории устарел, сборка обнаружит разницу до релиза.

## Связанные статьи

- Если вы предоставляете API-сервер и хотите, чтобы аутентификация Bearer корректно отображалась в интерфейсе документации Scalar, настройка неочевидна: [Scalar в ASP.NET Core: почему Bearer-токен игнорируется](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- Если вызовы между сервисами используют gRPC вместо REST, ловушки сетевого взаимодействия в контейнерах отличаются от HTTP: [gRPC в контейнерах в .NET 9 и .NET 10](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- Добавление распределённой трассировки к уровню HTTP-клиента хорошо сочетается с [нативной трассировкой OpenTelemetry в ASP.NET Core 11](/2026/04/aspnetcore-11-native-opentelemetry-tracing/)

## Источники

- [Обзор Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview) -- Microsoft Learn
- [Создание клиентов API для .NET](https://learn.microsoft.com/en-us/openapi/kiota/quickstarts/dotnet) -- Microsoft Learn
- [Регистрация клиента Kiota с внедрением зависимостей в .NET](https://learn.microsoft.com/en-us/openapi/kiota/tutorials/dotnet-dependency-injection) -- Microsoft Learn
- [NSwag: цепочка инструментов Swagger/OpenAPI для .NET](https://github.com/RicoSuter/NSwag) -- GitHub
