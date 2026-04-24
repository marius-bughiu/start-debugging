---
title: ".NET MAUI 11 liefert einen eingebauten LongPressGestureRecognizer"
description: ".NET MAUI 11 Preview 3 fügt LongPressGestureRecognizer als First-Party-Geste hinzu, mit Duration, Bewegungs-Threshold, State-Events und Command-Binding - und ersetzt das übliche Community-Toolkit-Behavior."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "xaml"
  - "mobile"
lang: "de"
translationOf: "2026/04/maui-11-long-press-gesture-recognizer"
translatedBy: "claude"
translationDate: 2026-04-24
---

Bis jetzt hieß Long Press in .NET MAUI zu erkennen, zu einem Drittanbieter-Behavior zu greifen, dem [TouchBehavior des Community Toolkits](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/behaviors/touch-behavior), oder Platform Handler pro OS zu schreiben. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) erhebt das Pattern zu einer First-Party-API mit `LongPressGestureRecognizer`, eingelandet über [dotnet/maui #33432](https://github.com/dotnet/maui/pull/33432).

## Was Sie out of the box bekommen

Der neue Recognizer sitzt neben `TapGestureRecognizer`, `PanGestureRecognizer` und dem Rest der Familie. Er exponiert vier Dinge, die für echte UIs zählen:

- `MinimumPressDuration` in Millisekunden, per Default an der Plattformkonvention (rund 500ms auf Android, 400ms auf iOS).
- Einen `MovementThreshold` in Device-Independent-Units, der die Geste abbricht, wenn der Nutzer darüber hinaus zieht, sodass ein Scroll nie einen Long Press auslöst.
- Ein `StateChanged`-Event, das `Started`, `Running`, `Completed` und `Canceled` meldet, nützlich für Haptic Feedback oder visuelle Pressed-Zustände.
- `Command` und `CommandParameter` für MVVM-Bindings und ein `LongPressed`-Event für schlichten Code-Behind.

Weil er an `GestureRecognizers` hängt, nimmt jede `View`, die bereits Gesten akzeptiert, ihn ohne Handler-Änderungen auf.

## TouchBehavior in XAML ersetzen

Ein Kontextmenü auf einem Avatarbild ist der kanonische Fall. In .NET MAUI 10 brauchte das typischerweise ein TouchBehavior mit einem `LongPressCommand`. In .NET MAUI 11 kollabiert das zu:

```xaml
<Image Source="avatar.png"
       HeightRequest="64"
       WidthRequest="64">
    <Image.GestureRecognizers>
        <LongPressGestureRecognizer
            MinimumPressDuration="650"
            MovementThreshold="10"
            Command="{Binding ShowContextMenuCommand}"
            CommandParameter="{Binding .}" />
    </Image.GestureRecognizers>
</Image>
```

Der Recognizer dispatcht auf dem UI-Thread und reicht den gebundenen Parameter direkt durch, sodass das View Model plattformagnostisch bleibt.

## Auf State reagieren für Press-Feedback

Das `StateChanged`-Event ist das, was das nativ anfühlen lässt. Die meisten Plattform-Long-Presses animieren eine Scale oder dimmen das Target während des Halts und brechen sauber ab, wenn der Finger verrutscht. Mit der neuen API lebt diese Logik an einer Stelle:

```csharp
var longPress = new LongPressGestureRecognizer
{
    MinimumPressDuration = 500
};

longPress.StateChanged += async (s, e) =>
{
    switch (e.State)
    {
        case GestureRecognizerState.Started:
            await card.ScaleTo(0.97, 80);
            break;
        case GestureRecognizerState.Completed:
            await HapticFeedback.Default.PerformAsync(HapticFeedbackType.LongPress);
            await card.ScaleTo(1.0, 80);
            ShowMenu();
            break;
        case GestureRecognizerState.Canceled:
            await card.ScaleTo(1.0, 80);
            break;
    }
};

card.GestureRecognizers.Add(longPress);
```

Dieses eine Event ersetzt drei Platform Handler und ein im `MauiProgram` verdrahtetes Behavior.

## Warum das für Library-Autoren zählt

Control Libraries, die zuvor eigene Long-Press-Plumbing ausgeliefert haben, können sich jetzt auf einen gemeinsamen Contract stützen. Ein `Microsoft.Maui.Controls`-Recognizer bedeutet, dass Bindings, Input Transparency und `IsEnabled`-Propagation bereits so arbeiten, wie der Rest des Frameworks arbeitet, sodass Konsumenten nicht mehr auf Inkonsistenzen stoßen wie die Geste, die während eines `CollectionView`-Scrolls auslöst oder `InputTransparent="True"` an einem Parent ignoriert.

Wenn Sie noch auf dem Community-Toolkit-TouchBehavior sind, ist die Migration meist ein Ein-Zeilen-Tausch und ein Property-Rename. Schauen Sie in die vollständigen [MAUI-Release-Notes für Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/dotnetmaui.md) für die begleitenden Gesten- und XAML-Änderungen.
