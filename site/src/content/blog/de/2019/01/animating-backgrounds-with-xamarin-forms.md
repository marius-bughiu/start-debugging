---
title: "Hintergründe in Xamarin Forms animieren"
description: "Erstellen Sie mit ScaleTo-Animationen auf übereinandergelegten BoxViews einen sanften animierten Hintergrundeffekt in Xamarin Forms."
pubDate: 2019-01-02
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2019/01/animating-backgrounds-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ich habe erst kürzlich begonnen, mit Animationen in Xamarin Forms zu spielen, und für eine meiner Apps (Charades for Dota 2) eine schöne Hintergrundanimation gebaut, die ich gerne teilen wollte. Ohne weitere Vorrede ist das hier das Endergebnis:

![](/wp-content/uploads/2019/01/animations3.gif)

Das GIF ruckelt etwas, aber nur weil mein PC den Emulator nicht richtig stemmt. Auf einem Gerät laufen die Animationen flüssig.

Also los: Zuerst wählen wir die Farben. In unserem Fall brauchen wir 5 Farben - eine als Hintergrund der App und 4 für die unterschiedlichen Layer, die wir animieren möchten. Damit es einfach bleibt, wählen Sie eine [Material Color](https://material-ui.com/style/color/); wir nutzen die Abstufungen 500 bis 900. Fügen Sie diese Farben als Ressourcen in Ihrer App oder Page hinzu.

```xml
<ContentPage.Resources>
        <Color x:Key="Color500">#2196F3</Color>
        <Color x:Key="Color600">#1E88E5</Color>
        <Color x:Key="Color700">#1976D2</Color>
        <Color x:Key="Color800">#1565C0</Color>
        <Color x:Key="Color900">#0D47A1</Color>
</ContentPage.Resources>
```

Bauen Sie als Nächstes Ihre Page so auf, dass Sie 4 Hintergrund-Layer haben - jeder Layer ein `BoxView` mit eigener Farbe. Beachten Sie, wie wir die Farben von der dunkelsten zur hellsten Abstufung anordnen.

```xml
<Grid x:Name="LayoutRoot" BackgroundColor="{StaticResource Color900}">
        <BoxView x:Name="BackgroundLayer1" BackgroundColor="{StaticResource Color800}" />
        <BoxView x:Name="BackgroundLayer2" BackgroundColor="{StaticResource Color700}" />
        <BoxView x:Name="BackgroundLayer3" BackgroundColor="{StaticResource Color600}" />
        <BoxView x:Name="BackgroundLayer4" BackgroundColor="{StaticResource Color500}" />
</Grid>
```

Da die Page nun eingerichtet ist, müssen wir nur noch die einzelnen Layer animieren. In unserem Fall skalieren wir jedes Layer mit der Methode `ScaleTo` hoch und runter. Sie nimmt drei Parameter entgegen: die Zielskala der Animation, die Animationsdauer in Millisekunden und die Easing-Funktion. Die letzten beiden sind optional. So verkleinern wir ein Layer:

```cs
await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
```

Sobald das Layer verkleinert ist - beachten Sie, dass wir das Ende der Animation `await`-en - müssen wir die umgekehrte Animation ausführen und es wieder vergrößern. Und wir müssen das in einer Schleife tun:

```cs
while (true)
{
    await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
    await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
}
```

Tun Sie dasselbe für alle 4 Layer in separaten Schleifen, und Sie erhalten denselben Effekt wie im GIF oben. Unten finden Sie den vollständigen Code für die Animation aller 4 Layer.

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

Das war's. Wenn etwas nicht funktioniert und Sie Hilfe brauchen, hinterlassen Sie unten einen Kommentar. Das vollständige Beispiel lag ursprünglich auf GitHub, aber das Repository ist nicht mehr verfügbar.
