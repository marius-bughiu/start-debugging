---
title: "How to download a file from a Blazor component without JavaScript interop"
description: "Skip the downloadFileFromStream JS module entirely. Render an anchor with the download attribute pointing at a minimal API endpoint that returns TypedResults.File, or POST a plain HTML form with an AntiforgeryToken. Covers why the download attribute is what stops Blazor's enhanced navigation from swallowing the click, why data-enhance silently discards the file, and the cookie-vs-bearer auth trap."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "minimal-apis"
---

To download a file from a Blazor component without writing a line of JavaScript, render a plain `<a>` element whose `href` points at an endpoint that returns `TypedResults.File` and whose `download` attribute is present. That is the whole trick. The `download` attribute is not just a filename hint: it is the flag that makes Blazor's enhanced navigation skip the click and let the browser perform a real navigation, which the `Content-Disposition: attachment` header then turns into a save. For files whose contents depend on user input, post a plain HTML `<form>` with an `<AntiforgeryToken />` to the same kind of endpoint. Everything below targets .NET 11 and C# 14, and was verified end to end against a Blazor Web App running on ASP.NET Core 10.0.5, where the behaviour is identical. The APIs are unchanged since .NET 8.

## Why the official guidance reaches for JS interop, and when you can ignore it

The [Blazor file downloads documentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) gives you two recipes, and both of them start by telling you to add a `.js` file. The small-file recipe wraps a `Stream` in a `DotNetStreamReference`, ships it to a `downloadFileFromStream` JS function, and rebuilds it into a `Blob` and an object URL on the client. The large-file recipe calls a `triggerFileDownload` JS function that builds an `HTMLAnchorElement` in script and fires a synthetic `click` on it.

Read that second one again. The JavaScript exists to create an anchor element and click it. You are in a UI framework whose entire job is rendering HTML elements. You can render the anchor yourself.

The JS-free route is not just less code, it dodges a class of bug that the interop route walks straight into. `IJSRuntime` is not usable while a component is prerendering, which is why [JavaScript interop calls cannot be issued at this time](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) is one of the most common Blazor exceptions. It is unavailable in components using static server-side rendering, because there is no circuit and no WebAssembly runtime to call into. An anchor works in every render mode, including static SSR, with no lifecycle rules at all.

There is exactly one scenario where you genuinely need interop: a standalone Blazor WebAssembly app that generates bytes on the client and must save them without a round trip. Even there, a `data:` URI gets you most of the way, and I cover the limits at the end.

## The download attribute is what stops Blazor eating your click

This is the part nobody explains, and it is why "just use an anchor" advice so often fails in a Blazor Web App.

Blazor Web Apps enable enhanced navigation by default. A document-level click handler intercepts internal links, fetches the destination with `fetch`, and patches the returned HTML into the existing DOM instead of doing a full page load. That is great for pages and catastrophic for a CSV.

The interceptor's guard clause is visible in the shipped `blazor.web.js`:

```js
return (!t || "_self" === t) && e.hasAttribute("href") && !e.hasAttribute("download")
```

An anchor is a candidate for interception only when it has an `href` and does **not** have a `download` attribute. The attribute is a deliberate opt-out, baked into the framework.

Leave it off and here is what actually happens, measured in a browser against a live app. Clicking `<a href="/exports/orders.csv">` produces:

```text
[warn] Enhanced navigation failed for destination http://localhost:5248/exports/orders.csv.
       Falling back to full page load.
```

The address bar changes to `/exports/orders.csv?`, complete with a stray question mark, while the DOM still shows the previous page. The network log shows the endpoint hit **twice**: once by the enhanced-navigation `fetch` that could not make sense of `text/csv`, then again by the fallback document navigation that the browser finally hands to the download manager. Your export query runs twice, the user's URL is wrong, and the file arrives anyway, which is the worst possible combination because it looks like it works.

Add `download` and none of that happens. The click is never intercepted, the URL never changes, one request goes out, one file comes back.

## Steps to wire up a JS-free download

1. **Write an endpoint that returns the file.** A minimal API `MapGet` returning `TypedResults.File`, `TypedResults.Bytes`, or `TypedResults.Stream` sets `Content-Disposition: attachment` for you when you pass `fileDownloadName`.
2. **Render an anchor pointing at it, with the `download` attribute present.** Do not omit it, even when the endpoint already sets `Content-Disposition`.
3. **For parameterised exports, use a plain `<form method="post">`** targeting the endpoint, with an `<AntiforgeryToken />` inside it and no `data-enhance` attribute.
4. **Make sure the endpoint authenticates the way a browser navigation does**, which means cookies, not an `Authorization` header.
5. **Verify the response headers**, not the browser's save dialog. `curl -I` against the endpoint should show `Content-Disposition: attachment` and the filename you expect.

## The endpoint: three shapes of TypedResults

