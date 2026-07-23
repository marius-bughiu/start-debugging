---
title: "How to show native video ads in your .NET MAUI app with Plugin.AdMob"
description: "Plugin.AdMob now renders native video ads. Drop a MediaView into your NativeAdView template, request video with VideoOptions, and wire up the OnVideoStart/Play/Pause/End lifecycle events — including the custom-controls caveat that trips everyone up on AdMob inventory. Full walkthrough with a complete working example, tested on Android with the native video demo unit."
pubDate: 2026-07-23
template: how-to
tags:
  - "maui"
  - "dotnet"
  - "admob"
  - "how-to"
---

Short answer: as of today, [Plugin.AdMob](https://github.com/marius-bughiu/Plugin.AdMob) renders **native video** inside native ads. Drop an `<admob:MediaView />` into your `NativeAdView` ad template, pass a `VideoOptions` object when you create the ad, and the Google Mobile Ads SDK loads and plays the video for you — no `MediaElement`, no platform code. You get media metadata (`HasVideoContent`, `VideoAspectRatio`, `VideoDuration`) and a set of lifecycle events (`OnVideoStart`, `OnVideoPlay`, `OnVideoPause`, `OnVideoEnd`, `OnVideoMuted`) on the `INativeAd`. That is the whole feature. The rest of this guide is the wiring, the test ad units, and the one caveat — custom playback controls — that behaves differently on AdMob than the Google docs suggest.

Fully supported on **Android and iOS**. On MacCatalyst and Windows the plugin still registers handlers so your app compiles and runs cross-platform, but no ad is displayed there.

## Prerequisites

This builds on a working native-ads setup. If you have never wired up AdMob in MAUI, start with [How to: Add AdMob to your MAUI app](/2023/11/how-to-add-admob-to-your-maui-app/) — it covers the packages, the Android manifest entries, and the iOS `Info.plist` keys. The short version:

1. Install the `Plugin.AdMob` NuGet package (update to the latest version — native video shipped in the July 2026 release). The underlying Android and iOS binding packages are now published on nuget.org, so you no longer need a local NuGet feed.
2. Call `UseAdMob()` on your app builder in `MauiProgram.cs`:

```cs
builder.UseAdMob();
```

That registers `INativeAdService` (and the other ad services) in the DI container, and registers the `MediaView` handler on every platform.

## Step 1 — Add a MediaView to your ad template

A native ad is rendered by a `NativeAdView` whose `AdContent` is your own template. The template's binding context is the loaded `INativeAd`, so you bind `Headline`, `Body`, and the rest as usual. To show the ad's media — a video, or the main image when the creative has no video — place a `MediaView` in the template.

First, make sure the controls namespace is declared on your page:

```xml
xmlns:admob="clr-namespace:Plugin.AdMob;assembly=Plugin.AdMob"
```

Then put the `MediaView` inside your `AdContent`:

```xml
<admob:NativeAdView x:Name="AdView">
    <admob:NativeAdView.AdContent>
        <ContentView>
            <VerticalStackLayout Spacing="8">
                <admob:MediaView HeightRequest="200" />
                <Label Text="{Binding Headline}" FontAttributes="Bold" FontSize="18" />
                <Label Text="{Binding Body}" />
            </VerticalStackLayout>
        </ContentView>
    </admob:NativeAdView.AdContent>
</admob:NativeAdView>
```

You do not bind or configure the `MediaView` yourself. When the native ad is assigned, the platform handler walks the visual tree of your template, finds the `MediaView`, and attaches it to the native `NativeAdView` before the ad is set — so the SDK knows where to draw the media and takes over playback. Your only job is placement and sizing.

> Size the `MediaView` to the creative's aspect ratio to avoid letterboxing. After the ad loads you can read `INativeAd.VideoAspectRatio` (width ÷ height) and adjust — e.g. a 16:9 video reports `1.78`.

## Step 2 — Request video with VideoOptions

Media rendering works with the plain `CreateAd()` call, but to control playback you pass a `VideoOptions` to the new `CreateAd` overload. `VideoOptions` lives in `Plugin.AdMob.Configuration`:

```cs
using Plugin.AdMob;
using Plugin.AdMob.Configuration;
using Plugin.AdMob.Services;

public partial class MyPage : ContentPage
{
    private readonly INativeAdService _nativeAdService;

    // INativeAdService is resolved from DI once you've called UseAdMob().
    public MyPage(INativeAdService nativeAdService)
    {
        InitializeComponent();
        _nativeAdService = nativeAdService;
    }

    private void LoadVideoAd()
    {
        var nativeAd = _nativeAdService.CreateAd(
            "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx",
            new VideoOptions
            {
                StartMuted = true,           // defaults to true
                CustomControlsRequested = false,
                ClickToExpandRequested = false,
            });

        nativeAd.OnAdLoaded += (_, _) =>
        {
            AdView.BindingContext = nativeAd;   // template binds to the INativeAd
        };
        nativeAd.OnAdFailedToLoad += (_, error) =>
            System.Diagnostics.Debug.WriteLine($"Failed: {error.Message}");

        nativeAd.Load();
    }
}
```

The three `VideoOptions` knobs map straight onto the native request:

| Property | Default | What it does |
| --- | --- | --- |
| `StartMuted` | `true` | Whether the video begins muted. Keep `true` unless you have a reason not to — autoplaying sound is a fast way to annoy users. |
| `CustomControlsRequested` | `false` | Opt in to driving playback from your own UI instead of the SDK's overlay. See the caveat below. |
| `ClickToExpandRequested` | `false` | Whether a tap expands the video to fullscreen. |

The overload was added as a **default interface method**, so it is fully backward compatible — existing `CreateAd(adUnitId)` calls keep working unchanged.

## Step 3 — Read media metadata and handle lifecycle events

Once `OnAdLoaded` fires, the `INativeAd` exposes what kind of media it carries and raises events as the video plays. The new members:

```cs
// Metadata (available after the ad loads)
bool     HasVideoContent    // false for an image-only creative
double   VideoAspectRatio   // width ÷ height, e.g. 1.78 for 16:9
TimeSpan VideoDuration
TimeSpan VideoCurrentTime
bool     IsVideoMuted

// Lifecycle events
event EventHandler        OnVideoStart;   // Android only — see note
event EventHandler        OnVideoPlay;
event EventHandler        OnVideoPause;
event EventHandler        OnVideoEnd;
event EventHandler<bool>  OnVideoMuted;   // arg is true when muted
```

Wire them up before calling `Load()`:

```cs
nativeAd.OnVideoStart += (_, _) => Log("start");                 // Android only
nativeAd.OnVideoPlay  += (_, _) => Log($"play, {nativeAd.VideoDuration:mm\\:ss}");
nativeAd.OnVideoPause += (_, _) => Log("pause");
nativeAd.OnVideoEnd   += (_, _) => Log("end");
nativeAd.OnVideoMuted += (_, isMuted) => Log(isMuted ? "muted" : "unmuted");
```

If you prefer to handle events in XAML, the same events are re-raised on the `NativeAdView` (`OnVideoStart`, `OnVideoPlay`, `OnVideoPause`, `OnVideoEnd`, `OnVideoMuted`), so you can subscribe on the view rather than the model.

Two things to know:

- **`OnVideoStart` is Android-only.** iOS does not surface a distinct start callback — treat the first `OnVideoPlay` as the beginning of playback and branch on platform if you need parity.
- **`VideoDuration` can read as zero at load time** for some creatives. It becomes accurate once playback actually starts, so read it inside `OnVideoPlay` rather than in `OnAdLoaded` if you need a reliable value.

## Custom video controls (and the AdMob caveat)

By default the SDK draws its own play/pause/mute overlay on the video. If you want your own buttons to drive playback, request custom controls and call the playback methods on `INativeAd`:

```cs
var nativeAd = _nativeAdService.CreateAd(
    adUnitId,
    new VideoOptions { StartMuted = true, CustomControlsRequested = true });

nativeAd.OnAdLoaded += (_, _) =>
{
    if (nativeAd.VideoCustomControlsEnabled)
    {
        // Now your own UI can drive playback:
        nativeAd.PlayVideo();
        nativeAd.PauseVideo();
        nativeAd.SetVideoMuted(true);
    }
};
```

Here is the part that catches everyone out. `PlayVideo()`, `PauseVideo()`, and `SetVideoMuted(bool)` are **no-ops unless `VideoCustomControlsEnabled` is `true`** — and that flag is only ever `true` when **both** conditions hold: your request opted in (`CustomControlsRequested = true`) **and** the served ad allows custom controls.

**AdMob inventory never allows custom controls** — not its production ads, and not even the native video demo ad unit. Custom video controls are a **Google Ad Manager** feature. So on AdMob, `VideoCustomControlsEnabled` stays `false` and the SDK's built-in overlay is what you get, no matter what you request. This is expected behavior, not a bug in the plugin — there is no AdMob test unit that serves custom controls.

The practical rule: **always gate your custom control UI on `VideoCustomControlsEnabled` after the ad loads, and keep the SDK overlay as the fallback** when it is `false`. (`IsVideoMuted`, `VideoCustomControlsEnabled`, and `VideoClickToExpandEnabled` are all exposed so you can render the right UI for whatever the served ad actually permits.)

## Testing during development

Set `AdConfig.UseTestAdUnitIds = true` and pass a `VideoOptions` — the plugin then routes the request to Google's platform-specific native **video** demo ad unit automatically, so you get a real video creative without wiring up your own unit:

```cs
var nativeAd = _nativeAdService.CreateAd(
    adUnitId: null,
    videoOptions: new VideoOptions { StartMuted = true });
```

A behavior change landed alongside this: **an explicitly specified ad unit ID now always wins over `AdConfig.UseTestAdUnitIds`.** That means you can hit Google's demo units — including the native video unit `ca-app-pub-3940256099942544/1044960115` — directly during development even with test mode toggled on.

If you are testing the video demo creative on an Android emulator, use a **Google Play** system image (e.g. `system-images;android-36;google_apis_playstore;x86_64`). The demo campaign's click-through misbehaves on plain AOSP images; physical devices and Play-enabled images are fine.

## Full example

A complete code-behind that loads a native video ad, renders the media through a `MediaView`, logs every lifecycle event, and wires up custom-control buttons that gracefully fall back when the served ad does not grant them:

```cs
using Plugin.AdMob;
using Plugin.AdMob.Configuration;
using Plugin.AdMob.Services;

public partial class NativeVideoPage : ContentPage
{
    private readonly INativeAdService _nativeAdService;

    public NativeVideoPage(INativeAdService nativeAdService)
    {
        InitializeComponent();
        _nativeAdService = nativeAdService;
    }

    private void OnLoadVideoAdClicked(object sender, EventArgs e)
    {
        // Test mode + VideoOptions => Google's native video demo unit.
        var nativeAd = _nativeAdService.CreateAd(
            adUnitId: null,
            videoOptions: new VideoOptions { StartMuted = true, CustomControlsRequested = true });

        nativeAd.OnAdLoaded += (_, _) =>
        {
            LayoutRoot.Add(new NativeAdView(nativeAd, BuildTemplate()));
            LayoutRoot.Add(BuildControls(nativeAd));
        };
        nativeAd.OnAdFailedToLoad += (_, error) =>
            System.Diagnostics.Debug.WriteLine($"Failed to load: {error.Message}");

        nativeAd.OnVideoStart += (_, _) => Log("start");
        nativeAd.OnVideoPlay  += (_, _) => Log($"play, duration: {nativeAd.VideoDuration:mm\\:ss}");
        nativeAd.OnVideoPause += (_, _) => Log("pause");
        nativeAd.OnVideoEnd   += (_, _) => Log("end");
        nativeAd.OnVideoMuted += (_, isMuted) => Log(isMuted ? "muted" : "unmuted");

        nativeAd.Load();
    }

    private static void Log(string name) =>
        System.Diagnostics.Debug.WriteLine($"Native video event: {name}.");

    private static ContentView BuildTemplate()
    {
        var headline = new Label { FontAttributes = FontAttributes.Bold, FontSize = 16 };
        headline.SetBinding(Label.TextProperty, nameof(INativeAd.Headline));

        var body = new Label { FontSize = 13 };
        body.SetBinding(Label.TextProperty, nameof(INativeAd.Body));

        return new ContentView
        {
            WidthRequest = 340,
            HeightRequest = 280,
            Content = new VerticalStackLayout
            {
                Spacing = 8,
                Children =
                {
                    new MediaView { HeightRequest = 200, WidthRequest = 340 },
                    headline,
                    body,
                },
            },
        };
    }

    private static View BuildControls(INativeAd ad)
    {
        var status = new Label { FontSize = 12 };
        void UpdateStatus() => status.Text =
            $"custom controls: {ad.VideoCustomControlsEnabled}, muted: {ad.IsVideoMuted}";

        var play = new Button { Text = "Play" };
        play.Clicked += (_, _) => ad.PlayVideo();     // no-op unless custom controls are enabled

        var pause = new Button { Text = "Pause" };
        pause.Clicked += (_, _) => ad.PauseVideo();

        var mute = new Button { Text = "Mute/unmute" };
        mute.Clicked += (_, _) => ad.SetVideoMuted(!ad.IsVideoMuted);

        ad.OnVideoPlay  += (_, _) => MainThread.BeginInvokeOnMainThread(UpdateStatus);
        ad.OnVideoPause += (_, _) => MainThread.BeginInvokeOnMainThread(UpdateStatus);
        ad.OnVideoMuted += (_, _) => MainThread.BeginInvokeOnMainThread(UpdateStatus);

        UpdateStatus();

        return new VerticalStackLayout
        {
            Spacing = 8,
            Children =
            {
                new HorizontalStackLayout { Spacing = 8, Children = { play, pause, mute } },
                status,
            },
        };
    }
}
```

On an Android emulator with a Google Play image, the demo video plays inside the `MediaView`, the status line reports `HasVideoContent: True, aspect: 1.78`, and you will see `[start]` then `[play]` events fire. Because AdMob does not grant custom controls, `VideoCustomControlsEnabled` reads `false` — the SDK's overlay controls drive playback and your buttons no-op, exactly as designed.

## Gotchas checklist

- **Nothing renders where the video should be** — make sure the `MediaView` is actually inside the `NativeAdView.AdContent` template. The handler finds it by walking that template's visual tree; a `MediaView` placed elsewhere on the page is never attached.
- **`VideoDuration` is `00:00`** — read it in `OnVideoPlay`, not `OnAdLoaded`. Some creatives only report duration once playback starts.
- **No `OnVideoStart` on iOS** — that event is Android-only; use the first `OnVideoPlay` as the start signal on iOS.
- **Custom controls do nothing** — expected on AdMob. Gate on `VideoCustomControlsEnabled` and fall back to the SDK overlay. It is an Ad Manager feature.
- **No video creative on the emulator** — use a Google Play system image, and remember an explicit ad unit ID overrides `UseTestAdUnitIds`.

### Read next

- [Plugin.AdMob on GitHub](https://github.com/marius-bughiu/Plugin.AdMob) — source, docs, and a full working sample app
- [How to: Add AdMob to your MAUI app](/2023/11/how-to-add-admob-to-your-maui-app/) — the banner-ad starting point if you are new to AdMob in MAUI
