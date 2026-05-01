---
title: "Implementation type Data.AppDbContext can't be converted to service type Microsoft.AspNetCore.Identity.IUserStore"
description: "AppDbContext を IUserStore に変換できないという ASP.NET Core Identity のエラーを、identity の設定に AddEntityFrameworkStores を追加して解消する方法を解説します。"
pubDate: 2023-09-28
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/09/implementation-type-data-appdbcontext-cant-be-converted-to-service-type-microsoft-aspnetcore-identity-iuserstore"
translatedBy: "claude"
translationDate: 2026-05-01
---
この例外は、`AddUserStore` と `AddRoleStore` を使って user store と role store を指定せずに identity DbContext を構築しようとしたときにスローされます。

下の例のように、`AddEntityFrameworkStores` を 1 回呼び出すだけで両方の設定を行えます。

```cs
services.AddIdentity<IdentityUser, IdentityRole>(options =>
    {
        // Set your options here
    })
    .AddEntityFrameworkStores<FooDbContext>()
    .AddDefaultTokenProviders();
```

完全な例外メッセージは参考までに以下のとおりです。

> System.AggregateException: 'Some services are not able to be constructed (Error while validating the service descriptor 'ServiceType: Microsoft.AspNetCore.Identity.IUserClaimsPrincipalFactory1\[Areas.Identity.Data.ApplicationUser\] Lifetime: Scoped ImplementationType: Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory': Unable to resolve service for type 'Microsoft.AspNetCore.Identity.UserManager1\[Areas.Identity.Data.ApplicationUser\]' while attempting to activate 'Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory'.)'
