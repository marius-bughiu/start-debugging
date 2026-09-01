---
title: "Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image"
description: "Framework-dependent on a chiseled aspnet image is the right default for an ASP.NET Core service on .NET 11, because the runtime layer is shared across services and a runtime CVE is fixed by a base image bump. Self-contained trimmed and Native AOT buy a 2x to 5x smaller image and a much faster cold start, and cost you that. Real published sizes, the layer-sharing math, and the .NET 11 base image inference bug that breaks the AOT path."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "containers"
  - "docker"
  - "native-aot"
  - "deployment"
---

For an ordinary long-running ASP.NET Core service on .NET 11, publish **framework-dependent onto a chiseled `aspnet` image**. It is the smallest thing you actually ship (a few megabytes of app on top of a runtime layer your other services already pulled), and a runtime CVE is fixed by rebuilding on a new base image tag rather than by rebuilding, retesting, and redeploying the app. Switch to **self-contained plus trimming** when the app must pin a specific runtime patch or run on a base image with no .NET at all. Reach for **Native AOT** only when cold start or per-pod memory is the dominating constraint and `dotnet publish` reports zero AOT warnings across your whole dependency tree. The size numbers people quote for AOT are real, but for a fleet they measure the wrong thing: framework-dependent images share one runtime layer across every service on a node, and self-contained and AOT images do not.

Everything here targets `<TargetFramework>net11.0</TargetFramework>`. .NET 11 is at Preview 7 (`11.0.100-preview.7.26381.103`, released August 11, 2026) as I write this, with [GA expected in November 2026](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview). Preview image tags carry a `-preview` qualifier that GA drops, so `11.0-preview-resolute-chiseled` today becomes `11.0-resolute-chiseled` in November. The mechanics below have been stable since .NET 8, so almost all of it applies unchanged on .NET 9 and .NET 10.

## The three modes as container images

| Property | Framework-dependent | Self-contained + trimmed | Native AOT |
| --- | --- | --- | --- |
| Base image repository | `dotnet/aspnet` or `dotnet/runtime` | `dotnet/runtime-deps` | `dotnet/runtime-deps` |
| Runtime lives in | the base image layer | your app layer | compiled into the binary |
| Runtime layer shared across services | Yes | No | No |
| Runtime CVE fixed by | pulling a new base tag, rebuild | new SDK, rebuild, retest, redeploy | new SDK, rebuild, retest, redeploy |
| Rolls forward to installed patch | Yes | No | No |
| Enabled by | nothing (the default) | `--self-contained -p:PublishTrimmed=true` | `-p:PublishAot=true` |
| Needs a RID | No | Yes | Yes |
| Build host needs a C toolchain | No | No | Yes (clang, zlib1g-dev) |
| Reflection, `Reflection.Emit`, plugin loading | Full | Trim warnings, runtime failures possible | Restricted or unavailable |
| Sample image, compressed | 52.81 MB | 21.86 MB | 11.60 MB |

Those last three numbers are from the [.NET container image size report](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md) in `dotnet/dotnet-docker`, measured on the `releasesapi` sample against .NET 10.0 with `noble-chiseled` base images. Full details in a moment, because that row is the one that misleads people.

## What each mode actually puts in the image

The SDK's container tooling infers the base image from your project, and the rule is short. [Per the containerization reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), a self-contained project gets `mcr.microsoft.com/dotnet/runtime-deps`, an ASP.NET Core project gets `mcr.microsoft.com/dotnet/aspnet`, and anything else gets `mcr.microsoft.com/dotnet/runtime`. The tag is the numeric part of your TFM, with `ContainerFamily` appended as a suffix.

That inference is the whole story:

- **Framework-dependent** lands on `aspnet`, which is `runtime-deps` plus the .NET runtime plus the ASP.NET Core shared framework. Your layer holds IL assemblies and static assets, typically single-digit megabytes.
- **Self-contained** lands on `runtime-deps`, which contains only the native libraries .NET needs (libc, OpenSSL, and friends) and no .NET at all. Your layer carries the whole runtime and shared framework, which is why trimming matters so much here.
- **Native AOT** also lands on `runtime-deps`, but your layer is one native executable with no IL and no JIT. Note that the `-aot` suffix on `runtime-deps` is gone: it existed for .NET 8, and in .NET 10 the AOT-specific runtime-deps tags were folded into the plain `-chiseled` tags. The `-aot` suffix now lives on the **SDK** images instead (`sdk:11.0-preview-aot`, `sdk:11.0-preview-resolute-aot`), which bundle the clang and zlib toolchain the AOT compiler needs at build time.

All three inherit the same hardening from the Microsoft images: the rootless `app` user at UID 1654, exposed through `$APP_UID`, and port 8080 rather than 80, both of which [landed in .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers). Chiseled images additionally ship no shell, no package manager, and no `curl`, so `docker exec` debugging and shell-based health checks do not work in any of the three modes if you pick a chiseled family.

## Publishing each of the three

Framework-dependent, no RID needed, straight to a chiseled ASP.NET Core base:

```bash
# .NET 11 SDK 11.0.100-preview.7. Framework-dependent onto aspnet:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Self-contained with trimming. `PublishTrimmed` implies `SelfContained`, but spell both out so a future reader does not have to remember that:

```bash
# .NET 11 SDK 11.0.100-preview.7. Self-contained + trimmed onto runtime-deps:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  --self-contained \
  -p PublishTrimmed=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Native AOT. `PublishAot` implies self-contained, and needs the platform C toolchain on the build machine:

```bash
# .NET 11 SDK 11.0.100-preview.7. Native AOT onto runtime-deps:11.0-preview-resolute-chiseled.
# Requires clang and zlib1g-dev locally, or build inside sdk:11.0-preview-aot.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

If you would rather do this from CI without installing clang on the agent, the SDK AOT image is the reason those tags exist:

```dockerfile
# .NET 11 preview. Multi-stage AOT build.
FROM mcr.microsoft.com/dotnet/sdk:11.0-preview-resolute-aot AS build
WORKDIR /src
COPY . .
RUN dotnet publish OrdersApi/OrdersApi.csproj -c Release -r linux-x64 -p:PublishAot=true -o /app

