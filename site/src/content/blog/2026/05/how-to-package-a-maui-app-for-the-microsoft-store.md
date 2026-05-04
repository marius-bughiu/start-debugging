---
title: "How to package a .NET MAUI app for the Microsoft Store"
description: "End-to-end guide to packaging a .NET MAUI 11 Windows app as an MSIX, bundling x64/x86/ARM64 into a .msixupload, and submitting through Partner Center: identity reservation, Package.appxmanifest, dotnet publish flags, MakeAppx bundling, and the Store-trusted certificate handoff."
pubDate: 2026-05-04
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "windows"
  - "msix"
  - "microsoft-store"
  - "partner-center"
  - "how-to"
---

Short answer: reserve the app name in Partner Center first, copy the generated Identity values into `Platforms/Windows/Package.appxmanifest`, set `WindowsPackageType=MSIX` plus `AppxPackageSigningEnabled=true` in your `.csproj`, then run `dotnet publish -f net10.0-windows10.0.19041.0 -c Release -p:RuntimeIdentifierOverride=win-x64` once per architecture you want to ship. Combine the resulting `.msix` files with `MakeAppx.exe bundle` into a single `.msixbundle`, wrap that in a `.msixupload` (a plain zip with the bundle and its symbol bundle), and upload it as the package on a Partner Center submission. The Store re-signs your bundle with its own certificate, so the local `PackageCertificateThumbprint` only needs to be trusted on your build machine.

This guide walks the full pipeline for .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7, and the Partner Center submission flow as it stands in May 2026. Everything below was validated against `dotnet new maui` from the .NET 11.0.100 SDK, with `Microsoft.WindowsAppSDK` 1.7.250401001 and `Microsoft.Maui.Controls` 11.0.0. Earlier .NET 8 and .NET 9 advice is called out where the recipe diverges.

## Why "just hit Publish" stopped working

Visual Studio's MAUI publish wizard ships a "Microsoft Store" target, but it has not produced a Store-acceptable `.msixupload` for any MAUI release since .NET 6. The wizard generates a single-architecture `.msix` and stops there, which means uploads either fail Partner Center validation outright (when your previous submission was bundled) or silently lock you into a single architecture for the lifetime of the listing. The MAUI team has tracked this gap as [dotnet/maui#22445](https://github.com/dotnet/maui/issues/22445) since 2024 and the fix has not landed in MAUI 11. The CLI is the supported path.

The second reason the wizard misleads is identity. The `.msix` it produces is signed with whatever local certificate you pointed it at, but a Store submission requires your app's `Identity` element (`Name`, `Publisher`, and `Version`) to exactly match the values Partner Center reserved for you. If the manifest says `CN=DevCert` and Partner Center expects `CN=4D2D9D08-...`, the upload fails with a generic 12345-style error code that does not name the offending field. Reserving the name first and pasting Partner Center's values into the manifest before you build is the only way to avoid that loop.

