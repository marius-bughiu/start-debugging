---
title: "Как отдать OpenAPI без Swashbuckle в ASP.NET Core 11"
description: "Swashbuckle исчез из шаблонов ASP.NET Core. Вот как сгенерировать и отдать документ OpenAPI в .NET 11 со встроенным пакетом Microsoft.AspNetCore.OpenApi: AddOpenApi, MapOpenApi, трансформеры, несколько документов, генерация во время сборки и интерфейс поверх."
pubDate: 2026-06-08
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "ru"
translationOf: "2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-08
---

Если вы недавно создали Web API на ASP.NET Core и пошли искать `AddSwaggerGen` и `UseSwagger`, их там не было. Начиная с .NET 9 шаблоны Web API содержат собственный генератор OpenAPI от Microsoft вместо Swashbuckle. Чтобы отдать документ OpenAPI в .NET 11, вы устанавливаете `Microsoft.AspNetCore.OpenApi`, вызываете `builder.Services.AddOpenApi()` и вызываете `app.MapOpenApi()`. Это отдаёт документ по адресу `/openapi/v1.json`. Интерфейса в комплекте нет: если вам нужна интерактивная страница, вы добавляете Scalar или Swagger UI отдельно и направляете его на этот JSON-endpoint. Всё, что ниже, нацелено на .NET 11 с `Microsoft.NET.Sdk.Web` и C# 14, но тот же API существует в .NET 9 и 10.

## Почему Swashbuckle покинул шаблон

Swashbuckle.AspNetCore долгие годы был решением OpenAPI по умолчанию, но это был сторонний пакет, закреплённый в официальных шаблонах, и он сильно отставал от релизов .NET. Эпоха .NET 6 служит поучительным примером: сопровождение Swashbuckle застопорилось, пакет остался без стабильной версии, нацеленной на новейшую среду выполнения, и команды, обновлявшиеся на новую версию .NET, застревали в ожидании зависимости, которой они не владели. Microsoft решила, что генерация OpenAPI достаточно фундаментальна, чтобы поставлять её из коробки, так же как сериализатор JSON и контейнер внедрения зависимостей.

