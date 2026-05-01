---
title: "Den Xamarin-Forms-AdMob-Renderer für Microsoft Ads auf UWP erweitern"
description: "Erfahren Sie, wie Sie Ihren Xamarin-Forms-AdMob-Renderer erweitern, um Microsoft Ads auf UWP mit dem Microsoft Advertising SDK anzuzeigen."
pubDate: 2018-04-08
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2018/04/extending-your-xamarin-forms-admob-renderer-to-display-microsoft-ads-on-uwp"
translatedBy: "claude"
translationDate: 2026-05-01
---
Bisher haben wir [Anzeigen nur auf Android und iOS über AdMob und unseren AdMob-Renderer](/de/2015/09/how-to-add-admob-to-your-xamarin-forms-app/) ausgespielt. Google hat den Support für Windows Phone komplett eingestellt und sich nie um UWP gekümmert, daher kommt AdMob in dieser konkreten Situation nicht in Frage.

Glücklicherweise ist auch Microsoft im Werbegeschäft und hat alles schön ins Developer Dashboard und in Visual Studio integriert, sodass es recht einfach ist, Anzeigen in der Anwendung darzustellen. Wir bauen auf unserem bestehenden AdMob-Code aus dem oben verlinkten Artikel auf und erweitern ihn so, dass er auf UWP das Microsoft Advertising SDK nutzt, um Anzeigen anzuzeigen.

Zum Einstieg gehen Sie in Ihr Windows Developer Dashboard, wählen Ihre App -- Monetize -- In-app ads und legen eine neue Banner-Unit an.

Anschließend fügen Sie das NuGet-Paket Microsoft.Advertising.XAML zu Ihrem UWP-Projekt hinzu.

Dann Rechtsklick auf References -- Add references und unter Universal Windows -- Extensions das Häkchen bei "Microsoft Advertising SDK for XAML" setzen, dann OK. **Hinweis:** Möglicherweise müssen Sie nach diesen beiden Schritten Visual Studio neu starten, damit alle Änderungen erkannt werden (z. B. wenn die Namespaces für den nächsten Codeausschnitt nicht registriert werden).

Die Projekteinrichtung ist abgeschlossen, jetzt geht's an den Renderer. Wir gehen Schritt für Schritt vor, aber wenn Sie nur den Code möchten, finden Sie ihn vollständig am Ende des Beitrags.

Erster Schritt ist, das AdControl zu erstellen. Dafür benötigen wir die Application ID und die AdUnitId aus dem Dev Center (im Code unten ausfüllen). Außerdem habe ich einige Test-IDs eingefügt, die Microsoft in der Dokumentation bereitstellt, damit wir unsere Implementierung testen können.

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

Als Nächstes müssen wir die verfügbare Breite ermitteln, um den Bildschirm bestmöglich zu nutzen. Microsoft bietet 4 horizontale Bannergrößen mit 300, 320, 640 und 728 Pixeln Breite. Wir müssen entscheiden, welche zu unserem Szenario passt.

Das hängt von drei Dingen ab:

-   Der verfügbaren Breite der Anwendung (nicht zu verwechseln mit der Bildschirmbreite, denn auf Desktops läuft die Anwendung nicht zwangsläufig im Vollbild)
-   Ob Ihre Xamarin-Forms-App ein MasterDetail nutzt (und ein Seitenmenü hat)
-   Der Gerätefamilie (uns interessiert, ob Desktop oder nicht)

Die Fensterbreite zu ermitteln ist einfach. Falls Ihre App ein MasterDetail als Root nutzt, wird auf Desktops dieses Seitenmenü immer angezeigt (also nicht ausgeblendet), nimmt also Platz von der verfügbaren Breite weg. In Xamarin Forms ist die Sidebar 320px breit, also ziehen wir das von der verfügbaren Breite ab. Dafür legen wir zwei Konstanten im Renderer an.

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

Dann wählen wir Anzeigenbreite und -höhe basierend auf der verfügbaren Breite und setzen den Height Request unseres Xamarin-Forms-Elements, damit auf der Page genug Platz für die Anzeige bleibt.

```cs
if (availableWidth >= 728)
{
    ad.Width = 728;
    ad.Height = 90;
}
else if (availableWidth >= 640)
{
    ad.Width = 640;
    ad.Height = 100;
}
else if (availableWidth >= 320)
{
    ad.Width = 320;
    ad.Height = 50;
}
else if (availableWidth >= 300)
{
    ad.Width = 300;
    ad.Height = 50;
}

e.NewElement.HeightRequest = ad.Height;

SetNativeControl(ad);
```

Und das war's. Wie versprochen, hier der vollständige Code.

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
                    ApplicationId = "",
                    AdUnitId = "",
#endif

#if DEBUG
                    ApplicationId = "3f83fe91-d6be-434d-a0ae-7351c5a997f1",
                    AdUnitId = "test"
#endif
                };

                var availableWidth = Window.Current.Bounds.Width;
                if (_hasSideMenu)
                {
                    var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Desktop";
                    if (isDesktop)
                    {
                        availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
                    }
                }

                if (availableWidth >= 728)
                {
                    ad.Width = 728;
                    ad.Height = 90;
                }
                else if (availableWidth >= 640)
                {
                    ad.Width = 640;
                    ad.Height = 100;
                }
                else if (availableWidth >= 320)
                {
                    ad.Width = 320;
                    ad.Height = 50;
                }
                else if (availableWidth >= 300)
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
