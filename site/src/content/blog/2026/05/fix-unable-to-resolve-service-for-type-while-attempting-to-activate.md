---
title: "Fix: Unable to resolve service for type 'X' while attempting to activate 'Y'"
description: "ASP.NET Core throws this when a constructor asks for a type that was never registered, was registered on the wrong container, or was added after the host was built. Three concrete fixes cover almost every case."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
---

The fix: ASP.NET Core's `ActivatorUtilities` walked the constructor of `Y`, asked the `IServiceProvider` for a `X`, and got back nothing. Either you forgot to call `services.AddScoped<X, XImpl>()` (or `AddSingleton` / `AddTransient`), you registered the implementation but asked for an interface or base class the container does not know about, or the registration lives in a different `IServiceCollection` than the one the host actually built. Add the missing registration in `Program.cs` before `builder.Build()`, and double-check the type names line up exactly.

```text
System.InvalidOperationException: Unable to resolve service for type 'MyApp.Data.IUserRepository' while attempting to activate 'MyApp.Api.Controllers.UsersController'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.ConstructorMatcher.CreateInstance(IServiceProvider provider)
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.CreateInstance(IServiceProvider provider, Type instanceType, Object[] parameters)
   at Microsoft.AspNetCore.Mvc.Controllers.ServiceBasedControllerActivator.Create(ControllerContext context)
   at Microsoft.AspNetCore.Mvc.Controllers.ControllerActivatorProvider.<>c__DisplayClass4_0.<CreateActivator>b__0(ControllerContext controllerContext)
   at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.Next(State& next, Scope& scope, Object& state, Boolean& isCompleted)
```

This guide is written against .NET 11 preview 4, `Microsoft.AspNetCore.App` 11.0.0-preview.4, and `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4. The exception text has been stable since ASP.NET Core 2.1, so every fix below applies cleanly back to .NET Core 3.1, .NET 5, 6, 8, and 10.

The two type names in the message are the most useful part: the **first** name (`X`) is the type the container could not find, and the **second** name (`Y`) is the consumer that asked for it. Read them in that order before doing anything else, because the search query that landed you here is going to match the wrong half of the message half the time.

## Why the container could not find the type

Three causes account for almost every occurrence:

1. **Nothing registered for that type at all.** You wrote `public UsersController(IUserRepository repo)` but never called `services.AddScoped<IUserRepository, UserRepository>()`. The container has no mapping from the interface to the implementation.
2. **You registered the wrong key.** You called `services.AddScoped<UserRepository>()` (concrete type) but the controller asks for `IUserRepository` (interface). The container only resolves what you registered, by the exact type used as the generic parameter or the `serviceType` argument.
3. **You registered into a different `IServiceCollection`.** Common in tests where the test host builds its own collection, or in unusual cases where you mutate `builder.Services` after `builder.Build()`. The host snapshots the collection at build time.

There are a handful of less common variants worth naming: a generic open type registered without the matching closed type (`AddScoped(typeof(IRepo<>), typeof(Repo<>))` is fine; `AddScoped<IRepo<User>>(...)` is not the same registration), a `keyed` service requested by a non-keyed consumer, and an `Action` or factory delegate passed to a constructor that DI cannot synthesise. Cover the first three first.

## Minimal repro

This is the smallest .NET 11 minimal API that throws the exception:

```csharp
// .NET 11 preview 4, Microsoft.AspNetCore.App 11.0.0-preview.4
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);

