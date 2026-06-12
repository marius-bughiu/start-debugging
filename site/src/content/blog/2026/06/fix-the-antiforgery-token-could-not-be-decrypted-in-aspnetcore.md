---
title: "Fix: The antiforgery token could not be decrypted in ASP.NET Core"
description: "The error means Data Protection lost the key that signed the token. Persist keys to a shared, durable store and call SetApplicationName so every instance reads the same key ring."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
---

The antiforgery token could not be decrypted because the Data Protection key that signed it is no longer in the key ring that your app is reading. By default ASP.NET Core writes those keys to a per-machine, per-user folder that does not survive a container restart and is not shared between instances. Persist the keys to a durable store every instance can read (file share, database, Azure Blob, Redis) and pin `SetApplicationName` to the same value everywhere. That is the whole fix. The rest of this post is why it happens and the exact code for each store.

This applies to ASP.NET Core 11 (`.NET 11`), but the same Data Protection stack and the same fix go back to ASP.NET Core 2.x.

## The error in context

You will see one of these, usually on a POST right after a deploy, a scale-out, or a container restart:

```
Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException: The antiforgery token could not be decrypted.
 ---> System.Security.Cryptography.CryptographicException: The key {0cf0e637-...} was not found in the key ring.
   at Microsoft.AspNetCore.DataProtection.KeyManagement.KeyRingBasedDataProtector.UnprotectCore(...)
   at Microsoft.AspNetCore.Antiforgery.DefaultAntiforgeryTokenSerializer.Deserialize(String serializedToken)
```

The inner exception is the tell. `The key {guid} was not found in the key ring` means the token references a key this instance has never seen. A different inner message, `The payload was invalid`, points at a key that exists but cannot decrypt this specific token, which usually means two apps share a key ring without a matching application name (more on that below).

In Blazor and Razor Pages the same root cause surfaces as an HTTP 400 with `Bad Request - antiforgery token validation failed`, and in MVC as a redirect loop on login because the antiforgery cookie can never be validated.

## Why this happens

Antiforgery tokens are encrypted and signed by ASP.NET Core Data Protection. Validation only works if the instance reading the token still holds the key that wrote it. There are four ways to lose that key:

- **Keys are ephemeral.** With no explicit configuration, Data Protection persists keys to `%LOCALAPPDATA%\ASP.NET\DataProtection-Keys` (Windows) or `$HOME/.aspnet/DataProtection-Keys` (Linux). In a container that path lives inside the writable layer and is wiped on every restart, so each new container generates a fresh key ring and rejects every token issued by the previous one.
- **You scaled out.** Two or more instances behind a load balancer each generate their own key ring. A token issued by instance A lands on instance B, whose ring does not contain A's key. This is the single most common cause in production.
- **The identity changed.** Running under IIS, an app pool recycle or an identity change moves the key folder, because the default path is user-scoped. Azure App Service deployment slots have the same effect: the staging slot and the production slot do not share keys unless you tell them to.
- **Two apps, one ring, no application name.** When several apps point at the same store but do not set a matching `SetApplicationName`, their tokens collide. Data Protection isolates by application discriminator, so a mismatch produces `The payload was invalid`.

The default key lifetime is 90 days, so legitimate key rotation almost never causes this. If you see it, the key is missing, not expired.

## Minimal repro

This is the smallest app that reproduces the error across a restart. Run it, submit the form, then restart the process before submitting again.

```csharp
// .NET 11, ASP.NET Core 11
// No Data Protection configuration: keys are ephemeral.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();

app.MapGet("/", (HttpContext ctx, IAntiforgery af) =>
{
    var tokens = af.GetAndStoreTokens(ctx);
    return Results.Content($"""
        <form action="/submit" method="post">
          <input name="{tokens.FormFieldName}" type="hidden" value="{tokens.RequestToken}" />
          <button type="submit">Submit</button>
        </form>
        """, "text/html");
});

app.MapPost("/submit", () => "OK").RequireAntiforgery();

app.Run();
```

Load `/`, copy the rendered form, restart the app, then POST the old form. Because the in-process key ring was regenerated on restart, the token no longer decrypts and you get `AntiforgeryValidationException`. In a single long-running process you will not see it, which is exactly why this slips through local testing and only bites in containers and farms.

## The fix, in detail

Pick the store that matches where you run. In every case the rule is the same: a location all instances can read and write, plus a stable application name.

### 1. File share (UNC or mounted volume): simplest for VMs and bare metal

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(@"\\fileserver\dpkeys\myapp"))
    .SetApplicationName("MyApp");
