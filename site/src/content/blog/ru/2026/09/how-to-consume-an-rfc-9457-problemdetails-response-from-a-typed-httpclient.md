---
title: "Как прочитать ответ ProblemDetails по RFC 9457 из типизированного HttpClient, не ссылаясь на ASP.NET Core"
description: "В BCL нет типа ProblemDetails, а добавление FrameworkReference на Microsoft.AspNetCore.App приводит к тому, что клиент отказывается запускаться в контейнере, где есть только среда выполнения. Вот модель на 20 строк, DelegatingHandler, который превращает problem+json в типизированное исключение, и миф про content-type, который до сих пор повторяет большинство ответов."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "httpclient"
  - "system-text-json"
  - "aspnetcore-11"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient"
translatedBy: "claude"
translationDate: 2026-09-07
---

Короткий ответ: не ссылайтесь на ASP.NET Core. Объявите класс с пятью свойствами и словарём `[JsonExtensionData]` для членов-расширений и десериализуйте его через `HttpContent.ReadFromJsonAsync<T>` из `System.Net.Http.Json`. Тип медиа `application/problem+json` разбирается без проблем, потому что `ReadFromJsonAsync` не проверяет типы содержимого начиная с .NET 5, и всё это работает в консольном приложении, библиотеке классов, Blazor WebAssembly, MAUI и клиенте с Native AOT.

В этой статье разбирается, почему `Microsoft.AspNetCore.Mvc.ProblemDetails` не тот тип, к которому стоит тянуться на клиенте, какая именно ошибка возникает, если всё-таки к нему потянуться, какая модель полностью переносит реальный ответ ASP.NET Core, включая `errors` и `traceId`, как подключить её к типизированному `HttpClient`, чтобы 4xx превращался в типизированное исключение, и горстка правил RFC 9457, которые ударят по вам, если считать `status` надёжным.

Замечание о версиях. .NET 11 и ASP.NET Core 11 находятся в предварительной версии по состоянию на сентябрь 2026 года и выходят в общую доступность 2026-11-10, согласно [заметкам о выпуске .NET 11](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md). В этой области с .NET 11 ничего не меняется, а предложение по API, которое решило бы вопрос как следует, нацелено на .NET 12 (об этом в конце). Весь вывод ниже получен на этой машине с .NET SDK 10.0.302 и средами выполнения 10.0.10, на minimal API с `AddProblemDetails()`.

## Почему клиент не может просто взять серверный тип

`ProblemDetails` представляет собой обычный класс данных с пятью свойствами, допускающими null, и словарём. У него нет поведения и нет серверных зависимостей. Тем не менее он живёт в `Microsoft.AspNetCore.Http.Abstractions.dll`, которая поставляется только как часть общего фреймворка `Microsoft.AspNetCore.App`, поэтому добраться до него можно только одним поддерживаемым способом, через ссылку на фреймворк:

```xml
<!-- Contracts.csproj, .NET 10 / .NET 11 -->
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

Это компилируется. И это распространяется дальше. Добавьте такую библиотеку классов в самое обычное консольное приложение и посмотрите, что SDK пишет в `Cli.runtimeconfig.json`:

```json
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}
```

Консольное приложение теперь жёстко требует общий фреймворк ASP.NET Core при старте. На машине, где он есть, всё выглядит нормально, и именно поэтому такое доезжает до продакшена. Запустите тот же бинарник на установке .NET, где есть только среда выполнения, то есть на том, что даёт `mcr.microsoft.com/dotnet/runtime:10.0`, и хост откажет ещё до того, как выполнится хоть одна строка вашего кода:

```
You must install or update .NET to run this application.

App: /app/Cli.dll
Architecture: arm64
Framework: 'Microsoft.AspNetCore.App', version '10.0.0' (arm64)