For content that already fits in memory, hand the endpoint a `byte[]`:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders.csv", () =>
{
    var csv = new StringBuilder("Id,Customer,Total\n");
    foreach (var order in OrderStore.Recent())
    {
        csv.Append(CultureInfo.InvariantCulture, $"{order.Id},{order.Customer},{order.Total}\n");
    }

    return TypedResults.File(
        Encoding.UTF8.GetBytes(csv.ToString()),
        contentType: "text/csv",
        fileDownloadName: "orders.csv");
});
```

That produces exactly the headers a browser needs:

```text
HTTP/1.1 200 OK
Content-Length: 75
Content-Type: text/csv
Content-Disposition: attachment; filename=orders.csv; filename*=UTF-8''orders.csv
```

Note the doubled `filename` and `filename*` parameters. ASP.NET Core emits the RFC 6266 form automatically, which is what makes non-ASCII filenames survive the trip.

For anything large enough that buffering it is a memory risk, use `TypedResults.Stream` with a callback and write directly to the response body:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders-stream.csv", (IOrderQuery query, CancellationToken ct) =>
    TypedResults.Stream(
        async stream =>
        {
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
            await writer.WriteLineAsync("Id,Customer,Total");

            await foreach (var order in query.StreamAsync(ct))
            {
                await writer.WriteLineAsync($"{order.Id},{order.Customer},{order.Total}");
            }
        },
        contentType: "text/csv",
        fileDownloadName: "orders-stream.csv"));
```

