---
title: "Fix: dotnet watch Blazor hot reload WebSocket fails on a custom local domain (403)"
description: "Since the September 2026 .NET SDKs (10.0.112, 10.0.401, 11 RC1), dotnet watch rejects browser-refresh WebSockets from unknown origins. Set DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS to your host name."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-10"
  - "dotnet-11"
---

Set `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` to your custom host name (just the host, like `myapp.localhost`, with no scheme and no port) in the shell that starts `dotnet watch`, then restart it. The September 8, 2026 SDKs (10.0.112, 10.0.401, 9.0.121, 9.0.318, 8.0.131, 8.0.425 and 11.0.100-rc.1) fixed CVE-2026-58649. Since then, the browser-refresh WebSocket only accepts an `Origin` of `localhost`, `127.0.0.1`, `[::1]`, or a host you list in that variable. Anything else gets a 403. I measured everything below on macOS with SDK 10.0.302 (before the fix) and 10.0.401 (after), using the stock `dotnet new blazor` template.

## The error in context

You open the app on a name like `http://myapp.localhost:5080`, `https://shop.test`, or a hosts-file alias, instead of plain `localhost`. The page renders and Blazor's own circuit connects, but the browser console shows this:

```
Failed to load resource: the server responded with a status of 403 (Forbidden)
WebSocket connection to 'ws://localhost:5599/' failed:
WebSocket failed to connect.
WebSocket connection to 'wss://localhost:63038/' failed:
WebSocket failed to connect.
Unable to establish a connection to the browser refresh server.
```

The last three lines are `console.debug` output from `aspnetcore-browser-refresh.js`, so you only see them with the "Verbose" level turned on in Chrome or Edge DevTools. Port numbers are random unless you pin them. Meanwhile the `dotnet watch` terminal looks completely healthy:

```
dotnet watch ⌚ Files updated: ./Components/Pages/Home.razor
dotnet watch 🔥 C# and Razor changes applied in 109ms.
```

The terminal says the change applied and the browser disagrees. That mismatch is why this one is so confusing. Many people who hit it also changed nothing in their project: the SDK updated underneath them through Visual Studio, Homebrew, or a `global.json` with `rollForward: latestPatch`. The report in [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291) says exactly that: hot reload broke on `bug.dev.localhost` with SDK 10.0.401, and pinning 10.0.400 made it work again.

## Why the browser-refresh socket now returns 403

Under `dotnet watch`, web apps get a small script injected, `_framework/aspnetcore-browser-refresh.js`. That script opens a WebSocket back to a server hosted inside the `dotnet watch` process. The server listens on `127.0.0.1` on a random port, plus a WSS port when the dev certificate is available. The socket carries page reloads, CSS updates, Blazor WebAssembly deltas, and diagnostics. The injected URL always points at `localhost`, whatever host name the page itself was loaded from:

```js
// injected by dotnet watch, SDK 10.0.401
const webSocketUrls = 'ws://localhost:5599,wss://localhost:63038'.split(',');
```

