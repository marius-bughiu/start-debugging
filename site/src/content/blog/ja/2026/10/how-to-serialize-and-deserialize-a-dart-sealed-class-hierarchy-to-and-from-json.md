---
title: "Dart の sealed クラス階層を JSON にシリアライズ/デシリアライズする方法"
description: "JSON に判別フィールドを入れ、sealed な基底クラスのファクトリでそれを switch し、書き戻すときはサブタイプで switch します。Dart 3.13.7 で動作する 3 つの実装(手書きのパターンマッチング、json_serializable 6.15.2、unionKey と fallbackUnion を使う Freezed 4.0.3)と、それぞれに潜む落とし穴を紹介します。"
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "json"
  - "freezed"
  - "json-serializable"
  - "sealed-classes"
lang: "ja"
translationOf: "2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json"
translatedBy: "claude"
translationDate: 2026-10-25
---

**結論:** JSON には、オブジェクトがどの Dart サブクラスから来たのかという情報がありません。そのため、通常は `"type": "circle"` のような判別フィールドとして、その情報をペイロードに自分で書き込む必要があります。デシリアライズでは、sealed な基底クラスに `factory Shape.fromJson` を用意し、そのフィールドで switch して適切なサブクラスに処理を委譲します。シリアライズでは、`this` に対して switch する `toJson` を用意し(`sealed` のおかげで網羅性が検査されます)、判別フィールドを書き戻します。これは Dart 3 のマップパターンで手書きすることも、サブクラスごとの本体は json_serializable に生成させてディスパッチだけ自分で書くことも、`@Freezed(unionKey: 'type')` で Freezed にすべて生成させることもできます。以下の内容はすべて、Dart 3.13.7(Flutter 3.47.8 の SDK)上で json_serializable 6.15.2、json_annotation 4.12.0、Freezed 4.0.3、freezed_annotation 3.1.0、build_runner 2.17.1 を使ってコンパイルし、実行して確認しています。

## sealed 階層がそのままではラウンドトリップしない理由

`Circle` と `Rect` というサブクラスを持つ `sealed class Shape` を使うと、Dart の内部では網羅的な `switch` 検査が効きますが、`jsonDecode` が返すのは `Map<String, dynamic>`、`List<dynamic>`、`String`、`num`、`bool`、`null` だけです。`{"radius": 2}` のどこにも"これは `Circle` だった" とは書かれていません。そのため作業は、異なる道具が必要な 2 つの方向に分かれます。

- **Dart から JSON** は、実際のオブジェクトがあるので簡単です。sealed 型に対する `switch (this)` はコンパイラーが検査するため、後から `Triangle` を追加すると、それを忘れているすべての `toJson` がコンパイルエラーになります。
- **JSON から Dart** が難しい方向です。ワイヤー上の*文字列*で switch することになり、考えられるすべての文字列がサブクラスに対応しているかをコンパイラーは検査できません。未知の判別値や判別値の欠落に対する方針が必要です。

判別フィールドの名前は `type` である必要はありません。Freezed のデフォルトは `runtimeType` で、多くの API は `kind` や `@type` を使い、判別フィールドがまったくなく、どのキーが存在するかからサブタイプを推測しなければならない API もあります。以下の 3 つの方法はいずれも、これらのケースを扱えます。

## 最小の階層とワイヤーフォーマット

すべての例で使う形は次のとおりです。

```json
[
  { "type": "circle", "radius": 2 },
  { "type": "rect", "width": 3, "height": 4.5 }
]
```

`"radius": 2` に注目してください。`jsonDecode` はこれを `double` ではなく `int` にします。フィールドが `double` と宣言されている場合、これはすぐに問題になります。

## 方法 1: Dart 3 のマップパターンによる手書き

パッケージもコード生成も不要です。マップパターンは、キーが存在すること*と*値の型が正しいことを 1 ステップで検査します。

