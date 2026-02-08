---
title: "Extending your Xamarin Forms AdMob renderer to display Microsoft Ads on UWP"
description: "So far we’ve been displaying ads only on Android and iOS through AdMob and our AdMob renderer. Google dropped support for Windows Phone altogether and never bothered with UWP so AdMob is not a choice in this particular situation. Fortunately, Microsoft is also in the advertising business and they’ve now nicely integrated everything in the…"
pubDate: 2018-04-08
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
---
So far we’ve been [displaying ads only on Android and iOS through AdMob and our AdMob renderer](/2015/09/how-to-add-admob-to-your-xamarin-forms-app/). Google dropped support for Windows Phone altogether and never bothered with UWP so AdMob is not a choice in this particular situation.

Fortunately, Microsoft is also in the advertising business and  they’ve now nicely integrated everything in the developer dashboard and Visual Studio making it rather easy to display ads in your application. We’re going to be building on our existing AdMob code from the article linked above, and we’re going to extend it to use the Microsoft Advertising SDK to display ads on UWP.

To start of, go to your Windows developer dashboard, select your app – Monetize – In-app ads and create a new banner unit.

Next, add the Microsoft.Advertising.XAML NuGet package to your UWP project.

Then right click References – Add references and got to Universal Windows – Extensions and tick “Microsoft Advertising SDK for XAML”, then hit ok. **Note:** you might have to restart Visual Studio after these two steps to make sure it picks up all your changes (e.g. if it doesn’t register the namespaces for the next piece of code).

We’re done with the project setup, it’s now time for the renderer. We’ll go in step by step, but if you just want the code, you can find it in its entirety at the end of the post.

First step is to create the AdControl. To do so we need the application ID and AdUnitId from the dev center (make sure you will them in in the code below). Additionally I’ve added in some test IDs that are provided by Microsoft in the documentation so we can test our implementation.

```cs

var ad = new Microsoft.Advertising.WinRT.UI.AdControl
{
#if !DEBUG
    ApplicationId = "",
    AdUnitId = "",
#endif

#if DEBUG
    ApplicationId = "3f83fe91-d6be-434d-a0ae-7351c5a997f1",
    AdUnitId = "test"
#endif
};
```

Next, we need to determine the available width if we’re going to make the most out of our screen. There are 4 sizes of horizontal banners available from Microsoft with 300, 320, 640 and 728 pixels in width. So we need to determine which is suitable for our scenario.

This depends on three things:

-   The available width of the application (don’t confuse this with screen width, as on desktop the application is not necessarily full screen)
-   Whether your Xamarin Forms app is using a MasterDetail (and has a side menu)
-   The device family (we’re interested if it’s a desktop or not)

Determining the window width is easy enough. Now, if your app uses a MasterDetail for its root, then on desktops, that side menu will be displayed always (i.e. it’s not hidden), so it’s taking up space from the application’s available width. On Xamarin Forms, the width of the sidebar is 320px, so we’ll subtract that from our available width. We’ll be adding two constant properties in our renderer to manage this configuration.

```cs
private const bool _hasSideMenu = true;
private const int _sideBarWidth = 320;
```
```cs
var availableWidth = Window.Current.Bounds.Width;
if (_hasSideMenu)
{
var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Desktop";
if (isDesktop)
{
availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
}
}
```

Next we pick our ad width and height based on our available width, and set the height request for our Xamarin Forms element to make sure there’s room for it to be displayed in the page.

```cs
if (availableWidth &amp;amp;amp;gt;= 728)
{
    ad.Width = 728;
    ad.Height = 90;
}
else if (availableWidth &amp;amp;amp;gt;= 640)
{
    ad.Width = 640;
    ad.Height = 100;
}
else if (availableWidth &amp;amp;amp;gt;= 320)
{
    ad.Width = 320;
    ad.Height = 50;
}
else if (availableWidth &amp;amp;amp;gt;= 300)
{
    ad.Width = 300;
    ad.Height = 50;
}

e.NewElement.HeightRequest = ad.Height;

SetNativeControl(ad);
```

And that’s it. As promised, below you have the whole code.

```cs
using GazetaSporturilor.Controls;
using GazetaSporturilor.UWP.Renderers;
using Microsoft.Advertising.WinRT.UI;
using Windows.System.Profile;
using Windows.UI.Xaml;
using Xamarin.Forms.Platform.UWP;

[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.UWP.Renderers
{
    public class AdMobRenderer : ViewRenderer<AdMobView, AdControl>
    {
        private const bool _hasSideMenu = true;
        private const int _sideBarWidth = 320;

        public AdMobRenderer()
        {

        }

        protected override void OnElementChanged(ElementChangedEventArgs<AdMobView> e)
        {
            base.OnElementChanged(e);

            if (e.NewElement == null)
            {
                return;
            }

            if (Control == null)
            {
                var ad = new Microsoft.Advertising.WinRT.UI.AdControl
                {
#if !DEBUG
                    ApplicationId = &quot;&quot;,
                    AdUnitId = &quot;&quot;,
#endif

#if DEBUG
                    ApplicationId = &quot;3f83fe91-d6be-434d-a0ae-7351c5a997f1&quot;,
                    AdUnitId = &quot;test&quot;
#endif
                };

                var availableWidth = Window.Current.Bounds.Width;
                if (_hasSideMenu)
                {
                    var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == &quot;Windows.Desktop&quot;;
                    if (isDesktop)
                    {
                        availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
                    }
                }

                if (availableWidth &amp;amp;amp;gt;= 728)
                {
                    ad.Width = 728;
                    ad.Height = 90;
                }
                else if (availableWidth &amp;amp;amp;gt;= 640)
                {
                    ad.Width = 640;
                    ad.Height = 100;
                }
                else if (availableWidth &amp;amp;amp;gt;= 320)
                {
                    ad.Width = 320;
                    ad.Height = 50;
                }
                else if (availableWidth &amp;amp;amp;gt;= 300)
                {
                    ad.Width = 300;
                    ad.Height = 50;
                }

                e.NewElement.HeightRequest = ad.Height;

                SetNativeControl(ad);
            }
        }
    }
}
```
