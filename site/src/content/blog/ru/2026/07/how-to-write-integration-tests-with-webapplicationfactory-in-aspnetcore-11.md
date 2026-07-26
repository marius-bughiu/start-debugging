---
title: "Как писать интеграционные тесты с WebApplicationFactory<T> в ASP.NET Core 11"
description: "Полное руководство по WebApplicationFactory<TEntryPoint> в ASP.NET Core 11: как сделать точку входа Program доступной, ConfigureTestServices против ConfigureWebHost, замена регистрации EF Core через IDbContextOptionsConfiguration, новый хук ConfigureHostApplicationBuilder в .NET 11 preview 6, подделка аутентификации, WebApplicationFactoryClientOptions и UseKestrel, когда нужен настоящий порт."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "xunit"
lang: "ru"
translationOf: "2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Чтобы написать интеграционный тест с `WebApplicationFactory<TEntryPoint>` в ASP.NET Core 11, подключите пакет `Microsoft.AspNetCore.Mvc.Testing` в тестовом проекте, сделайте точку входа приложения доступной, добавив `public partial class Program { }` в конец `Program.cs`, а затем внедрите `WebApplicationFactory<Program>` в тестовый класс xUnit через `IClassFixture<T>` и вызовите `CreateClient()`. Этот `HttpClient` общается с вашим настоящим конвейером middleware и вашим настоящим контейнером внедрения зависимостей через транспорт в памяти: без сокета, без порта и без `dotnet run`. Всё остальное (подмена сервиса заглушкой, переключение EF Core на другую базу данных, подделка аутентифицированного пользователя) делается внутри `ConfigureWebHost` или `WithWebHostBuilder`. Статья ориентирована на .NET 11 (на момент написания preview 6, релиз в ноябре 2026 года) и C# 14 и отдельно отмечает два API, появившихся после .NET 9: `UseKestrel` из .NET 10 и `ConfigureHostApplicationBuilder` из .NET 11 preview 6. Всё прочее работает без изменений на .NET 8, 9 и 10.

## Что на самом деле запускает фабрика

`WebApplicationFactory<TEntryPoint>` запускает приложение не так, как `dotnet run`. Она использует `HostFactoryResolver`, чтобы вызвать вашу точку входа, перехватывает `IHost` прямо перед его запуском, подменяет реализацию сервера на `TestServer` и возвращает вам уже собранный хост. Последствия стоит усвоить, потому что именно они объясняют почти всё неожиданное поведение:

- Ваш `Program.cs` выполняется. Каждый вызов `builder.Services.Add*`, каждая регистрация middleware и каждый `MapGet` отрабатывают ровно так же, как в продакшене.
- Сетевой сокет не открывается. `TestServer` реализует `IServer` поверх `HttpMessageHandler` в памяти, поэтому запросы полностью минуют транспортный уровень. Kestrel не участвует, а значит, перенаправление на HTTPS, согласование HTTP/2 и ограничения на соединения не проверяются.
- Контейнер внедрения зависимостей тот же, что в продакшене, плюс то, что вы добавите в `ConfigureTestServices`. Синглтоны живут столько же, сколько фабрика, поэтому состояние протекает между тестами одного фикстура, если его не сбрасывать.

Последний пункт и есть главная ценность. Модульный тест сообщает, что обработчик возвращает правильный объект. Интеграционный тест сообщает, что шаблон маршрута совпадает, привязка модели разбирает тело запроса, политика авторизации пропускает вызывающего, конвейер фильтров выполняется в нужном порядке, а JSON в ответе содержит те имена свойств, которых ждёт клиент. Ничего из этого не проверяется прямым вызовом обработчика.

## Шаги для добавления теста с WebApplicationFactory

