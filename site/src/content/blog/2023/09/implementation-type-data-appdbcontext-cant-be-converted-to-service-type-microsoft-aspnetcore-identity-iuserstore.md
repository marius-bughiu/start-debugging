---
title: "Implementation type Data.AppDbContext can’t be converted to service type Microsoft.AspNetCore.Identity.IUserStore"
description: "This exception is thrown when you are building an identity DbContext without providing the user and role stores using AddUserStore and AddRoleStore. You can provide both configurations with a single call to AddEntityFrameworkStores like in the example below: The full exception for reference: System.AggregateException: ‘Some services are not able to be constructed (Error while validating…"
pubDate: 2023-09-28
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "net"
---
This exception is thrown when you are building an identity DbContext without providing the user and role stores using `AddUserStore` and `AddRoleStore`.

You can provide both configurations with a single call to `AddEntityFrameworkStores` like in the example below:

```cs
services.AddIdentity<IdentityUser, IdentityRole>(options =>
    {
        // Set your options here
    })
    .AddEntityFrameworkStores<FooDbContext>()
    .AddDefaultTokenProviders();
```

The full exception for reference:

> System.AggregateException: ‘Some services are not able to be constructed (Error while validating the service descriptor ‘ServiceType: Microsoft.AspNetCore.Identity.IUserClaimsPrincipalFactory1\[Areas.Identity.Data.ApplicationUser\] Lifetime: Scoped ImplementationType: Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory’: Unable to resolve service for type ‘Microsoft.AspNetCore.Identity.UserManager1\[Areas.Identity.Data.ApplicationUser\]’ while attempting to activate ‘Areas.Identity.Data.AdditionalUserClaimsPrincipalFactory’.)’
