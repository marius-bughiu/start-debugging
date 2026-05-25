---
title: "Dart 3.12 がプライベートフィールドの初期化リストを不要にする"
description: "Dart 3.12 では、コンストラクターが名前付きパラメーターで直接プライベートフィールドを初期化できるようになり、言語に根強く残っていたボイラープレートパターンの一つが解消されます。"
pubDate: 2026-05-25
tags:
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/05/dart-3-12-private-named-parameters-initializing-formals"
translatedBy: "claude"
translationDate: 2026-05-25
---

Dart 3.12 は Google I/O 2026 で Flutter 3.44 とともに登場しましたが、そのリリースには、すべての Dart 開発者が百回は書いてきたボイラープレートコードを取り除く、小さな言語変更が隠れています。プライベートな名前付きパラメーターを initializing formals として使えるようになりました。簡単に言えば、コンストラクターは名前付き引数を受け取り、それを初期化リストなしで直接プライベートフィールドに代入できます。

## Dart が何年も抱えてきたアンダースコアの問題

Dart はフィールドにアンダースコアを前置することでプライベートと印を付けます。この慣習はコンストラクターの名前付きパラメーターと衝突していました。言語が名前付きパラメーターを `_` で始めることを許さなかったからです。その結果が、おなじみの手順でした。パブリックな名前のパラメーターを受け取り、それを初期化リストで手作業によりプライベートフィールドへコピーするのです。

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required String petName, required int wingbeatsPerSecond})
    : _petName = petName,
      _wingbeatsPerSecond = wingbeatsPerSecond;
}
```

プライベートフィールドごとに、パラメーター宣言に加えて初期化のエントリが必要でした。プライベートフィールドが 8 つあるクラスでは、これは純粋な配線だけで 16 行になります。initializing formals (`this.field`) は何年も前にパブリックフィールドについてこれを解決しましたが、プライベートフィールドは遅い経路に取り残されていました。

## 3.12 が実際に変えること

Dart 3.12 は当たり前のことを動くようにします。`this._field` を名前付きパラメーターとして書けば、あとはコンパイラーが処理します。

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required this._petName, required this._wingbeatsPerSecond});
}
```

フィールドはプライベートのままですが、呼び出し側に公開されるパラメーター名はアンダースコアを取り除いたパブリックなバージョンです。そのため呼び出し箇所は以前とまったく同じように読めます。

```dart
void main() {
  print(Hummingbird(petName: 'Dash', wingbeatsPerSecond: 75));
}
```

これは純粋にコンストラクター側の変更です。パブリックな API は同一で、呼び出し側は何も触らず、プライベートフィールドはプライベートのままです。初期化リストを削除しているだけで、それ以上のことはありません。

## 知っておくべき制約

この例外が適用されるのは initializing formals のみです。通常の名前付きパラメーターは依然としてアンダースコアで始められません。それはプライベートな名前を、頼れるパブリックな名前なしにパブリックなシグネチャへ漏らすことになるからです。アンダースコア付きの名前は、有効なパブリック識別子に対応していなければなりません。`this._` と `this._2x` は拒否されます。アンダースコアを取り除くと `` と `2x` が残り、どちらも有効なパラメーター名ではないためです。

この機能は primary constructors とも組み合わせられます。これは同じサイクルで実験的に登場し、3.13 以上の言語バージョンを必要とします。両方を使えば、プライベートフィールドをコンストラクターのヘッダーで直接宣言し、公開向けの名前をコンパイラーに自動で公開させることができます。

すでに Flutter 3.44 を使っているなら、Dart 3.12 が手元にあり、今日からこれを使えます。`pubspec.yaml` の SDK 制約を `^3.12.0` に引き上げ、`dart fix` を実行して、初期化リストを削除し始めましょう。完全なリリースノートは [Dart 3.12 の発表](https://dart.dev/blog/announcing-dart-3-12) を参照してください。