// Notice: no services.AddScoped<IUserRepository, UserRepository>();

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}
```

```csharp
// .NET 11 preview 4
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("users")]
public sealed class UsersController(IUserRepository repo) : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(repo.GetName(id));
}
```

Hit `GET /users/1` and the request fails with the exception in the section above. The container never saw `IUserRepository`, so when MVC's `ServiceBasedControllerActivator` tries to build the controller, the constructor parameter cannot be satisfied.

## Fix one: register the missing service

The first thing to try, and the answer 80% of the time:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Pick the lifetime that matches how the service is used:

- `AddScoped` is the right default for anything that touches per-request state (an EF Core `DbContext`, a `HttpContext` accessor wrapper, a tenant resolver). One instance per request scope.
- `AddSingleton` is for stateless or thread-safe shared state (caches, options, HTTP clients via `IHttpClientFactory`). One instance per process.
- `AddTransient` is for cheap, stateless objects you want a fresh copy of every time (`IValidator<T>`, mappers). New instance per resolve.

Get this wrong and you trade today's exception for tomorrow's `InvalidOperationException: Cannot consume scoped service ... from singleton ...`, or worse, for a silent thread-safety bug where two requests share a `DbContext`. The official guidance in the [Microsoft.Extensions.DependencyInjection docs](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) is the reference; default to `AddScoped` when in doubt and a request scope exists.

## Fix two: register the service type the constructor actually asks for

If you have a registration but still get the exception, the registered type and the consumed type do not match. Check the constructor against the registration:

```csharp
// Wrong: only the concrete type is registered
builder.Services.AddScoped<UserRepository>();

// Right: register both the interface and the implementation,
// or just the interface mapped to the implementation
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

The container does not perform interface inference. If `UserRepository` implements `IUserRepository`, registering only `UserRepository` does not register `IUserRepository`. If the consumer asks for the interface, register the interface.

If you genuinely need both ("inject `UserRepository` here, but `IUserRepository` there"), register both, and forward the interface to the concrete:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<UserRepository>();
builder.Services.AddScoped<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
```

This pattern matters for hosted services and the options pattern, where consumers sometimes ask for the concrete `MyOptions` and sometimes for `IOptions<MyOptions>`.

## Fix three: register before the host is built

`builder.Build()` is the cut-off line. Anything you add to `builder.Services` after that point is silently discarded for the running host:

```csharp
// .NET 11 preview 4
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Too late. The container was snapshotted in builder.Build().
builder.Services.AddScoped<IUserRepository, UserRepository>();

app.MapControllers();
app.Run();
```

Reorder so every registration runs before `Build`. This pattern bites most often when a refactor moves an `Add*` call into a method, and the method is called from the wrong place. A handy pattern is to put every `services.Add*` call inside an extension method on `IServiceCollection` and call it from one place near the top of `Program.cs`:

```csharp
// .NET 11 preview 4
public static class DependencyInjectionExtensions
{
    public static IServiceCollection AddDataServices(this IServiceCollection services)
    {
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        return services;
    }
}

// Program.cs
builder.Services.AddDataServices();
var app = builder.Build();
```

In integration tests against `WebApplicationFactory<TEntryPoint>`, the equivalent rule is that `ConfigureTestServices` runs before the test host is built. If you mutate the container from inside a test method body after `factory.CreateClient()`, you are mutating a discarded collection.

## Variants that look like the same error

Several lookalikes resolve differently and waste time if you treat them as the same bug:

- **`Cannot consume scoped service '<X>' from singleton '<Y>'`**. The registration exists, but the lifetime is wrong. The fix is to make `Y` scoped, or to take `IServiceScopeFactory` / `IServiceProvider` in `Y` and create a scope on demand. Covered in [the singleton-to-scoped capture problem](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- **`No service for type 'IOptions<MyOptions>' has been registered`**. Same root cause, different message: you skipped `services.Configure<MyOptions>(...)` or `services.AddOptions<MyOptions>().Bind(...)`. Adding `Configure` registers `IOptions<MyOptions>` for free.
- **`Implementation type 'X' can't be converted to service type 'Y'`**. You wrote `services.AddScoped(typeof(IFoo), typeof(Bar))` and `Bar` does not implement `IFoo`. The compiler cannot catch this because both arguments are `Type`. Fix the type or use the generic overload.
- **`A suitable constructor for type 'X' could not be located`**. The type is registered but DI cannot construct it: every public constructor parameter must be resolvable, and there must be exactly one constructor (or `[ActivatorUtilitiesConstructor]` on the chosen one). This is not the `Unable to resolve service` error.
- **Keyed services**: in .NET 8 and later, `AddKeyedScoped<IFoo, Foo>("primary")` requires `[FromKeyedServices("primary")] IFoo foo` on the consumer. Asking for a plain `IFoo` will throw the resolve-service exception even though a keyed registration exists. The two namespaces are separate.

