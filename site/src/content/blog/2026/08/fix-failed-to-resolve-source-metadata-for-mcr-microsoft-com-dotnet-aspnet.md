---
title: "Fix: failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet"
description: "BuildKit cannot read the manifest for your base image. Check the tag exists, repair the Docker credential helper, open both MCR endpoints, then pre-pull for offline builds."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "buildkit"
  - "dotnet-11"
---

This is BuildKit failing to read the image manifest for your `FROM` line, and it happens before a single instruction in your Dockerfile runs. Four causes cover almost every occurrence, in this order: the tag does not exist (`11.0` is not a real tag while .NET 11 is still in preview), a broken credential helper in `~/.docker/config.json`, a proxy or firewall that blocks `mcr.microsoft.com` or `*.data.mcr.microsoft.com`, or an offline build with a builder that cannot see your locally pulled images. Run `docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:10.0` first. If that fails too, your Dockerfile is not the problem.

```text
 => ERROR [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0
------
 > [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0:
------
failed to solve: failed to resolve source metadata for
mcr.microsoft.com/dotnet/aspnet:11.0: mcr.microsoft.com/dotnet/aspnet:11.0: not found
```

Everything below is verified against Docker Engine 29 (BuildKit v0.32.x, Buildx v0.32), .NET 10 (`10.0`, released 11 November 2025), and the .NET 11 previews, which are at Preview 7 as of August 2026 with GA scheduled for November 2026. The same mechanism applies unchanged to Engine 27 and 28, and to Podman's BuildKit-compatible frontend. Only the exact wording of the trailing clause moves between versions.

## What BuildKit is doing when it says "resolve source metadata"

BuildKit does not execute your Dockerfile top to bottom the way the classic builder did. It first builds a dependency graph, and to do that it has to know what every `FROM` reference actually is. That means one `HEAD https://mcr.microsoft.com/v2/dotnet/aspnet/manifests/<tag>` request per base image, per build, so it can pin the reference to a content digest before planning anything. That request is the "load metadata" step you see in the build output, and the message you got is that step failing.

Three consequences fall out of this, and they explain most of the confusion around the error:

- **It fires even when every layer is already cached.** Cached layers do not answer the question "is this tag still the same digest", so BuildKit asks anyway. This is why an offline build fails on a machine that built the exact same image an hour earlier.
- **It fires before `RUN`, `COPY`, and `WORKDIR`.** No build argument that affects the build environment can help, because nothing in the build environment has started yet. In particular `--build-arg HTTP_PROXY=...` does nothing here. That build argument is injected into `RUN` steps; it does not configure the BuildKit daemon's own registry client.
- **The trailing clause after the last colon is the real error.** `not found` means the tag does not exist. `dial tcp ...: i/o timeout` means the network. `error getting credentials` means your Docker config. Read that clause first and skip straight to the matching section below.

Everything else in the message is BuildKit wrapping. The failing verb is always the same.

## The minimal repro

Two stages, a build image and a runtime image, which is the shape the .NET container templates generate:

```dockerfile
# Docker Engine 29, BuildKit v0.32. Fails at "load metadata".
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`docker build .` fails immediately with the error above and never reaches `dotnet publish`. Note that there is no application code involved at all. An empty directory with just this Dockerfile reproduces it, which is the fastest way to prove the problem is not your project.

## Fix 1: check that the tag actually exists

This is the single most common cause right now, and .NET 11 is the reason. Microsoft does not publish a floating major-version tag for a release until it reaches GA. During the preview window the tags are `11.0-preview` and the pinned `11.0.0-preview.7`, plus OS-qualified variants like `11.0-preview-resolute` and `11.0-preview-alpine`. There is no `11.0`. That tag appears in November 2026 and not before, so a Dockerfile copied from a .NET 10 project and bumped by hand fails on a name that has never existed.

Ask the registry directly instead of guessing:

```bash
# Works against any registry, prints the manifest list and its platforms.
docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:11.0-preview
```

MCR also serves the anonymous OCI tag listing, which is useful when you want to see what is actually published:

```bash
curl -s https://mcr.microsoft.com/v2/dotnet/aspnet/tags/list | jq '.tags[] | select(startswith("11.0"))'
```

Two other tag mistakes produce the identical error. The first is the repository rename: .NET Core 3.1 and earlier lived under `mcr.microsoft.com/dotnet/core/aspnet`, and everything from .NET 5 onward lives under `mcr.microsoft.com/dotnet/aspnet`. An old Dockerfile carried forward keeps the `core/` segment and gets `not found` for any modern version. The second is picking an OS variant that was retired, such as a `bullseye-slim` tag on a .NET version whose Debian base has moved on. The [.NET container image tag documentation](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md) is the authority for which variants are live, and it is worth reading whenever you change base images rather than trusting an old blog post. If you are choosing between OS variants, the tradeoffs in [the resolute container tags for .NET 10](/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) apply to the .NET 11 previews too.

## Fix 2: repair the Docker credential helper

If the trailing clause reads like this, the registry is fine and your local Docker config is broken:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0:
error getting credentials - err: exit status 1, out: ``
```

