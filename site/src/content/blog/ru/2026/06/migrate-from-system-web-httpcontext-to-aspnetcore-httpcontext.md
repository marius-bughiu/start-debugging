---
title: "Миграция с System.Web.HttpContext на Microsoft.AspNetCore.Http.HttpContext"
description: "Практическая миграция с System.Web.HttpContext из ASP.NET Framework на HttpContext в ASP.NET Core 11: HttpContext.Current, карта свойств, Server.MapPath, Session и слой совместимости адаптеров System.Web для инкрементальных миграций."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "httpcontext"
  - "system-web"
lang: "ru"
translationOf: "2026/06/migrate-from-system-web-httpcontext-to-aspnetcore-httpcontext"
translatedBy: "claude"
translationDate: 2026-06-06
---

Единственная строка, которая ломает больше миграций ASP.NET Framework, чем любая другая, это `HttpContext.Current`. В ASP.NET Core её не существует. Нет статического окружающего контекста, к которому можно обратиться из произвольного класса, тип `HttpContext` это другой тип в другом пространстве имён (`Microsoft.AspNetCore.Http.HttpContext`, а не `System.Web.HttpContext`), и большинство свойств, на которые вы полагались, переместились, изменили форму или исчезли. Эта статья сопоставляет старый API с новым для .NET 11 / ASP.NET Core 11, а затем показывает два реальных пути вперёд: чистое переписывание для кода, который вы контролируете, и официальные адаптеры `System.Web`, когда у вас есть куча общих библиотек, которые передают `HttpContext` туда-сюда и не могут быть переписаны за один проход.

Для небольшого обработчика или одного контроллера переписывание это час. Для монолита, где `HttpContext.Current` протянут через слой бизнес-логики в отдельной сборке, закладывайте дни и берите адаптеры, чтобы библиотеки продолжали компилироваться под оба фреймворка, пока вы мигрируете приложение за приложением. Ничего в HTTP-семантике не меняется; меняется то, как вы достаёте запрос, что время жизни теперь строго привязано к запросу, и что нет привязки к потоку, на которую можно опереться.

## Почему эта миграция не "найти и заменить"

`System.Web.HttpContext` и `Microsoft.AspNetCore.Http.HttpContext` это по-настоящему разные объекты, и различия поведенческие, а не только косметические:

- **`HttpContext.Current` исчез.** ASP.NET Framework давал каждому запросу привязку к потоку, поэтому статический аксессор мог найти правильный контекст по текущему потоку. ASP.NET Core такой гарантии не даёт, поэтому нет ничего эквивалентного, что можно прочитать статически. Вместо этого вы внедряете контекст.
- **Контекст не может пережить запрос.** В ASP.NET Core контекст переиспользуется в конце запроса. Обращение к нему после этого (захваченная ссылка в задаче fire-and-forget, закешированное поле) бросает `ObjectDisposedException`. На Framework это часто "работало" по случайности.
- **Нет привязки к потоку.** Один запрос может переходить между потоками через точки `await`. Чтение и запись `HttpContext` конкурентно теперь это состояние гонки, которое принадлежит вам.
- **Чтение и запись становятся асинхронными.** `Response.Write` превращается в `await Response.WriteAsync`. Чтение формы или тела это `await ReadFormAsync()` / чтение потока. Заголовки и cookie ответа должны быть установлены до начала ответа.

Собственное [руководство по миграции HttpContext](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0) от Microsoft описывает это как две стратегии, и выбор определяет всё дальнейшее: полное переписывание или адаптеры `System.Web` для инкрементального перехода.

## Что ломается

