---
title: "Fluorite: Toyota が Flutter と Dart 上にコンソール級ゲームエンジンを構築"
description: "Fluorite は Google Filament レンダリングを Flutter ウィジェット内に埋め込み、ゲームロジックを Dart で書けるオープンソースの 3D ゲームエンジンです。"
pubDate: 2026-04-13
tags:
  - "flutter"
  - "dart"
  - "game-development"
  - "fluorite"
  - "open-source"
lang: "ja"
translationOf: "2026/04/fluorite-toyota-console-grade-game-engine-flutter-dart"
translatedBy: "claude"
translationDate: 2026-04-25
---

Toyota Connected North America は完全に Flutter 内で動作する 3D ゲームエンジン [Fluorite](https://fluorite.game/) をオープンソース化しました。これはブリュッセルでの [FOSDEM 2026](https://fosdem.org/2026/schedule/event/7ZJJWW-fluorite-game-engine-flutter/) で紹介され、それ以来 [Hacker News](https://news.ycombinator.com/item?id=46976911) で注目を集めています。売り文句: コンソール級のレンダリング、C++ ECS コア、Flutter の標準ツーリングを使用して Dart で書かれたゲームロジック。

## ゲームエンジンになぜ Flutter なのか

Toyota は車載デジタルコックピットとダッシュボード向けにインタラクティブな 3D 体験を必要としていました。Unity と Unreal はライセンス費用とリソースの重さを伴い、組み込み自動車ハードウェアには合いません。Godot の起動オーバーヘッドはもう一つの懸念でした。Flutter は UI 作業のためにすでに彼らのスタックにあったので、第 2 のフレームワークを導入する代わりにその上にレンダリング層を構築しました。

結果が Fluorite です。パフォーマンスクリティカルな作業のための薄い C++ ECS (Entity-Component-System) コア、Vulkan を介して PBR レンダリングを処理する [Google Filament](https://github.com/google/filament)、ゲームロジックのスクリプト言語としての Dart です。

## FluoriteView と Flutter 統合

主要な統合ポイントは `FluoriteView` ウィジェットです。これを Flutter ウィジェットツリーにドロップすると、ライブの 3D シーンをレンダリングします。

```dart
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Stack(
      children: [
        FluoriteView(
          scene: myScene,
          onReady: (controller) {
            controller.loadModel('assets/car_interior.glb');
          },
        ),
        Positioned(
          bottom: 16,
          right: 16,
          child: ElevatedButton(
            onPressed: () => setState(() => _lightsOn = !_lightsOn),
            child: Text(_lightsOn ? 'Lights Off' : 'Lights On'),
          ),
        ),
      ],
    ),
  );
}
```

複数の `FluoriteView` ウィジェットが同じシーンを異なるカメラアングルから同時にレンダリングできます。状態はゲームエンティティと Flutter ウィジェットの間で、すでに使用しているのと同じパターンで流れます。`setState`、プロバイダー、またはアプリが頼るその他の状態管理アプローチです。

## モデル定義のタッチゾーン

自動車用途で目立つ機能の 1 つはモデル定義のタッチゾーンです。3D アーティストは Blender 内で直接クリック可能な領域にタグを付けます。実行時に、Fluorite はそれらのタグをイベントソースとして公開するので、開発者はコードで手動でヒットテストジオメトリを定義することなく、特定のダッシュボードノブや制御部の `onClick` をリッスンできます。

## ホットリロードが動作する

Fluorite は Flutter 内で動作するため、`flutter run` のホットリロードはシーン変更にも適用されます。ウィジェットレイアウトを変更したり、光源パラメータを調整したり、モデル参照を交換したりすると、更新がフレーム内に反映されます。これは、変更を見るために完全な再コンパイルが必要なエンジンに対する大きなワークフロー上の優位性です。

## ダッシュボードを超えて

このエンジンはモバイル、デスクトップ、組み込み、そして潜在的にコンソールプラットフォームを対象としています。Toyota は車のために構築しましたが、アーキテクチャはその領域に限定されません。ハードウェアアクセラレーションされた 3D を必要とする任意の Flutter プロジェクト、製品コンフィギュレーター、建築ウォークスルー、簡単なゲームを考えてみてください、これらは Dart エコシステムを離れることなく Fluorite を使用できます。

プロジェクトはオープンソースライセンスのもと [fluorite.game](https://fluorite.game/) で利用可能です。すでに Flutter を出荷していて、第 2 のエンジンランタイムを接ぎ木せずに 3D が必要なら、Fluorite は評価する価値があります。