The Docker CLI reads `~/.docker/config.json`, sees a `credsStore` or `credHelpers` entry, and shells out to a `docker-credential-<name>` binary to fetch credentials for the registry. When that binary is missing from `PATH` or cannot reach a keychain, the CLI aborts before it ever contacts MCR. The classic trigger is `"credsStore": "desktop"` in a config file shared with a WSL2 distro, a CI container, or a remote SSH session where `docker-credential-desktop` does not exist.

MCR serves its public images anonymously, so you do not need credentials for it at all. Delete the entry:

```json
{
  "auths": {},
  "credsStore": ""
}
```

Or remove the `credsStore` key entirely. On macOS the working value is `osxkeychain`, on Linux `pass` or `secretservice`, and if a helper is genuinely installed, confirm it responds:

```bash
echo '{"ServerURL":"https://index.docker.io/v1/"}' | docker-credential-desktop get
```

A related variant surfaces as `401 Unauthorized` on a HEAD request to MCR. That means stale credentials are being sent for an anonymous registry. Clear them with `docker logout mcr.microsoft.com` and rebuild.

## Fix 3: open both MCR endpoints and configure the builder's proxy

Microsoft Artifact Registry splits its work across two hostnames, and firewall rules written against only the first one fail in a way that looks random. `mcr.microsoft.com` handles content discovery, meaning the manifest and tag requests. `*.data.mcr.microsoft.com` is the Azure Front Door CDN that serves the actual layer bytes. Microsoft's [client firewall rules](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md) require both over HTTPS on 443, and explicitly warn against region-specific rules because the data endpoint's regions change for performance reasons. If you allow only the registry endpoint, metadata resolution succeeds and the pull dies later. If you allow neither, you get the error in this post.

Proxy configuration is where most of the wasted time goes, because it depends on which builder driver you are using and the two behave differently:

- **The default `docker` driver** runs BuildKit inside the Docker daemon, so it inherits the daemon's proxy settings. On Docker Desktop that is Settings, Resources, Proxies. On Linux it is a systemd drop-in at `/etc/systemd/system/docker.service.d/http-proxy.conf` followed by `systemctl daemon-reload && systemctl restart docker`.
- **The `docker-container` driver** created by `docker buildx create` runs BuildKit in its own container, which inherits nothing. You have to pass the environment explicitly:

```bash
# Buildx v0.32. env.<key> sets variables inside the BuildKit container.
docker buildx create --name proxied \
  --driver docker-container \
  --driver-opt env.HTTP_PROXY=http://proxy.corp:8080 \
  --driver-opt env.HTTPS_PROXY=http://proxy.corp:8080 \
  --driver-opt env.NO_PROXY=localhost,127.0.0.1 \
  --use
```

If your proxy terminates TLS with a corporate certificate authority, the trailing clause is `tls: failed to verify certificate: x509: certificate signed by unknown authority`. The daemon-side fix is to install the CA into the host trust store and restart Docker. For a `docker-container` builder you have to get the CA into that container, either by mounting it through a custom `buildkitd.toml` or by building on the default driver instead.

