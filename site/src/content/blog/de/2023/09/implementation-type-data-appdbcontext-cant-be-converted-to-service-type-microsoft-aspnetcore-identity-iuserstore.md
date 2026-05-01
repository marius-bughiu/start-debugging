---
title: "Implementation type Data.AppDbContext can't be converted to service type Microsoft.AspNetCore.Identity.IUserStore"
description: "Beheben Sie den ASP.NET Core Identity-Fehler, bei dem AppDbContext nicht in IUserStore konvertiert werden kann, indem Sie AddEntityFrameworkStores in Ihre Identity-Konfiguration aufnehmen."
pubDate: 2023-09-28
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/09/implementation-type-data-appdbcontext-cant-be-converted-to-service-type-microsoft-aspnetcore-identity-iuserstore"
translatedBy: "claude"
translationDate: 2026-05-01
---
Diese Exception wird geworfen, wenn Sie einen Identity-DbContext aufbauen, ohne die User- und Role-Stores über `AddUserStore` und `AddRoleStore` bereitzustellen.

Beide Konfigurationen lassen sich mit einem einzigen Aufruf von `AddEntityFrameworkStores` erledigen, wie im folgenden Beispiel:

```cs
services.AddIdentity<IdentityUser, IdentityRole>(options =>
    {
        // Set your options here
    })
    .AddEntityFrameworkStores<FooDbContext>()
    .AddDefaultTokenProviders();
```

Die vollständige Exception zur Referenz:

> System.AggregateException: 'Some services are not able to be constructed (Error while validating the service descriptor 'ServiceType: Microsoft.AspNetCore.Identity.IUserClaimsPrincipalFactory1\[Areas.Identity.Data.ApplicationUser\] Lifetime: Scoped ImplementationType: Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory': Unable to resolve service for type 'Microsoft.AspNetCore.Identity.UserManager1\[Areas.Identity.Data.ApplicationUser\]' while attempting to activate 'Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory'.)'
