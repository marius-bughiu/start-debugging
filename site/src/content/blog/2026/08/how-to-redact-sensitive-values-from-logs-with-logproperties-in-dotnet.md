---
title: "How to redact sensitive values from logs with LogProperties and data redaction in .NET"
description: "A complete guide to redacting classified data in source-generated logs: build a taxonomy, write a Redactor, wire EnableRedaction and AddRedaction, and understand the discriminator that silently breaks partial masking. With real output from Microsoft.Extensions.Compliance.Redaction 10.9.0."
pubDate: 2026-08-17
template: how-to
tags:
  - "dotnet"
  - "logging"
  - "security"
  - "source-generators"
---

Redacting sensitive values in .NET logs takes three moving parts that must all be present: a data classification attribute on the property, `AddRedaction` to register redactors in DI, and `EnableRedaction` on the logging builder. Miss the classification and nothing is protected. Miss `EnableRedaction` and the classified values are dropped from the structured state entirely. Miss `AddRedaction` while `EnableRedaction` is on, and the raw values are written to your logs in plain text. This post walks all three, plus the redaction discriminator that quietly breaks any redactor doing partial masking.

Everything below was compiled and run against `Microsoft.Extensions.Compliance.Redaction` 10.9.0, `Microsoft.Extensions.Compliance.Abstractions` 10.9.0, and `Microsoft.Extensions.Telemetry` 10.9.0, on the .NET 10.0.201 SDK targeting `net10.0`. These packages ship on the `dotnet/extensions` cadence rather than the runtime's, and 10.9.0 (released 11 August 2026) targets `net8.0`, `net9.0`, `net10.0`, and `net462`, so the same code applies on .NET 8 through the current .NET 11 previews. There is no 11.x release of these packages yet.

## What the source generator actually emits for a classified property

The whole feature rests on one thing: the `[LoggerMessage]` source generator emits classified values into a *separate array* from ordinary tags. Given this log method:

```csharp
// Microsoft.Extensions.Telemetry.Abstractions 10.9.0, net10.0
public static partial class Log
{
    [LoggerMessage(2, LogLevel.Information, "Via LogProperties")]
    public static partial void ViaProps(this ILogger logger, [LogProperties] Payment payment);
}
```

the generator produces (trimmed, but otherwise verbatim from `EmitCompilerGeneratedFiles`):

```csharp
var state = LoggerMessageHelper.ThreadLocalState;

_ = state.ReserveTagSpace(2);
state.TagArray[1] = new("{OriginalFormat}", "Via LogProperties");
state.TagArray[0] = new("payment.Amount", payment?.Amount);

_ = state.ReserveClassifiedTagSpace(2);
state.ClassifiedTagArray[1] = new("payment.CardNumber", payment?.CardNumber,
    new DataClassificationSet(_SensitiveAttribute));
state.ClassifiedTagArray[0] = new("payment.Cvv", payment?.Cvv,
    new DataClassificationSet(_SensitiveAttribute));
```

`Amount` goes into `TagArray`. `CardNumber` and `Cvv` go into `ClassifiedTagArray` alongside the `DataClassificationSet` that came from the attribute. Nothing here redacts anything: the generator only *labels* the values. Whoever consumes `LoggerMessageState` decides what happens next, which is why the wiring matters so much. If you are new to how `[LoggerMessage]` generates code in the first place, the background in [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) is worth a detour.

## Building the taxonomy, attributes, and a redactor

A classification is a `(TaxonomyName, Value)` pair. Define them once in a static class so the whole solution shares one vocabulary:

```csharp
// Microsoft.Extensions.Compliance.Abstractions 10.9.0
using Microsoft.Extensions.Compliance.Classification;

public static class Taxonomy
{
    public const string Name = "Contoso";

    public static DataClassification Sensitive => new(Name, nameof(Sensitive));
    public static DataClassification Pii => new(Name, nameof(Pii));
}
```

The MS Learn samples for this feature show classified parameters written as `[MyTaxonomyClassifications.Private] string SSN`. That does not compile: a static property is not an attribute. You need a real `DataClassificationAttribute` subclass per classification, which is what the [data classification docs](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification) describe correctly:

```csharp
public sealed class SensitiveAttribute : DataClassificationAttribute
{
    public SensitiveAttribute() : base(Taxonomy.Sensitive) { }
}

public sealed class PiiAttribute : DataClassificationAttribute
{
    public PiiAttribute() : base(Taxonomy.Pii) { }
}
```

Now decorate the model. Anything without an attribute is logged as-is:

```csharp
public sealed class Payment
{
    [Sensitive] public string CardNumber { get; set; } = "";
    [Pii] public string Email { get; set; } = "";
    public int Amount { get; set; }
    [LogPropertyIgnore] public string InternalTrace { get; set; } = "";
}
```

A redactor is an abstract class with two members. `GetRedactedLength` sizes the destination buffer, `Redact` fills it and returns how many characters it wrote:

```csharp
// Microsoft.Extensions.Compliance.Redaction 10.9.0
using Microsoft.Extensions.Compliance.Redaction;

public sealed class LastFourRedactor : Redactor
{
    public override int GetRedactedLength(ReadOnlySpan<char> input)
        => input.Length <= 4 ? input.Length : 4 + 4;

    public override int Redact(ReadOnlySpan<char> source, Span<char> destination)
    {
        if (source.Length <= 4)
        {
            source.CopyTo(destination);
            return source.Length;
        }

        "****".CopyTo(destination);
        source[^4..].CopyTo(destination[4..]);
        return 8;
    }
}
```

The span-based signature is deliberate: the logging pipeline redacts from span to span through a pooled `JustInTimeRedactor`, so a well-written redactor allocates nothing per log record.

## Wiring it up

Four steps, and all four are load-bearing:

1. Install `Microsoft.Extensions.Compliance.Redaction` for the redactors and `Microsoft.Extensions.Telemetry` for the logging integration. The classification types come transitively from `Microsoft.Extensions.Compliance.Abstractions`.
2. Call `AddRedaction` on the service collection and map each classification to a redactor.
3. Call `EnableRedaction` on the logging builder. This swaps in `ExtendedLogger`, which is the only component that reads `ClassifiedTagArray`.
4. Log through a source-generated `[LoggerMessage]` method. Redaction does not apply to `logger.LogInformation(...)`.

```csharp
var services = new ServiceCollection();

services.AddLogging(b =>
{
    b.AddJsonConsole();
    b.EnableRedaction();          // Microsoft.Extensions.Logging namespace
});

services.AddRedaction(r =>
{
    r.SetRedactor<LastFourRedactor>(Taxonomy.Sensitive);
    r.SetFallbackRedactor<ErasingRedactor>();
});
```

`EnableRedaction` lives in the `Microsoft.Extensions.Logging` namespace despite shipping in the `Microsoft.Extensions.Telemetry` package, so the `using Microsoft.Extensions.Telemetry;` in the official sample is not needed.

## The three configurations and what each one really logs

This is where the feature bites. Here is the same `Payment` logged under three different wirings, taken from actual `JsonConsole` output.

**`AddRedaction` registered, `EnableRedaction` not called.** The plain `ILogger` never looks at `ClassifiedTagArray`, so the classified properties are absent from the structured state and the flattened message shows a placeholder:

```json
{"State":{"Message":"customer.Plan=enterprise,customer.Id=42,customer.CardNumber=<omitted> ([Contoso:Sensitive]),customer.Email=<omitted> ([Contoso:Pii])","customer.Plan":"enterprise","customer.Id":42}}
```

