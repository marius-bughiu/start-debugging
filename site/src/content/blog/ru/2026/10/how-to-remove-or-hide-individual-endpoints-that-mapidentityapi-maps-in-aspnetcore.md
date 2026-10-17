---
title: "Как удалить или скрыть отдельные endpoint, которые MapIdentityApi добавляет в ASP.NET Core"
description: "MapIdentityApi<TUser>() добавляет десять endpoint и не позволяет пропустить ни один из них. Вот четыре проверенных способа справиться с этим на .NET 11: скрыть endpoint из OpenAPI, заставить его возвращать 404, перекрыть его или полностью убрать из маршрутизации, плюс ловушка /confirmEmail, из-за которой регистрация превращается в 500."
pubDate: 2026-10-17
template: how-to
tags:
  - "aspnetcore"
  - "aspnetcore-11"
  - "identity"
  - "minimal-apis"
  - "openapi"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/10/how-to-remove-or-hide-individual-endpoints-that-mapidentityapi-maps-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-17
---

**Короткий ответ:** у `MapIdentityApi<TUser>()` нет параметра для выбора endpoint, и в .NET 11 RC 2 это по-прежнему так. Метод возвращает `IEndpointConventionBuilder`, а его соглашения выполняются для каждого endpoint, когда итоговый шаблон маршрута уже известен, поэтому `/register` или `/manage/2fa` можно находить по шаблону. Чтобы скрыть endpoint только из документа OpenAPI, добавьте в соглашении `ExcludeFromDescriptionAttribute`. Чтобы сделать его непригодным для использования, дополнительно замените `EndpointBuilder.RequestDelegate` делегатом, который возвращает 404. Чтобы полностью убрать его из маршрутизации, подключите Identity к приватному `IEndpointRouteBuilder` и заново опубликуйте его endpoint через фильтрующий `EndpointDataSource` (около 30 строк, код ниже). Никогда не удаляйте `/confirmEmail`, пока работают `/register` или `/resendConfirmationEmail`: оба выбросят `NotSupportedException` и вернут 500.

Всё ниже запускалось на macOS с SDK 11.0.100-rc.1.26425.128, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0.0-rc.1.26425.128 и хранилищем EF Core InMemory. Я сравнил `IdentityApiEndpointRouteBuilderExtensions.cs` между тегами `v8.0.0`, `v11.0.0-rc.1.26425.128` и `v11.0.0-rc.2.26504.105`: список маршрутов во всех трёх одинаков, а между RC 1 и RC 2 файл не менялся, так что приёмы подходят для .NET 8, 9, 10 и 11.

## Почему нет встроенного способа пропустить endpoint

`MapIdentityApi<TUser>()` это один метод расширения, который создаёт пустую группу маршрутов и добавляет в неё всё:

| Метод | Маршрут | Требуется авторизация |
| --- | --- | --- |
| POST | `/register` | нет |
| POST | `/login` | нет |
| POST | `/refresh` | нет |
| GET | `/confirmEmail` | нет |
| POST | `/resendConfirmationEmail` | нет |
| POST | `/forgotPassword` | нет |
| POST | `/resetPassword` | нет |
| POST | `/manage/2fa` | да |
| GET | `/manage/info` | да |
| POST | `/manage/info` | да |

Затем исходный код оборачивает группу в приватный тип `IdentityEndpointsConventionBuilder` с комментарием, что это сделано "to avoid a potential future behavioral breaking change". Вернуть значение обратно к `RouteGroupBuilder` нельзя, а обработчики это лямбды внутри метода, поэтому и вызвать их самостоятельно тоже нельзя.

