---
title: "Scalar в ASP.NET Core: почему ваш Bearer-токен игнорируется (.NET 10)"
description: "Если ваш Bearer-токен работает в Postman, но не в Scalar, проблема скорее всего в OpenAPI-документе. Как объявить корректную security-схему в .NET 10."
pubDate: 2026-01-23
tags:
  - "aspnet"
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Scalar всё чаще встречается как чистая UI-альтернатива для OpenAPI-документации в ASP.NET Core. Свежий вопрос на r/dotnet высвечивает частую ловушку: вы вставляете токен в auth-UI Scalar, в Postman всё работает, а вызовы из Scalar по-прежнему стучатся в API без `Authorization: Bearer ...`: [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).

Проблема редко в том, что "JWT-аутентификация сломана". Обычно ваш OpenAPI-документ просто не объявляет правильную HTTP Bearer security-схему, поэтому UI нечего надёжно применить к вашим операциям.

## Scalar следует вашему OpenAPI-контракту, а не middleware

В .NET 10 можно полностью настроить аутентификацию в пайплайне и при этом отдавать OpenAPI-документ, который ничего не говорит про auth. Когда так получается, инструменты ведут себя несогласованно:

-   Postman работает, потому что вы добавляете заголовки вручную.
-   Scalar (или любой другой UI) не может вывести требования безопасности, если их не объявил OpenAPI-документ.

Лучший якорь здесь это собственная документация Scalar по интеграции с ASP.NET Core: [https://scalar.com/products/api-references/integrations/aspnetcore/integration](https://scalar.com/products/api-references/integrations/aspnetcore/integration).

## Объявите Bearer-безопасность в OpenAPI-документе

Если вы используете встроенную поддержку OpenAPI, исправление это добавить transformer, который вшивает схему `http` `bearer` и применяет её к операциям (глобально или выборочно).

Вот нужная форма (обрезано до сути):

```cs
using Microsoft.OpenApi.Models;

// Program.cs (.NET 10)
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer((document, context, ct) =>
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, OpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT"
        };

        // Apply globally (or attach per operation if you prefer)
        document.SecurityRequirements ??= new List<OpenApiSecurityRequirement>();
        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme { Reference = new OpenApiReference
                { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }] = Array.Empty<string>()
        });

        return ValueTask.CompletedTask;
    });
});
```

Как только документ выражает security-схему, Scalar может применять введённый вами токен к запросам предсказуемым образом.

## Убедитесь, что Scalar смотрит на тот же OpenAPI-эндпоинт

Вторая ловушка это маршрутизация: Scalar должен указывать на только что исправленный OpenAPI-документ (например `"/openapi/v1.json"`). Держите маппинг рядом с вашей OpenAPI-настройкой, чтобы случайно не отдавать Scalar поверх старого документа.

В Scalar также есть опция настроить HTTP Bearer auth в слое маппинга UI. Если вы её используете, относитесь к ней как к удобству, а не источнику истины. OpenAPI-контракт всё равно должен объявлять Bearer-схему.

## Быстрая проверка реальности

Если хотите подтвердить корневую причину за минуты:

-   Откройте сгенерированный OpenAPI JSON и поищите `"securitySchemes"` и `"bearer"`.
-   Если их нет, Scalar не "игнорирует ваш токен". Он просто следует контракту, который вы ему отдали.

Изначальная ветка-триггер (со скриншотами): [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).
