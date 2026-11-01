---
title: "Migrate a .NET test project from Moq 4.21 to NSubstitute 6.2"
description: "A tested migration of an xUnit v3 test project on .NET 10 from Moq 4.21.0 to NSubstitute 6.2.0: the full API mapping table, out parameters, events, protected members, partial mocks, and four gotchas that a mechanical find-and-replace walks straight into."
pubDate: 2026-11-01
updatedDate: 2026-11-01
template: migration
tags:
  - "migration"
  - "dotnet"
  - "testing"
  - "csharp"
  - "nsubstitute"
  - "moq"
---

Moving a .NET test project from Moq to NSubstitute is a package swap plus a syntax rewrite: `new Mock<T>()` becomes `Substitute.For<T>()`, `.Object` disappears because the substitute *is* the object, `Setup(x => x.M()).Returns(v)` becomes `sub.M().Returns(v)`, and `Verify(x => x.M(), Times.Once)` becomes `sub.Received(1).M()`. Both packages can live in the same project, so you can convert one test file at a time and keep the suite green between commits. Budget roughly 5 to 15 minutes per test class, most of it spent on `Callback`, out parameters, `Protected()` and `MockBehavior.Strict`, which have no one-token equivalent. The parts that bite are not the syntax but four behaviour differences: argument matchers mixed with literals, default return values, re-configuring a call that throws, and the fact that NSubstitute cannot tell you at runtime that you asserted on a non-virtual member.

Everything here was run on the .NET 10 SDK 10.0.302, xUnit v3 4.0.2 on Microsoft.Testing.Platform, Moq 4.21.0 (September 2026), NSubstitute 6.2.0 (August 2026) and NSubstitute.Analyzers.CSharp 1.0.17. I wrote one test class per library against the same small `OrderService` and ran both side by side in a single project: 12 tests, all passing on both. Every exception message quoted below is the actual output from that project.

## Why teams move off Moq, and why that is not urgent

- **Trust.** Moq 4.20.0 (August 2023) shipped SponsorLink, which read the developer's git email at build time and sent a hash of it to a remote service. It was pulled in 4.20.69 after [a public outcry](https://github.com/devlooped/moq/issues/1372), but many organisations put Moq on a deny list that week and never took it off.
- **Less ceremony.** NSubstitute configures and asserts by calling the member on the substitute itself. No lambdas, no `.Object`, no separate mock for every nested interface, because interface-typed members return auto-created substitutes.
- **Readable failures.** A failed `Received` call lists the calls that did arrive and marks the mismatched argument with asterisks, which is often enough to fix the test without a debugger.

To be fair to Moq: it is maintained. 4.21.0 shipped on 2026-09-24 with a faster `It.Is` and nullable annotations on its constructors. If your only reason to migrate is "Moq is dead", it is not, and a working suite has value. Migrate because you want the syntax or because policy requires it.

## What changes between Moq 4.21 and NSubstitute 6.2

| Area | Moq 4.21.0 | NSubstitute 6.2.0 | Severity |
| --- | --- | --- | --- |
| Arrange syntax | `Setup(lambda).Returns(v)` | `sub.Member(args).Returns(v)` | high (every test) |
| Assert syntax | `Verify(lambda, Times.X)` | `sub.Received(n).Member(args)` | high (every test) |
| Literal mixed with matcher | works | `AmbiguousArgumentsException` | high |
| Default for `string` and interface members | `null` | `""` and a recursive substitute | medium |
| Strict mocks | `MockBehavior.Strict` | none | medium |
| Non-virtual member in assert | `NotSupportedException` | passes silently | medium (analyzer catches it) |
| Re-configuring a call that throws | fine | rethrows, needs `Configure()` | low |
| Target frameworks | net462, netstandard2.0/2.1, net6.0 | net8.0, netstandard2.0 | low |

The target framework row matters only for .NET Framework test projects: NSubstitute 5.3.0 still shipped a `net462` build, while NSubstitute 6 dropped it and serves .NET Framework projects from the `netstandard2.0` assets. That works, but Microsoft recommends .NET Framework 4.7.2 or later for consuming .NET Standard 2.0 libraries, so on older Framework versions NSubstitute 5.3.0 is the safer target (the mapping in this post is the same, minus `Protected`).

## Pre-flight checklist

