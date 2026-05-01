---
title: "Implementation type Data.AppDbContext can't be converted to service type Microsoft.AspNetCore.Identity.IUserStore"
description: "Исправляем ошибку ASP.NET Core Identity, когда AppDbContext не может быть преобразован в IUserStore, добавлением AddEntityFrameworkStores в конфигурацию identity."
pubDate: 2023-09-28
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/09/implementation-type-data-appdbcontext-cant-be-converted-to-service-type-microsoft-aspnetcore-identity-iuserstore"
translatedBy: "claude"
translationDate: 2026-05-01
---
Это исключение возникает, когда вы собираете identity DbContext, не предоставляя user- и role-store через `AddUserStore` и `AddRoleStore`.

Обе конфигурации можно задать одним вызовом `AddEntityFrameworkStores`, как в примере ниже:

```cs
services.AddIdentity<IdentityUser, IdentityRole>(options =>
    {
        // Set your options here
    })
    .AddEntityFrameworkStores<FooDbContext>()
    .AddDefaultTokenProviders();
```

Полный текст исключения для справки:

> System.AggregateException: 'Some services are not able to be constructed (Error while validating the service descriptor 'ServiceType: Microsoft.AspNetCore.Identity.IUserClaimsPrincipalFactory1\[Areas.Identity.Data.ApplicationUser\] Lifetime: Scoped ImplementationType: Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory': Unable to resolve service for type 'Microsoft.AspNetCore.Identity.UserManager1\[Areas.Identity.Data.ApplicationUser\]' while attempting to activate 'Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory'.)'
