---
title: "Microsoft Is Rotating Its NuGet Author-Signing Certificate: Fix trustedSigners Before NU3034 Hits"
description: "Starting September 23, 2026, Microsoft packages on NuGet get author-signed with a new certificate (SHA-256 9A1B131B...). If your nuget.config pins Microsoft in trustedSigners, restores will fail with NU3034. Here is the fix, including the correct dotnet nuget trust command."
pubDate: 2026-09-24
tags:
  - "nuget"
  - "dotnet"
  - "security"
  - "supply-chain"
---

On September 23, 2026 the .NET team [announced](https://devblogs.microsoft.com/dotnet/microsoft-author-signing-certificate-update-2026/) that Microsoft is switching the certificate it uses to author-sign packages on nuget.org. Most projects will never notice. If you run NuGet with `signatureValidationMode="require"` and a `<trustedSigners>` list that names Microsoft, or you run `dotnet nuget verify --certificate-fingerprint` in CI, the first package signed with the new certificate will fail with `NU3034` and break the build.

## The fingerprints

The new certificate has SHA-256 fingerprint `9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630`. The one being replaced is `566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353`. Two older fingerprints, `3F9001EA...` and `AA12DA22...`, also stay valid for packages signed years ago.

Don't remove any of them. Packages already on nuget.org keep their original signatures, so your trust list has to accept every certificate Microsoft has used, not just the newest one.

## The rollout is gradual

I downloaded `Microsoft.Playwright` 1.63.0 (published September 23, 20:23 UTC) and `Microsoft.Identity.Web` 4.15.0 and ran `dotnet nuget verify --all -v normal` on SDK 10.0.302. Both are still signed with the old certificate:

```text
Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353
  Valid from: 27/07/2023 03:00:00 to 18/10/2026 02:59:59
```

The old certificate expires on October 18, 2026. Microsoft teams publish on their own schedules, so expect packages to switch to the new certificate over the next few weeks. Nothing new can be signed with the old one after October 18. A build that works today can still fail next Tuesday.

## The trust command in the announcement does not run

The blog post suggests `dotnet nuget trust author Microsoft <fingerprint> --algorithm SHA256`. On SDK 10.0.302 that fails with `Unrecognized command or argument '--algorithm'`, because `trust author` takes a path to a signed package, not a fingerprint. To add a raw fingerprint, use [`trust certificate`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-trust):

```bash
dotnet nuget trust certificate Microsoft 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630 --algorithm SHA256 --configfile nuget.config
```

If the `Microsoft` author entry already exists, this adds the fingerprint to it ("Successfully updated the trusted signer 'Microsoft'"). The resulting config should list all four:

```xml
<trustedSigners>
  <author name="Microsoft">
    <certificate fingerprint="3F9001EA83C560D712C24CF213C3D312CB3BFF51EE89435D3430BD06B5D0EECE" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="AA12DA22A49BCE7D5C1AE64CC1F3D892F150DA76140F210ABD2CBFFCA2C18A27" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
  </author>
</trustedSigners>
```

## CI verify steps

`dotnet nuget verify` accepts `--certificate-fingerprint` more than once. Pass all four. With only one fingerprint, the check fails as soon as it meets a package signed with a different certificate. For example, verifying Playwright 1.63.0 against only the new fingerprint prints:

```text
error: NU3034: The package signature did not match any of the allowed certificate fingerprints.
```

Organizations that mirror nuget.org into an internal feed and check signatures on ingest need the same change there. The [NU3034 reference](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu3034) and the [signed packages guide](https://learn.microsoft.com/en-us/nuget/consume-packages/installing-signed-packages) cover the rest of the `trustedSigners` model. Adding the new fingerprint now, before your restore meets a package that uses it, is much easier than debugging a red build in the middle of October.
