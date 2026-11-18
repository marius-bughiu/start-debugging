---
title: "Fix: exec /usr/bin/dotnet: exec format error when a .NET container runs on Kubernetes"
description: "The image is arm64 (built on an Apple Silicon Mac) but the node is amd64. Rebuild with buildx --platform linux/amd64 or dotnet publish -r linux-x64, or go multi-arch."
pubDate: 2026-11-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "kubernetes"
---

`exec /usr/bin/dotnet: exec format error` means the container image's CPU architecture does not match the node's. The usual cause is an image built on an Apple Silicon Mac, which is `linux/arm64` by default, running on an `amd64` Kubernetes node. Rebuild for the node's platform: `docker buildx build --platform linux/amd64`, or with the .NET SDK, `dotnet publish -t:PublishContainer -r linux-x64`. Better still, publish a multi-arch image (`linux/amd64,linux/arm64`) so every node pulls the variant that matches it. The repro below uses .NET SDK 11.0.100 on an arm64 Mac (macOS, Darwin 27.0.0). The same rules apply to .NET 8, 9 and 10 images.

## The error in context

The pod starts, crashes immediately, and goes into `CrashLoopBackOff`. `kubectl describe pod` shows only `Back-off restarting failed container`. The real message is in the container log:

```text
$ kubectl logs notification-svc-766875d4bb-s8fng -n dev
exec /usr/bin/dotnet: exec format error
```

When the image's entrypoint is the app's own native launcher (the apphost, which recent `dotnet-docker` samples use) instead of `dotnet app.dll`, the path in the message changes, but it is the same failure:

```text
exec ./MyApp: exec format error
```

The message comes from the container runtime. It called `execve()` on the entrypoint binary, and the kernel refused with `ENOEXEC` because the ELF file targets a different CPU. Nothing in .NET has run yet, so you will not find a .NET stack trace, a crash dump, or any of your own log output.

## Why this happens

A Linux container shares the node's kernel and runs the image's binaries directly on the node's CPU. An `arm64` binary cannot run on an `amd64` CPU, and the reverse is also true. Three things make the mismatch easy to create:

- **Docker builds for the machine it runs on.** The `dotnet-docker` guidance says it plainly: on a Mac with Apple Silicon, `docker build` "will produce a `linux/arm64` image". The `mcr.microsoft.com/dotnet/aspnet` tags are multi-platform, so the `FROM` line silently resolves to the arm64 variant.
- **Your app DLL has no architecture, but the base image does.** A framework-dependent app compiles to IL, so `MyApp.dll` is the same file on any CPU. The architecture-specific part is the runtime layer underneath it, starting with `/usr/bin/dotnet`. That is why the error names `dotnet` and not your app.
- **It works locally.** Docker Desktop on the Mac runs the arm64 image natively, and so does its built-in Kubernetes. The mismatch only shows up when the image reaches an amd64 cluster such as AKS, EKS or GKE on x86 nodes.

The reverse case gives the same error. An image built on an `ubuntu-latest` GitHub Actions runner is `amd64`, and if it is scheduled onto an arm64 node pool (Azure Cobalt or Ampere, AWS Graviton, GCP Axion), you get the identical message.

## Minimal repro

There was no Docker daemon on the test machine, so this repro uses the SDK's built-in container publishing. It needs no daemon and can write the image to a tarball. A one-file web app that reports its own architecture:

```csharp
// .NET SDK 11.0.100, net11.0, Program.cs (dotnet new web)
using System.Runtime.InteropServices;

var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/", () => $"{RuntimeInformation.ProcessArchitecture} on {RuntimeInformation.OSDescription}");
app.Run();
```

Publish it as an image archive with no runtime identifier, on an arm64 Mac:

```bash
# .NET SDK 11.0.100 on macOS arm64, no Docker installed
dotnet publish -t:PublishContainer -p:ContainerArchiveOutputPath=./out/default.tar.gz
```

```text
Building image 'archdemo' with tags 'latest' on top of base image 'mcr.microsoft.com/dotnet/aspnet:11.0'.
Pushed image 'archdemo:latest' to local archive at '.../out/default.tar.gz'.
```

Unpack the archive and read the image config. It records `"os": "linux"`, `"architecture": "arm64"` and `"Entrypoint": ["dotnet", "/app/ArchDemo.dll"]`. The SDK chose the arm64 variant of `aspnet:11.0` because the host is arm64. In the layers, `/usr/bin/dotnet` is a symlink to `/usr/share/dotnet/dotnet`, and that file is:

```text
$ file usr/share/dotnet/dotnet
usr/share/dotnet/dotnet: ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, for GNU/Linux 3.7.0, stripped
```

This is the binary an amd64 node is asked to run. Running a foreign binary on the Mac itself shows the same kernel refusal (`ENOEXEC`) the node reports:

```text
$ ./usr/share/dotnet/dotnet --info
zsh:1: exec format error: ./usr/share/dotnet/dotnet
```

(On macOS the refusal is about the file format, Linux ELF versus Mach-O. On the node it is about the CPU, aarch64 versus x86-64. The errno and the message are the same.)

## Confirm the mismatch before changing anything

Check two facts: the node's architecture and the image's architecture.

```bash
# Node architecture (well-known label set by the kubelet)
kubectl get nodes -L kubernetes.io/arch

# Architecture of a local image
docker image inspect myapp:latest --format '{{.Os}}/{{.Architecture}}'

# Platforms published under a remote tag (single image or multi-arch index)
docker buildx imagetools inspect ghcr.io/you/myapp:1.4.2
```

These three commands were not run for this post because there was no Docker or cluster on the test machine. They are the standard commands for these checks. If the node says `amd64` and the image says `linux/arm64` (or the reverse), you have found the cause. If both say the same architecture, see the variants section: you are most likely running a different image than you think.

## Fix 1: build the right platform with Docker buildx

If you build with a Dockerfile, use the cross-compiling pattern from Microsoft's own samples. The SDK stage always runs natively on the build machine, and only the final stage takes the target platform:

```dockerfile
# .NET 11, pattern from dotnet/dotnet-docker samples
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0 AS build
ARG TARGETARCH
WORKDIR /source

COPY *.csproj .
RUN dotnet restore -a $TARGETARCH

COPY . .
RUN dotnet publish -a $TARGETARCH --no-restore -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
USER $APP_UID
ENTRYPOINT ["./MyApp"]
```

Then build for the node's platform, or for both:

```bash
# From an Apple Silicon Mac, for amd64 nodes
docker buildx build --platform linux/amd64 -t ghcr.io/you/myapp:1.4.3 --push .

# One tag, both architectures; each node pulls its own variant
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/you/myapp:1.4.3 --push .
```

`$BUILDPLATFORM`, `$TARGETPLATFORM` and `$TARGETARCH` are BuildKit's automatic build args. `TARGETARCH` is in Docker's spelling (`amd64`, `arm64`), and `dotnet publish -a` accepts that spelling. With SDK 11.0.100, `dotnet publish --os linux -a amd64` produced output under `linux-x64/`, and its apphost was `ELF 64-bit LSB pie executable, x86-64`. Because the SDK cross-compiles, nothing in this Dockerfile runs under emulation, so the build is as fast as a native one. This post did not benchmark emulated builds.

In GitHub Actions, the same switch is the `platforms` input of `docker/build-push-action`. Multi-platform builds there also need `docker/setup-buildx-action` (and `docker/setup-qemu-action` if any `RUN` step executes for the foreign platform):

```yaml
# docker/build-push-action v6
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    context: .
    push: true
    platforms: linux/amd64,linux/arm64
    tags: ghcr.io/you/myapp:1.4.3
```

## Fix 2: publish the right platform with the .NET SDK

If you use `dotnet publish -t:PublishContainer` (no Dockerfile), the image architecture follows the runtime identifier. Each of these was run on the arm64 Mac with SDK 11.0.100, and the resulting image config was inspected:

```bash
# .NET SDK 11.0.100. Image config: linux/amd64
dotnet publish -t:PublishContainer -r linux-x64

# Same result; the -a value is applied to the OS you name
dotnet publish -t:PublishContainer --os linux -a x64

# Keep the build RID, override only the container platform. Image config: linux/amd64
dotnet publish -t:PublishContainer -p:ContainerRuntimeIdentifier=linux-x64
```

For a multi-arch image, list both RIDs in the project file:

```xml
<!-- .NET SDK 8.0.405+ / 9.0.102+ / 10 / 11 -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

With that in place, `dotnet publish -t:PublishContainer` logs one `Building image ... for runtime identifier` line per RID, then `Building image index`. The archive it wrote contained an OCI image index with two manifests, `linux/amd64` and `linux/arm64`, each with its own config. Two rules from the docs apply: `ContainerRuntimeIdentifiers` must be a subset of `RuntimeIdentifiers`, and a multi-architecture image is always written in OCI format. The Microsoft Learn page dates multi-RID container publishing to SDK 8.0.405, 9.0.102 and 9.0.2xx. On an older 8.0 SDK, update the SDK first.

## Fix 3: pin the workload to the architecture you shipped

This does not fix the image, but it turns a crash loop into a clear scheduling decision. If a cluster mixes node pools and you are deliberately shipping a single-arch image, pin the pod with the well-known label:

```yaml
# Kubernetes Deployment, pod spec fragment
spec:
  nodeSelector:
    kubernetes.io/arch: amd64
```

With a multi-arch image, leave this out and let each node pull its own variant.

## Gotchas and lookalikes

- **`-a x64` on its own fails on a Mac.** The OS part of the RID comes from the host, so `dotnet publish -t:PublishContainer -a x64` resolves to `osx-x64`. SDK 11.0.100 stops with `BaseImageNotFoundException: The RuntimeIdentifier 'osx-x64' is not supported by dotnet/aspnet:11.0. The supported RuntimeIdentifiers are linux-x64,linux-arm,linux-arm64`. Add `--os linux` or use `-r linux-x64`.
- **`--platform=$BUILDPLATFORM` on the final stage locks the image to the builder's architecture.** That flag belongs on the SDK stage only. If you also put it on the `aspnet` stage, the runtime layer always matches the machine that ran the build, whatever you pass to `--platform`. Do not "fix" this by removing it from the SDK stage. That makes the SDK run under QEMU emulation when cross-building, and the `dotnet-docker` docs state that .NET does not support running under QEMU.
- **`RUN` in the final stage runs under emulation.** When cross-building, any `RUN` after the last `FROM` runs as the target architecture. Use the final stage only to copy files. Never run `dotnet` there.
- **The tag is not what you think.** If the node and the image you inspected have the same architecture, the cluster is probably running an older push of a reused tag (`latest`, `fixed-2026-4`). Use a unique tag per build, or deploy by digest (`image@sha256:...`), and check `kubectl get pod -o jsonpath='{.status.containerStatuses[*].imageID}'` to see the digest that is actually running.
- **Self-contained and Native AOT images fail the same way, with a different path.** The entrypoint is your apphost or native binary instead of `dotnet`, so the message names your app. The fix is the same. Native AOT also needs a cross-compiling toolchain for the target architecture, which the regular SDK images do not include.
- **`exec format error` on a script entrypoint is a different bug.** If the entrypoint is a shell script that lacks a `#!/bin/sh` shebang, or has Windows CRLF line endings, the kernel also returns `ENOEXEC`. Check `head -1 entrypoint.sh` before you look at architectures.

## Related

- The SDK-native build path is covered end to end in [publishing a .NET 11 app as a container image with PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/).
- Whether the image should carry the shared runtime at all is weighed in [framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).
- If the build fails earlier, at the `FROM` line, see [failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet](/2026/08/fix-failed-to-resolve-source-metadata-for-mcr-microsoft-com-dotnet-aspnet/), which includes the `no match for platform in manifest` case.
- To make two builds of the same commit produce the same digest, see [reproducible container images with SOURCE_DATE_EPOCH in .NET 11](/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/).

## Sources

- [Building images for a specific platform](https://github.com/dotnet/dotnet-docker/blob/main/samples/build-for-a-platform.md), dotnet/dotnet-docker (the `$BUILDPLATFORM` pattern, the Apple Silicon default, .NET and QEMU).
- [AspNetCoreRazorApp sample Dockerfile](https://github.com/dotnet/dotnet-docker/blob/main/samples/AspNetCoreRazorApp/Dockerfile), dotnet/dotnet-docker.
- [Containerize a .NET app reference: ContainerRuntimeIdentifier(s), ContainerImageFormat](https://learn.microsoft.com/dotnet/core/containers/publish-configuration), Microsoft Learn.
- [Dockerfile reference: automatic platform ARGs](https://docs.docker.com/reference/dockerfile/#automatic-platform-args-in-the-global-scope) and [Multi-platform builds](https://docs.docker.com/build/building/multi-platform/), Docker docs.
- [Well-known labels: kubernetes.io/arch](https://kubernetes.io/docs/reference/labels-annotations-taints/#kubernetes-io-arch), Kubernetes docs.
- [k8 cluster ASP.NET Core 8 error exec /usr/bin/dotnet: exec format error](https://stackoverflow.com/questions/79870696), Stack Overflow.
