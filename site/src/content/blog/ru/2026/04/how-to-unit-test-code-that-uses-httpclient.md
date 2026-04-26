---
title: "Как писать модульные тесты для кода, использующего HttpClient"
description: "Полное руководство по тестированию HttpClient в .NET 11: почему не стоит мокать HttpClient напрямую, как написать stub HttpMessageHandler, заменить primary handler через IHttpClientFactory, проверить повторы Polly и вариант WireMock.Net."
pubDate: 2026-04-26
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "httpclient"
lang: "ru"
translationOf: "2026/04/how-to-unit-test-code-that-uses-httpclient"
translatedBy: "claude"
translationDate: 2026-04-26
---

Чтобы писать модульные тесты для кода, который обращается к HTTP API, не мокайте сам `HttpClient`. Замените его `HttpMessageHandler` на stub, возвращающий нужный вам ответ, и затем внедрите получившийся `HttpClient` (или `IHttpClientFactory`, который его выдаёт) в тестируемый класс. Точкой расширения служит handler, а не клиент. Всё дальнейшее ориентировано на .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) и xUnit 2.9, но шаблон не меняется в .NET 6, 8, 9 и 10.

## Почему мокать HttpClient напрямую неверно

У `HttpClient` есть открытая поверхность (`GetAsync`, `PostAsync`, `SendAsync`), которая выглядит мокабельной, и Moq позволит создать мок без возражений. Сложность в том, что эти методы делают на самом деле: каждый из них в конечном счёте вызывает `HttpMessageInvoker.SendAsync(HttpRequestMessage, CancellationToken)` на нижележащем `HttpMessageHandler`. Удобные методы самого `HttpClient` не `virtual`, а значит `Mock<HttpClient>` либо вообще их не перехватывает, либо опирается на инструменты вроде `Protected()` из Moq, чтобы добраться до приватных деталей.

Два практических следствия:

1. Тесты, которые мокают `HttpClient.GetAsync` напрямую, молча обходят конвейер handler-ов. Всё, что вы подключали к `IHttpClientFactory`, retry handler-ы, logging handler-ы, handler-ы аутентификации, в тесте не выполняется, поэтому зелёный тест может выпустить в продакшн сломанную цепочку handler-ов.
2. Если вы поменяете `GetAsync` на `Send`, тест сломается, хотя поведение идентично.

Официальное руководство Microsoft, любой разумный ответ на Stack Overflow с 2018 года и сам исходник `HttpClient` указывают на одну и ту же точку расширения: подменить `HttpMessageHandler`. У handler-а ровно один метод для переопределения (`SendAsync`), он `protected internal virtual`, и именно с ним работает остальной конвейер.

## Минимальный stub handler

Самая простая реализация это класс, оборачивающий делегат. Никакого фреймворка для мокинга не нужно:

```csharp
// .NET 11, C# 14
public sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;
    public List<HttpRequestMessage> Requests { get; } = new();

    public StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    public StubHttpMessageHandler(HttpStatusCode status, string? body = null, string mediaType = "application/json")
        : this((_, _) => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = body is null ? null : new StringContent(body, Encoding.UTF8, mediaType),
        }))
    {
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return _handler(request, cancellationToken);
    }
}
```

Двух конструкторов хватает на большинство тестов: конструктор с делегатом для тестов, которым нужно проверить запрос, и сокращение для случая "верни 200 с этим JSON". Список `Requests` позволяет тесту проверить то, что было отправлено.

## Тестируемый класс

Чтобы остальное стало конкретным, вот типичная форма кода, который хотят протестировать:

```csharp
// .NET 11, C# 14
public sealed record Repo(int Id, string Name, int Stars);

public sealed class GitHubClient
{
    private readonly HttpClient _http;

    public GitHubClient(HttpClient http) => _http = http;

    public async Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default)
    {
        var path = $"/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(name)}";
        using var response = await _http.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();

        var dto = await response.Content.ReadFromJsonAsync<RepoDto>(ct);
        return new Repo(dto!.Id, dto.Full_Name, dto.Stargazers_Count);
    }

    private sealed record RepoDto(int Id, string Full_Name, int Stargazers_Count);
}
```

