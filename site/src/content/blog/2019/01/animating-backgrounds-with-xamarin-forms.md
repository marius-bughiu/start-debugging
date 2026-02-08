---
title: "Animating backgrounds with Xamarin Forms"
description: "Create a smooth animated background effect in Xamarin Forms using ScaleTo animations on layered BoxViews."
pubDate: 2019-01-02
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "xamarin"
  - "xamarin-forms"
---
I’ve started playing with animations in Xamarin Forms only recently and created a cool background animation for one of my apps ([Charades for Dota 2](https://play.google.com/store/apps/details?id=com.outworldapps.CharadesForDota2)) which I thought I would share. So without any extra introduction, this is the final result:

![](/wp-content/uploads/2019/01/animations3.gif)

The GIF is a bit jittery but that's just because my PC can't handle the emulator properly. On a device, the animations are smooth.

Right, so how we did this: first, we pick the colors. In our case, we need 5 colors, one acting as the background for our app and 4 for the different layers that we want to animate. To make things easy – pick a [material color](https://material-ui.com/style/color/); we’ll be using the shades from 500 to 900. Add these colors as resources in your app or page.

```xml
<ContentPage.Resources>
        <Color x:Key="Color500">#2196F3</Color>
        <Color x:Key="Color600">#1E88E5</Color>
        <Color x:Key="Color700">#1976D2</Color>
        <Color x:Key="Color800">#1565C0</Color>
        <Color x:Key="Color900">#0D47A1</Color>
</ContentPage.Resources>
```

Next, setup your page so that you have 4 background layers – each layer being a `BoxView` with its own color. Notice how we order the colors from the darkest shade to the lightest.

```xml
<Grid x:Name="LayoutRoot" BackgroundColor="{StaticResource Color900}">
        <BoxView x:Name="BackgroundLayer1" BackgroundColor="{StaticResource Color800}" />
        <BoxView x:Name="BackgroundLayer2" BackgroundColor="{StaticResource Color700}" />
        <BoxView x:Name="BackgroundLayer3" BackgroundColor="{StaticResource Color600}" />
        <BoxView x:Name="BackgroundLayer4" BackgroundColor="{StaticResource Color500}" />
</Grid>
```

Now that the page is setup, all we have left to do is to animate the individual layers. In our case, we’re scaling each layer up and down using the `ScaleTo` method which takes in three parameters: the scale towards which to animate, the animation duration in milliseconds and the easing function to use for the animation; with the last two parameters being optional. This is how we shrink one layer:

```cs
await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
```

Once the layer is shrunk – and notice how we `await` for the animation to complete – we have to do the opposite animation and make it bigger. And we need to do this in a loop:

```cs
while (true)
{
    await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
    await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
}
```

Do the same for all 4 layers as part of different loops and you get the same effect as in the GIF above. Below you have the complete code for animating all 4 layers.

```cs
public partial class MainPage : ContentPage
{
    public MainPage()
    {
        InitializeComponent();
        AnimateBackground();
    }

    private void AnimateBackground()
    {
        AnimateBackgroundLayer1();
        AnimateBackgroundLayer2();
        AnimateBackgroundLayer3();
        AnimateBackgroundLayer4();
    }

    private async void AnimateBackgroundLayer1()
    {
        while (true)
        {
            await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
            await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
        }
    }

    private async void AnimateBackgroundLayer2()
    {
        while (true)
        {
            await BackgroundLayer2.ScaleTo(0.8, 2750, Easing.SinOut);
            await BackgroundLayer2.ScaleTo(1, 2250, Easing.SinInOut);
        }
    }

    private async void AnimateBackgroundLayer3()
    {
        while (true)
        {
            await BackgroundLayer3.ScaleTo(0.7, 3000, Easing.SinInOut);
            await BackgroundLayer3.ScaleTo(0.9, 2500, Easing.SinOut);
        }
    }

    private async void AnimateBackgroundLayer4()
    {
        while (true)
        {
            await BackgroundLayer4.ScaleTo(0.6, 1750, Easing.SinOut);
            await BackgroundLayer4.ScaleTo(0.8, 2000, Easing.SinInOut);
        }
    }
}
```

That’s it. If something’s not working and you need help, leave a comment below. Also, you can find the entire code on [GitHub](https://github.com/StartDebugging/xamarin-forms-animated-backgrounds).