1. Добавьте тестовый проект и подключите `Microsoft.AspNetCore.Mvc.Testing`, а также ссылку на проект тестируемого приложения.
2. Откройте точку входа, дописав `public partial class Program { }` в `Program.cs` приложения.
3. Внедрите `WebApplicationFactory<Program>` в тестовый класс через `IClassFixture<T>` и вызовите `CreateClient()`.
4. Создайте собственную фабрику и переопределите `ConfigureWebHost`, когда нужно заменить сервисы или конфигурацию.
5. Используйте `WithWebHostBuilder` для подмен в рамках одного теста, которые не должны влиять на остальной класс.
6. Сбрасывайте общее состояние между тестами, поскольку хост и его синглтоны разделяются на весь фикстур.

## Пакеты

```xml
<!-- .NET 11 preview 6, test project -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="11.0.0-preview.6.*" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.0" />
  <PackageReference Include="xunit.v3" Version="3.1.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="..\..\src\Orders.Api\Orders.Api.csproj" />
</ItemGroup>
```

На .NET 10 используйте стабильную версию `10.0.0` пакета `Microsoft.AspNetCore.Mvc.Testing`. Если вы ещё не ушли с xUnit v2, `xunit` 2.9.x работает точно так же для всего изложенного ниже, за исключением сигнатуры `IAsyncLifetime`, о которой говорится в разделе про жизненный цикл.

`Microsoft.AspNetCore.Mvc.Testing`, несмотря на название, не привязан к MVC. Он работает для minimal API, контроллеров, Razor Pages и Blazor Server. Кроме того, пакет содержит MSBuild-таргет, который проставляет в тестовую сборку атрибут `WebApplicationFactoryContentRootAttribute`, чтобы фабрика нашла content root приложения, а это важно для статических файлов и представлений Razor.

## Как сделать точку входа доступной

Именно здесь останавливается большинство первых попыток. Операторы верхнего уровня компилируются в класс с именем `Program`, доступность которого `internal`, поэтому обращение к нему из тестовой сборки не компилируется:

```
error CS0122: 'Program' is inaccessible due to its protection level
```

Решение занимает одну строку в самом конце `Program.cs`, после `app.Run()`:

```csharp
// .NET 11, C# 14 -- Program.cs, last line
app.Run();

public partial class Program { }
```

Компилятор объединяет ваше частичное объявление со сгенерированным, и класс становится публичным. Альтернатива, `[assembly: InternalsVisibleTo("Orders.Api.Tests")]` в проекте приложения, оставляет `Program` внутренним, но заодно открывает тестовой сборке все остальные внутренние типы. Выбирайте частичный класс, если только у вас нет причин политики поступить иначе.

Родственный сбой во время выполнения выглядит так:

```
System.InvalidOperationException: The entry point exited without ever building an IHost.
```

Он означает, что резолвер выполнил ваш `Program.cs` до конца и так и не увидел построения хоста. Обычные причины: ранний `return` на какой-то ветке разбора аргументов, `Main`, вызывающий `Environment.Exit`, или проглоченное исключение при старте. Учитывайте, что код запуска приложения действительно выполняется во время теста, поэтому `Program.cs`, который читает строку подключения и бросает исключение при её отсутствии, бросит его и здесь. Конфигурация, на которую вы полагаетесь при старте, должна быть доступна тестовому процессу.

## Первый тест

Когда точка входа открыта, фабрике по умолчанию вообще не нужен наследник:

```csharp
// .NET 11, xUnit v3
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

public sealed class OrdersEndpointTests
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrdersEndpointTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Unknown_order_returns_404()
    {
        var response = await _client.GetAsync("/orders/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/orders")]
    public async Task Endpoint_returns_json(string url)
    {
        var response = await _client.GetAsync(url);

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json; charset=utf-8",
            response.Content.Headers.ContentType?.ToString());
    }
}
```

`IClassFixture<T>` создаёт фабрику один раз на тестовый класс и освобождает её после последнего теста этого класса. `CreateClient` можно вызывать сколько угодно раз; каждый вызов возвращает новый `HttpClient`, привязанный к тому же хосту, со своим контейнером cookie.

## Замена сервисов через ConfigureTestServices

Как только вам понадобится поддельный платёжный шлюз или другая база данных, вы наследуете фабрику и переопределяете `ConfigureWebHost`. Используйте `ConfigureTestServices`, а не `ConfigureServices`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