FROM mcr.microsoft.com/dotnet/runtime-deps:11.0-preview-resolute-chiseled
WORKDIR /app
COPY --from=build /app/OrdersApi .
USER $APP_UID
ENTRYPOINT ["./OrdersApi"]
```

For the full set of `Container*` properties, tag control, and registry authentication, see the walkthrough on [publishing a .NET 11 app as a container image without a Dockerfile](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/).

## The published size numbers

Microsoft publishes measured sizes for a sample minimal web API across every base image variant, so there is no need to hand-wave. These are the compressed sizes for the `releasesapi` sample on .NET 10.0:

| Base image | Framework-dependent | Self-contained + trimmed | Native AOT |
| --- | --- | --- | --- |
| Full Ubuntu (`10.0`) | 92.48 MB | 61.53 MB | 51.27 MB |
| `10.0-noble-chiseled` | 52.81 MB | 21.86 MB | 11.60 MB |
| `10.0-noble-chiseled-extra` | 67.68 MB | 36.82 MB | 26.56 MB |
| `10.0-alpine` | 51.93 MB | 20.95 MB | 10.69 MB |
| `10.0-alpine-extra` | 66.50 MB | 35.52 MB | 25.25 MB |

Two things fall out of that table immediately. First, **the base image family is a bigger lever than the deployment mode**. Moving a framework-dependent app from the full Ubuntu image to `noble-chiseled` saves 39.67 MB, which is more than switching that same app from framework-dependent to Native AOT on the full image saves (41.21 MB) and requires none of the compatibility work. If you have not chiseled yet, do that first and re-measure before you consider anything else.

Second, chiseled Native AOT really is roughly 4.5x smaller than chiseled framework-dependent. That is a genuine win, and for a scale-to-zero function or a very high-density node it is decisive.

## The layer-sharing math that flips the size argument

Here is the part the size report cannot show you, because it measures one image in isolation.

Container images are content-addressed layers. If ten of your services all build `FROM mcr.microsoft.com/dotnet/aspnet:11.0-preview-resolute-chiseled`, every node that runs them pulls and stores that runtime layer exactly once. The marginal cost of the eleventh service is its own app layer, which for a framework-dependent ASP.NET Core service is a few megabytes of IL.

Do the arithmetic for ten services on one node, using the chiseled column above:

- **Framework-dependent**: about 50 MB of shared `aspnet` layers, plus 10 app layers of roughly 3 MB. Call it 80 MB.
- **Self-contained trimmed**: a shared `runtime-deps` layer of a few megabytes, plus 10 app layers that each carry their own trimmed copy of the runtime. Roughly 10 x 20 MB, so around 200 MB.
- **Native AOT**: same shape, 10 x 11 MB, so around 110 MB.

Self-contained is the worst of the three at fleet scale even though it beats framework-dependent 2.4x on a single image, because trimming is per-app and cannot dedupe across apps. Native AOT is small enough that it stays ahead, but its lead shrinks from 4.5x to well under 2x. Registry storage, cross-AZ pull bandwidth, and node disk pressure all follow this second calculation, not the first one. Measure your own fleet before you migrate anything on size grounds.

## Patching: who fixes a runtime CVE

This is the argument that should actually decide it for most teams, and it is the one the [publishing overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/) states plainly. A framework-dependent app "automatically rolls forward to the latest .NET security patch available on the environment," while a self-contained deployment "doesn't roll forward" and "the .NET Runtime can only be upgraded by releasing a new version of the app."

In container terms:

- **Framework-dependent**: when Microsoft ships an out-of-band runtime fix, you retag, rebuild, and redeploy. Your code is byte-identical, so the change is mechanically safe. A base-image-bump automation (Dependabot, Renovate) can do this without a human, and one PR per repository covers it.
- **Self-contained and Native AOT**: the runtime is inside your app layer, so the fix requires a new SDK on the build agent, a full rebuild, and a full test pass, per service. For AOT specifically it also means recompiling native code, which is the slowest build you own.

If your organization has a "patch critical CVEs within N days" control, that difference is not a footnote. It is the reason to stay framework-dependent unless something forces you off it.

## Globalization is the hidden switch between chiseled and chiseled-extra

Plain `-chiseled`, `-alpine`, and Azure Linux `-distroless` images ship without ICU and tzdata, so they only work for apps in globalization invariant mode. The `-extra` variants add ICU, tzdata, and `libstdc++` back, which is what those 15 MB deltas in the size table are.

For self-contained and AOT publishes the SDK tries to help: if `InvariantGlobalization` is false it steers you to an `-extra` variant. For framework-dependent publishes you choose the family yourself, so it is on you to set the property to match:

```xml
<!-- .NET 11, net11.0. Required if you target a plain -chiseled or -alpine base. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Get this wrong and the container dies at startup with `Couldn't find a valid ICU package installed on the system`, which has [its own fix post](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/). And invariant mode is not free: culture-sensitive string comparison, `ToUpper` and `ToLower` for non-ASCII, and `TimeZoneInfo` lookups all change behaviour. If you localize anything or format currency, pay the 15 MB for `-extra`.

## The .NET 11 gotcha: base image inference still says noble