| Область | ASP.NET Framework | ASP.NET Core 11 | Серьёзность |
| --- | --- | --- | --- |
| Окружающий контекст | `HttpContext.Current` | `IHttpContextAccessor` (зарегистрировать через `AddHttpContextAccessor`) | высокая |
| Время жизни контекста | Иногда пригоден после запроса | `ObjectDisposedException` после завершения запроса | высокая |
| Потокобезопасность | Запрос с привязкой к потоку | Нет привязки к потоку через `await` | высокая |
| Запись в ответ | `Response.Write(s)` | `await Response.WriteAsync(s)` | средняя |
| Чтение формы / тела | `Request.Form`, `Request.InputStream` (sync) | `await Request.ReadFormAsync()`, `Request.Body` (читается один раз) | средняя |
| Заголовки / cookie ответа | Устанавливать в любой момент | Устанавливать до начала ответа (или через `OnStarting`) | средняя |
| Физические пути | `Server.MapPath("~/x")` | `IWebHostEnvironment.ContentRootPath` / `WebRootPath` + `Path.Combine` | средняя |
| Session | `Session["k"]`, авто-сериализация, с блокировкой | `HttpContext.Session.GetString/SetString`, на основе байтов, без блокировки | средняя |
| HTML-кодирование | `Server.HtmlEncode` | `System.Net.WebUtility.HtmlEncode` / `HtmlEncoder` | низкая |
| URL запроса | `Request.Url`, `Request.RawUrl` | `Request.Scheme/Host/Path/QueryString` или `GetDisplayUrl()` | низкая |

## Контрольный список перед стартом

- Установите SDK .NET 11 (`dotnet --version` сообщает `11.x`). Зафиксируйте `<TargetFramework>net11.0</TargetFramework>` в веб-проекте.
- Инвентаризируйте каждую ссылку на `HttpContext.Current`. `grep -rn "HttpContext.Current"` по всему решению это честная оценка объёма.
- Инвентаризируйте `Server.MapPath`, `Session[`, `Request.Url`, `Response.Write` и `Request.ServerVariables`. Это нарушители второго уровня.
- Решите по каждой сборке: переписать на нативный ASP.NET Core или сохранить `System.Web.HttpContext` и добавить пакет адаптера. Общие библиотеки, которые должны продолжать обслуживать ещё не мигрированное Framework-приложение, это кандидаты на адаптеры.
- Имейте зелёный набор тестов до того, как что-либо трогать. Миграция механическая, и проходящий набор это то, чем вы держите её честной.

## Шаги миграции

### Шаг 1: Зарегистрируйте аксессор и перестаньте тянуться к HttpContext.Current

Замените окружающий доступ явным внедрением. В `Program.cs`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddHttpContextAccessor(); // enables IHttpContextAccessor

var app = builder.Build();
app.MapControllers();
app.Run();
```

Сервис, который раньше читал `HttpContext.Current`, теперь принимает `IHttpContextAccessor`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class CurrentUserService(IHttpContextAccessor accessor)
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

Не кешируйте `accessor.HttpContext` в поле. Читайте его в точке использования каждый раз, потому что поле захватило бы контекст одного запроса и передало бы его другому, или никакому. Внутри контроллера или minimal API у вас уже есть `HttpContext` как свойство или параметр, поэтому предпочитайте передавать его явно и пропускайте аксессор полностью.

**Проверьте:** решение компилируется без ссылок на `System.Web` в переписанных проектах, и запрос, который задействует `CurrentUserService`, возвращает ожидаемый id пользователя.

### Шаг 2: Переведите свойства запроса

Большинство членов `Request` переместились, а не исчезли. Сопоставление, покрывающее распространённые случаи:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
string method      = httpContext.Request.Method;          // was HttpMethod
bool   isHttps     = httpContext.Request.IsHttps;         // was IsSecureConnection
string? remoteIp   = httpContext.Connection.RemoteIpAddress?.ToString(); // was UserHostAddress
string userAgent   = httpContext.Request.Headers.UserAgent.ToString();

// Query string: IQueryCollection, indexer never throws on a missing key
string q = httpContext.Request.Query["key"].ToString(); // "" if absent

// Full URL: no single Request.Url anymore
// using Microsoft.AspNetCore.Http.Extensions;
string url = httpContext.Request.GetDisplayUrl();
```

Чтение формы или тела асинхронно, и тело это поток только для чтения вперёд, который можно прочитать один раз:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
if (httpContext.Request.HasFormContentType)
{
    IFormCollection form = await httpContext.Request.ReadFormAsync();
    string firstName = form["firstname"].ToString();
}
```

**Проверьте:** обратитесь к конечной точке, которая читает query, форму и заголовок; убедитесь, что значения совпадают с тем, что Framework-приложение возвращало для того же запроса.

### Шаг 3: Переведите ответ и учитывайте, когда можно устанавливать заголовки

Запись асинхронна, и заголовки и cookie должны быть установлены до того, как тело начнёт передаваться:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.StatusCode = StatusCodes.Status200OK;
httpContext.Response.ContentType = "application/json";
httpContext.Response.Headers["X-Custom"] = "value"; // before first write
await httpContext.Response.WriteAsync(payload);
```

