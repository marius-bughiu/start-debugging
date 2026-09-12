---
title: ".NET 11 RC 1 Makes dotnet publish Container Images Reproducible"
description: "The .NET 11 RC 1 SDK honors SOURCE_DATE_EPOCH when publishing container images, strips the process id from layer tar headers, and skips blob uploads when the registry already has the manifest. Same commit in, same digest out."
pubDate: 2026-09-12
tags:
  - "dotnet-11"
  - "containers"
  - "sdk"
  - "dotnet"
---

Publish the same commit twice with `dotnet publish /t:PublishContainer` on .NET 10 and you get two different image digests. The code is identical, but the SDK stamped the current time into every layer entry and into the image config. It also stamped the process id into every layer tar. A registry cannot deduplicate that, and a GitOps controller watching the tag sees a new release. [.NET 11 RC 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/), shipped on September 8, 2026, fixes both in the SDK's built-in container tooling ([dotnet/sdk#55836](https://github.com/dotnet/sdk/pull/55836)).

## Four places the clock leaked into the digest

The [original PR](https://github.com/dotnet/sdk/pull/55689) lists them:

- Every `PaxTarEntry` in a layer defaulted its modification time to `DateTime.UtcNow`, sampled separately per file.
- The image config sampled `DateTime.UtcNow` for `created` and again for the generated history entry.
- The `org.opencontainers.image.created` and `org.opencontainers.artifact.created` labels came from `UtcNow` in the targets file.
- `TarWriter` names each pax extended header `./PaxHeaders.<process id>/.`, so the pid ended up in every layer.

The pid alone was enough to change the layer digest when the content was byte-identical. Only 13 bytes of the layer differed, all of them caused by that header name.

## Opting in with SOURCE_DATE_EPOCH

RC 1 follows the [reproducible-builds convention](https://reproducible-builds.org/docs/source-date-epoch/). The `SOURCE_DATE_EPOCH` MSBuild property, or an environment variable of the same name, which MSBuild picks up automatically, is parsed once into a single timestamp. That value then goes into every tar entry, the config `created` field, the history entry, and both OCI labels:

```bash
dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerRegistry=registry.example.com \
  -p:SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
```

Using the commit timestamp means the digest only moves when the commit moves. I checked it with the RC 1 SDK (`11.0.100-rc.1.26425.128`) by publishing a console app to a tarball three times:

```bash
pub() { dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerArchiveOutputPath=./$1.tar.gz "${@:2}"; }

pub a -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub b -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub c                                   # config 5f24aace..., app layer 2f4f68c1...
```

Runs `a` and `b` are byte-identical, and the config `created` field reads `2025-09-12T00:00:00.0000000Z`. Run `c` still gets the wall clock, so reproducibility is opt-in. If the value is malformed, negative, or out of range, the SDK falls back to the current time. The build does not fail.

Two side effects to know before upgrading. The layer writer now sorts entries by container path, because directory enumeration order depends on the filesystem. The pax header name is always the constant `./PaxHeaders/.`. Both apply to every publish, even without `SOURCE_DATE_EPOCH`, so your digests will shift once when you move to RC 1.

## Skipping uploads the registry already has

The companion change ([dotnet/sdk#55838](https://github.com/dotnet/sdk/pull/55838)) builds on it. Before pushing, the SDK sends a `HEAD` request for the computed manifest digest. If the registry already has it, the SDK skips the layer and config uploads, still applies every requested tag, and logs `Manifest '...' already exists in repository '...'`. A retried CI job or a second tag on an unchanged commit becomes a few metadata calls.

In the RC 1 targets this is on by default: `ContainerPushNoCache` defaults to `false`. If a registry misreports manifest existence, turn the check off:

```bash
dotnet publish /t:PublishContainer -p:ContainerPushNoCache=true
```

The image is still built locally, since the digest has to be computed first, so this saves transfer, not build time. It also only pays off when the digest is stable, which is why the two PRs landed together.

For another RC 1 change that removes a long-standing workaround, see [signals and exit status on `Process`](/2026/09/dotnet-11-rc-1-process-signal-exit-status/). The full SDK list is in the [RC 1 SDK release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/sdk.md).