The container tooling computes the Ubuntu codename for the inferred tag from the SDK version, and as of the .NET 11 previews that lookup only knows `jammy` (SDK below 8.0.300) and `noble` (8.0.300 and above). Since `11.0.100` satisfies the second condition it returns `noble`, but .NET 11 images on MCR are published under `resolute` (Ubuntu 26.04). The result, [reported as dotnet/sdk#53553](https://github.com/dotnet/sdk/issues/53553):

```console
error CONTAINER1015: Unable to access the repository 'dotnet/runtime-deps' at tag '11.0.0-preview.2-noble-chiseled-extra'
```

The blast radius is exactly the paths this post is about. Framework-dependent publishing is fine, because it does not go down the codename-inference branch. Trimmed self-contained and `PublishAot=true` publishes both hit it. The fix is to stop relying on inference and name the family explicitly, which is why every command above passes it:

```bash
# .NET 11 SDK 11.0.100-preview.7. Explicit family, no codename inference.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled
```

Setting `ContainerBaseImage` to a fully qualified name works too and bypasses `ContainerFamily` entirely. Pinning the family explicitly is good practice regardless: it is what stops a future SDK from silently moving your fleet to a different distro. The [Ubuntu 26.04 tag rotation](/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) is the same lesson from the .NET 10 side.

## The constraint that picks for you

Most teams never get to weigh sizes, because one hard constraint decides it:

- **Reflection-heavy dependencies.** Dynamic proxies, reflection-based serializers, runtime-emitted DI containers, plugin loading. Native AOT is off the table and trimming is risky. Treat the publish warnings as the go/no-go signal, not the docs. [Trim-safe code](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) is the prerequisite for both.
- **A compliance clock on CVE remediation.** Framework-dependent, because a base image bump is a mechanical change and a rebuild is not.
- **Scale-to-zero or per-request billing.** Cold start dominates the bill. Native AOT starts roughly 3x faster than plain JIT and uses less than half the working set, per the measurements in [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **One build artifact for several platforms.** Framework-dependent without a RID is the only mode that produces one artifact; the other two are per-RID and need a build matrix.
- **A base image with no .NET, that you do not control.** Self-contained, since it is the only mode that runs on an arbitrary distro image with the right native libraries and nothing else.

## Recommendation, restated

Default to **framework-dependent on `aspnet:11.0-<family>-chiseled`**. It is the cheapest image at fleet scale, it is the only mode where a runtime CVE is a base image bump instead of a release, and it is the only one that ships a single RID-agnostic artifact. Move to **Native AOT on `runtime-deps:11.0-<family>-chiseled`** when cold start or memory density is the binding constraint and your dependency tree publishes clean. Use **self-contained plus trimming** as the middle option when you need runtime version pinning or a non-.NET base image, understanding that it is the worst of the three for fleet-wide storage. Whichever you pick, set `ContainerFamily` explicitly, and chiseled the image before you optimize anything else.

## Related

- [How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) covers the full `Container*` property surface these commands rely on.
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) is the compilation-model comparison sitting underneath this packaging one, with startup and throughput measurements.
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) enumerates the API and library restrictions before you commit.
- [What is trim-safe code and how do I write it?](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) is the prerequisite for both trimmed self-contained and AOT.
- [What is the difference between dotnet build and dotnet publish?](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) explains why all of this is publish-time only.

## Sources

- [.NET application publishing overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/), MS Learn (framework-dependent vs self-contained tradeoffs, roll-forward, AOT).
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), MS Learn (`ContainerBaseImage` inference, `ContainerFamily`, `ContainerUser`).
- [.NET container images](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images), MS Learn (repositories, chiseled and extra variants, globalization).
- [Sample image size report](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md), `dotnet/dotnet-docker` (measured sizes for the `releasesapi` sample).
- [Container base image inference uses wrong Ubuntu codename for .NET 11](https://github.com/dotnet/sdk/issues/53553), `dotnet/sdk` (CONTAINER1015, `ContainerFamily` workaround).
- [What's new in containers for .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers), MS Learn (rootless `app` user, `APP_UID`, port 8080).
- [What's new in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), MS Learn (preview status, GA timing, SDK container changes).
