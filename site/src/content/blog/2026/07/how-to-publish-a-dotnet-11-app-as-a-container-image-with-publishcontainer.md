---
title: "How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer"
description: "A complete guide to building container images from a .NET 11 app with no Dockerfile: the PublishContainer target, ContainerRepository and ContainerImageTags, base image selection through ContainerBaseImage and ContainerFamily, pushing to a registry and how authentication resolves, multi-arch OCI image indexes, the non-root default user, entrypoint control, tarball output for scanners, and the cases where you still need a Dockerfile."
pubDate: 2026-07-27
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "containers"
  - "docker"
  - "devops"
  - "msbuild"
---

To turn a .NET 11 app into a container image without writing a Dockerfile, run `dotnet publish --os linux --arch x64 /t:PublishContainer` from the project directory. The SDK pulls the right Microsoft base image, layers your publish output on top, and pushes the result into your local Docker or Podman daemon. Add `-p ContainerRegistry=ghcr.io` to push to a real registry instead, or `-p ContainerArchiveOutputPath=./images/app.tar.gz` to get a tarball and touch no daemon at all. Everything a Dockerfile would express (base image, tags, ports, environment variables, labels, user, entrypoint) is an MSBuild property or item. This post targets .NET 11 (preview 6 at the time of writing, GA in November 2026) with C# 14 and the 11.0.1xx SDK. Nearly all of it also runs unchanged on the .NET 8, 9, and 10 SDKs, and I call out the version floors where they matter.

## What the SDK does instead of a Dockerfile

The mental model people usually arrive with is wrong in a useful way. `PublishContainer` is not a wrapper around `docker build`. There is no Dockerfile generated behind the scenes, and Docker is not involved in producing the image at all.

What actually happens is that the `Microsoft.NET.Build.Containers` targets, which ship inside the SDK, talk directly to the registry HTTP API:

1. Your app is published normally to `bin/Release/net11.0/<rid>/publish/`.
2. The SDK resolves a base image (by default one of the `mcr.microsoft.com/dotnet/*` repositories) and fetches its manifest and config from MCR. It does not download layer blobs it does not need.
3. Your publish folder is packed into a single new tar layer.
4. A new image config and manifest are assembled: base layers plus your layer, plus the entrypoint, working directory, exposed ports, environment variables, labels, and user.
5. The result is pushed somewhere. Local daemon by default, a remote registry if you set `ContainerRegistry`, or a `tar.gz` on disk if you set `ContainerArchiveOutputPath`.

Two consequences fall out immediately. First, you do not need a container runtime installed to *build* an image, only to *run* one locally, which makes this viable on CI agents with no Docker socket. Second, there is no `RUN` step, because no container is executed during the build. If your image needs `apt-get install`, you bake that into a custom base image and point `ContainerBaseImage` at it.

`/t:PublishContainer` is an MSBuild target, not a `dotnet publish` option, which is why it uses MSBuild syntax. The older `-p PublishProfile=DefaultContainer` form still works and does the same thing. If the distinction between `dotnet build` and `dotnet publish` is fuzzy, [the difference between dotnet build and dotnet publish](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) is worth five minutes, because everything here rides on the publish output.

## Steps to publish a .NET 11 app as a container image

1. Confirm you have the .NET 11 SDK (`dotnet --info`). Container publishing works from the .NET 7 SDK onward, but the defaults described here are .NET 8 SDK and later.
2. Set `ContainerRepository` in the project file if the assembly name is not a legal image name (uppercase letters are the usual offender).
3. Run `dotnet publish --os linux --arch x64 /t:PublishContainer` to build the image and load it into the local daemon.
4. Verify with `docker images` and run it: `docker run --rm -p 8080:8080 my-app:latest`.
5. Add `-p ContainerRegistry=<registry>` once the image is correct locally, after authenticating with `docker login <registry>`.
6. Move the settings you want permanently into the `.csproj` so CI and local runs agree.

That is the whole loop. The rest of this post is what each knob does and where the sharp edges are.

## Naming: registry, repository, tag

The image name the SDK produces is assembled from separate properties that map onto the parts of a fully qualified image reference:

```text
REGISTRY[:PORT]/REPOSITORY[:TAG]
```

- `ContainerRegistry` defaults to the local daemon. Set it to `ghcr.io`, `myorg.azurecr.io`, `docker.io`, `quay.io`, or a private `registry.mycorp.com:5000`.
- `ContainerRepository` defaults to the project's `AssemblyName`. Image names must be lowercase alphanumeric plus periods, underscores, dashes, and slashes, and must start with a letter or number. An assembly called `DotNet.ContainerImage` is not a legal repository name, which is why the Microsoft tutorial sets the property explicitly.
- `ContainerImageTag` defaults to `latest` on the .NET 8 SDK and later. Before that, the default was the project's `Version`.

