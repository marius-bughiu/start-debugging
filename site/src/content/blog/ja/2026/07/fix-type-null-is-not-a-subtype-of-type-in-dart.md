---
title: "解決: Dart の type 'Null' is not a subtype of type 'X'"
description: "この実行時エラーは、null 非許容の型を期待するキャストに null が到達したことを意味し、ほとんどの場合 JSON が原因です。フィールドを null 許容にするか、キャストの前にデフォルト値を与えてください。"
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart"
translatedBy: "claude"
translationDate: 2026-07-18
---

`type 'Null' is not a subtype of type 'X'` は実行時の型エラーです。キャストや代入が null 非許容の型を要求する場所に、`null` が到達しました。圧倒的に多い原因は JSON の解析です。キーが欠けていたり `null` として届いたりしたものを、`String`、`int`、あるいはモデル型へ直接キャストするケースです。修正の要点は、キャストが生の `null` を見ないようにすることです。ターゲットの型を null 許容（`String?`）として宣言して null を処理するか、キャストが起きる前に `?? fallback` でデフォルト値を与えます。これは Dart 3.12（Flutter 3.44）で検証しています。この挙動は Dart 2.12 以降のすべての健全な null safety のリリースで同じです。

## コンテキストの中のエラー

メッセージは、値が本来あるべきだった具体的な型を示します。JSON のデコードでは通常こう見えます。

```
Unhandled Exception: type 'Null' is not a subtype of type 'String' in type cast
#0      _$UserFromJson (package:myapp/models/user.dart:12:34)
#1      new User.fromJson (package:myapp/models/user.dart:8:7)
#2      fetchUser (package:myapp/api/client.dart:41:24)
<asynchronous suspension>
```

このメッセージでは 2 つの語がすべての意味を担っています。最初の `'Null'` は、値が実行時に実際に持っていた型で、`null` でした。2 つ目の "subtype of type" の後にあるものは、コードが要求したものです。`'String'`、`'int'`、`'List<dynamic>'`、`'Map<String, dynamic>'`、あるいは自作のモデルクラスのいずれかです。末尾の `in type cast` は、失敗が明示的または暗黙的な `as` キャストで起きたことを伝えており、これは型のない `dynamic` の JSON を型付きフィールドへデコードするときの決定的な痕跡です。

`in type cast` を伴わない変種も見かけます。たとえば `type 'Null' is not a subtype of type 'String'` で、値が `as` 式ではなく null 非許容のパラメーターやフィールドへ流れ込む場合です。根本原因は同じで、修正も同じです。

## なぜこれが起きるのか

健全な null safety のもとでは、`Null` はそれ自身の型であり、null 非許容のどの型のサブタイプでもありません。これこそが null safety の要点です。`String` は本当に `null` を保持できないため、ランタイムは `null` がそれになりすますことを拒みます。`json['name'] as String` と書き、`json['name']` が `null` のとき、あなたはランタイムに `Null` を `String` として扱うよう求めており、ランタイムはエラーを投げます。

これがコンパイル時ではなく実行時に現れる理由は、JSON が `dynamic` だからです。`jsonDecode` は `dynamic` を返し、`Map<String, dynamic>` へのすべてのルックアップも `dynamic` です。コンパイラーはマップの実際の中身を見られないため、あなたの `as String` キャストを信頼し、チェックを実行時へ先送りします。実際の値が `null` なら、その行が実行された瞬間にチェックが失敗します。これがこのエラーが `fromJson` ファクトリや `json_serializable` の生成コードで非常に多い理由です。それらはまさに `dynamic` の値が型付きの形へ押し込まれる場所だからです。

これを生む状況は 3 つあり、おおよそ頻度順に並べます。

- JSON のキーが完全に欠けており、`json['key']` が `null` を返し、その `null` を null 非許容の型へキャストする。
- キーは存在するがその値が JSON の `null` である。たとえばバックエンドからシリアライズされた null 許容の列。
- 値は存在するが形が誤っている。たとえば `String` へキャストしているのに数値が `int` として届く、あるいはリストを期待したところにオブジェクトが来る。これは別のサブタイプのメッセージを投げますが、同じカテゴリーのバグです。

## 最小の再現

標準的なケースを再現する最小のスニペットです。

```dart
// Dart 3.12, Flutter 3.44
import 'dart:convert';

class User {
  final String name;
  final int age;
  User({required this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String, // throws if 'name' is null or missing
        age: json['age'] as int,
      );
}

void main() {
  // 'name' is absent from the payload
  final payload = jsonDecode('{"age": 30}') as Map<String, dynamic>;
  final user = User.fromJson(payload); // type 'Null' is not a subtype of type 'String'
  print(user.name);
}
```

