---
title: "NuGet API Keys Get a 30-Day Cap on August 17, and Every Old Key Expires November 1"
description: "NuGet.org drops the 365-day API key option on August 17, 2026, caps new keys at 30 days, and expires every key created before that date on November 1. Here is what breaks and how to move a publish workflow to OIDC trusted publishing."
pubDate: 2026-08-04
tags:
  - "dotnet"
  - "nuget"
  - "ci-cd"
  - "security"
  - "github-actions"
---

The .NET team published [Strengthening NuGet Supply Chain Security: Reducing API Key Lifetime](https://devblogs.microsoft.com/dotnet/strengthening-nuget-supply-chain-security-reducing-api-key-lifetime/) on August 3, 2026, and it carries two hard dates that will break release pipelines if you ignore them.

## The two dates

**August 17, 2026**: new API keys are limited to a 30-day maximum duration. The 365-day option disappears from the key creation UI on nuget.org.

**November 1, 2026**: every API key created before August 17 expires. Not just the year-long ones. If your `NUGET_API_KEY` secret was minted in June, it stops working on November 1 regardless of the expiry date printed next to it.

That second date is the one that bites. A tag-driven release workflow that has not run since October will fail on its first push after November 1 with a 401, and the failure surfaces in a job nobody watches until they actually need to ship.

## Why a 30-day key is still the wrong shape

A 30-day key is better than a 365-day key, but it is still a long-lived secret sitting in a repository secret store, and now you get to rotate it twelve times a year instead of once. Rotation automation is real work: mint the key on nuget.org with the right package scope, push it into GitHub or Azure DevOps, verify the old one is revoked.

The alternative that Microsoft is steering everyone toward is [trusted publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing), which uses OIDC instead. Your CI system issues a short-lived signed token, nuget.org validates it against a policy you registered, and hands back a temporary API key valid for **one hour**. One token buys exactly one key. Nothing durable is stored anywhere.

The GitHub Actions shape is small:

```yaml
publish:
  environment: release
  permissions:
    id-token: write   # required for GitHub to mint the OIDC token
    contents: read
  steps:
    - name: NuGet login (OIDC to temp API key)
      uses: NuGet/login@v1
      id: login
      with:
        user: ${{ secrets.NUGET_USER }}   # nuget.org profile name, not your email
    - name: Push
      run: >
        dotnet nuget push artifacts/*.nupkg
        --api-key ${{ steps.login.outputs.NUGET_API_KEY }}
        --source https://api.nuget.org/v3/index.json
        --skip-duplicate
```

The one-time setup is a policy on nuget.org under Account, Trusted Publishing: repository owner, repository, workflow file name (`release.yml`, without the `.github/workflows/` prefix), and optionally the environment name. GitLab works too, exchanging an `id_tokens` claim against `POST https://www.nuget.org/api/v2/token`.

One gotcha worth knowing before November: a policy created against a private GitHub repo starts out **temporarily active for 7 days**. If no publish happens in that window it goes inactive, because nuget.org needs the repo and owner IDs from a real token exchange to pin the policy against resurrection attacks. Register the policy and do a throwaway push, do not register it and walk away.

If you already run a multi-package release, the wiring is covered in [Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/). Otherwise the minimum viable action this week is to audit which of your pipelines still push with a static key, and confirm the nuget.org account receiving expiration notices is one somebody actually reads.
