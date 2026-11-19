---
title: "What are the stray hex numbers around the JSON in an ASP.NET Core response, and how do I return Content-Length instead?"
description: "The 2e before your JSON and the 0 after it are HTTP/1.1 chunked transfer encoding, not part of the body. Raw Kestrel bytes for every common MVC and minimal API return style on ASP.NET Core 10.0.10 and 11.0.0, which ones send Content-Length, how to force it, and why a hand-set header comes out wrong."
pubDate: 2026-11-19
tags:
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "kestrel"
  - "http"
---

The `2e` before your JSON and the `0` after it are not part of the body. They are the framing of HTTP/1.1 chunked transfer encoding: `2e` is the length of the next chunk in hex (46 bytes, the exact size of your JSON), and `0` followed by an empty line marks the end of the body. Kestrel uses chunked encoding whenever the response body is written without a `Content-Length` header, which is what happens for every object serialized as JSON by MVC (`Ok(obj)`, returning a POCO) and by minimal APIs (`return obj`, `TypedResults.Ok(obj)`, `Results.Json`). Any real HTTP client strips the framing, so the hex only shows up in raw tools like Fiddler's Raw tab or `curl --raw`. If a client genuinely needs `Content-Length` (embedded devices, picky proxies), return a result that knows its length up front: `Content(...)` / `Results.Text(...)` for a pre-serialized string, or `Results.Bytes(...)` / `File(...)` for UTF-8 bytes. Everything below was captured byte-for-byte from Kestrel on ASP.NET Core 11.0.0 (SDK 11.0.100) and re-run on ASP.NET Core 10.0.10, macOS arm64; both versions produced identical bytes.

## Where the 2e and the 0 come from

