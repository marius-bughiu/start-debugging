---
title: "Implementation type Data.AppDbContext can't be converted to service type Microsoft.AspNetCore.Identity.IUserStore"
description: "Corrija o erro do ASP.NET Core Identity em que AppDbContext não pode ser convertido em IUserStore adicionando AddEntityFrameworkStores na sua configuração de identidade."
pubDate: 2023-09-28
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/09/implementation-type-data-appdbcontext-cant-be-converted-to-service-type-microsoft-aspnetcore-identity-iuserstore"
translatedBy: "claude"
translationDate: 2026-05-01
---
Essa exceção é lançada quando você está montando um DbContext de identidade sem informar os user e role stores via `AddUserStore` e `AddRoleStore`.

Dá para configurar os dois com uma única chamada a `AddEntityFrameworkStores`, como no exemplo abaixo:

```cs
services.AddIdentity<IdentityUser, IdentityRole>(options =>
    {
        // Set your options here
    })
    .AddEntityFrameworkStores<FooDbContext>()
    .AddDefaultTokenProviders();
```

A exceção completa para referência:

> System.AggregateException: 'Some services are not able to be constructed (Error while validating the service descriptor 'ServiceType: Microsoft.AspNetCore.Identity.IUserClaimsPrincipalFactory1\[Areas.Identity.Data.ApplicationUser\] Lifetime: Scoped ImplementationType: Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory': Unable to resolve service for type 'Microsoft.AspNetCore.Identity.UserManager1\[Areas.Identity.Data.ApplicationUser\]' while attempting to activate 'Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory'.)'
