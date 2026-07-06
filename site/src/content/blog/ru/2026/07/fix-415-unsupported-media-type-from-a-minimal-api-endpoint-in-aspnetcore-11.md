---
title: "Исправление: \"415 Unsupported Media Type\" от endpoint минимального API в ASP.NET Core 11"
description: "Минимальный API возвращает 415, когда Content-Type запроса не совпадает с тем, что связывает endpoint. Отправьте Content-Type: application/json для типа, связанного с телом, или используйте [FromForm] для форм и загрузки файлов."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ru"
translationOf: "2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-06
---

Endpoint минимального API возвращает `415 Unsupported Media Type`, когда заголовок `Content-Type` тела запроса не совпадает с тем, что пытается связать обработчик маршрута. Самая частая причина: параметр обработчика является сложным типом, связанным из тела, что требует `Content-Type: application/json`, а клиент не отправил тип содержимого, отправил `text/plain` или отправил данные формы. Исправьте это, отправив `Content-Type: application/json` для тела JSON, или аннотируйте параметр атрибутом `[FromForm]`, когда клиент отправляет `application/x-www-form-urlencoded` или `multipart/form-data`. Это проверено на ASP.NET Core 11 на .NET 11 с C# 14; поведение идентично на .NET 8 -- .NET 10.

## Ошибка в контексте

В отличие от большинства исключений, это никогда не доходит до вашего кода. Слой связывания минимального API отклоняет запрос до того, как запустится ваш обработчик, и возвращает клиенту голый `415`. Здесь нет трассировки стека, нет тела `ProblemDetails` по умолчанию, только строка статуса:

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
Date: Mon, 06 Jul 2026 09:12:44 GMT

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.16",
  "title": "Unsupported Media Type",
  "status": 415
}
```

Если вы не подключили `AddProblemDetails()`, вы получите пустое тело только со статусом `415`. В любом случае отсутствие трассировки стека является признаком: это сбой согласования содержимого на уровне фреймворка, а не что-то, выброшенное внутри вашего обработчика. Справочник по связыванию параметров на Microsoft Learn прямо документирует это в своей таблице сбоев связывания: "Wrong content type (not `application/json`), body, 415."

## Почему это происходит

Обработчик маршрута минимального API связывает каждый параметр из источника: маршрута, строки запроса, заголовка, службы из DI или тела запроса. Когда параметр является сложным типом без атрибута `[From*]`, минимальные API определяют, что он приходит из тела запроса, а единственный подключенный по умолчанию читатель тела -- это читатель `System.Text.Json`. Этот читатель зарегистрирован ровно для одного типа содержимого: `application/json`.

Поэтому фреймворк выполняет проверку типа содержимого еще до того, как вызовет `JsonSerializer`. Если входящий `Content-Type` не является `application/json` (или совместимым типом с суффиксом `+json`), читатель тела отклоняет запрос, и минимальные API прерывают обработку с `415`. Он не пытается угадывать. Отсутствующий `Content-Type`, `text/plain`, `application/x-www-form-urlencoded` или `multipart/form-data` -- все они завершаются одинаково, когда целевой параметр ожидает тело JSON.

Это отличается от сбоя `400 Bad Request`. `400` означает, что тип содержимого был правильным, но полезная нагрузка JSON была некорректной или нарушила валидацию. `415` означает, что фреймворк даже не пытался прочитать тело, потому что тип содержимого был неправильным. Различение этих двух ситуаций избавляет вас от отладки вашего JSON, когда реальная проблема в заголовке. Три обычных триггера:

- Клиент отправляет тело JSON, но забывает заголовок `Content-Type: application/json` (или прокси удаляет его).
- Клиент отправляет данные формы (`application/x-www-form-urlencoded` или `multipart/form-data`) в обработчик, чей параметр связан из тела JSON.
- Клиент отправляет вендорный или декорированный кодировкой тип содержимого, который читатель JSON не зарегистрирован принимать.

## Минимальное воспроизведение

Вот наименьший endpoint, который производит ошибку. `CreateProduct` является сложным типом без атрибута связывания, поэтому минимальные API связывают его из тела JSON:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();   // so the 415 comes back as problem+json
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);
```

Теперь отправьте тело без заголовка типа содержимого. Каждый из этих вызовов возвращает `415`:

```bash
# .NET 11 -- no Content-Type header at all
curl -i -X POST http://localhost:5000/products \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- wrong Content-Type (curl defaults -d to x-www-form-urlencoded)
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'sku=A-100&name=Widget&quantity=5'

# .NET 11 -- text/plain, even though the payload is valid JSON
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: text/plain" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

Полезная нагрузка в первом и третьем вызовах является совершенно корректным JSON. Это не имеет значения. Читатель определяется заголовком, а не байтами.

## Исправление, подробно

Проработайте эти шаги по порядку. Первый решает подавляющее большинство случаев.

### 1. Отправьте `Content-Type: application/json` для типа, связанного с телом

Если ваш обработчик связывает сложный тип из тела, клиент должен объявить тип содержимого JSON. С `curl` ловушка в том, что `-d` (или `--data`) незаметно устанавливает `application/x-www-form-urlencoded`. Используйте `--json` или задайте заголовок явно:

```bash
# .NET 11 -- curl 7.82+ has a --json shortcut that sets the header for you
curl -i -X POST http://localhost:5000/products \
  --json '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- or set it by hand
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

Из типизированного `HttpClient` используйте `PostAsJsonAsync`, который задает заголовок и сериализует за один вызов. Это самый частый способ случайно исправить или случайно сломать заголовок:

```csharp
// .NET 11, C# 14 -- sets Content-Type: application/json automatically
using System.Net.Http.Json;

var http = new HttpClient { BaseAddress = new Uri("http://localhost:5000") };
var response = await http.PostAsJsonAsync(
    "/products",
    new { sku = "A-100", name = "Widget", quantity = 5 });

response.EnsureSuccessStatusCode();   // 201 Created, no 415
```

Если вы вручную собираете `HttpContent`, используйте `JsonContent.Create(...)` или `StringContent` с заданным типом содержимого. `new StringContent(json)` без типа содержимого по умолчанию устанавливает `text/plain` и дает вам `415`:

```csharp
// .NET 11, C# 14
// WRONG -- StringContent defaults to text/plain -> 415
var bad = new StringContent(json);

// RIGHT -- declare the media type
var good = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
```

В JavaScript `fetch` задайте заголовок явно; `fetch` не добавляет его за вас, когда тело является строкой:

```javascript
// browser fetch -- must set Content-Type or you get 415
await fetch("/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "A-100", name: "Widget", quantity: 5 }),
});
```

### 2. Используйте `[FromForm]` для отправки форм и загрузки файлов

Если клиент действительно отправляет данные формы (отправка HTML-формы `<form>` или загрузка файла), не заставляйте его использовать JSON. Скажите обработчику связывать из формы, а не из тела, аннотируя каждый параметр атрибутом `[FromForm]`. Это переключает ожидаемый тип содержимого endpoint на `application/x-www-form-urlencoded` и `multipart/form-data`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products",
    ([FromForm] string sku, [FromForm] string name, [FromForm] int quantity) =>
        TypedResults.Created($"/products/{sku}", new { sku, name, quantity }));
```

Для загрузки файлов параметр `IFormFile` требует `multipart/form-data`. Согласно документации по минимальным API, минимальные API не связывают все тело запроса напрямую с `IFormFile`; поле должно приходить через кодировку формы, а имя параметра должно совпадать с именем поля формы:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload",
    async ([FromForm] string title, IFormFile file, HttpContext ctx) =>
    {
        await using var stream = File.Create(Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return TypedResults.Ok(new { title, file.FileName, file.Length });
    })
    .DisableAntiforgery();   // see the gotcha below before you copy this line
```

Отправьте его как multipart, и `415` исчезнет:

```bash
# .NET 11 -- multipart, matches the [FromForm] + IFormFile handler
curl -i -X POST http://localhost:5000/upload \
  -F "title=Spec sheet" \
  -F "file=@./spec.pdf"
```

### 3. Удалите charset или вендорный суффикс, который читатель JSON отклоняет

Тип содержимого вроде `application/json; charset=utf-8` принимается, но голый вендорный тип, такой как `application/vnd.myapp+json`, может не приниматься, в зависимости от того, как настроены типы содержимого читателя. Если вы контролируете клиента, который отправляет пользовательский тип содержимого `+json`, и не можете это изменить, зарегистрируйте этот тип содержимого, чтобы читатель тела JSON его распознавал. В минимальных API вы делаете это, настраивая принимаемые типы содержимого запроса для endpoint с помощью `Accepts`, что также питает ваш документ OpenAPI:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .Accepts<CreateProduct>("application/json", "application/vnd.myapp+json");
```

### 4. Прочитайте тело не в формате JSON самостоятельно с помощью HttpRequest

Когда полезная нагрузка вообще не JSON (сырые байты, CSV, пользовательский текстовый формат), прекратите связывать сложный тип и читайте поток напрямую. Свяжите `HttpRequest` (или `Stream`, или `PipeReader`), который минимальные API предоставляют без какой-либо проверки типа содержимого, и разбирайте тело на своих условиях:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- accepts any content type
app.MapPost("/import", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var raw = await reader.ReadToEndAsync();
    // parse `raw` (CSV, custom format, whatever) here
    return TypedResults.Ok(new { bytes = raw.Length });
});
```

