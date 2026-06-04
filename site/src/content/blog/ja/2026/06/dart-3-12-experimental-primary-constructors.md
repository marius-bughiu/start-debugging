---
title: "Dart 3.12 が実験フラグの背後でプライマリコンストラクターを導入"
description: "Dart 3.12 は、フィールドとコンストラクターをクラスのヘッダーで宣言する実験的なプライマリコンストラクター構文を追加し、従来の3行のデータクラスを1行に縮めます。"
pubDate: 2026-06-04
tags:
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/06/dart-3-12-experimental-primary-constructors"
translatedBy: "claude"
translationDate: 2026-06-04
---

Dart 3.12（2026-05-20 リリース）は、言語の中でも特に要望の多かった機能の1つを実験的なプレビューとして導入しました。プライマリコンストラクターです。単純なデータクラスのために、同じフィールドと `this.field` というコンストラクターパラメーター、さらに代入を3回書いた経験があるなら、これはそのパターンをなくす構文です。今のところ `--enable-experiment=primary-constructors` の背後にありますが、日常的な Dart コードの多くの読み方を変えるため、今日のうちにブランチへ組み込んでみる価値があります。

これは Dart 3.12 のもう1つのボイラープレート削減である、[初期化フォーマルとしての非公開の名前付きパラメーター](/ja/2026/05/dart-3-12-private-named-parameters-initializing-formals/)に続くものです。プライマリコンストラクターはさらに踏み込み、宣言全体をクラスのヘッダーへ移します。

## 4行ではなく1行

これは誰もが書くデータクラスであり、本来コンパイラーが最初から生成すべきだった部分です。

```dart
class Point {
  final int x;
  final int y;
  Point(this.x, this.y);
}
```

プライマリコンストラクターを使うと、フィールド宣言とコンストラクターはヘッダーへとまとめられます。空のクラス本体はセミコロンになります。

```dart
class Point(final int x, final int y);
```

ルールはシンプルです。ヘッダーで `final` または `var` を付けたパラメーターはインスタンスフィールドになります。修飾子を外すと、フィールドではなく通常のコンストラクターパラメーターのままです。したがって `class User(String name);` は `name` を保持せずに引数として受け取り、`class User(final String name);` はそれを保持します。

## フィールドはヘッダーのパラメーターに依存できます

ヘッダーのパラメーターはクラス本体のスコープ内にあるため、初期化リストなしでそれらから他の非 `late` フィールドを初期化できます。

```dart
class DeltaPoint(final int x, int delta) {
  final int y = x + delta;
}
```

ここで `delta` はコンストラクターパラメーター（`final` がないためフィールドではありません）で、`y` はそれから計算されます。

## 本体で検証を追加する

assert やセットアップが必要な場合は、`this` で導入されるコンストラクター本体を書きます。初期化リストのみの形式はセミコロンで終わります。

```dart
class Point(var int x, var int y) {
  this : assert(x >= 0 && y >= 0) {
    print('Point initialized at ($x, $y)');
  }
}
```

名前付きコンストラクターも、本体で `new` を使うより簡潔な形式を得ます。

```dart
class Pet {
  String name;

  new() : name = 'Fluffy';
  new withName(this.name);
}
```

## 有効にする方法

この機能は実験的なので、実行ごとに有効にします。

```bash
dart run --enable-experiment=primary-constructors bin/main.dart
```

実験的であるため、プレビューとして扱ってください。構文は安定する前にまだ変わる可能性があり、`final` と `var` はパラメーターリスト内で特別な意味を持つようになったので、共有の本番コードにはまだ取り込まないでください。ただしサイドブランチでは、プライマリコンストラクターによって Flutter のウィジェットモデル、値オブジェクト、設定ホルダーが大幅に短くなります。super パラメーターや名前付きコンストラクターのルールを含む完全な仕様は、[Dart のプライマリコンストラクターのドキュメント](https://dart.dev/language/primary-constructors)にあります。
