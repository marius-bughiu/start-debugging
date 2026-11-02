---
title: "Blazor render modes in .NET 11: Server, WebAssembly, and Auto"
description: "Choose Blazor Web App render modes or standalone WebAssembly using hosting, offline, service, and support requirements, with corrected Auto behavior."
pubDate: 2026-05-26
updatedDate: 2026-11-02
template: vs
tags:
  - "dotnet-11"
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
---

**Correction — 2 November 2026:** The earlier version included unverified benchmark results and incorrect claims about Auto rendering, templates, offline support, and render-mode boundaries. Those claims have been corrected. No .NET 11 performance measurements are presented here.

For a new server-hosted Blazor application, start by considering **Blazor Web App**. It supports static rendering and optional Server, WebAssembly, or Auto interactivity. If the application must be deployed entirely as static files, consider **standalone Blazor WebAssembly**. “Blazor United” was an early name for the combined approach, not a third runtime you install.

As of this correction, [Microsoft lists .NET 11 RC3 as a go-live prerelease](https://dotnet.microsoft.com/en-us/download/dotnet/11.0). .NET 10 is the current LTS release; .NET 11 belongs to the STS line. Choose the runtime's support policy separately from the rendering architecture.

## Choose where the component runs

| Choice | Useful when | Cost to account for |
| --- | --- | --- |
| Static SSR | Content and request/response forms need server-rendered HTML | No interactive C# event handling |
| Interactive Server | UI needs server-side services and small initial downloads | Connection latency, circuits, and server resources |
| Interactive WebAssembly | Interactive UI should execute in the browser | Runtime download, browser API limits, and backend API design |
| Interactive Auto | Both execution environments are supported and useful | Two execution paths to develop and verify |
| Standalone WebAssembly | Static hosting or a deliberately designed offline PWA is required | Download/cache strategy and separately secured APIs |

Auto chooses an interactive runtime when a component is instantiated. It can use Server initially and WebAssembly on subsequent visits after the bundle is cached. **It does not migrate a running component from Server to WebAssembly.** A server restart therefore isn't made harmless by selecting Auto. See the [render-mode rules](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0).

## Use the current template family

These template commands were verified with SDKs 8.0.427 and 10.0.302. On a .NET 11 SDK, check `dotnet new blazor --help` for that installed build's options; the commands were not run on .NET 11 during this correction.

```bash
dotnet new blazor -o ServerDemo --interactivity Server --no-restore
dotnet new blazor -o AutoDemo --interactivity Auto --no-restore
dotnet new blazorwasm -o OfflineDemo --pwa --no-restore
```

The Server option uses the Blazor Web App template without requiring a WebAssembly client project. A ban on WebAssembly downloads does not require the old `blazorserver` template, which wasn't present in either tested SDK. Auto generates a `.Client` project; components that execute in WebAssembly must be included in its build. The [tooling documentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/tooling?view=aspnetcore-11.0) describes these templates.

In the generated Server app, this page compiled successfully on both tested SDKs:

```razor
@page "/counter-check"
@rendermode InteractiveServer

<button @onclick="() => count++">@count</button>

@code {
    private int count;
}
```

Static SSR is the default when no interactive mode is assigned or inherited. There is no built-in `@rendermode StaticServer` directive value. Remove the interactive directive only when the parent doesn't already impose interactivity.

## Boundaries and services matter

A static parent can contain interactive islands, including siblings with different modes. An interactive child cannot switch to an incompatible interactive mode beneath its parent. Parameters crossing a static-to-interactive boundary must be serializable; arbitrary render fragments cannot cross it.

Server components can call server services, but still require authorization and correct service lifetimes. Browser components must not contain database credentials or other secrets. Missing dependency-injection registrations commonly fail at runtime, not necessarily at compilation. Auto components need appropriate service implementations in both environments. Prerendering is enabled by default for interactive components, so browser-only APIs need lifecycle handling even for WebAssembly interactivity.

## Offline, scaling, and Hybrid are separate decisions

A WebAssembly component inside a Blazor Web App does not automatically make the application offline-capable. A standalone PWA needs a service worker, cached assets, local data, and a synchronization strategy; uncached navigation and remote API calls can still fail without a connection.

Server interactivity needs a working SignalR connection. Capacity depends on per-circuit state and workload; there is no universal 5,000-user limit. WebAssembly shifts UI execution to the browser, but API capacity remains finite. Measure your own startup, bundle transfer, interaction latency, and server memory; the previous fixed timing and memory tables had no reproducible evidence.

[Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/?view=aspnetcore-10.0) runs Razor components on the native .NET runtime inside a desktop/mobile app. It does not require a standalone WebAssembly application. Sharing components through a Razor class library is a separate design choice.

For an existing application, prefer the smallest architecture change that solves a measured problem. The [Framework migration guide](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) covers when that change also involves replacing `System.Web`.

**Verification limits:** Template generation, Server builds, and the counter component were checked on .NET 8 and 10. No .NET 11 build, browser performance benchmark, offline browser run, or Auto lifecycle experiment was performed.

## Further primary references

- [Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor PWA](https://learn.microsoft.com/en-us/aspnet/core/blazor/progressive-web-app?tabs=visual-studio)