No frameworks were found.
```

Я получил это, скопировав только `shared/Microsoft.NETCore.App` во временный `DOTNET_ROOT` и запустив приложение оттуда. Это в точности то сообщение, которое выдаёт неверный базовый образ, и обычно это лечат переходом на образ `aspnet`, что добавляет около 20 МБ серверного фреймворка клиенту, который никогда не откроет сокет в режиме прослушивания. Если вы занимаетесь размерами образов, компромиссы разобраны в статье [Framework-dependent vs self-contained vs Native AOT для контейнерного образа .NET 11](/ru/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).

Остальные цели ломаются раньше и жёстче. `FrameworkReference` на `Microsoft.AspNetCore.App` вообще недоступен библиотеке `netstandard2.0`, а клиенту Blazor WebAssembly или MAUI незачем тащить Kestrel, MVC и метаданные маршрутизации в свой граф trimming ради чтения пяти строк JSON. Задача в `dotnet/aspnetcore` с просьбой перенести тип, [#58551 "Move ProblemDetails outside of Asp.Net Core"](https://github.com/dotnet/aspnetcore/issues/58551), лежит в бэклоге без исполнителя с момента создания.

## Модель за четыре шага

1. **Объявите пять членов RFC 9457 как свойства, допускающие null.** Каждый член в [разделе 3.1 RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457#section-3.1) необязателен. `status` задан как JSON-число, поэтому `int?`; остальные четыре являются строками.
2. **Добавьте словарь `[JsonExtensionData]`.** Раздел 3.2 RFC 9457 разрешает типу проблемы добавлять члены в том же плоском пространстве имён, что и стандартные, и ASP.NET Core пишет свой словарь `Extensions` ровно так. Без этого вы молча теряете `errors`, `traceId` и все доменные поля, которые добавил API.
3. **Десериализуйте через `ReadFromJsonAsync<T>` на `HttpContent`,** а не через `GetFromJsonAsync`. Помощники уровня `HttpClient` вызывают `EnsureSuccessStatusCode` за вас, что здесь ровно противоположно тому, что нужно.
4. **Проверяйте тип медиа сами,** потому что больше этого никто не сделает.

Тип достаточно короткий, чтобы вставить его в любой клиентский проект:

```csharp
// .NET 10 / .NET 11, C# 14. Only needs System.Net.Http.Json + System.Text.Json.
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ProblemDetails
{
    public string? Type { get; set; }
    public string? Title { get; set; }
    public int? Status { get; set; }
    public string? Detail { get; set; }
    public string? Instance { get; set; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Extensions { get; set; }
}
```

Атрибуты `[JsonPropertyName]` не нужны. `ReadFromJsonAsync` по умолчанию использует `JsonSerializerOptions.Web`, где `PropertyNamingPolicy` установлен в camelCase, а `PropertyNameCaseInsensitive` в `true`, поэтому `title` связывается с `Title` сам. На реальном ответе ASP.NET Core модель забирает всё:

```
type=https://example.com/probs/insufficient-funds
title=Insufficient funds
status=402
detail=Account 12345 has a balance of 4.20 EUR.
instance=/accounts/12345/withdraw
extensions: balance=4.20, accounts=["/account/12345","/account/67890"], traceId=00-5bf0...-00
```

Этот `traceId` конечная точка не устанавливала. `DefaultProblemDetailsWriter` из ASP.NET Core добавляет его из `Activity.Current?.Id`, с запасным вариантом `HttpContext.TraceIdentifier`, в каждый ответ о проблеме, записанный через `AddProblemDetails()`. Это самое полезное поле в теле ответа, когда вы сопоставляете клиентский сбой с серверным журналом, и оно выживает только если вы сохранили словарь расширений.

## Ошибки валидации приходят как член-расширение, а не как свойство

Ошибка валидации ASP.NET Core выглядит в сети так:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The Sku field is required."],
    "Quantity": ["The field Quantity must be between 1 and 100."]
  },
  "traceId": "00-8246...-00"
}
```

`errors` находится на верхнем уровне рядом с `title`, поэтому попадает в `Extensions` с `ValueKind`, равным `Object`. Чтение обратно умещается в небольшой помощник, и он должен быть защитным: раздел 3.1 RFC 9457 говорит, что член, тип значения которого не совпадает с ожидаемым, ДОЛЖЕН быть проигнорирован, а собственный пример RFC в разделе 3 использует **массив** `errors` из объектов `{detail, pointer}` вместо карты по именам членов, как в ASP.NET Core. Если вы вызываете API вне мира .NET, вы встретите вторую форму.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections.ObjectModel;

public IReadOnlyDictionary<string, string[]> GetValidationErrors()
{
    if (Extensions is null ||
        !Extensions.TryGetValue("errors", out var errors) ||
        errors.ValueKind is not JsonValueKind.Object)
    {
        return ReadOnlyDictionary<string, string[]>.Empty;
    }

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var member in errors.EnumerateObject())
    {
        if (member.Value.ValueKind is not JsonValueKind.Array) continue;
        result[member.Name] = member.Value.EnumerateArray()
            .Where(e => e.ValueKind is JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToArray();
    }
    return result;
}
```

Проверенный вывод на теле ответа выше:

```
Sku: The Sku field is required.
Quantity: The field Quantity must be between 1 and 100.
```

Каждая ветка, которая сдаётся, возвращает пустой словарь вместо выброса исключения, и именно такого поведения раздел 3.2 требует от потребителей: игнорируйте расширения, которых вы не знаете. Если сервер тоже ваш, форма того, что он отдаёт, под вашим контролем через [IProblemDetailsService и ответы валидации minimal API](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Проверка content-type, которой больше нет

Половина ответов на эту тему предупреждает, что `ReadFromJsonAsync` бросает `NotSupportedException: The provided ContentType is not supported`, если ответ не `application/json`. Это было верно в предварительной версии `System.Net.Http.Json` для .NET Core 3.1 и неверно начиная с .NET 5: [dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594) убрал валидацию целиком, закрывая [#38713](https://github.com/dotnet/runtime/issues/38713), и в текущем исходном коде `HttpContentJsonExtensions` нет никакого `ValidateContent`.

Измерено на 10.0.10, на матрице типов содержимого с одним и тем же телом problem+json:

| Content-Type | Тело | Результат |
| --- | --- | --- |
| `application/problem+json` | JSON проблемы | разобрано |
| `application/problem+json; charset=utf-8` | JSON проблемы | разобрано |
| `text/html` | JSON проблемы | **разобрано** |
| `text/plain` | JSON проблемы | разобрано |
| (нет) | JSON проблемы | разобрано |
| `text/html` | `<html/>` | `JsonException: '<' is an invalid start of a value` |
| `application/problem+json` | пусто | `JsonException: The input does not contain any JSON tokens` |
| `application/problem+json` | `null` | возвращает `null` |

Отсюда следует две вещи. Во-первых, никакого обходного пути для чтения `application/problem+json` не требуется, и не требовалось начиная с .NET 5. Во-вторых, страховки, на которую вы рассчитывали, нет: если шлюз вернёт HTML-страницу ошибки 502, `ReadFromJsonAsync` с готовностью попробует её разобрать и отдаст вам `JsonException` вместо чистого сигнала "это не документ проблемы". Поэтому шаг 4 выше требует проверять тип медиа самостоятельно, и поэтому проверка идёт по `Content.Headers.ContentType?.MediaType`, а не по сырому заголовку, который несёт параметр `charset`.

Заодно: `JsonSerializerOptions.Web` также устанавливает `NumberHandling` в `AllowReadingFromString`, поэтому сервер, который пишет `"status": "402"` строкой, всё равно свяжется с `int?`. Эта деталь играет в вашу пользу.

## Как превратить 4xx в типизированное исключение

Естественным местом для этого служит `DelegatingHandler` на типизированном клиенте, чтобы каждая точка вызова получала поведение без `if` в каждом методе. Исключение наследуется от `HttpRequestException`, поэтому существующие блоки `catch` и политики повторов продолжают работать:

```csharp
// .NET 10 / .NET 11, C# 14
public sealed class ProblemDetailsException(ProblemDetails problem, HttpStatusCode status)
    : HttpRequestException(
        problem.Detail ?? problem.Title ?? "The server returned a problem response.",
        inner: null,
        statusCode: status)
{
    public ProblemDetails ProblemDetails { get; } = problem;
}

public sealed class ProblemDetailsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = await base.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
            return response;

        var json = await response.Content.ReadAsStringAsync(ct);
        var problem = JsonSerializer.Deserialize<ProblemDetails>(json, JsonSerializerOptions.Web);
        if (problem is null) return response;

        throw new ProblemDetailsException(problem, response.StatusCode);
    }
}
```

Регистрация выполняется обычным `IHttpClientFactory`:

```csharp
services.AddTransient<ProblemDetailsHandler>();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://api.example.com"))
        .AddHttpMessageHandler<ProblemDetailsHandler>();