public sealed class OrdersApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, StubPaymentGateway>();
        });
    }
}
```

Различие существенно. Обратные вызовы `ConfigureServices` выполняются в порядке регистрации наравне с вызовами самого приложения, поэтому ваш может отработать раньше, чем `Program.cs` добавит свою реализацию. `ConfigureTestServices` намеренно откладывается до момента, когда регистрация сервисов приложения завершена, и именно это делает надёжной подмену по принципу «побеждает последний».

Принцип «побеждает последний» действует только при разрешении одного сервиса. `GetRequiredService<IPaymentGateway>()` вернёт последнюю регистрацию, но `GetRequiredService<IEnumerable<IPaymentGateway>>()` вернёт обе, и всё, что внедряется как `IEnumerable<T>` (валидаторы, health checks, фоновые сервисы, `IStartupFilter`), увидит и исходную реализацию. Поэтому перед `Add` стоит `RemoveAll<T>`. Для сервисов, зарегистрированных по ключу, во внедрении зависимостей .NET 11 есть `RemoveAllKeyed<T>`, что сочетается с [регистрацией и разрешением сервисов по ключу](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

Для разовой подмены, которая не должна влиять на остальной класс, используйте `WithWebHostBuilder`. Он возвращает новую фабрику, не разделяющую ничего, кроме переданной вами конфигурации:

```csharp
[Fact]
public async Task Gateway_timeout_maps_to_502()
{
    var client = _factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, TimingOutGateway>();
        });
    }).CreateClient();

    var response = await client.PostAsJsonAsync("/orders",
        new { customerId = "C-1", amount = 10m });

    Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
}
```

## Ловушка с регистрацией EF Core

Руководства, написанные до EF Core 9, советуют найти и удалить дескриптор `DbContextOptions<TContext>` перед добавлением собственного провайдера. Этот фрагмент больше не делает того, что обещает. Начиная с EF Core 9, `AddDbContext` регистрирует конфигурацию провайдера через `IDbContextOptionsConfiguration<TContext>` из `Microsoft.EntityFrameworkCore.Infrastructure`, и удаление одного лишь `DbContextOptions<TContext>` оставляет исходную конфигурацию SQL Server на месте. Вы добавляете второй провайдер, и EF бросает исключение:

```
System.InvalidOperationException: Only a single database provider can be registered
in a service provider. If possible, ensure that Entity Framework is managing its
service provider by removing the call to UseInternalServiceProvider.
```

В EF Core 9, 10 и 11 удалять нужно вот эту регистрацию:

```csharp
// .NET 11, EF Core 11
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

builder.ConfigureTestServices(services =>
{
    var registrations = services
        .Where(d => d.ServiceType ==
            typeof(IDbContextOptionsConfiguration<OrdersDbContext>))
        .ToList();

    foreach (var registration in registrations)
    {
        services.Remove(registration);
    }

    services.AddDbContext<OrdersDbContext>(options =>
        options.UseSqlite(_connection));
});
```

Обратите внимание, что соединение SQLite это поле фабрики, открытое один раз и остающееся открытым, потому что база данных SQLite в памяти уничтожается при закрытии последнего соединения. Не берите здесь in-memory провайдер EF Core: у него нет реляционной семантики, поэтому внешние ключи, ограничения уникальности и типы столбцов не проверяются. Если тест должен доказать, что ограничение срабатывает, запускайте его на настоящем движке, как описано в статье про [интеграционные тесты с настоящим SQL Server и Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), а для случаев, когда база данных действительно избыточна, смотрите [как подменять DbContext, не ломая отслеживание изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

## Конфигурация и окружение

`UseEnvironment("Testing")` это самый дешёвый рычаг: он заставляет `IWebHostEnvironment.EnvironmentName` возвращать `Testing`, загружает `appsettings.Testing.json`, если он есть, и позволяет продакшен-коду ветвиться по `env.IsProduction()` без специальных случаев для тестов.

Для отдельных настроек сложность в моменте подмены. `ConfigureAppConfiguration` внутри `ConfigureWebHost` выполняется уже после возврата из `WebApplication.CreateBuilder`, поэтому добавленное там значение невидимо для любого кода в `Program.cs`, который читает `builder.Configuration` при старте, а это большинство вызовов `AddOptions` и `Bind`. В .NET 11 preview 6 появился хук, который выполняется достаточно рано:

```csharp
// .NET 11 preview 6 and later
private static readonly KeyValuePair<string, string?>[] s_settings =
[
    new("Payments:Endpoint", "https://localhost/stub"),
    new("Features:UseNewPricing", "true"),
];

