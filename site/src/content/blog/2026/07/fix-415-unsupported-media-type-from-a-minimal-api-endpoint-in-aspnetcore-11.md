---
title: "Fix: \"415 Unsupported Media Type\" from a minimal API endpoint in ASP.NET Core 11"
description: "A minimal API returns 415 when the request Content-Type does not match what the endpoint binds. Send Content-Type: application/json for a body-bound type, or use [FromForm] for form and file uploads."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
---

A minimal API endpoint returns `415 Unsupported Media Type` when the request body's `Content-Type` header does not match what the route handler is trying to bind. The most common cause: a handler parameter is a complex type bound from the body, which requires `Content-Type: application/json`, and the client sent no content type, sent `text/plain`, or sent form data. Fix it by sending `Content-Type: application/json` for a JSON body, or annotate the parameter with `[FromForm]` when the client posts `application/x-www-form-urlencoded` or `multipart/form-data`. This is verified against ASP.NET Core 11 on .NET 11 with C# 14; the behaviour is identical on .NET 8 through .NET 10.

## The error in context

Unlike most exceptions, this one never reaches your code. The minimal API binding layer rejects the request before your handler runs and writes a bare `415` back to the client. There is no stack trace, no `ProblemDetails` body by default, just the status line:

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
Date: Mon, 06 Jul 2026 09:12:44 GMT

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.16",
  "title": "Unsupported Media Type",
  "status": 415
}
```

If you have not wired up `AddProblemDetails()`, you get an empty body with just the `415` status. Either way, the absence of a stack trace is the tell: this is a framework-level content negotiation failure, not something thrown inside your handler. The Microsoft Learn parameter-binding reference documents it plainly in its binding-failure table: "Wrong content type (not `application/json`), body, 415."

## Why this happens

A minimal API route handler binds each parameter from a source: the route, the query string, a header, a service from DI, or the request body. When a parameter is a complex type with no `[From*]` attribute, minimal APIs infer that it comes from the request body, and the only body reader wired in by default is the `System.Text.Json` reader. That reader is registered for exactly one media type: `application/json`.

So the framework does a content-type check before it ever calls `JsonSerializer`. If the incoming `Content-Type` is not `application/json` (or a compatible `+json` suffix type), the body reader declines the request, and minimal APIs short-circuit with `415`. It does not attempt to guess. A missing `Content-Type`, `text/plain`, `application/x-www-form-urlencoded`, or `multipart/form-data` all fail the same way when the target parameter expects a JSON body.

This is a different failure from a `400 Bad Request`. A `400` means the content type was right but the JSON payload was malformed or violated validation. A `415` means the framework never even tried to read the body because the content type was wrong. Keeping those two straight saves you from debugging your JSON when the real problem is a header. The three usual triggers:

- The client sends a JSON body but forgets the `Content-Type: application/json` header (or a proxy strips it).
- The client posts form data (`application/x-www-form-urlencoded` or `multipart/form-data`) to a handler whose parameter is bound from the JSON body.
- The client sends a vendor or charset-decorated content type that the JSON reader is not registered to accept.

## Minimal repro

Here is the smallest endpoint that produces the error. `CreateProduct` is a complex type with no binding attribute, so minimal APIs bind it from the JSON body:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();   // so the 415 comes back as problem+json
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);
```

Now post a body without the content type header. Every one of these returns `415`:

```bash
# .NET 11 -- no Content-Type header at all
curl -i -X POST http://localhost:5000/products \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- wrong Content-Type (curl defaults -d to x-www-form-urlencoded)
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'sku=A-100&name=Widget&quantity=5'

# .NET 11 -- text/plain, even though the payload is valid JSON
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: text/plain" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

The payload in the first and third calls is perfectly valid JSON. It does not matter. The reader is gated on the header, not the bytes.

## Fix, in detail

Work through these in order. The first one resolves the large majority of cases.

### 1. Send `Content-Type: application/json` for a body-bound type

If your handler binds a complex type from the body, the client must declare a JSON content type. With `curl`, the trap is that `-d` (or `--data`) silently sets `application/x-www-form-urlencoded`. Use `--json`, or set the header explicitly:

```bash
# .NET 11 -- curl 7.82+ has a --json shortcut that sets the header for you
curl -i -X POST http://localhost:5000/products \
  --json '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- or set it by hand
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

From a typed `HttpClient`, use `PostAsJsonAsync`, which sets the header and serializes in one call. This is the single most common way to accidentally-fix or accidentally-break the header:

```csharp
// .NET 11, C# 14 -- sets Content-Type: application/json automatically
using System.Net.Http.Json;

var http = new HttpClient { BaseAddress = new Uri("http://localhost:5000") };
var response = await http.PostAsJsonAsync(
    "/products",
    new { sku = "A-100", name = "Widget", quantity = 5 });

response.EnsureSuccessStatusCode();   // 201 Created, no 415
```

If you hand-build the `HttpContent`, use `JsonContent.Create(...)` or a `StringContent` with the media type set. A `new StringContent(json)` with no media type defaults to `text/plain` and gives you a `415`:

```csharp
// .NET 11, C# 14
// WRONG -- StringContent defaults to text/plain -> 415
var bad = new StringContent(json);

// RIGHT -- declare the media type
var good = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
```

In JavaScript `fetch`, set the header explicitly; `fetch` does not add it for you when the body is a string:

```javascript
// browser fetch -- must set Content-Type or you get 415
await fetch("/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "A-100", name: "Widget", quantity: 5 }),
});
```

### 2. Use `[FromForm]` for form posts and file uploads

