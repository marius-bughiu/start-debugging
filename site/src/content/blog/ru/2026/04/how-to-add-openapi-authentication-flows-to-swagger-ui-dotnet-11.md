---
title: "Как добавить потоки аутентификации OpenAPI в Swagger UI на .NET 11"
description: "В .NET 11 документ OpenAPI генерирует Microsoft.AspNetCore.OpenApi, а Swagger UI больше не входит в шаблон. Разбор того, как подключить Bearer, OAuth2 с PKCE и OpenID Connect, чтобы кнопка Authorize действительно работала."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "openapi"
  - "swagger"
  - "authentication"
  - "dotnet-11"
template: how-to
lang: "ru"
translationOf: "2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-28
---

В .NET 11 документ OpenAPI создаёт `Microsoft.AspNetCore.OpenApi`, а Swagger UI больше не входит в шаблон проекта. Чтобы кнопка Authorize действительно отправляла заголовки, нужны три части, связанные между собой: document transformer, регистрирующий схему безопасности в документе OpenAPI, глобальное или пооперационное security requirement, чтобы endpoint объявлял, что ему нужно, и middleware Swagger UI (`Swashbuckle.AspNetCore.SwaggerUI`), сконфигурированное настройками OAuth-клиента, если используется OAuth2 или OpenID Connect. Этот пост проводит через Bearer JWT, OAuth2 authorization code с PKCE и OpenID Connect — всё на .NET 11 GA.

Версии, упоминаемые по тексту: .NET 11.0 GA, `Microsoft.AspNetCore.OpenApi` 11.0, `Swashbuckle.AspNetCore.SwaggerUI` 7.x, `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0. Примеры используют minimal API, но те же transformer'ы работают и в MVC-controller'ах.

## Что изменилось со времён .NET 8

В .NET 8 и более ранних версиях `Swashbuckle.AspNetCore` поставлялся по умолчанию. Вы вызывали `AddSwaggerGen()` и в одном месте конфигурировали всё (схемы аутентификации, требования, опции UI). Начиная с .NET 9 шаблон поставляет `Microsoft.AspNetCore.OpenApi` для генерации документа и полностью убирает Swagger UI. .NET 11 сохраняет это разделение.

Для потоков аутентификации это значит две вещи:

1. Документ OpenAPI больше не зона ответственности Swashbuckle, поэтому все примеры с `OperationFilter` и `DocumentFilter` на Stack Overflow устарели. Новая точка расширения — `IOpenApiDocumentTransformer` и `IOpenApiOperationTransformer`.
2. Swagger UI теперь опционален. Если он нужен, ставится `Swashbuckle.AspNetCore.SwaggerUI` (только UI-пакет, около 600 КБ) и направляется на JSON-документ, который выдаёт новый генератор.

Если нужен только UI «попробовать endpoint», [Scalar — более лёгкая альтернатива](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/), читающая тот же документ OpenAPI. Transformer'ы ниже формируют корректную модель безопасности OpenAPI 3.x, поэтому любой UI, уважающий спецификацию, подхватит auth-потоки.

## Минимальная настройка Bearer JWT

Начнём с самой простой схемы: `http` со `bearer` и подсказкой формата JWT. Установите генератор OpenAPI, UI и аутентификацию JWT bearer:

```bash
# .NET 11
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Swashbuckle.AspNetCore.SwaggerUI
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Добавьте document transformer, регистрирующий схему:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header,
            Description = "Paste a JWT issued by your IdP."
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "Bearer"
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

Зарегистрируйте его и отдавайте JSON вместе с UI:

```csharp
// .NET 11, C# 14, Program.cs
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "https://login.example.com/";
        o.Audience = "api://my-api";
    });

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapOpenApi();           // serves /openapi/v1.json
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
});

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/secret", () => "hello").RequireAuthorization();
app.Run();
```

Откройте `/swagger`, нажмите **Authorize**, вставьте токен — и Swagger UI начнёт отправлять `Authorization: Bearer <token>` при каждом вызове. Глобальные `SecurityRequirements` приводят к тому, что каждая операция наследует требование; если нужен публичный endpoint, переопределите его на уровне операции (см. раздел «Несколько схем» ниже).

## OAuth2 authorization code с PKCE

