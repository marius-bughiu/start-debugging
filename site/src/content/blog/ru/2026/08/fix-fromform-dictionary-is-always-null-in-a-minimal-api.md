---
title: "Исправление: [FromForm] Dictionary<string, string> всегда null в минимальном API"
description: "Dictionary с [FromForm] в минимальном API связывается с пустым префиксом: ключи формы должны быть [key], а не metadata[key]. Оберните его в класс, чтобы имена остались читаемыми."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ru"
translationOf: "2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-08-20
---

Параметр `[FromForm] Dictionary<string, string>` в минимальном API не использует имя параметра как префикс ключей формы. Маппер формы начинает с корня формы, поэтому он ищет `[author]` и `[env]`, а не `metadata[author]` или `metadata.author`. Отправляйте ключи в квадратных скобках без префикса или, что лучше, оберните словарь в класс и отправляйте `Metadata[author]`, чтобы формат на проводе остался читаемым. Когда ключи не совпадают, в лог ничего не пишется и `400` не возвращается: параметр просто приходит как `null`.

Всё, что описано ниже, измерено на ASP.NET Core 10.0.5 с SDK 10.0.201. Соответствующий код связывания идентичен в ветке `release/11.0`, так что поведение сохраняется и в .NET 11.

## Ошибка в контексте

Искать нечего, исключения нет вообще, и именно поэтому такая задача съедает целый вечер. Обработчик выполняется, файл связывается, а словарь равен `null`:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/broken", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/broken \
  -F "metadata[author]=marius" -F "metadata[env]=prod" -F "file=@a.txt"
```

```text
metadata=null, file=a.txt
```

Тот же `null` возвращается для `metadata.author=marius`, для простого `author=marius` и для запроса, в котором ключей нет вовсе. Код состояния каждый раз `200`.

Исключение появляется только тогда, когда ключи достаточно близки к нужным и маппер начинает их читать. С `Dictionary<string, int>` и значением, которое не парсится:

```text
Microsoft.AspNetCore.Http.BadHttpRequestException: The value 'notanint' is not valid for 'b'.
 ---> Microsoft.AspNetCore.Components.Endpoints.FormMapping.FormDataMappingException
   at Microsoft.AspNetCore.Components.Endpoints.FormMapping.DictionaryConverter`5.TryRead(...)
```

Этот стек вызовов и есть подсказка. Тип, который делает всю работу, находится в `Microsoft.AspNetCore.Components.Endpoints.FormMapping`, в том же слое маппинга форм, который использует Blazor, и соглашения об именах ключей там не те, к которым приучил MVC.

## Почему это происходит

У связывания форм в минимальных API есть два полностью раздельных пути выполнения, и какой из них выберет параметр, решает единственный предикат в `RequestDelegateFactory`:

```csharp
// dotnet/aspnetcore, src/Http/Http.Extensions/src/RequestDelegateFactory.cs, release/10.0
var useSimpleBinding = parameter.ParameterType == typeof(string) ||
    parameter.ParameterType == typeof(StringValues) ||
    parameter.ParameterType == typeof(StringValues?) ||
    ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType) ||
    (parameter.ParameterType.IsArray && ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType.GetElementType()!));
hasTryParse = useSimpleBinding;
return useSimpleBinding
    ? BindParameterFromFormItem(parameter, formAttribute.Name ?? parameter.Name, factoryContext)
    : BindComplexParameterFromFormItem(parameter, string.IsNullOrEmpty(formAttribute.Name) ? parameter.Name : formAttribute.Name, factoryContext);
```

Простое связывание читает `HttpContext.Request.Form[key]`, где `key` это имя параметра. Именно такого поведения все и ожидают, и именно его вы получаете для `string`, `int`, `Guid`, `DateOnly` и любого другого типа с `TryParse`.

У `Dictionary<string, string>` нет `TryParse`, поэтому он попадает в `BindComplexParameterFromFormItem`, который передаёт всю форму общему мапперу:

```csharp
// FormDataMapper.Map<Dictionary<string, string>>(name_reader, FormDataMapperOptions);
var invokeMapMethodExpr = Expression.Call(
    FormDataMapperMapMethod.MakeGenericMethod(parameter.ParameterType),
    formReader,
    Expression.Constant(formDataMapperOptions));
```

