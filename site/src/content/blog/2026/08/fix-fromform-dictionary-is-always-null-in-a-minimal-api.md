---
title: "Fix: [FromForm] Dictionary<string, string> is always null in a minimal API"
description: "A [FromForm] Dictionary in a minimal API binds with an empty prefix: the form keys must be [key], not metadata[key]. Wrap it in a class to keep readable names."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
---

A `[FromForm] Dictionary<string, string>` parameter in a minimal API does not use the parameter name as a form key prefix. The form mapper starts at the root of the form, so it looks for `[author]` and `[env]`, not `metadata[author]` or `metadata.author`. Send bracket keys with no prefix, or, better, wrap the dictionary in a class and post `Metadata[author]` so the wire format stays readable. Nothing is logged and no `400` is returned when the keys do not match: the parameter simply arrives as `null`.

Everything below was measured on ASP.NET Core 10.0.5 with SDK 10.0.201. The relevant binding code is identical on the `release/11.0` branch, so the behaviour carries into .NET 11.

## The error in context

There is no exception to search for, which is exactly why this one burns an afternoon. The handler runs, the file binds, and the dictionary is `null`:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/broken", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/broken \
  -F "metadata[author]=marius" -F "metadata[env]=prod" -F "file=@a.txt"
```

```text
metadata=null, file=a.txt
```

The same `null` comes back for `metadata.author=marius`, for a bare `author=marius`, and for a request that omits the keys entirely. The status code is `200` every time.

You only see an exception once the keys are close enough that the mapper starts reading them. With a `Dictionary<string, int>` and a value that does not parse:

```text
Microsoft.AspNetCore.Http.BadHttpRequestException: The value 'notanint' is not valid for 'b'.
 ---> Microsoft.AspNetCore.Components.Endpoints.FormMapping.FormDataMappingException
   at Microsoft.AspNetCore.Components.Endpoints.FormMapping.DictionaryConverter`5.TryRead(...)
```

That stack trace is the tell. The type doing the work lives in `Microsoft.AspNetCore.Components.Endpoints.FormMapping`, the same form-mapping layer Blazor uses, and its key conventions are not the ones MVC taught you.

## Why this happens

Minimal API form binding has two completely separate code paths, and which one a parameter takes is decided by a single predicate in `RequestDelegateFactory`:

```csharp
// dotnet/aspnetcore, src/Http/Http.Extensions/src/RequestDelegateFactory.cs, release/10.0
var useSimpleBinding = parameter.ParameterType == typeof(string) ||
    parameter.ParameterType == typeof(StringValues) ||
    parameter.ParameterType == typeof(StringValues?) ||
    ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType) ||
    (parameter.ParameterType.IsArray && ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType.GetElementType()!));
hasTryParse = useSimpleBinding;
return useSimpleBinding
    ? BindParameterFromFormItem(parameter, formAttribute.Name ?? parameter.Name, factoryContext)
    : BindComplexParameterFromFormItem(parameter, string.IsNullOrEmpty(formAttribute.Name) ? parameter.Name : formAttribute.Name, factoryContext);
```

Simple binding reads `HttpContext.Request.Form[key]` where `key` is the parameter name. That is the behaviour everyone expects, and it is what you get for `string`, `int`, `Guid`, `DateOnly`, and anything else with a `TryParse`.

`Dictionary<string, string>` has no `TryParse`, so it falls into `BindComplexParameterFromFormItem`, which hands the whole form to the shared form mapper:

```csharp
// FormDataMapper.Map<Dictionary<string, string>>(name_reader, FormDataMapperOptions);
var invokeMapMethodExpr = Expression.Call(
    FormDataMapperMapMethod.MakeGenericMethod(parameter.ParameterType),
    formReader,
    Expression.Constant(formDataMapperOptions));
```

Look at the arguments: the reader and the options. There is no prefix. The `key` computed on the line above is only used as a dictionary key in `factoryContext.TrackedParameters`, never pushed onto the reader's prefix stack. The mapper therefore reads the dictionary from the root of the form, and a root-level dictionary entry is spelled `[author]`.

That is the entire bug: the parameter is named `metadata`, but the form mapper was never told the name.

This is also why the behaviour feels like a regression when you move an endpoint off controllers. MVC's model binder tries the parameter name as a prefix and then falls back to the empty prefix, so a controller action accepts both spellings:

```csharp
// .NET 10.0.201, controller action, both curl shapes below return the same result
[HttpPost("dict")]
public IActionResult Dict([FromForm] Dictionary<string, string> metadata, IFormFile file)
    => Content($"count={metadata?.Count}");
```

```text
curl -F "metadata[author]=marius" -F "file=@a.txt"   ->  count=1
curl -F "[author]=marius"         -F "file=@a.txt"   ->  count=1
```

Minimal APIs accept only the second. If you are weighing the two hosting models more broadly, [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) covers the other places their binding semantics diverge.

## Minimal repro

A complete app, plus the request shapes that do and do not work:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();
app.UseAntiforgery();