Bearer-конфигурация подходит для сценария «у меня уже есть токен, я его вставлю», но большинству команд нужно, чтобы Swagger UI вёл пользователя через настоящий OAuth-логин. Для SPA-подобных потоков используйте authorization code с PKCE.

Добавьте ещё один transformer:

```csharp
// .NET 11, C# 14
internal sealed class OAuth2SecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oauth2"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OAuth2,
            Flows = new OpenApiOAuthFlows
            {
                AuthorizationCode = new OpenApiOAuthFlow
                {
                    AuthorizationUrl = new Uri($"{authority}/oauth2/authorize"),
                    TokenUrl = new Uri($"{authority}/oauth2/token"),
                    Scopes = new Dictionary<string, string>
                    {
                        ["api://my-api/read"]  = "Read your data",
                        ["api://my-api/write"] = "Write your data"
                    }
                }
            }
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oauth2"
                }
            }] = ["api://my-api/read", "api://my-api/write"]
        });

        return Task.CompletedTask;
    }
}
```

Сторона документа OpenAPI готова. Swagger UI ещё нужно знать, кем *он* представляется IdP, иначе редирект из endpoint authorize упадёт с `invalid_client`:

```csharp
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");

    c.OAuthClientId("swagger-ui");        // public client registered with the IdP
    c.OAuthUsePkce();                     // mandatory for public clients
    c.OAuthScopes("api://my-api/read");
    c.OAuthAppName("Swagger UI for My API");
});
```

Две детали регистрации на стороне IdP, на которых часто спотыкаются:

- Redirect URI должен быть ровно `https://your-host/swagger/oauth2-redirect.html`. Swashbuckle уже отдаёт эту страницу; не придумывайте свою.
- Client должен быть *публичным* (без секрета). Если IdP отказывается работать с публичными клиентами, переходите на client credentials для машина-машина и забудьте про поток в UI.

## OpenID Connect через discovery

Если IdP отдаёт discovery-документ, предпочитайте `openIdConnect` зашитым URL'ам. Swagger UI 7.x читает discovery-документ и сам определяет остальное:

```csharp
// .NET 11, C# 14
internal sealed class OidcSecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oidc"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OpenIdConnect,
            OpenIdConnectUrl = new Uri($"{authority}/.well-known/openid-configuration")
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oidc"
                }
            }] = ["openid", "profile", "api://my-api/read"]
        });

        return Task.CompletedTask;
    }
}
```

Схема `openIdConnect` валидна в OpenAPI 3.x, начиная с 3.0.1, и даёт Swagger UI единый источник правды по `authorization_endpoint`, `token_endpoint` и `scopes_supported`. На практике это самая чистая конфигурация при работе с Microsoft Entra ID, Auth0, Keycloak или любым другим IdP, отдающим `/.well-known/openid-configuration`. На стороне Swagger UI всё равно нужны `OAuthClientId` и `OAuthUsePkce` — discovery-документ покрывает только *серверную* часть контракта.

## Несколько схем и пооперационные требования

В реальных API чаще встречается смесь: пара endpoint'ов принимает API key, остальные требуют OAuth, health-проба анонимна. Уберите глобальный вызов `SecurityRequirements.Add(...)` из document transformer и применяйте требования по операциям.

Добавьте operation transformer, читающий метаданные endpoint'а:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authorization;