Посмотрите на аргументы: ридер и опции. Префикса нет. Значение `key`, вычисленное строкой выше, используется только как ключ словаря в `factoryContext.TrackedParameters` и никогда не помещается в стек префиксов ридера. Поэтому маппер читает словарь от корня формы, а запись словаря на корневом уровне пишется как `[author]`.

В этом и состоит вся проблема: параметр называется `metadata`, но мапперу формы это имя никто не сообщил.

Этим же объясняется, почему поведение выглядит как регрессия при переносе конечной точки с контроллеров. Model binder в MVC сначала пробует имя параметра как префикс, а затем откатывается к пустому префиксу, поэтому action контроллера принимает оба варианта записи:

```csharp
// .NET 10.0.201, controller action, both curl shapes below return the same result
[HttpPost("dict")]
public IActionResult Dict([FromForm] Dictionary<string, string> metadata, IFormFile file)
    => Content($"count={metadata?.Count}");
```

```text
curl -F "metadata[author]=marius" -F "file=@a.txt"   ->  count=1
curl -F "[author]=marius"         -F "file=@a.txt"   ->  count=1
```

Минимальные API принимают только второй. Если вы взвешиваете обе модели хостинга целиком, [минимальные API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) разбирает остальные места, где их семантика связывания расходится.

## Минимальное воспроизведение

Полное приложение плюс формы запроса, которые работают и не работают:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();
app.UseAntiforgery();

app.MapPost("/dict", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();

app.MapPost("/list", ([FromForm] List<string> tags, IFormFile file) =>
    Results.Text($"tags={(tags is null ? "null" : JsonSerializer.Serialize(tags))}"))
   .DisableAntiforgery();

app.Run();
```

Измеренные результаты для этого приложения:

| Запрос | Результат |
| --- | --- |
| `-F "metadata[author]=marius"` | `metadata=null` |
| `-F "metadata.author=marius"` | `metadata=null` |
| `-F "author=marius"` | `metadata=null` |
| `-F "[author]=marius" -F "[env]=prod"` | `metadata={"author":"marius","env":"prod"}` |
| `-F "tags=a" -F "tags=b"` | `tags=null` |
| `-F "tags[0]=a" -F "tags[1]=b"` | `tags=null` |
| `-F "[0]=a" -F "[1]=b"` | `tags=["a","b"]` |

Закономерность единообразна: параметр коллекции `[FromForm]` верхнего уровня адресуется с пустым префиксом, поэтому словари используют `[key]`, а списки `[0]`, `[1]` и так далее. Имя параметра оказывается мёртвым грузом.

## Исправление в деталях

Четыре варианта в том порядке, в котором я бы к ним обращался.

### 1. Оберните словарь в класс

Это исправление стоит выкатывать в продакшен. Свойство класса префикс получает, потому что маппер кладёт имя свойства в свой стек префиксов при спуске, и формат на проводе снова становится тем, что человек может прочитать, а клиентская библиотека сгенерировать.

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadRequest request, IFormFile file) =>
    Results.Text($"request={JsonSerializer.Serialize(request)}, file={file?.FileName}"))
   .DisableAntiforgery();

public class UploadRequest
{
    public Dictionary<string, string> Metadata { get; set; } = new();
}
```

```bash
curl -X POST http://localhost:5222/upload \
  -F "Metadata[author]=marius" -F "Metadata[env]=prod" -F "file=@a.txt"
```

```text
request={"Metadata":{"author":"marius","env":"prod"}}, file=a.txt
```

Сопоставление ключей не зависит от регистра, поэтому `metadata[author]` тоже связывается со свойством `Metadata`. Вложенный словарь может лежать и глубже: `Meta.Tags[a]=1` связывается нормально, если `Meta` сам является свойством.

Файл можно втянуть в тот же класс, и тогда сигнатура конечной точки останется с одним параметром:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadWithFile request) =>
    Results.Text($"metadata={JsonSerializer.Serialize(request.Metadata)}, file={request.File?.FileName}"))
   .DisableAntiforgery();

public class UploadWithFile
{
    public Dictionary<string, string> Metadata { get; set; } = new();
    public IFormFile? File { get; set; }
}
```

Отправка `-F "Metadata[author]=marius" -F "File=@a.txt"` связывает оба значения. Свойство файла сопоставляется по имени свойства, то же правило действует и для параметра `IFormFile` верхнего уровня.

### 2. Оставьте параметр-словарь и поправьте клиент

Если клиент ваш, а сигнатура конечной точки зафиксирована, просто отправляйте корневые ключи в квадратных скобках:

```bash
curl -X POST http://localhost:5222/dict \
  -F "[author]=marius" -F "[env]=prod" -F "file=@a.txt"
