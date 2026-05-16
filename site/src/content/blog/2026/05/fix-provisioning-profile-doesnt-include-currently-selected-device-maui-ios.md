---
title: "Fix: Provisioning profile doesn't include the currently selected device in MAUI iOS"
description: "The profile Visual Studio picked was generated before this iPhone's UDID was registered. Re-register the device, regenerate the development profile, redownload, redeploy."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "signing"
---

The fix: the development provisioning profile MAUI tried to sign with does not list the iPhone's UDID. Either the profile was generated before you registered the device, the device is registered under a different team than the one Visual Studio is using, or the Bundle ID in your csproj does not match the App ID the profile is bound to. Add the UDID in Apple Developer Account, regenerate the iOS App Development profile so it includes the new device, click Download All Profiles in Visual Studio (or `Download Manual Profiles` in Xcode if you use the CLI path), and redeploy. If you are on automatic provisioning, unplugging and replugging the device usually triggers Visual Studio to re-run provisioning and pick up the new UDID.

```text
Could not find any available provisioning profiles for iOS.
error : The provisioning profile doesn't include the currently selected device "iPhone (00008130-001A2C3D0EF8401E)".

error MT1006: Could not install the application 'com.example.app' on the device 'iPhone'.
error : A valid provisioning profile for this executable was not found. (0xe8008015)
```

This guide is written against .NET 11 GA, the `net11.0-ios` target framework, .NET MAUI 11.0.0, Xcode 16.4, and Visual Studio 17.14 paired to a Mac build host. The same error and the same fix apply unchanged on .NET MAUI 8 and 9; only the workload IDs (`maui-ios`, `ios`) and the bundled `Xcode` minimum shift between releases. The exception is raised by `mlaunch`, the tool MAUI uses under the hood to push a `.app` bundle to a real device, after `codesign` has already accepted the binary. The build itself succeeds. The install step is what rejects you.

## Why MAUI iOS pairs profiles with device UDIDs

Apple's iOS code-signing model has three moving parts: a signing certificate (your developer identity), an App ID (the bundle identifier the profile is bound to), and a provisioning profile (a signed blob that ties a certificate, an App ID, a team, and a list of permitted device UDIDs together). A development profile is only valid for the devices Apple wrote into it at the moment of generation. Plug in a new iPhone, and any pre-existing development profile silently does not cover it. The OS refuses the install with `0xe8008015`, the MISAgent error for "no valid provisioning profile". MAUI's `mlaunch` surfaces that as the "provisioning profile doesn't include the currently selected device" message and, on older toolchains, as the more cryptic `MT1006`.

There is no warning at build time. `codesign` only checks the certificate and the profile's App ID; it does not inspect the device list. The device list is enforced by `installd` on the iPhone itself, which is why the error always appears at deploy, never at build.

Three things cause this:

1. The device's UDID is not in the profile (most common, especially right after plugging in a new test device).
2. The Bundle ID in your csproj has drifted from the App ID the profile is bound to (renaming a project, changing the org prefix, copying a template).
3. Visual Studio is signing with a profile from a different team than the one that registered the device (a personal team vs an organization team, or a stale profile cached locally).

## A minimal repro

Take any MAUI 11 iOS project, set Bundle Signing to Manual, point `CodesignProvision` at a development profile that was generated last week, then plug in a brand new iPhone today.

```xml
<!-- .NET 11, .NET MAUI 11.0.0, net11.0-ios -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
  <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
  <CodesignProvision>MyApp Dev Profile</CodesignProvision>
  <CodesignEntitlements>Platforms/iOS/Entitlements.plist</CodesignEntitlements>
</PropertyGroup>
```

Then:

```bash
# .NET 11.0.100, MAUI workload 11.0.0
dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:udid=00008130-001A2C3D0EF8401E"
```

Build succeeds. Deploy fails with the device-not-included message, because the profile named `MyApp Dev Profile` was generated before `00008130-001A2C3D0EF8401E` was a device Apple knew about.

## Fix path A: automatic provisioning that has gone stale

If your `iOS Bundle Signing` scheme is set to **Automatic Provisioning** (the recommended default for development), Visual Studio is supposed to re-run provisioning every time a new device is plugged in and quietly regenerate the profile to include it. When that mechanism stalls, the error you are reading is the symptom.

