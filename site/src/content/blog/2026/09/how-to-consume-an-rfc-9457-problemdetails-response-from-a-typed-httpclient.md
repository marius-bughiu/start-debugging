---
title: "How to consume an RFC 9457 ProblemDetails response from a typed HttpClient without referencing ASP.NET Core"
description: "The BCL has no ProblemDetails type, and adding a FrameworkReference to Microsoft.AspNetCore.App makes your client refuse to start on a runtime-only container. Here is the 20-line model that does the job, the DelegatingHandler that turns problem+json into a typed exception, and the content-type myth that most answers still repeat."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "httpclient"
  - "system-text-json"
  - "aspnetcore-11"
  - "how-to"
---

Short answer: do not reference ASP.NET Core. Declare a five-property class with an `[JsonExtensionData]` dictionary for the extension members, and deserialize it with `HttpContent.ReadFromJsonAsync<T>` from `System.Net.Http.Json`. The `application/problem+json` media type parses fine because `ReadFromJsonAsync` has not verified content types since .NET 5, and the whole thing works in a console app, a class library, Blazor WebAssembly, MAUI, and a Native AOT client.

This post covers why `Microsoft.AspNetCore.Mvc.ProblemDetails` is the wrong type to reach for on the client, the exact failure you get if you reach for it anyway, the model that round-trips a real ASP.NET Core problem response including `errors` and `traceId`, how to wire it into a typed `HttpClient` so a 4xx becomes a typed exception, and the handful of RFC 9457 rules that will bite you if you treat `status` as trustworthy.

A note on versions. .NET 11 and ASP.NET Core 11 are in preview as of September 2026 and reach general availability on 2026-11-10, per the [.NET 11 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md). Nothing in this area changes in .NET 11, and the API proposal that would fix it properly is targeted at .NET 12 (more on that at the end). Every output below was produced on this machine with the .NET SDK 10.0.302 and the 10.0.10 runtimes, against a minimal API using `AddProblemDetails()`.

## Why the client cannot just use the server's type

`ProblemDetails` is a plain data class with five nullable properties and a dictionary. It has no behaviour and no server dependencies. It still lives in `Microsoft.AspNetCore.Http.Abstractions.dll`, which ships only as part of the `Microsoft.AspNetCore.App` shared framework, so the only supported way to reach it is a framework reference:

```xml
<!-- Contracts.csproj, .NET 10 / .NET 11 -->
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

That compiles. It also propagates. Add that class library to an otherwise ordinary console app and look at what the SDK writes into `Cli.runtimeconfig.json`:

```json
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}
```

The console app now hard-requires the ASP.NET Core shared framework at startup. On a box that has it, everything looks fine, which is exactly why this ships. Run the same binary against a runtime-only .NET installation, which is what `mcr.microsoft.com/dotnet/runtime:10.0` gives you, and the host refuses before a single line of your code executes:

```
You must install or update .NET to run this application.

App: /app/Cli.dll
Architecture: arm64
Framework: 'Microsoft.AspNetCore.App', version '10.0.0' (arm64)