app.MapPost("/dict", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();

app.MapPost("/list", ([FromForm] List<string> tags, IFormFile file) =>
    Results.Text($"tags={(tags is null ? "null" : JsonSerializer.Serialize(tags))}"))
   .DisableAntiforgery();

app.Run();
```

Measured results against that app:

| Request | Result |
| --- | --- |
| `-F "metadata[author]=marius"` | `metadata=null` |
| `-F "metadata.author=marius"` | `metadata=null` |
| `-F "author=marius"` | `metadata=null` |
| `-F "[author]=marius" -F "[env]=prod"` | `metadata={"author":"marius","env":"prod"}` |
| `-F "tags=a" -F "tags=b"` | `tags=null` |
| `-F "tags[0]=a" -F "tags[1]=b"` | `tags=null` |
| `-F "[0]=a" -F "[1]=b"` | `tags=["a","b"]` |

The pattern is consistent: a top-level `[FromForm]` collection parameter is addressed with an empty prefix, so dictionaries use `[key]` and lists use `[0]`, `[1]`, and so on. The parameter name is dead weight.

## Fix, in detail

Four options, in the order I would reach for them.

### 1. Wrap the dictionary in a class

This is the fix worth shipping. A property on a class does get a prefix, because the mapper pushes the property name onto its prefix stack as it descends, so the wire format goes back to something a human can read and a client library can generate.

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadRequest request, IFormFile file) =>
    Results.Text($"request={JsonSerializer.Serialize(request)}, file={file?.FileName}"))
   .DisableAntiforgery();

public class UploadRequest
{
    public Dictionary<string, string> Metadata { get; set; } = new();
}
```

```bash
curl -X POST http://localhost:5222/upload \
  -F "Metadata[author]=marius" -F "Metadata[env]=prod" -F "file=@a.txt"
```

```text
request={"Metadata":{"author":"marius","env":"prod"}}, file=a.txt
```

Key matching is case-insensitive, so `metadata[author]` binds to the `Metadata` property too. The nested dictionary can also sit deeper: `Meta.Tags[a]=1` binds fine if `Meta` is itself a property.

You can pull the file into the same class, which keeps the endpoint signature to a single parameter:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadWithFile request) =>
    Results.Text($"metadata={JsonSerializer.Serialize(request.Metadata)}, file={request.File?.FileName}"))
   .DisableAntiforgery();

public class UploadWithFile
{
    public Dictionary<string, string> Metadata { get; set; } = new();
    public IFormFile? File { get; set; }
}
```

Posting `-F "Metadata[author]=marius" -F "File=@a.txt"` binds both. The file property is matched by property name, the same rule that applies to a top-level `IFormFile` parameter.

### 2. Keep the dictionary parameter and fix the client

If the client is yours and the endpoint signature is fixed, just send root-level bracket keys:

```bash
curl -X POST http://localhost:5222/dict \
  -F "[author]=marius" -F "[env]=prod" -F "file=@a.txt"
```

It works, and it is one character of change per key. It is also the shape nobody will guess when they read the handler six months from now, and it does not survive a second dictionary parameter (see the gotchas). Treat it as a stopgap.

### 3. Read the form yourself

The most explicit option, and the only one that survives the Request Delegate Generator. `IFormCollection` is bound as a whole-form parameter with no mapping layer involved, so you own the key convention:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", (IFormCollection form) =>
{
    var metadata = form
        .Where(kv => kv.Key.StartsWith("metadata[", StringComparison.Ordinal) && kv.Key.EndsWith(']'))
        .ToDictionary(kv => kv.Key[9..^1], kv => kv.Value.ToString());

    return Results.Text($"metadata={JsonSerializer.Serialize(metadata)}, files={form.Files.Count}");
}).DisableAntiforgery();
```

```text
metadata={"author":"marius","env":"prod"}, files=1
```

Verbose, but it accepts `metadata[author]` directly and gives you a real error path when a key is malformed instead of a silent `null`.

### 4. Send the metadata as one JSON field

If the metadata is genuinely open-ended, stop modelling it as form keys. One form field holding a JSON document binds through the simple path, because `string` short-circuits the predicate above:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] string metadata, IFormFile file) =>
{
    var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata);
    return Results.Text($"metadata={JsonSerializer.Serialize(parsed)}, file={file?.FileName}");
}).DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/upload \
  -F 'metadata={"author":"marius","env":"prod"}' -F "file=@a.txt"