This exact confusion is behind [a Stack Overflow question from a team porting a Web API 2 app to ASP.NET Core 10](https://stackoverflow.com/questions/79890922). Fiddler showed this:

```http
HTTP/1.1 404 Not Found
Content-Type: application/vnd.com.org.error+json; charset=utf-8
Server: Kestrel
Transfer-Encoding: chunked

2e
{ "Message": "Could not find specified request" }
0
```

[RFC 9112, section 7.1](https://www.rfc-editor.org/rfc/rfc9112#section-7.1) defines the format. A chunked body is a sequence of chunks, each one a hex size line, CRLF, that many bytes of data, CRLF. A chunk of size `0` ends the body, optionally followed by trailer fields and a final CRLF. On the wire the response above is:

```text
2e\r\n{"message":"Could not find specified request"}\r\n0\r\n\r\n
```

Count the JSON: 46 characters, `0x2e`. The size line changes with every payload, which is why the question noticed the numbers are "not always 2e".

The server needs some way to tell the client where the body ends. HTTP/1.1 gives it three options:

1. Send `Content-Length` before the body. Requires knowing the byte count before the first body byte goes out.
2. Send `Transfer-Encoding: chunked` and frame the body. Works when the length is unknown.
3. Close the connection when done. Only allowed for HTTP/1.0 style responses, and it kills keep-alive.

ASP.NET Core's JSON writers stream. `HttpResponse.WriteAsJsonAsync` serializes straight into the response pipe instead of building a `byte[]` first, so the length is not known when the headers are committed. Kestrel sees a body being written with no `Content-Length` and picks option 2. That is deliberate: it avoids buffering every response in memory and lets the first bytes leave before serialization finishes.

## Seeing the raw bytes yourself

`curl` decodes chunks by default; `--raw` turns that off. Against an MVC action that returns `Ok(new Status("Could not find specified request"))`:

```bash
# ASP.NET Core 11.0.0, Kestrel, HTTP/1.1
curl -s --raw -i http://127.0.0.1:5099/mvc/ok
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Date: Thu, 19 Nov 2026 07:04:58 GMT
Server: Kestrel
Transfer-Encoding: chunked

2e
{"message":"Could not find specified request"}
0
```

Without `--raw`, the same request prints only the JSON. `HttpClient`, browsers, Postman, Python `requests` and every other HTTP/1.1 client do the same. In Fiddler the Raw inspector shows the transport bytes, and the yellow "Response body is encoded. Click to decode." bar removes the framing. So if the hex digits appear in your *parsed* data, the bug is on the client side: something is reading the socket by hand and treating it as HTTP/1.0.

To get exact bytes, including the CRLFs, a 20-line Python socket client is enough. This is the probe used for the table in the next section:

```python
# raw.py - prints status line, headers (minus Date/Server) and the body bytes as received
import socket, sys

def get(path, ver="1.1", extra=""):
    s = socket.create_connection(("127.0.0.1", 5099))
    s.sendall(f"GET {path} HTTP/{ver}\r\nHost: localhost\r\nConnection: close\r\n{extra}\r\n".encode())
    data = b""
    while chunk := s.recv(65536):
        data += chunk
    return data

for p in sys.argv[1:]:
    ver = "1.1"
    if p.startswith("1.0:"):
        ver, p = "1.0", p[4:]
    extra = "Accept-Encoding: gzip\r\n" if p.startswith("/gz") else ""
    head, _, body = get(p, ver, extra).partition(b"\r\n\r\n")
    lines = [h for h in head.decode().split("\r\n") if not h.startswith(("Date", "Server"))]
    print("=== GET", p, "HTTP/" + ver, *lines, repr(body), "", sep="\n")
```

## Which return styles send Content-Length and which go chunked

The test app maps one endpoint per return style, MVC and minimal API side by side. The relevant parts:

```csharp
// .NET 11 (also built and run as net10.0 on ASP.NET Core 10.0.10), C# 14
var status = new Status("Could not find specified request");

app.MapGet("/min/object",   () => status);
app.MapGet("/min/typed-ok", () => TypedResults.Ok(status));
app.MapGet("/min/json",     () => Results.Json(status));
app.MapGet("/min/string",   () => "{\"message\":\"hello\"}");
app.MapGet("/min/text",     () => Results.Text("{\"message\":\"hello\"}", "application/json"));
app.MapGet("/min/content",  () => Results.Content("{\"message\":\"hello\"}", "application/json"));
app.MapGet("/min/bytes",    () => Results.Bytes(JsonSerializer.SerializeToUtf8Bytes(status), "application/json"));
app.MapGet("/min/write-json", async (HttpContext ctx) => await ctx.Response.WriteAsJsonAsync(status));

public record Status(string Message);

[ApiController, Route("mvc")]
public class MvcController : ControllerBase
{
    static readonly Status S = new("Could not find specified request");
    [HttpGet("ok")]       public IActionResult OkObj() => Ok(S);
    [HttpGet("notfound")] public IActionResult Nf()    => NotFound(S);
    [HttpGet("poco")]     public Status Poco()         => S;
    [HttpGet("content")]  public IActionResult Cont()  => Content("{\"message\":\"hello\"}", "application/json");
    [HttpGet("iresult")]  public IResult IRes()        => Results.Text("{\"message\":\"hello\"}", "application/json");
    [HttpGet("string")]   public string Str()          => "{\"message\":\"hello\"}";
    [HttpGet("file")]     public IActionResult Fil()   => File(JsonSerializer.SerializeToUtf8Bytes(S), "application/json");
}
```

Results over HTTP/1.1, identical on 10.0.10 and 11.0.0:

| Endpoint | Framing | Body on the wire |
| --- | --- | --- |
| MVC `Ok(obj)`, `NotFound(obj)`, returning a POCO | `Transfer-Encoding: chunked` | `2e\r\n{...}\r\n0\r\n\r\n` |
| MVC returning `string` | chunked (`text/plain`) | `13\r\n{...}\r\n0\r\n\r\n` |
| MVC `Content(str, "application/json")` | `Content-Length: 19` | raw JSON |
| MVC returning `Results.Text(...)` as `IResult` | `Content-Length: 19` | raw JSON |
| MVC `File(byte[], ...)` | `Content-Length: 46` | raw JSON |
| Minimal API `return obj`, `TypedResults.Ok`, `Results.Json` | chunked | `2e\r\n{...}\r\n0\r\n\r\n` |
| Minimal API returning `string` | chunked (`text/plain`) | `13\r\n{...}\r\n0\r\n\r\n` |
| Minimal API `Results.Text` / `Results.Content` | `Content-Length: 19` | raw JSON |
| Minimal API `Results.Bytes` | `Content-Length: 46` | raw JSON |
| `Response.WriteAsJsonAsync(obj)` | chunked | framed |
| `Response.WriteAsync(str)` without setting a length | chunked | framed |

The rule falls out of the source. [`ContentResultExecutor`](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Core/src/Infrastructure/ContentResultExecutor.cs) sets `response.ContentLength = encoding.GetByteCount(result.Content)` before writing, and the minimal API helper behind `Results.Text` / `Results.Content` ([`HttpResultsHelper.WriteResultAsContentAsync`](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Results/src/HttpResultsHelper.cs)) does the same. File and byte results know their length from the array. Every JSON object path goes through a streaming serializer and never sets a length. A plain `string` return also goes chunked, because it is written with `WriteAsync` and no length, which surprises people who assume "it's already a string, the framework knows its size".

Two other variables change the framing regardless of how you return:

- **HTTP/2 and HTTP/3 have no chunked encoding.** The body is carried in DATA frames and the end of stream is a flag. Over h2c prior knowledge (`curl --http2-prior-knowledge`) the same `/mvc/ok` returns no `transfer-encoding` and no `content-length`, while `/min/text` returns `content-length: 19`. If the "hex numbers" appear behind a proxy that talks HTTP/2 to the client, they are an artifact of the HTTP/1.1 hop.
- **An HTTP/1.0 request never gets chunked.** Sending `GET /min/object HTTP/1.0` gives the bare JSON with no `Content-Length`; Kestrel signals the end by closing the connection. That is the fallback an embedded client written against HTTP/1.0 actually receives.

## Forcing Content-Length for clients that need it

The [second Stack Overflow question](https://stackoverflow.com/questions/79914630) is the real-world reason to care: the clients are embedded C devices that read `Content-Length` and cannot parse a chunked body. Options, from least to most invasive.

### Serialize first, return text or bytes

When the payload is small, materialize it and hand ASP.NET Core a result that sets the length:

```csharp
// .NET 10 / 11, minimal API
app.MapPost("/device/status", (DeviceReport report) =>
{
    var json = JsonSerializer.SerializeToUtf8Bytes(new { status = "OK" }, JsonSerializerOptions.Web);
    return Results.Bytes(json, "application/json");          // Content-Length: 15
});

// .NET 6+, MVC controller
[HttpPost]
public IActionResult Post()
{
    var json = JsonSerializer.Serialize(new { status = "OK" }, JsonSerializerOptions.Web);
    return Content(json, "application/json");                // Content-Length set by ContentResultExecutor
}
```

`Results.Bytes` / `File(byte[])` avoids the extra `GetByteCount` pass that `Content` makes over the string. Note that `JsonSerializerOptions.Web` gives camelCase; the `Results.Bytes` probe above used the default options, which is why its body shows `"Message"` instead of `"message"`. Pick one options instance and use it everywhere.

### Set the length yourself, from bytes, not characters

Writing directly to the response works too, as long as the number is the byte count of what you actually write:

```csharp
// .NET 10 / 11
app.MapGet("/min/manual-length", async (HttpContext ctx) =>
{
    byte[] json = JsonSerializer.SerializeToUtf8Bytes(status);
    ctx.Response.ContentType = "application/json";
    ctx.Response.ContentLength = json.Length;   // set before the first write
    await ctx.Response.Body.WriteAsync(json);
});
```

That endpoint returns `Content-Length: 46` and the bare JSON.

### Buffer the whole response in middleware

If you have many MVC actions returning `Ok(obj)` and cannot touch each one, buffer the body, then set the length and copy:

```csharp
// .NET 10 / 11. Scope it: buffering every response defeats streaming.
app.UseWhen(c => c.Request.Path.StartsWithSegments("/device"), b => b.Use(async (ctx, next) =>
{
    var original = ctx.Response.Body;
    using var buffer = new MemoryStream();
    ctx.Response.Body = buffer;
    try { await next(ctx); }
    finally { ctx.Response.Body = original; }

    ctx.Response.ContentLength = buffer.Length;
    buffer.Position = 0;
    await buffer.CopyToAsync(original, ctx.RequestAborted);
}));
```

A POCO returned through this middleware came back with `Content-Length: 46` and no chunk framing. The cost is one `MemoryStream` per request holding the full body and a later time to first byte. Do not put it in front of file downloads, `IAsyncEnumerable<T>` endpoints or server-sent events; for those, [streaming without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) is the point. ASP.NET Core does not ship a response buffering middleware, so a small hand-written one like this is the usual answer.

Kestrel has no option that turns chunking off. Chunking is simply what it does when no length was declared, so the fix is always to declare the length, never to fight the header.

## Why a hand-set Content-Length comes out wrong

The 79914630 question also reported that setting `Content-Length` by hand "is always wrong". There are three distinct ways that happens.

### 1. Counting characters instead of bytes

`string.Length` counts UTF-16 code units. The wire carries UTF-8. Any non-ASCII character breaks the count:

```csharp
// .NET 10 / 11. Bug: "Zürich" is 6 chars but 7 UTF-8 bytes.
app.MapGet("/min/wrong-length", async (HttpContext ctx) =>
{
    var json = "{\"city\":\"Zürich\"}";
    ctx.Response.ContentType = "application/json";
    ctx.Response.ContentLength = json.Length; // 17, actual bytes are 18
    await ctx.Response.WriteAsync(json);
});
```

Kestrel enforces the declared length. The client got `Content-Length: 17` and an empty body, and the server logged:

```text
System.InvalidOperationException: Response Content-Length mismatch: too many bytes written (18 of 17).
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.VerifyAndUpdateWrite(Int32 count)
```

Declaring too much fails the other way. With `ContentLength = 100` and 19 bytes written, Kestrel sent the 19 bytes, logged `too few bytes written (19 of 100)` and aborted the connection; `curl` reported `(18) transfer closed with 81 bytes remaining to read`. Use `Encoding.UTF8.GetByteCount(json)` or, better, serialize to `byte[]` and use `.Length`.

### 2. Response compression rewrites it

[Response compression](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) changes the body after your code ran. With `UseResponseCompression()` and an `Accept-Encoding: gzip` request, the same `Results.Bytes` endpoint that produced `Content-Length: 46` came back as `Content-Encoding: gzip`, `Transfer-Encoding: chunked`, with two gzip chunks (`a` and `38` bytes). The middleware removes the original length because it no longer matches, and the compressed size is not known until the stream is flushed. If your constrained clients need a length, exclude their routes from compression or have them stop sending `Accept-Encoding`.

### 3. The body is not what you think it is (ASP.NET Core 6)

The 79914630 author returned `Results.Text(json, "application/json")` from a controller action on ASP.NET Core 6 and got:

```json
{ "content": "{ \"status\": \"OK\" }", "contentType": "application/json", "statusCode": null }
```

So any length computed from `json` was short. In ASP.NET Core 6, MVC had no idea what an `IResult` was. [`ActionResultTypeMapper.Convert` at v6.0.0](https://github.com/dotnet/aspnetcore/blob/v6.0.0/src/Mvc/Mvc.Core/src/Infrastructure/ActionResultTypeMapper.cs) wraps any non-`IActionResult` return value in an `ObjectResult`, so the JSON formatter serialized the result object's public properties. The [v7.0.0 version](https://github.com/dotnet/aspnetcore/blob/v7.0.0/src/Mvc/Mvc.Core/src/Infrastructure/ActionResultTypeMapper.cs) added an `if (value is IResult httpResult) return new HttpActionResult(httpResult);` branch, which is why the same code "works on .NET 8". On 10.0.10 and 11.0.0 the controller action returning `Results.Text(...)`, typed either as `IResult` or as `object`, produced `Content-Length: 19` and the bare JSON. On 6.0, stay inside MVC and return `Content(json, "application/json")`, which is the accepted answer there. (The 6.0 behavior here comes from the source at the v6.0.0 tag; a 6.0 runtime was not run for this post. 6.0 has been out of support since November 2024.)

If you mix the two result families, the trade-offs between them are covered in [typed results vs IResult vs IActionResult](/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/).

## Quick diagnosis checklist

- The hex digits only appear in Fiddler Raw or `curl --raw`: nothing is wrong. That is the transport, and every client removes it.
- The hex digits appear in data your code parsed: the client is reading HTTP/1.1 by hand. Fix the client, or send `Content-Length` with one of the options above.
- A client hangs or truncates: compare the declared `Content-Length` with the real byte count, and check the server log for `Response Content-Length mismatch`.
- `Content-Length` disappears in production but not locally: look for compression middleware, a reverse proxy that re-encodes, or an HTTP/2 hop. The [h2c behind nginx](/2026/11/how-to-accept-http2-cleartext-h2c-in-kestrel-behind-nginx-on-dotnet-10/) setup is a common one where the framing differs per hop.

For the bigger picture on picking between the two endpoint styles tested here, see [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

## Sources

- [RFC 9112, section 7.1: Chunked Transfer Coding](https://www.rfc-editor.org/rfc/rfc9112#section-7.1)
- [MDN: Transfer-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Transfer-Encoding)
- [Stack Overflow 79890922: ASP.NET Core 10 extra content returned on JSON result](https://stackoverflow.com/questions/79890922)
- [Stack Overflow 79914630: Prevent chunking in ASP.NET Core 6 Web API](https://stackoverflow.com/questions/79914630)
- [`ContentResultExecutor.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Core/src/Infrastructure/ContentResultExecutor.cs) and [`HttpResultsHelper.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Results/src/HttpResultsHelper.cs) in dotnet/aspnetcore
- [`ActionResultTypeMapper.cs` at v6.0.0](https://github.com/dotnet/aspnetcore/blob/v6.0.0/src/Mvc/Mvc.Core/src/Infrastructure/ActionResultTypeMapper.cs) vs [v7.0.0](https://github.com/dotnet/aspnetcore/blob/v7.0.0/src/Mvc/Mvc.Core/src/Infrastructure/ActionResultTypeMapper.cs)
- [Response compression in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/response-compression)
