---
title: "How To: AdMob in Ihre Xamarin-Forms-App einbinden"
description: "Schritt-für-Schritt-Anleitung zur Integration von AdMob-Anzeigen in Ihre Xamarin-Forms-App auf Android und iOS mithilfe von Custom View Renderern."
pubDate: 2015-09-27
updatedDate: 2023-11-18
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2015/09/how-to-add-admob-to-your-xamarin-forms-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Eines der ersten Dinge, an die man bei der Entwicklung für eine neue Plattform / mit einer neuen Technologie denkt, ist Monetarisierung; und in meinem Fall lautet die Frage: Wie einfach lässt sich AdMob integrieren? Für Xamarin Forms ist die Antwort: "Es kommt darauf an" - es kommt auf Glück und auf die Komplexität dessen an, was Sie erreichen möchten; ich werde das aber im Verlauf erläutern.

Als Erstes müssen Sie die nötigen Komponenten zu Ihren Projekten hinzufügen. Für diesen Walkthrough verwende ich Visual Studio, mit Xamarin Studio sollte es aber relativ ähnlich sein. Hier trennen sich die Wege je nach Plattform:

-   für Android: NuGet-Paket Xamarin.GooglePlayServices.Ads.Lite hinzufügen
-   für iOS: NuGet-Paket Xamarin.Google.iOS.MobileAds hinzufügen
-   für Windows Phone: SDK von hier herunterladen und als Referenz hinzufügen (Plattform nicht mehr unterstützt)

An dieser Stelle sollte Ihr Android-Projekt nicht mehr bauen und Sie erhalten den Fehler COMPILETODALVIK : UNEXPECTED TOP-LEVEL. Um das zu beheben, gehen Sie in die Properties Ihres Droid-Projekts, wählen den Tab Android Options und ändern unter Advanced den Wert von Java Max Heap Size auf 1G. Ihr Projekt sollte nun fehlerfrei bauen.

Fügen Sie als Nächstes in Ihrem Shared/PCL-Projekt einen neuen Content View hinzu und nennen Sie ihn AdMobView. Entfernen Sie den im Konstruktor generierten Code, sodass es so aussieht:

```cs
public class AdMobView : ContentView
{
    public AdMobView() { }
}
```

Fügen Sie diese neue View Ihrer Page hinzu. In XAML zum Beispiel so:

```xml
<controls:AdMobView />
```

Stellen Sie sicher, dass NICHTS das Control beeinträchtigt. Mit nichts meine ich überlappende Controls, Page-Padding, Margins/Spacings des Controls usw. Wenn etwas das Anzeigen-Control überlagert, werden keine Anzeigen ausgeliefert, und Sie erhalten keinen Fehler. Also Vorsicht.

Als Nächstes folgen die Custom View Renderer; und auch hier wieder pro Plattform:

**Android**

Fügen Sie eine neue Klasse AdMobRenderer mit dem Code unten hinzu. Achten Sie darauf, das Attribut ExportRenderer oberhalb des Namespace zu lassen, sonst funktioniert die Magie nicht.

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

Anschließend müssen Sie Ihre AndroidManifest.xml anpassen, um die AdActivity sowie die für das Ausspielen von Anzeigen nötigen Berechtigungen ACCESS\_NETWORK\_STATE, INTERNET hinzuzufügen, wie im Beispiel unten.

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

Das war's. Ihr Android-Build sollte nun Anzeigen innerhalb des AdMobView-Content-Views ausspielen.

**iOS**

Beginnen Sie mit einer Zeile in Ihrer AppDelegate.cs, um das SDK mit Ihrer Application ID zu initialisieren. Achtung: nicht mit der Ad Unit ID verwechseln! Fügen Sie das direkt vor dem Aufruf LoadApplication ein.

```cs
MobileAds.Configure("ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx");
```

Dann, wie zuvor, eine neue Klasse AdMobRenderer hinzufügen und den Code unten kopieren, wobei Sie die AdmobID durch die ID Ihrer Banner-Unit ersetzen.

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

Das war's. Jetzt werden auf beiden Plattformen Anzeigen ausgespielt. Anmerkungen oder Vorschläge gerne in die Kommentare unten.

**Update 30. Dez. 2017**

In diesem Artikel haben wir Banner-Anzeigen ausgespielt und die View-Größe auf 320 x 50 dp festkodiert. Wenn Sie Smart Banner umsetzen möchten, werfen Sie einen Blick auf diesen Folgebeitrag: [AdMob Smart Banner Sizing in Xamarin Forms](/de/2017/12/admob-smart-banner-sizing-xamarin-forms/)

**Update 21. Jan. 2018**

Endlich habe ich den Mut gefunden, eine meiner Apps für iOS zu bauen, also habe ich diesen Artikel für die neueste AdMob-Version für Xamarin aktualisiert. Außerdem ist der Smart-Sizing-Code aus dem Update vom 30. Dez. enthalten. Danke an alle, die in den Kommentaren bei der iOS-Umsetzung helfen.

### Lesen Sie als Nächstes

-   [How to: AdMob in Ihre MAUI-App einbinden](/de/2023/11/how-to-add-admob-to-your-maui-app/)
