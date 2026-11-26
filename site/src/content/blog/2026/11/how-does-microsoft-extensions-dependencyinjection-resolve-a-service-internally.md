---
title: "How does Microsoft.Extensions.DependencyInjection resolve a service internally, from AddSingleton to the instance?"
description: "AddSingleton only appends a ServiceDescriptor to a list. BuildServiceProvider indexes those descriptors, and the first GetService builds a call-site tree with reflection, caches it, and wraps it in an accessor delegate. Singletons are stored on the call site itself, scoped instances in a per-scope dictionary, and after the second resolve of a non-singleton the container compiles an IL DynamicMethod on the thread pool. Walked through the .NET 11 source and observed with reflection, EventSource events and BenchmarkDotNet."
pubDate: 2026-11-26
tags:
  - "dotnet"
  - "csharp"
  - "dotnet-11"
  - "dependency-injection"
  - "performance"
---

**Short answer:** in Microsoft.Extensions.DependencyInjection 11.0.0, `services.AddSingleton<IMyService, MyService>()` stores nothing but a `ServiceDescriptor` (service type, implementation type, lifetime) in a list. `BuildServiceProvider()` turns that list into a `Dictionary<ServiceIdentifier, ...>` lookup and picks an engine. The first `GetService(typeof(IMyService))` asks a `CallSiteFactory` to build a tree of "call sites" (which constructor to run, and recursively how to get each parameter), caches that tree, and stores a `Func<ServiceProviderEngineScope, object?>` accessor for the type in a `ConcurrentDictionary`. A singleton instance is then kept in a field on its own call-site object, a scoped instance in a `Dictionary<ServiceCacheKey, object?>` owned by the scope, and a transient is not kept at all (only tracked for disposal if it is `IDisposable`). Non-singleton services are resolved by reflection twice, and on the second call the container queues a background job that compiles an IL `DynamicMethod` and swaps it into the accessor. Everything below was read from the `release/11.0` branch of dotnet/runtime and observed on .NET 11.0.0 (SDK 11.0.100), macOS arm64, Apple M4.