The good news: once you have the right manifest, the CLI commands are stable across .NET 8, 9, 10, and 11. Only the runtime identifier shape changed: `win10-x64` was retired in .NET 10 in favor of the portable `win-x64`, per [NETSDK1083](https://learn.microsoft.com/en-us/dotnet/core/tools/sdk-errors/netsdk1083). Everything else is the same `MSBuild` invocation Xamarin shipped in 2020.

## Step 1: Reserve the name and harvest the identity values

Sign in to [Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview) and create a new app. Reserve the name. Open **Product identity** (or **App management > App identity** depending on the dashboard version you see); you need three strings:

- **Package/Identity Name**, for example `12345Contoso.MyMauiApp`.
- **Package/Identity Publisher**, the long `CN=...` string Microsoft assigns you, for example `CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A`.
- **Package/Publisher display name**, the human-readable version that appears in the Store listing.

These three values must land verbatim in `Platforms/Windows/Package.appxmanifest`. The MAUI template ships a placeholder manifest with `Name="maui-package-name-placeholder"`, which the build system normally rewrites from your `.csproj`. For Store builds, override it explicitly so the `Identity` element survives the build.

```xml
<!-- Platforms/Windows/Package.appxmanifest, .NET MAUI 11 -->
<Identity
    Name="12345Contoso.MyMauiApp"
    Publisher="CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A"
    Version="1.0.0.0" />

<Properties>
  <DisplayName>My MAUI App</DisplayName>
  <PublisherDisplayName>Contoso</PublisherDisplayName>
  <Logo>Images\StoreLogo.png</Logo>
</Properties>
```

The `Version` here uses the four-part Win32 scheme (`Major.Minor.Build.Revision`) and Partner Center treats the fourth segment as reserved: it must be `0` for any Store submission. If you encode CI build numbers into the version, put them in the third segment.

While you are in the manifest, set the `<TargetDeviceFamily>` to `Windows.Desktop` with a `MinVersion` of `10.0.17763.0` (the floor for Windows App SDK 1.7) and a `MaxVersionTested` that matches what you actually tested against. Setting `MaxVersionTested` too high causes Partner Center to flag the submission for additional certification; too low makes Windows refuse to install on more recent OS versions.

## Step 2: Wire up the project for MSIX builds

The `.csproj` properties below replace the entire "Configure project for MSIX" advice from the Visual Studio docs. Add this block once, then forget about it.

```xml
<!-- MyMauiApp.csproj, .NET MAUI 11.0.0 on .NET 11 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(Configuration)' == 'Release'">
  <WindowsPackageType>MSIX</WindowsPackageType>
  <AppxPackage>true</AppxPackage>
  <AppxPackageSigningEnabled>true</AppxPackageSigningEnabled>
  <GenerateAppxPackageOnBuild>true</GenerateAppxPackageOnBuild>
  <AppxAutoIncrementPackageRevision>False</AppxAutoIncrementPackageRevision>
  <AppxSymbolPackageEnabled>true</AppxSymbolPackageEnabled>
  <AppxBundle>Never</AppxBundle>
  <PackageCertificateThumbprint>AA11BB22CC33DD44EE55FF66AA77BB88CC99DD00</PackageCertificateThumbprint>
</PropertyGroup>

<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(RuntimeIdentifierOverride)' != ''">
  <RuntimeIdentifier>$(RuntimeIdentifierOverride)</RuntimeIdentifier>
</PropertyGroup>
```

Two of these properties are non-obvious.

`AppxBundle=Never` looks wrong because the Store wants a bundle, but the .NET MAUI build only knows how to produce a single-architecture `.msix` per `dotnet publish` invocation. Setting `AppxBundle=Always` here causes the build to attempt UWP-era bundle generation against a non-UWP project and emits the cryptic `The target '_GenerateAppxPackage' does not exist in the project` error tracked in [dotnet/maui#17680](https://github.com/dotnet/maui/issues/17680). You build per architecture and bundle them yourself in the next step.

`AppxSymbolPackageEnabled=true` produces an `.appxsym` next to each `.msix`. The `.msixupload` you submit is a zip whose contents are the bundle plus a sibling symbol bundle, and Partner Center silently strips crash analytics if either side is missing. It does not warn you; you just get blank stack traces in the Health dashboard six weeks later.

The second `<PropertyGroup>` works around [WindowsAppSDK#3337](https://github.com/microsoft/WindowsAppSDK/issues/3337), which has been open since the project moved to GitHub and shows no signs of closing. Without it, `dotnet publish` selects the implicit RID before the MSIX target reads it, and the resulting package targets the build host's architecture instead of whatever you passed on the command line.

The `PackageCertificateThumbprint` only matters for sideload installs. Partner Center re-signs your bundle with the certificate associated with your publisher account, so a self-signed cert is fine for Store submissions. Generate one with `New-SelfSignedCertificate -Type Custom -Subject "CN=Contoso" -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")`, copy the thumbprint into the project file, and trust the certificate in the **Trusted People** store on whichever machines you sideload to before the Store listing goes live.

## Step 3: Build one MSIX per architecture

The Store accepts x64 and ARM64 today, plus an optional x86 build for the long tail of older PCs. Run `dotnet publish` once per architecture, from a **Developer Command Prompt for Visual Studio** so the Windows SDK tools are on `PATH`.

```powershell
# .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7
$tfm = "net10.0-windows10.0.19041.0"
$project = "src\MyMauiApp\MyMauiApp.csproj"

foreach ($rid in @("win-x64", "win-x86", "win-arm64")) {
    dotnet publish $project `
        -f $tfm `
        -c Release `
        -p:RuntimeIdentifierOverride=$rid
}
```

After all three runs finish, the per-architecture packages land at:

```
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x64.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x86\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x86.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-arm64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_arm64.msix
```

Each folder also contains an `.appxsym` symbol bundle. Copy all six artefacts into a flat staging folder so the bundling step can operate on a single directory.

```powershell
$staging = "artifacts\msix"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem -Recurse -Include *.msix, *.appxsym `
    -Path "src\MyMauiApp\bin\Release\$tfm" |
    Copy-Item -Destination $staging
```

Your `dotnet build` log will report `package version 1.0.0.0` for each architecture. They must match exactly, otherwise `MakeAppx.exe bundle` rejects the input set with `error 0x80080204: The package family is invalid`.

## Step 4: Bundle the architectures into a `.msixbundle`

`MakeAppx.exe` ships with the Windows 11 SDK at `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe`. Newer SDK versions install side by side; pick the one that matches your `MaxVersionTested`.

```powershell
$makeappx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe"
$version = "1.0.0.0"

& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle"
```

The `/d` switch tells `MakeAppx` to ingest every `.msix` in the folder and produce a fat bundle whose architecture map covers all three. The `/bv` (bundle version) value must equal the `Version` in `Package.appxmanifest`; mismatches cause Partner Center to reject the submission with `package version mismatch`.

Run a second pass to bundle the symbol files:

```powershell
& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle"
```

`MakeAppx` figures out the file extension from the input set and skips the `.msix` files when bundling symbols. If you forget the symbol bundle, the upload still succeeds, but Health Reports stays empty.

## Step 5: Wrap it as a `.msixupload`

A `.msixupload` is just a zip with a specific extension. Partner Center auto-detects bundle and symbol bundle sibling files inside it.

```powershell
$upload = "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixupload"

Compress-Archive `
    -Path "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle", `
          "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle" `
    -DestinationPath ($upload -replace '\.msixupload$', '.zip') -Force

Move-Item -Force ($upload -replace '\.msixupload$', '.zip') $upload
```

PowerShell 5.1 refuses to write a non-`.zip` extension directly with `Compress-Archive`, which is why the snippet writes a `.zip` first and renames. PowerShell 7.4+ accepts the extension directly.

## Step 6: Upload through Partner Center

Open your reserved app in Partner Center, click **Start your submission**, jump to the **Packages** section, and drop the `.msixupload`. Partner Center validates the package on the spot and surfaces issues in three categories:

- **Identity mismatch.** The `Identity Name` or `Publisher` in your manifest does not match the values Partner Center reserved. Open the dashboard's **Product identity** page side by side with `Package.appxmanifest`, fix the manifest, rebuild, re-bundle, and re-upload. Do not edit the `.msixupload` zip directly; the bundle is signed and the unzip-edit-rezip cycle invalidates the signature.
- **Capabilities.** Any `<Capability>` you declare maps to a Store category that may require additional certification. `runFullTrust` (which MAUI sets implicitly because Win32 desktop apps need it) is approved for normal Store accounts; `extendedExecutionUnconstrained` and similar capabilities take additional review.
- **Min version.** If `MinVersion` in `<TargetDeviceFamily>` is older than the lowest Windows version the Store currently supports (10.0.17763.0 as of May 2026), the package is rejected. The fix is to raise it in the manifest, not to lower the SDK.

Once validation passes, fill in the listing metadata, age rating, and pricing as you would for any other Store app. The first review typically completes in 24-48 hours; updates to existing apps usually clear in under 12.

## Five gotchas that will eat an afternoon

**1. The first submission decides bundle versus single MSIX forever.** If you ever upload a single `.msix` for a listing, every future submission must also be a single `.msix`; you cannot promote an existing listing to a bundle, and you cannot demote a bundle to a single MSIX. Decide upfront and stick to bundles even if you only ship one architecture today.

**2. `Package Family Name` in PartnerCenter is not the same as `Identity Name`.** The PFN is `Identity.Name + "_" + first 13 chars of the Publisher hash`, and Windows derives it automatically. If you copy the PFN into the manifest's `Identity.Name`, the upload fails with the misleading "package identity does not match" error documented in [dotnet/maui#32801](https://github.com/dotnet/maui/issues/32801).

**3. Windows App SDK is a framework dependency, not a redistributable you ship.** The Store installs the matching `Microsoft.WindowsAppRuntime.1.7` package automatically as long as you use the framework-dependent `WindowsAppSDK` reference from the MAUI template. If you flip to self-contained, the resulting MSIX is 80MB larger and Partner Center rejects it for exceeding the per-architecture size budget on the Store's free tier.

**4. Project names with underscores break MakeAppx.** A `.csproj` named `My_App.csproj` produces packages whose filenames contain underscores in positions where `MakeAppx bundle` interprets them as version separators, which fails with `error 0x80080204`. Rename the project to use hyphens, or add `<AssemblyName>MyApp</AssemblyName>` to override the output name. This is tracked in [dotnet/maui#26486](https://github.com/dotnet/maui/issues/26486).

**5. The `Test` suffix is real.** The `AppPackages\MyMauiApp_1.0.0.0_Test` folder is named that way because `dotnet publish` defaults to producing test certificates. The `.msix` inside the folder is fine for the Store; only the folder name is misleading. Copy the `.msix`, ignore the `_Test` directory, and move on.

## Where this fits in a CI pipeline

Nothing in this pipeline requires Visual Studio. A clean `windows-latest` GitHub Actions runner with the .NET 11 SDK and the MAUI workload installed produces the same `.msixupload` from these commands. The only sensitive material is the signing certificate's thumbprint and PFX, both of which fit in repository secrets. After upload, the [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) lets you push the same artefact straight into a draft submission without touching the dashboard, which closes the loop on a fully automated release.

If you are stripping mobile target frameworks from the same project so the Windows build does not also drag in Android and iOS workloads, the [Windows-and-macOS-only MAUI 11 setup](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) covers the `<TargetFrameworks>` rewrites you need before any of the publish commands above will run cleanly. For the Manifest Designer side of `Package.appxmanifest` and the small set of theme settings the Store reads, [supporting dark mode in a MAUI app](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) walks through the resource keys that show up in the listing's screenshot generator. If your Store listing showcases a Maps page, the [MAUI 11 map pin clustering walkthrough](/2026/04/dotnet-maui-11-map-pin-clustering/) covers the `MapsKey` capability you need to declare in the manifest before the certification team will approve the app. And for a wider tour of what is new in the framework that ships in your bundle, [what's new in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) is the closest thing the docs have to a release-note pillar.

## Source links

- [Use the CLI to publish packaged apps for Windows - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/publish-cli?view=net-maui-10.0)
- [Publish a .NET MAUI app for Windows (overview)](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/overview?view=net-maui-10.0)
- [App manifest schema reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/root-elements)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [MakeAppx.exe tool reference](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [WindowsAppSDK Issue #3337 - RID workaround](https://github.com/microsoft/WindowsAppSDK/issues/3337)
- [dotnet/maui Issue #22445 - .msixupload missing](https://github.com/dotnet/maui/issues/22445)
- [dotnet/maui Issue #32801 - package identity mismatch](https://github.com/dotnet/maui/issues/32801)