Запрос на разделение метода открыт с 2024 года: [dotnet/aspnetcore#55792](https://github.com/dotnet/aspnetcore/issues/55792) ("Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled"), а более общий [dotnet/aspnetcore#50303](https://github.com/dotnet/aspnetcore/issues/50303) о расширяемости тянется со времён превью .NET 8. Оба находятся в milestone Backlog. Пока ни один из них не выйдет, все типичные причины, по которым с этим сталкиваются (публичная регистрация должна быть отключена, 2FA обрабатывается в другом месте, документ OpenAPI не должен рекламировать сброс пароля), приходится решать снаружи.

## Тестовое приложение

Это приложение, в которое подключается каждый из вариантов ниже. Endpoint Identity находятся под `/account`, потому что так их подключает большинство реальных приложений и потому что это влияет на сопоставление маршрутов:

```csharp
// .NET 11 RC 1, Microsoft.AspNetCore.Identity.EntityFrameworkCore 11.0.0-rc.1.26425.128
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ids"));
builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var account = app.MapGroup("/account");
account.MapIdentityApi<IdentityUser>();

app.Run();

class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);
```

Без изменений `/openapi/v1.json` перечисляет все десять маршрутов под `/account`, `POST /account/register` возвращает 200, а анонимный `POST /account/manage/2fa` возвращает 401.

Одна деталь важна для каждого приёма ниже: внутри соглашения `RouteEndpointBuilder.RoutePattern.RawText` это **итоговый** шаблон, включая префикс группы. Если вывести его в журнал из соглашения, получится `/account/register`, `/account/manage/2fa` и так далее, а не `/register`. Сам Identity опирается на это, когда задаёт имя endpoint подтверждения почты. Поэтому сопоставляйте через `EndsWith` или сравнивайте с полным путём с префиксом:

```csharp
// .NET 11 RC 1
string[] blocked = ["/register", "/manage/2fa"];

bool IsBlocked(EndpointBuilder b) =>
    b is RouteEndpointBuilder rb &&
    blocked.Any(p => rb.RoutePattern.RawText!.EndsWith(p, StringComparison.OrdinalIgnoreCase));
```

## Вариант 1: скрыть endpoint только из документа OpenAPI

Если endpoint должен продолжать работать, но не попадать в опубликованный контракт (обычное дело для `/refresh` или `/manage/info` в публичном документе API), добавьте те же метаданные, что добавляет `.ExcludeFromDescription()`:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (IsBlocked(b))
        b.Metadata.Add(new ExcludeFromDescriptionAttribute());
});
```

Измеренный результат: `/account/register` и `/account/manage/2fa` исчезают из `/openapi/v1.json`, а `POST /account/register` по-прежнему возвращает 200. В этом смысл варианта и его предел. Скрытие это документация, а не контроль доступа. Всякий, кто читал документацию по Identity, знает, что маршрут существует.

`ExcludeFromDescriptionAttribute` находится в `Microsoft.AspNetCore.Routing` и реализует `IExcludeFromDescriptionMetadata`, который учитывают и встроенный генератор `Microsoft.AspNetCore.OpenApi`, и API explorer в Swashbuckle. Если вы хотите держать всё в одном месте, ту же фильтрацию можно сделать в трансформере документа, как показано в [статье о трансформерах операций и схем OpenAPI](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/), но подход с метаданными проще и охватывает также других потребителей API explorer.

## Вариант 2: оставить маршрут, но возвращать 404

Чтобы действительно отключить endpoint, замените его делегат запроса в том же соглашении. Соглашения получают `EndpointBuilder` до построения `RouteEndpoint`, а `RequestDelegate` это свойство с сеттером:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (!IsBlocked(b)) return;

    b.Metadata.Add(new ExcludeFromDescriptionAttribute());
    b.RequestDelegate = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    };
});
```

Измеренный результат: `POST /account/register` возвращает 404, оба маршрута пропали из документа OpenAPI, а все остальные endpoint ведут себя как раньше. С `.Finally(...)` вместо `.Add(...)` результат такой же. Соглашения `Finally` выполняются после всех остальных, и это более безопасный выбор, если что-то ещё в вашем конвейере тоже трогает `RequestDelegate`.

Загвоздка в том, что с точки зрения маршрутизации и авторизации endpoint по-прежнему существует. Он сохраняет все свои метаданные, включая `RequireAuthorization()`, который Identity ставит на группу `/manage`. Middleware авторизации выполняется раньше делегата endpoint, поэтому анонимный `POST /account/manage/2fa` по-прежнему возвращает **401**, а не 404. До вашего 404 доходят только аутентифицированные вызывающие. Если цель в том, чтобы не раскрывать само существование endpoint, эта разница видна снаружи.

