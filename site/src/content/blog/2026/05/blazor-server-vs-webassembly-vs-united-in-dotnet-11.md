---
title: "Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11: which should you pick in 2026?"
description: "For any new Blazor app on .NET 11, scaffold a Blazor Web App (the template formerly nicknamed Blazor United) and pick render modes per page. Server-only and WebAssembly-only templates only still make sense in narrow cases."
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
---

For any new Blazor app on .NET 11, the answer is the Blazor Web App template (the model that was nicknamed "Blazor United" while .NET 8 was in preview). It lets you decide rendering per component: static server-side rendering for marketing pages, interactive Server for low-latency CRUD screens, interactive WebAssembly for offline-capable widgets, and Auto for components that should hand off from Server to WebAssembly once the WASM payload finishes downloading. Pick a Server-only or WebAssembly-only template only when you have a hard constraint that rules out the unified model: an internal app where the WebAssembly download is a deal-breaker, or a PWA that must run fully offline against a third-party API.

This post targets .NET 11 (preview at time of writing, GA scheduled November 2026) and the `Microsoft.AspNetCore.Components` 11.0.x package set. Project templates are from the `Microsoft.AspNetCore.Components.WebAssembly.Templates` and the in-box `dotnet new blazor` template that ships with the .NET 11 SDK. Where behaviour matters across versions, I call out the .NET 8, .NET 9, .NET 10, and .NET 11 differences inline.

## What "Blazor United" actually is in .NET 11

"Blazor United" is not a separate hosting model. It was the working name Microsoft used during the .NET 8 preview cycle for what shipped as the **Blazor Web App** template. The template combines four render modes in one project:

- **Static Server (SSR)**: HTML rendered on the server, no interactivity, no SignalR connection, no WebAssembly download. Loads like a Razor Page.
- **Interactive Server**: HTML rendered on the server, DOM updates pushed over a SignalR circuit. The classic Blazor Server model.
- **Interactive WebAssembly**: The component runs in the browser on a WebAssembly runtime. The classic Blazor WebAssembly model.
- **Interactive Auto**: Renders on Server while the user waits for the WebAssembly bundle to download in the background, then transparently hands off to WebAssembly on the next navigation. Per-component fallback if WebAssembly fails to load.

You declare the mode per component with `@rendermode InteractiveServer`, `@rendermode InteractiveWebAssembly`, or `@rendermode InteractiveAuto`. The same `.razor` file can run in any of those modes if it does not call APIs that are mode-specific (more on that below).

Blazor Server (the standalone template, `dotnet new blazorserver`) and Blazor WebAssembly (`dotnet new blazorwasm`) still exist in .NET 11, but Microsoft's guidance since .NET 8 has been: prefer the unified Blazor Web App template unless you have a specific reason not to.

## The feature matrix

| Capability                                | Blazor Server (standalone)               | Blazor WebAssembly (standalone)              | Blazor Web App / United (.NET 11)            |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Render location                           | server                                   | browser                                      | per-component (Static, Server, WASM, Auto)   |
| Initial payload (cold cache)              | ~50-80 KB HTML                           | ~1.4 MB WASM + assemblies (R2R, .NET 11)     | ~50-80 KB HTML, WASM downloads lazily        |
| First Contentful Paint (LAN)              | ~80-150 ms                               | ~600-900 ms                                  | ~80-150 ms (Static / Server) ~600-900 ms (WASM-first) |
| Time to interactive after FCP             | tens of ms (WebSocket open)              | hundreds of ms (WASM boot)                   | depends on render mode of the landed page    |
| Requires persistent WebSocket             | yes (SignalR)                            | no                                           | only for Interactive Server components       |
| Works offline                             | no                                       | yes (with service worker)                    | yes for WebAssembly components, no for Server |
| Direct DB / file / secret access          | yes (server process)                     | no (browser sandbox)                         | yes in Server components, no in WASM components |
| .NET API surface                          | full server runtime                      | trimmed, browser-safe subset                 | both, depending on component                 |
| Debugging story                           | F5 in Visual Studio / Rider              | Chrome devtools + VS WebAssembly debugger    | both                                         |
| Scale ceiling per server                  | bounded by open circuits (~5k per node)  | unbounded (static files + API)               | bounded only for the Interactive Server pages |
| Native AOT support                        | no (server still JIT)                    | partial via WASM AOT                         | per-render-mode                              |
| Authentication story                      | cookie + circuit                         | OIDC / token in browser                      | cookie for SSR/Server, token for WASM        |
| .NET 11 status                            | supported, not the recommended default   | supported, not the recommended default       | recommended default                          |

