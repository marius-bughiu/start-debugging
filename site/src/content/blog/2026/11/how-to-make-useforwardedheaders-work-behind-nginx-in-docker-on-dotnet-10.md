---
title: "How to make UseForwardedHeaders work behind nginx in Docker on .NET 10"
description: "Behind nginx and Docker, ASP.NET Core's ForwardedHeadersMiddleware silently ignores X-Forwarded-For and X-Forwarded-Proto unless the connecting proxy is in KnownIPNetworks or KnownProxies, and ForwardLimit decides how many hops it walks. The four silent-ignore rules, the KnownNetworks to KnownIPNetworks change in .NET 10, and a runnable repro checked on .NET 10.0.10."
pubDate: 2026-11-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "docker"
  - "nginx"
---

**Short answer:** in .NET 10, `ForwardedHeadersMiddleware` only trusts proxies on loopback (`127.0.0.0/8` and `::1`) by default. When nginx forwards to a container, the connection reaches Kestrel from a Docker address such as `172.18.0.1`, the middleware logs `Unknown proxy` at Debug level, and it leaves `RemoteIpAddress` and `Scheme` untouched. Add that address range to `KnownIPNetworks` (a `System.Net.IPNetwork`, the replacement for the obsolete `KnownNetworks`), set `ForwardedHeaders = XForwardedFor | XForwardedProto`, and raise `ForwardLimit` to the number of proxies in front of the app, trusting every one of them. With Cloudflare in front of nginx that means `ForwardLimit = 2` plus the Cloudflare ranges, otherwise `RemoteIpAddress` becomes a Cloudflare edge IP instead of the client.

Every behavior below was checked by driving the real `ForwardedHeadersMiddleware` from a console app on .NET 10.0.10 (SDK 10.0.302, macOS arm64), with the connection's remote address set to the values a Docker setup produces. Docker and nginx themselves were not run for this post; the topology comes from the Stack Overflow report quoted below and the middleware source on the `release/10.0` branch.

## The report: forwarded headers arrive, the app ignores them

The question [Forwarded headers are not being picked up by ASP.NET Core](https://stackoverflow.com/questions/79942487) describes the setup most self-hosted apps end up with: Browser, then Cloudflare, then nginx on the host with `proxy_pass http://localhost:5000`, then a published Docker port, then the app. The nginx config is the standard one from the docs:

```nginx
location / {
    proxy_pass http://localhost:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

The app registered the Cloudflare IPv4 ranges in `KnownIPNetworks`, called `app.UseForwardedHeaders()` first, and logged what it saw afterwards:

```text
RemoteIpAddress: ::ffff:172.18.0.1
X-Forwarded-For: MY_IP_ADDRESS, 162.158.116.145
X-Forwarded-Proto: https
Scheme: http
```

The headers are there. The middleware ran. Nothing changed, and nothing was logged at the default Information level. The accepted answer ("the Docker gateway IP was not trusted") is correct but stops halfway: trusting only the gateway produces a different wrong answer, which is what the rest of this post walks through.

## How the middleware decides whether to apply a header

The logic lives in `ForwardedHeadersMiddleware.ApplyForwarders` ([source on `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Middleware/HttpOverrides/src/ForwardedHeadersMiddleware.cs)). It reads `X-Forwarded-For` right to left, one entry per proxy hop, and for each hop:

1. It checks that the address the request currently appears to come from is trusted. On the first hop that is the TCP peer (`HttpContext.Connection.RemoteIpAddress`). If the address is not in `KnownProxies` and not inside any `KnownIPNetworks` entry, it logs `Unknown proxy: {RemoteIpAndPort}` at **Debug** and stops.
2. It takes the rightmost unconsumed `X-Forwarded-For` entry as the new remote address, and the matching `X-Forwarded-Proto` entry as the new scheme.
3. It moves to the next entry, now asking whether *that* address is a trusted proxy.

It stops after `ForwardLimit` entries (default `1`). Whatever it consumed is applied: `RemoteIpAddress` and `Scheme` are replaced, the old values are saved in `X-Original-For` and `X-Original-Proto`, and the consumed entries are removed from `X-Forwarded-For`.

The defaults in .NET 10, printed from a fresh `ForwardedHeadersOptions`:

```text
[defaults] ForwardedHeaders=None ForwardLimit=1 KnownIPNetworks=127.0.0.0/8 KnownProxies=::1
```

That gives four ways for the headers to be silently ignored.

## Reproducing each silent-ignore rule

This console app builds the same request the Stack Overflow asker got (TCP peer `::ffff:172.18.0.1`, two `X-Forwarded-For` entries, one `X-Forwarded-Proto`) and runs it through the real middleware with different options. `203.0.113.7` stands in for the client; `162.158.116.145` is the Cloudflare edge from the report.

```csharp
// .NET 10 (SDK 10.0.302, runtime 10.0.10), C# 14
// fwd.csproj: <Project Sdk="Microsoft.NET.Sdk.Web">, net10.0, OutputType Exe
using System.Net;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Options;
using IPNetwork = System.Net.IPNetwork;

using var loggerFactory = LoggerFactory.Create(b => b
    .AddSimpleConsole(o => o.SingleLine = true)
    .AddFilter("Microsoft.AspNetCore.HttpOverrides", LogLevel.Debug));

static DefaultHttpContext NewRequest()
{
    var ctx = new DefaultHttpContext();
    ctx.Connection.RemoteIpAddress = IPAddress.Parse("::ffff:172.18.0.1"); // Docker bridge gateway
    ctx.Connection.RemotePort = 50612;
    ctx.Request.Scheme = "http";
    ctx.Request.Headers["X-Forwarded-For"] = "203.0.113.7, 162.158.116.145";
    ctx.Request.Headers["X-Forwarded-Proto"] = "https";
    return ctx;
}

void Run(string name, Action<ForwardedHeadersOptions> configure)
{
    var options = new ForwardedHeadersOptions();
    configure(options);
    var mw = new ForwardedHeadersMiddleware(_ => Task.CompletedTask, loggerFactory, Options.Create(options));
    var ctx = NewRequest();
    mw.ApplyForwarders(ctx);
    Thread.Sleep(50); // let the console logger flush first
    Console.WriteLine($"[{name}] RemoteIp={ctx.Connection.RemoteIpAddress} Scheme={ctx.Request.Scheme} " +
        $"XFF='{ctx.Request.Headers["X-Forwarded-For"]}' X-Original-For='{ctx.Request.Headers["X-Original-For"]}'");
}

var cloudflare = new[] { "173.245.48.0/20", "103.21.244.0/22", "162.158.0.0/15", "104.16.0.0/13" };
const ForwardedHeaders ForAndProto = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

Run("1 defaults", o => { });
Run("2 For|Proto only", o => o.ForwardedHeaders = ForAndProto);
Run("3 Cloudflare ranges only", o =>
{
    o.ForwardedHeaders = ForAndProto;
    foreach (var r in cloudflare) o.KnownIPNetworks.Add(IPNetwork.Parse(r));
});
Run("4 trust Docker bridge", o =>
{
    o.ForwardedHeaders = ForAndProto;
    o.KnownIPNetworks.Add(IPNetwork.Parse("172.16.0.0/12"));
});
Run("5 bridge + limit 2, no CF", o =>
{
    o.ForwardedHeaders = ForAndProto;
    o.ForwardLimit = 2;
    o.KnownIPNetworks.Add(IPNetwork.Parse("172.16.0.0/12"));
});
Run("6 bridge + CF + limit 2", o =>
{
    o.ForwardedHeaders = ForAndProto;
    o.ForwardLimit = 2;
    o.KnownIPNetworks.Add(IPNetwork.Parse("172.16.0.0/12"));
    foreach (var r in cloudflare) o.KnownIPNetworks.Add(IPNetwork.Parse(r));
});
```

Output on .NET 10.0.10 (each `dbug` line belongs to the result line directly below it):