Если вы в middleware и вам нужно установить заголовки прямо перед отправкой ответа, используйте обратный вызов вместо того, чтобы устанавливать их поздно:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.OnStarting(static state =>
{
    var ctx = (HttpContext)state;
    ctx.Response.Headers["X-Late"] = "value";
    return Task.CompletedTask;
}, httpContext);
```

**Проверьте:** осмотрите заголовки ответа через `curl -i`; убедитесь, что заголовок присутствует и вы не получаете исключение `response has already started` под нагрузкой.

### Шаг 4: Замените Server.MapPath на IWebHostEnvironment

У `Server.MapPath("~/App_Data/x.json")` нет эквивалента. Внедрите `IWebHostEnvironment` и комбинируйте пути самостоятельно:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class FileService(IWebHostEnvironment env)
{
    public string DataPath(string name) =>
        Path.Combine(env.ContentRootPath, "App_Data", name); // project root
    public string AssetPath(string name) =>
        Path.Combine(env.WebRootPath, name);                 // wwwroot
}
```

`ContentRootPath` это корень проекта (старый `~/`), `WebRootPath` это `wwwroot` (старый корень статических файлов). Для HTML-кодирования `Server.HtmlEncode` превращается в `System.Net.WebUtility.HtmlEncode` или, в DI, во внедрённый `HtmlEncoder`.

**Проверьте:** запрос, который загружает файл, разрешается в тот же абсолютный путь, который вы ожидаете, как на Windows, так и на Linux (`Path.Combine` делает его переносимым).

### Шаг 5: Перенесите Session, зная, что она ведёт себя иначе

Session в ASP.NET Core подключаемая, на основе байтов, не сериализуется автоматически и не предлагает блокировки на запрос. Зарегистрируйте её:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
// ...
app.UseSession(); // before endpoints
```

Затем замените индексатор на типизированные помощники:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Session.SetString("user", "marius"); // was Session["user"] = "marius"
string? user = httpContext.Session.GetString("user");
httpContext.Session.SetInt32("count", 3);
```

Хранение объекта означает, что вы сериализуете его сами (например, через `System.Text.Json`) и вызываете `SetString`. Нет автоматической объектной session, как была у Framework. [Руководство по миграции session](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0) стоит прочитать, если вы полагались на блокировку session.

**Проверьте:** установите значение в одном запросе, прочитайте его обратно в следующем; убедитесь, что оно переживает между запросами с тем же cookie session.

## Когда переписывание слишком велико: адаптеры System.Web

Если `HttpContext` вплетён через библиотеки классов, которые также вызывает ещё не мигрированное Framework-приложение, переписать каждую сигнатуру разом нереально. Microsoft поставляет [адаптеры System.Web](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0) именно для этого. Они переопределяют форму `System.Web.HttpContext` поверх контекста ASP.NET Core, так что библиотека может нацелиться на `netstandard2.0` и обслуживать оба рантайма.

Пакеты, которые вы увидите:

- `Microsoft.AspNetCore.SystemWebAdapters`: сам слой совместимости, на который ссылаются общие библиотеки. Нацелен на .NET Standard 2.0, .NET Framework 4.5+ и .NET 5+.
- `Microsoft.AspNetCore.SystemWebAdapters.CoreServices`: на него ссылается ASP.NET Core-приложение для настройки поведения. Нацелен на .NET 6+.
- `Microsoft.AspNetCore.SystemWebAdapters.FrameworkServices`: на него ссылается Framework-приложение во время инкрементальной миграции.