キーがマップにないため、`json['name']` は `null` に評価されます。すると `as String` キャストが `null` を `String` として見ようとして、エラーを投げます。例外は `print` ではなく `User.fromJson` の内部で発生することに注意してください。だからこそスタックトレースは、最終的にデータを表示したウィジェットではなく、あなたのモデルファイルを指します。

## 詳細な修正

これらを順に進めてください。最初の 2 つで実際の発生のほとんどを網羅します。残りは、単純な修正では扱えない形を処理します。

### 1. データが本当に欠けうるなら、フィールドを null 許容にする

バックエンドが値を正当に省略したり null にしたりできるなら、それを正直にモデル化します。Dart のフィールドを null 許容として宣言し、キャストを null 許容の型に向けます。`null` はその型のサブタイプです。

```dart
// Dart 3.12, Flutter 3.44
class User {
  final String? name; // was String
  final int age;
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String?, // as String?, not as String
        age: json['age'] as int,
      );
}
```

`json['name'] as String?` は、値が `String` でも `null` でも成功します。`Null` は `String?` のサブタイプだからです。トレードオフは、`name` を利用するすべての箇所が今や null を処理しなければならないことで、これはまさに型システムが認めるよう求めている正しさです。フィールドが本当に任意である場合、これが正しい修正です。

### 2. 値が null 非許容のフィールドに届く前に ?? でデフォルトを与える

フィールドを null 非許容のままにしなければならないが、妥当なフォールバックを選べるなら、キャストが完了する前に null を消し去ります。

```dart
// Dart 3.12, Flutter 3.44
factory User.fromJson(Map<String, dynamic> json) => User(
      name: json['name'] as String? ?? 'Unknown', // cast to nullable, then default
      age: json['age'] as int? ?? 0,
    );
```

順序が重要です。まず null 許容の型へキャストし（`as String?`）、それから `??` を適用します。`json['name'] ?? 'Unknown' as String` と書くと、優先順位により `json['name'] ?? ('Unknown' as String)` となり、左辺を保護せず、値が誤った非 null 型のときは依然としてエラーを投げます。null 許容へキャストしてからマージするのが、きれいに読めて正しく振る舞うイディオムです。

### 3. `dynamic` マップの値を null 非許容の型へ直接キャストしない

このエラーを引き起こす習慣は `json['x'] as ConcreteType` です。安全な形をデフォルトにしてください。null 許容の型へキャストし、それから null が何を意味するかを決めます。ネストしたオブジェクトやリストには、同じ規則が 1 段深いところで適用されます。

```dart
// Dart 3.12, Flutter 3.44
// A list that may be absent -> default to empty, never null-cast the elements
final tags = (json['tags'] as List<dynamic>?)
        ?.map((e) => e as String)
        .toList() ??
    <String>[];

// A nested object that may be absent -> guard before recursing
final address = json['address'] == null
    ? null
    : Address.fromJson(json['address'] as Map<String, dynamic>);
```

外側のコンテナを `List<dynamic>?` へキャストするか、再帰の前に `== null` を確認すると、`null` が要素やネストしたキャストに決して到達しません。手書きの `fromJson` コードが最もよく誤るのはここです。トップレベルのフィールドは保護されているのに、リストの要素やネストしたマップは保護されていないのです。

### 4. json_serializable を使うなら、フィールドを null 許容にするかデフォルトを与える

生成された `fromJson` コードは、あなたが手で書くのとまったく同じようにキャストします。したがって `@JsonKey` を付けた null 非許容のフィールドは、データが欠けると同じ実行時エラーを生みます。モデルの宣言で修正して再生成してください。

```dart
// Dart 3.12, Flutter 3.44, json_serializable 6.x
@JsonSerializable()
class User {
  final String? name;                       // nullable -> generator emits `as String?`
  @JsonKey(defaultValue: 0) final int age;  // default -> used when the key is null/absent
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}
```

null 許容のフィールドはジェネレーターに `as String?` を出力させます。`@JsonKey(defaultValue: ...)` は、キーが欠けているか null のときにデフォルトを代入させます。アノテーションを変更したら `dart run build_runner build --delete-conflicting-outputs` を実行してください。そうしないと古い生成キャストが動いたままです。

### 5. 値が実際には null でないときは形の不一致を修正する

エラーが `'String'` のような型を示すのにペイロードが明らかに値を持っているなら、値の形が誤っています。`as int` でキャストしているのに `"age": "30"`（文字列）を送るバックエンド、あるいは数値を期待する場所に `"30"` を送るバックエンドは、同じ系統のエラーを引き起こします。キャストではなく明示的に変換してください。

```dart
// Dart 3.12, Flutter 3.44
// Backend sends age as a string sometimes, an int other times
final age = json['age'] is int
    ? json['age'] as int
    : int.parse(json['age'].toString());
```

これは `Null` のケースではありませんが、メッセージの形が同一なので人々をこのページに導きます。メッセージの左側の型が `'Null'` でないときは、あなたの null 処理ではなく、サーバーが実際に送ったものを見てください。

