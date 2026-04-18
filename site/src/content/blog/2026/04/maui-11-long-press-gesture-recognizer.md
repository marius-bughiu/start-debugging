---
title: ".NET MAUI 11 Ships a Built-in LongPressGestureRecognizer"
description: ".NET MAUI 11 Preview 3 adds LongPressGestureRecognizer as a first-party gesture, with duration, movement threshold, state events, and command binding, replacing the common Community Toolkit behavior."
pubDate: 2026-04-16
tags:
  - ".NET MAUI"
  - ".NET 11"
  - "XAML"
  - "Mobile"
---

Until now, detecting a long press in .NET MAUI meant reaching for a third-party behavior, the [Community Toolkit's TouchBehavior](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/behaviors/touch-behavior), or writing platform handlers per OS. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) promotes the pattern to a first-party API with `LongPressGestureRecognizer`, landing via [dotnet/maui #33432](https://github.com/dotnet/maui/pull/33432).

## What you get out of the box

The new recognizer sits next to `TapGestureRecognizer`, `PanGestureRecognizer`, and the rest of the family. It exposes four things that matter for real UIs:

- `MinimumPressDuration` in milliseconds, defaulting to the platform convention (around 500ms on Android, 400ms on iOS).
- A `MovementThreshold` in device-independent units that cancels the gesture if the user drags beyond it, so a scroll never fires a long press.
- A `StateChanged` event reporting `Started`, `Running`, `Completed`, and `Canceled`, useful for haptic feedback or visual pressed states.
- `Command` and `CommandParameter` for MVVM bindings, and a `LongPressed` event for plain code-behind.

Because it hangs off `GestureRecognizers`, any `View` that already accepts gestures picks it up without handler changes.

## Replacing TouchBehavior in XAML

A context menu on an avatar image is the canonical case. In .NET MAUI 10 this typically required a TouchBehavior with a `LongPressCommand`. In .NET MAUI 11 it collapses to:

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

The recognizer dispatches on the UI thread and passes the bound parameter straight through, so the view model stays platform-agnostic.

## Reacting to state for press feedback

The `StateChanged` event is what makes this feel native. Most platform long presses animate a scale or dim the target during the hold, and cancel cleanly if the finger drifts. With the new API that logic lives in one place:

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

That single event replaces three platform handlers and a Behavior wired up in `MauiProgram`.

## Why this matters for library authors

Control libraries that previously shipped their own long-press plumbing can now rely on a shared contract. A `Microsoft.Maui.Controls` recognizer means bindings, input transparency, and `IsEnabled` propagation already work the way the rest of the framework works, so consumers stop hitting inconsistencies like the gesture firing during a `CollectionView` scroll or not respecting `InputTransparent="True"` on a parent.

If you are still on the Community Toolkit TouchBehavior, the migration is usually a one-line swap and a property rename. Check the full [Preview 3 MAUI release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/dotnetmaui.md) for the surrounding gesture and XAML changes.
