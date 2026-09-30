---
title: "修正: Dart 3.13 へのアップグレード後にパラメーターで Can't have modifier 'final' here が出る"
description: "Dart 3.13 では、プライマリコンストラクター用に final と var がパラメーターリスト内で予約されました。dart fix --apply --code=extraneous_modifier で削除し、代わりに parameter_assignments を使ってください。"
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "dart-3-13"
lang: "ja"
translationOf: "2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters"
translatedBy: "claude"
translationDate: 2026-09-30
---

Dart 3.13 (Flutter 3.47 の SDK) では、通常の関数、メソッド、クロージャ、本体内コンストラクターのパラメーターに `final` や `var` を書けなくなりました。この 2 つのキーワードはプライマリコンストラクターでのパラメーター宣言専用に予約されたため、`pubspec.yaml` に `sdk: ^3.13.0` と書いた時点で `int add(int a, final int b)` は `extraneous_modifier` で失敗します。`dart fix --apply --code=extraneous_modifier` を実行すれば、該当する修飾子をすべて一括で削除できます。パラメーターの再代入を防ぐために `final` を使っていた場合は、代わりに `parameter_assignments` lint を有効にしてください。

以下の内容はすべて、macOS arm64 上の Dart 3.13.3 (Flutter 3.47.4) と Dart 3.12.2 (Flutter 3.44.8) で再現したものです。あわせて 3.13.0 の changelog、承認済みのプライマリコンストラクター仕様、そしてこの制限が意図的なものであると Dart チームが確認した [dart-lang/sdk#64151](https://github.com/dart-lang/sdk/issues/64151) のトリアージでも確認しています。

## エラーの全体像

`dart analyze` と IDE は、アナライザーのエラーとして報告します。

```text
error - lib/a.dart:2:16 - Can't have modifier 'final' here. Try removing 'final'. - extraneous_modifier
```

`dart run`、`flutter run`、`flutter build` は代わりにフロントエンドコンパイラーを通り、同じメッセージをキーワードの下にキャレット付きで表示します。

```text
lib/a.dart:2:16: Error: Can't have modifier 'final' here.
Try removing 'final'.
int add(int a, final int b) => a + b;
               ^^^^^
```

`var` の場合はキーワードが入れ替わり、`Can't have modifier 'var' here. Try removing 'var'.` となります。型付きの `var int n` パラメーターではさらに `var_and_type` も報告されますが、こちらは 3.13 より前からエラーでした。

分かりにくいのは、きっかけです。ファイルには誰も手を入れていません。変わったのは SDK 制約です。誰かがプライマリコンストラクターを試すために `environment: sdk:` を `^3.13.0` に上げたか、テンプレートが 3.13 を下限にした新しいパッケージを生成したことで、何年も問題なくコンパイルできていたコードが失敗し始めます。典型的な CI の失敗は #64151 にあるもので、数か月前に書かれたプライベートなヘルパーメソッドのパラメーターリストに `final int precision` があり、そのクラスにプライマリコンストラクターはどこにもない、というケースです。

## Dart 3.13 がパラメーターの final を拒否する理由

Dart 3.13.0 は 2026-08-12 に[プライマリコンストラクター](https://dart.dev/language/primary-constructors)を提供開始しました。プライマリコンストラクターはクラスヘッダーに置かれ、そこで `final` または `var` が付いたパラメーターは*宣言パラメーター*になります。つまりコンストラクターパラメーターであると同時に、インスタンスフィールドも宣言します。

```dart
// Dart 3.13.3
class Point(final int x, final int y); // declares fields x and y
```

この意味を曖昧にしないため、[機能仕様](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)では、プライマリコンストラクターではないすべての関数で、仮パラメーター宣言としての `var x`、`final x`、`final T x` を禁止しています。Dart チームはより狭いルールよりも一貫性を選びました。#64151 で Leaf Petersen は「もっと狭い範囲のつもりだったのか」という質問に、意図どおりだと明確に答えています。

言語の変更というより退行のように感じられる点が 2 つあります。

1. **言語バージョンに依存します。** この制限は、言語バージョンが 3.13 以降のライブラリにのみ適用されます。言語バージョンは `pubspec.yaml` の `sdk:` の下限で決まるため、同じコードでも `sdk: ^3.12.0` のままなら 3.13 SDK でコンパイルできます。これが、Dart チームがこれを正式な意味での破壊的変更として扱わなかった理由でもあります。
2. **リリース時にはほとんど文書化されていませんでした。** 当初の 3.13.0 changelog にはプライマリコンストラクターの説明はありましたが、通常の関数への影響には触れていませんでした。#64151 の後、changelog の Language の項に「**Breaking change**: You can no longer use `final` or `var` on non-declaring parameters」という項目が追加され、プライマリコンストラクターのページには「Constraints and breaking changes」セクションが加わりました。それ以前の唯一の兆候は、Dart 3.11 での `prefer_final_parameters` lint の非推奨化でした。

## 最小再現

ファイルは 2 つで足ります。pubspec で言語バージョンを設定します。

```yaml
# Dart 3.13.3
name: fp
environment:
  sdk: ^3.13.0
```

そして、一般的なあらゆるパラメーター位置で `final` と `var` を使うライブラリです。

```dart
// Dart 3.13.3, language version 3.13
int add(int a, final int b) => a + b;                   // error

void named({required final String id, final int retries = 3}) {} // 2 errors

void positional([final int? x]) {}                      // error

void callback(final void Function(int) onTap) {}        // error

void untypedVar(var x) {}                               // error

class Money {
  final int cents;
  Money(final int c) : cents = c;                       // error, in-body constructor
  Money operator +(final Money other) => Money(cents + other.cents); // error
  set value(final int v) {}                             // error
  static Money zero(final int unused) => Money(0);      // error
}

void loops(List<int> xs) {
  for (final x in xs) {                                 // fine, not a parameter
    print(x);
  }
  final local = xs.length;                              // fine, local variable
  xs.forEach((final v) => print(v + local));            // error, closure parameter
}

class Point(final int x, final int y);                  // fine, declaring parameters
```

3.13.3 の `dart analyze` は、上で印を付けたパラメーターごとに `extraneous_modifier` エラーを 1 件ずつ報告します。pubspec を `sdk: ^3.12.0` に変えるとすべて消え、残るエラーは `Point` の行だけで、そこには `This requires the 'primary-constructors' language feature to be enabled` と表示されます。

フィールド仮パラメーターとスーパーパラメーターも対象です。`T2(final this.x)` と `C(final super.y)` はどちらも 3.13 で `extraneous_modifier` になり、さらに `unnecessary_final` 警告も出ます。これらのパラメーターは元から暗黙的に final だったためです。

影響を受け*ない*ものは、ローカル変数、`for (final ... in ...)`、パターン変数、フィールド、そして通常の `this.x` / `super.x` パラメーターです。

## 修正方法の詳細

次のいずれかを、優先度の高い順に選んでください。

### 1. dart fix に修飾子を削除させる

アナライザーには `extraneous_modifier` 用の修正が用意されているため、移行は機械的に行えます。

```bash
dart fix --dry-run
```

再現用パッケージでは、`lib/a.dart` に対して `extraneous_modifier - 11 fixes` と、エラー 1 件につき 1 つ報告されます。プロジェクト内の他の部分が書き換えられないよう、そのコードだけを適用します。

```bash
dart fix --apply --code=extraneous_modifier
```

得られる差分は、手で書いた場合とまったく同じです。

```dart
// Dart 3.13.3, after dart fix
int add(int a, int b) => a + b;
void named({required String id, int retries = 3}) {}
void positional([int? x]) {}
void callback(void Function(int) onTap) {}
void untypedVar(x) {}

class Money {
  final int cents;
  Money(int c) : cents = c;
  Money operator +(Money other) => Money(cents + other.cents);
  set value(int v) {}
  static Money zero(int unused) => Money(0);
}
```

修正後は `dart analyze` が問題なしと報告し、プログラムも動作します。Flutter アプリでもコマンドは同じです。`flutter` は同梱の Dart SDK を使うだけなので、Flutter 3.47 にパスを通した状態でプロジェクトルートから `dart fix` を実行してください。

`var x` は単なる `x` になり、暗黙的に `dynamic` なパラメーターになる点に注意してください。コンパイルは通りますが、`strict-raw-types` などのアナライザー設定を使っている場合は、ついでに適切な型を付けてください。

### 2. lint で「パラメーターを再代入しない」ルールを維持する

多くの人は、再代入をコンパイルエラーにするためにパラメーターへ `final` を書いていました。その保証は今後、linter が担います。

```yaml
# analysis_options.yaml, Dart 3.13.3
linter:
  rules:
    - parameter_assignments
```

```dart
// Dart 3.13.3
int clamp(int value, int max) {
  if (value > max) value = max; // info: Invalid assignment to the parameter 'value'.
  return value;
}
```

以前の挙動を取り戻すために `prefer_final_parameters` を使うのはやめてください。これは Dart 3.11 から非推奨で、3.13 で有効にすると `The lint rule 'prefer_final_parameters' is deprecated and shouldn't be enabled` と表示されます。その指摘に従うと、コンパイルできないコードに誘導されることになります。チームで共有している lint パッケージがまだこれを有効にしている場合は、そのパッケージも更新が必要です。

### 3. 特定のファイルだけ古い言語バージョンに固定する

生成コードやベンダリングしたライブラリなど、今は手を入れられないファイルがある場合は、ファイル先頭に言語バージョンコメントを置くと、そのライブラリ 1 つだけを対象外にできます。

```dart
// @dart=3.12
// Dart 3.13.3 SDK, this library uses language version 3.12
int legacyAdd(int a, final int b) => a + b; // compiles
```

パッケージの他の部分ではプライマリコンストラクターを使えます。これはあくまでつなぎの対処です。3.12 に固定したファイルでは 3.13 の機能を一切使えないので、ファイルを整理できたらコメントは削除してください。

### 4. 準備ができるまで SDK 制約を 3.12 のままにする

チェックは、実行している SDK ではなくパッケージの言語バージョンに基づくため、3.13 SDK は制約が `sdk: ^3.12.0` のパッケージを問題なくコンパイルします。テンプレートや `pub upgrade --major-versions` によって勝手に制約が上がっただけなら、下限を元に戻すのは有効な短期対応です。どちらの場合でも依存パッケージには影響しません。私の再現では、`sdk: ^3.12.0` でパラメーターに `final` を使っているパス依存パッケージが、3.13 アプリの中でも問題なくコンパイルされ動作しました。各パッケージは、それぞれの言語バージョンでコンパイルされるためです。

## アップグレード前に 3.12 のコードベースを整える

まだ Flutter 3.44 / Dart 3.12 を使っているなら、制約を上げる前にすべてを見つけて修正できます。プライマリコンストラクターのページでは、3.12.2 に存在する 2 つの lint が推奨されています。

```yaml
# analysis_options.yaml, Dart 3.12.2
linter:
  rules:
    - avoid_final_parameters
    - var_with_no_type_annotation
```

3.12.2 では、これらは `Parameters should not be marked as 'final'` と `Avoid declaring parameters with var and no type annotation` を報告し、どちらも `dart fix` に対応しています (`--code=avoid_final_parameters` と `--code=var_with_no_type_annotation`)。警告を修正してから `sdk:` を `^3.13.0` に上げれば、アップグレードで `extraneous_modifier` エラーはまったく出ません。

## 落とし穴と紛らわしいケース

- **コードジェネレーターも出力します。** freezed 3.x は、コレクションフィールド向けに `const _Example({required final List<String> someField})` のようなコンストラクターを生成しており、3.13 のパッケージでは壊れます ([rrousselGit/freezed#1365](https://github.com/rrousselGit/freezed/issues/1365))。freezed 4.0.0 (2026-08-22) で、生成されるコンストラクターのパラメーター内の `final` が削除され、現行リリースは 4.0.2 です。ジェネレーターをアップグレードして `dart run build_runner build` を再実行してください。`.freezed.dart` ファイルに `dart fix` を実行しても、次のビルドで再生成されるので意味がありません。他のジェネレーターを使っている場合は、自分のコードを疑う前に、その changelog で「Dart 3.13」や「primary constructors」を確認してください。
- **コードを解析するツールは 3.12 でも影響を受けることがあります。** #64151 では、失敗の原因は `featureSet` なしでアナライザーの `parseString()` を呼び出すツールでした。その場合、アナライザーが知る最新の言語バージョンがデフォルトになるため、アナライザー 13.1.0 以降では、まだ古い言語バージョンのパッケージでも `final` パラメーターが拒否されました。カスタムビルダー、ドキュメントツール、コードメトリクスのスクリプトが失敗するのに `dart analyze` は通る場合は、これが原因であり、修正すべきなのはツール側です。
- **メッセージにプライマリコンストラクターは登場しません。** Dart チームは #64151 でより長いメッセージを検討しましたが見送ったため、表示されるのは `Try removing 'final'` だけです。この文字列からこのページにたどり着いたなら、ここが説明です。
- **型のない `var` は `dynamic` になります。** `dart fix` は `(var x)` を `(Object? x)` ではなく `(x)` にします。気になるなら型を追加してください。
- **Flutter のバージョン対応。** Flutter 3.47.0 から 3.47.5 には、Dart 3.13.0 から 3.13.4 が同梱されています。Flutter だけをアップグレードしても何も変わりません。エラーが出るのはパッケージの `sdk:` の下限が 3.13 に達したときだけなので、その引き上げの後は、`final` パラメーターを使う古い回答のコピペスニペットがすぐに失敗します。
- **プライマリコンストラクターの `final` フィールドとは別物です。** `class User(final String name);` は有効な 3.13 のコードで、フィールドを宣言します。プライマリコンストラクターのパラメーターで `extraneous_modifier` が出た場合は、そのパラメーターリストが本当にクラスヘッダーにあり、本体内コンストラクターではないことを確認してください。

## 関連記事

- この問題を引き起こした機能を実験段階から見る: [Dart 3.12 のプライマリコンストラクター](/ja/2026/06/dart-3-12-experimental-primary-constructors/)。
- 差分には現れない、もう 1 つの 3.13 アップグレードの落とし穴: [Dart 3.13 Docker イメージでの CERTIFICATE_VERIFY_FAILED](/ja/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/)。
- SDK 制約の引き上げで依存関係の解決も壊れた場合は、[pubspec.yaml の version solving failed の修正方法](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)を参照してください。
- freezed 4.0 へのアップグレード後に、生成されたデータクラスと組み込み型のどちらを選ぶか: [Dart の record と freezed クラスの比較](/ja/2026/05/dart-records-vs-freezed-classes/)。
- 大規模なリポジトリで `dart fix` やアナライザーが遅い場合は、[VS Code での Dart 解析サーバーの高速化](/ja/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)を参照してください。

## 参考資料

- [dart-lang/sdk#64151: `final` no longer allowed on parameters of normal functions/methods](https://github.com/dart-lang/sdk/issues/64151)
- [Dart SDK CHANGELOG, 3.13.0 Language section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Primary constructors feature specification (accepted/3.13)](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)
- [Primary constructors, dart.dev](https://dart.dev/language/primary-constructors)
- [`parameter_assignments` lint rule](https://dart.dev/tools/linter-rules/parameter_assignments)
- [`avoid_final_parameters` lint rule](https://dart.dev/tools/linter-rules/avoid_final_parameters)
- [rrousselGit/freezed#1365: invalid `final` keyword in generated constructor parameters](https://github.com/rrousselGit/freezed/issues/1365)
- [freezed CHANGELOG (4.0.0, 4.0.2)](https://github.com/rrousselGit/freezed/blob/master/packages/freezed/CHANGELOG.md)