Plain DNS failures show up as `dial tcp: lookup mcr.microsoft.com: no such host`, which is common on WSL2 after a VPN change. Setting explicit resolvers in `/etc/docker/daemon.json` with `"dns": ["1.1.1.1", "8.8.8.8"]` and restarting the daemon usually clears it.

## Fix 4: pre-pull for offline builds, and mind the builder driver

Because metadata resolution always wants a live registry, an air-gapped or flaky-network build fails even when the layers are on disk. The fix is to make the image present in the local image store, not merely cached:

```bash
# Run these while you still have connectivity.
docker pull mcr.microsoft.com/dotnet/sdk:10.0
docker pull mcr.microsoft.com/dotnet/aspnet:10.0
```

With the default `docker` driver, BuildKit can then resolve the reference from the daemon's image store and the offline build succeeds. Adding `--pull=false` makes the intent explicit and stops BuildKit from preferring a remote lookup.

The catch is that this only works on the default driver. A `docker-container` builder has its own content store and cannot see images in the Docker daemon, which is [a long-standing and frequently rediscovered behaviour](https://github.com/moby/moby/issues/49542). If you created a custom builder for multi-platform output and then went offline, pre-pulling does nothing for you. Switch back with `docker buildx use default` for offline work, or run a registry mirror the builder can reach.

The same distinction bites in CI. GitHub Actions runners using `docker/setup-buildx-action` get a `docker-container` builder by default, so a workflow that works locally after a `docker pull` step will still hit the registry on the runner.

## Fix 5: match the platform

If the tag exists but has no image for your target platform, the failure arrives at the same step with a different tail:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0-nanoserver-ltsc2022:
no match for platform in manifest: not found
```

Two common shapes. The first is a Windows-only tag such as `nanoserver` or `windowsservercore` requested from a daemon running Linux containers. Switch Docker Desktop to Windows containers, or use a Linux tag. The second is an explicit `--platform linux/arm64` against a tag that ships amd64 only, which happens with third-party sidecar images more often than with Microsoft's, since the .NET runtime images publish amd64, arm64, and arm32v7. `docker buildx imagetools inspect` lists every platform in the manifest list, so check there before assuming the image is broken.

## Variants that look the same but are not

`failed to solve: process "/bin/sh -c dotnet restore" did not complete successfully` is a different failure entirely. Metadata resolution succeeded and your build is now running, so the problem is NuGet, not the registry. Likewise, `NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json` inside a build stage means the container can reach MCR but not NuGet, which is usually the same proxy story one layer down.

If the image pulls and starts but the container immediately exits, you are past this error and into runtime territory. The globalization crash covered in [the missing ICU package fix](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) is the most common one on slim base images.

Finally, if you find yourself fighting the `FROM` lines at all, consider whether you need a Dockerfile. The SDK can produce an OCI image directly, and [publishing a .NET 11 app with `/t:PublishContainer`](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) resolves base images through NuGet-style logic that fails with far more specific messages than BuildKit's.

## Related

- [How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [.NET 10 on Ubuntu 26.04: resolute container tags and Native AOT in the archive](/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [Fix: Couldn't find a valid ICU package installed on the system in a .NET container](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)
- [SBOM for .NET in Docker: stop trying to force one tool to see everything](/2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything/)
- [Aspire vs Docker Compose for local multi-service development](/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/)

## Sources

- [Microsoft Artifact Registry client firewall rules](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md)
- [Microsoft Artifact Registry endpoints guidance](https://github.com/microsoft/containerregistry/blob/main/docs/mcr-endpoints-guidance.md)
- [dotnet/dotnet-docker: ASP.NET Core runtime supported tags](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md)
- [Docker docs: docker-container build driver options](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Docker docs: build variables and proxy build arguments](https://docs.docker.com/build/building/variables/)
- [moby/moby#49542: BuildKit with the docker-container driver refuses to use local images](https://github.com/moby/moby/issues/49542)
- [dotnet/core#8268: docker-compose build fails to pull images from mcr.microsoft.com](https://github.com/dotnet/core/issues/8268)