The question comes from a [Stack Overflow post](https://stackoverflow.com/questions/80008542) that explicitly asks for the runtime and memory view rather than "DI is a dictionary of factories". The two existing answers describe a generic container. This post follows the actual objects and references inside the Microsoft container, because several details (where singletons live, when IL is emitted, what a "slot" is) are not what most people guess.

## The objects you need to know about

All of these are `internal` types in `Microsoft.Extensions.DependencyInjection.dll`, under the `ServiceLookup` namespace unless noted:

- **`ServiceDescriptor`** (public, in the Abstractions package): one registration. Holds `ServiceType`, `Lifetime`, an optional `ServiceKey`, and exactly one of `ImplementationType`, `ImplementationInstance` or `ImplementationFactory`.
- **`ServiceIdentifier`**: a `readonly struct` of `(object? ServiceKey, Type ServiceType)`. This is the dictionary key used everywhere at runtime.
- **`ServiceCacheKey`**: a `readonly struct` of `(ServiceIdentifier, int Slot)`. The slot distinguishes multiple registrations of the same service type.
- **`ServiceCallSite`**: an abstract node describing how to produce a value. Subclasses include `ConstructorCallSite`, `FactoryCallSite`, `ConstantCallSite`, `IEnumerableCallSite` and `ServiceProviderCallSite`. Every node has a `ResultCache` (where its result is stored) and an `object? Value` property.
- **`CallSiteFactory`**: builds and caches call-site trees from descriptors.
- **`ServiceProvider`**: the public object you get from `BuildServiceProvider()`. It owns the accessor dictionary, the engine and the root scope.
- **`ServiceProviderEngineScope`**: both the root scope and every scope you create. It is the `IServiceProvider` you get from `scope.ServiceProvider`, and it owns `ResolvedServices` and the list of disposables.
- **`ServiceProviderEngine`**: the strategy that turns a call site into a delegate. On a normal JIT runtime it is `DynamicServiceProviderEngine`.

## Step 1: AddSingleton only appends a descriptor

`ServiceCollection` is a thin wrapper over `List<ServiceDescriptor>`. The registration extension builds a descriptor and adds it:

```csharp
// .NET 11, Microsoft.Extensions.DependencyInjection.Abstractions 11.0.0
// What services.AddSingleton<IMyService, MyService>() boils down to:
services.Add(new ServiceDescriptor(typeof(IMyService), typeof(MyService), ServiceLifetime.Singleton));
```

At this point there is no `MyService` instance, no reflection over its constructors and no delegate. The descriptor holds two `RuntimeType` references and an enum. That is what the Stack Overflow asker meant by "the registration stores information about how `MyService` should be created": it stores *which type* to create, and nothing about *how* yet. The how is computed lazily, per service type, the first time someone asks for it.

## Step 2: BuildServiceProvider indexes descriptors and picks an engine

`BuildServiceProvider()` calls the `ServiceProvider` constructor. Stripped of validation, the [.NET 11 source](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) does this:

```csharp
// dotnet/runtime release/11.0, ServiceProvider.cs (abridged)
Root = new ServiceProviderEngineScope(this, isRootScope: true);
_engine = GetEngine();
_serviceAccessors = new ConcurrentDictionary<ServiceIdentifier, ServiceAccessor>();

CallSiteFactory = new CallSiteFactory(serviceDescriptors);
CallSiteFactory.Add(ServiceIdentifier.FromServiceType(typeof(IServiceProvider)), new ServiceProviderCallSite());
CallSiteFactory.Add(ServiceIdentifier.FromServiceType(typeof(IServiceScopeFactory)), new ConstantCallSite(typeof(IServiceScopeFactory), Root));
// ... IServiceProviderIsService, IServiceProviderIsKeyedService
```

The `CallSiteFactory` constructor copies the descriptors into an array, validates them (open generic arity, abstract implementation types), and builds `_descriptorLookup`, a `Dictionary<ServiceIdentifier, ServiceDescriptorCacheItem>`. The cache item is a small struct holding the first descriptor plus a `List<ServiceDescriptor>` for any extra registrations of the same service type. Its `Last` property is what a plain `GetService<T>()` uses, which is why the last registration wins.

`GetEngine()` chooses between two engines:

```csharp
// dotnet/runtime release/11.0, ServiceProvider.cs
if (RuntimeFeature.IsDynamicCodeCompiled && !DisableDynamicEngine)
    engine = CreateDynamicEngine();              // DynamicServiceProviderEngine
else
    engine = RuntimeServiceProviderEngine.Instance; // reflection only
```

Under Native AOT `IsDynamicCodeCompiled` is `false`, so the container uses reflection for every resolve and never emits IL. You can force the same behaviour on a JIT runtime with the `Microsoft.Extensions.DependencyInjection.DisableDynamicEngine` AppContext switch, which is how the comparison benchmark further down was produced.

With `ValidateOnBuild = true` (the default in the ASP.NET Core Development environment), the constructor also builds a call site for every descriptor right away, which is how "Unable to resolve service" errors show up at startup instead of on first request. Without it, nothing else happens until the first resolve.

## Step 3: the first GetService builds and caches a call-site tree

Every `GetService` call, from the root provider or from a scope, ends up in the same method:

```csharp
// dotnet/runtime release/11.0, ServiceProvider.cs
internal object? GetService(ServiceIdentifier serviceIdentifier, ServiceProviderEngineScope scope)
{
    if (_disposed) ThrowHelper.ThrowObjectDisposedException();
    ServiceAccessor serviceAccessor = _serviceAccessors.GetOrAdd(serviceIdentifier, _createServiceAccessor);
    OnResolve(serviceAccessor.CallSite, scope);   // scope validation, if enabled
    DependencyInjectionEventSource.Log.ServiceResolved(this, serviceIdentifier.ServiceType);
    return serviceAccessor.RealizedService?.Invoke(scope);
}
```

On a miss, `CreateServiceAccessor` calls `CallSiteFactory.GetCallSite`, which takes a per-service-type lock and tries, in order, an exact registration, an open generic registration, and `IEnumerable<T>`. For an exact registration with an implementation type it calls `CreateConstructorCallSite`, which is where reflection happens:

1. `implementationType.GetConstructors()` returns the public constructors.
2. With one constructor, it builds a call site for each parameter by recursively calling `GetCallSite` on the parameter type. Missing services throw `InvalidOperationException` here.
3. With several constructors, they are sorted by parameter count, descending. The first one whose parameters can all be satisfied (by a registration or a default value) becomes the best match, and every other satisfiable constructor must use a subset of its parameters or the container throws the "ambiguous constructors" error.

A `CallSiteChain` tracks the types currently being built, so `A -> B -> A` fails with a circular dependency message during this phase, before any constructor runs.

For this registration set:

```csharp
// .NET 11, Microsoft.Extensions.DependencyInjection 11.0.0
services.AddSingleton<IClock, SystemClock>();
services.AddScoped<IUnitOfWork, UnitOfWork>();
services.AddTransient<IMyService, MyService>();

public sealed class MyService(IClock clock, IUnitOfWork uow) : IMyService { /* ... */ }
```

resolving `IMyService` produces this tree, and every node is stored in `CallSiteFactory._callSiteCache`, a `ConcurrentDictionary<ServiceCacheKey, ServiceCallSite>`:

```text
ConstructorCallSite  IMyService   ctor MyService(IClock, IUnitOfWork)   Cache: Dispose (transient)
 ├─ ConstructorCallSite  IClock       ctor SystemClock()                 Cache: Root    (singleton)
 └─ ConstructorCallSite  IUnitOfWork  ctor UnitOfWork()                  Cache: Scope   (scoped)
```

The `Cache` value is a `ResultCache`, computed from the descriptor lifetime: `Singleton -> Root`, `Scoped -> Scope`, `Transient -> Dispose`. The `ConstructorInfo` and the parameter call sites are held by reference, so after this point the container never has to call `GetConstructors()` or `GetParameters()` for `MyService` again.

The tree is then wrapped in an accessor. Here the lifetime matters:

```csharp
// dotnet/runtime release/11.0, ServiceProvider.cs
if (callSite.Cache.Location == CallSiteResultCacheLocation.Root)
{
    object? value = CallSiteRuntimeResolver.Instance.Resolve(callSite, Root);
    return new ServiceAccessor { CallSite = callSite, RealizedService = scope => value };
}

Func<ServiceProviderEngineScope, object?> realizedService = _engine.RealizeService(callSite);
return new ServiceAccessor { CallSite = callSite, RealizedService = realizedService };
```

For a singleton that is requested directly, the instance is created immediately and the accessor becomes a closure that returns a captured reference. It never goes through the compile step at all. Everything else gets a delegate from the engine.

## Step 4: where each lifetime keeps its instance

The reflection-based resolver, `CallSiteRuntimeResolver`, walks the tree. Each lifetime is handled by a different visitor method, and this is the part that answers "where is my object in memory".

**Singletons live on the call site.** `VisitRootCache` checks `callSite.Value`, and if it is `null`, takes a `lock` on the call-site object, builds the instance, registers it for disposal with the root scope, and assigns `callSite.Value = resolved`. The singleton reference is a field on a `ConstructorCallSite` object that is reachable from `CallSiteFactory._callSiteCache`, which is reachable from the `ServiceProvider`. It is not in any dictionary keyed by type.

**Scoped instances live in the scope.** `VisitScopeCache` routes to `VisitCache`, which locks `scope.Sync` (the dictionary object itself), looks up `callSite.Cache.Key` in `scope.ResolvedServices` (a `Dictionary<ServiceCacheKey, object?>`), and on a miss constructs the instance and adds it. Each `IServiceScope` has its own dictionary, which is all "scoped" means. A scoped service resolved from the root provider is treated as a root-cached call site, which is why it silently behaves like a singleton when `ValidateScopes` is off.

**Transients are not stored.** `VisitDisposeCache` constructs the instance and passes it to `scope.CaptureDisposable`, which adds it to the scope's `_disposables` list only if it implements `IDisposable` or `IAsyncDisposable`. That list is the only reference the container keeps to a transient, and it is the source of the classic "disposable transients resolved from the root provider leak" problem.

Reflection can confirm this on a live provider. After resolving the three services above from a scope, reading the private fields gives:

```text
root ResolvedServices count: 0
scope ResolvedServices: ServiceCacheKey(IUnitOfWork, slot 0)
scope disposables: 1                                  <- the UnitOfWork
call site ConstructorCallSite  IMyService   Value=null
call site ConstructorCallSite  IUnitOfWork  Value=null
call site ConstructorCallSite  IClock       Value=SystemClock
call site ConstantCallSite     IServiceScopeFactory Value=ServiceProviderEngineScope
```

The root scope's `ResolvedServices` is empty even though a singleton exists, because the singleton is on the `IClock` call site. A comment in `ServiceProviderEngineScope` says the same thing: the root's lock protects only the disposables list, "since ResolvedServices are cached on CallSites".

## Step 5: after the second call, the container compiles IL

`DynamicServiceProviderEngine.RealizeService` does not compile anything up front. It returns a closure with a call counter:

```csharp
// dotnet/runtime release/11.0, DynamicServiceProviderEngine.cs (abridged)
int callCount = 0;
return scope =>
{
    var result = CallSiteRuntimeResolver.Instance.Resolve(callSite, scope);
    if (Interlocked.Increment(ref callCount) == 2)
    {
        _ = ThreadPool.UnsafeQueueUserWorkItem(_ =>
        {
            _serviceProvider.ReplaceServiceAccessor(callSite, base.RealizeService(callSite));
        }, null);
    }
    return result;
};
```

The first two resolves use reflection. The second one queues a thread-pool work item that calls `ILEmitResolverBuilder.Build`, which emits a `DynamicMethod` named `ResolveService` that does with straight-line IL what the visitor did with reflection: `newobj` on the constructor, calls into nested resolver methods for scoped dependencies, and the lock-and-dictionary dance for scoped caching. Two details are worth knowing:

- **Singleton dependencies become constants.** `ILEmitResolverBuilder.VisitRootCache` resolves the singleton at compile time and stores the instance in a `Constants` array that the dynamic method closes over. The compiled `MyService` resolver loads the `SystemClock` reference from that array and never checks `callSite.Value`.
- **Scoped resolvers are shared.** Compiled methods for scoped call sites are cached by `ServiceCacheKey` in `_scopeResolverCache` and called from every resolver that depends on them.

When the work item finishes, `ReplaceServiceAccessor` overwrites the entry in `_serviceAccessors`, and subsequent calls go straight to the compiled delegate.

This is observable without a debugger. The following program enables the container's EventSource, prints which method backs the accessor delegate after each call, and times the first three calls:

```csharp
// .NET 11.0.0, Microsoft.Extensions.DependencyInjection 11.0.0, C# 14
using System.Collections;
using System.Diagnostics;
using System.Diagnostics.Tracing;
using System.Reflection;
using Microsoft.Extensions.DependencyInjection;

using var listener = new DiEventListener();

var services = new ServiceCollection();
services.AddSingleton<IClock, SystemClock>();
services.AddScoped<IUnitOfWork, UnitOfWork>();
services.AddTransient<IMyService, MyService>();
using ServiceProvider provider = services.BuildServiceProvider();
Console.WriteLine($"Engine: {Field(provider, "_engine")!.GetType().Name}");

using IServiceScope scope = provider.CreateScope();
for (int i = 1; i <= 3; i++)
{
    long t0 = Stopwatch.GetTimestamp();
    scope.ServiceProvider.GetRequiredService<IMyService>();
    var us = Stopwatch.GetElapsedTime(t0).TotalMicroseconds;
    Console.WriteLine($"call {i}: {us,8:F1} us  accessor = {AccessorMethod(provider, typeof(IMyService))}");
}
Thread.Sleep(200); // let the background compile finish
Console.WriteLine($"after compile:     accessor = {AccessorMethod(provider, typeof(IMyService))}");

static object? Field(object o, string name) =>
    o.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(o);

static object? Prop(object o, string name) =>
    o.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!.GetValue(o);

static string AccessorMethod(ServiceProvider provider, Type serviceType)
{
    foreach (DictionaryEntry e in (IDictionary)Field(provider, "_serviceAccessors")!)
    {
        if ((Type)Prop(e.Key, "ServiceType")! != serviceType) continue;
        var del = (Delegate)Prop(e.Value!, "RealizedService")!;
        return del.Method.GetType().Name.Contains("DynamicMethod")
            ? $"{del.Method.Name} (DynamicMethod)"
            : $"{del.Method.Name} in {del.Method.DeclaringType?.Name}";
    }
    return "<none>";
}

public interface IClock { DateTime Now { get; } }
public sealed class SystemClock : IClock { public DateTime Now => DateTime.UtcNow; }
public interface IUnitOfWork { }
public sealed class UnitOfWork : IUnitOfWork, IDisposable { public void Dispose() { } }
public interface IMyService { }
public sealed class MyService(IClock clock, IUnitOfWork uow) : IMyService
{
    public IClock Clock { get; } = clock;
    public IUnitOfWork Uow { get; } = uow;
}

sealed class DiEventListener : EventListener
{
    protected override void OnEventSourceCreated(EventSource source)
    {
        if (source.Name == "Microsoft-Extensions-DependencyInjection")
            EnableEvents(source, EventLevel.Verbose, EventKeywords.All);
    }

    protected override void OnEventWritten(EventWrittenEventArgs e)
    {
        if (e.EventName is not ("CallSiteBuilt" or "DynamicMethodBuilt")) return;
        var type = e.Payload![e.PayloadNames!.IndexOf("serviceType")];
        var size = e.EventName == "DynamicMethodBuilt" ? $" methodSize={e.Payload[e.PayloadNames.IndexOf("methodSize")]}" : "";
        Console.WriteLine($"  [event] {e.EventName} {type}{size} (thread {Environment.CurrentManagedThreadId})");
    }
}
```

Output on .NET 11.0.0, Release build, Apple M4:

```text
Engine: DynamicServiceProviderEngine
  [event] CallSiteBuilt Microsoft.Extensions.DependencyInjection.IServiceScopeFactory (thread 1)
  [event] CallSiteBuilt IMyService (thread 1)
call 1:   6087.0 us  accessor = <RealizeService>b__0 in <>c__DisplayClass2_0
call 2:    953.4 us  accessor = <RealizeService>b__0 in <>c__DisplayClass2_0
call 3:     10.6 us  accessor = <RealizeService>b__0 in <>c__DisplayClass2_0
  [event] DynamicMethodBuilt IUnitOfWork methodSize=143 (thread 4)
  [event] DynamicMethodBuilt IMyService methodSize=36 (thread 4)
after compile:     accessor = ResolveService (DynamicMethod)
```

Each line matches the source. `CallSiteBuilt` fires once, on the calling thread, during the first resolve. Calls 1 to 3 are still served by the reflection closure from `DynamicServiceProviderEngine`. `DynamicMethodBuilt` fires on a thread-pool thread (thread 4), first for the scoped `IUnitOfWork` resolver (143 bytes of IL, because it contains the lock and dictionary logic) and then for `IMyService` (36 bytes, because it only calls the `IUnitOfWork` method, loads the `SystemClock` constant and runs `newobj`). After that, the accessor is a `DynamicMethod`. The `IServiceScopeFactory` event is from `CreateScope()`, which resolves the scope factory through the same path.

The first-call times include JIT compilation of the container's own code paths and the call-site construction, so treat them as a single cold sample, not a measurement. Across three separate process runs call 1 took 5.5 to 6.1 ms, call 2 took 0.86 to 1.03 ms and call 3 took 7 to 13 µs.

## What resolution costs in steady state

To measure the compiled path against the reflection-only path, the same registrations were benchmarked with BenchmarkDotNet 0.15.8 (in-process emit toolchain) on .NET 11.0.0, macOS 27.0.1, Apple M4. The "runtime engine" run is the same build with `"Microsoft.Extensions.DependencyInjection.DisableDynamicEngine": true` added to `runtimeconfig.json`. Every resolve happens from an already-created scope, and `New` is a plain `new MyService(clock, uow)` baseline.

```csharp
// .NET 11.0.0, Microsoft.Extensions.DependencyInjection 11.0.0, BenchmarkDotNet 0.15.8
[Benchmark(Baseline = true)] public object New() => new MyService(_clock, _uow);
[Benchmark] public object Singleton() => _sp.GetRequiredService<IClock>();
[Benchmark] public object ScopedCached() => _sp.GetRequiredService<IUnitOfWork>();
[Benchmark] public object TransientWithDeps() => _sp.GetRequiredService<IMyService>();
[Benchmark] public object NewScopeAndResolve()
{
    using var scope = _provider.CreateScope();
    return scope.ServiceProvider.GetRequiredService<IMyService>();
}
```

| Benchmark            | Dynamic engine (default) | Allocated | Runtime engine (reflection only) | Allocated |
|----------------------|-------------------------:|----------:|---------------------------------:|----------:|
| `New` (baseline)     |                  6.67 ns |      32 B |                          6.45 ns |      32 B |
| `Singleton`          |                  6.76 ns |         - |                          6.89 ns |         - |
| `ScopedCached`       |                 20.15 ns |         - |                         21.00 ns |         - |
| `TransientWithDeps`  |                 27.32 ns |      32 B |                         74.75 ns |      72 B |
| `NewScopeAndResolve` |                111.14 ns |     456 B |                        171.23 ns |     496 B |

Error margins were below 3.5 ns for every row. The extra 40 bytes per transient on the runtime engine is the `object?[]` holding the two constructor arguments for `ConstructorInfo.Invoke`. The same reflection program from the previous section, run with the switch in `runtimeconfig.json`, reports `Engine: RuntimeServiceProviderEngine`, emits no `DynamicMethodBuilt` events, and keeps the reflection closure as the accessor forever. In that run call 2 took 143 µs instead of roughly 1 ms, which suggests most of the dynamic engine's call-2 cost is queueing the first thread-pool work item in a fresh process rather than the resolve itself.

Read the numbers by lifetime:

- **Singleton** is a `ConcurrentDictionary` lookup plus a closure that returns a captured reference, so it costs about the same as allocating a small object. The engine does not matter, because the singleton accessor never goes through the engine.
- **Scoped (already created)** pays for the accessor lookup, a `Monitor.Enter` on the scope's dictionary and a `Dictionary<ServiceCacheKey, object?>` lookup.
- **Transient with dependencies** is where IL compilation pays off: the compiled method calls the constructor directly instead of going through `ConstructorInfo.Invoke` and boxing parameters into an `object?[]`.
- **New scope + resolve** shows that creating a scope is the expensive part of a request-scoped resolve: a new `ServiceProviderEngineScope`, a new `Dictionary`, the scoped `UnitOfWork`, the disposables list, and disposal.

## Gotchas this explains

**A singleton's constructor runs under a lock on its call site.** If two threads resolve the same singleton at the same time, one waits. If a singleton constructor blocks (a sync-over-async HTTP call, a slow file read), every caller of that singleton blocks with it, and a constructor that resolves itself through `IServiceProvider` is caught by the `t_resolving` thread-static set and fails with a circular dependency error instead of deadlocking.

**Registering a service twice does not replace the first descriptor.** Both stay in `_descriptorLookup`. `GetService<T>()` uses `Last`, and `GetServices<T>()` builds an `IEnumerableCallSite` with one child per descriptor. Each child gets a different slot (the last registration is slot 0, the one before it slot 1, and so on), so `ServiceCacheKey(IFoo, 0)` and `ServiceCacheKey(IFoo, 1)` are two separate cache entries in a scope. That is why a scoped `IFoo` resolved directly and as `IEnumerable<IFoo>` is the same instance only for the last registration.

**Instance registrations never touch the engine.** `AddSingleton<IFoo>(new Foo())` becomes a `ConstantCallSite`, and the container does not own it for disposal. Factory registrations become `FactoryCallSite`, which invokes your delegate, so the factory itself can never be compiled to IL; only the code around it is.

**Native AOT and trimming keep the reflection path forever.** With `IsDynamicCodeCompiled == false` the engine is `RuntimeServiceProviderEngine`, so the "runtime engine" column above is the steady state for an AOT app. If DI is hot in an AOT service, cache resolved services in fields rather than calling `GetService` in a loop. The [Native AOT minimal API guide](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) covers the related trimming warnings for open generics.

**Validation runs at build or at first resolve, not at registration.** Because the call-site tree is only built on demand, a missing dependency shows up the first time the service is resolved unless `ValidateOnBuild` is on. The fix for that error, and how to read the message, is in [Fix: Unable to resolve service for type 'X' while attempting to activate 'Y'](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/). The scope checks that `ValidateScopes` adds are what produce [Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

**Keyed services use the same machinery.** The `ServiceIdentifier` key simply carries a non-null `ServiceKey`, so keyed and unkeyed registrations of the same type are different dictionary entries. That is the mechanical reason behind the separate-registries behaviour described in [How to register and resolve keyed services in .NET 11](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

**Scope disposal walks the disposables list in reverse.** `ServiceProviderEngineScope.Dispose` iterates `_disposables` from last to first, so services are disposed in reverse creation order. A scoped or transient service that only implements `IAsyncDisposable` throws from a synchronous `Dispose()`; use `await using` on the scope, as shown in [How to implement and consume IAsyncDisposable](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

## The whole path in one picture

```text
AddSingleton/AddScoped/AddTransient
  -> List<ServiceDescriptor>                     (no reflection, no instances)

BuildServiceProvider()
  -> CallSiteFactory._descriptorLookup           Dictionary<ServiceIdentifier, descriptors>
  -> engine = DynamicServiceProviderEngine       (RuntimeServiceProviderEngine under AOT)

GetService(T), first time
  -> _serviceAccessors miss
  -> CallSiteFactory builds call-site tree       (GetConstructors, recursive, cached in _callSiteCache)
  -> singleton: create now, accessor = () => value   (instance stored in callSite.Value)
  -> otherwise: accessor = reflection closure with call counter

GetService(T), second time (non-singleton)
  -> reflection resolve, queue ILEmitResolverBuilder on thread pool
  -> accessor replaced with DynamicMethod

Storage
  singleton -> ServiceCallSite.Value
  scoped    -> scope.ResolvedServices[ServiceCacheKey]
  transient -> nowhere, unless disposable (scope._disposables)
```

Sources: the `ServiceLookup` folder of [Microsoft.Extensions.DependencyInjection on the release/11.0 branch](https://github.com/dotnet/runtime/tree/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src), in particular [`ServiceProvider.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs), [`CallSiteFactory.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteFactory.cs), [`CallSiteRuntimeResolver.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteRuntimeResolver.cs), [`DynamicServiceProviderEngine.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/DynamicServiceProviderEngine.cs) and [`ILEmitResolverBuilder.cs`](https://github.com/dotnet/runtime/blob/release/11.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ILEmit/ILEmitResolverBuilder.cs); the [service lifetimes documentation on MS Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes); and the original [Stack Overflow question](https://stackoverflow.com/questions/80008542).