The row that ends the conversation for most new apps is the last one. Microsoft's own templates, docs samples, and tutorials lead with the Blazor Web App template. Choosing Server-only or WebAssembly-only in 2026 is now an explicit deviation that needs justification.

## When to pick Blazor Server (standalone)

The standalone Blazor Server template is still the right call when you have one of these constraints:

- **Internal LAN application, fixed user count, ban on WebAssembly downloads.** Field service tools, manufacturing dashboards, hospital-floor screens. A 1.4 MB WebAssembly download over a flaky kiosk Wi-Fi is a worse user experience than a SignalR reconnect. With .NET 11 the standalone Server template is also the leanest container image because it never copies the WASM runtime into your publish output.
- **You need to call a SQL Server with Windows Authentication or a Kerberos-protected service from the component.** The component runs in the server process, so it can use the integrated credentials of the app pool identity. There is no equivalent for WebAssembly without a server-side proxy.
- **The team has no front-end people and never will.** Server rendering with a SignalR circuit hides almost all browser concerns. State lives on the server, you debug with regular .NET tooling, and there is no second build pipeline for the WASM bundle.

A minimal Blazor Server `Program.cs` in .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Note `AddRazorComponents()` plus `AddInteractiveServerComponents()` is the .NET 8+ API. The old `AddServerSideBlazor()` still works but routes through a compatibility layer and does not light up the new render-mode plumbing. Use the new APIs in any greenfield project.

## When to pick Blazor WebAssembly (standalone)

Reach for the standalone WebAssembly template when:

- **The app must work offline.** A PWA that ships to field engineers, a tablet app for in-store associates, anything that talks to a backend behind a flaky connection. Combine a service worker with a local store (`IndexedDB` through `Microsoft.JSInterop`) and the app survives total network loss.
- **You are deploying to a CDN or static host with no .NET runtime.** Blazor WebAssembly is just `wwwroot/` plus a `_framework/` folder. Drop it on Cloudflare Pages, GitHub Pages, Azure Static Web Apps, or any S3 bucket behind CloudFront. You pay zero compute. The Blazor Web App template, by contrast, needs an ASP.NET Core host for the Server and SSR pages.
- **The backend is a third-party API you do not own.** If your data store is Stripe, Auth0, or a public REST API, there is no server logic to host. The standalone WASM template plus an OIDC PKCE flow gives you a fully client-side app with no infrastructure of your own.
- **You want to ship the front-end as part of a MAUI Hybrid or Electron app.** `BlazorWebView` and the .NET MAUI Hybrid template both expect a standalone WebAssembly-style component graph. Embedding a Blazor Web App project there does not buy you anything.

A minimal Blazor WebAssembly `Program.cs` in .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.WebAssembly 11.0.x
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

await builder.Build().RunAsync();
```

In .NET 11 the WebAssembly runtime has multi-threading enabled by default for new projects when you opt in with `<WasmEnableThreads>true</WasmEnableThreads>` in the `.csproj`. That removes one of the biggest reasons people used to dismiss Blazor WebAssembly: CPU-bound work no longer blocks the UI thread.

## When to pick Blazor Web App (the United model)

For everything else. The unified template gives you a single project where:

- The landing page is `@rendermode StaticServer` and loads in under 100 ms with no JavaScript at all. It is indistinguishable from a Razor Page to a search crawler.
- The dashboard is `@rendermode InteractiveServer` because it talks directly to a `DbContext` and you do not want to expose those queries through an API.
- The image annotator is `@rendermode InteractiveWebAssembly` because it runs an ONNX model in the browser via `Microsoft.ML.OnnxRuntime`.
- The shared shell components are `@rendermode InteractiveAuto`: they render under Server on first paint, then hand off to WebAssembly once the bundle finishes downloading, so subsequent navigations are instant and survive a server restart.

This composability is what nothing else matches. You stop having a binary "Server app or WASM app" decision and start having a per-page decision the same way Next.js lets you mix `ssr`, `static`, and `client`. A minimal Blazor Web App `Program.cs` in .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x +
// Microsoft.AspNetCore.Components.WebAssembly.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorApp.Client._Imports).Assembly);

app.Run();
```

The `.Client` project that ships with the template is where you put components that need to run on WebAssembly. Server-only components stay in the host project. Interactive Auto components live in `.Client` (because they have to be reachable from the WebAssembly side too).

## The cold-start and bundle-size data

The numbers below are from a clean `dotnet new blazor`, `dotnet new blazorserver`, and `dotnet new blazorwasm` on .NET 11 SDK `11.0.100-preview.4.26152.6`, published with `dotnet publish -c Release` and served by `dotnet run`. Measured with Chrome 137 on a MacBook Pro M2, cold cache, throttled "Fast 3G" in DevTools.