```dart
// Dart 3.13.7, no packages
sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
        {'type': 'circle', 'radius': num radius} => Circle(radius.toDouble()),
        {'type': 'rect', 'width': num w, 'height': num h} =>
          Rect(w.toDouble(), h.toDouble()),
        {'type': String type} =>
          throw FormatException('Unknown or malformed Shape "$type"', json),
        _ => throw FormatException('Missing "type" discriminator', json),
      };

  Map<String, dynamic> toJson() => switch (this) {
        Circle(:final radius) => {'type': 'circle', 'radius': radius},
        Rect(:final width, :final height) =>
          {'type': 'rect', 'width': width, 'height': height},
      };
}

final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;
}

final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;
}
```

上のペイロードに対して実行した結果です。

```text
[Circle, Rect]
[{"type":"circle","radius":2.0},{"type":"rect","width":3.0,"height":4.5}]
manual unknown THREW FormatException: Unknown or malformed Shape "hexagon"
manual missing type THREW FormatException: Missing "type" discriminator
manual circle missing radius THREW FormatException: Unknown or malformed Shape "circle"
manual radius as string THREW FormatException: Unknown or malformed Shape "circle"
```

次の 3 点が、よくある `json['radius'] as double` というスニペットよりもこの実装を優れたものにしています。

1. **`num` を使い、そのあと `.toDouble()`。** `'radius': double r` でマッチさせると、デコードされた値が `int` なので `2` で失敗します。`num` でマッチさせれば両方を受け付けます。
2. **不正なペイロードは `TypeError` ではなく、自分のメッセージで失敗します。** 半径のない円や `"radius": "2"` の円は最初のケースにマッチせず、`{'type': String type}` のケースに落ちて、問題のあるマップを保持した `FormatException` をスローします。
3. **`toJson` はコンパイラーが検査します。** `final class Triangle extends Shape` を追加して対応を忘れると、アナライザーが止めてくれます。

```text
error - The type 'Shape' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'Triangle()'. Try adding a wildcard pattern or cases that match 'Triangle()'. - non_exhaustive_switch_expression
```

`fromJson` にはそのような検査がありません。マップの内容で switch しているためです。サブクラスを追加するときにレビュアーが両方を目にできるよう、2 つの switch は基底クラスの中で隣り合わせに置いてください。

### API に判別フィールドがない場合

ペイロードを制御できず、`{"radius": 2}` や `{"width": 3, "height": 4.5}` のような形をしている場合は、同じマップパターンでキーの*有無*によってディスパッチできます。

```dart
// Dart 3.13.7: dispatch on key presence, no "type" field on the wire
factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
      {'radius': num r} => Circle(r.toDouble()),
      {'width': num w, 'height': num h} => Rect(w.toDouble(), h.toDouble()),
      _ => throw FormatException('Not a Shape', json),
    };
```

ここでは順序が重要です。マップパターンは余分なキーを無視するので、最も限定的なケースを先に置いてください。`width`、`height`、`cornerRadius` を持つ `RoundedRect` は `Rect` より前にマッチさせないと、すべての角丸長方形が通常の長方形になってしまいます。

手書きの実装は、フィールドが数個ずつの 3 から 5 個程度のサブクラスなら適切な選択です。それを超えると、フィールドごとの定型コードがバグの温床になり、コード生成のほうが見合うようになります。

## 方法 2: サブクラスは json_serializable、基底クラスのディスパッチは自前

