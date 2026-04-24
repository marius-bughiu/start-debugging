---
title: ".NET MAUI 11 がビルトインの LongPressGestureRecognizer を出荷"
description: ".NET MAUI 11 Preview 3 は LongPressGestureRecognizer を first-party のジェスチャーとして追加し、duration、移動しきい値、state イベント、command バインディングを備え、一般的な Community Toolkit の behavior を置き換えます。"
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "xaml"
  - "mobile"
lang: "ja"
translationOf: "2026/04/maui-11-long-press-gesture-recognizer"
translatedBy: "claude"
translationDate: 2026-04-24
---

今まで .NET MAUI で long press を検出するには、サードパーティの behavior、[Community Toolkit の TouchBehavior](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/behaviors/touch-behavior) に手を伸ばすか、OS ごとに platform handler を書く必要がありました。[.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) は、[dotnet/maui #33432](https://github.com/dotnet/maui/pull/33432) 経由で `LongPressGestureRecognizer` と共にパターンを first-party API に昇格させます。

## すぐに得られるもの

新しい recognizer は `TapGestureRecognizer`、`PanGestureRecognizer`、そしてファミリーの残りの隣に座ります。実際の UI に重要な 4 つを公開します:

- `MinimumPressDuration` はミリ秒で、デフォルトはプラットフォームの慣例 (Android で約 500ms、iOS で約 400ms) に従います。
- `MovementThreshold` はデバイス非依存単位で、ユーザーがそれを超えてドラッグするとジェスチャーをキャンセルします。スクロールが long press を発火しないためです。
- `StateChanged` イベントは `Started`、`Running`、`Completed`、`Canceled` を報告し、触覚フィードバックや視覚的な押下状態に便利です。
- MVVM バインディング用の `Command` と `CommandParameter`、そしてプレーンな code-behind 用の `LongPressed` イベント。

`GestureRecognizers` にぶら下がっているので、すでにジェスチャーを受け付けるあらゆる `View` が handler 変更なしで拾い上げます。

## XAML で TouchBehavior を置き換える

アバター画像のコンテキストメニューは定型例です。.NET MAUI 10 では通常、`LongPressCommand` を持つ TouchBehavior が必要でした。.NET MAUI 11 ではこう折りたたまれます:

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

recognizer は UI スレッドで dispatch し、バインドされたパラメータをまっすぐ通すので、view model はプラットフォーム非依存のままです。

## press フィードバックのために state に反応する

`StateChanged` イベントはこれをネイティブっぽく感じさせるものです。ほとんどのプラットフォームの long press はホールド中にスケールをアニメートしたりターゲットを暗くしたりし、指が漂えばきれいにキャンセルします。新しい API ではそのロジックが 1 箇所に住みます:

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

この単一のイベントが 3 つの platform handler と `MauiProgram` に配線された Behavior を置き換えます。

## ライブラリ作者になぜ重要か

以前自前の long-press 配管を出荷していたコントロールライブラリは、共有契約に依存できるようになりました。`Microsoft.Maui.Controls` の recognizer ならば、bindings、input transparency、そして `IsEnabled` の伝播がすでにフレームワークの残りと同じように動くので、消費者は `CollectionView` スクロール中にジェスチャーが発火するとか、親の `InputTransparent="True"` を尊重しないとかいった不整合に当たらなくなります。

まだ Community Toolkit の TouchBehavior を使っているなら、マイグレーションは通常 1 行の入れ替えとプロパティのリネームです。周辺のジェスチャーと XAML 変更については [Preview 3 MAUI リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/dotnetmaui.md) 全体を確認してください。