- Test project builds and passes today. Record the test count (`dotnet test` prints `total: N`), you will compare against it.
- Commit or stash everything. You want each converted file to be a reviewable diff.
- Note any `InternalsVisibleTo("DynamicProxyGenAssembly2, ...")` attribute. Both libraries emit proxies through Castle.Core (NSubstitute 6.2.0 depends on Castle.Core 5.1.1), so the existing grant keeps working unchanged. The [strong-named InternalsVisibleTo post](/2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto/) has the exact attribute if you are missing it.
- Search for `Mock<` usages outside test projects (shared test-helper libraries, builders). They migrate too.

## Migration steps

1. **Add NSubstitute and its analyzer next to Moq.** Do not remove Moq yet. Verify with a `dotnet build` that both restore.

   ```xml
   <!-- Shop.Tests.csproj, .NET 10 -->
   <ItemGroup>
     <PackageReference Include="Moq" Version="4.21.0" />
     <PackageReference Include="NSubstitute" Version="6.2.0" />
     <PackageReference Include="NSubstitute.Analyzers.CSharp" Version="1.0.17" PrivateAssets="all" />
   </ItemGroup>
   ```

   The analyzer is not optional in practice. It is the only thing that flags the silent non-virtual case described in the gotchas.

2. **Convert creation and drop `.Object`.** `new Mock<IOrderRepository>()` becomes `Substitute.For<IOrderRepository>()`, `Mock.Of<T>()` becomes `Substitute.For<T>()`, `Mock.Get(obj)` becomes `obj`, and every `mock.Object` becomes `mock`. Rename the variables while you are there (`repoMock` to `repo`), because the substitute is now passed directly to the system under test. Verify: the file compiles once the next two steps are done.

3. **Rewrite arrangements.** Remove the `Setup` lambda and call the member directly, then swap the matchers: `It.IsAny<T>()` to `Arg.Any<T>()`, `It.Is<T>(p)` to `Arg.Is<T>(p)`. `ReturnsAsync(v)` becomes plain `Returns(v)`, because NSubstitute has `Returns` overloads for `Task<T>` and `ValueTask<T>` that wrap the value for you.

   ```csharp
   // Moq 4.21.0
   payments.Setup(p => p.ChargeAsync(It.IsAny<string>(), It.Is<decimal>(a => a > 0)))
           .ReturnsAsync(true);

   // NSubstitute 6.2.0
   payments.ChargeAsync(Arg.Any<string>(), Arg.Is<decimal>(a => a > 0))
           .Returns(true);
   ```

4. **Rewrite assertions.** `Verify(x => x.M(), Times.Once)` becomes `sub.Received(1).M()`, `Times.Never` becomes `DidNotReceive()`, and `Times.AtLeastOnce` becomes `Received()` with no count. For an async member, `await` the `Received` call (`await payments.DidNotReceive().ChargeAsync(...)`): it returns a completed task, and awaiting it keeps the async analyzers quiet. Verify: run the converted class and compare its test count with the Moq version.

5. **Port the special cases** (out parameters, callbacks, events, protected members, partial mocks) using the patterns in the sections below. These are the only places where you have to think.

6. **Delete the Moq usings, then the package.** Once `grep -rn "using Moq" .` returns nothing, remove the `Moq` `PackageReference`. Verify: `dotnet test` reports the same `total:` as before the migration with zero failures.

## A complete test, before and after

This is the same test in both libraries. Note the line that disappeared: Moq needs an explicit `IAuditLog` mock wired into the `Audit` property, while NSubstitute auto-creates a substitute for any interface-typed member, and returns the same instance every time, so you can assert on `repo.Audit` directly.

```csharp
// .NET 10, Moq 4.21.0, xUnit v3 4.0.2
[Fact]
public async Task Places_order_and_audits()
{
    var repo = new Mock<IOrderRepository>();
    var audit = new Mock<IAuditLog>();
    repo.Setup(r => r.Audit).Returns(audit.Object);
    var payments = new Mock<IPaymentGateway>();
    payments.Setup(p => p.ChargeAsync(It.IsAny<string>(), It.Is<decimal>(a => a > 0)))
            .ReturnsAsync(true);

    var sut = new OrderService(repo.Object, payments.Object);
    var ok = await sut.PlaceAsync(new Order(7, "ana", 30m));

    Assert.True(ok);
    repo.Verify(r => r.Save(It.Is<Order>(o => o.Id == 7)), Times.Once);
    audit.Verify(a => a.Write("placed 7"), Times.Once);
    payments.Verify(p => p.ChargeAsync("bob", It.IsAny<decimal>()), Times.Never);
}
```