Конструктор принимает `HttpClient`, а не статическую ссылку и не свежесозданный экземпляр. Именно это решение в дизайне делает возможным всё, что описано ниже.

## Тест, возвращающий заранее заготовленный ответ

```csharp
// .NET 11, C# 14, xUnit 2.9
[Fact]
public async Task GetRepoAsync_returns_parsed_repo_when_api_returns_200()
{
    var json = """
    { "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }
    """;

    var handler = new StubHttpMessageHandler(HttpStatusCode.OK, json);
    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    var repo = await sut.GetRepoAsync("octocat", "hello-world");

    Assert.Equal(42, repo.Id);
    Assert.Equal("octocat/hello-world", repo.Name);
    Assert.Equal(1300, repo.Stars);

    var sent = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, sent.Method);
    Assert.Equal("/repos/octocat/hello-world", sent.RequestUri!.AbsolutePath);
}
```

Три момента, на которые стоит обратить внимание. Handler конструируется со status и body, `HttpClient` конструируется с этим handler-ом и `BaseAddress`, а тест проверяет и распарсенный результат, и исходящий запрос. Третья проверка обычно пропускается тестами и при этом ловит больше всего регрессий, неверный путь, забытый заголовок, пустое тело там, где его быть не должно.

## Возвращать разные ответы на каждый запрос

Для класса, выполняющего несколько вызовов (постраничный список, повтор, условный GET), передайте делегат:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_throws_on_404()
{
    var handler = new StubHttpMessageHandler((req, _) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            RequestMessage = req,
            Content = new StringContent("""{ "message": "Not Found" }""", Encoding.UTF8, "application/json"),
        }));

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    await Assert.ThrowsAsync<HttpRequestException>(() => sut.GetRepoAsync("octocat", "ghost"));
}
```

Для последовательных ответов (первый вызов вернул 401, второй 200 после обновления токена) держите счётчик внутри делегата:

```csharp
// .NET 11, C# 14
var calls = 0;
var handler = new StubHttpMessageHandler((req, _) =>
{
    var status = calls++ == 0 ? HttpStatusCode.Unauthorized : HttpStatusCode.OK;
    return Task.FromResult(new HttpResponseMessage(status)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });
});
```

Этого достаточно почти для любого сценария модульного теста. Без фреймворка для мокинга, без трюков с protected членами, без церемоний.

## Вариант с Moq и почему я его избегаю

Если в кодовой базе уже стандартизирован Moq, эквивалент таков:

```csharp
// .NET 11, C# 14, Moq 4.20
var handler = new Mock<HttpMessageHandler>(MockBehavior.Strict);
handler
    .Protected()
    .Setup<Task<HttpResponseMessage>>(
        "SendAsync",
        ItExpr.IsAny<HttpRequestMessage>(),
        ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });

var http = new HttpClient(handler.Object) { BaseAddress = new Uri("https://api.github.com") };
```

Работает. Минусы:

- `"SendAsync"` это строка. Если фреймворк когда-нибудь это переименует (не переименует, но принцип остаётся), компилятор не заметит.
- `Protected()` требует `using Moq.Protected;` и заставляет каждого, кто читает тест, знать этот трюк.
- Возврат единственного экземпляра `HttpResponseMessage` из singleton-настройки мока приводит к утечке состояния между вызовами, если ответ читается более одного раза. Stub handler из предыдущего раздела создаёт свежий ответ на каждый вызов.

Для разовых тестов Moq нормален. Для тестового класса с пятью HTTP-сценариями написанный руками stub короче, быстрее читается и проще отлаживается.

## Тестирование через IHttpClientFactory

В продакшн-коде, который использует `IHttpClientFactory` (а большая часть современного кода использует), тестируемая единица принимает `IHttpClientFactory` или типизированный клиент, а фабрика собирает `HttpClient` с цепочкой handler-ов, которую вы зарегистрировали в `Program.cs`. Тестовая точка расширения смещается с "сконструировать `HttpClient` напрямую" на "настроить primary handler фабрики".

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http 11.0
[Fact]
public async Task TypedClient_uses_registered_handler_chain()
{
    var stub = new StubHttpMessageHandler(HttpStatusCode.OK,
        """{ "id": 7, "full_name": "a/b", "stargazers_count": 5 }""");

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .ConfigurePrimaryHttpMessageHandler(() => stub)
        .Services
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();

    var repo = await sut.GetRepoAsync("a", "b");
    Assert.Equal(7, repo.Id);
}
```