```

Это работает, и правка составляет один символ на ключ. Но это же и та форма, которую никто не угадает, читая обработчик через полгода, и она не переживёт второго параметра-словаря (см. подводные камни). Считайте это временной затычкой.

### 3. Прочитайте форму самостоятельно

Самый явный вариант и единственный, который переживает Request Delegate Generator. `IFormCollection` связывается как параметр формы целиком, без всякого слоя маппинга, поэтому соглашение о ключах остаётся за вами:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", (IFormCollection form) =>
{
    var metadata = form
        .Where(kv => kv.Key.StartsWith("metadata[", StringComparison.Ordinal) && kv.Key.EndsWith(']'))
        .ToDictionary(kv => kv.Key[9..^1], kv => kv.Value.ToString());

    return Results.Text($"metadata={JsonSerializer.Serialize(metadata)}, files={form.Files.Count}");
}).DisableAntiforgery();
```

```text
metadata={"author":"marius","env":"prod"}, files=1
```

Многословно, зато принимает `metadata[author]` напрямую и даёт настоящий путь обработки ошибки при некорректном ключе вместо тихого `null`.

### 4. Отправьте метаданные одним полем JSON

Если метаданные действительно произвольные, перестаньте моделировать их ключами формы. Одно поле формы с документом JSON связывается по простому пути, потому что `string` замыкает предикат, приведённый выше:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] string metadata, IFormFile file) =>
{
    var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata);
    return Results.Text($"metadata={JsonSerializer.Serialize(parsed)}, file={file?.FileName}");
}).DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/upload \
  -F 'metadata={"author":"marius","env":"prod"}' -F "file=@a.txt"