No leak, but no data either, and no error telling you redaction is off. This behaviour is tracked in [dotnet/extensions issue 5163](https://github.com/dotnet/extensions/issues/5163).

**`EnableRedaction` called, `AddRedaction` never called.** This is the dangerous one. With no `IRedactorProvider` in the container, the pipeline falls through to a pass-through redactor and writes the raw value:

```json
{"State":{"customer.CardNumber":"4111111111111111:customer.CardNumber","customer.Email":"ada@contoso.com:customer.Email"}}
```

Your card numbers are now in the log file, with the tag name helpfully appended. Nothing warns you. If you take one thing from this post: `EnableRedaction` and `AddRedaction` must be added together, and an integration test that greps the log sink for a known secret is cheap insurance.

**Both called.** Classified values are redacted, unclassified ones pass through untouched, and `[LogPropertyIgnore]` properties never appear at all:

```json
{"State":{"payment.Email":"****","payment.CardNumber":"****","payment.Amount":1999}}
```

Calling `AddRedaction()` with no configuration at all is safe: the default fallback is `ErasingRedactor`, so every classified value becomes an empty string. Verified directly against the provider, `GetRedactor` returns `ErasingRedactor` for an unmapped classification and for `DataClassification.Unknown`, and `NullRedactor` (pass-through) only for `DataClassification.None`.

## The discriminator that breaks partial masking

Register the `LastFourRedactor` from earlier, log a card number of `4111111111111111`, and you get this:

```json
{"payment.CardNumber":"****mber","payment.Email":"****mail"}
```

`mber` is the last four characters of `payment.CardNumber`, not of the card. The redactor never saw the value on its own. Instrumenting `Redact` with a spy shows exactly what arrives:

```text
[spy] Redact saw: "4111111111111111:payment.CardNumber" (len 35)
[spy] Redact saw: "ada@contoso.com:payment.Email"      (len 29)
```

This is intentional, not a bug. `ExtendedLogger` builds each redaction through `JustInTimeRedactor.Get(value, redactor, discriminator)` where the discriminator is the tag name, and `LoggerRedactionOptions.ApplyDiscriminator` defaults to `true`. The documented rationale is correlation resistance: including the tag name in the redacted text makes it impossible to tell that a hashed `user.Email` and a hashed `contact.Email` are the same address. That is a genuinely good default for hashing redactors, and a silent correctness bug for anything that inspects the input.

The fix is one option:

```csharp
b.EnableRedaction(o => o.ApplyDiscriminator = false);
```

With the discriminator off, the same redactor produces what you expected:

```json
{"payment.CardNumber":"****1111","payment.Email":"****.com"}
```

Turn it off only for redactors that must see the real value. If you rely on hashed values to spot repeat offenders across a single field, leave it on. Note that a redactor invoked directly through `IRedactorProvider` never sees a discriminator, so a unit test of your redactor in isolation will pass while the logging pipeline misbehaves. Test through the logger.

## Hashing instead of erasing

`HmacRedactor` produces a stable `HMACSHA256` hash, which lets you correlate occurrences of the same value without storing it:

```csharp
#pragma warning disable EXTEXP0002
services.AddRedaction(r => r.SetHmacRedactor(o =>
{
    o.KeyId = 42;
    o.Key = Convert.ToBase64String(keyBytes);   // base64, at least 44 chars
}, Taxonomy.Pii));
#pragma warning restore EXTEXP0002
```

Real output, with `ApplyDiscriminator` off:

```json
{"payment.Email":"42:AjapxXMS14J9i8GFw62JBQ==","payment.CardNumber":""}
```

The `42:` prefix is the `KeyId`, so you can tell which key produced a hash after a rotation. Two caveats. `SetHmacRedactor` is experimental and raises `EXTEXP0002`, so you need an explicit suppression or `<NoWarn>$(NoWarn);EXTEXP0002</NoWarn>`. And `CardNumber` came out empty above because it is classified `Sensitive`, which has no mapped redactor here and therefore hits the `ErasingRedactor` fallback. Map every classification you define, or the fallback will quietly decide for you.

## The rest of the LogProperties surface

`[LogProperties]` has more knobs than most people use:

```csharp
[LoggerMessage(4, LogLevel.Information, "Charging customer")]
public static partial void Charging(this ILogger logger,
    [LogProperties(OmitReferenceName = false, SkipNullProperties = true)] Customer customer);
```

`OmitReferenceName` defaults to `false`, which is what produces the `customer.` prefix on every tag name; set it to `true` and the tags become plain `Id`, `Plan`, and so on. `SkipNullProperties = true` omits null-valued properties from the state instead of writing nulls. Both are ordinary compile-time options with no runtime cost.

Nested objects are not walked by default. A `Customer.Address` of a complex type produces a build warning rather than silently stringifying:

```text
warning LOGGEN036: The type "Address?" doesn't implement ToString(), IConvertible, or IFormattable
(did you forget to apply [LogProperties] or [TagProvider] to "Address"?)
```

Fix it by putting `[LogProperties]` on the nested property itself, which then emits `customer.Address.Street` tags, classification attributes on `Address` included. There is also `[LogProperties(Transitive = true)]` to walk the graph automatically, but it is marked experimental and fails the build with `EXTEXP0003` until suppressed.

## Classifying values you cannot attribute

Attributes only work on types you own. For a third-party DTO, or when the classification depends on runtime state, use `[TagProvider]` and classify inside a hand-written collector method:

```csharp
public static class SessionTagProvider
{
    public static void Provide(ITagCollector collector, Session session)
    {
        collector.Add("user", session.User);
        collector.Add("token", session.Token, new DataClassificationSet(Taxonomy.Sensitive));
    }
}

[LoggerMessage(2, LogLevel.Information, "Session opened")]
public static partial void Opened(this ILogger logger,
    [TagProvider(typeof(SessionTagProvider), nameof(SessionTagProvider.Provide),
                 OmitReferenceName = true)] Session session);
```

The `ITagCollector.Add` overload taking a `DataClassificationSet` is the programmatic equivalent of a classification attribute, and the value flows into `ClassifiedTagArray` exactly the same way. Watch the naming: by default the parameter name is prepended to whatever key you pass, so `collector.Add("session.token", ...)` on a parameter named `session` emits the tag `session.session.token`. Pass bare keys and let the parameter name supply the prefix, or pass bare keys and set `OmitReferenceName = true` to drop the prefix entirely. Do not spell the prefix out yourself.

## Proving it with a test

`FakeLogger` from `Microsoft.Extensions.Diagnostics.Testing` 10.9.0 runs behind the same `ExtendedLogger`, so redaction applies and the redacted tags are readable through `FakeLogCollector`. That makes the leak assertion straightforward:

```csharp
var services = new ServiceCollection();
services.AddLogging(b => { b.AddFakeLogging(); b.EnableRedaction(); });
services.AddRedaction(r => r.SetRedactor<StarRedactor>(Taxonomy.Sensitive));

using var sp = services.BuildServiceProvider();
sp.GetRequiredService<ILoggerFactory>().CreateLogger("T")
  .Taken(new Payment { CardNumber = "4111111111111111", Amount = 1999 });

var records = sp.GetRequiredService<FakeLogCollector>().GetSnapshot();
Assert.DoesNotContain("4111111111111111",
    string.Join('\n', records.SelectMany(r => r.StructuredState ?? [])
                             .Select(kv => $"{kv.Key}={kv.Value}")));
```

The structured state for that record is exactly `payment.CardNumber = ****`, `payment.Amount = 1999`, `{OriginalFormat} = Payment taken`. Assert on the absence of the secret rather than the presence of `****`, so the test still catches a regression if someone swaps the redactor.

Two things that surprised me. Redaction only applies to source-generated log methods, so any remaining `logger.LogInformation($"card {card}")` in the codebase is completely unprotected. If you have not done that sweep yet, [converting interpolated ILogger calls to message templates](/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) is the prerequisite for this whole feature. Second, `EnableRedaction` changes what `JsonConsole` writes into the nested `State.Message` field: it becomes the literal string `Microsoft.Extensions.Logging.ExtendedLogger+ModernTagJoiner`. The top-level `Message` is still correct and every individual tag is still present, but if you have a downstream parser reading `State.Message`, it will break. Structured sinks that enumerate the state, like those covered in the [Serilog and Seq setup guide](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) or an [OpenTelemetry logging pipeline](/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/), are unaffected.

The strongest argument for this feature is that classification lives on the model, next to the property, where the developer adding a field will see it. Redaction policy lives in one composition-root call that a security reviewer can read in ten seconds. That separation is worth the setup cost, provided you actually assert on it: add one test that logs a fully populated model to an in-memory sink and fails if any known-secret string appears in the output.

## Sources

- [Compile-time logging source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/source-generation), MS Learn
- [Data classification in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification), MS Learn
- [Data redaction in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-redaction), MS Learn
- [ExtendedLogger.ModernPath](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/ExtendedLogger.cs) and [JustInTimeRedactor](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/JustInTimeRedactor.cs), dotnet/extensions
- [LoggerRedactionOptions.ApplyDiscriminator](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/LoggerRedactionOptions.cs), dotnet/extensions
- [dotnet/extensions issue 5163](https://github.com/dotnet/extensions/issues/5163), on LogProperties output when redaction is disabled