## How to confirm the registration is wired correctly

Three quick checks beat any amount of guessing:

1. **`IServiceProvider.GetService<T>()` from the dev console.** Drop a one-liner just after `app.Build()` and before `app.Run()`:

   ```csharp
   // .NET 11 preview 4 - remove before commit
   using (var scope = app.Services.CreateScope())
   {
       var repo = scope.ServiceProvider.GetService<IUserRepository>();
       Console.WriteLine(repo is null ? "NOT REGISTERED" : repo.GetType().FullName);
   }
   ```

   If `GetService<T>()` returns `null`, the registration is missing or scoped to a different container. `GetRequiredService<T>()` would throw the same `InvalidOperationException` you are debugging.

2. **Validate scopes at startup.** Pass `ValidateScopes = true` and `ValidateOnBuild = true` to the service-provider factory and the host will refuse to start if any registration is broken:

   ```csharp
   // .NET 11 preview 4
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

   `ValidateOnBuild` walks every registration once at build time and fails fast if any constructor parameter cannot be satisfied. In the development environment ASP.NET Core enables this for you, which is why the exception often appears the moment you start the app rather than the moment you hit an endpoint.

3. **Print the registrations.** When the registration looks correct but the exception still fires, dump the collection itself before `Build`:

   ```csharp
   // .NET 11 preview 4
   foreach (var sd in builder.Services.Where(s => s.ServiceType.Name.Contains("UserRepository")))
   {
       Console.WriteLine($"{sd.Lifetime}: {sd.ServiceType.FullName} -> {sd.ImplementationType?.FullName ?? "factory"}");
   }
   ```

   This catches the case where you registered `MyApp.OldNamespace.IUserRepository` and the controller imports `MyApp.NewNamespace.IUserRepository`. The exception message shows the full namespace, but the eye glides past it.

## Edge cases that catch experienced developers

A few patterns trigger this exception in code that looks correct on inspection:

- **`IConfiguration` injected into a `Configure<TOptions>` callback**. The callback runs lazily. If you reference a service inside the callback that is later removed, the exception fires the first time the options are resolved, not at startup.
- **Background services that resolve scoped dependencies in their constructor**. A `BackgroundService` is a singleton. Its constructor cannot ask for an `IUserRepository` if the latter is scoped. Inject `IServiceScopeFactory`, create a scope inside `ExecuteAsync`, and resolve from the scope.
- **Generic hosted services**. `services.AddHostedService<MyHostedService<MyArg>>()` requires that the closed generic `MyHostedService<MyArg>` be constructible by DI, which means `MyArg` must also be resolvable. Open generics need `services.AddTransient(typeof(IRepo<>), typeof(Repo<>))`.
- **Source-generated DI containers**. Strawberry Shake, Refit, and gRPC source generators sometimes register their own clients with `IServiceCollection`. If you call their `Add*` extension after `Build`, the same silent-discard rule applies.
- **Native AOT builds**. The trim-friendly default container in .NET 11 still resolves through reflection by default. If you ship with `<PublishTrimmed>true</PublishTrimmed>` and the trimmer removes the implementation type, you will see the resolve-service exception at runtime even though the source compiles fine. The fix is `[DynamicDependency]` or registering the type via a typed factory.

## Related

- Wiring up logging and DI together cleanly: [structured logging with Serilog and Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).
- The next exception you will hit after this one if you pick the wrong lifetime: [singleton consuming scoped DbContext](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- A related EF Core misuse that surfaces when DI hands the same `DbContext` to two requests: [a second operation was started on this context instance](/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Test-time DI swaps that bypass this exception by registering a fake: [pooled DbContext factory in EF Core 11 tests](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).
- For the related `IConfiguration` failure mode: [no connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/).

## Sources

- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines).
- Microsoft Learn, [Keyed services in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services).
- Microsoft Learn, [Use scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-usage#scope-validation).
- ASP.NET Core source, [`ActivatorUtilities.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection.Abstractions/src/ActivatorUtilities.cs) where the exception is thrown.