This responds with `Transfer-Encoding: chunked` and no `Content-Length`, so the user gets no progress bar, but the server never holds the whole export. The same trade-off applies whenever you [stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

The `new UTF8Encoding(false)` is deliberate. `StreamWriter`'s default `Encoding.UTF8` has its BOM preamble enabled, so the shortcut version writes three stray bytes before your header row. I hit this in the probe app: the `byte[]` endpoint produced clean output because `Encoding.UTF8.GetBytes` never emits a preamble, while the streaming endpoint prefixed `Id,Customer,Total` with a BOM. For CSV opened in Excel that BOM is actually what you want, so pick per format rather than by accident.

If the file already exists on disk, skip the buffer entirely: `TypedResults.File(File.OpenRead(path), "application/pdf", "manual.pdf", enableRangeProcessing: true)`. Range processing lets the browser resume an interrupted download.

## Static SSR: an anchor and a plain form, no circuit required

Here is a component that adopts static SSR, has no render mode, no `@onclick`, and downloads two different files:

```razor
@* .NET 11, static SSR, no render mode *@
@page "/exports"

<h1>Exports</h1>

<a href="/exports/orders.csv" download>Download today's orders</a>

<a href="/exports/orders.csv" download="orders-2026-08.csv">Download with a custom name</a>

<form method="post" action="/exports/orders">
    <AntiforgeryToken />
    <label>
        Rows
        <input type="number" name="maxRows" value="500" />
    </label>
    <input type="hidden" name="format" value="csv" />
    <button type="submit">Export</button>
</form>
```

The second anchor shows the one thing the `download` attribute does beyond opting out of enhanced navigation: its value overrides the server's suggested filename. Leave it empty when the endpoint's `fileDownloadName` is already right.

The form is a plain HTML `<form>` with an `action`, not an `EditForm`, and it carries no `@formname` or `@onsubmit`. That is intentional. An `EditForm` posts back into the Blazor component, and a component's job is to render HTML, so there is no way for it to return a file. Posting to a separate endpoint is the only path that ends in a download.

`<AntiforgeryToken />` renders a hidden `__RequestVerificationToken` field. It is required, because a minimal API endpoint that binds `[FromForm]` parameters is covered by antiforgery validation as of .NET 8. Post without the token and you get a bare `400`:

```csharp
// .NET 11, C# 14
app.MapPost("/exports/orders", ([FromForm] string format, [FromForm] int maxRows) =>
{
    var bytes = ExportBuilder.Build(format, maxRows);

    return TypedResults.File(bytes, "text/csv", $"orders.{format}");
});
```

With `app.UseAntiforgery()` in the pipeline and the token in the form, this returns the file directly to the browser. No circuit, no WebAssembly payload, no JavaScript.

.NET 11 adds a second layer here. Automatic header-based CSRF protection is on by default for apps built with `WebApplication.CreateBuilder`, inspecting `Sec-Fetch-Site` and `Origin` on unsafe methods, and Blazor SSR form posts return `400 Bad Request` for untrusted cross-origin posts. Token validation still only runs if you call `UseAntiforgery`, and when both are present the token verdict wins. If a form that worked on .NET 10 starts 400ing after the upgrade, that middleware is the first thing to check. I went through its behaviour in detail when [ASP.NET Core 11 turned on automatic CSRF protection](/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/).

## Interactive render modes: hand the client a URL, not bytes

In an interactive component the instinct is to have the button handler produce a `byte[]` and then find some way to push it at the browser. Invert it. Have the handler prepare the export server-side, stash it behind a token, and render an anchor:

```razor
@* .NET 11, C# 14 *@
@page "/reports"
@rendermode InteractiveServer
@inject IReportService Reports

<button @onclick="Prepare" disabled="@_working">Prepare export</button>

@if (_token is not null)
{
    <a href="@($"/exports/report/{_token}")" download="report.csv">Your export is ready</a>
}

@code {
    private string? _token;
    private bool _working;

    private async Task Prepare()
    {
        _working = true;
        _token = await Reports.QueueExportAsync();
        _working = false;
    }
}
```

The user clicks twice, which is honest UI for an export that takes real time anyway, and the bytes never travel over the SignalR circuit.

If you insist on a single click, `NavigationManager.NavigateTo(url, forceLoad: true)` works and still involves no interop code of yours. Because the response carries `Content-Disposition: attachment`, the browser starts a download and abandons the navigation. I confirmed the SPA URL is untouched afterwards: it was `/interactive` before the call and `/interactive` after, with the file delivered.

```csharp
// .NET 11, C# 14
private void Download() => Nav.NavigateTo("/exports/orders-stream.csv", forceLoad: true);
```

The caveat is that this is a navigation, so if the endpoint returns a `404` or a `500` instead of a file, the browser navigates away from your app to an error page. An anchor fails the same way, but at least the user chose to click it.

## Blazor WebAssembly with no server: the data URI escape hatch

When bytes are produced on the client and there is no endpoint to point at, base64 them into the `href`:

```razor
@* .NET 11, C# 14, Blazor WebAssembly *@
@rendermode InteractiveWebAssembly

<button @onclick="Build">Build report</button>

@if (_href is not null)
{
    <a href="@_href" download="client-report.csv">Save client-report.csv</a>
}

@code {
    private string? _href;

    private void Build()
    {
        var bytes = Encoding.UTF8.GetBytes(ReportBuilder.ToCsv());
        _href = $"data:text/csv;base64,{Convert.ToBase64String(bytes)}";
    }
}
```

Chrome blocks top-level navigation to `data:` URIs, but explicitly exempts anchors carrying a `download` attribute, so this survives. I verified the rendered anchor keeps `download="client-report.csv"` intact in the DOM after WebAssembly hydration.

Two limits keep this from being the general answer. Base64 inflates payloads by about a third and the whole thing lives in a DOM attribute, so a 30 MB export becomes a 40 MB string in the render tree. And browsers disagree on ceilings, with Chrome and Edge enforcing a 2 MB cap in some `data:` contexts while Firefox and Safari document none. Under a megabyte or so this is fine. Past that, add a server endpoint or accept that you need `Blob` and `URL.createObjectURL`, which means interop.

## The gotchas that will actually bite you

**`data-enhance` on the form silently throws your file away.** Enhanced form handling posts with `fetch`, and it refuses to talk to anything that is not a Blazor endpoint. Adding `data-enhance` to the export form above produced this in the console:

```text
Enhanced navigation does not support making a non-GET request to a non-Blazor endpoint.
Avoid enabling enhanced navigation for forms that post to a non-Blazor endpoint.
```

The network tab showed the `POST` returning `200` with the full CSV body. The server built the export, streamed it out, and the client discarded it. Nothing downloaded. `EditForm` with `Enhance` fails identically.

**Bearer tokens do not survive a navigation.** An anchor click and a form post are browser-initiated requests. There is no `Authorization` header, because there is no code of yours running to attach one. If your API authenticates with JWTs held in memory, the download endpoint returns `401` no matter how correct the markup is. Either give that one endpoint cookie authentication, or issue a short-lived single-use token and put it in the path as in the interactive example. The [trade-offs between JWT and cookie authentication](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) are worth reading before you pick, because this is a genuine architectural fork and not a workaround.

**The `download` attribute is ignored cross-origin.** Since Chrome 65 the filename hint is silently dropped for cross-origin URLs, and Firefox ignores the attribute entirely and navigates instead. If your files live on a CDN or a separate API host, the attribute stops being load-bearing and `Content-Disposition: attachment` set by the origin server becomes the only thing that triggers a save. Set it there.

**Static assets still need the attribute.** `<a href="/docs/manual.pdf" download>` works against files in `wwwroot`, but without `download` the enhanced-navigation interception applies to those too, and a PDF is exactly the kind of response that makes enhanced navigation give up mid-patch.

**Do not try to write the response from the component.** Grabbing the cascading `HttpContext` in a static SSR component and writing bytes to `Response.Body` fights the renderer and lands you in [headers are read-only, response has already started](/2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore/). Components render markup. Endpoints return files. Keep the split.

The rule that falls out of all of this is small enough to remember: the browser already knows how to download files, and Blazor already knows how to render anchors. The only thing standing between them is an attribute that the framework is explicitly checking for.

## Sources

- [ASP.NET Core Blazor file downloads](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) on Microsoft Learn, for the interop-based recipes this post replaces
- [ASP.NET Core Blazor forms overview](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/) for the `AntiforgeryToken` component, enhanced form handling, and the .NET 11 automatic CSRF middleware
- [Breaking change: IFormFile parameters require anti-forgery checks](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/8/antiforgery-checks) for why `[FromForm]` binding needs a token
- [Deprecations and removals in Chrome 65](https://developer.chrome.com/blog/chrome-65-deprecations) for the cross-origin `download` attribute restriction
- Behaviour confirmed against a `dotnet new blazor -int Auto` app on ASP.NET Core 10.0.5, inspecting `blazor.web.js`, response headers, and the browser console