json_serializable は sealed 階層を理解しません。機能リクエストの [google/json_serializable.dart#1342 "Support dart3 sealed class"](https://github.com/google/json_serializable.dart/issues/1342) は 2023 年 8 月から open のままで、6.15.2 の時点でもまだ open です。json_serializable が得意なのは、各具象クラスのフィールドごとのコードを生成することなので、パターンはこうなります。サブクラスにアノテーションを付け、基底クラスの 2 つの switch は手で書きます。

```dart
// Dart 3.13.7, json_serializable 6.15.2, json_annotation 4.12.0
import 'package:json_annotation/json_annotation.dart';

part 'shape.g.dart';

sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json['type']) {
        'circle' => Circle.fromJson(json),
        'rect' => Rect.fromJson(json),
        final type => throw CheckedFromJsonException(
            json, 'type', 'Shape', 'Unknown Shape type "$type"'),
      };

  Map<String, dynamic> toJson();
}

@JsonSerializable()
final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;

  factory Circle.fromJson(Map<String, dynamic> json) => _$CircleFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'circle', ..._$CircleToJson(this)};
}

@JsonSerializable()
final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;

  factory Rect.fromJson(Map<String, dynamic> json) => _$RectFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'rect', ..._$RectToJson(this)};
}
```

`dart run build_runner build` を実行してください。生成される `_$CircleToJson` には `radius` しか含まれず、判別フィールドについては何も知りません。そのため、各オーバーライドでは `'type'` から始まるマップにそれを展開しています。未知の型に対して `CheckedFromJsonException` をスローすると、エラーの形が生成コードが他の場所でスローするものと同じになるため、1 つの `on CheckedFromJsonException` ハンドラーで両方を扱えます。

`Shape` には `fromJson` ファクトリと `toJson` メソッドがあるので、フィールドとして現れたときには、json_serializable は他のシリアライズ可能な型と同じように扱います。コンテナークラスでも、デコードはそのまま動きます。

```dart
// Dart 3.13.7, json_serializable 6.15.2
@JsonSerializable(explicitToJson: true)
class Drawing {
  Drawing(this.name, this.shapes);
  final String name;
  final List<Shape> shapes;

  factory Drawing.fromJson(Map<String, dynamic> json) => _$DrawingFromJson(json);
  Map<String, dynamic> toJson() => _$DrawingToJson(this);
}
```

生成されたデコーダーは、すべての要素に対して `Shape.fromJson(e as Map<String, dynamic>)` を呼び出すので、自分で書いたディスパッチが再利用されます。`explicitToJson: true` は付けたままにしてください。理由は下の落とし穴で説明します。

唯一の弱点は、ペイロードにフィールドが欠けているとき、生成コードがそれがどのフィールドかを教えてくれないことです。`Shape.fromJson({'type': 'circle'})` は `type 'Null' is not a subtype of type 'num' in type cast` をスローします。キー名を示す `CheckedFromJsonException` が欲しい場合は、サブクラスに `@JsonSerializable(checked: true)` を追加してください。

## 方法 3: Freezed がユニオン全体を生成する

Freezed は sealed 階層を、複数のファクトリコンストラクターを持つクラスとして表現します。json_serializable も dev 依存関係に入っていれば、ディスパッチ、判別フィールド、ケースごとのコードを生成します。

```dart
// Dart 3.13.7, freezed 4.0.3, freezed_annotation 3.1.0, json_serializable 6.15.2
import 'package:freezed_annotation/freezed_annotation.dart';

part 'shape.freezed.dart';
part 'shape.g.dart';

@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
sealed class Shape with _$Shape {
  const factory Shape.circle({required double radius}) = Circle;
  const factory Shape.rect({required double width, required double height}) =
      Rect;
  const factory Shape.roundedRect({
    required double width,
    required double height,
    required double cornerRadius,
  }) = RoundedRect;

  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
```

dev 依存関係は `build_runner`、`freezed`、`json_serializable` で、通常の依存関係は `freezed_annotation` と `json_annotation` です。Freezed 4.0.3 は Dart 3.13 を必要とするため、Flutter 3.44(Dart 3.12)では Freezed 3.2.x のままにしてください。同じアノテーションが動作します。

生成されたコードの動作は次のとおりです。

```text
[{"radius":2.0,"type":"circle"},{"width":3.0,"height":4.5,"type":"rect"},{"width":1.0,"height":2.0,"cornerRadius":0.5,"type":"rounded_rect"}]
fz unknown THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "hexagon"!
fz missing type THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "null"!
```

- `unionKey: 'type'` は判別フィールドの名前を変更します。これがないと、Freezed は `runtimeType` を読み書きするため、素の `@freezed` ユニオンは `{"n": 1, "runtimeType": "a"}` を生成します。バックエンドが期待するものとは、ほぼ確実に違うでしょう。
- `unionValueCase` は、コンストラクター名がどのように値になるかを制御します。`roundedRect` は `FreezedUnionCase.snake` では `rounded_rect`、`kebab` では `rounded-rect`、`pascal` では `RoundedRect` になり、デフォルトの `none` では `roundedRect` のままです。
- 1 つのコンストラクターに `@FreezedUnionValue('rounded-rect')` を付けると、そのケースだけ値を上書きできます。単一の表記規則に従わないワイヤーフォーマットに合わせるときに使います。
- 生成されたクラスは本物のサブタイプなので、`switch (shape) { Circle(:final radius) => ..., Rect() => ..., RoundedRect() => ... }` という網羅的な switch は、方法 1 とまったく同じように動作します。

設定をクラスごとではなく全体に適用したい場合は、`build.yaml` に書きます。

```yaml
# build.yaml, freezed 4.0.3
targets:
  $default:
    builders:
      freezed:
        options:
          union_key: type
          union_value_case: snake
```

### 未知の型: `fallbackUnion`

クライアントはサーバーのデプロイより長く生き残ります。バックエンドが新しいイベント型を追加したとき、未知の判別値でスローするアプリは、本来なら表示できたはずのリストでクラッシュします。Freezed の `fallbackUnion` は、認識できないすべての値を 1 つのコンストラクターに振り分けます。

```dart
// Dart 3.13.7, freezed 4.0.3
@Freezed(unionKey: 'type', fallbackUnion: 'unknown')
sealed class Event with _$Event {
  const factory Event.click({required int x, required int y}) = ClickEvent;
  const factory Event.unknown() = UnknownEvent;

  factory Event.fromJson(Map<String, dynamic> json) => _$EventFromJson(json);
}
```

`{"type": "scroll", "dy": 120}` をデコードすると `Event.unknown()` になり、その `toJson()` は `{type: scroll}` を返します。Freezed は元の判別値を非公開の `$type` フィールドに保持しますが、ペイロード(`dy`)は失われます。`type` キーがない場合もフォールバックに入ります。未知のイベントを忠実に再送信したりログに記録したりする必要がある場合は、フォールバックのコンストラクターに `Map<String, dynamic>` フィールドを持たせてカスタムの `fromJson` で値を入れるか、`_` ケースでマップ全体を保持できる手書きの実装を使ってください。

## どの方法でも引っかかる落とし穴

1. **ネストした `toJson` は、指示しない限りマップではなくオブジェクトを返します。** `explicitToJson: true` がないと、json_serializable は `'shapes': instance.shapes` と書きます。`Drawing.toJson()` の結果は `{name: d, shapes: [Instance of 'Circle', Instance of 'Rect']}` になります。`jsonEncode` は、エンコードできないものに対して `toJson()` を呼び出すため、この問題を隠します。文字列は正しく見えます。しかし、*マップ*を消費するもの(Firestore、マップ経由の `shared_preferences`、`Isolate` のメッセージ、マップを比較するテスト)には Dart のオブジェクトが渡されます。Freezed でもデフォルトは同じで、修正方法はファクトリコンストラクターにアノテーションを付けることです。

   ```dart
   // Dart 3.13.7, freezed 4.0.3
   @freezed
   abstract class FzDrawing with _$FzDrawing {
     @JsonSerializable(explicitToJson: true)
     const factory FzDrawing({required String name, required List<Shape> shapes}) =
         _FzDrawing;

     factory FzDrawing.fromJson(Map<String, dynamic> json) =>
         _$FzDrawingFromJson(json);
   }
   ```

   この変更後、`toJson()` は `{name: d, shapes: [{radius: 2.0, type: circle}, ...]}` を生成し、デコード、エンコード、デコードのラウンドトリップの結果は等価と比較されました。

2. **`int` と `double`。** 生成コードはすでに `(json['radius'] as num).toDouble()` を行っています。`as double` とキャストする手書きコードは `2` でスローし、Dart の `jsonEncode` は `2.0` を書き戻すので、値が正しくラウンドトリップしても、元のペイロードとのバイト単位の比較は失敗します。文字列ではなく、デコードしたオブジェクトを比較してください。

3. **判別フィールドはフィールドと衝突してはいけません。** あるケースに `type` というフィールドがすでにあっても、Freezed は警告しません。`unionKey: 'type'` と `const factory Note.email({required String type, required String to})` の組み合わせでは、`toJson()` は `{type: urgent, to: a}` を返しました。フィールドが判別フィールドを黙って置き換えるため、その出力をデコードすると `Invalid union type "urgent"!` でスローされます。逆方向では、`Note.fromJson({'type': 'email', 'to': 'a'})` は判別値をフィールドに詰め込みます(`Note.email(type: email, ...)`)。どのフィールドにも使われていない `unionKey`、たとえば `kind` を選んでください。手書き版と json_serializable 版でも、サブクラスの `toJson` に `type` キーが含まれていると、展開がリテラルを上書きするため、同じ罠があります。

4. **コンストラクター名の変更は、ワイヤーフォーマットの変更です。** Freezed では、判別値はコンストラクター名から導出されます。`Shape.rect` を `Shape.rectangle` にリネームすると、送信する内容が黙って変わり、保存済みのすべてのドキュメントと古いクライアントが壊れます。永続化されるもの、または他のサービスと共有されるものには、`@FreezedUnionValue('rect')` で値を固定してください。

5. **`build_runner` のフラグは変わりました。** build_runner 2.17.1 では、`dart run build_runner build --delete-conflicting-outputs` は `These options have been removed and were ignored: --delete-conflicting-outputs` と出力しますが、ビルドは行われます。古い README や CI スクリプトは今でもこれを渡しています。警告は無害ですが、本物の警告を隠さないよう削除してください。

6. **ジェネリクスには `genericArgumentFactories` が必要です。** `Ok<T>` と `Err<T>` のケースを持つ `sealed class Result<T>` には `@JsonSerializable(genericArgumentFactories: true)`(または `@Freezed(genericArgumentFactories: true)`)が必要で、`fromJson` は追加の `T Function(Object?) fromJsonT` パラメーターを取るようになります。`Result.fromJson` をコードベース全体に広げる前に、このシグネチャを見込んでおいてください。

## どれを選ぶか

- **手書き**は、小さくて安定した階層、またはペイロードに判別フィールドがなく、キーから型を推測しなければならない場合に向いています。依存関係はゼロで、エラーメッセージも最良ですが、すべてのフィールドが自分で保守するコードになります。
- **サブクラスに json_serializable** は、すでに素の DTO で使っていて、サブクラスを独自のメソッドを持つ通常のクラスのままにしたい場合に向いています。階層ごとに 10 行ほどのディスパッチを書くことになります。
- **Freezed** は、`copyWith`、値の等価性、`toString` も欲しい場合、または階層が大きい場合に向いています。`unionKey` は明示的に設定し、永続化するデータは `@FreezedUnionValue` で値を固定し、未知の型をスローするのか `fallbackUnion` に流すのかを最初に決めてください。Freezed のコード生成にそもそも価値があるのはどんなときかについては、[レコードと Freezed の比較](/ja/2026/05/dart-records-vs-freezed-classes/)で扱っています。

### 関連記事

- [Fix FormatException: Unexpected character when parsing JSON in Dart](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/): `fromJson` が実行されるよりも前の段階について。
- [Fix "type 'Null' is not a subtype of type" in Dart](/ja/2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart/): 生成された `fromJson` コードでフィールドが欠けたときに出るエラーです。
- [How to handle network errors gracefully in a Flutter app](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/): デコードの失敗を UI のどこで表面化させるべきかも扱っています。
- C# での対応例である [System.Text.Json で JsonDerivedType を使って多態的な階層をシリアライズする](/ja/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)では、同じ判別フィールドの問題を属性で解決します。

### 参考資料

- [Dart language: patterns, map patterns](https://dart.dev/language/pattern-types#map) と [class modifiers: sealed](https://dart.dev/language/class-modifiers#sealed)
- [Freezed README: fromJSON for classes with multiple constructors](https://pub.dev/packages/freezed#fromjson---classes-with-multiple-constructors) と [Freezed changelog](https://pub.dev/packages/freezed/changelog)
- [json_serializable on pub.dev](https://pub.dev/packages/json_serializable) と [issue #1342, sealed class support](https://github.com/google/json_serializable.dart/issues/1342)
- [build_runner changelog](https://pub.dev/packages/build_runner/changelog)