Результатом стал `Microsoft.AspNetCore.OpenApi`. Он по умолчанию генерирует документы [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html), использует [JSON Schema draft 2020-12](https://json-schema.org/specification-links#2020-12), повторно использует поддержку схем `System.Text.Json`, на которую уже опирается остальной фреймворк, и совместим с Native AOT. Единственное, чего он намеренно не делает, это рендеринг интерфейса. Swashbuckle упаковывал одновременно и генератор документов, и веб-ресурсы Swagger UI; Microsoft разделила эти задачи. Фреймворк производит спецификацию, а вы выбираете средство просмотра.

## Два вызова, которые генерируют документ

Добавьте пакет:

```dotnetcli
dotnet add package Microsoft.AspNetCore.OpenApi
```

Затем зарегистрируйте сервисы и отобразите endpoint:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapGet("/todos/{id}", (int id) => new Todo(id, "Write the spec", false));

app.Run();

record Todo(int Id, string Title, bool Done);
```

Запустите приложение и запросите `https://localhost:{port}/openapi/v1.json`. Вы получите полный документ OpenAPI 3.1, описывающий каждый endpoint, который видит обозреватель API, со схемами, выведенными из типов ваших параметров и возвращаемых значений. `AddOpenApi()` регистрирует сервисы документа, а `MapOpenApi()` добавляет route handler, сериализующий документ по запросу.

Имя документа по умолчанию `v1`, поэтому маршрут такой: `/openapi/v1.json`. Шаблон маршрута `MapOpenApi` выглядит как `/openapi/{documentName}.json`. В приведённом выше фрагменте стоит обратить внимание на две вещи. Во-первых, endpoint документа защищён за `IsDevelopment()`. Это собственная рекомендация фреймворка: документ OpenAPI представляет собой полную карту вашей поверхности атаки, поэтому по умолчанию не отдавайте его в публичный интернет. Во-вторых, интерфейса пока нет. Обращение к `/openapi/v1.json` даёт сырой JSON, именно то, что нужно инструментам, но не то, что человек хочет просматривать кликами.

## Принесите свой интерфейс

Это та часть, на которой спотыкаются переходящие со Swashbuckle, где `/swagger` просто работал. В .NET 11 вы выбираете средство просмотра и связываете его с маршрутом документа.

С .NET 9 шаблон по умолчанию склоняется к Scalar. Установите `Scalar.AspNetCore` и отобразите его:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Перейдите на `https://localhost:{port}/scalar`, и вы получите интерактивный справочный интерфейс, который читает документ `/openapi/v1.json`. Scalar автоматически определяет стандартный маршрут, так что в обычном случае больше ничего настраивать не нужно.

Если ваша команда привязана к Swagger UI, он по-прежнему работает. Установите `Swashbuckle.AspNetCore.SwaggerUi` (только ресурсы интерфейса, не генератор) и направьте его на документ:

```csharp
// .NET 11, C# 14
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

Это отдаёт Swagger UI по адресу `/swagger`, читая документ, сгенерированный фреймворком, а не сгенерированный Swashbuckle. ReDoc работает так же: отдайте статический интерфейс и дайте ему URL `/openapi/v1.json`. Фреймворку всё равно, какое средство просмотра вы используете, потому что он владеет только JSON. В качестве замечания по безопасности держите все три интерфейса за проверкой «только для разработки» по той же причине, по которой вы защищаете сам документ.

## Добавьте заголовки, описания и метаданные

У голого документа есть обобщённый заголовок и нет описаний. Вы обогащаете его в двух местах: метаданными для каждого endpoint и трансформерами уровня документа.

Метаданные для каждого endpoint используют те же соглашения minimal API, которые вы уже используете для маршрутизации. `WithSummary`, `WithDescription` и `WithTags` напрямую переходят в операцию:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Для информации уровня документа, такой как заголовок API, версия и контакт, зарегистрируйте трансформер документа. Трансформер выполняется над сгенерированным `OpenApiDocument` до его сериализации, так что вы можете задать или переписать что угодно:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi.Models;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints for the Start Debugging sample.",
            Contact = new OpenApiContact { Name = "API team", Email = "api@example.com" }
        };
        return Task.CompletedTask;
    });
});
```

Трансформеры представляют собой точку расширения, которая заменяет большую часть того, что вы делали с фильтрами Swashbuckle. Их три вида, и они выполняются в порядке их регистрации:

- `AddDocumentTransformer` изменяет весь документ. Используйте его для `Info`, `servers`, схем безопасности верхнего уровня и тегов.
- `AddOperationTransformer` выполняется один раз для каждой операции. Используйте его, чтобы добавить общий ответ, параметр заголовка или описание к каждому endpoint.
- `AddSchemaTransformer` выполняется один раз для каждой сгенерированной схемы. Используйте его, чтобы добавить примеры, подправить форматы или пометить свойства.

Распространённая реальная задача состоит в том, чтобы объявить схему безопасности Bearer, чтобы интерфейс показывал кнопку Authorize. Это трансформер документа, который добавляет схему и глобальное требование. Если вы сталкивались со случаем, когда средство просмотра молча игнорирует токен, причина почти всегда в отсутствующей или некорректной схеме безопасности в документе, что я подробно разобрал в [почему ваш токен Bearer игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

Для строго типизированного трансформера вы реализуете `IOpenApiDocumentTransformer` (или эквиваленты для операции и схемы) и регистрируете тип. Это позволяет внедрять сервисы, например чтобы прочитать зарегистрированные схемы аутентификации и эмитировать соответствующие определения безопасности:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };
        return Task.CompletedTask;
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

## Сгенерируйте более одного документа

Swashbuckle обрабатывал «v1 и v2» или «публичный и внутренний» через несколько вызовов `SwaggerDoc`. Встроенный генератор делает это через несколько вызовов `AddOpenApi`, каждый со своим именем и опциями:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public");
builder.Services.AddOpenApi("internal");
```

Каждый именованный документ получает собственный маршрут: `/openapi/public.json` и `/openapi/internal.json`. Какие endpoint попадают в какой документ, решает делегат `ShouldInclude` на `OpenApiOptions`. По умолчанию он использует имя группы endpoint, заданное через `WithGroupName` или атрибут `[EndpointGroupName]`, и любой endpoint без имени группы включается в каждый документ. Вы можете заменить `ShouldInclude` любым предикатом над `ApiDescription`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
```

Если у вас работает версионирование API, библиотеки версионирования интегрируются с этой же моделью документа, а не борются с ней, что является реальным улучшением по сравнению со старой настройкой. См. [Asp.Versioning со встроенным OpenAPI](/ru/2026/04/api-versioning-openapi-dotnet-10/) для шаблона «документ на версию».

## Сгенерируйте документ во время сборки

Отдавать документ по HTTP подходит для разработки, но иногда вам нужен файл JSON как артефакт сборки: чтобы зафиксировать его в системе контроля версий, чтобы прогонять по нему контрактные тесты, чтобы скормить [генератору клиентского кода](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) или чтобы отдавать его как статический файл в продакшене вместо открытия живого endpoint. Для этого добавьте пакет для сборки:

```dotnetcli
dotnet add package Microsoft.Extensions.ApiDescription.Server
```

С установленным пакетом `dotnet build` эмитирует документ в `obj/` с именем проекта. Чтобы управлять тем, куда он попадает и генерируется ли он, задайте свойства MSBuild в `.csproj`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>
</PropertyGroup>
```

`OpenApiDocumentsDirectory` разрешается относительно файла проекта, так что значение выше кладёт JSON рядом с `.csproj`. Чтобы переименовать файл или выбрать один документ, когда вы генерируете несколько, используйте `OpenApiGenerateDocumentsOptions`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocumentsOptions>--file-name my-api --document-name public</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

Генерация во время сборки работает за счёт запуска точки входа вашего приложения против заглушки сервера, так что ваш `Program.cs` реально выполняется. Это значит, что код запуска, чтение конфигурации и регистрации внедрения зависимостей: всё это выполняется во время сборки. Если что-то в запуске не должно выполняться в этом контексте, например подключение к базе данных, оградите это проверкой имени входной сборки:

```csharp
// .NET 11, C# 14
using System.Reflection;

if (Assembly.GetEntryAssembly()?.GetName().Name != "GetDocument.Insider")
{
    builder.Services.AddDbContext<AppDbContext>(/* ... */);
}
```

Одно текущее ограничение: генерация во время сборки производит только JSON. Вывод YAML поддерживается во время выполнения (дайте `MapOpenApi` маршрут `.yaml`), но пока не во время сборки.

## Нюансы, которые стоит знать перед выпуском

**Документ перегенерируется на каждый запрос.** `MapOpenApi` прогоняет весь конвейер генерации каждый раз при обращении к endpoint, намеренно, чтобы трансформеры могли реагировать на живое состояние. Для часто запрашиваемого документа вы можете кешировать его с помощью кеша вывода и `.CacheOutput()` на endpoint или просто опереться на генерацию во время сборки и отдавать статический файл.

**По умолчанию версия спецификации 3.1, и это может сломать старые инструменты.** Некоторые потребители всё ещё понимают только OpenAPI 3.0. Если нижестоящий генератор давится документом 3.1, понизьте версию явно:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

Во время сборки эквивалентом служит `<OpenApiGenerateDocumentsOptions>--openapi-version OpenApi3_1</OpenApiGenerateDocumentsOptions>`.

**У endpoint по умолчанию нет авторизации.** Если вы всё же отдаёте документ за пределами разработки, оградите его. `MapOpenApi()` возвращает endpoint convention builder, так что `app.MapOpenApi().RequireAuthorization("SomePolicy")` работает так же, как на любом minimal endpoint.

**Он документирует только то, что видит обозреватель API.** Endpoint minimal API обнаруживаются автоматически, но если вы возвращаете `IResult` без типизированной перегрузки или вызова `Produces`, генератор не может вывести схему ответа. Аннотируйте через `Produces<T>` и `Accepts<T>`, чтобы документ был точным. Это та же дисциплина, которую minimal API вознаграждают в других местах, и она хорошо сочетается с организацией endpoint через [MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), поскольку соглашения уровня группы вроде `WithTags` переходят в каждую операцию группы.

Ментальный переход от Swashbuckle невелик, как только вы его усвоите: фреймворк владеет документом, трансформеры заменяют фильтры, а интерфейс представляет собой отдельную, заменяемую задачу. Вы пишете две строки, чтобы получить JSON, ещё одну строку, чтобы получить средство просмотра, и горстку трансформеров, чтобы привести документ в презентабельный вид. Ничто не привязано к пакету, который выходит по чужому графику.

## Связанное чтение

- [Как организовать endpoint minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как добавить потоки аутентификации OpenAPI в Swagger UI в .NET 11](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Как сгенерировать строго типизированный клиентский код из спецификации OpenAPI в .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar в ASP.NET Core: почему ваш токен Bearer игнорируется](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Источники

- [Generate OpenAPI documents, документация ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Use the generated OpenAPI documents, документация ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Customize OpenAPI documents, документация ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Microsoft.AspNetCore.OpenApi на NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server на NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