```csharp
// .NET 10, NSubstitute 6.2.0, xUnit v3 4.0.2
[Fact]
public async Task Places_order_and_audits()
{
    var repo = Substitute.For<IOrderRepository>();
    var payments = Substitute.For<IPaymentGateway>();
    payments.ChargeAsync(Arg.Any<string>(), Arg.Is<decimal>(a => a > 0))
            .Returns(true);

    var sut = new OrderService(repo, payments);
    var ok = await sut.PlaceAsync(new Order(7, "ana", 30m));

    Assert.True(ok);
    repo.Received(1).Save(Arg.Is<Order>(o => o.Id == 7));
    repo.Audit.Received(1).Write("placed 7");
    await payments.DidNotReceive().ChargeAsync("bob", Arg.Any<decimal>());
}
```

## The API mapping table

| Moq 4.21.0 | NSubstitute 6.2.0 |
| --- | --- |
| `new Mock<T>()`, `Mock.Of<T>()` | `Substitute.For<T>()` |
| `mock.Object`, `Mock.Get(obj)` | the substitute itself |
| `new Mock<T> { CallBase = true }` | `Substitute.ForPartsOf<T>()` |
| `mock.As<IOther>()` | `Substitute.For<T, IOther>()` |
| `It.IsAny<T>()` / `It.Is<T>(p)` | `Arg.Any<T>()` / `Arg.Is<T>(p)` |
| `It.IsAnyType` | `Arg.AnyType` |
| `It.IsIn(a, b)` | `Arg.Is<T>(x => new[] { a, b }.Contains(x))` |
| `.Returns(v)` / `.ReturnsAsync(v)` | `.Returns(v)` |
| `.Returns((int id) => ...)` | `.Returns(call => ... call.Arg<int>() ...)` |
| `SetupSequence(...).Returns(a).Returns(b)` | `.Returns(a, b)` |
| `.Throws(ex)` / `.ThrowsAsync(ex)` | `.Throws(ex)` / `.ThrowsAsync(ex)` (`using NSubstitute.ExceptionExtensions;`) |
| `.Callback<T>(action)` | `Arg.Do<T>(action)` in the call, or `.AndDoes(call => ...)` |
| `SetupProperty(x => x.P)`, `SetupAllProperties()` | nothing to do: read/write properties already remember the last value set |
| `Verify(..., Times.Once)` / `Times.Exactly(n)` | `Received(1)` / `Received(n)` |
| `Verify(..., Times.AtLeastOnce)` | `Received()` |
| `Verify(..., Times.Never)` | `DidNotReceive()` |
| `Times.AtMost(n)`, `Times.Between(...)` | count `sub.ReceivedCalls()` yourself |
| `MockSequence` / `InSequence` | `Received.InOrder(() => { ... })` |
| `VerifyNoOtherCalls()` | assert on `sub.ReceivedCalls()` |
| `mock.Raise(x => x.E += null, sender, args)` | `sub.E += Raise.Event<EventHandler<T>>(sender, args)` |
| `mock.Protected().Setup<R>("Name", ItExpr.IsAny<T>())` | `sub.Protected("Name", Arg.Any<T>()).Returns(...)` (`using NSubstitute.Extensions;`, new in 6.0) |
| `mock.Reset()` | `sub.ClearSubstitute()` or `sub.ClearReceivedCalls()` |
| `MockBehavior.Strict`, `VerifyAll()`, `Verifiable()` | no equivalent, see below |

## The special cases, ported

**Out parameters.** Moq captures the value of the variable at setup time. NSubstitute puts a matcher in the out position and assigns the slot from the `CallInfo` inside `Returns`:

```csharp
// Moq 4.21.0
var cached = new Order(1, "ana", 10m);
repo.Setup(r => r.TryGetCached(1, out cached)).Returns(true);

// NSubstitute 6.2.0
var cached = new Order(1, "ana", 10m);
repo.TryGetCached(1, out Arg.Any<Order?>())
    .Returns(call => { call[1] = cached; return true; });
```

`call[1]` is the argument index, so it breaks silently if someone reorders the parameters. Keep these setups close to the interface they mock.

**Callbacks.** For "capture what was passed in", `Arg.Do` reads better than Moq's `Callback`, and it works on `void` members without a `When`:

```csharp
// NSubstitute 6.2.0
var saved = new List<Order>();
repo.Save(Arg.Do<Order>(saved.Add));
```

