---
title: "How to: Add AdMob to your MAUI app"
description: "Learn how to display AdMob banner ads in your .NET MAUI app on both Android and iOS, with step-by-step setup and platform-specific handler implementations."
pubDate: 2023-11-17
tags:
  - "maui"
  - "net"
  - "net-8"
---
One of the first things people think about when developing for a new platform / using a new technology is monetization; and in my case the question is: how easy is it to integrate AdMob? For .NET MAUI the answer would be: “It depends” – it depends on luck & on the complexity of what you want to achieve; but I will detail this as we move along.

In this article we’re going to look at how to display a banner ad using AdMob on both Android and iOS.

The first thing we need to do is add the platform-specific AdMob packages:

-   for Android – add Nuget package `Xamarin.GooglePlayServices.Ads.Lite`
-   for iOS – add Nuget package `Xamarin.Google.iOS.MobileAds`

Once the packages are installed, you might be running into some binding errors, the likes of:

```plaintext
Type androidx.collection.LongSparseArrayKt$keyIterator$1 is defined multiple times.
```

That is due to conflicts between the bindings libraries referenced by MAUI and the ones referenced by the Xamarin packages we just installed. We can fix this by forcing a certain package version. In this case, we will want to install:

-   for Android: `Xamarin.AndroidX.Collection.Ktx` version `1.3.0.1`
-   for iOS: `Xamarin.Build.Download` version `0.11.4`

Once these packages are installed, your project should build and run without issues on both platforms. Now on to the code. We start by defining our ad view:

```cs
public class BannerAd : ContentView
{
    public static readonly BindableProperty AdUnitIdProperty =
        BindableProperty.Create("AdUnitId", typeof(string), typeof(BannerAd), null);

    public string AdUnitId
    {
        get { return (string)GetValue(AdUnitIdProperty); }
        set { SetValue(AdUnitIdProperty, value); }
    }
}
```

Next, you want to create an empty handler for your view (we’re going to provide platform-specific implementations for this a bit later):

```cs
internal partial class BannerAdHandler { }
```

And register the handler in your `MauiProgram.cs`, right after `.UseMauiApp()`:

```cs
builder
    .UseMauiApp<App>()
    .ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(BannerAd), typeof(BannerAdHandler));
        });
```

With everything set up, it’s time to work on the platform-specific handlers. These go into the `Platforms/Android` and `Platforms/iOS` folders respectively.

For Android, the handler will look like this:

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, AdView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);


    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(AdView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override AdView CreatePlatformView()
    {
        var adView = new AdView(Context)
        {
            AdSize = GetAdSize(),
            AdUnitId = VirtualView.AdUnitId
        };

        VirtualView.HeightRequest = 90;

        var request = new AdRequest.Builder().Build();
        adView.LoadAd(request);

        return adView;
    }
}
```

And for iOS:

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, BannerView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);

    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(BannerView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override BannerView CreatePlatformView()
    {
        var adSize = AdSizeCons.GetCurrentOrientationAnchoredAdaptiveBannerAdSize((float)UIScreen.MainScreen.Bounds.Width);
        var adView = new BannerView(adSize)
        {
            AdUnitId = VirtualView.AdUnitId,
            RootViewController = GetRootViewController()
        };
        
        VirtualView.HeightRequest = 90;

        var request = Request.GetDefaultRequest();
        adView.LoadRequest(request);

        return adView;
    }

    private UIViewController GetRootViewController()
    {
        foreach (UIWindow window in UIApplication.SharedApplication.Windows)
        {
            if (window.RootViewController != null)
            {
                return window.RootViewController;
            }
        }

        return null;
    }
}
```

With the platform-specific handlers implemented, we can go ahead and use the `BannerAd` view in our page. Go to your `MainPage.xaml`, and simply add the `BannerAd` within your layout:

```xml
<admob:BannerAd AdUnitId="ca-app-pub-3940256099942544/6300978111" />
```

And that's it! If you run the app, you should now see a test ad being displayed on both platforms.

### Read next

-   [GitHub: AdMob plugin implementation and fully working sample for .NET MAUI](https://github.com/marius-bughiu/Plugin.AdMob)