К тому же результату приводит [фильтр endpoint](/ru/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/), потому что `AddEndpointFilter` работает с любым `IEndpointConventionBuilder`:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().AddEndpointFilter(async (ctx, next) =>
{
    var route = (ctx.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    if (blocked.Any(p => route.EndsWith(p))) return Results.NotFound();
    return await next(ctx);
});
```

Для `/account/register` он тоже вернул 404, но здесь он строго хуже: фильтр выполняется для каждого запроса Identity, endpoint остаются в документе OpenAPI, пока вы не добавите и метаданные, а привязка модели тела запроса к моменту запуска фильтра уже выполнена. Порядок выполнения подробнее разобран в [сравнении фильтров endpoint и middleware](/ru/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/). Используйте подмену делегата.

## Вариант 3: перекрыть маршрут endpoint с более высоким приоритетом

Во многих ответах в интернете предлагают сопоставить собственный endpoint с тем же маршрутом. В наивном виде, `account.MapPost("/register", () => Results.NotFound())` после `MapIdentityApi`, это ничего полезного не даёт: я ожидал `AmbiguousMatchException`, но JSON `POST /account/register` всё равно вернул 200 из обработчика Identity. Endpoint Identity привязывает параметр `[FromBody]`, поэтому несёт метаданные accepts для `application/json`, а политика сопоставления по content-type ставит его выше вашего, который ничего не объявляет. Ваш endpoint молча никогда не выполняется. Задайте ему меньший `Order`, и сопоставитель предпочтёт его ещё до любого такого разрешения ничьей:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>();
account.MapPost("/register", () => Results.NotFound())
    .WithOrder(-1)
    .ExcludeFromDescription();
```

Измеренный результат: `POST /account/register` возвращает 404, а список endpoint теперь содержит и `POST /account/register order=0`, и `POST /account/register order=-1`. Исходный endpoint по-прежнему есть в документе OpenAPI, потому что `ExcludeFromDescription()` применяется только к вашему перекрывающему endpoint. Чтобы скрыть его, нужен вариант 1 сверху.

Перекрытие подходит, когда endpoint нужно **заменить**, а не удалить, например `/register`, который дополнительно требует код приглашения, пока остальной `MapIdentityApi` остаётся стандартным. Для простого удаления это самый неряшливый из четырёх вариантов.

## Вариант 4: полностью убрать endpoint из маршрутизации

Чтобы endpoint действительно не существовал (ни маршрута, ни записи в OpenAPI, ни 401 для анонимных вызывающих, только тот же 404, что и для любого неизвестного URL), нужно не дать его `RouteEndpoint` попасть в систему маршрутизации. `MapIdentityApi` использует только два члена переданного ему `IEndpointRouteBuilder`: `ServiceProvider` для получения сервисов и `DataSources`, куда `MapGroup("")` добавляет свой источник endpoint. Это и даёт точку подключения:

1. Передайте `MapIdentityApi` собственный небольшой `IEndpointRouteBuilder`, у которого коллекция `DataSources` приватная.
2. Оберните эту приватную коллекцию в `EndpointDataSource`, который отбрасывает ненужные endpoint.
3. Добавьте обёртку в `DataSources` настоящего построителя маршрутов.

```csharp
// .NET 11 RC 1, works the same on .NET 8, 9 and 10
using Microsoft.Extensions.Primitives;

static class IdentityApiExceptExtensions
{
    public static IEndpointConventionBuilder MapIdentityApiExcept<TUser>(
        this IEndpointRouteBuilder endpoints, params string[] excludedRoutes)
        where TUser : class, new()
    {
        var capture = new CapturingRouteBuilder(endpoints);
        var conventions = capture.MapIdentityApi<TUser>();

        bool Keep(Endpoint e) =>
            e is not RouteEndpoint re ||
            !excludedRoutes.Any(r =>
                re.RoutePattern.RawText!.EndsWith(r, StringComparison.OrdinalIgnoreCase));

        endpoints.DataSources.Add(new FilteringEndpointDataSource(capture.DataSources, Keep));
        return conventions;
    }

    private sealed class CapturingRouteBuilder(IEndpointRouteBuilder inner) : IEndpointRouteBuilder
    {
        public ICollection<EndpointDataSource> DataSources { get; } = new List<EndpointDataSource>();
        public IServiceProvider ServiceProvider => inner.ServiceProvider;
        public IApplicationBuilder CreateApplicationBuilder() => inner.CreateApplicationBuilder();
    }

    private sealed class FilteringEndpointDataSource(
        ICollection<EndpointDataSource> sources, Func<Endpoint, bool> keep) : EndpointDataSource
    {
        private readonly CompositeEndpointDataSource _inner = new(sources);

        public override IReadOnlyList<Endpoint> Endpoints =>
            _inner.Endpoints.Where(keep).ToList();

        public override IReadOnlyList<Endpoint> GetGroupedEndpoints(RouteGroupContext context) =>
            _inner.GetGroupedEndpoints(context).Where(keep).ToList();

        public override IChangeToken GetChangeToken() => _inner.GetChangeToken();
    }
}
```

Использование сводится к правке одной строки:

```csharp
// .NET 11 RC 1
var account = app.MapGroup("/account");
account.MapIdentityApiExcept<IdentityUser>("/register", "/manage/2fa");
```

Измеренный результат: в списке endpoint восемь записей вместо десяти, `/openapi/v1.json` перечисляет восемь путей, а и `POST /account/register`, и анонимный `POST /account/manage/2fa` возвращают 404. Остальные восемь endpoint работают как раньше, а возвращаемый построитель соглашений по-прежнему применяется к ним, так что `.RequireRateLimiting(...)` или `.WithTags(...)`, добавленные в цепочку, ведут себя как обычно.

В этом коде легко ошибиться в двух местах:

- **Переопределите `GetGroupedEndpoints`.** Когда вы вызываете расширение на группе вроде `account`, внешняя группа не читает `Endpoints`. Она вызывает `GetGroupedEndpoints` с префиксом и соглашениями группы. Делегирование этого вызова внутренним источникам позволяет им построить каждый endpoint один раз с полным префиксом и всеми применёнными соглашениями, вместо того чтобы рассчитывать, что базовый класс заново обернёт endpoint, уже построенные без префикса. Именно поэтому `RawText` уже содержит `/account`, когда выполняется `Keep`.
- **Пробросьте токен изменений.** Endpoint Identity статичны, но возврат настоящего токена из внутреннего composite сохраняет корректность источника данных, если что-то ещё когда-нибудь добавит endpoint в захваченную коллекцию.

Это опирается на то, что `MapIdentityApi` использует только `ServiceProvider` и `DataSources`. Так обстоит дело во всех версиях от 8.0 до 11 RC 2, но это деталь реализации. Будущая версия, которая, скажем, вызовет `CreateApplicationBuilder()`, всё равно заработает благодаря делегированию выше. Версия, которая подключает endpoint к какому-то другому построителю, не заработает. Тест, проверяющий ожидаемый список маршрутов (дамп `IEnumerable<EndpointDataSource>`, которым пользовался я, занимает три строки), поймает это при обновлении.

## Ловушка `/confirmEmail`

Единственный endpoint, который нельзя убрать в одиночку, это `GET /confirmEmail`. `/register`, `/resendConfirmationEmail` и ветка смены почты в `POST /manage/info` генерируют ссылку подтверждения по имени endpoint через `LinkGenerator.GetUriByName`. Имя назначается в соглашении `Finally` на `/confirmEmail` как `MapIdentityApi-`, за которым следует итоговый шаблон маршрута.

При варианте 4 и `MapIdentityApiExcept<IdentityUser>("/confirmEmail")` соглашение всё равно выполняется (endpoint строится, затем отфильтровывается), поэтому имя задано, но генератор ссылок не находит endpoint с таким именем. Регистрация после этого падает:

```text
System.NotSupportedException: Could not find endpoint named 'MapIdentityApi-/account/confirmEmail'.
```

Измеренный результат: `POST /account/register` возвращает **500**, как и `POST /account/resendConfirmationEmail`, а `/login` продолжает работать. Если подтверждение почты через этот API вам вообще не нужно, удаляйте `/register` и `/resendConfirmationEmail` вместе с `/confirmEmail` либо оставьте `/confirmEmail` в маршрутизации и только скройте его из OpenAPI вариантом 1.

У варианта 2 такой проблемы нет, потому что endpoint для генерации ссылок продолжает существовать. Он просто отвечает 404.

## Какой вариант выбрать

- **Endpoint в порядке, просто его не должно быть в опубликованном документе:** вариант 1.
- **Endpoint не должен работать, а 401 для анонимных вызывающих на `/manage/*` допустим:** вариант 2 с подменой делегата в `Finally`. Это несколько строк, и он не зависит от внутренностей Identity.
- **Endpoint не должен существовать вовсе:** вариант 4.
- **Нужна другая реализация одного endpoint:** вариант 3 плюс вариант 1, чтобы скрыть оригинал.
- **Нужно изменить поведение внутри нескольких endpoint** (дополнительные поля регистрации, вход по имени пользователя, другие ответы с токенами): скопируйте [`IdentityApiEndpointRouteBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) в свой проект и правьте его. Файл распространяется под лицензией MIT, занимает около 490 строк, а DTO запросов и ответов, которые он использует (`RegisterRequest`, `LoginRequest`, `AccessTokenResponse` и так далее), это публичные типы в `Microsoft.AspNetCore.Identity.Data`. Вы теряете автоматические исправления из будущих обновлений фреймворка, так что при обновлении следите за историей файла.

Если вы уже дошли до замены нескольких endpoint, сначала сравните компромиссы в статье [JWT и cookie-аутентификация в ASP.NET Core 11](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/). Bearer-токены, которые выдаёт `MapIdentityApi`, это непрозрачные токены Data Protection, а не JWT, и нередко именно это настоящая причина, по которой команда перерастает эти endpoint.

## Подводные камни

- **Сопоставляйте полный маршрут или осторожно используйте `EndsWith`.** `EndsWith("/info")` совпадает и с `GET`, и с `POST /manage/info`. Если нужно заблокировать только `POST` (именно он может менять почту и пароль), дополнительно проверяйте `b.Metadata.OfType<HttpMethodMetadata>()` в соглашении или `re.Metadata.GetMetadata<HttpMethodMetadata>()` в варианте 4.
- **`/login` и `/refresh` идут вместе.** Если убрать `/refresh`, оставив `/login`, клиенты получат `refreshToken`, которым никогда не смогут воспользоваться. [Разбор refresh-токенов](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) описывает, что именно проверяет `/refresh`.
- **Удаление `/register` не останавливает создание аккаунтов.** `UserManager<TUser>.CreateAsync` по-прежнему доступен вашему собственному коду, а потоки внешнего входа по-прежнему могут создавать пользователей. Блокировка endpoint убирает только маршрут анонимной публичной регистрации.
- **Не начинайте с middleware на основе путей.** Middleware, возвращающий 404 для путей, начинающихся с `/account/register`, работает, но жёстко прописывает префикс группы, выполняется для каждого запроса в приложении и оставляет запись в OpenAPI. Соглашения endpoint знают итоговый шаблон и выполняются один раз, при построении endpoint.
- **Подключайте Identity в отдельную группу.** Вызов `MapIdentityApi` прямо на `app` помещает `/login` и `/register` в корень вашего API. Отдельная группа, как описано в [организации endpoint минимальных API через `MapGroup`](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), также позволяет навесить ограничение частоты и теги только на Identity.

## Связанные материалы

- [Как реализовать refresh-токены в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/), включая случаи, когда `MapIdentityApi` перестаёт быть достаточным.
- [Как организовать endpoint минимальных API с помощью `MapGroup` в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как настроить OpenAPI с помощью трансформеров операций и схем в ASP.NET Core 11](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Фильтры endpoint и middleware в ASP.NET Core 11](/ru/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [JWT и cookie-аутентификация в ASP.NET Core 11](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)

## Источники

- [`IdentityApiEndpointRouteBuilderExtensions.cs` at `v11.0.0-rc.2.26504.105`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.2.26504.105/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs), dotnet/aspnetcore.
- [dotnet/aspnetcore#55792: Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled](https://github.com/dotnet/aspnetcore/issues/55792)
- [dotnet/aspnetcore#50303: Extensibility for Identity Endpoints](https://github.com/dotnet/aspnetcore/issues/50303)
- [Use Identity to secure a Web API backend for SPAs](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization), Microsoft Learn.
- [Route groups and endpoint conventions in minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers#route-groups), Microsoft Learn.
- [`EndpointDataSource` class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.routing.endpointdatasource), Microsoft Learn.
