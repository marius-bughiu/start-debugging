---
title: "Flutter 3.44: MediaQuery から画面の物理的な角の半径を読み取る"
description: "Flutter 3.44 は MediaQuery.displayCornerRadiiOf を通じてデバイスの丸い角を公開します。魔法の半径を当て推量するのはやめて、Android API 31+ でハードウェアの正確なカーブに UI をクリップしましょう。"
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery"
translatedBy: "claude"
translationDate: 2026-07-07
---

スマートフォンが四角い画面をやめてから何年も経ちますが、Flutter は角が実際にどれくらい丸いのかを教えてくれませんでした。カードや全画面のシートをディスプレイの物理的なカーブに沿わせたい場合、1 つのデバイスに合わせて目分量で調整した `BorderRadius.circular(24)` をハードコードし、残りの端末でもよく見えることを祈るしかありませんでした。現在の安定版である Flutter 3.44 は、ついにその値をハードウェアから直接読み取り、`MediaQuery` を通じて渡してくれます。

## OS がすでに知っていた値

Android は API レベル 31 以降、`RoundedCorner` API を通じて角ごとの半径を公開していましたが、フレームワークはそれを表に出しませんでした。[PR #179219](https://github.com/flutter/flutter/pull/179219) は、それらの半径をエンジンのウィンドウメトリクスから `MediaQueryData` まで引き上げます。padding や view insets を読むのと同じように読み取ります。

```dart
final BorderRadius? corners = MediaQuery.displayCornerRadiiOf(context);
```

戻り値の型は null 許容の `BorderRadius` です。各角は論理ピクセル単位の `Radius` なので、すでに使っているウィジェットと直接組み合わせられます。API 31 未満の Android、iOS、その他すべてのプラットフォームでは値が `null` になるため、null チェックは後付けの発想ではなく、フォールバックの経路そのものです。

## ハードウェアのカーブに合わせてクリップする

わかりやすい使い方は、丸みがガラスに一致する全画面のサーフェスです。以前は数値をでっち上げていました。今はディスプレイに尋ねます。

```dart
@override
Widget build(BuildContext context) {
  final BorderRadius radius =
      MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.circular(16);

  return ClipRRect(
    borderRadius: radius,
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: content,
    ),
  );
}
```

`displayCornerRadii` は本物の `BorderRadius` なので、4 つの角が異なっていても構いません。これは、下側のカーブが上側より急なデバイスや、折りたたみのヒンジによって片方の端が異なるプロファイルになるデバイスで重要になります。1 つの角だけが必要なときは、単一の角を取り出すこともできます。

```dart
final Radius topLeft =
    (MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.zero).topLeft;
```

## 物理ピクセルが必要なとき

`MediaQuery` は論理ピクセルを返します。これはレイアウトのコードが求めるものです。カスタムの `RenderObject` やシェーダーの内部など、生のピクセルレベルで作業する場合は、同じデータが view 上にあります。`FlutterView.displayCornerRadii` は値を物理ピクセルで返します。描画している座標空間に一致する方を選べば、逆にしがちな `devicePixelRatio` の乗算を避けられます。

## これが本当に効いてくる場面

ほとんどのアプリはピクセル単位で完璧な角の一致を必要とせず、`SafeArea` は今もノッチの外にコンテンツを保つという一般的なケースを処理します。これは、デバイスそのものの一部として読み取られるサーフェスのためのものです。ガラスの端までせり上がるボトムシート、没入型のメディアプレーヤー、キオスク用のレイアウト、そして新しい予測型の戻り遷移などです。Flutter 3.44 はすでにこの遷移を `displayCornerRadii` に接続しており、退場する画面が正しく丸められた矩形へと縮みます。

この機能は小さいものですが、デザイナーから開発者への引き継ぎのたびに当て推量の数値で終わっていたギャップを埋めます。`null` は「四角形とみなし、自分の定数にフォールバックする」と扱えば、あとは OS がずっと保持していた値を読み取るだけです。完全な仕様については [MediaQueryData.displayCornerRadii のドキュメント](https://api.flutter.dev/flutter/widgets/MediaQueryData/displayCornerRadii.html) を参照してください。
