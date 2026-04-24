---
title: ".NET MAUI 11 поставляется со встроенным LongPressGestureRecognizer"
description: ".NET MAUI 11 Preview 3 добавляет LongPressGestureRecognizer как жест first-party, с duration, порогом движения, событиями state и command-binding, заменяя распространённый behavior из Community Toolkit."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "xaml"
  - "mobile"
lang: "ru"
translationOf: "2026/04/maui-11-long-press-gesture-recognizer"
translatedBy: "claude"
translationDate: 2026-04-24
---

До сих пор детектировать long press в .NET MAUI означало тянуться за сторонним behavior, [TouchBehavior из Community Toolkit](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/behaviors/touch-behavior), или писать platform handlers по ОС. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) продвигает паттерн в first-party API с `LongPressGestureRecognizer`, приземляясь через [dotnet/maui #33432](https://github.com/dotnet/maui/pull/33432).

## Что вы получаете из коробки

Новый recognizer сидит рядом с `TapGestureRecognizer`, `PanGestureRecognizer` и остальной семьёй. Он выставляет четыре важных для реальных UI вещи:

- `MinimumPressDuration` в миллисекундах, по умолчанию следующий конвенции платформы (около 500ms на Android, 400ms на iOS).
- `MovementThreshold` в device-independent единицах, отменяющий жест, если пользователь потянул дальше, так что scroll никогда не стрельнёт long press.
- Событие `StateChanged`, сообщающее `Started`, `Running`, `Completed` и `Canceled`, полезное для haptic feedback или визуальных pressed-состояний.
- `Command` и `CommandParameter` для MVVM-bindings, и событие `LongPressed` для простого code-behind.

Поскольку он висит на `GestureRecognizers`, любая `View`, уже принимающая жесты, подхватывает его без изменений handler.

## Замена TouchBehavior в XAML

Контекстное меню на изображении аватара - канонический случай. В .NET MAUI 10 это обычно требовало TouchBehavior с `LongPressCommand`. В .NET MAUI 11 это сжимается до:

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

Recognizer диспатчит на UI thread и пробрасывает привязанный параметр насквозь, так что view model остаётся platform-agnostic.

## Реакция на state для press feedback

Событие `StateChanged` - то, что делает это похожим на нативное. Большинство платформенных long press анимируют scale или затемняют target во время удержания и чисто отменяются, если палец уплыл. С новым API эта логика живёт в одном месте:

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

Это одно событие заменяет три platform handlers и Behavior, завязанный в `MauiProgram`.

## Почему это важно для авторов библиотек

Библиотеки контролов, которые раньше поставляли собственную инфраструктуру long-press, теперь могут опираться на общий контракт. Recognizer `Microsoft.Maui.Controls` означает, что bindings, input transparency и пропагация `IsEnabled` уже работают так же, как работает остальной framework, так что потребители перестают биться о несогласованности вроде срабатывания жеста во время scroll в `CollectionView` или несоблюдения `InputTransparent="True"` на родителе.

Если вы всё ещё на TouchBehavior из Community Toolkit, миграция обычно - однострочный swap и переименование property. Смотрите полные [release notes MAUI для Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/dotnetmaui.md) на предмет сопутствующих изменений жестов и XAML.
