---
title: "Monetizing a .NET MAUI app with AdMob (banner, interstitial, rewarded) in 2026"
description: "A practical, end-to-end guide to monetizing a .NET MAUI app with Google AdMob using Plugin.AdMob. Install one NuGet, call UseAdMob(), and wire up banner, interstitial, and rewarded ads — with consent built in via UMP, test ad units, the exact service APIs, preloading patterns, and a production checklist. Tested on .NET 10 / MAUI."
pubDate: 2026-07-24
template: how-to
tags:
  - "maui"
  - "dotnet"
  - "admob"
  - "how-to"
---

Short answer: install the [`Plugin.AdMob`](https://github.com/marius-bughiu/Plugin.AdMob) NuGet package, call `UseAdMob()` on your app builder, and you get all three of the workhorse ad formats — **banner** (a XAML control), **interstitial**, and **rewarded** (both injectable services) — on Android and iOS, with GDPR consent handled for you through Google's User Messaging Platform. No per-platform handlers, no binding-conflict yak-shaving. This guide wires up all three from an empty project, shows the exact APIs, and covers the parts that actually matter in production: test units, preloading, consent, and frequency.

This is the modern replacement for the hand-rolled banner handler I wrote back in [How to: Add AdMob to your MAUI app](/2023/11/how-to-add-admob-to-your-maui-app/) — that post is still a good read if you want to see what the plugin does for you under the hood, but you no longer need to write any of it.

Fully supported on **Android and iOS**. On MacCatalyst and Windows the plugin still registers handlers so your app compiles and runs cross-platform — the ad calls are simply no-ops there, so you don't have to `#if` them out.

## The three formats at a glance

Before the code, pick the right format for the right moment. Mixing them badly is the fastest way to tank retention.

| Format | What it is | Good for | The rule |
| --- | --- | --- | --- |
| **Banner** | A small, persistent strip embedded in your layout | Content screens the user dwells on (lists, readers) | Keep it out of the way of taps; never over content the user needs |
| **Interstitial** | A full-screen ad shown at a natural break | Between levels, after finishing a task, on navigation boundaries | Show at *transitions*, never mid-interaction, and never back-to-back |
| **Rewarded** | Full-screen, opt-in, pays the user a reward on completion | "Watch an ad for a hint / extra life / to unlock X" | Always user-initiated; grant the reward only from the reward callback |

Banner is passive revenue. Interstitial is the highest-yield format you can overdo. Rewarded is the one users actually *like*, because they chose it and got something for it.

## Step 0 — Install, initialize, and configure the platforms

Install the package (this pulls in the Android and iOS Google Mobile Ads bindings — all published on nuget.org now, no local feed needed):

```
dotnet add package Plugin.AdMob
```

Register the plugin in `MauiProgram.cs`. This single call registers `IInterstitialAdService`, `IRewardedAdService`, the consent service, and every ad-view handler in the DI container:

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

### Android manifest

In `Platforms/Android/AndroidManifest.xml`, add the AdMob activity, the network permissions, and your **AdMob application ID** as a `meta-data` element inside `<application>` (the value below is Google's public test app ID — swap it for your own before shipping):

```xml
<manifest ...>
  <application ...>
    <activity android:name="com.google.android.gms.ads.AdActivity"
              android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|uiMode|screenSize|smallestScreenSize"
              android:theme="@android:style/Theme.Translucent" />
    <meta-data
        android:name="com.google.android.gms.ads.APPLICATION_ID"
        android:value="ca-app-pub-3940256099942544~3347511713" />
  </application>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.INTERNET" />
</manifest>
```

Set the minimum Android version to **23** in your `.csproj` — Google Play Services requires it, and a lower value throws manifest-merger errors on .NET 10:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
    <SupportedOSPlatformVersion>23.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

### iOS Info.plist and AppDelegate

Add your `GADApplicationIdentifier` and the `SKAdNetworkItems` list (per [Google's iOS quick-start](https://developers.google.com/admob/ios/quick-start)), plus the App Manager flag and App Tracking Transparency string, to `Platforms/iOS/Info.plist`:

```xml
<key>GADIsAdManagerApp</key>
<true/>
<key>NSUserTrackingUsageDescription</key>
<string>This identifier will be used to deliver personalized ads to you.</string>
<key>MinimumOSVersion</key>
<string>15.0</string>
```

Start the Mobile Ads SDK in `Platforms/iOS/AppDelegate.cs`:

```cs
[Register("AppDelegate")]
public class AppDelegate : MauiUIApplicationDelegate
{
    protected override MauiApp CreateMauiApp()
    {
        var app = MauiProgram.CreateMauiApp();
        Google.MobileAds.MobileAds.SharedInstance.Start(completionHandler: null);
        return app;
    }
}
```

Set the minimum iOS version to **15.0** (the SDK requires it — without it `MobileAds.Start` can `NullReferenceException` on device), and, from plugin 2.0.0 onward, add the Swift-linking target to your `.csproj`. Both snippets are in the [Setup docs](https://github.com/marius-bughiu/Plugin.AdMob/blob/main/docs/Setup.md); I'll skip them here to keep this readable.

### Use test ads during development

Do **not** click your own live ads — AdMob will flag the account. Instead, flip one switch and the plugin routes every request to Google's safe-to-tap test units:

```cs
using Plugin.AdMob.Configuration;

AdConfig.UseTestAdUnitIds = true;
```

With that set, you can omit `AdUnitId` everywhere and still get test creatives. Set it from a debug guard so it never ships enabled:

```cs
#if DEBUG
AdConfig.UseTestAdUnitIds = true;
#endif
```

When testing on a physical device against your *real* units, register it as a test device instead so you get test creatives without risking your account:

```cs
AdConfig.AddTestDevice("<your-test-device-id>");
```

### Consent is on by default (and that's the point)

Since plugin `1.3.0`, consent is handled automatically through Google's User Messaging Platform. If the user is in a region that requires it, the consent form shows on startup, and **ad requests are held until consent is resolved**. You don't have to write anything — but you *do* have to configure the messages in AdMob's **Privacy & messaging** section, or the form never appears and (correctly) no ads load. Full control lives in `IAdConsentService`; see the [Consent docs](https://github.com/marius-bughiu/Plugin.AdMob/blob/main/docs/Consent.md). In 2026 this is not optional polish — it's the difference between serving ads and serving nothing across the EEA and UK.

## Banner ads

A banner is a XAML control. Declare the namespace and drop it into a layout — ideally pinned to the bottom of a content page so it doesn't fight your UI:

```xml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:admob="clr-namespace:Plugin.AdMob;assembly=Plugin.AdMob"
             x:Class="MyApp.FeedPage">
    <Grid RowDefinitions="*,Auto">
        <!-- your content -->
        <CollectionView Grid.Row="0" ItemsSource="{Binding Items}" />

        <!-- ad pinned to the bottom -->
        <admob:BannerAd Grid.Row="1"
                        AdUnitId="ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                        AdSize="Banner" />
    </Grid>
</ContentPage>
```

`AdUnitId` is optional when `AdConfig.UseTestAdUnitIds` is `true`. Pick a size with the `AdSize` property:

| AdSize | Width × Height | Notes |
| --- | --- | --- |
| `SmartBanner` | Screen width × 32/50/90 | Adapts height to the device |
| `Banner` | 320 × 50 | The classic |
| `LargeBanner` | 320 × 100 | |
| `MediumRectangle` | 300 × 250 | Higher yield; use in-feed, not as a strip |
| `FullBanner` | 468 × 60 | Tablet |
| `Leaderboard` | 728 × 90 | Tablet |
| `Custom` | `CustomAdWidth` × `CustomAdHeight` | See below |

For a custom size, set `AdSize="Custom"` and supply the dimensions in density-independent pixels:

```xml
<admob:BannerAd AdSize="Custom" CustomAdWidth="200" CustomAdHeight="200" />
```

The control exposes an `IsLoaded` property and a full set of events, so you can react to the ad's lifecycle — for example, only reveal the container once an ad actually fills:

```xml
<admob:BannerAd x:Name="Banner"
                AdUnitId="ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                OnAdLoaded="OnBannerLoaded"
                OnAdFailedToLoad="OnBannerFailed" />
```

```cs
private void OnBannerLoaded(object? sender, EventArgs e)
    => Banner.IsVisible = true;   // no empty gap while it loads or if it fails

private void OnBannerFailed(object? sender, EventArgs e)
    => Banner.IsVisible = false;
```

The available banner events:

| Event | When it fires |
| --- | --- |
| `OnAdLoaded` | An ad was received |
| `OnAdFailedToLoad` | The request failed |
| `OnAdImpression` | An impression was recorded |
| `OnAdClicked` | A click was recorded |
| `OnAdOpened` | The ad opened a screen-covering overlay |
| `OnAdClosed` | The user is about to return to your app after a click |
| `OnAdSwiped` | A swipe was counted as a click (**Android only**) |

## Interstitial ads

Interstitials are full-screen, so they're a *service*, not a view. Two things matter: **preload before you need it**, and **only show a loaded ad**. Fetching an ad takes a network round-trip; if you call show-on-demand you'll get nothing.

Inject `IInterstitialAdService` (or resolve it from the service provider), preload with `PrepareAd()`, and show at your transition:

```cs
using Plugin.AdMob.Services;

public partial class GamePage : ContentPage
{
    private readonly IInterstitialAdService _interstitialAds;

    public GamePage(IInterstitialAdService interstitialAds)
    {
        InitializeComponent();
        _interstitialAds = interstitialAds;

        // Preload early — e.g. when the level starts — so the ad is ready
        // by the time the level ends.
        _interstitialAds.PrepareAd("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");
    }

    private void OnLevelCompleted()
    {
        if (_interstitialAds.IsAdLoaded)
            _interstitialAds.ShowAd();   // no-op if nothing is prepared
    }
}
```

If you prefer not to use constructor injection, grab it from the container:

```cs
var interstitialAds = IPlatformApplication.Current!.Services
    .GetRequiredService<IInterstitialAdService>();
```

The service interface:

```cs
public interface IInterstitialAdService
{
    bool IsAdLoaded { get; }

    IInterstitialAd CreateAd(string? adUnitId = null);
    void PrepareAd(string? adUnitId = null);
    void ShowAd();

    event EventHandler OnAdLoaded;
}
```

`PrepareAd()` and `CreateAd()` both fall back to `AdConfig.DefaultInterstitialAdUnitId` when you pass no ID (more on defaults below). `IsAdLoaded` is `true` once an ad is ready; the service-level `OnAdLoaded` event fires at the same moment if you'd rather show reactively than poll.

### Re-preloading after dismiss (the CreateAd path)

The single-slot `PrepareAd`/`ShowAd` pair is the easy path, but it has no dismiss callback — after an ad is shown, you need to call `PrepareAd()` again for the next one. When you want per-ad lifecycle control (to preload the *next* interstitial the moment the current one closes), use `CreateAd()` and drive the returned `IInterstitialAd` yourself:

```cs
public interface IInterstitialAd
{
    string AdUnitId { get; }
    bool IsLoaded { get; }

    event EventHandler OnAdLoaded;
    event EventHandler<IAdError> OnAdFailedToLoad;
    event EventHandler OnAdShowed;
    event EventHandler<IAdError> OnAdFailedToShow;
    event EventHandler OnAdImpression;
    event EventHandler OnAdClicked;
    event EventHandler OnAdDismissed;

    void Load();
    void Show();
}
```

A self-refilling interstitial that's always ready for the next transition:

```cs
private IInterstitialAd? _ad;

private void PreloadInterstitial()
{
    _ad = _interstitialAds.CreateAd("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");

    // As soon as one is dismissed, load the next.
    _ad.OnAdDismissed += (_, _) => PreloadInterstitial();
    _ad.OnAdFailedToLoad += (_, err) =>
        System.Diagnostics.Debug.WriteLine($"Interstitial failed: {err.Message}");

    _ad.Load();
}

private void ShowInterstitialIfReady()
{
    if (_ad?.IsLoaded == true)
        _ad.Show();
}
```

> **Frequency matters more than any code here.** Cap interstitials to natural breaks, put a cooldown between them (a couple of minutes, or every N transitions), and never show one on app launch or mid-gesture. Google's own guidance is that too-frequent interstitials increase uninstalls; frequency capping in the AdMob console is worth setting too.

## Rewarded ads

Rewarded ads are the polite format: the user opts in ("Watch an ad to earn 50 coins"), and you grant the reward **only when the reward callback fires** — not when the ad is shown, and not when it's dismissed. The plugin gives you the reward through a callback on `PrepareAd`, or an `OnUserEarnedReward` event on the ad instance.

The simplest path mirrors interstitials, with one extra parameter — the reward callback:

```cs
using Plugin.AdMob;          // RewardItem
using Plugin.AdMob.Services;

public partial class StorePage : ContentPage
{
    private readonly IRewardedAdService _rewardedAds;

    public StorePage(IRewardedAdService rewardedAds)
    {
        InitializeComponent();
        _rewardedAds = rewardedAds;
        PreloadReward();
    }

    private void PreloadReward()
    {
        // The onUserEarnedReward callback fires only if the user completes the ad.
        _rewardedAds.PrepareAd(
            "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx",
            onUserEarnedReward: reward => GrantReward(reward));
    }

    private void OnWatchAdForCoinsClicked(object sender, EventArgs e)
    {
        if (_rewardedAds.IsAdLoaded)
            _rewardedAds.ShowAd();
        else
            DisplayAlert("Not ready", "No ad available right now — try again shortly.", "OK");
    }

    private void GrantReward(RewardItem reward)
    {
        // reward.Type and reward.Amount come from your AdMob ad unit config.
        Wallet.Add(reward.Amount);
        PreloadReward();   // preload the next one
    }
}
```

`RewardItem` is a small record — the values come from how you configured the reward on the ad unit in the AdMob console:

```cs
public sealed record RewardItem(int Amount, string Type);
```

The service interface:

```cs
public interface IRewardedAdService
{
    bool IsAdLoaded { get; }

    IRewardedAd CreateAd(string? adUnitId = null);
    void PrepareAd(string? adUnitId = null, Action<RewardItem>? onUserEarnedReward = null);
    void ShowAd();

    event EventHandler OnAdLoaded;
}
```

When you pass no ID it falls back to `AdConfig.DefaultRewardedAdUnitId`. As with interstitials, `CreateAd()` returns a fully controllable `IRewardedAd` when you want per-ad events — including the dedicated `OnUserEarnedReward`:

```cs
public interface IRewardedAd
{
    string AdUnitId { get; }
    bool IsLoaded { get; }

    event EventHandler OnAdLoaded;
    event EventHandler<IAdError> OnAdFailedToLoad;
    event EventHandler OnAdShowed;
    event EventHandler<IAdError> OnAdFailedToShow;
    event EventHandler OnAdImpression;
    event EventHandler OnAdClicked;
    event EventHandler OnAdDismissed;
    event EventHandler<RewardItem> OnUserEarnedReward;

    void Load();
    void Show();
}
```

The critical distinction: **`OnAdDismissed` is not the same as `OnUserEarnedReward`.** A user can dismiss the ad early without earning anything. Grant value from `OnUserEarnedReward` only — treating dismissal as completion is how people farm free rewards.

```cs
var ad = _rewardedAds.CreateAd("ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx");

ad.OnUserEarnedReward += (_, reward) => Wallet.Add(reward.Amount);   // ✅ grant here
ad.OnAdDismissed      += (_, _) => PreloadNextReward();               // ❌ NOT here

ad.Load();
```

## Set default ad unit IDs once

Threading ad unit ID strings through every call site gets old. Set them once via `AdConfig` (or pass them to `UseAdMob(...)`), then call `PrepareAd()` / `CreateAd()` with no arguments:

```cs
using Plugin.AdMob.Configuration;

AdConfig.DefaultBannerAdUnitId       = "ca-app-pub-.../...";
AdConfig.DefaultInterstitialAdUnitId = "ca-app-pub-.../...";
AdConfig.DefaultRewardedAdUnitId     = "ca-app-pub-.../...";
```

Now `_interstitialAds.PrepareAd()` and `_rewardedAds.PrepareAd(onUserEarnedReward: GrantReward)` resolve their units from config. Keep separate IDs per platform (Android and iOS ad units are different) and select at runtime, or store them in your platform config.

## Going to production — the checklist

- [ ] **Real ad unit IDs** wired in (per platform), and `AdConfig.UseTestAdUnitIds` guarded behind `#if DEBUG` so it can't ship on.
- [ ] **Your own AdMob app ID** in the Android manifest `meta-data` and the iOS `GADApplicationIdentifier` — the test IDs above are placeholders.
- [ ] **Consent messages configured** in AdMob's *Privacy & messaging* section, and tested in an EEA/UK geography using `UseConsentDebugSettings` on a registered test device.
- [ ] **App Tracking Transparency** string present in `Info.plist` (`NSUserTrackingUsageDescription`) — iOS ad fill collapses without it.
- [ ] **Frequency caps** set in the AdMob console for interstitials, and reasonable cooldowns in code.
- [ ] **Rewards granted only from the reward callback**, never from show or dismiss.
- [ ] Verified on a **real device** — emulators fill inconsistently, and iOS in particular needs iOS 15+ and the Swift-linking target.

## Gotchas checklist

- **`ShowAd()` does nothing** — you're showing before the ad loaded. Preload with `PrepareAd()` and gate `ShowAd()` on `IsAdLoaded` (or the `OnAdLoaded` event).
- **No ads at all in the EEA/UK** — expected until consent resolves. Configure the messages in AdMob; the plugin holds requests until then by design.
- **Interstitial only shows once** — the `PrepareAd`/`ShowAd` service slot doesn't auto-refill. Call `PrepareAd()` again, or use `CreateAd()` and re-load in `OnAdDismissed`.
- **Rewards being farmed** — you're granting on `OnAdDismissed`. Move it to `OnUserEarnedReward`.
- **`MobileAds.Start` NREs on iOS device** — set `SupportedOSPlatformVersion` to `15.0` and add `MinimumOSVersion` to `Info.plist`.
- **Manifest-merger errors on .NET 10 Android** — raise `SupportedOSPlatformVersion` to `23.0`.
- **Ads render on Windows/MacCatalyst?** They don't — the handlers register so you compile cross-platform, but nothing displays there. That's intended, not a bug.

### Read next

- [Plugin.AdMob on GitHub](https://github.com/marius-bughiu/Plugin.AdMob) — source, docs, and a full working sample app covering every format
- [How to show native video ads in your .NET MAUI app with Plugin.AdMob](/2026/07/how-to-show-native-video-ads-in-your-maui-app-with-plugin-admob/) — the native-ad format, including video
- [How to: Add AdMob to your MAUI app](/2023/11/how-to-add-admob-to-your-maui-app/) — the manual banner handler, for when you want to see what the plugin abstracts away