```xml
<!-- .csproj, .NET 11 SDK 11.0.1xx -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <ContainerRegistry>ghcr.io</ContainerRegistry>
  <ContainerRepository>marius-bughiu/orders-api</ContainerRepository>
  <ContainerImageTags>1.4.2;latest</ContainerImageTags>
</PropertyGroup>
```

`ContainerImageTags` (plural, semicolon-delimited) produces one image per tag, which is the usual "version plus moving latest" release pattern. Tags are capped at 127 characters and must start with an alphanumeric or underscore.

The plural form is a genuine trap on the command line, because the semicolon is an MSBuild list separator and both PowerShell and Bash want a say in it. The quoting differs per shell:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  /p:ContainerImageTags='"1.4.2;latest"'
```

```powershell
dotnet publish --os linux --arch x64 /t:PublishContainer /p:ContainerImageTags=`"1.4.2`;latest`"
```

If that fight is not worth having in a CI script, set the environment variable `ContainerImageTags` instead. MSBuild reads environment variables as properties, and the shell never sees a semicolon it wants to interpret.

Note also that pushing to Docker Hub requires the username in the repository (`myuser/orders-api`), not just the bare image name.

## Choosing a base image without a FROM line

By default the SDK infers the base image from the project shape:

- ASP.NET Core projects get `mcr.microsoft.com/dotnet/aspnet`.
- Self-contained projects get `mcr.microsoft.com/dotnet/runtime-deps`, because the runtime ships inside your publish output.
- Everything else gets `mcr.microsoft.com/dotnet/runtime`.

The tag comes from the numeric part of your `TargetFramework`, so `net11.0` resolves to the `11.0` tag. Since SDK 8.0.200 the inference also reacts to how you publish: a `linux-musl-x64` or `linux-musl-arm64` RID selects the Alpine variants, and `PublishAot=true` selects a chiseled AOT variant of `runtime-deps`.

To pick a different *flavour* of the Microsoft image rather than a different image entirely, use `ContainerFamily`. The value is appended to the inferred tag:

```xml
<PropertyGroup>
  <ContainerFamily>alpine</ContainerFamily>
</PropertyGroup>
```

That turns the base image tag into `11.0-alpine`. The field is free-form and is simply concatenated, so check that the tag you are asking for actually exists in the `mcr.microsoft.com/dotnet/aspnet` (or `runtime`) repository before you commit to it. `ContainerFamily` is ignored entirely when `ContainerBaseImage` is set.

For full control, set `ContainerBaseImage` to a fully qualified name including the tag:

```xml
<PropertyGroup>
  <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:11.0-alpine</ContainerBaseImage>
</PropertyGroup>
```

This is also the escape hatch for the missing `RUN` support: build a base image once with a Dockerfile that installs whatever native package you need, push it, and point every service at it.

Windows containers need the same treatment. Since .NET 8, Microsoft's manifest lists no longer include Windows variants, so targeting Nano Server means naming the tag explicitly, for example `mcr.microsoft.com/dotnet/aspnet:11.0-nanoserver-ltsc2022`.

If you are combining this with Native AOT to get a genuinely small image, the trade-offs in [what Native AOT actually costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) apply unchanged inside a container, and the layer savings are usually smaller than the reflection restrictions cost you in library compatibility.

## Pushing to a registry, and how authentication resolves

Set `ContainerRegistry` and the SDK pushes over the Docker Registry HTTP API V2 instead of loading into a local daemon:

```bash
# .NET 11 SDK
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerRegistry=ghcr.io \
  -p ContainerRepository=marius-bughiu/orders-api
```

Credentials are resolved through Docker's own configuration, in this order of usefulness:

1. `~/.docker/config.json`, or the directory named by the `DOCKER_CONFIG` environment variable. The `auths` section (what `docker login` writes) is read directly.
2. `credHelpers` entries, which map a registry to a `docker-credential-<name>` executable on `PATH`. This is how ACR, ECR, and Google Artifact Registry hand out short-lived tokens.
3. `credsStore`, the OS keychain helper.

If none of that is available, for example inside an SDK container that has no Docker config mounted, there are two environment variables as a last resort:

```bash
export DOTNET_CONTAINER_REGISTRY_UNAME='<token>'
export DOTNET_CONTAINER_REGISTRY_PWORD="$GITHUB_TOKEN"
```

