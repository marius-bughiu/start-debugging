---
title: "UWP - Acrylic Brush im MasterDetail-Menü von Xamarin Forms verwenden"
description: "Wenden Sie den UWP Acrylic Brush auf ein MasterDetail-Menü in Xamarin Forms an, indem Sie einen plattformspezifischen Native Renderer ohne Drittanbieter-Bibliotheken nutzen."
pubDate: 2018-01-16
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2018/01/using-acrylic-brush-xamarin-forms-masterdetail"
translatedBy: "claude"
translationDate: 2026-05-01
---
Gut, Sie zielen also mit Ihrer Xamarin-Forms-App auch auf UWP und möchten den neuen Acrylic Brush nutzen, um Ihre App hervorzuheben. Kein Wort mehr.

![Gazeta Acrylic-Menü auf UWP](https://image.ibb.co/fTPyrm/gazeta_acrylic.gif)

Wir verwenden dafür keine Drittanbieter-Bibliothek/-Paket und arbeiten im plattformspezifischen Projekt; öffnen Sie also Ihre **MainPage.xaml.cs** im UWP-Projekt. Als Erstes brauchen wir eine Referenz auf die Master Page Ihres MasterDetail. In meinem Fall ist das MasterDetail meine MainPage, daher ist alles ziemlich geradlinig.

```cs
var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
```

Als Nächstes benötigen Sie den Native Renderer für die Master Page. Damit können wir den Background Brush ändern.

```cs
var renderer = Platform.GetRenderer(masterPage) as PageRenderer;
```

Erzeugen Sie nun Ihren Brush und weisen Sie ihn dem Renderer zu. Damit wird jede BackgroundColor überschrieben, die Sie ggf. in XAML auf Ihrer ContentPage gesetzt haben - das ist gut, denn Android und iOS verwenden weiterhin diesen Wert aus XAML, während Sie unter UWP den neuen AcrylicBrush nutzen.

```cs
var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.TintOpacity = 0.8;

renderer.Background = acrylicBrush;
```

TintColor und FallbackColor habe ich an die in XAML gesetzte Farbe angeglichen, für die Opacity habe ich 80% gewählt. Spielen Sie mit diesen Werten, bis Sie den gewünschten Effekt erzielen. Was die einzelnen Eigenschaften genau tun:

> -   **TintColor**: die überlagernde Farb-/Tintschicht. Geben Sie nach Möglichkeit sowohl den RGB-Farbwert als auch die Alpha-Kanal-Opacity an.
> -   **TintOpacity**: die Opacity der Tintschicht. Wir empfehlen 80% als Ausgangspunkt, allerdings können andere Farben mit anderen Transparenzen besser wirken.
> -   **BackgroundSource**: das Flag, das bestimmt, ob Sie Background- oder In-App-Acrylic möchten.
> -   **FallbackColor**: die einfarbige Farbe, die Acrylic im Stromsparmodus ersetzt. Bei Background-Acrylic ersetzt FallbackColor das Acrylic auch dann, wenn Ihre App nicht im aktiven Desktop-Fenster läuft oder wenn die App auf Phone oder Xbox läuft.

Mehr Infos zur Funktionsweise des Acrylic-Materials finden Sie [hier](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic). Zur Sicherheit hier auch noch die ganze MainPage:

```cs
public sealed partial class MainPage
{
    public MainPage()
    {
        this.InitializeComponent();
        var app = new GazetaSporturilor.App();
        LoadApplication(app);

        var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
        var renderer = Platform.GetRenderer(masterPage) as PageRenderer;

        var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
        acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
        acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.TintOpacity = 0.8;

        renderer.Background = acrylicBrush;
    }
}
```