`ConfigurePrimaryHttpMessageHandler` подменяет нижнюю часть цепочки. Все остальные handler-ы, которые вы зарегистрировали (журналирование, повторы, аутентификация), продолжают выполняться, в этом и весь смысл. Если вы хотите заменить всю цепочку (это почти никогда не нужно), используйте `AddHttpMessageHandler` плюс stub handler в конце или соберите `HttpClient` вручную, как в примерах выше.

## Проверить, что Polly действительно повторил запрос

Это тест, который Moq делает мучительным, а stub handler делает тривиальным. Допустим, ваш `Program.cs` регистрирует:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 9.0
builder.Services.AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
    .AddStandardResilienceHandler();
```

Стандартный handler устойчивости по умолчанию повторяет 5xx и таймауты три раза. Чтобы это доказать в тесте:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_retries_on_503()
{
    var calls = 0;
    var handler = new StubHttpMessageHandler((_, _) =>
    {
        calls++;
        var status = calls < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                        Encoding.UTF8, "application/json"),
        });
    });

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .AddStandardResilienceHandler()
        .Services
        .ConfigureAll<HttpClientFactoryOptions>(o => o.HttpMessageHandlerBuilderActions.Add(b =>
            b.PrimaryHandler = handler))
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();
    var repo = await sut.GetRepoAsync("x", "y");

    Assert.Equal(3, calls);
    Assert.Equal(1, repo.Id);
}
```

Проверка `Assert.Equal(3, calls)` и делает это интеграционным тестом цепочки handler-ов. Чистый мок `HttpClient.GetAsync` вообще бы не вызвал Polly, и проверка была бы `calls == 1`, тот самый молчаливый сбой, о котором я предупреждал ранее.

## Отмена и таймаут

С отменой всё прямолинейно: stub handler получает `CancellationToken`, и вы можете заставить его его наблюдать.

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_propagates_cancellation()
{
    var handler = new StubHttpMessageHandler(async (_, ct) =>
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    });

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://x") };
    var sut = new GitHubClient(http);

    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        sut.GetRepoAsync("a", "b", cts.Token));
}
```

Сам `HttpClient.Timeout` проявляется как `TaskCanceledException` (с вложенным `TimeoutException` начиная с .NET 5). Если хотите проверить поведение таймаута, задайте `http.Timeout = TimeSpan.FromMilliseconds(50)` и заставьте handler ждать `await Task.Delay` дольше этого. См. [Как отменить долгую Task в C# без дедлока](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) для шаблонов кооперативной отмены, которым продакшн-код уже должен следовать.

## Проверки на тела запросов

Для `POST` и `PUT` захватите и прочитайте содержимое запроса внутри делегата handler-а:

```csharp
// .NET 11, C# 14
string? captured = null;
var handler = new StubHttpMessageHandler(async (req, ct) =>
{
    captured = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
    return new HttpResponseMessage(HttpStatusCode.Created);
});
```

Читайте тело внутри handler-а, а не после. Как только `SendAsync` вернётся, поток запроса может быть уничтожен.

## Заголовки, query string и базовые адреса

`BaseAddress` плюс относительный путь это самая чистая конфигурация, но следите за завершающим слешем. `new Uri("https://api.example.com/v1")` плюс запрос на `/users` отбрасывает `/v1`, потому что у URI нет завершающего слеша. `https://api.example.com/v1/` плюс `users` (без ведущего слеша) даёт `/v1/users`. Проверьте:

```csharp
// .NET 11, C# 14
Assert.Equal("/v1/users", handler.Requests[0].RequestUri!.AbsolutePath);
```

Заголовки по умолчанию ставятся на `HttpClient`, а не на каждый запрос, и видны handler-у:

```csharp
// .NET 11, C# 14
http.DefaultRequestHeaders.Add("User-Agent", "start-debugging/1.0");
// in the handler:
Assert.Contains("start-debugging/1.0", req.Headers.UserAgent.ToString());
```

## Когда стоит брать WireMock.Net

Подход со stub handler-ом это модульный тест, без сокета, без реального HTTP. Для компонентных или интеграционных тестов, использующих настоящий HTTP-стек (TLS, согласование контента, реальная chunked-передача, серверные таймауты) обращайтесь к [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net):

```csharp
// .NET 11, C# 14, WireMock.Net 1.6
using var server = WireMockServer.Start();
server
    .Given(Request.Create().WithPath("/repos/octocat/hello-world").UsingGet())
    .RespondWith(Response.Create()
        .WithStatusCode(200)
        .WithHeader("Content-Type", "application/json")
        .WithBody("""{ "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }"""));

var http = new HttpClient { BaseAddress = new Uri(server.Url!) };
var sut = new GitHubClient(http);
var repo = await sut.GetRepoAsync("octocat", "hello-world");
```

WireMock.Net поднимает реальный HTTP-сервер на локальном порту. Медленнее, чем stub handler, реалистичнее, более хрупок (конфликты портов, TLS, асинхронный старт). Я использую его для тестов, которым нужно проверить поведение, которое фреймворк делает только для реальных сокетов, в остальных случаях stub handler быстрее и тише. Для аналогичного подхода к мокингу других зависимостей см. [Как написать собственный JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), на который шаг десериализации в `GetRepoAsync` уже опирается.

## Ошибки, всплывающие при code review

Короткий список того, что я отмечал не в одном PR:

- Создавать `HttpClient` внутри тестируемого класса (`private readonly HttpClient _http = new();`). Тест не может внедрить фейковый handler, поэтому он либо обращается к настоящей сети, либо падает. Принимайте зависимость как параметр.
- Использовать `MockBehavior.Loose` на моке `HttpMessageHandler` и забыть проверить запрос. Тест проходит, даже когда продакшн-код вообще не обращается к API.
- Возвращать один и тот же экземпляр `HttpResponseMessage` из нескольких вызовов в тесте. Поток содержимого читается один раз, поэтому второй вызов увидит пустое тело. Либо создавайте свежий ответ на каждый вызов (конструктор с делегатом), либо копируйте тело в свежий `StringContent`.
- Проверять `response.StatusCode` вместо поведения. Смысл теста в том, что `GetRepoAsync` делает с 503, а не в том, что у литерала `HttpResponseMessage`, который вы сконструировали, тот код статуса, с которым вы его сконструировали.
- Мокать через `Mock<HttpClient>` напрямую. Как описано выше, это обходит цепочку handler-ов и молча ломает handler-ы устойчивости и аутентификации.

Handler это точка расширения, остальное вытекает. Если тесту нужны Moq, NSubstitute, FakeItEasy или WireMock, прекрасно, но настраивайте точку расширения, а не поверхность.

## Источники

- [HttpMessageHandler.SendAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.httpmessagehandler.sendasync)
- [Руководство IHttpClientFactory (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory)
- [ConfigurePrimaryHttpMessageHandler (MS Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.httpclientbuilderextensions.configureprimaryhttpmessagehandler)
- [Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net)
