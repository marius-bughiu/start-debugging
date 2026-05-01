---
title: "Xamarin Forms - OnPlatform verwenden"
description: "Erfahren Sie, wie Sie OnPlatform in Xamarin Forms nutzen, um plattformspezifische Eigenschaftswerte sowohl in XAML als auch in C# zu setzen."
pubDate: 2019-07-27
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2019/07/xamarin-forms-using-onplatform"
translatedBy: "claude"
translationDate: 2026-05-01
---
Bei der Entwicklung von Xamarin-Forms-Anwendungen werden Sie häufig in der Situation sein, für eine bestimmte Eigenschaft je nach Betriebssystem unterschiedliche Werte setzen zu müssen.

OnPlatform ermöglicht genau das und kann sowohl aus C#-Code als auch aus XAML genutzt werden. Sehen wir uns einige Beispiele an. Für diesen Artikel arbeiten wir mit einem neuen Master-Detail-Projekt.

## OnPlatform mit XAML verwenden

Auf der About-Seite gibt es einen Learn-More-Button. Machen wir seine Farbe plattformabhängig: Grün für Android, Orange für iOS und Lila für UWP.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
    BackgroundColor="{OnPlatform Android=Green, iOS=Orange, UWP=Purple}"
    Command="{Binding OpenWebCommand}"
    TextColor="White" />
```

Und schauen wir uns das Ergebnis an:

![](/wp-content/uploads/2019/07/xamarin-forms-on-platform.png)

Alternativ können Sie auch die folgende Syntax verwenden, die bei komplexeren Datentypen praktischer ist.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
        Command="{Binding OpenWebCommand}"
        TextColor="White">
    <Button.BackgroundColor>
        <OnPlatform x:TypeArguments="Color">
            <On Platform="Android" Value="Green"/>
            <On Platform="iOS" Value="Orange"/>
            <On Platform="UWP" Value="Purple"/>
        </OnPlatform>
    </Button.BackgroundColor>
</Button>
```

## OnPlatform mit C# (veraltet)

Dieselben Anforderungen wie oben, aber dieses Mal in C# statt in XAML. Zuerst geben wir unserem Button x:Name="LearnMoreButton" und schreiben dann im Code-Behind Folgendes:

```cs
Device.OnPlatform(
    Android: () => this.LearnMoreButton.BackgroundColor = Color.Green, 
    iOS: () => this.LearnMoreButton.BackgroundColor = Color.Orange, 
    WinPhone: () => this.LearnMoreButton.BackgroundColor = Color.Purple,
    Default: () => this.LearnMoreButton.BackgroundColor = Color.Black);
```

Gleiches Ergebnis wie zuvor. WinPhone wird auf UWP gemappt, und Sie können zudem einen Default-Wert für die übrigen Plattformen angeben. Diese Methode ist seit XF 2.3.4 veraltet, und es wird empfohlen, stattdessen ein eigenes Switch-Case auf Device.RuntimePlatform zu schreiben.

## Stattdessen Device.RuntimePlatform verwenden

Der obige Code lässt sich übersetzen in:

```cs
switch (Device.RuntimePlatform)
{
    case Device.Android:
        LearnMoreButtonSwitch.BackgroundColor = Color.Green;
        break;
    case Device.iOS:
        LearnMoreButtonSwitch.BackgroundColor = Color.Orange;
        break;
    case Device.UWP:
        LearnMoreButtonSwitch.BackgroundColor = Color.Purple;
        break;
     default:
         LearnMoreButtonSwitch.BackgroundColor = Color.Black;
         break;
}
```

Die derzeit unterstützten Plattformwerte sind: iOS, Android, UWP, macOS, GTK, Tizen und WPF.

Der Quellcode des Beispielprojekts lag ursprünglich auf GitHub, aber das Repository ist nicht mehr verfügbar.