```

This is the only option that gives you nested values, arrays, and non-string types without fighting the key syntax, and it works identically under AOT.

## Gotchas and variants

- **`null` is not a validation failure.** The parameter type is non-nullable `Dictionary<string, string>` and the handler still receives `null`, with a `200` response and nothing in the logs. The mapper returns `default(T)` when it finds no matching key, and a form-bound complex parameter is never treated as required. Null-check it, or make the parameter nullable so the compiler reminds you. A property initializer like `= new()` does not save you either: the wrapper object itself comes back `null` when no key matches its prefix.

- **`[FromForm(Name = "metadata")]` does not set the prefix.** It reads like the fix and it is not. The name is used to look up tracked parameters, then thrown away before the mapper runs. `[FromForm(Name = "metadata")] Dictionary<string, string> metadata` still binds from `[author]`, not `metadata[author]`.

- **Two complex form parameters collide.** Because both bind with an empty prefix, they read the same keys. An endpoint taking `[FromForm] Dictionary<string, string> first, [FromForm] Dictionary<string, string> second` and receiving `[a]=1&[b]=2` returns `first={"a":"1","b":"2"} second={"a":"1","b":"2"}`. There is no warning. This alone is a reason to prefer the wrapper class.

- **Arrays and lists behave differently from each other.** `List<string> tags` is a complex type and needs `[0]`, `[1]`. `int[] ids` has a `TryParse`-able element type, so it takes the simple path and binds from repeated `ids=1&ids=2`. And `[FromForm] string[] tags` throws at startup on .NET 10 with `InvalidOperationException: TryParse method found on string with incorrect format`, because `string` now exposes a span-based `TryParse` that the binding-method cache rejects instead of ignoring. That is [dotnet/aspnetcore#62326](https://github.com/dotnet/aspnetcore/issues/62326), fixed by [PR #63072](https://github.com/dotnet/aspnetcore/pull/63072); the merge commit is an ancestor of every `v11.0.0-preview` tag and of neither `v10.0.0` nor `v10.0.5`, so the crash stays with you for the whole .NET 10 lifetime.

- **Two different limits both default to 1024.** Post 1025 keys and you get `InvalidDataException: Form value count limit 1024 exceeded` from `FormPipeReader`, which is `FormOptions.ValueCountLimit`. Raise it with `services.Configure<FormOptions>(o => o.ValueCountLimit = 5000)` and you hit the next wall: `The number of elements in the dictionary exceeded the maximum number of '1024' elements allowed`, which is the mapper's own cap. That one is per-endpoint: `.WithFormMappingOptions(maxCollectionSize: 5000)`. You need both, and raising only one looks like the fix did nothing. If your uploads are large in bytes rather than in key count, [413 Request Entity Too Large when uploading a file](/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) covers the size-based limits instead.

- **Form binding demands antiforgery wiring.** Any minimal API endpoint with a form-bound parameter carries antiforgery metadata. If the app never calls `app.UseAntiforgery()`, the request fails with `InvalidOperationException: Endpoint HTTP: POST /upload contains anti-forgery metadata, but a middleware was not found that supports anti-forgery` and a `500`. Add the middleware, or call `.DisableAntiforgery()` on machine-to-machine endpoints. Do not blanket-disable it for endpoints a browser posts to.

- **The Request Delegate Generator refuses all of this.** Build with `EnableRequestDelegateGenerator` set to `true`, or with `PublishAot`, and both the dictionary parameter and the wrapper class produce `warning RDG003: Unable to statically resolve parameter named 'metadata' for endpoint`. The endpoint falls back to runtime generation, which is exactly what AOT cannot do. `IFormCollection` produces no warning, so option 3 is the AOT-safe shape. See [how to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for the rest of the RDG diagnostics.

- **A wrong `Content-Type` looks like the same bug.** If the request arrives as `application/json` instead of `multipart/form-data` or `application/x-www-form-urlencoded`, you get a `415` rather than a silent `null`. That is a different failure with a different fix, covered in [415 Unsupported Media Type from a minimal API endpoint](/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/).

The rule to remember is short: in a minimal API, a `[FromForm]` parameter is addressed by name only if its type can be parsed from a single string. Everything else goes through the Blazor form mapper, which starts at the root of the form and does not know what your parameter is called. Give it a class to descend into and the names come back.

## Related

- [Fix: "415 Unsupported Media Type" from a minimal API endpoint in ASP.NET Core 11](/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) for when the form never reaches the binder at all.
- [Fix: "413 Request Entity Too Large" when uploading a file to an ASP.NET Core endpoint](/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) for the byte-size limits that sit in front of form parsing.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for what the Request Delegate Generator can and cannot bind.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for the wider set of binding differences between the two models.
- [How to upload a large file with streaming to Azure Blob Storage](/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) for getting off `IFormFile` buffering once the uploads grow.

## Sources

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-10.0) (form binding to collections and complex types, the `IFormFile` collection table, and the note that complex and collection form binding is not supported under the Request Delegate Generator).
- dotnet/aspnetcore, [RequestDelegateFactory.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (the `useSimpleBinding` predicate and `BindComplexParameterFromFormItem`, which calls `FormDataMapper.Map<T>` with no prefix).
- dotnet/aspnetcore issue [#62326](https://github.com/dotnet/aspnetcore/issues/62326) and PR [#63072](https://github.com/dotnet/aspnetcore/pull/63072) (`[FromForm] string[]` throwing at startup, and the simple-binding fix that shipped in .NET 11).
- Microsoft Learn, [RDG003: Unable to statically resolve parameter](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG003) (the compile-time diagnostic for form-mapped parameters under AOT).
