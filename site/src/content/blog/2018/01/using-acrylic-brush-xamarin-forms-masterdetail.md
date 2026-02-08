---
title: "UWP – Using an Acrylic Brush in your Xamarin Forms MasterDetail menu"
description: "Right, so you are one of those guys targeting UWP with their Xamarin Forms app… aand you want to use the new Acrylic brush to make you application stand out. Say no more. We won’t be using any 3rd party library/package to do this and we’ll be working in the platform specific project; so open…"
pubDate: 2018-01-16
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
---
Right, so you are one of those guys targeting UWP with their Xamarin Forms app… aand you want to use the new Acrylic brush to make you application stand out. Say no more.

![Gazeta Acrylic menu on UWP](https://image.ibb.co/fTPyrm/gazeta_acrylic.gif)

We won’t be using any 3rd party library/package to do this and we’ll be working in the platform specific project; so open up your **MainPage.xaml.cs** found inside your UWP project. First thing we need to do is grab a reference to your MasterDetail Master page. In my case, the MasterDetail represents my MainPage so things are pretty straight forward.

```cs
var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
```

Next, you need to the native renderer for the Master page. This is what will allow us to modify the Background brush.

```cs
var renderer = Platform.GetRenderer(masterPage) as PageRenderer;
```

Now create your brush and assign it to your renderer. This will overwrite any BackgroundColor that you might have set on your ContentPage in XAML – and this is good, Android and iOS will continue to use that value you defined in XAML while on UWP you will be using the new AcrylicBrush.

```cs
var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.TintOpacity = 0.8;

renderer.Background = acrylicBrush;
```

I’ve set the TintColor and FallbackColor to match the color that I’ve set in XAML, while for the opacity I chose to go with 80%. Play with these values until you obtain the desired effect. As for what each of the properties does exactly:

> -   **TintColor**: the color/tint overlay layer. Consider specifying both the RGB color value and alpha channel opacity.
> -   **TintOpacity**: the opacity of the tint layer. We recommend 80% opacity as a starting point, although different colors may look more compelling at other transparencies.
> -   **BackgroundSource**: the flag to specify whether you want background or in-app acrylic.
> -   **FallbackColor**: the solid color that replaces acrylic in low-battery mode. For background acrylic, fallback color also replaces acrylic when your app isn’t in the active desktop window or when the app is running on phone and Xbox.

You can read [this](https://docs.microsoft.com/en-us/windows/uwp/design/style/acrylic) for more info on how the Acrylic material works. Also, just in case something doesn’t work, here’s the whole MainPage:

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