protected override void ConfigureHostApplicationBuilder(
    IHostApplicationBuilder hostApplicationBuilder)
{
    hostApplicationBuilder.Configuration.AddInMemoryCollection(s_settings);
    base.ConfigureHostApplicationBuilder(hostApplicationBuilder);
}
```

Источник конфигурации оказывается на месте до возврата из `CreateBuilder`, поэтому код запуска его видит. В .NET 10 и раньше эквивалент это переопределить `CreateHost` и вызвать `builder.ConfigureHostConfiguration(...)` перед `base.CreateHost(builder)`, либо просто выставить переменные окружения в тестовом процессе до построения хоста.

## Подделка аутентифицированного пользователя

Не пытайтесь получить настоящий токен в тесте. Зарегистрируйте тестовую схему аутентификации, которая всегда завершается успешно, и сделайте её схемой по умолчанию:

```csharp
// .NET 11, C# 14
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, "user-1"),
            new(ClaimTypes.Name, "Test User"),
            new("scope", "orders:write"),
        ];

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme));
        var ticket = new AuthenticationTicket(principal, Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// in ConfigureTestServices
services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = TestAuthHandler.Scheme;
    options.DefaultChallengeScheme = TestAuthHandler.Scheme;
})
.AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
    TestAuthHandler.Scheme, _ => { });
```

Затем установите `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(TestAuthHandler.Scheme)`, и запрос придёт аутентифицированным. Ваши политики авторизации при этом продолжают работать по-настоящему, в этом и смысл: тестируется политика, а не формат токена. Если проверить нужно именно валидацию токена, это уже другой тест, а участвующие параметры разобраны в статье про [настройку аутентификации JWT bearer в minimal API](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Параметры клиента, которые меняют результат

`CreateClient` принимает `WebApplicationFactoryClientOptions`, и два его свойства регулярно решают, пройдёт тест или нет:

```csharp
var client = factory.CreateClient(new WebApplicationFactoryClientOptions
{
    AllowAutoRedirect = false,          // default true
    BaseAddress = new Uri("https://localhost"),
    HandleCookies = true,               // default true
    MaxAutomaticRedirections = 7,
});
```

`AllowAutoRedirect` по умолчанию равен `true`, поэтому обработчик, возвращающий `302`, отслеживается автоматически, и ваша проверка на `HttpStatusCode.Redirect` падает с `200 OK`. Отключайте его всегда, когда тестируется само перенаправление. Значение `BaseAddress`, равное `https://localhost`, важно, если в конвейере есть `UseHttpsRedirection`, поскольку на запрос к `http://localhost` придёт перенаправление вместо ресурса.

## Когда нужен настоящий порт

`TestServer` не умеет обслуживать браузер. Начиная с .NET 10, `WebApplicationFactory` может работать поверх Kestrel и слушать настоящий порт на loopback:

```csharp
// .NET 10 and .NET 11
var factory = new OrdersApiFactory();
factory.UseKestrel(0);      // 0 means "pick a free port"
factory.StartServer();

var client = factory.CreateClient();
// client.BaseAddress is now the real bound address, for example
// http://127.0.0.1:53127/, taken from IServerAddressesFeature
await page.GotoAsync(client.BaseAddress!.ToString());
```