No frameworks were found.
```

I produced that by copying only `shared/Microsoft.NETCore.App` into a scratch `DOTNET_ROOT` and launching the app there. It is the identical message you get from the wrong base image, and the fix people usually apply is to switch to the `aspnet` image, which adds roughly 20 MB of server framework to a client that will never open a socket in listening mode. If you are sizing images, the tradeoffs are in [framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).

The other targets fail earlier and harder. `FrameworkReference` to `Microsoft.AspNetCore.App` is not available to a `netstandard2.0` library at all, and a Blazor WebAssembly or MAUI client has no business dragging Kestrel, MVC, and routing metadata into its trim graph to read five JSON strings. The `dotnet/aspnetcore` issue asking for the type to be relocated, [#58551 "Move ProblemDetails outside of Asp.Net Core"](https://github.com/dotnet/aspnetcore/issues/58551), has been sitting in the backlog unassigned since it was filed.

## The model, in four steps

1. **Declare the five RFC 9457 members as nullable properties.** Every member in [RFC 9457 Section 3.1](https://datatracker.ietf.org/doc/html/rfc9457#section-3.1) is optional. `status` is a JSON number, so it is `int?`; the other four are strings.
2. **Add an `[JsonExtensionData]` dictionary.** RFC 9457 Section 3.2 lets a problem type add members in the same flat namespace as the standard ones, and ASP.NET Core writes its `Extensions` dictionary exactly that way. Without this you silently drop `errors`, `traceId`, and every domain-specific field the API added.
3. **Deserialize with `ReadFromJsonAsync<T>` off the `HttpContent`,** not with `GetFromJsonAsync`. The `HttpClient`-level helpers call `EnsureSuccessStatusCode` for you, which is the opposite of what you want here.
4. **Guard on the media type yourself,** because nothing else will.

The type is short enough to paste into any client project:

```csharp
// .NET 10 / .NET 11, C# 14. Only needs System.Net.Http.Json + System.Text.Json.
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ProblemDetails
{
    public string? Type { get; set; }
    public string? Title { get; set; }
    public int? Status { get; set; }
    public string? Detail { get; set; }
    public string? Instance { get; set; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Extensions { get; set; }
}
```

No `[JsonPropertyName]` attributes are needed. `ReadFromJsonAsync` defaults to `JsonSerializerOptions.Web`, which sets `PropertyNamingPolicy` to camelCase and `PropertyNameCaseInsensitive` to `true`, so `title` binds to `Title` on its own. Against a real ASP.NET Core response the model captures everything:

```
type=https://example.com/probs/insufficient-funds
title=Insufficient funds
status=402
detail=Account 12345 has a balance of 4.20 EUR.
instance=/accounts/12345/withdraw
extensions: balance=4.20, accounts=["/account/12345","/account/67890"], traceId=00-5bf0...-00
```

That `traceId` is not something the endpoint set. ASP.NET Core's `DefaultProblemDetailsWriter` adds it from `Activity.Current?.Id`, falling back to `HttpContext.TraceIdentifier`, on every problem response written through `AddProblemDetails()`. It is the single most useful field in the payload when you are correlating a client-side failure with a server log, and it only survives if you kept the extension dictionary.

## Validation errors are an extension member, not a property

An ASP.NET Core validation failure looks like this on the wire:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The Sku field is required."],
    "Quantity": ["The field Quantity must be between 1 and 100."]
  },
  "traceId": "00-8246...-00"
}
```

`errors` is a top-level sibling of `title`, so it lands in `Extensions` with a `ValueKind` of `Object`. Reading it back is a small helper, and it needs to be defensive: RFC 9457 Section 3.1 says a member whose value type does not match the expected type MUST be ignored, and the RFC's own example in Section 3 uses an `errors` **array** of `{detail, pointer}` objects rather than ASP.NET Core's member-keyed map. If you call a non-.NET API, you will meet the other shape.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections.ObjectModel;

public IReadOnlyDictionary<string, string[]> GetValidationErrors()
{
    if (Extensions is null ||
        !Extensions.TryGetValue("errors", out var errors) ||
        errors.ValueKind is not JsonValueKind.Object)
    {
        return ReadOnlyDictionary<string, string[]>.Empty;
    }

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var member in errors.EnumerateObject())
    {
        if (member.Value.ValueKind is not JsonValueKind.Array) continue;
        result[member.Name] = member.Value.EnumerateArray()
            .Where(e => e.ValueKind is JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToArray();
    }
    return result;
}
```

Verified output against the payload above:

```
Sku: The Sku field is required.
Quantity: The field Quantity must be between 1 and 100.
```

Every branch that bails returns an empty dictionary rather than throwing, which is the behaviour Section 3.2 asks of consumers: ignore extensions you do not recognise. If you also own the server, the shape of what it emits is under your control through [IProblemDetailsService and minimal API validation responses](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## The content-type check that no longer exists

Half the answers on this topic warn that `ReadFromJsonAsync` throws `NotSupportedException: The provided ContentType is not supported` unless the response is `application/json`. That was true in the .NET Core 3.1 preview of `System.Net.Http.Json` and has been wrong since .NET 5: [dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594) removed the validation outright to resolve [#38713](https://github.com/dotnet/runtime/issues/38713), and there is no `ValidateContent` in the current source of `HttpContentJsonExtensions`.

Measured on 10.0.10, across a matrix of content types with the same problem+json body:

| Content-Type | Body | Result |
| --- | --- | --- |
| `application/problem+json` | problem JSON | parsed |
| `application/problem+json; charset=utf-8` | problem JSON | parsed |
| `text/html` | problem JSON | **parsed** |
| `text/plain` | problem JSON | parsed |
| (none) | problem JSON | parsed |
| `text/html` | `<html/>` | `JsonException: '<' is an invalid start of a value` |
| `application/problem+json` | empty | `JsonException: The input does not contain any JSON tokens` |
| `application/problem+json` | `null` | returns `null` |

Two things follow. First, you do not need a workaround to read `application/problem+json`, and you never did on .NET 5 or later. Second, the safety net you assumed was there is not: if a gateway returns a 502 HTML error page, `ReadFromJsonAsync` will happily try to parse it and hand you a `JsonException` rather than a clean "this is not a problem document" signal. That is why step 4 above says to check the media type yourself, and why the check belongs on `Content.Headers.ContentType?.MediaType` rather than on the raw header, which carries the `charset` parameter.

While you are here: `JsonSerializerOptions.Web` also sets `NumberHandling` to `AllowReadingFromString`, so a server that writes `"status": "402"` as a string still binds to `int?`. That one works in your favour.

## Turning a 4xx into a typed exception

The natural home for this is a `DelegatingHandler` on a typed client, so every call site gets the behaviour without a per-method `if`. The exception derives from `HttpRequestException` so existing `catch` blocks and retry policies keep working:

```csharp
// .NET 10 / .NET 11, C# 14
public sealed class ProblemDetailsException(ProblemDetails problem, HttpStatusCode status)
    : HttpRequestException(
        problem.Detail ?? problem.Title ?? "The server returned a problem response.",
        inner: null,
        statusCode: status)
{
    public ProblemDetails ProblemDetails { get; } = problem;
}

public sealed class ProblemDetailsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = await base.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
            return response;

        var json = await response.Content.ReadAsStringAsync(ct);
        var problem = JsonSerializer.Deserialize<ProblemDetails>(json, JsonSerializerOptions.Web);
        if (problem is null) return response;

        throw new ProblemDetailsException(problem, response.StatusCode);
    }
}
```

Registration is ordinary `IHttpClientFactory`:

```csharp
services.AddTransient<ProblemDetailsHandler>();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://api.example.com"))
        .AddHttpMessageHandler<ProblemDetailsHandler>();
