---
title: "NuGet.org staged publishing: push with dotnet package stage push, promote by hand"
description: "NuGet.org now lets you upload and validate a package privately, then promote it to public on the website. How staging differs from unlisting, the new dotnet package stage push command in the .NET 11 SDK, staging groups, and the staging-only key model."
pubDate: 2026-11-18
tags:
  - "nuget"
  - "dotnet-11"
  - "security"
  - "ci-cd"
---

On November 17, 2026 the NuGet team [introduced staged publishing on NuGet.org](https://devblogs.microsoft.com/dotnet/nuget-staged-publishing/). Until now, a successful `dotnet nuget push` meant the package started going public the moment the upload was accepted. Staging adds a private stop: the package is uploaded and validated, then waits until a maintainer promotes it on the website.

It is opt-in, available to every publisher, and existing push workflows keep working unchanged.

## Staged is not the same as unlisted

Unlisting has always been the fallback for "we published too early", but an unlisted package is still restorable by exact version. A staged package is not available to consumers at all. It goes through the full NuGet.org validation pipeline (malware scanning, signature checks, repository signing) and then sits in a "ready for promotion" state, absent from package pages, search, and restore.

There is also no private restore feed for staged packages, not even for the owner. If you want to smoke test the `.nupkg` before release day, do it against a local or private feed first.

## The CLI side

The new command lives under `dotnet package`, not `dotnet nuget`:

```bash
dotnet package stage push ./artifacts/Contoso.Library.1.2.0.nupkg \
  --source https://api.nuget.org/v3/index.json \
  --api-key "$NUGET_API_KEY" \
  --group november-release
```

`--group` is optional. A staging group collects every package for one release under a single staging owner (a user or an organization), and it is created automatically if it does not exist.

Running `dotnet package stage push --help` on the .NET 11 GA SDK (`11.0.100`) shows two options the announcement does not mention: `--no-symbols`, which stops the command from discovering and staging a sibling symbols package, and a fallback that reads the key from the `NUGET_API_KEY` environment variable when `--api-key` is omitted. The `--help` output is the only part checked here; no package was actually staged.

An accepted upload only means NuGet.org received the file. Validation may still be running, and the package is not public.

## Promotion stays on the website, behind 2FA

Promotion is deliberately a website action: "Promote" for a single package, "Promote group" for a group. The person promoting must be signed in with two-factor authentication enabled. The blog lists future `dotnet package stage list` and `stage group` commands as roadmap items, but says not to expect a CLI approval command.

Two caveats worth planning around:

- **Group promotion is not atomic.** Each package moves through distribution independently, so `Contoso.Library` and `Contoso.Library.Abstractions` can become restorable minutes apart.
- **Staged content expires** if nobody promotes it. The post does not state the window, so watch the expiration notices on NuGet.org.

## Why this matters for supply chain

The interesting part is the credential model. A staging-only API key can upload staged packages but cannot use the normal push path, and Trusted Publishing policies can also be limited to staging. That means a compromised CI pipeline can, at worst, stage a package that a human still has to promote with a 2FA-protected account.

That fits the direction NuGet has been taking since [API keys were capped at 30 days in August](/2026/08/nuget-api-keys-capped-at-30-days-from-august-17/): short-lived credentials from [Trusted Publishing](https://learn.microsoft.com/nuget/nuget-org/trusted-publishing) for the upload, and a human gate for the release. Feedback goes to [NuGet/NuGetGallery](https://github.com/NuGet/NuGetGallery/issues) for the website and [NuGet/Home](https://github.com/NuGet/Home/issues) for the CLI.
