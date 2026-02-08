---
title: "How To: Add AdMob to your Xamarin Forms app"
description: "Step-by-step guide to integrating AdMob ads into your Xamarin Forms app on Android and iOS using custom view renderers."
pubDate: 2015-09-27
updatedDate: 2023-11-18
tags:
  - "xamarin"
  - "xamarin-forms"
---
One of the first things people think about when developing for a new platform / using a new technology is monetization; and in my case the question is: how easy is it to integrate AdMob? For Xamarin Forms the answer would be: “It depends” – it depends on luck & on the complexity of what you want to achieve; but I will detail this as we move along.

The first thing you need to do is add the required components to your projects. For this walkthrough I will be using Visual Studio but it should be relatively the same when using Xamarin Studio. Here, things go separate ways for each of the platforms:

-   for Android – add Nuget package Xamarin.GooglePlayServices.Ads.Lite
-   for iOS – add Nuget package Xamarin.Google.iOS.MobileAds
-   for Windows Phone – download the SDK from here and add it as a reference platform no longer supported

By now, your Android project should no longer be building and you should be receiving a COMPILETODALVIK : UNEXPECTED TOP-LEVEL error. To fix that, go into your Droid project properties, select the Android Options tab and then under Advanced modify the value for the Java Max Heap Size to 1G. Your project should now build without any errors.

Next, inside your shared / PCL project add a new Content View and call it AdMobView. Remove the code generated inside its constructor and it should look like this:

```cs
public class AdMobView : ContentView
{
    public AdMobView() { }
}
```

Add this new view to your page. In XAML you can do it like this:

```xml
<controls:AdMobView />
```

Make sure NOTHING interferes with the control. By nothing I mean – overlapping controls, page padding, control margins / spacing, etc. If you have something overlapping the ad control, ads will not display & you won’t receive an error, so be careful.

Next, it’s time to add the custom view renderers; and again, we’ll handle each platform:

**Android**

Add a new class called AdMobRenderer with the code below. Make sure to keep the ExportRenderer attribute above the namespace, otherwise the magic won’t happen.

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace AdExample.Droid.Renderers
{
    public class AdMobRenderer : ViewRenderer
    {
        public AdMobRenderer(Context context) : base(context)
        {

        }

        private int GetSmartBannerDpHeight()
        {
            var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

            if (dpHeight <= 400) return 32;
            if (dpHeight <= 720) return 50;
            return 90;
        }

        protected override void OnElementChanged(ElementChangedEventArgs<View> e)
        {
            base.OnElementChanged(e);

            if (Control == null)
            {
                var ad = new AdView(Context)
                {
                    AdSize = AdSize.SmartBanner,
                    AdUnitId = "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                };

                var requestbuilder = new AdRequest.Builder();

                ad.LoadAd(requestbuilder.Build());
                e.NewElement.HeightRequest = GetSmartBannerDpHeight();

                SetNativeControl(ad);
            }
        }
    }
}
```

Next, you need to modify your AndroidManifest.xml file to add the AdActivity & required permissions for displaying ads: ACCESS\_NETWORK\_STATE, INTERNET; just like in the example below.

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
	<uses-sdk android:minSdkVersion="15" />
	<application>
    <activity android:name="com.google.android.gms.ads.AdActivity" android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|uiMode|screenSize|smallestScreenSize" android:theme="@android:style/Theme.Translucent" />
  </application>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.INTERNET" />
</manifest>
```

That’s it. Your Android build should now display ads inside the AdMobView content view.

**iOS**

Start off by adding one line in your AppDelegate.cs to initialize the SDK with your application ID. Careful, do not mistake this with your ad unit ID! Add this just before the LoadApplication call.

```cs
MobileAds.Configure("ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx");
```

Then, same as before, just add a new class called AdMobRenderer and copy-paste the code below replacing the AdmobID with the ID of your banner unit.

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.iOS.Renderers
{
    public class AdMobRenderer : ViewRenderer
    {
        BannerView adView;
        bool viewOnScreen;

        protected override void OnElementChanged(ElementChangedEventArgs<Xamarin.Forms.View> e)
        {
            base.OnElementChanged(e);

            if (e.NewElement == null)
                return;

            if (e.OldElement == null)
            {
                adView = new BannerView(AdSizeCons.SmartBannerPortrait)
                {
                    AdUnitID = "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx",
                    RootViewController = GetRootViewController()
                };

                adView.AdReceived += (sender, args) =>
                {
                    if (!viewOnScreen) this.AddSubview(adView);
                    viewOnScreen = true;
                };

                var request = Request.GetDefaultRequest();

                e.NewElement.HeightRequest = GetSmartBannerDpHeight();
                adView.LoadRequest(request);

                base.SetNativeControl(adView);
            }
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

        private int GetSmartBannerDpHeight()
        {
            var dpHeight = (double)UIScreen.MainScreen.Bounds.Height;

            if (dpHeight <= 400) return 32;
            if (dpHeight <= 720) return 50;
            return 90;
        }
    }
}
```

That’s it. Now you have ads being served on both platforms. Any comments or suggestions you have leave them in the comments section below.

**Update 30 Dec 2017**

In this article we looked at displaying Banner ads and hard-coded the view size to 320 x 50 dp. If you’re looking to implement smart banners have a look at this follow-up post: [AdMob Smart Banner sizing in Xamarin Forms](/2017/12/admob-smart-banner-sizing-xamarin-forms/)

**Update 21 Jan 2018**

I finally made the courage to try and build one of my apps for iOS so I’ve updated this article to work with the latest version of AdMob for Xamarin. I’ve also included the smart sizing code mentioned in the 30 Dec update. Thanks to everyone helping out in the comments section with the iOS implementation.

### Read next

-   [How to: Add AdMob to your MAUI app](/2023/11/how-to-add-admob-to-your-maui-app/)