Two things to know about these. The prefix changed from `SDK_CONTAINER_*` to `DOTNET_CONTAINER_*` in SDK 8.0.400, and stale blog posts still show the old names. And they apply to *both* the source registry (MCR, where the base image comes from) and the destination, which makes them unsuitable when those need different credentials. Prefer `docker login`.

For a plain-HTTP registry on an internal network, SDK 9.0.1xx and later accepts a comma-separated allowlist:

```bash
export DOTNET_CONTAINER_INSECURE_REGISTRIES=localhost:5000,registry.mycorp.com
```

**New in .NET 11:** the SDK now validates the bearer-token `realm` a registry returns in its authentication challenge before following it ([dotnet/sdk#54225](https://github.com/dotnet/sdk/pull/54225)). The realm must be an absolute URI, must be HTTPS unless that registry is explicitly listed as insecure, and must not resolve to a loopback, private, link-local, or unspecified IP literal. Registry and auth hosts are still allowed to differ, which is the normal OCI pattern. This is a breaking change in the sense that a misconfigured or malicious registry that used to "work" will now fail the publish early. If a previously fine internal registry starts failing on .NET 11, that validation is the first thing to check.

## Multi-architecture images and the OCI image index

Since SDK 8.0.405, 9.0.102, and 9.0.2xx, `PublishContainer` can produce a real multi-arch image. The rule is about which RID properties you set:

- A single `RuntimeIdentifier` or `ContainerRuntimeIdentifier` gives you a single-architecture image, as before.
- No single RID, but multiple `RuntimeIdentifiers` or `ContainerRuntimeIdentifiers`, and the SDK publishes once per RID and combines the results into an [OCI Image Index](https://specs.opencontainers.org/image-spec/image-index/) so all architectures share one name.

```xml
<!-- .NET 11, SDK 11.0.1xx -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

```bash
# Note: no --arch, and no -r. Passing either collapses it back to one architecture.
dotnet publish --os linux /t:PublishContainer
```

`ContainerRuntimeIdentifiers` must be a subset of `RuntimeIdentifiers`, or parts of the build pipeline fail in confusing ways. Multi-arch images are always emitted in OCI format regardless of what `ContainerImageFormat` says, because the Docker v2 manifest schema has no equivalent of the image index.

Two operational notes. Blazor WebAssembly projects can hit build race conditions when RIDs publish concurrently; `ContainerPublishInParallel=false` serialises them at the cost of wall-clock time (SDK 8.0.408, 9.0.300, 10.0 and later). And .NET 11 preview 6 added multi-arch support when Podman is the local engine ([dotnet/sdk#54575](https://github.com/dotnet/sdk/pull/54575)), which previously required Docker.

`ContainerImageFormat`, added in .NET 10, lets you force `Docker` or `OCI` for the single-arch case. The default is inferred from the base image, and Microsoft's images still use the Docker manifest media type. Set it to `OCI` if a downstream tool insists.

## Ports, environment variables, labels, and the user

These are items rather than properties, so they go in an `ItemGroup`:

```xml
<ItemGroup>
  <ContainerPort Include="8080" Type="tcp" />
  <ContainerEnvironmentVariable Include="ASPNETCORE_FORWARDEDHEADERS_ENABLED" Value="true" />
  <ContainerLabel Include="org.contoso.businessunit" Value="orders" />
</ItemGroup>
```

`ContainerPort` is inferred on .NET 8 and later from `ASPNETCORE_URLS`, `ASPNETCORE_HTTP_PORTS`, or `ASPNETCORE_HTTPS_PORTS`, read either from the base image or from your own `ContainerEnvironmentVariable` items. Since the ASP.NET Core images set `ASPNETCORE_HTTP_PORTS=8080`, a plain web API usually needs no port configuration at all.

`ContainerEnvironmentVariable` has a real limitation worth planning around: there is currently no way to set it from the CLI, only from the project file ([dotnet/sdk-container-builds#451](https://github.com/dotnet/sdk-container-builds/issues/451)). Anything environment-specific therefore belongs in your orchestrator's configuration, not baked into the image, which is where it should be anyway.

Labels mostly take care of themselves. The SDK writes the standard OCI annotations (`org.opencontainers.image.created`, `.version`, `.title`, `.source`, `.revision`, `.base.name`, `.base.digest`, and others) from existing MSBuild properties. `.source` and `.revision` only appear when `PublishRepositoryUrl` is `true` and SourceLink is in the build. Turn the whole set off with `ContainerGenerateLabels=false`, or an individual one with its `ContainerGenerateLabelsImage*` flag.

The user default is the one that surprises people in a good way. Targeting .NET 8 or later against the Microsoft runtime images, the container runs as the rootless `app` user on Linux (referenced by UID via the `APP_UID` environment variable) and as `ContainerUser` on Windows. That is the correct default and you should leave it alone. It does mean the app cannot write to arbitrary paths, cannot bind ports below 1024, and cannot read files whose permissions assume root. If you genuinely need root, `ContainerUser=root` is there, and the SDK does not verify that whatever user you name exists in the image.

`ContainerWorkingDirectory` defaults to `/app`.

## Controlling the entrypoint

For most apps the generated apphost binary is the entrypoint and there is nothing to do. When you want the image to run a tool rather than your app, use `ContainerAppCommand` plus `ContainerAppCommandArgs`, and `ContainerDefaultArgs` for arguments a caller should be able to override:

```xml
<ItemGroup>
  <!-- Semicolons split tokens: this is dotnet ef database update -->
  <ContainerAppCommand Include="dotnet;ef" />
  <ContainerAppCommandArgs Include="database;update" />
</ItemGroup>
```

`ContainerAppCommandInstruction` decides how these combine with any `ENTRYPOINT` in the base image, taking `Entrypoint`, `DefaultArgs`, or `None`. `DefaultArgs` is the default and the most subtle: when no `ContainerEntrypoint` items are present, it skips a base image entrypoint hard-coded to `dotnet` or `/usr/bin/dotnet` so you get complete control. `ContainerEntrypoint` and `ContainerEntrypointArgs` are deprecated as of .NET 8; use the app-command items instead.

## Tarball output for scanning pipelines

Security-conscious pipelines often want to scan before anything reaches a registry. `ContainerArchiveOutputPath` writes the image to a `tar.gz` and needs no daemon:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerArchiveOutputPath=./images/orders-api.tar.gz
```

```bash
docker load -i ./images/orders-api.tar.gz
```

Podman uses `podman load -i` with the same file. If you give a directory instead of a filename, the archive is named `$(ContainerRepository).tar.gz`. All `ContainerImageTags` end up inside the one archive rather than producing multiple files.

## Wiring it into GitHub Actions

The whole thing collapses into three steps, because there is no Buildx, no QEMU, and no Dockerfile to keep in sync with the project:

```yaml
# .github/workflows/publish.yml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '11.0.x'

- name: Log in to GHCR
  run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

- name: Publish container
  run: >
    dotnet publish src/Orders.Api/Orders.Api.csproj
    --os linux /t:PublishContainer
    -p ContainerRegistry=ghcr.io
    -p ContainerRepository=${{ github.repository_owner }}/orders-api
    -p ContainerImageTag=${{ github.sha }}
```

`docker login` is used only to populate `~/.docker/config.json`; the push itself is done by the SDK over HTTPS. On a runner with no Docker at all, replace that step by exporting `DOTNET_CONTAINER_REGISTRY_UNAME` and `DOTNET_CONTAINER_REGISTRY_PWORD`.

## When you still want a Dockerfile

Be honest about the boundaries. Reach for a Dockerfile when you need `RUN` steps, when a multi-stage build has to compile non-.NET assets (a Node front end, native dependencies) in the same file, or when you need fine control over layer ordering for cache efficiency across many images.

Everything else, which in practice is most ASP.NET Core services and worker services, is better off with `PublishContainer`. The image configuration lives in the same file as the rest of the build, it cannot drift out of sync with the TFM, and there is no `COPY --from=build /app/publish .` line to get wrong. If you already run the app under [.NET Aspire](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), this is also the mechanism the AppHost uses when it containerises a project resource for deployment.

One last version note for console apps: on the .NET 10 SDK and later, a console project can publish a container with no extra configuration. On .NET 9 and earlier SDKs, you needed `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` in the project file, and that property is still what you set for project types the SDK does not opt in automatically.

## Related

- [What is the difference between dotnet build and dotnet publish?](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) for what actually lands in the folder that becomes your image layer.
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) before you chase a smaller image with `PublishAot`.
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) for the startup and size numbers behind that decision.
- [How to add .NET Aspire to an existing ASP.NET Core solution](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) if the same projects also need local orchestration.
- [What is trim-safe code and how do I write it?](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) since trimming is the other half of shrinking a container image.

## Sources

- [Containerize an app with dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/containers/sdk-publish) on Microsoft Learn.
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), the full property and item list.
- [Authenticating to container registries](https://github.com/dotnet/sdk-container-builds/blob/main/docs/RegistryAuthentication.md) in the dotnet/sdk-container-builds repository.
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk) for `ContainerImageFormat` and console app support.
- [.NET SDK in .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) for the bearer-token realm validation.
- [.NET SDK in .NET 11 Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) for Podman multi-arch support.