```text
[1 defaults] RemoteIp=::ffff:172.18.0.1 Scheme=http XFF='203.0.113.7, 162.158.116.145' X-Original-For=''
dbug: Microsoft.AspNetCore.HttpOverrides.ForwardedHeadersMiddleware[1] Unknown proxy: [::ffff:172.18.0.1]:50612
[2 For|Proto only] RemoteIp=::ffff:172.18.0.1 Scheme=http XFF='203.0.113.7, 162.158.116.145' X-Original-For=''
dbug: Microsoft.AspNetCore.HttpOverrides.ForwardedHeadersMiddleware[1] Unknown proxy: [::ffff:172.18.0.1]:50612
[3 Cloudflare ranges only] RemoteIp=::ffff:172.18.0.1 Scheme=http XFF='203.0.113.7, 162.158.116.145' X-Original-For=''
[4 trust Docker bridge] RemoteIp=162.158.116.145 Scheme=https XFF='203.0.113.7' X-Original-For='[::ffff:172.18.0.1]:50612'
dbug: Microsoft.AspNetCore.HttpOverrides.ForwardedHeadersMiddleware[1] Unknown proxy: 162.158.116.145:0
[5 bridge + limit 2, no CF] RemoteIp=162.158.116.145 Scheme=https XFF='203.0.113.7' X-Original-For='[::ffff:172.18.0.1]:50612'
[6 bridge + CF + limit 2] RemoteIp=203.0.113.7 Scheme=https XFF='' X-Original-For='[::ffff:172.18.0.1]:50612'
```

Read it as four separate rules.

**Rule 1: `ForwardedHeaders` defaults to `None`.** Scenario 1 does nothing and logs nothing at all, not even at Debug. `app.UseForwardedHeaders()` without configuring `ForwardedHeadersOptions` is a no-op. The project templates do not set it for you.

**Rule 2: the TCP peer must be trusted.** Scenarios 2 and 3 are the Stack Overflow report exactly. The asker trusted Cloudflare, but Cloudflare never talks to Kestrel. The peer Kestrel sees is the Docker bridge gateway, because nginx on the host connects to the published port and Docker forwards that connection into the container from the gateway address. The middleware checks the gateway first, finds it untrusted, and gives up before it ever looks at `162.158.116.145`. Note that the IPv4-mapped form `::ffff:172.18.0.1` is not the problem: `CheckKnownAddress` maps it back to IPv4 before testing, which is why scenario 4 matches `172.16.0.0/12` without any extra entry.

**Rule 3: `ForwardLimit` defaults to 1.** Scenario 4 is what the accepted answer leads to. Trusting the gateway makes the middleware consume one entry, so `RemoteIpAddress` becomes `162.158.116.145`, which is Cloudflare, not the visitor. The scheme does become `https`, so redirects and cookie flags start working, and that makes this half-fix easy to miss. Rate limiting by IP or audit logging on this value would lump every visitor behind one Cloudflare edge into a single bucket.

**Rule 4: every hop you walk must also be trusted.** Scenario 5 raises `ForwardLimit` to 2 but does not trust Cloudflare. The middleware consumes the first entry, then asks whether `162.158.116.145` is a known proxy, logs `Unknown proxy: 162.158.116.145:0`, and stops. Only scenario 6, with the bridge network, the Cloudflare ranges and a limit of 2, yields the real client address and an empty `X-Forwarded-For`.

## The fix, step by step