```

И точка вызова получает всё тело ответа там, где раньше был голый код состояния 404:

```
ProblemDetailsException: No order with id abc.
  StatusCode=NotFound  type=https://api.example.com/probs/order-not-found
  orderId extension = abc
  is HttpRequestException: True
```

Обратите внимание на `ReadAsStringAsync` внутри обработчика вместо `ReadFromJsonAsync`. Это не вопрос стиля. На 10.0.10 вызов `ReadFromJsonAsync` на `HttpContent` освобождает буферизованный поток, поэтому второй вызов на том же ответе бросает `ObjectDisposedException: Cannot access a closed Stream`. В обработчике, который иногда возвращает ответ вместо выброса исключения, это означает, что вы уничтожили тело для вызывающего кода. `ReadAsStringAsync` можно повторять, и `ReadAsStringAsync` с последующим `ReadFromJsonAsync` тоже работает; падает только `ReadFromJsonAsync` дважды. Если где-то в цепочке используется `HttpCompletionOption.ResponseHeadersRead`, вызовите `LoadIntoBufferAsync()` перед чтением тела.

Тестирование обработчика сводится к стандартному упражнению с подставным `HttpMessageHandler`, разобранное в статье [Как писать модульные тесты для кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/). Если вы ещё выбираете форму самого клиента, [HttpClient vs HttpClientFactory vs Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/) показывает, куда такой обработчик встаёт в каждом варианте.

## Четыре правила RFC, которые ударят по вам

**`status` носит справочный характер.** Раздел 3.1.2 говорит прямо: "The 'status' member, if present, is only advisory". Он ещё и необязателен. Сервер за прокси, который переписывает статус, оставляет вам тело, заявляющее 409, на ответе HTTP 502. Всегда ветвитесь по `response.StatusCode`, а `ProblemDetails.Status` считайте диагностическим полем, которое вы логируете, а не полем, по которому переключаетесь.

**Ветвитесь по `type`, а не по `title` или статусу.** `type` служит стабильным идентификатором; `title` явно разрешено локализовать, и раздел 3.1 говорит "SHOULD NOT change from occurrence to occurrence" только в пределах одного типа. Когда `type` отсутствует, раздел 3.1.1 говорит, что его значение считается равным `about:blank`, что по разделу 4.2.1 означает "никакой информации сверх кода состояния" и подразумевает, что `title` содержит просто фразу статуса. Приводите отсутствующий или пустой `type` к `about:blank` перед сравнением.

**`type` и `instance` являются URI-*ссылками*, то есть они могут быть относительными.** RFC это разрешает и предупреждает, что "using relative URIs can cause confusion, and they might not be handled correctly by all implementations". Если вы сравниваете `type` с константой, сначала разрешите его: `new Uri(response.RequestMessage!.RequestUri!, pd.Type ?? "about:blank")`.

**Не разыменовывайте `type` и не показывайте `detail` конечным пользователям.** Раздел 5 говорит потребителям, что они "SHOULD NOT automatically dereference the type URI" вне инструментов для разработчиков, а весь смысл `detail` в том, что это серверный текст, специфичный для конкретного случая, и он регулярно раскрывает внутренности. Логируйте его, сопоставляйте по `traceId` и показывайте собственное сообщение.

Ещё два момента поменьше. Заголовки по-прежнему важны: документ проблемы с кодом 429 не несёт задержку повтора в теле, он несёт её в `Retry-After`, так что читайте заголовок. И ответ-проблема не гарантирован на каждый сбой. В моей матрице 429 вернулся без типа содержимого и с телом нулевой длины, то есть ровно тот случай, который проверка типа медиа в обработчике выше пропускает нетронутым.

## Native AOT и trimming

Модель работает с генератором исходного кода `System.Text.Json`, включая `[JsonExtensionData]`, при условии, что словарь имеет один из типов `IDictionary<string, JsonElement>`, `IDictionary<string, object>`, `IDictionary<string, JsonNode>` или `JsonNode`. Всё остальное даёт `SYSLIB1036` во время сборки.

```csharp
// .NET 10 / .NET 11, C# 14
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
public partial class ProblemJsonContext : JsonSerializerContext;