```

Это единственный вариант, который даёт вложенные значения, массивы и нестроковые типы без борьбы с синтаксисом ключей, и под AOT он работает точно так же.

## Подводные камни и разновидности

- **`null` это не ошибка валидации.** Тип параметра, `Dictionary<string, string>`, не допускает null, но обработчик всё равно получает `null`, с ответом `200` и без единой записи в логах. Маппер возвращает `default(T)`, когда не находит подходящего ключа, а сложный параметр, связанный из формы, никогда не считается обязательным. Проверяйте на `null` или сделайте параметр nullable, чтобы компилятор напоминал вам об этом. Инициализатор свойства вида `= new()` тоже не спасает: сам объект-обёртка возвращается как `null`, если ни один ключ не совпал с его префиксом.

- **`[FromForm(Name = "metadata")]` не задаёт префикс.** Выглядит как исправление, но им не является. Имя используется для поиска отслеживаемых параметров, а затем отбрасывается до запуска маппера. `[FromForm(Name = "metadata")] Dictionary<string, string> metadata` по-прежнему связывается из `[author]`, а не из `metadata[author]`.

- **Два сложных параметра формы конфликтуют.** Поскольку оба связываются с пустым префиксом, они читают одни и те же ключи. Конечная точка, принимающая `[FromForm] Dictionary<string, string> first, [FromForm] Dictionary<string, string> second`, при получении `[a]=1&[b]=2` возвращает `first={"a":"1","b":"2"} second={"a":"1","b":"2"}`. Никакого предупреждения нет. Одного этого достаточно, чтобы предпочесть класс-обёртку.

- **Массивы и списки ведут себя по-разному.** `List<string> tags` это сложный тип, и ему нужны `[0]`, `[1]`. У `int[] ids` тип элемента поддерживает `TryParse`, поэтому он идёт по простому пути и связывается из повторяющегося `ids=1&ids=2`. А `[FromForm] string[] tags` падает при старте на .NET 10 с `InvalidOperationException: TryParse method found on string with incorrect format`, потому что `string` теперь предоставляет `TryParse` на основе span, который кэш методов связывания отвергает вместо того, чтобы проигнорировать. Это [dotnet/aspnetcore#62326](https://github.com/dotnet/aspnetcore/issues/62326), исправленный в [PR #63072](https://github.com/dotnet/aspnetcore/pull/63072); коммит слияния является предком каждого тега `v11.0.0-preview` и не является предком ни `v10.0.0`, ни `v10.0.5`, так что этот сбой остаётся с вами на весь цикл жизни .NET 10.

- **Два разных лимита, и оба по умолчанию равны 1024.** Отправьте 1025 ключей, и вы получите `InvalidDataException: Form value count limit 1024 exceeded` из `FormPipeReader`, это `FormOptions.ValueCountLimit`. Поднимите его через `services.Configure<FormOptions>(o => o.ValueCountLimit = 5000)`, и упрётесь в следующую стену: `The number of elements in the dictionary exceeded the maximum number of '1024' elements allowed`, это собственный предел маппера. Он задаётся на конечную точку: `.WithFormMappingOptions(maxCollectionSize: 5000)`. Нужны оба, а если поднять только один, кажется, что исправление ничего не дало. Если ваши загрузки велики в байтах, а не в количестве ключей, размерные лимиты разобраны в статье [413 Request Entity Too Large при загрузке файла](/ru/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/).

- **Связывание формы требует настроенного antiforgery.** Любая конечная точка минимального API с параметром, связанным из формы, несёт метаданные antiforgery. Если приложение никогда не вызывает `app.UseAntiforgery()`, запрос завершается с `InvalidOperationException: Endpoint HTTP: POST /upload contains anti-forgery metadata, but a middleware was not found that supports anti-forgery` и кодом `500`. Добавьте middleware или вызовите `.DisableAntiforgery()` на конечных точках для межмашинного взаимодействия. Не отключайте его огульно там, куда отправляет данные браузер.

- **Request Delegate Generator отказывается от всего этого.** Соберите проект с `EnableRequestDelegateGenerator` в значении `true` или с `PublishAot`, и как параметр-словарь, так и класс-обёртка дадут `warning RDG003: Unable to statically resolve parameter named 'metadata' for endpoint`. Конечная точка откатывается к генерации во время выполнения, а это именно то, чего AOT сделать не может. `IFormCollection` предупреждения не вызывает, поэтому вариант 3 и есть безопасная для AOT форма. Остальные диагностики RDG разобраны в статье [как использовать Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

- **Неверный `Content-Type` выглядит как та же самая проблема.** Если запрос приходит как `application/json` вместо `multipart/form-data` или `application/x-www-form-urlencoded`, вы получите `415`, а не тихий `null`. Это другой сбой с другим исправлением, он разобран в статье [415 Unsupported Media Type от конечной точки минимального API](/ru/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/).

Правило, которое стоит запомнить, короткое: в минимальном API параметр `[FromForm]` адресуется по имени только тогда, когда его тип можно разобрать из одной строки. Всё остальное проходит через маппер форм Blazor, который начинает с корня формы и не знает, как называется ваш параметр. Дайте ему класс, внутрь которого можно спуститься, и имена вернутся.

## Похожие материалы

- [Исправление: "415 Unsupported Media Type" от endpoint минимального API в ASP.NET Core 11](/ru/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) для случая, когда форма вообще не доходит до биндера.
- [Исправление: "413 Request Entity Too Large" при загрузке файла в конечную точку ASP.NET Core](/ru/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) про размерные лимиты в байтах, которые срабатывают до разбора формы.
- [Как использовать Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) о том, что Request Delegate Generator умеет и не умеет связывать.
- [Минимальные API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) про более широкий набор различий в связывании между двумя моделями.
- [Как загрузить большой файл потоком в Azure Blob Storage](/ru/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/), чтобы уйти от буферизации `IFormFile`, когда загрузки растут.

## Источники

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-10.0) (связывание формы с коллекциями и сложными типами, таблица коллекций `IFormFile` и замечание о том, что связывание формы со сложными типами и коллекциями не поддерживается под Request Delegate Generator).
- dotnet/aspnetcore, [RequestDelegateFactory.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (предикат `useSimpleBinding` и `BindComplexParameterFromFormItem`, который вызывает `FormDataMapper.Map<T>` без префикса).
- Issue [#62326](https://github.com/dotnet/aspnetcore/issues/62326) и PR [#63072](https://github.com/dotnet/aspnetcore/pull/63072) в dotnet/aspnetcore (падение `[FromForm] string[]` при старте и исправление простого связывания, вышедшее в .NET 11).
- Microsoft Learn, [RDG003: Unable to statically resolve parameter](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG003) (диагностика времени компиляции для параметров, маппящихся из формы, под AOT).
