---
title: "Dart 3.12 の dot shorthands: Flutter コードから型名を省く"
description: "dot shorthands は Dart 3.12.2 で安定版になりました。.center や .new と書けば、コンパイラーがコンテキストから型を推論します。enum、静的メンバー、コンストラクターでの動作を解説します。"
pubDate: 2026-07-05
tags:
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/07/dart-dot-shorthands-drop-the-type-name-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

Flutter のウィジェットツリーが `MainAxisAlignment.center`、`CrossAxisAlignment.start`、`EdgeInsets.all` の壁になっているなら、Dart はその繰り返しの多くを削除する方法をちょうど提供しました。`.center` と書けばコンパイラーが型を判断してくれる機能である dot shorthands が、Dart 3.12.2 で安定版になりました。Flutter 3.44 にはすでに Dart 3.12 が含まれているため、現在の stable チャネルを使っていれば今日から利用できます。

## 先頭のドットが実際に行うこと

dot shorthand は、むき出しの `.` で始まる式です。周囲のコンテキストによって対象の型が一意に定まるとき、Dart は型を完全に書かせるのではなく、その型に対してメンバーを解決します。典型的な例は、代入における enum です。

```dart
Status currentStatus = .running; // Instead of Status.running
```

変数は `Status` として宣言されているため、`.running` は `Status.running` しか意味しえません。同じ推論は `switch` の内部でも働き、そこでは比較対象の値がすでに型を確定させています。

```dart
return switch (level) {
  .debug => 'gray',
  .info => 'blue',
  .warning => 'orange',
  .error => 'red',
};
```

## enum だけではありません

この仕組みは汎用的です。コンテキストの型を通じて到達可能な静的メンバーであれば、どれでも対象になります。これには静的メソッド、静的ゲッター、名前付きコンストラクター、ファクトリーコンストラクターが含まれます。

```dart
int port = .parse('8080');      // int.parse('8080')
BigInt zero = .zero;            // BigInt.zero
Point origin = .origin();       // Point.origin() named constructor
Point p = .fromList([1.0, 2.0]); // Point.fromList(...) factory
```

無名コンストラクターには、この目的のために名前が与えられます。`.new` です。この一点こそ、新しく構築したオブジェクトを型付きフィールドに絶えず代入する実際の Flutter コードで、この機能が価値を発揮する理由です。

```dart
final ScrollController _scrollController = .new();
final GlobalKey<ScaffoldMessengerState> scaffoldKey = .new();
```

## つまずきやすい唯一のルール

等価比較には特別なケースがあります。`==` または `!=` の右辺で shorthand を使うと、Dart は左オペランドの静的な型をコンテキストとして採用します。

```dart
if (myColor == .green) {
  print('The color is green.');
}
```

ここでは `myColor` が `Color` として型付けされているため、`.green` は `Color.green` に解決されます。shorthand は右辺に置く必要があります。`.green == myColor` のように逆にすると、推論の元になる左オペランドの型が存在しないため、コンパイルできません。

## 有効にする方法

dot shorthands は少なくとも 3.10 の言語バージョンを必要とし、この機能は Dart 3.12.2 で stable に到達しました。すでに Flutter 3.44 を使っていれば、利用できます。`pubspec.yaml` の SDK 制約を `^3.12.0` に引き上げれば、アナライザーは先頭のドットを警告しなくなります。runtime のコストはなく、生成されるコードにも変化はありません。これは純粋な構文であり、コンパイル時に、結局は自分で書いていたはずの完全修飾メンバーへと解決されます。

得られるのは、短いコードそのものではありません。型が値ごとに繰り返されるのではなく、宣言の一か所にだけ現れるということです。解決ルールの全体については、[dot shorthands の言語ページ](https://dart.dev/language/dot-shorthands) を参照してください。