internal sealed class SecurityRequirementOperationTransformer
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken ct)
    {
        var endpoint = context.Description.ActionDescriptor.EndpointMetadata;
        var hasAuth   = endpoint.OfType<IAuthorizeData>().Any();
        var anonymous = endpoint.OfType<IAllowAnonymous>().Any();

        if (!hasAuth || anonymous) return Task.CompletedTask;

        var schemeId = endpoint
            .OfType<AuthorizeAttribute>()
            .Select(a => a.AuthenticationSchemes)
            .FirstOrDefault(s => !string.IsNullOrEmpty(s)) ?? "oauth2";

        operation.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = schemeId
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

Зарегистрируйте оба transformer'а рядом:

```csharp
builder.Services.AddOpenApi(o =>
{
    o.AddDocumentTransformer<OAuth2SecuritySchemeTransformer>();
    o.AddDocumentTransformer<ApiKeySecuritySchemeTransformer>();
    o.AddOperationTransformer<SecurityRequirementOperationTransformer>();
});
```

Теперь `[Authorize]` рисует замочек на операции, `[AllowAnonymous]` пропускает её, а `[Authorize(AuthenticationSchemes = "ApiKey")]` рисует замочек нужной схемы. Документ OpenAPI снова выглядит как при старом overload'е `AddSecurityRequirement` в Swashbuckle, но без `OperationFilter`, который надо поддерживать.

## Подводные камни, которые кусают на проде

Несколько вещей не упоминаются в официальной документации, но всплывают в каждой триаге:

**`document.Components` может быть null.** В свежесозданном `OpenApiDocument` свойство `Components` остаётся `null`, пока что-то не присвоит ему значение. Защитная строка `document.Components ??= new OpenApiComponents();` в каждом transformer'е выше — не опциональная. Если секции нет, сериализатор не запишет `components.securitySchemes`, и Swagger UI молча игнорирует ссылку из требования, потому что схема, на которую она указывает, не существует.

**`Reference.Id` обязан совпадать с ключом словаря посимвольно.** Если зарегистрировали схему как `"Bearer"`, а в требовании — `"bearer"`, OpenAPI 3.x считает это неразрешённым `$ref`, Swagger UI рисует замочек, но заголовок не отправляет. Выберите одну капитализацию на приложение и придерживайтесь её.

**Persisted authorization выключен по умолчанию.** Каждая перезагрузка стирает токен. Для удобства разработки включите `c.EnablePersistAuthorization()`. Токен попадает в `localStorage`, поэтому в продовом развёртывании опцию включать нельзя.

**OAuth-redirect URL при не-корневом path base.** Когда приложение работает за reverse proxy на `/api`, Swagger UI собирает редирект как `/api/swagger/oauth2-redirect.html`. Регистрация в IdP должна включать ровно этот путь, иначе callback падает с `redirect_uri_mismatch`. Если редирект выглядит странно — проверьте заголовки `Forwarded` и `UsePathBase`.

**Native AOT.** На момент .NET 11 новый генератор OpenAPI не помечен как trim-safe для произвольных transformer'ов, а статическая отдача `Swashbuckle.AspNetCore.SwaggerUI` хоть и работает под AOT, transformer'ам стоит избегать reflection по закрытым generic'ам. Если вылезли предупреждения `RequiresUnreferencedCode`, обратитесь к [руководству по Native AOT с minimal API](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) — там описан рабочий шаблон.

**Пооперационные требования добавляются, а не заменяют.** Если в документе есть глобальный `SecurityRequirements` *и* operation transformer добавляет своё, оба считаются альтернативами (OR-семантика OpenAPI). Для публичного endpoint'а нужно явно очистить `operation.Security`, а не просто оставить transformer в покое.

## Подключение SwaggerUI с несколькими документами

Если API версионируется и для каждой версии генерируется отдельный документ OpenAPI, dropdown в Swagger UI требует endpoint на каждый из них:

```csharp
app.MapOpenApi("/openapi/{documentName}.json");

app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
    c.SwaggerEndpoint("/openapi/v2.json", "API v2");

    c.OAuthClientId("swagger-ui");
    c.OAuthUsePkce();
});
```

Каждый документ несёт собственный набор `securitySchemes`, поэтому transformer, выполняющийся per-document, вызывается по разу на версию. Хорошая новость: за общим состоянием гнаться не приходится. Плохая: если забыть зарегистрировать transformer для документа v2, замочек будет только в v1. Шаблон чисто стыкуется с `WithDocumentPerVersion()` из `Asp.Versioning` 10.0 (разобрано в [посте про версионирование API](/2026/04/api-versioning-openapi-dotnet-10/)).

## Похожее

- [Scalar in ASP.NET Core: why your Bearer token is ignored (.NET 10)](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Asp.Versioning 10.0 finally plays nicely with built-in OpenAPI in .NET 10](/2026/04/api-versioning-openapi-dotnet-10/)
- [How to generate strongly-typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Источники

- [Документация по кастомизации Microsoft.AspNetCore.OpenApi](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi)
- [Справочник API `IOpenApiDocumentTransformer`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.openapi.iopenapidocumenttransformer)
- [Исходный код Swashbuckle.AspNetCore.SwaggerUI 7.x](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/tree/master/src/Swashbuckle.AspNetCore.SwaggerUI)
- [OpenAPI 3.0.3 security requirement object](https://spec.openapis.org/oas/v3.0.3#security-requirement-object)