1. Open **Tools > Options > Xamarin > Apple Accounts**, select your team, click **View Details**. Confirm the team you expect is the team Visual Studio is using. If you see two teams (a personal "Marius Bughiu" team and an organization team), they each have their own pool of profiles and Visual Studio will only auto-provision against the team currently bound to the project.
2. Right-click the project, **Properties**, **iOS > Bundle Signing**. Confirm **Scheme** is **Automatic Provisioning**, **Signing Identity** and **Provisioning Profile** are both set to **Automatic**, and **Configure Automatic Provisioning** shows a green check. If the dialog reports an error, read it; "Authentication Service Is Unavailable" almost always means there is an unaccepted agreement in [App Store Connect](https://appstoreconnect.apple.com/) or [Apple Developer](https://developer.apple.com/account).
3. Unplug the iPhone from the Mac build host, wait two seconds, plug it back in. Visual Studio listens for the USB event and re-runs automatic provisioning, which is what registers a new UDID and regenerates the development profile. Watch the **Output > General** pane for `Automatic provisioning succeeded` before redeploying.
4. If you swapped Macs since the last successful build, the private key for your signing certificate likely never made it across. Visual Studio will tell you so in the Apple Accounts dialog with the status **Not in Keychain**. Export the `.p12` from Keychain Access on the original Mac and import it via **Import Certificate** in the Apple Accounts dialog, then retry.

Automatic provisioning still requires the Mac build host to be paired and reachable. If `Pair to Mac` shows yellow, the USB device event will not propagate and your fresh UDID never gets registered. Re-pair first.

## Fix path B: manual provisioning, the explicit csproj path

If you keep your iOS signing under explicit control (CI, enterprise distribution, an Apple account shared across the team), do the registration and the regeneration by hand.

1. On the Mac, **Xcode > Window > Devices and Simulators**, select the iPhone, copy the **Identifier** string. This is the UDID `installd` checks. The format is `00008130-001A2C3D0EF8401E` for an A12+ device. Do not type it; copy it. UDIDs are 25 characters with a dash; one wrong character and the profile silently does not match.
2. In a browser, [Devices in Apple Developer](https://developer.apple.com/account/resources/devices/list), **+**, select platform **iOS, tvOS, watchOS**, paste the UDID, give it a memorable name, **Continue**, **Register**.
3. [Profiles](https://developer.apple.com/account/resources/profiles/list), find your development profile, **Edit**, tick the newly added device in the Devices list, **Save**, **Download**. Editing the profile regenerates it; the file name stays the same, the contents change. Apple does not push the new file to your machine; you have to download it.
4. Install the regenerated profile. On Mac, double-clicking the `.mobileprovision` registers it with `~/Library/MobileDevice/Provisioning Profiles/`. On Windows, in Visual Studio go to **Tools > Options > Xamarin > Apple Accounts**, select your team, **View Details**, **Download All Profiles**. The profile syncs to both Windows and the paired Mac.
5. Confirm your csproj points at the right profile. The string in `CodesignProvision` must match the profile **Name** in Apple Developer exactly, not the file name, not the UUID:

    ```xml
    <!-- .NET 11, .NET MAUI 11.0.0 -->
    <PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
      <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
      <CodesignProvision>MyApp Dev Profile</CodesignProvision>
    </PropertyGroup>
    ```

    The `CodesignKey` is the common name of the certificate as it appears in Keychain Access under **My Certificates**. The `CodesignProvision` is the profile name you typed in step 3 of the Apple Developer workflow. Both are case-sensitive. See [CodesignKey](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) and [CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignprovision) for the full schema.

6. Rebuild and redeploy. If the failure persists, jump to the gotchas below; the UDID has been registered correctly, so something else is wrong.

## Verify the profile actually contains the device

Before tearing the project down, prove the profile is correct. `security` on macOS decodes the CMS envelope around a `.mobileprovision`:

```bash
# macOS, security tool ships with the OS
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -convert xml1 -o - - \
  | grep -A1000 ProvisionedDevices \
  | head -50
```

You should see a `<string>` element with your UDID inside `<key>ProvisionedDevices</key>`. If it is missing, the profile in your Provisioning Profiles folder is the pre-regeneration copy. Delete it and re-download from Visual Studio or Xcode. macOS does not overwrite an existing profile with a newer one of the same UUID unless you remove the old file first; this catches a lot of people who think they have "the new profile" but actually have last week's.

While you are there, check the `<key>application-identifier</key>` value. It must equal `<TEAM_ID>.<bundle-id>`, where the bundle id is exactly the **Application ID** in your csproj. If they differ, your csproj or your `Info.plist` drifted. See the Bundle ID drift section under gotchas.

## Gotchas and lookalikes

**You are deploying to the simulator, not a device.** The simulator does not require a provisioning profile at all, but `mlaunch` will still complain if your project forces a profile via `CodesignProvision` and you accidentally selected an `iPhone 15 Pro Simulator` target. Switch the **Debug Target** in the Visual Studio toolbar to **iOS Remote Devices** and pick the physical device.

**You are running Distribution, not Development.** A development profile only includes Development-capable devices and only signs with an `Apple Development` certificate. If `Configuration` is `Release` and the project uses an `Apple Distribution` certificate, an ad-hoc distribution profile is required and your dev profile will not be selected. See the official guide on [publishing for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) for the parallel manual steps.

**Bundle ID drift.** The Application ID in **Project Properties > MAUI Shared > General** must match the Bundle ID a wildcard or explicit App ID covers. A wildcard `com.example.*` profile covers `com.example.app` but not `com.example.app.dev`. If you forked a sample and never updated the App ID, your profile is rejected on App ID mismatch and `mlaunch` reports it as the device-not-included error because the OS rolls both checks into the same 0xe8008015 code.

**Wildcard profile but an entitlement that needs explicit App ID.** Push Notifications, App Groups, Apple Pay, iCloud, Game Center, HealthKit, HomeKit, NFC, Associated Domains, In-App Purchase, and Wireless Accessory Configuration all require an explicit App ID. If you enabled one of these in `Entitlements.plist` while your profile is wildcard, the install fails. Switch to an explicit App ID that matches your bundle identifier and regenerate the profile with the entitlement ticked.

**Two profiles, same App ID, different teams.** Cached profiles do not key on team. If you ever signed into a different Apple Developer team on the same machine, both teams' profiles live side by side in `~/Library/MobileDevice/Provisioning Profiles/`. Visual Studio picks one, often the older or alphabetically first, and the device list does not match because the device is registered under the other team. Delete the stale profile files and re-download via **Download All Profiles**.

**The device is supervised or has lost trust.** On the iPhone, **Settings > General > VPN & Device Management** should list the developer certificate and let you tap **Trust**. If "Trust This Computer" was dismissed, `installd` rejects the deploy without a clear reason and `mlaunch` may surface the device-not-included message. Re-pair, tap Trust, retry.

**Free Apple ID accounts have a 7-day profile lifetime.** Personal teams (no paid membership) generate development profiles that expire seven days after creation. The expiration manifests at deploy time the same way the missing-device case does. The fix is to regenerate by clicking Run from Xcode at least once, or to upgrade to a paid Apple Developer Program account.

**`MT1006: Could not install the application`.** This is `mlaunch`'s wrapper for any deploy failure, not a specific cause. The first sibling line in the build log is the real error; in the missing-device case it is the "provisioning profile doesn't include" line. Khalid Abuhakmeh's writeup on [missing entitlements](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues) walks through the entitlements variant of the same MT1006 surface.

## Related

- The Android counterpart for "the build wrapper hides the real error" is covered in [the XA1029 Gradle build failure walkthrough](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- If you are setting up iOS hot-reload on the same project, [dotnet watch on MAUI Android and iOS in .NET 11 preview 4](/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) covers the watch loop you can return to once signing is fixed.
- For distribution flows after the development loop works, see [packaging a MAUI app for the Microsoft Store](/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) for the Windows side and the [ad-hoc distribution doc](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) for the iOS side.
- If your target is desktop-only and you want to skip mobile signing altogether, [a MAUI app that runs on Windows and macOS only, no mobile targets](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) shows how to drop the `net11.0-ios` TFM.
- For the underlying runtime context on iOS in .NET 11, the [MAUI CoreCLR default for Android and iOS in .NET 11 preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) post covers what changed under `mlaunch`.

## Sources

- [Manual provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/manual-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Automatic provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/automatic-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Device provisioning for .NET MAUI apps on iOS](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/?view=net-maui-10.0) (Microsoft Learn)
- [Build properties for iOS: CodesignKey and CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) (Microsoft Learn)
- [Publish a .NET MAUI iOS app for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) (Microsoft Learn)
- [Manual iOS Provisioning, dotnet/maui#7056](https://github.com/dotnet/maui/issues/7056) (GitHub)
- [Khalid Abuhakmeh: Fix .NET MAUI MissingEntitlement and Provisioning Profiles Issues](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues)