**Sequences and exceptions.** `Returns(a, b)` replaces `SetupSequence`, and `ThrowsAsync` works on any `Task`-returning member once you import `NSubstitute.ExceptionExtensions`:

```csharp
// NSubstitute 6.2.0
repo.Find(Arg.Any<int>()).Returns(new Order(1, "a", 1m), (Order?)null);
repo.CountAsync("boom", Arg.Any<CancellationToken>()).ThrowsAsync(new TimeoutException());
```

The `(Order?)null` cast is not decoration. Gotcha 3 explains why.

**Events.** `Raise.Event` uses the event subscription syntax, so the compiler checks the delegate type:

```csharp
// NSubstitute 6.2.0
payments.Refunded += Raise.Event<EventHandler<decimal>>(payments, 12m);
```

**Protected members.** Before 6.0 this was the classic reason to keep Moq around for `HttpMessageHandler` tests. NSubstitute 6.0 added a string-based `Protected` extension, close to Moq's:

```csharp
// NSubstitute 6.2.0
using NSubstitute.Extensions;

var notifier = Substitute.For<Notifier>();
notifier.Protected("SendCore", Arg.Any<string>()).Returns(true);
Assert.True(notifier.Notify("x"));
```

For `HttpClient` specifically, a hand-written handler is still the cleaner seam; the [HttpClient unit testing guide](/2026/04/how-to-unit-test-code-that-uses-httpclient/) shows why.

**Partial mocks.** `ForPartsOf<T>()` calls the real implementation for everything you did not configure. Configure overrides through `Configure()`:

```csharp
// NSubstitute 6.2.0
var calc = Substitute.ForPartsOf<PriceCalculator>();
calc.Configure().TaxRate().Returns(0.5m);
Assert.Equal(150m, calc.WithTax(100m));
```

Without `Configure()`, the line `calc.TaxRate().Returns(0.5m)` executes the *real* `TaxRate()` once while configuring it. If the real method throws, talks to a database or has a side effect, so does your arrangement. I confirmed this with a virtual method that throws `InvalidOperationException`: the plain form threw, the `Configure()` form did not.

**Strict mocks.** NSubstitute has no `MockBehavior.Strict`. The closest replacement is asserting the exact set of calls at the end of the test:

```csharp
// NSubstitute 6.2.0
log.Received(1).Write("a");
Assert.Single(log.ReceivedCalls());
```

If a test relied on strict mode to fail fast on an unexpected call deep inside the system under test, that intent is now expressed after the fact. It is usually fine, but read those tests rather than converting them mechanically.

## Verification

- `dotnet test` reports the same total as before, zero failures. With Microsoft.Testing.Platform as the runner (see the [VSTest to MTP migration](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/)) a count mismatch is easy to spot in the summary.
- `dotnet build` shows no `NS1xxx` or `NS5xxx` warnings except the known false positives on `Protected` (gotcha 4).
- `grep -rn "Moq" --include=*.cs --include=*.csproj .` returns nothing.
- Spot-check that a deliberately broken assertion still fails. Change one `Received(1)` to `Received(2)` and confirm the test goes red: this catches assertions that silently became no-ops.

## Rollback plan

The migration is fully reversible until step 6. Moq and NSubstitute coexist in one project with no conflicts (my repro project referenced both for every run), so a test file that proves hard can stay on Moq while the rest moves. Reverting a converted file is a `git checkout` of that file. After step 6, rollback is re-adding the package reference.

## Gotchas a find-and-replace walks into

**1. Literals mixed with matchers throw `AmbiguousArgumentsException`.** Moq reads an expression tree, so `Setup(c => c.Add(0, It.IsAny<int>()))` is unambiguous. NSubstitute sees real values: `Arg.Any<int>()` returns `0` and queues a matcher, and when a literal `0` sits next to it in an argument of the same type, NSubstitute cannot tell which position the matcher belongs to:

```text
NSubstitute.Exceptions.AmbiguousArgumentsException: Cannot determine argument specifications to use. Please use specifications for all arguments of the same type.
Method signature:
    Add(Int32, Int32)
Method arguments (possible arg matchers are indicated with '*'):
    Add(*0*, *0*)
```

The analyzer did not flag this one. The fix is to wrap the literal: `calc.Add(Arg.Is(0), Arg.Any<int>()).Returns(1)`. It only happens when the literal equals the type's default value, which is exactly why it slips past a first test run with other numbers.