```

And the call site gets the whole payload, on a 404 that used to be a bare status code:

```
ProblemDetailsException: No order with id abc.
  StatusCode=NotFound  type=https://api.example.com/probs/order-not-found
  orderId extension = abc
  is HttpRequestException: True
```

Note the `ReadAsStringAsync` in the handler rather than `ReadFromJsonAsync`. This is not stylistic. On 10.0.10, calling `ReadFromJsonAsync` on an `HttpContent` disposes the buffered stream, so a second call on the same response throws `ObjectDisposedException: Cannot access a closed Stream`. In a handler that sometimes returns the response instead of throwing, that means you have destroyed the body for the caller. `ReadAsStringAsync` is repeatable, and `ReadAsStringAsync` followed by `ReadFromJsonAsync` is fine too; only `ReadFromJsonAsync` twice fails. If you use `HttpCompletionOption.ResponseHeadersRead` anywhere in the chain, call `LoadIntoBufferAsync()` before peeking at all.

Testing the handler is the standard fake-`HttpMessageHandler` exercise covered in [how to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/). If you are still deciding how to shape the client itself, [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/) covers where a handler like this fits in each option.

## Four RFC rules that will bite you

**`status` is advisory.** Section 3.1.2 is explicit: "The 'status' member, if present, is only advisory". It is also optional. A server behind a proxy that rewrites the status leaves you with a body claiming 409 on an HTTP 502 response. Always branch on `response.StatusCode`, and treat `ProblemDetails.Status` as a diagnostic field you log, not one you switch on.

**Branch on `type`, not on `title` or status.** `type` is the stable identifier; `title` is explicitly allowed to be localised, and Section 3.1 says it "SHOULD NOT change from occurrence to occurrence" only for a given type. When `type` is absent, Section 3.1.1 says its value is assumed to be `about:blank`, which per Section 4.2.1 means "no information beyond the status code" and implies `title` is just the status phrase. Normalise a missing or empty `type` to `about:blank` before you compare it.

**`type` and `instance` are URI *references*, so they can be relative.** The RFC allows it and warns that "using relative URIs can cause confusion, and they might not be handled correctly by all implementations". If you compare `type` against a constant, resolve it first: `new Uri(response.RequestMessage!.RequestUri!, pd.Type ?? "about:blank")`.

**Do not dereference `type`, and do not show `detail` to end users.** Section 5 tells consumers they "SHOULD NOT automatically dereference the type URI" outside of developer tooling, and the whole point of `detail` is that it is occurrence-specific server text, which frequently leaks internals. Log it, correlate it by `traceId`, and render your own message.

Two smaller ones. Headers still matter: a 429 problem document does not carry the retry delay in the body, it carries it in `Retry-After`, so read the header. And a problem response is not guaranteed for every failure. In my matrix a 429 came back with no content type and a zero-length body, which is exactly the case the media-type guard in the handler above passes through untouched.

## Native AOT and trimming

The model works with the `System.Text.Json` source generator, `[JsonExtensionData]` included, provided the dictionary is one of `IDictionary<string, JsonElement>`, `IDictionary<string, object>`, `IDictionary<string, JsonNode>`, or `JsonNode`. Anything else is `SYSLIB1036` at build time.

```csharp
// .NET 10 / .NET 11, C# 14
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
public partial class ProblemJsonContext : JsonSerializerContext;