| Metric                                       | Blazor Server | Blazor WebAssembly | Blazor Web App (Auto landing) |
| -------------------------------------------- | ------------- | ------------------ | ----------------------------- |
| Initial HTML transferred                     | 8 KB          | 4 KB               | 8 KB                          |
| WebAssembly + assemblies transferred         | 0             | 1.42 MB (gzip)     | 1.42 MB (gzip, lazy)          |
| Time to First Contentful Paint               | 320 ms        | 1850 ms            | 340 ms                        |
| Time to Interactive (counter button live)    | 410 ms        | 2300 ms            | 440 ms (Server) / 2400 ms (handoff to WASM) |
| Memory after first navigation                | 7 MB browser  | 38 MB browser      | 9 MB then 41 MB after handoff |

The Blazor Web App in Auto mode beats standalone WebAssembly on first paint by a factor of five because it does not wait for the bundle. It does not beat standalone Server because once the WebAssembly bundle finishes loading it costs memory anyway. The point is not that Auto is the fastest at one metric. The point is it is never the slowest.

For a deeper look at how the .NET 11 SDK trims the WASM bundle, see [the new dotnet-11 Blazor WebWorker template](/2026/04/dotnet-11-preview-2-blazor-webworker-template/) which uses the same trimmer settings.

## The gotcha that picks for you

Three things force the decision regardless of preference:

1. **You cannot put a `DbContext` injection on a WebAssembly component.** Or any `IConfiguration` value that contains a secret. Or any blob client that uses a connection string. The browser is a hostile environment by design. If your component has to read the database directly, it has to be Server (or you need a backend API that the WASM component calls). The Blazor Web App template surfaces this by failing fast: drop `@inject ApplicationDbContext Db` in a `.Client` component and the build fails with a clear missing-DI error.

2. **You cannot do `@rendermode` switching inside a render-mode boundary.** A page rendered as Static Server can host an Interactive Server island, and an Interactive Server page can host Interactive WebAssembly islands, but you cannot nest interactivity inside interactivity. In practice this means: pick the lowest render mode that works for the page, and only escalate at the island level.

3. **HTTPS, antiforgery, and authentication state flow through cookies by default.** WebAssembly components do not see those cookies for cross-origin requests. If the WebAssembly part of a Blazor Web App calls an external API, you need an OIDC token flow on top, not just the host cookie. This is the single most common stumbling block when migrating a Blazor Server app to the Web App template.

For the antiforgery angle specifically, the [Blazor SSR TempData behaviour in .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) and the [shared validation logic guide](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) cover the practical patterns.

## Restated recommendation

For a new Blazor project on .NET 11 in 2026, start with `dotnet new blazor` (the Blazor Web App template) and assign render modes per page. The cost of being able to drop down to `@rendermode StaticServer` for a marketing page or up to `@rendermode InteractiveWebAssembly` for an offline-capable component is nearly zero compared to the cost of picking the wrong standalone template and rewriting later. Choose `dotnet new blazorserver` only if you have a hard ban on WebAssembly downloads. Choose `dotnet new blazorwasm` only if your deployment target has no .NET runtime, or if you are embedding the front-end in MAUI Hybrid or Electron.

If you are already on Blazor Server today and weighing a migration, the destination is almost always the Blazor Web App template with most of your existing pages set to `@rendermode InteractiveServer`. That is the lowest-risk migration: behaviour stays identical for the pages that move over, and you unlock the option to add Static Server and Auto components incrementally.

## Related

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for the backend API decisions a Blazor Web App opens up.
- [How to use Tailwind CSS with Blazor WebAssembly in .NET 11](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) for styling pipeline differences between standalone WASM and the Blazor Web App template.
- [How to share validation logic between server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) for the practical "shared project" pattern the Web App template formalises.
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) for the compilation-mode tradeoffs that affect both Server and WASM.
- [Blazor virtualize with variable height in .NET 11 Preview 3](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) for one of the new APIs that benefit Auto-mode component lists.

## Sources

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, accessed 2026-05-26.
- [What's new in ASP.NET Core in .NET 8](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-8.0) for the first ship of the unified template (then called "Blazor United" in previews).
- [What's new in ASP.NET Core for .NET 11](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-11.0) for the per-render-mode improvements.
- [ASP.NET Core Blazor WebAssembly with multithreading](https://learn.microsoft.com/aspnet/core/blazor/performance#webassembly-multithreading) for the `WasmEnableThreads` flag.
- [`dotnet/aspnetcore` discussion 51020](https://github.com/dotnet/aspnetcore/discussions/51020), where Microsoft engineers explained why "United" became "Web App" in the GA template name.