**2. Defaults changed under your assertions.** An unconfigured Moq mock (`DefaultValue.Empty`) returns `null` for a `string` property and for an interface-typed property. NSubstitute returns `""` for strings and a recursive substitute for interfaces, delegates and purely virtual classes; both libraries return a completed task for `Task<int>`. Any test with `Assert.Null(sub.Region)` fails after the swap, and production code with `if (repo.Audit is null)` now takes the other branch. The [auto and recursive mocks](https://nsubstitute.github.io/help/auto-and-recursive-mocks/) page lists the rules.

**3. `Returns(value, null)` is a one-element sequence.** I converted `SetupSequence(...).Returns(order).Returns((Order?)null)` to `Returns(order, null)` and the second call returned the order again:

```text
Assert.Null() Failure: Value is not null
Expected: null
Actual:   Order { Id = 1, Customer = a, Total = 1 }
```

The signature is `Returns(T returnThis, params T[] returnThese)`. A bare `null` converts to `T[]`, so C# picks the normal form and passes a null array instead of an array holding `null`. Cast it, `Returns(order, (Order?)null)`, and the expanded form wins.

**4. Assertions on non-virtual members pass silently, and the analyzer lags behind 6.0.** Moq rejects a non-virtual member outright: `NotSupportedException: Non-overridable members (here: PriceCalculator.Discount) may not be used in setup / verification expressions.` NSubstitute cannot intercept the call, so `calc.Received(3).Discount()` just runs the real method and the test passes, even though `Discount()` was never called. Configuring it with `Returns` does throw (`CouldNotSetReturnDueToNoLastCallException`), but the assert side is silent. Only the analyzer catches it, as `NS1001: Member Discount can not be intercepted`. Consider `<WarningsAsErrors>NS1000;NS1001</WarningsAsErrors>` in test projects.

The catch: NSubstitute.Analyzers 1.0.17 dates from February 2024 and does not know the `Protected` extension added in NSubstitute 6.0, so every `sub.Protected("SendCore", Arg.Any<string>())` line raises NS1000 and NS1004 false positives. This is tracked in [NSubstitute.Analyzers issue #228](https://github.com/nsubstitute/NSubstitute.Analyzers/issues/228). Suppress it locally with `#pragma warning disable NS1000, NS1004` around those lines rather than project-wide, or you lose the protection from the previous paragraph.

**A smaller one: overlapping setups.** As in Moq, the last matching configuration wins. `calc.Add(1, 2).Returns(10)` followed by `calc.Add(Arg.Any<int>(), Arg.Any<int>()).Returns(99)` makes `Add(1, 2)` return `99`. Put the general setup first and the specific ones after it. And if the earlier setup was a `Throws`, reconfiguring it with `repo.Find(1).Returns(...)` rethrows the configured exception during the arrangement; `repo.Configure().Find(1).Returns(...)` is the [safe configuration](https://nsubstitute.github.io/help/configure/) escape hatch.

## Related

- If the same pull request also moves the test framework, follow [migrating from xUnit v2 to xUnit v3](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/) first, then swap the mocking library.
- Mocking `DbContext` is where most mock-heavy suites hurt; [mocking DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) covers when to stop mocking it.
- Time is a dependency you should not mock with either library: [FakeTimeProvider for time-dependent code](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).

## Sources

- [NSubstitute 6.0.0 release notes](https://github.com/nsubstitute/NSubstitute/releases/tag/v6.0.0), [6.1.0](https://github.com/nsubstitute/NSubstitute/releases/tag/v6.1.0) (nullable annotations reverted) and [6.2.0](https://github.com/nsubstitute/NSubstitute/releases/tag/v6.2.0).
- [Moq 4.21.0 release notes](https://github.com/devlooped/moq/releases/tag/v4.21.0) and the [SponsorLink privacy issue](https://github.com/devlooped/moq/issues/1372).
- NSubstitute docs: [argument matchers](https://nsubstitute.github.io/help/argument-matchers/), [setting out and ref arguments](https://nsubstitute.github.io/help/setting-out-and-ref-arguments/), [partial subs](https://nsubstitute.github.io/help/partial-subs/), [raising events](https://nsubstitute.github.io/help/raising-events/), [received in order](https://nsubstitute.github.io/help/received-in-order/), [NSubstitute.Analyzers](https://nsubstitute.github.io/help/nsubstitute-analysers/).
- [NSubstitute.Analyzers issue #228](https://github.com/nsubstitute/NSubstitute.Analyzers/issues/228): analyzers not updated for NSubstitute 6.0.