`UseKestrel` нужно вызвать до инициализации фабрики, то есть до любого вызова `CreateClient` или `StartServer`, иначе он бросит `InvalidOperationException`. Как только в игру вступает Kestrel, `CreateClient` возвращает обычный `HttpClient`, чей `BaseAddress` взят из `IServerAddressesFeature` сервера, так что Playwright или Selenium могут управлять тем же хостом, который остальные ваши тесты проверяют в памяти. Есть также перегрузки `UseKestrel()` и `UseKestrel(Action<KestrelServerOptions>)`, когда нужно настроить ограничения или HTTPS.

## Жизненный цикл, освобождение и общее состояние

`WebApplicationFactory<T>` освобождаема, и xUnit освобождает фикстур за вас. Если ваша фабрика владеет дополнительными ресурсами (соединением SQLite, контейнером, временным каталогом), реализуйте на ней `IAsyncLifetime`. В xUnit v3 этот интерфейс наследуется от `IAsyncDisposable`, и оба метода возвращают `ValueTask`, поэтому сигнатуры из v2 с `Task` после миграции больше не компилируются:

```csharp
// xUnit v3
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");

    public async ValueTask InitializeAsync() => await _connection.OpenAsync();

    public override async ValueTask DisposeAsync()
    {
        await _connection.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Выбор области видимости это компромисс: `IClassFixture<T>` поднимает один хост на тестовый класс, `ICollectionFixture<T>` разделяет один хост между всеми классами коллекции (и выстраивает их последовательно), а фикстур уровня сборки разделяет один хост на весь прогон. Запуск хоста обычно занимает от 200 до 500 мс, поэтому вариант «на класс» разумен по умолчанию, но помните, что все синглтоны приложения на это время общие. Кеш, `static`-счётчик, `IMemoryCache` или внутрипроцессный outbox перенесут состояние из одного теста в следующий. Сбрасывайте его в тесте явно или сужайте область фикстура.

Для всего, что зависит от часов, не используйте задержки. Зарегистрируйте `TimeProvider` в приложении и подменяйте его на `FakeTimeProvider` в `ConfigureTestServices`, как описано в статье про [тестирование кода, зависящего от времени, с TimeProvider и FakeTimeProvider](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). А когда приложение делает исходящие HTTP-вызовы, подменяйте обработчик, а не клиент, по образцу из статьи про [модульное тестирование кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/).

Последняя ловушка: `xunit.runner.visualstudio` в некоторых конфигурациях по умолчанию делает теневое копирование тестовых сборок, что ломает определение content root, от которого зависят статические файлы и представления Razor. Если страница отрисовывается в продакшене, но отдаёт 404 в тесте, добавьте `xunit.runner.json` со значением `"shadowCopy": false` и настройте его копирование в выходной каталог.

Ментальная модель, которая держит всё это вместе: `WebApplicationFactory` это ваш продакшен-хост ровно с двумя изменениями, реализацией сервера и тем, что вы намеренно переопределили в `ConfigureTestServices`. Любая неожиданность, которую она выдаёт, восходит к чему-то в вашем настоящем пути запуска, о чём вы забыли, что оно тоже выполнится.

## Похожие статьи

- [Как писать интеграционные тесты с настоящим SQL Server и Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Как тестировать зависящий от времени код с TimeProvider и FakeTimeProvider в .NET 11](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [Как писать модульные тесты для кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Как настроить аутентификацию JWT bearer в minimal API в ASP.NET Core 11](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Как регистрировать и разрешать сервисы по ключу во внедрении зависимостей .NET 11](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [WebApplication.CreateBuilder против CreateSlimBuilder и CreateEmptyBuilder в ASP.NET Core 11](/ru/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Источники

- [Интеграционные тесты в ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [WebApplicationFactory&lt;TEntryPoint&gt;.UseKestrel (справочник по API)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel)
- [Исходный код WebApplicationFactory.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Testing/src/WebApplicationFactory.cs)
- [IDbContextOptionsConfiguration&lt;TContext&gt; (справочник по API EF Core)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.idbcontextoptionsconfiguration-1)
- [Миграция модульных тестов с xUnit v2 на v3](https://xunit.net/docs/getting-started/v3/migration)