```

In Kubernetes, mount a shared `PersistentVolume` (ReadWriteMany) and point `PersistKeysToFileSystem` at the mount path. The keys then outlive any single pod. This is the lowest-friction fix when you already have shared storage.

### 2. Database via EF Core: no extra infrastructure if you already have a DB

Add the [`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`](https://www.nuget.org/packages/Microsoft.AspNetCore.DataProtection.EntityFrameworkCore/) package and a context that implements `IDataProtectionKeyContext`:

```csharp
// .NET 11, EF Core 11
public class KeysDbContext : DbContext, IDataProtectionKeyContext
{
    public KeysDbContext(DbContextOptions<KeysDbContext> options) : base(options) { }
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
}
```

```csharp
// Program.cs
builder.Services.AddDbContext<KeysDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Keys")));

builder.Services.AddDataProtection()
    .PersistKeysToDbContext<KeysDbContext>()
    .SetApplicationName("MyApp");
```

Run a migration that creates the `DataProtectionKeys` table once, and every instance reads the same ring. This is the option I reach for most often because it needs nothing the app does not already have.

### 3. Azure Blob Storage: the clean choice for App Service and Azure Container Apps

Add [`Azure.Extensions.AspNetCore.DataProtection.Blobs`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Blobs). Use a managed identity rather than a connection string:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToAzureBlobStorage(
        new Uri("https://mystorage.blob.core.windows.net/dpkeys/keys.xml"),
        new DefaultAzureCredential())
    .SetApplicationName("MyApp");
```

This also fixes the deployment-slot variant: when staging and production both point at the same blob, swapping slots no longer invalidates live sessions. For defense in depth, wrap it with `ProtectKeysWithAzureKeyVault` (package [`Azure.Extensions.AspNetCore.DataProtection.Keys`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Keys)) so the key ring itself is encrypted at rest.

### 4. Redis: lowest latency for large farms

Add `Microsoft.AspNetCore.DataProtection.StackExchangeRedis` and reuse the multiplexer you already use for caching:

```csharp
// .NET 11, ASP.NET Core 11
var redis = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!);
builder.Services.AddDataProtection()
    .PersistKeysToStackExchangeRedis(redis, "DataProtection-Keys")
    .SetApplicationName("MyApp");
```

Whichever store you pick, `SetApplicationName` is not optional in a multi-app or slot scenario. It sets the application discriminator that Data Protection mixes into key derivation, and the value must be byte-for-byte identical across every instance and slot that should trust each other's tokens.

## Gotchas and variants

**`The payload was invalid` instead of `key not found`.** The key exists but the application discriminator differs. Two apps share a store, and one is missing `SetApplicationName` or has a different value. Set the same name in both. This is also why copying a published app to a new content root path can break tokens: ASP.NET Core falls back to deriving the application name from the content root path when you do not set one explicitly, so the path itself becomes the discriminator.

**Encrypted-at-rest keys that cannot be read by other instances.** On Windows, Data Protection encrypts the key ring with DPAPI scoped to the current user or machine by default. A key written under one identity is unreadable under another, which produces the same symptom even though the keys are physically present. When you share keys across machines, either disable the per-machine encryption or use an explicit, portable protector like `ProtectKeysWithCertificate`.

**It works locally, fails in the container.** Expected. A single process on your dev box keeps its ephemeral ring in memory for the whole session, so the token always decrypts. The bug only appears once a second instance or a restart enters the picture. Reproduce it by running two instances locally on different ports behind nothing, or by restarting between requests as in the repro above.

**Do not "fix" it by disabling antiforgery.** Removing `[ValidateAntiForgeryToken]` or `.RequireAntiforgery()` makes the error disappear and reopens a CSRF hole. The token is doing its job. Persist the keys instead.

**`DisableAutomaticKeyGeneration` on read-only replicas.** If you run a worker that should consume keys but never mint them, call `DisableAutomaticKeyGeneration()` so it does not create a competing key in the shared ring. Leave it off on the instance that owns rotation.

## Related reading

- [.NET 10.0.7 ships out-of-band to fix CVE-2026-40372 in ASP.NET Core Data Protection](/2026/04/dotnet-10-0-7-oob-cve-2026-40372-dataprotection/) covers an HMAC validation flaw in the same stack, and why you want your key ring patched.
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) leans on Data Protection for the same encryption pipeline.
- [Blazor static SSR forms get client-side validation in .NET 11 Preview 5](/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) is where antiforgery tokens show up on static-rendered Blazor forms.
- [How to persist state across the Blazor static-to-interactive render boundary in .NET 11](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) deals with the related class of "state lost across a boundary" bugs.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) helps you surface this exception cleanly instead of as a bare 400.

## Sources

- [Configure ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-11.0) - exact `PersistKeysTo*`, `ProtectKeysWith*`, and `SetApplicationName` APIs and package names.
- [Key storage providers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/implementation/key-storage-providers?view=aspnetcore-11.0) - file system, Azure Blob, Redis, and EF Core providers.
- [Data Protection key management and lifetime](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/default-settings?view=aspnetcore-11.0) - default 90-day lifetime and default storage locations.
- [dotnet/aspnetcore #47185: The antiforgery token could not be decrypted](https://github.com/dotnet/aspnetcore/issues/47185) - real-world reports and maintainer guidance.