If the client genuinely sends form data (an HTML `<form>` submit, or a file upload), do not force it into JSON. Tell the handler to bind from the form instead of the body by annotating each parameter with `[FromForm]`. This switches the endpoint's expected content type to `application/x-www-form-urlencoded` and `multipart/form-data`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products",
    ([FromForm] string sku, [FromForm] string name, [FromForm] int quantity) =>
        TypedResults.Created($"/products/{sku}", new { sku, name, quantity }));
```

For file uploads, an `IFormFile` parameter requires `multipart/form-data`. Per the minimal API docs, minimal APIs do not bind the entire request body directly to an `IFormFile`; the field must come through form encoding, and the parameter name must match the form field name:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload",
    async ([FromForm] string title, IFormFile file, HttpContext ctx) =>
    {
        await using var stream = File.Create(Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return TypedResults.Ok(new { title, file.FileName, file.Length });
    })
    .DisableAntiforgery();   // see the gotcha below before you copy this line
```

Post it as multipart and the `415` is gone:

```bash
# .NET 11 -- multipart, matches the [FromForm] + IFormFile handler
curl -i -X POST http://localhost:5000/upload \
  -F "title=Spec sheet" \
  -F "file=@./spec.pdf"
```

### 3. Strip the charset or vendor suffix the JSON reader rejects

A content type like `application/json; charset=utf-8` is accepted, but a bare vendor type such as `application/vnd.myapp+json` may not be, depending on how the reader's media types are configured. If you control a client that sends a custom `+json` media type and you cannot change it, register that media type so the JSON body reader recognizes it. In minimal APIs you do this by configuring the endpoint's accepted request content types with `Accepts`, which also feeds your OpenAPI document:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .Accepts<CreateProduct>("application/json", "application/vnd.myapp+json");
```

### 4. Read a non-JSON body yourself with HttpRequest

When the payload is not JSON at all (raw bytes, CSV, a custom text format), stop binding a complex type and read the stream directly. Bind `HttpRequest` (or `Stream`, or `PipeReader`), which minimal APIs supply without any content-type check, and parse the body on your own terms:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- accepts any content type
app.MapPost("/import", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var raw = await reader.ReadToEndAsync();
    // parse `raw` (CSV, custom format, whatever) here
    return TypedResults.Ok(new { bytes = raw.Length });
});
```

Because you never asked the framework to deserialize the body into a typed parameter, there is no content-type gate, and the `415` cannot occur on this endpoint.

## Gotchas and variants

A handful of lookalikes send people to this page by mistake, and a few sharp edges bite even after the fix:

- **`415` is not `406`.** `415 Unsupported Media Type` is about the request body's `Content-Type`. `406 Not Acceptable` is about the client's `Accept` header for the response. If you are getting `406`, you are on the wrong page: the server cannot produce a representation the client will accept, which is a formatter problem on the way out, not the way in.

- **`415` is not `400`.** If the content type is right but the JSON is malformed or fails validation, you get a `400`, not a `415`. For that path, see [how to validate request bodies in minimal APIs without controllers](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), and if you need to reshape the `400` payload, [customize minimal API validation error responses with IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/). A specific malformed-JSON variant, a date string the serializer cannot parse, is covered in [the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

- **`[FromForm]` endpoints require an antiforgery token by default.** Since .NET 8, form-bound minimal API parameters trigger antiforgery validation. A programmatic client (curl, `HttpClient`) that posts a form without a valid token gets rejected, which reads like a content-type problem but is not. Either send the antiforgery token, or call `.DisableAntiforgery()` on endpoints that are not browser-driven, as in the upload example above. Do not blanket-disable it on endpoints a browser posts to.

- **A missing `Content-Type` behaves like the wrong one.** Some HTTP clients omit the header entirely for a `POST` with a body. From the framework's perspective an absent content type is not `application/json`, so it fails the same `415` check. Always set the header explicitly rather than relying on a client default.

- **Reverse proxies and API gateways can rewrite or drop the header.** If the same request works against Kestrel directly but returns `415` behind nginx, YARP, or an API gateway, inspect what `Content-Type` actually arrives at the app. Log `HttpContext.Request.ContentType` at the top of the pipeline to see the real value rather than the one you think you sent.

- **`[ApiController]` inference is a controllers concept, not a minimal API one.** If you migrated from controllers, remember minimal APIs infer body binding for complex types the same way, but there is no `[Consumes]` attribute filtering media types unless you add `Accepts`. The binding source, not an attribute, is what gates the content type.

The mental model to keep: a minimal API `415` is a mismatch between the `Content-Type` the client sent and the body reader the endpoint expects. Decide what the endpoint should accept, JSON body, form, file, or raw stream, then make the client's header and the handler's binding agree. When they agree, the `415` disappears and you are back to normal `400`/`200` territory.

## Related

- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) for the `400` path once the content type is correct.
- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) for shaping the error body the client sees.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for applying `Accepts` and filters across a group of endpoints.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for how content-type handling differs between the two models.
- [How to set up JWT bearer authentication in a minimal API in ASP.NET Core 11](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) for the auth layer that sits in front of these endpoints.

## Sources

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-9.0) (binding-failure table: wrong content type on a body parameter returns 415; `[FromForm]`, `IFormFile`, and `multipart/form-data` requirements; antiforgery on form binding).
- Microsoft Learn, [Minimal APIs quick reference](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-9.0) (`Accepts` metadata, body vs form binding sources).
- MDN, [415 Unsupported Media Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415) (the HTTP semantics: server refuses the request payload's media type).