Поскольку вы никогда не просили фреймворк десериализовать тело в типизированный параметр, здесь нет проверки типа содержимого, и `415` не может возникнуть на этом endpoint.

## Подводные камни и варианты

Несколько похожих ошибок по ошибке приводят людей на эту страницу, а несколько острых углов задевают даже после исправления:

- **`415` -- это не `406`.** `415 Unsupported Media Type` касается заголовка `Content-Type` тела запроса. `406 Not Acceptable` касается заголовка `Accept` клиента для ответа. Если вы получаете `406`, вы на неправильной странице: сервер не может произвести представление, которое клиент примет, что является проблемой форматтера на выходе, а не на входе.

- **`415` -- это не `400`.** Если тип содержимого правильный, но JSON некорректен или не проходит валидацию, вы получаете `400`, а не `415`. Об этом пути смотрите [как валидировать тела запросов в минимальных API без контроллеров](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), а если вам нужно изменить форму полезной нагрузки `400`, [настройте ответы об ошибках валидации минимального API с помощью IProblemDetailsService](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/). Конкретный вариант с некорректным JSON, строкой даты, которую сериализатор не может разобрать, рассмотрен в [значение JSON не удалось преобразовать](/ru/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

- **Endpoint с `[FromForm]` по умолчанию требует токен защиты от подделки.** Начиная с .NET 8, связанные с формой параметры минимального API запускают валидацию защиты от подделки. Программный клиент (curl, `HttpClient`), который отправляет форму без действительного токена, получает отказ, что читается как проблема типа содержимого, но таковой не является. Либо отправьте токен защиты от подделки, либо вызовите `.DisableAntiforgery()` на endpoint, которые не управляются браузером, как в примере загрузки выше. Не отключайте это огульно на endpoint, куда отправляет данные браузер.

- **Отсутствующий `Content-Type` ведет себя как неправильный.** Некоторые HTTP-клиенты полностью пропускают заголовок для `POST` с телом. С точки зрения фреймворка отсутствующий тип содержимого не является `application/json`, поэтому он не проходит ту же проверку `415`. Всегда задавайте заголовок явно, а не полагайтесь на значение по умолчанию клиента.

- **Обратные прокси и API-шлюзы могут переписать или удалить заголовок.** Если тот же запрос работает напрямую против Kestrel, но возвращает `415` за nginx, YARP или API-шлюзом, проверьте, какой `Content-Type` фактически приходит в приложение. Логируйте `HttpContext.Request.ContentType` в начале конвейера, чтобы увидеть реальное значение, а не то, которое вы думаете, что отправили.

- **Вывод `[ApiController]` -- это концепция контроллеров, а не минимального API.** Если вы мигрировали с контроллеров, помните, что минимальные API определяют связывание из тела для сложных типов тем же способом, но здесь нет атрибута `[Consumes]`, фильтрующего типы содержимого, если вы не добавите `Accepts`. Источник связывания, а не атрибут, определяет тип содержимого.

Ментальная модель, которую стоит держать в голове: `415` минимального API -- это несовпадение между `Content-Type`, который отправил клиент, и читателем тела, который ожидает endpoint. Решите, что должен принимать endpoint: тело JSON, форму, файл или сырой поток, а затем приведите в соответствие заголовок клиента и связывание обработчика. Когда они согласованы, `415` исчезает, и вы возвращаетесь на обычную территорию `400`/`200`.

## Связанные материалы

- [Как валидировать тела запросов в минимальных API без контроллеров в ASP.NET Core 11](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) о пути `400`, когда тип содержимого правильный.
- [Как настроить ответы об ошибках валидации минимального API с помощью IProblemDetailsService в ASP.NET Core 11](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) о придании формы телу ошибки, которое видит клиент.
- [Как организовать endpoint минимального API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) о применении `Accepts` и фильтров к группе endpoint.
- [Минимальные API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) о том, чем обработка типов содержимого различается между двумя моделями.
- [Как настроить аутентификацию JWT bearer в минимальном API в ASP.NET Core 11](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) о слое аутентификации, который стоит перед этими endpoint.

## Источники

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-9.0) (таблица сбоев связывания: неправильный тип содержимого на параметре тела возвращает 415; требования `[FromForm]`, `IFormFile` и `multipart/form-data`; защита от подделки при связывании форм).
- Microsoft Learn, [Minimal APIs quick reference](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-9.0) (метаданные `Accepts`, источники связывания из тела и формы).
- MDN, [415 Unsupported Media Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415) (семантика HTTP: сервер отказывается от типа содержимого полезной нагрузки запроса).
