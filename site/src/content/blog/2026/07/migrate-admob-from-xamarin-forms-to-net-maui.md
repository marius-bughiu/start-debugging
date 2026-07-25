---
title: "Migrate AdMob from Xamarin.Forms to .NET MAUI with Plugin.AdMob"
description: "Port your ads layer from Xamarin.Forms to .NET MAUI: what to delete (MTAdmob, custom AdView renderers, Xamarin.GooglePlayServices.Ads bindings), what replaces it in Plugin.AdMob, and a line-by-line API mapping for banner, interstitial, rewarded, rewarded interstitial and app open — plus the singleton-to-DI shift and the UMP consent gap that stops ads serving in the EEA."
pubDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "admob"
  - "dotnet"
---

Short answer: delete your entire Xamarin ads layer — the `MarcTron.Admob` package, or the hand-written `ViewRenderer` over `Xamarin.GooglePlayServices.Ads` — and replace it with [`Plugin.AdMob`](https://github.com/marius-bughiu/Plugin.AdMob): one NuGet, one `UseAdMob()` call on the app builder, a `<admob:BannerAd />` control in XAML, and injectable services for every full-screen format. The shape of the port is the same regardless of where you're coming from: **a singleton with static events becomes DI-registered services with per-ad instances**, and the consent plumbing you either paid for or wrote by hand comes built in.

This is the ads-specific companion to [Migrate from Xamarin.Forms 5.0 to .NET MAUI 11](/2026/05/migrate-from-xamarin-forms-to-maui-11/). Do the project-system migration first; ads are the last thing you want fighting a broken build. Pinned versions here: `Plugin.AdMob 10.0.90` (published 2026-07-23) on .NET 10 MAUI, migrating from `MarcTron.Admob 2.4.0` on Xamarin.Forms 5.0.

## Why this can't wait for "later"

- **Xamarin.Forms went out of support on 2024-05-01.** The Google Mobile Ads bindings that Xamarin apps consume (`Xamarin.GooglePlayServices.Ads`, `Xamarin.Google.iOS.MobileAds`) stopped tracking Google's SDK releases with it. You are shipping against a frozen ad SDK.
- **Consent is a serving requirement, not a nice-to-have.** Since Google's January 2024 enforcement, ad requests from EEA and UK users without a Google-certified CMP simply don't fill. If your Xamarin app is quietly earning nothing in Europe, this is usually why.
- **The ad units survive the migration.** Your AdMob account, app IDs, ad unit IDs, and historical reporting all carry over untouched. This is a code migration, not an account migration — nothing on the AdMob side needs to change.

## Where your ad code lives today

Three starting points, and the port is slightly different for each:

| Starting point | What you have | Migration difficulty |
| --- | --- | --- |
| **MTAdmob** (`MarcTron.Admob`) | `CrossMTAdmob.Current` singleton, `MTAdView` in XAML, static events per format | Low — mostly mechanical renames |
| **Hand-rolled renderer** | A `Xamarin.Forms.View` subclass, `ViewRenderer<AdMobView, AdView>` per platform, `[assembly: ExportRenderer]`, `DependencyService` for interstitials | Medium — but you delete more than you write |
| **Platform bindings only** | `AdView` / `InterstitialAd` used directly inside the Android and iOS head projects | Medium — the platform code has no MAUI equivalent and is deleted outright |

All three collapse onto the same destination, so the mapping tables below apply whichever one you're on.

> If you're on MTAdmob today, there is a first-party MAUI port — `Plugin.MauiMTAdmob` — and staying on it is a legitimate choice with the smallest diff. The reasons this guide uses Plugin.AdMob instead: it's MIT-licensed with **no paid tier for UMP consent** (MTAdmob gates its consent support behind a purchased license), it registers through the MAUI DI container rather than a static singleton, and it exposes per-ad instances so you can preload and refill ads independently. Pick on those merits, not on migration cost — both ports are a day's work.

## What changes

| Area | Xamarin.Forms | .NET MAUI + Plugin.AdMob | Severity |
| --- | --- | --- | --- |
| Entry point | `CrossMTAdmob.Current` singleton / `DependencyService` | `builder.UseAdMob()` + constructor injection | high |
| Banner | `MTAdView` or custom renderer | `<admob:BannerAd />` control | high |
| Full-screen ads | Static methods + static events on one object | `IInterstitialAdService`, `IRewardedAdService`, `IAppOpenAdService` | high |
| Ad lifecycle | Global events shared by every ad | Per-ad instances via `CreateAd()` with their own events | high |
| Platform init | `MobileAds.Initialize(this)` in `MainActivity` | Nothing on Android; one `MobileAds.SharedInstance.Start` call on iOS | medium |
| Renderers | `ExportRenderer` + `ViewRenderer` per platform | Deleted — the plugin registers its own handlers | medium |
| Consent (UMP) | Licensed feature or hand-rolled | Automatic on startup, free | medium |
| Minimum OS | Whatever Xamarin allowed | Android **23**, iOS **15.0** | medium |
| Windows / Mac Catalyst | Not applicable | Compiles and runs; ad calls are no-ops | low |

## Step 1 — Delete the old ads layer

Do the deletions first and in one commit. Leaving both stacks referenced produces duplicate Google Mobile Ads bindings and a link step that fails in ways that don't name the real culprit.

Remove from the project file and from every `using`:

- `MarcTron.Admob` / `Plugin.MtAdmob`
- `Xamarin.GooglePlayServices.Ads` and `Xamarin.GooglePlayServices.Ads.Lite`
- `Xamarin.Google.iOS.MobileAds` / `Xamarin.Firebase.iOS.AdMob`
- Any UMP binding you added by hand for the consent form

Then delete the code:

```cs
// Delete: the whole renderer, both platform copies.
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobViewRenderer))]
namespace MyApp.Droid.Renderers;

public class AdMobViewRenderer : ViewRenderer<AdMobView, AdView>
{
    protected override void OnElementChanged(ElementChangedEventArgs<AdMobView> e)
    {
        // ~80 lines of AdView construction, AdRequest.Builder, and
        // layout math that Plugin.AdMob's handler now does for you.
    }
}
```

```cs
// Delete: MainActivity.cs
MobileAds.Initialize(this);
```

Android needs no initialization call at all with the plugin — `UseAdMob()` covers it. On iOS you keep exactly one line, which we'll add back in Step 3.

Keep your `AndroidManifest.xml` `APPLICATION_ID` meta-data and your `Info.plist` `GADApplicationIdentifier`. Those are the same values in MAUI, and re-typing them is how people end up shipping Google's test app ID.

## Step 2 — Install and register

```bash
dotnet add package Plugin.AdMob
```

The package version tracks the MAUI version it targets — `10.0.90` targets MAUI 10.0.90 — so match the major to your MAUI version rather than looking for a "3.x" successor. (The scheme changed after `3.0.3`; the 10.x numbers are newer, not older.)

Register it in `MauiProgram.cs`. This one call registers every ad-view handler plus `IInterstitialAdService`, `IRewardedAdService`, `IAppOpenAdService`, and `IAdConsentService` in the container:

```cs
public static MauiApp CreateMauiApp()
{
    var builder = MauiApp.CreateBuilder();
    builder
        .UseMauiApp<App>()
        .UseAdMob();

    return builder.Build();
}
```

If your MAUI head targets Windows as well, scope the package reference so restore doesn't trip over the mobile-only targets:

```xml
<ItemGroup Condition="'$(TargetFramework)' == 'net10.0-android' Or '$(TargetFramework)' == 'net10.0-ios'">
  <PackageReference Include="Plugin.AdMob" Version="10.0.90" />
</ItemGroup>
```

## Step 3 — Platform configuration

Two values are non-negotiable and are the most common cause of "it built, it runs, no ads":

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
    <SupportedOSPlatformVersion>23.0</SupportedOSPlatformVersion>
</PropertyGroup>
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-ios'">
    <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

Xamarin.Forms projects routinely sat at API 21 and iOS 11. Google Play Services requires Android 23 — below it you get manifest-merger errors on .NET 10 — and the Google Mobile Ads SDK requires iOS 15, below which `MobileAds.SharedInstance.Start(...)` can throw a `NullReferenceException` on a physical device. Add the matching `MinimumOSVersion` key to `Info.plist` too, or Release builds fail.

Your Android manifest needs the `AdActivity` entry alongside the app ID you kept from Step 1:

```xml
<activity android:name="com.google.android.gms.ads.AdActivity"
          android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|uiMode|screenSize|smallestScreenSize"
          android:theme="@android:style/Theme.Translucent" />
```

On iOS, put the SDK start call in `AppDelegate.cs` — this is the one piece of platform code that survives the migration:

```cs
protected override MauiApp CreateMauiApp()
{
    var app = MauiProgram.CreateMauiApp();
    Google.MobileAds.MobileAds.SharedInstance.Start(completionHandler: null);
    return app;
}
```

iOS also needs a Swift-linking MSBuild target in the app `.csproj` — new since plugin 2.0.0, and there's no Xamarin equivalent to migrate, so copy it verbatim from the [Setup docs](https://github.com/marius-bughiu/Plugin.AdMob/blob/main/docs/Setup.md). Without it the native link step fails with unresolved Swift symbols.

## Step 4 — Banner ads

The XAML swap is close to a find-and-replace. Old:

```xml
xmlns:controls="clr-namespace:MarcTron.Plugin.Controls;assembly=Plugin.MtAdmob"

<controls:MTAdView x:Name="myAds"
                   AdsId="ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                   AdSize="AnchoredAdaptive"
                   PersonalizedAds="true" />
```

New:

```xml
xmlns:admob="clr-namespace:Plugin.AdMob;assembly=Plugin.AdMob"

<admob:BannerAd x:Name="Banner"
                AdUnitId="ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                AdSize="SmartBanner" />
```

Three differences worth knowing before you run find-and-replace:

- **`AdsId` → `AdUnitId`.** Different name, same value.
- **`PersonalizedAds` has no direct equivalent, by design.** Personalization is decided by the UMP consent result now, not by a bindable property. Drop the attribute; Step 8 covers what replaces it.
- **`AdSize` values don't line up.** Plugin.AdMob offers `SmartBanner`, `Banner`, `LargeBanner`, `MediumRectangle`, `FullBanner`, `Leaderboard`, and `Custom`. If you were using `AnchoredAdaptive`, `SmartBanner` is the closest behaviour — it fills the screen width and picks its height from the device. For anything else, set `AdSize="Custom"` with `CustomAdWidth` and `CustomAdHeight` in device-independent pixels.

Banner events are renamed but map one-to-one:

| MTAdmob | Plugin.AdMob |
| --- | --- |
| `AdsClicked` | `OnAdClicked` |
| `AdsOpened` | `OnAdOpened` |
| `AdsClosed` | `OnAdClosed` |
| `AdsImpression` | `OnAdImpression` |
| — | `OnAdLoaded`, `OnAdFailedToLoad`, `OnAdSwiped` (Android) |

Those last three have no MTAdmob counterpart, and `OnAdLoaded` is the one to adopt immediately — it's what lets you avoid the empty gap that every Xamarin banner layout reserved unconditionally:

```xml
<admob:BannerAd x:Name="Banner"
                IsVisible="False"
                OnAdLoaded="OnBannerLoaded"
                OnAdFailedToLoad="OnBannerFailed" />
```

```cs
private void OnBannerLoaded(object? sender, EventArgs e) => Banner.IsVisible = true;
private void OnBannerFailed(object? sender, EventArgs e) => Banner.IsVisible = false;
```

**Coming from a custom renderer instead?** You delete the renderer, the `View` subclass, the `ExportRenderer` attribute, and the platform layout code, and you write the six lines of XAML above. There is no handler to register — `UseAdMob()` registers the plugin's own.

## Step 5 — Interstitial ads

This is where the singleton-to-DI shift shows up. Old:

```cs
CrossMTAdmob.Current.OnInterstitialLoaded += Current_OnInterstitialLoaded;
CrossMTAdmob.Current.OnInterstitialClosed += Current_OnInterstitialClosed;

CrossMTAdmob.Current.LoadInterstitial("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");

if (CrossMTAdmob.Current.IsInterstitialLoaded())
    CrossMTAdmob.Current.ShowInterstitial();
```

New — inject the service, and the call sites read almost the same:

```cs
using Plugin.AdMob.Services;

public partial class GamePage : ContentPage
{
    private readonly IInterstitialAdService _interstitialAds;

    public GamePage(IInterstitialAdService interstitialAds)
    {
        InitializeComponent();
        _interstitialAds = interstitialAds;

        _interstitialAds.PrepareAd("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");
    }

    private void OnLevelCompleted()
    {
        if (_interstitialAds.IsAdLoaded)
            _interstitialAds.ShowAd();
    }
}
```

Register the page in the container (`builder.Services.AddTransient<GamePage>()`) so constructor injection resolves. If you have pages you'd rather not convert yet, resolve the service directly — it's the closest thing to the old singleton and a reasonable staging step:

```cs
var interstitialAds = IPlatformApplication.Current!.Services
    .GetRequiredService<IInterstitialAdService>();
```

The method mapping:

| MTAdmob | Plugin.AdMob |
| --- | --- |
| `LoadInterstitial(id)` | `IInterstitialAdService.PrepareAd(id)` |
| `ShowInterstitial()` | `IInterstitialAdService.ShowAd()` |
| `IsInterstitialLoaded()` | `IInterstitialAdService.IsAdLoaded` (property, not a method) |
| `OnInterstitialLoaded` | `IInterstitialAdService.OnAdLoaded` |
| `OnInterstitialClosed` | `IInterstitialAd.OnAdDismissed` (per-ad, see below) |
| `OnInterstitialFailedToLoad` | `IInterstitialAd.OnAdFailedToLoad` |
| `OnInterstitialFailedToShow` | `IInterstitialAd.OnAdFailedToShow` |
| `OnInterstitialOpened` | `IInterstitialAd.OnAdShowed` |
| `OnInterstitialClicked` / `OnInterstitialImpression` | `IInterstitialAd.OnAdClicked` / `OnAdImpression` |

Note the split: the *service* exposes only `IsAdLoaded`, `OnAdLoaded`, `PrepareAd`, `ShowAd`, and `CreateAd`. Everything else lives on an ad instance. If you relied on `OnInterstitialClosed` to load the next ad — the standard MTAdmob pattern — you need `CreateAd()`:

```cs
private IInterstitialAd? _ad;

private void PreloadInterstitial()
{
    _ad = _interstitialAds.CreateAd("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");
    _ad.OnAdDismissed += (_, _) => PreloadInterstitial();   // self-refilling
    _ad.Load();
}
```

This is strictly better than what you had. In MTAdmob those events were global, so a handler attached on page A fired for an ad shown from page B — the reason so many Xamarin codebases carry a `_shouldSetEvents` flag to avoid double subscription. Per-ad instances make that class of bug impossible.

## Step 6 — Rewarded ads

Same shape, plus the reward callback:

```cs
// Old
CrossMTAdmob.Current.OnUserEarnedReward += (s, e) => Wallet.Add(50);
CrossMTAdmob.Current.LoadRewarded("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");
if (CrossMTAdmob.Current.IsRewardedLoaded())
    CrossMTAdmob.Current.ShowRewarded();
```

```cs
// New
using Plugin.AdMob;          // RewardItem
using Plugin.AdMob.Services;

_rewardedAds.PrepareAd(
    "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx",
    onUserEarnedReward: reward => Wallet.Add(reward.Amount));

if (_rewardedAds.IsAdLoaded)
    _rewardedAds.ShowAd();
```

| MTAdmob | Plugin.AdMob |
| --- | --- |
| `LoadRewarded(id)` | `IRewardedAdService.PrepareAd(id, onUserEarnedReward)` |
| `ShowRewarded()` | `IRewardedAdService.ShowAd()` |
| `IsRewardedLoaded()` | `IRewardedAdService.IsAdLoaded` |
| `OnUserEarnedReward` | the `onUserEarnedReward` callback, or `IRewardedAd.OnUserEarnedReward` |
| `OnRewardedClosed` | `IRewardedAd.OnAdDismissed` |
| `OnRewardedFailedToLoad` / `OnRewardedFailedToShow` | `IRewardedAd.OnAdFailedToLoad` / `OnAdFailedToShow` |
| `OnRewardedLoaded` / `OnRewardedOpened` | `IRewardedAd.OnAdLoaded` / `OnAdShowed` |

One upgrade to make while you're in here: MTAdmob's `OnUserEarnedReward` gave you an event with no reward payload, so most Xamarin apps hard-coded the amount at the call site. Plugin.AdMob hands you a `RewardItem`:

```cs
public sealed record RewardItem(int Amount, string Type);
```

Read `reward.Amount` and `reward.Type` from the callback instead of the hard-coded constant, and the reward becomes configurable from the AdMob console without an app update. And as always: grant from the reward callback, never from `OnAdDismissed` — a user can dismiss early without earning.

## Step 7 — Rewarded interstitial and app open

Both formats exist on each side and follow the identical pattern, so the port is mechanical:

| MTAdmob | Plugin.AdMob |
| --- | --- |
| `LoadRewardedInterstitial(id)` / `ShowRewardedInterstitial()` / `IsRewardedInterstitialLoaded()` | `IRewardedInterstitialAdService.PrepareAd(id, onUserEarnedReward)` / `ShowAd()` / `IsAdLoaded` |
| `OnAppOpenAdLoaded`, `OnAppOpenOpened`, `OnAppOpenClosed`, … | `IAppOpenAdService` + `IAppOpenAd` events (`OnAdLoaded`, `OnAdShowed`, `OnAdDismissed`, …) |

App open ads are the one format where the MAUI version wants different code rather than just different names — you preload on startup and show on resume, driving an `IAppOpenAd` from `CreateAd()`. See the [App open ads docs](https://github.com/marius-bughiu/Plugin.AdMob/blob/main/docs/App-open-ads.md).

## Step 8 — Consent (the part that's actually worth the migration)

If your Xamarin app never shipped a certified CMP, this step is why your European fill rate is what it is.

Plugin.AdMob handles UMP automatically as of `1.3.0`: on startup, if the user's region requires it, the consent form shows, and **ad requests are held until consent resolves**. There is nothing to write. What there *is* to do — and it's not optional — is configure the messages in AdMob's **Privacy & messaging** section. If you skip that, the form never appears, and correctly, no ads load.

If you were using MTAdmob's licensed consent support, the API maps cleanly:

| MTAdmob | Plugin.AdMob |
| --- | --- |
| `ShowPrivacyOptionsForm()` | `IAdConsentService.ShowPrivacyOptionsForm()` |
| licensed automatic consent flow | on by default; opt out with `UseAdMob(automaticallyAskForConsent: false)` |
| — | `IAdConsentService.LoadAndShowConsentFormIfRequired()`, `CanRequestAds()`, `IsPrivacyOptionsRequired()`, `Reset()` |

You still need a "Privacy settings" entry point in your app — GDPR requires users be able to change their mind — so wire a menu item to `ShowPrivacyOptionsForm()`, gated on `IsPrivacyOptionsRequired()`:

```cs
if (_consent.IsPrivacyOptionsRequired())
    _consent.ShowPrivacyOptionsForm();
```

To verify before shipping, force an EEA geography on a registered test device:

```cs
builder
    .UseAdMob()
    .UseConsentDebugSettings(new ConsentDebugSettings
    {
        Geography = ConsentDebugGeography.Eea,
        Reset = true,
    });
```

`Reset = true` clears stored consent on every launch so you see the form each run. Strip both the debug settings and the reset before release.

## Step 9 — Global configuration and targeting

Your Xamarin app configured targeting on the singleton at startup; MAUI moves it to a static `AdConfig` or to `UseAdMob(...)` parameters. The enum names lose the `MT` prefix and the redundant repetition of the enum name in each member:

```cs
// Old
CrossMTAdmob.Current.TestDevices = new List<string> { "D70290758AB9D6060C3B14AA41DAB53A" };
CrossMTAdmob.Current.TagForChildDirectedTreatment =
    MTTagForChildDirectedTreatment.TagForChildDirectedTreatmentUnspecified;
CrossMTAdmob.Current.MaxAdContentRating = MTMaxAdContentRating.MaxAdContentRatingG;
```

```cs
// New
using Plugin.AdMob;
using Plugin.AdMob.Configuration;

AdConfig.AddTestDevice("D70290758AB9D6060C3B14AA41DAB53A");
AdConfig.TagForChildDirectedTreatment = TagForChildDirectedTreatment.Unspecified;
AdConfig.MaxAdContentRating = MaxAdContentRating.G;
```

Or pass them to the builder, which keeps startup configuration in one place:

```cs
builder.UseAdMob(
    tagForChildDirectedTreatment: TagForChildDirectedTreatment.None,
    tagForUnderAgeOfConsent: TagForUnderAgeOfConsent.None,
    maxAdContentRating: MaxAdContentRating.None);
```

| MTAdmob | Plugin.AdMob |
| --- | --- |
| `CrossMTAdmob.Current.TestDevices` | `AdConfig.TestDevices` / `AdConfig.AddTestDevice(id)` |
| `MTTagForChildDirectedTreatment.*` | `TagForChildDirectedTreatment.None` / `True` / `False` / `Unspecified` |
| `MTTagForUnderAgeOfConsent.*` | `TagForUnderAgeOfConsent.None` / `True` / `False` / `Unspecified` |
| `MTMaxAdContentRating.MaxAdContentRatingG` | `MaxAdContentRating.G` (also `PG`, `T`, `MA`, `None`) |
| `CrossMTAdmob.Current.AdsId` | `AdConfig.DefaultBannerAdUnitId` (plus a default per format) |
| `UserPersonalizedAds` | — (decided by UMP consent) |

Setting the per-format defaults is worth doing during the migration rather than after — it lets every `PrepareAd()` call site drop its ad unit ID string:

```cs
AdConfig.DefaultBannerAdUnitId       = "ca-app-pub-.../...";
AdConfig.DefaultInterstitialAdUnitId = "ca-app-pub-.../...";
AdConfig.DefaultRewardedAdUnitId     = "ca-app-pub-.../...";
```

## Step 10 — Test ads

During the port you'll be showing a lot of ads to yourself. Do not use live units for that; AdMob flags self-clicking accounts.

```cs
#if DEBUG
AdConfig.UseTestAdUnitIds = true;
#endif
```

With that set, every request routes to Google's test units and you can omit `AdUnitId` entirely — which conveniently means a half-migrated page still shows ads while you're mid-port. The `#if DEBUG` guard matters: this is exactly the flag that ships enabled and zeroes out a month of revenue.

## Verify before you ship

- [ ] Old packages gone from the `.csproj` — no `MarcTron.*`, no `Xamarin.GooglePlayServices.*`, no `Xamarin.Google.iOS.MobileAds`.
- [ ] Renderers and `ExportRenderer` attributes deleted; nothing references `Xamarin.Forms.Platform.*`.
- [ ] `SupportedOSPlatformVersion` at 23.0 (Android) and 15.0 (iOS), plus `MinimumOSVersion` in `Info.plist`.
- [ ] App ID carried over correctly — the manifest `meta-data` and `GADApplicationIdentifier` are yours, not Google's test ID.
- [ ] Consent messages configured in AdMob's *Privacy & messaging*, tested with `Geography = Eea` on a real device.
- [ ] `AdConfig.UseTestAdUnitIds` behind `#if DEBUG`, debug consent settings removed.
- [ ] Rewards granted from the reward callback, never from dismissal.
- [ ] Verified on physical Android **and** iOS hardware — emulators fill inconsistently, and the iOS Swift-link and minimum-version issues only surface on device.

## Gotchas from the port

- **Both stacks referenced at once.** Duplicate Google Mobile Ads bindings fail at the native link step with errors that name symbols, not packages. Delete the old references before adding the new one.
- **`ShowAd()` silently does nothing.** In MTAdmob, `ShowInterstitial(id)` could load-and-show in one call. `ShowAd()` never loads — it shows what `PrepareAd()` already fetched. Every show site needs a preload site.
- **The interstitial doesn't come back after the first one.** The service's `PrepareAd`/`ShowAd` slot doesn't auto-refill. Call `PrepareAd()` again, or move to `CreateAd()` and reload in `OnAdDismissed`.
- **Zero fill in the EEA after migrating.** Expected until consent resolves. Configure the AdMob messages — the plugin holds requests by design, and this is the correct behaviour, not a regression.
- **`IsInterstitialLoaded()` won't compile.** It's a property now: `IsAdLoaded`. Same for rewarded.
- **Your banner leaves a gap.** Xamarin layouts reserved banner height unconditionally because there was no load event. Bind visibility to `OnAdLoaded` / `IsLoaded` instead.
- **Constructor injection throws on a page you didn't register.** Pages resolving `IInterstitialAdService` must be in the container. Register them, or use `IPlatformApplication.Current.Services.GetRequiredService<T>()` while you finish the port.
- **Version numbers look like they went backwards.** `10.0.90` is newer than `3.0.3`; the scheme now tracks the targeted MAUI version.

### Read next

- [Monetizing a .NET MAUI app with AdMob (banner, interstitial, rewarded) in 2026](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) — the full reference for the destination API
- [Migrate from Xamarin.Forms 5.0 to .NET MAUI 11: the full checklist](/2026/05/migrate-from-xamarin-forms-to-maui-11/) — do this one first
- [How to show native video ads in your .NET MAUI app with Plugin.AdMob](/2026/07/how-to-show-native-video-ads-in-your-maui-app-with-plugin-admob/) — a format Xamarin never made easy
- [How to: Add AdMob to your MAUI app](/2023/11/how-to-add-admob-to-your-maui-app/) — the hand-rolled handler, for when you want to see what the plugin replaces

## Sources

- [Plugin.AdMob on GitHub](https://github.com/marius-bughiu/Plugin.AdMob) — source, docs, and samples
- [Plugin.AdMob setup documentation](https://github.com/marius-bughiu/Plugin.AdMob/blob/main/docs/Setup.md)
- [Plugin.AdMob consent documentation](https://github.com/marius-bughiu/Plugin.AdMob/blob/main/docs/Consent.md)
- [MTAdmob on GitHub](https://github.com/marcojak/MTAdmob) and the [Xamarin sample project](https://github.com/marcojak/XamarinMTAdmobSample)
- [Get started with AdMob on Android](https://developers.google.com/admob/android/quick-start) and [on iOS](https://developers.google.com/admob/ios/quick-start)