В ASP.NET Core-приложении вы включаете их:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddSystemWebAdapters();
// ...
app.UseSystemWebAdapters();
```

Библиотека, которая принимала `System.Web.HttpContext`, продолжает компилироваться после того, как вы замените ссылку на `System.Web` пакетом адаптера. Чтобы преобразовывать между двумя представлениями внутри запроса, вы используете кешированные преобразования, что позволяет переписывать точечные места вызова инкрементально:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
// Microsoft.AspNetCore.Http.HttpContext -> System.Web.HttpContext
System.Web.HttpContext legacy = coreContext.AsSystemWeb();
// System.Web.HttpContext -> Microsoft.AspNetCore.Http.HttpContext
HttpContext core = legacy.AsAspNetCore();
```

Адаптеры не бесплатны. Они добавляют накладные расходы по сравнению с нативными API, поддерживаются не все члены, и два поведения нужно включать, потому что ASP.NET Core не предоставляет их по умолчанию: поток запроса с поиском и полной буферизацией (`PreBufferRequestStream`) и буферизованный ответ (`BufferResponseStream`). Если библиотека читает тело дважды или полагается на `Response.End()`, включите их на соответствующих конечных точках:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapDefaultControllerRoute()
   .PreBufferRequestStream()
   .BufferResponseStream();
```

## Верификация

После миграции пройдитесь по этому списку:

- `dotnet build` не сообщает предупреждений про `System.Web` в проектах, которые вы переписали.
- `dotnet test` проходит без пропущенных тестов HTTP-контекста.
- Дымовой тест горячих путей: вход (claims через `HttpContext.User`), POST формы, скачивание файла, цикл туда-обратно с session.
- Проведите короткий нагрузочный тест и следите за `ObjectDisposedException` или `response has already started`. Эти два исключения это сигнатура бага с захваченным контекстом или поздней записи заголовков.

## Откат

Это миграция кода, а не миграция данных, поэтому откат это `git revert` ветки. Единственное, за чем нужно следить, это формат состояния session: session ASP.NET Core несовместима на уровне формата с session ASP.NET Framework, поэтому, если вы переключили продакшен-трафик и у пользователей есть живые сессии, откат сбрасывает эти сессии и принуждает к повторному входу. Дайте им завершиться или примите это. Больше ничего здесь не одностороннее.

## Подводные камни, которые стоит знать до старта

- **Захваченный `HttpContext` в фоновой работе.** Самый частый сбой в продакшене: контроллер запускает `Task.Run(() => DoWork(HttpContext))`, и контекст уже освобождён к тому моменту, когда `DoWork` его читает. Сначала скопируйте то, что вам нужно, в обычный объект. Это та же ловушка освобождённого контекста, которая кусает `DbContext` из EF Core в коде fire-and-forget.
- **`accessor.HttpContext` равен null вне запроса.** В hosted service или задаче запуска запроса нет, поэтому аксессор возвращает null. Это правильно, а не баг. У фоновых сервисов есть свой [паттерн scoped-сервисов](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **Чтение тела дважды.** `Request.Body` только для чтения вперёд. Если связывание модели уже его потребило, последующее чтение ничего не получает. Используйте `EnableBuffering()` или `PreBufferRequestStream` адаптеров. Синхронные чтения также бросают исключение, если вы их не разрешите, что является той же первопричиной за исключением [synchronous operations are disallowed](/ru/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).
- **Порядок регистрации DI.** Если сервис, которому нужен `IHttpContextAccessor`, не может его разрешить, вы забыли `AddHttpContextAccessor()`, что всплывает как знакомая ошибка [unable to resolve service for type](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

Если вы делаете это в рамках более широкого перехода между фреймворками, это вписывается в более крупную [миграцию с .NET Framework 4.8 на .NET 11](/ru/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/), и вы, вероятно, также будете заменять модель хостинга на том же шаге, когда [мигрируете с IWebHostBuilder на WebApplication.CreateBuilder](/ru/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/). Для новых конечных точек, написанных во время миграции, стоит взвесить компромиссы [minimal API против контроллеров](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), прежде чем переносить старую форму контроллера дословно.

## Источники

- [Миграция HttpContext из ASP.NET Framework на ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0)
- [Адаптеры System.Web (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0)
- [Доступ к HttpContext в ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-context?view=aspnetcore-10.0)
- [Миграция состояния session с ASP.NET на ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0)
- [dotnet/systemweb-adapters (GitHub)](https://github.com/dotnet/systemweb-adapters)