// ...
var problem = await response.Content.ReadFromJsonAsync(ProblemJsonContext.Default.ProblemDetails, ct);
```

Verified on 10.0.10: the source-generated path parses the same payload and preserves `4.20` as an exact decimal in the extension dictionary, because `JsonElement` keeps the raw text. Reading it with `GetDecimal()` gives you `4.20`, not a float artefact. That matters for money fields, and it is one more reason to keep extensions as `JsonElement` rather than `object`. If you need to reshape what the generator emits, [a type-info resolver modifier](/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/) is the hook.

## What .NET 12 may change

There is an open API proposal, [dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046), to put all of this in the BCL: a `ProblemDetails` model in `System.Net.Http.Json`, `HttpResponseMessage.IsProblemJson()`, `ReadProblemJsonAsync()`, `ThrowIfProblemJsonAsync()`, and a `ProblemDetailsException` deriving from `HttpRequestException`. The reasoning in the proposal is the same one this post opens with: referencing the server framework "pulls ASP.NET Core into console apps, MAUI apps, Blazor WASM clients, and class libraries that have no business depending on a server framework". It is labelled `api-suggestion` against the 12.0.0 milestone, which means it is not in .NET 11 and is not guaranteed for .NET 12 either.

Until it ships, the twenty lines above are the whole answer, and they are forward-compatible: the proposed BCL type has the same five properties and an extensions dictionary, so swapping to it later is a namespace change and a delete.

## Related

- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [HttpClient vs HttpClientFactory vs Refit: which should you use in .NET 11?](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [How to customize source-generated System.Text.Json serialization with a type-info resolver modifier](/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)

## Sources

- [RFC 9457, Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [API proposal: Problem Details (RFC 9457) support in System.Net.Http.Json, dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046)
- [Move ProblemDetails outside of Asp.Net Core, dotnet/aspnetcore#58551](https://github.com/dotnet/aspnetcore/issues/58551)
- [Remove content type verification from ReadFromJsonAsync, dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594)
- [ProblemDetails class reference on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.problemdetails)
- [DefaultProblemDetailsWriter source in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Extensions/src/DefaultProblemDetailsWriter.cs)
- [SYSLIB1036: JsonExtensionData type requirements](https://learn.microsoft.com/en-US/dotnet/fundamentals/syslib-diagnostics/syslib1036)