## 落とし穴と変種

- **スタックトレースはモデルを指し、UI を指さない。** キャストは `fromJson` の内部で動くため、最上位のフレームはあなたのモデルファイルです。開発者はしばしば空欄を表示したウィジェットのデバッグから始めますが、本当の修正は 1 つか 2 つ下のフレーム、キャストのところにあります。トレースの中でフレームワークに属さない最初のフレームを読んでください。

- **`as String?` は `as String` と同じではない。** たいていの場合、単一の `?` が修正のすべてです。`as String?` は `null` を許可し、`as String` は禁止します。null 非許容のフィールドから null 許容のフィールドへキャストをコピーしたら、`?` を足すのを忘れないでください。さもないとバグを移動しただけで、修正していません。

- **`Map<String, dynamic>` のキャストも同じように失敗する。** `jsonDecode` は `dynamic` を返します。ペイロード全体が `null` なら（たとえば空の 204 レスポンスボディ）、フィールドに到達する前に `jsonDecode(body) as Map<String, dynamic>` が `type 'Null' is not a subtype of type 'Map<String, dynamic>'` を投げます。デコードを保護してください。`body.isEmpty ? null : jsonDecode(body)` です。これは [FormatException: Dart で JSON を解析するときの Unexpected character](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) で扱う不正な入力と重なります。

- **bang 演算子はクラッシュを移動するだけで、修正しない。** `json['name']!` と書くと、`Null` のサブタイプエラーが `Null check operator used on a null value` に変わります。同じ根底の null を、別の仕組みが投げているだけです。`!` がなぜ、非 null であると証明できる値のために取っておくべきで、意見が合わないコンパイラーを黙らせるために使うものではないのかは、[Null check operator used on a null value（Flutter）](/ja/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) を参照してください。

- **`late` フィールドは同じ null を別のエラーに変える。** null になりうる値を null 非許容の `late` フィールドへ流し、代入前に読むと、代わりに `LateInitializationError` が出ます。治療法は同じです。持っていない値を約束するのではなく、不在を正直にモデル化してください。[LateInitializationError: Field has not been initialized（Flutter）](/ja/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/) を参照してください。

- **ジェネリックの型引数はキャストを隠す。** `List<String>.from(json['tags'])` と `(json['tags'] as List).cast<String>()` はどちらも、要素が `null` のときにこのエラーを遅延的に投げ、トレースはあなたのコードではなく `.cast` を指すことがあります。失敗が見えてあなたが処理できるよう、明示的な `.map((e) => e as String?)` を好んでください。

- **これは実行時エラーなので、テストは捕まえるがアナライザーは捕まえない。** アナライザーは `dynamic` の JSON マップの中を見られないため、キャストが安全でなくても `dart analyze` は緑のままです。フィールドを省いたペイロードで `fromJson` の単体テストを 1 つ書くだけで、ユーザーより先にバグが表面化します。古いコードベースを移行しているなら、[Flutter の null safety 移行チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) が、これらのキャストが隠れがちな場所を案内します。

持ち帰るべき考え方はこうです。このエラーは、`null` が自分でないものになりすますことを null safety が拒んでいるのです。値は `null` として入り、下流のどこかのキャストや代入が、それはそうならないと約束していました。修正は決してキャストをより強く押しつけることではありません。`dynamic` のデータが型付きの世界へ入る境界で、そのフィールドが欠けうるかどうかを決めることです。欠けうるなら null 許容にして null を処理します。欠けえないなら、キャストが完了する前にデフォルトを与えます。これをすべての `json[...]` ルックアップで行えば、このエラーは現れなくなります。

## 関連記事

- [解決: FormatException: Dart で JSON を解析するときの Unexpected character](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/)：ペイロードがそもそも有効な JSON でないときの兄弟エラー。
- [解決: Null check operator used on a null value（Flutter）](/ja/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/)：このキャストを黙らせようと代わりに `!` に手を伸ばすと何が起きるか。
- [解決: LateInitializationError: Field has not been initialized（Flutter）](/ja/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/)：持っていない値を約束する `late` の変種。
- [Flutter 2 アプリを Flutter 3.x へ移行する: null safety チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)：これらの安全でないキャストをコードベース全体から見つける。

## 出典

- Dart, [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety)（なぜ `Null` がもはやすべての型のサブタイプではないのか、そしてなぜ `dynamic` からの暗黙のダウンキャストが実行時に失敗する明示的なキャストになったのか）。
- Dart, [Sound null safety](https://dart.dev/null-safety)（null 非許容の `String` が実行時に `null` を拒む保証）。
- GitHub, [dart-lang/sdk issue #53700](https://github.com/dart-lang/sdk/issues/53700)（実際の JSON デコードコードに対して報告された "type 'Null' is not a subtype of type 'String'"、キー欠落の根本原因つき）。