1. Find the address the proxy connects from. For nginx on the host proxying to a published port, that is the bridge gateway; for nginx as another container on the same Compose network, it is the nginx container's IP. `docker network inspect <network> --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}'` prints both the subnet and the gateway. Prefer trusting the subnet: container IPs change when containers are recreated.
2. Pin the subnet so it does not drift between hosts or `docker compose down` cycles:

   ```yaml
   # compose.yaml
   networks:
     backend:
       ipam:
         config:
           - subnet: 172.30.0.0/24
   ```

3. Configure the options, before `Build()`, with the subnet plus every upstream proxy range, and `ForwardLimit` equal to the number of proxies:

   ```csharp
   // .NET 10, C# 14
   using System.Net;
   using Microsoft.AspNetCore.HttpOverrides;
   using IPNetwork = System.Net.IPNetwork;

   var builder = WebApplication.CreateBuilder(args);

   builder.Services.Configure<ForwardedHeadersOptions>(options =>
   {
       options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
       options.ForwardLimit = 2; // nginx + Cloudflare

       foreach (var cidr in builder.Configuration.GetSection("ForwardedHeaders:TrustedNetworks").Get<string[]>() ?? [])
       {
           options.KnownIPNetworks.Add(IPNetwork.Parse(cidr));
       }
   });

   var app = builder.Build();
   app.UseForwardedHeaders(); // first, before HTTPS redirection, auth, rate limiting, logging
   ```

   ```json
   {
     "ForwardedHeaders": {
       "TrustedNetworks": [ "172.30.0.0/24", "173.245.48.0/20", "103.21.244.0/22", "162.158.0.0/15" ]
     }
   }
   ```

   Keep the Cloudflare list complete and current from [cloudflare.com/ips](https://www.cloudflare.com/ips/), including the IPv6 ranges if the edge reaches nginx over IPv6.

4. Turn on Debug logging for the middleware while you verify, then turn it off again:

   ```json
   {
     "Logging": {
       "LogLevel": {
         "Microsoft.AspNetCore.HttpOverrides": "Debug"
       }
     }
   }
   ```

   An `Unknown proxy: <address>` line names exactly the hop that is not trusted. No line at all while the headers are still ignored means rule 1: `ForwardedHeaders` is still `None`, or the middleware runs after the code that reads the values.

5. Check the result from inside the app. After a successful pass, `X-Original-For` holds the proxy's address and `X-Forwarded-For` holds only the entries that were not consumed, so a temporary endpoint that echoes `RemoteIpAddress`, `Scheme`, `X-Original-For` and `X-Forwarded-For` shows precisely how far the middleware got.

## KnownNetworks became KnownIPNetworks in .NET 10

Older answers use `options.KnownNetworks.Add(new IPNetwork(IPAddress.Parse("172.18.0.0"), 16))`. In .NET 10 that compiles with [warning ASPDEPR005](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/ipnetwork-knownnetworks-obsolete?view=aspnetcore-10.0): `Microsoft.AspNetCore.HttpOverrides.IPNetwork` and `KnownNetworks` are obsolete in favor of `System.Net.IPNetwork` and `KnownIPNetworks`. Functionally both still work, because [dotnet/aspnetcore#63658](https://github.com/dotnet/aspnetcore/pull/63658) made the two properties views over one synchronized list before .NET 10 shipped. Adding to the old property is not silently lost.

The migration has one sharp edge, hit while building the repro above: a file with `using System.Net;` and `using Microsoft.AspNetCore.HttpOverrides;` that mentions `IPNetwork` fails with:

```text
error CS0104: 'IPNetwork' is an ambiguous reference between 'Microsoft.AspNetCore.HttpOverrides.IPNetwork' and 'System.Net.IPNetwork'
```

Fully qualify it as `System.Net.IPNetwork`, or add `using IPNetwork = System.Net.IPNetwork;`. `System.Net.IPNetwork.Parse("10.0.0.0/8")` also replaces the manual `Split('/')` that older samples use.

## ASPNETCORE_FORWARDEDHEADERS_ENABLED trusts everyone and still stops at one hop

Container guides often suggest the environment variable instead of code. It is handled by two internal classes in the default host: `ForwardedHeadersOptionsSetup` sets `XForwardedFor | XForwardedProto` and **clears** both `KnownIPNetworks` and `KnownProxies`, and `ForwardedHeadersStartupFilter` inserts `UseForwardedHeaders()` at the start of the pipeline. Resolving the options with the setting on:

```text
[env var] ForwardedHeaders=XForwardedFor, XForwardedProto ForwardLimit=1 KnownIPNetworks=0 KnownProxies=0
```

With empty lists the middleware skips the trust check entirely, so it fixes the Docker case in one line. Two consequences:

- `ForwardLimit` is still 1, so behind Cloudflare plus nginx you get the Cloudflare edge IP (the same result as scenario 4).
- Any client that can reach the container port directly can set `X-Forwarded-For` to whatever it likes. That is acceptable only when the port is not published outside the proxy's network.

Calling `app.UseForwardedHeaders()` yourself on top of the environment variable registers the middleware twice. With trust-all options, running the same request through it twice consumed both entries and produced `RemoteIpAddress=203.0.113.7`. That happens to look correct here, but it is an accident of double registration, not configuration. Pick one mechanism.

## Gotchas that produce the same symptom

**`X-Forwarded-Proto` has fewer entries than `X-Forwarded-For`.** nginx's `$proxy_add_x_forwarded_for` appends to the incoming header, while `proxy_set_header X-Forwarded-Proto $scheme` overwrites it, so behind Cloudflare you get two `For` entries and one `Proto`. The middleware tolerates this by default (scenario 6 still ends with `https`). Turn on `RequireHeaderSymmetry` and the same request is rejected outright:

```text
warn: Microsoft.AspNetCore.HttpOverrides.ForwardedHeadersMiddleware[1] Parameter count mismatch between X-Forwarded-For and X-Forwarded-Proto.
[8 RequireHeaderSymmetry, limit 2] RemoteIp=::ffff:172.18.0.1 Scheme=http XFF='203.0.113.7, 162.158.116.145' X-Original-For=''
```

**Middleware order.** Anything that reads `Scheme` or the client IP before `UseForwardedHeaders()` sees the proxy's values. `UseHttpsRedirection()` placed earlier produces an infinite redirect loop behind a TLS-terminating proxy; rate limiting partitioned by IP placed earlier puts every request into one partition. The [per-endpoint rate limiting guide](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) lists that pitfall from the other side, and the [endpoint filters vs middleware](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) comparison covers why ordering matters for anything that rewrites the request.

**An `async` lambda passed to `Configure<ForwardedHeadersOptions>`.** The Stack Overflow code used `Configure<ForwardedHeadersOptions>(async options => ...)`. `Configure` takes an `Action<T>`, so that lambda compiles to `async void`. It worked there only because nothing inside was awaited. Fetch the Cloudflare list before `Build()`, as the asker did, and keep the options callback synchronous; an `await` inside it would let the options be read before the ranges are added.

**Single-header alternatives.** Cloudflare also sends the visitor IP in `CF-Connecting-IP` ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). Setting `ForwardedForHeaderName = "CF-Connecting-IP"` with `ForwardLimit = 1` and only the Docker network trusted gets the client address in one hop, but anyone who reaches nginx without going through Cloudflare can set that header themselves. Locking nginx to Cloudflare's ranges (or using nginx's `real_ip` module with `set_real_ip_from`) closes that hole; trusting the ranges in the app, as in step 3, does the same check one layer later.

**Logs that show the wrong IP.** If request logging runs before the middleware, or a structured logging setup captures `RemoteIpAddress` early, the logs will keep showing `172.18.0.1` after the fix. With Serilog, the request logging middleware belongs after `UseForwardedHeaders()`; the [Serilog and Seq setup guide](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) shows the pipeline position.

## Related

- [How to publish a .NET 11 app as a container image with PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) sets `ASPNETCORE_FORWARDEDHEADERS_ENABLED` as a container environment variable; read the section above before copying that line behind a multi-hop proxy.
- [Aspire vs Docker Compose for local multi-service development](/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/) for how Compose networks are laid out in the first place.
- [How to add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) for partitioning by the client IP this post recovers.

## Sources

- [Configure ASP.NET Core to work with proxy servers and load balancers](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/proxy-load-balancer?view=aspnetcore-10.0) on Microsoft Learn.
- [Breaking change: IPNetwork and ForwardedHeadersOptions.KnownNetworks are obsolete](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/ipnetwork-knownnetworks-obsolete?view=aspnetcore-10.0) (ASPDEPR005).
- [`ForwardedHeadersMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Middleware/HttpOverrides/src/ForwardedHeadersMiddleware.cs), [`ForwardedHeadersOptions.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Middleware/HttpOverrides/src/ForwardedHeadersOptions.cs) and [`ForwardedHeadersOptionsSetup.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/DefaultBuilder/src/ForwardedHeadersOptionsSetup.cs) on the `release/10.0` branch.
- [dotnet/aspnetcore#63658](https://github.com/dotnet/aspnetcore/pull/63658), which keeps `KnownNetworks` and `KnownIPNetworks` in sync.
- [nginx `$proxy_add_x_forwarded_for`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#var_proxy_add_x_forwarded_for) documentation.
- The original question: [Forwarded headers are not being picked up by ASP.NET Core](https://stackoverflow.com/questions/79942487).