So a page on `http://myapp.localhost:5080` makes a cross-origin WebSocket request to `ws://localhost:5599`, and the browser sends `Origin: http://myapp.localhost:5080` with it. Before September 2026 the refresh server ignored the `Origin` header entirely. Any page open in your browser, on any site, could connect to it, and the socket carries IL and PDB update payloads. That is [CVE-2026-58649](https://github.com/dotnet/sdk/issues/56166), rated CWE-346 (Origin Validation Error), CVSS 6.5.

The fix ([dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) on `release/11.0.1xx`, ported to `main` as [#56246](https://github.com/dotnet/sdk/pull/56246)) adds this check before the WebSocket is accepted:

```csharp
// src/Dotnet.Watch/HotReloadClient/Web/BrowserRefreshServer.cs (SDK fix for CVE-2026-58649)
if (!Uri.TryCreate(context.Request.Headers.Origin.FirstOrDefault(), UriKind.Absolute, out var originUri) ||
    !webSocketConfig.GetAllowedOriginDomains().Contains(originUri.Host, StringComparer.OrdinalIgnoreCase))
{
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return;
}
```

`GetAllowedOriginDomains()` yields `localhost`, `127.0.0.1`, `[::1]`, every entry in `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS`, and the value of `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` if it is set. The comparison is an exact, case-insensitive match against `Uri.Host`. There are no wildcards, no suffix matching, and no special case for `*.localhost`. A request with no `Origin` header at all is also rejected.

## Minimal repro

```bash
# .NET SDK 10.0.401, macOS 26 (any OS behaves the same)
dotnet new blazor -o BlazorRepro
cd BlazorRepro
DOTNET_WATCH_AUTO_RELOAD_WS_PORT=5599 dotnet watch run --urls http://localhost:5080
```

Pinning the port with `DOTNET_WATCH_AUTO_RELOAD_WS_PORT` just makes the socket easy to probe. Chromium browsers resolve any `*.localhost` name to loopback without a hosts-file entry, so browse to `http://myapp.localhost:5080/` and you get the console output above. You don't even need a browser. A raw WebSocket handshake with `curl` shows the decision directly:

```bash
# .NET SDK 10.0.401, while dotnet watch is running
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://myapp.test:5000' \
  http://127.0.0.1:5599/
```

I ran that handshake against both SDKs, with different values of the new variable:

| `Origin` header | 10.0.302 | 10.0.401 | 10.0.401 + `ORIGINS=myapp.test;bug.dev.localhost` |
|---|---|---|---|
| `http://localhost:5000` | 101 | 101 | 101 |
| `http://myapp.test:5000` | 101 | 403 | 101 |
| `https://myapp.test` | 101 | 403 | 101 |
| `http://bug.dev.localhost:5000` | 101 | 403 | 101 |
| `https://evil.example` | 101 | 403 | 403 |
| (no `Origin`) | 101 | 403 | 403 |

On 10.0.302, 101 (Switching Protocols) for `https://evil.example` is the vulnerability itself. On 10.0.401, every custom name is refused until you list it.

## The fix: allow your host name

`dotnet watch` reads the variable from its **own** process environment when it starts. Set it in the shell, the task runner, or the container that launches `dotnet watch`, then restart the watcher. A running watcher won't pick it up.

```bash
# bash / zsh, .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.localhost"
dotnet watch run --urls http://localhost:5080
```

```powershell
# PowerShell, .NET SDK 10.0.401+
$env:DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS = "myapp.localhost"
dotnet watch run
```

For more than one name, separate them with `;` or `,`. Whitespace around each entry is trimmed:

```bash
# .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="shop.test;admin.shop.test,api.shop.test"
```

If you start the watcher from VS Code, put the variable on the task, not in `launch.json`. A `coreclr` launch configuration's `env` goes to the app, and the app is not the process doing the check:

```json
// .vscode/tasks.json, .NET SDK 10.0.401+
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "watch",
      "type": "process",
      "command": "dotnet",
      "args": ["watch", "run", "--project", "BlazorRepro/BlazorRepro.csproj"],
      "options": { "env": { "DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS": "myapp.localhost" } },
      "isBackground": true
    }
  ]
}
```

With `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS=myapp.localhost` set, the same page on `http://myapp.localhost:5080` connected, and edits reached the browser without a manual refresh. A text change to the static SSR `Home.razor` and a color change in `wwwroot/app.css` both showed up in the open tab.

## What actually breaks, and why some edits still seem to work

The symptom depends on where the component renders, which makes the bug look intermittent. On 10.0.401 without the variable, with the page open on `myapp.localhost`:

- **Interactive Server components** (the template's `Counter.razor` with `@rendermode InteractiveServer`): Razor and C# edits **still appeared**. The delta is applied inside the server process, and Blazor re-renders over its own SignalR circuit (`ws://myapp.localhost:5080/_blazor`), which is same-origin and never touches the refresh server.
- **Static SSR pages** (the template's `Home.razor`): Razor edits **did not appear**. `dotnet watch` printed "C# and Razor changes applied", but only a browser refresh pushed through the refresh socket would show the new HTML.
- **CSS in `wwwroot`**: changes **did not appear** on any page, even though the terminal printed "Static asset changes applied". CSS updates are delivered through the refresh socket.
- **Blazor WebAssembly** (standalone or the `.Client` project): the deltas themselves travel over the refresh socket, so C# and Razor hot reload for WebAssembly components stops as well (I did not measure this case, but the delivery path is the same socket).

So "hot reload works on the counter page but not on the home page" is this same bug, not two different ones. If you are not sure which bucket a component falls into, see [how Blazor decides which render mode runs a component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).

## Gotchas and lookalikes

**The value is a host name, not an origin.** The check compares `Uri.Host`, so `http://myapp.test` and `myapp.test:5000` never match anything. In my runs, `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.test:5000,*.localhost"` and `"http://myapp.test"` both still returned 403 for every custom origin. List every subdomain explicitly.

**`launchSettings.json` does not work.** A profile's `environmentVariables` are passed to the app process. `dotnet watch` has already built its allow-list by then. I added the variable to both profiles of the template's `launchSettings.json` and still got 403 for `myapp.test`. The same fix also changed how launch-profile variables reach the app: they now go over RPC to the hot reload agent instead of as `-e` arguments ([CVE-2026-69806](https://github.com/dotnet/sdk/issues/56167), same PR). None of that affects the watcher's own settings, though. If you want this tied to the repo, a `.env`-style script or the task definition above is the place for it.

**`DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` is a different knob.** Its host is also added to the allow-list (with `HOSTNAME=myapp.test` the `myapp.test` origins returned 101 in my test), but it does more than that. It changes the host the refresh server binds to and the URL the injected script connects to. Kestrel treats a non-IP host name as "listen on all interfaces", so the socket becomes reachable from your network. Use `HOSTNAME` only when the browser really cannot reach `localhost`, for example when `dotnet watch` runs inside a container or on a remote dev box. When only the page's name differs, use `ORIGINS`.

**Pinning the old SDK "fixes" it by bringing the vulnerability back.** A `global.json` pinned to 10.0.400 or 10.0.302 makes the 403 go away, because those SDKs accept any origin, `https://evil.example` included. Treat that as a diagnostic step, not a fix.

**The advisory table and the release notes disagree on version numbers.** The advisory lists 10.0.111 and 10.0.400 as "patched". The [release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json) puts CVE-2026-58649 in the September 8 release (runtime 10.0.12, SDKs 10.0.112 and 10.0.401). Measurement and the issue reporter agree with the release metadata: 10.0.400 accepts any origin, and 10.0.401 enforces the check. The public `v10.0.400` and `v10.0.401` tags point at the same commit because security fixes are built from the internal repo, so don't bother diffing the tags.

**A 403 on the page itself is something else.** If the whole document returns 403, check what is actually listening on that port. On macOS, port 5000 belongs to the AirPlay Receiver in Control Center, which answers 403 for any path. Browsers can resolve `*.localhost` to `::1` before `127.0.0.1`, so a Kestrel bound only to `127.0.0.1:5000` loses that connection to AirPlay. I hit exactly this while building the repro, which is why the commands above use `--urls http://localhost:5080`.

**No custom domain involved, still no refresh?** If you browse `localhost` and the socket still fails, the cause is somewhere else: an HTTPS page trying `wss://` without a trusted dev certificate, `DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1` left in the environment, or middleware that rewrites the response so the script never gets injected. [What dotnet watch adds on top of dotnet run](/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) walks through the injection and the environment variables it sets.

**This goes away later.** On the SDK's `main` branch, [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118) (merged 2026-09-21) routes the browser-tools WebSocket through the application's own origin and forwards it to a loopback-only provider. In that design the page and the socket share an origin, and a code comment says `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` "no longer applies to this hop". That change has not shipped in any SDK as of this writing, so on 10.0.401 and 11 RC1 you still need the variable.

## Related

This is the second time an SDK update has quietly broken a Blazor app without a single project change. The first was [the blazor.server.js 404 after installing the .NET 10 SDK](/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/). For what `dotnet watch` has gained recently beyond the browser socket, see [dotnet watch in .NET 11 Preview 3 with Aspire hosts and crash recovery](/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/). If you use Visual Studio instead of the CLI, [Hot Reload auto-restart in Visual Studio 2026](/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) covers how the IDE handles edits it cannot apply. I did not test Visual Studio's own browser connection for this post.

## Sources

- [CVE-2026-58649 advisory, dotnet/sdk#56166](https://github.com/dotnet/sdk/issues/56166), and the [announcement, dotnet/announcements#441](https://github.com/dotnet/announcements/issues/441).
- [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198), the fix, which documents `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` as the escape hatch for custom domains, and its `main` port [#56246](https://github.com/dotnet/sdk/pull/56246).
- [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291), the regression report on `*.dev.localhost` with SDK 10.0.401 and the maintainer's workaround.
- [`EnvironmentVariables.cs` in dotnet/sdk](https://github.com/dotnet/sdk/blob/main/src/Dotnet.Watch/Watch/Context/EnvironmentVariables.cs), for the variable names, separators, and defaults.
- [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118), the same-origin browser-tools redesign on `main`.
- [.NET 10 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), for which SDK builds carry the fix.
