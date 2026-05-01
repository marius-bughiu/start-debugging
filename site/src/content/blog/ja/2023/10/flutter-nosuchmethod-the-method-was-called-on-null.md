---
title: "Flutter NoSuchMethod: the method was called on null"
description: "null のオブジェクト参照に対してメソッドを呼び出したときに発生する Flutter のエラーです。コールスタックとブレークポイントを使った NoSuchMethod の原因特定と修正方法を解説します。"
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "ja"
translationOf: "2023/10/flutter-nosuchmethod-the-method-was-called-on-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
このエラーは、`null` のオブジェクト参照に対してメソッドを呼び出そうとしたときに発生します。呼び出し対象が `null` または未代入のため、そのようなメソッドが存在しないのです。たとえば、

```dart
foo.bar()
```

は、`foo` が `null` のときには必ず `NoSuchMethod` エラーで失敗します。エラーメッセージは `NoSuchMethod: the method 'bar' was called on null` のようになります。

これは C# の `NullReferenceException` に相当します。

## どう直せばよい?

コールスタックを使って、エラーが発生した行を特定しましょう。メソッド名はエラーメッセージに含まれているので、通常はそれだけで十分です。それで足りなければ、その行にブレークポイントを設定し、到達した時点で変数の値を確認して `null` を探します。見つかったら、なぜその状態になったのかを突き止め、原因を取り除きましょう。