// ...
var problem = await response.Content.ReadFromJsonAsync(ProblemJsonContext.Default.ProblemDetails, ct);
```

Проверено на 10.0.10: путь через генератор разбирает то же тело ответа и сохраняет `4.20` как точное десятичное значение в словаре расширений, потому что `JsonElement` держит сырой текст. Чтение через `GetDecimal()` даёт `4.20`, а не артефакт с плавающей точкой. Для денежных полей это важно, и это ещё одна причина хранить расширения как `JsonElement`, а не как `object`. Если нужно изменить то, что выдаёт генератор, точкой подключения служит [модификатор type info resolver](/ru/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Что может измениться в .NET 12

Есть открытое предложение по API, [dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046), которое переносит всё это в BCL: модель `ProblemDetails` в `System.Net.Http.Json`, `HttpResponseMessage.IsProblemJson()`, `ReadProblemJsonAsync()`, `ThrowIfProblemJsonAsync()` и `ProblemDetailsException`, наследуемый от `HttpRequestException`. Обоснование в предложении то же, с которого начинается эта статья: ссылка на серверный фреймворк "pulls ASP.NET Core into console apps, MAUI apps, Blazor WASM clients, and class libraries that have no business depending on a server framework". Предложение помечено меткой `api-suggestion` для вехи 12.0.0, а значит, его нет в .NET 11 и оно не гарантировано даже для .NET 12.

Пока оно не выпущено, двадцать строк выше составляют весь ответ, и они совместимы с будущим: у предлагаемого типа BCL те же пять свойств и словарь расширений, так что переход на него позже сводится к смене пространства имён и удалению файла.

## Похожие статьи

- [Как настроить ответы об ошибках валидации в minimal API с помощью IProblemDetailsService в ASP.NET Core 11](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [HttpClient vs HttpClientFactory vs Refit: что использовать в .NET 11?](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Как писать модульные тесты для кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Как настроить сериализацию System.Text.Json, сгенерированную генератором исходного кода, с помощью модификатора type info resolver](/ru/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)
- [Framework-dependent vs self-contained vs Native AOT для контейнерного образа .NET 11](/ru/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)

## Источники

- [RFC 9457, Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [Предложение по API: поддержка Problem Details (RFC 9457) в System.Net.Http.Json, dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046)
- [Move ProblemDetails outside of Asp.Net Core, dotnet/aspnetcore#58551](https://github.com/dotnet/aspnetcore/issues/58551)
- [Удаление проверки типа содержимого из ReadFromJsonAsync, dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594)
- [Справочник по классу ProblemDetails на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.problemdetails)
- [Исходный код DefaultProblemDetailsWriter в dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Extensions/src/DefaultProblemDetailsWriter.cs)
- [SYSLIB1036: требования к типу для JsonExtensionData](https://learn.microsoft.com/en-US/dotnet/fundamentals/syslib-diagnostics/syslib1036)
