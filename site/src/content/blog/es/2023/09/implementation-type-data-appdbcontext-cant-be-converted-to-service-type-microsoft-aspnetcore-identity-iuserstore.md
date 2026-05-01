---
title: "Implementation type Data.AppDbContext can't be converted to service type Microsoft.AspNetCore.Identity.IUserStore"
description: "Arregla el error de ASP.NET Core Identity en el que AppDbContext no se puede convertir a IUserStore añadiendo AddEntityFrameworkStores a tu configuración de identidad."
pubDate: 2023-09-28
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/09/implementation-type-data-appdbcontext-cant-be-converted-to-service-type-microsoft-aspnetcore-identity-iuserstore"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esta excepción se lanza cuando estás construyendo un DbContext de identidad sin proporcionar los user y role stores usando `AddUserStore` y `AddRoleStore`.

Puedes proporcionar ambas configuraciones con una sola llamada a `AddEntityFrameworkStores`, como en el siguiente ejemplo:

```cs
services.AddIdentity<IdentityUser, IdentityRole>(options =>
    {
        // Set your options here
    })
    .AddEntityFrameworkStores<FooDbContext>()
    .AddDefaultTokenProviders();
```

La excepción completa, para referencia:

> System.AggregateException: 'Some services are not able to be constructed (Error while validating the service descriptor 'ServiceType: Microsoft.AspNetCore.Identity.IUserClaimsPrincipalFactory1\[Areas.Identity.Data.ApplicationUser\] Lifetime: Scoped ImplementationType: Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory': Unable to resolve service for type 'Microsoft.AspNetCore.Identity.UserManager1\[Areas.Identity.Data.ApplicationUser\]' while attempting to activate 'Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory'.)'
