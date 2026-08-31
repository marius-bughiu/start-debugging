---
title: "解決: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'"
description: "source_gen 3.1.0 または 4.0.0 が analyzer 8.4.0 で削除された API を呼ぶため build_runner がビルドできません。source_gen を 4.0.1 未満に固定している生成パッケージを更新します。"
pubDate: 2026-08-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "build-runner"
  - "source-gen"
lang: "ja"
translationOf: "2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl"
translatedBy: "claude"
translationDate: 2026-08-31
---

`build_runner` が失敗しているのは自分のビルドスクリプトのコンパイルであり、あなたのコードではありません。`source_gen` 3.1.0 と 4.0.0 は `analyzer` 8.4.0 が削除した `DartObjectImpl.getInvocation()` を呼んでおり、両パッケージの制約は pub がこの組み合わせを選べる程度にゆるいままです。`pubspec.yaml` の中で `source_gen` を 4.0.1 未満に固定しているコード生成パッケージを更新すれば直ります。今日すぐ更新できない場合は、暫定策として `dependency_overrides: analyzer: 8.3.0` を追加してください。

## エラーの全文

`dart run build_runner build`（または `flutter pub run build_runner build`）を実行すると、pub キャッシュを指す Dart フロントエンドのコンパイルエラーが出ます。

```text
[INFO] Generating build script...
../../.pub-cache/hosted/pub.dev/source_gen-3.1.0/lib/src/constants/revive.dart:82:40:
Error: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'.
 - 'DartObjectImpl' is from 'package:analyzer/src/dart/constant/value.dart'
   ('../../.pub-cache/hosted/pub.dev/analyzer-8.4.1/lib/src/dart/constant/value.dart').
Try correcting the name to the name of an existing method, or defining a method
named 'getInvocation'.
  final i = (object as DartObjectImpl).getInvocation();
                                       ^^^^^^^^^^^^^
[SEVERE] Failed to compile build script. Check builder definitions and generated
script .dart_tool/build/entrypoint/build.dart.
```

この出力の 2 点が診断をほぼ済ませてくれます。失敗しているファイルはあなたのプロジェクトではなく `source_gen` の中にあります。そして 2 つのキャッシュパスに含まれるバージョン番号こそがバグそのものです。`source_gen-3.1.0` と `analyzer-8.4.1` の組み合わせです。

以下の内容はすべて pub.dev のパッケージアーカイブに対して検証しており、2026 年 8 月時点の stable チャンネルである Flutter 3.47.0 と Dart 3.13.0 に当てはまります。同じ組み合わせを解決する古い Dart 3.x のプロジェクトでも同様です。

## なぜ analyzer 8.4.0 はこのメソッドを削除したのか

`source_gen` は見つけたアノテーションごとに 1 つの問いに答える必要があります。analyzer がすでに評価した const オブジェクトに対して、それを再生成するソースコードは何か、という問いです。それを行うのが `source_gen/lib/src/constants/revive.dart` の `reviveInstance` であり、`@JsonSerializable(fieldRename: FieldRename.snake)` がビルダー内部で使える設定になるのもこの仕組みです。

そのために `source_gen` は `DartObject` の背後にあるコンストラクターと引数の値を必要としました。長年、それを取得する唯一の方法が実装 import でした。

```dart
// source_gen 3.1.0, lib/src/constants/revive.dart
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

// ...
final i = (object as DartObjectImpl).getInvocation();
```

この `// ignore: implementation_imports` というコメントは、API の安定性を何も保証しない `src/` ディレクトリに手を伸ばしていることを `source_gen` に伝える analyzer 自身の lint です。

analyzer チームはこの根本的な穴をふさぎました。2025-08-07 に公開されたバージョン 8.1.0 は、公開 API である `package:analyzer/dart/constant/value.dart` に `DartObject.constructorInvocation` を追加し、`constructor`、`positionalArguments`、`namedArguments` を持つ `ConstructorInvocation` を返すようにしました。8.3.0 では旧来の入口がまだ残っており、削除予定として印が付いていました。

```dart
// analyzer 8.3.0, lib/src/dart/constant/value.dart
@Deprecated('Use constructorInvocation instead')
ConstructorInvocationImpl? getInvocation() {
  return constructorInvocation;
}
```

2025-10-15 に公開された analyzer 8.4.0 はこのメソッドを削除しました。`constructorInvocation` は残っていますが、`getInvocation` という名前のものはパッケージのどこにも存在しません。まだそれを呼んでいるコードは、このバージョンが解決された時点でコンパイルできなくなります。

`source_gen` はすでに移行済みでした。2025-09-04 に公開されたバージョン 4.0.1 は公開ゲッターに切り替え、自身の制約を `analyzer: ^8.1.1` に絞りました。

```dart
// source_gen 4.0.1 and later, lib/src/constants/revive.dart
final i = object.constructorInvocation;
if (i != null) {
  url = Uri.parse(urlOfElement(i.constructor.enclosingElement));
  // ...
}
```

実装 import が消えている点に注目してください。これが本当の修正であり、4.0.1 以降の `source_gen` がすべて影響を受けない理由です。

## 壊れた組み合わせを許してしまうバージョン解決の穴

`source_gen` 4.0.1 が 9 月にこれを修正し、analyzer 8.4.0 が 10 月に出たのなら、なぜ今も踏む人がいるのでしょうか。壊れたバージョンが非互換を宣言しなかったからであり、pub は宣言しか読まないからです。

関係する制約は次のとおりです。

| パッケージ | analyzer への制約 | `getInvocation` を呼ぶか |
| --- | --- | --- |
| `source_gen` 3.0.0 | `^7.4.0` | 呼ぶが 8.0.0 未満に制限されるため安全 |
| `source_gen` 3.1.0 | `>=7.4.0 <9.0.0` | 呼び、8.4.x が範囲内に入る |
| `source_gen` 4.0.0 | `>=7.4.0 <9.0.0` | 呼び、8.4.x が範囲内に入る |
| `source_gen` 4.0.1+ | `^8.1.1` | 呼ばない |

削除されたメソッドを呼び、なおかつ analyzer 8.4.x を許す公開バージョンは `source_gen` 3.1.0 と 4.0.0 の 2 つだけです。上限の `<9.0.0` は、破壊的変更はメジャーバージョンの更新に伴うだろうという読みでした。analyzer チームは非推奨のメンバーをマイナーリリースで削除しましたが、そもそも公開 API ではなかったものについてはこれが通常の運用です。

pub はすべての制約を満たす最新バージョンを選ぶため、他の圧力がないプロジェクトは `source_gen` 4.3.0 を解決し、この問題を見ることはありません。この失敗が起きるには、依存グラフの中で `source_gen` を下に引き止める何かが必要です。その何かはほぼ必ず、キャレット指定で固定しているコード生成パッケージです。2025-10-01 に公開された `objectbox_generator` 5.0.0 は `source_gen: ^3.1.0` を宣言していました。3.1.0 が 3.x 系列の最後のリリースであるため、この指定はちょうど 1 つのバージョン、3.1.0 にしか解決しません。その 2 週間後に analyzer 8.4.0 が出て、`dart pub upgrade` を実行した ObjectBox のプロジェクトはすべて、コンパイルできないビルドスクリプトを手にしました。

ObjectBox の 5.0.1 の changelog はこの失敗を名指ししています。"Generator: migrate to `analyzer` 8 APIs. Require at least `analyzer` 8.1.1 and `source_gen` 4.0.1. Resolves `Error: The method 'getInvocation' isn't defined` when running the generator using `analyzer` 8.4.0"

ObjectBox だけではありませんでした。`json_serializable` 6.11.0 は `source_gen: ^3.1.0` で出荷され、6.11.1 で `>=3.1.0 <5.0.0` に広げられました。`retrofit_generator` 10.0.2、`chopper_generator` 8.3.1、`built_value_generator` 8.11.1、`envied_generator` 1.2.1 も同じ時期に同じ形の固定を抱えていました。`source_gen` は依存グラフ上の単一の共有ノードなので、古い生成パッケージが 1 つあるだけで、プロジェクト内の他のすべての生成パッケージも 3.1.0 まで引きずり下ろされます。`freezed`、`json_serializable`、それに保守されていないビルダーを 1 つ使っているプロジェクトは、毎回まちがったパッケージを疑うことになります。

## きれいな pubspec からの再現

```yaml
# pubspec.yaml
# Dart 3.9.x. Any SDK that admits analyzer 8.4.x reproduces this.
name: repro
environment:
  sdk: ^3.9.0

dependencies:
  objectbox: 5.0.0

dev_dependencies:
  build_runner: ^2.9.0
  objectbox_generator: 5.0.0
```

`dart pub get` を実行し、実際に何が選ばれたかを読みます。

```bash
dart pub deps --style=compact | grep -E 'source_gen|analyzer'
```

`source_gen 3.1.0` と `analyzer 8.4.1` が表示されます。この組み合わせがバグです。続いて `dart run build_runner build` は、あなたのコードが 1 行も解析されないうちに、冒頭のエラーで失敗します。

## 対処 1: source_gen を固定している生成パッケージを更新する

これが正しい修正で、たいていは 1 行で済みます。`source_gen` の上限を作っている制約を見つけて、引き上げてください。

pub に出せないバージョンを要求して、原因のパッケージを名指しさせます。

```bash
dart pub add dev:source_gen:^4.0.1
```

バージョン解決が失敗し、その説明が固定を握っているパッケージを名指しします。

```text
Because objectbox_generator 5.0.0 depends on source_gen ^3.1.0 and no versions
        of objectbox_generator match >5.0.0 <6.0.0, objectbox_generator 5.0.0
        requires source_gen ^3.1.0.
So, because repro depends on both objectbox_generator 5.0.0 and
source_gen ^4.0.1, version solving failed.
```

これは [pub のバージョン解決の失敗](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)と同じく、下から上へ読みます。一番上の行が、変更すべき事実です。

そのうえで名指しされたパッケージを引き上げ、修正をグラフ全体に行き渡らせます。

```bash
dart pub upgrade objectbox objectbox_generator
dart run build_runner build --delete-conflicting-outputs
```

明示的に下限を設定したい場合の、動作が確認できているバージョンです。

- `objectbox_generator` 5.0.1 以降
- `json_serializable` 6.11.1 以降
- `chopper_generator` 8.5.0 以降
- `envied_generator` 1.3.2 以降
- `retrofit_generator` 10.2.3 以降
- `built_value_generator` 8.11.2 以降

修正として `source_gen` を自分の `dev_dependencies` に追加してはいけません。これは生成パッケージの推移的依存であり、自分の pubspec で固定しても、競合が自分のファイルに移って腐るだけです。

## 対処 2: 暫定策として analyzer を固定する

問題の生成パッケージが放置されている場合や、リリース途中で更新を受け入れられない場合は、非推奨メソッドがまだ残っている最後のバージョンに analyzer を抑えます。

```yaml
# pubspec.yaml
# Temporary. Delete once the generator is upgraded.
dependency_overrides:
  analyzer: 8.3.0
```

analyzer 8.3.0（2025-10-10）が `getInvocation` を持つ最後のリリースです。非推奨メソッドは `constructorInvocation` への 1 行の転送だったので、挙動は同一です。

代償は 2 つあり、どちらも現実的です。`dependency_overrides` はグラフ内のすべてのパッケージに対して解決器を黙らせるため、本当に analyzer 8.4 以上を必要とする別のパッケージがあると、`pub get` ではなくコンパイル時に失敗するようになります。さらに override は自分のパッケージが依存として使われるときには無視されるので、公開パッケージがこれを利用者向けの修正として出荷することはできません。日付付きの TODO を添えたブランチレベルの一時回避として扱い、override なしでビルドする CI ジョブを併設して、不要になった時点で気づけるようにしてください。異なる SDK 上で複数のブランチを保守しているなら、[1 つの CI パイプラインから複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)方法が、両方を正直に保つためのパターンです。

## 対処 3: 呼び出しが自分のビルダーにある場合

エラーが指す失敗箇所が `source_gen` ではなく自分のパッケージなら、その呼び出しを書いたのはあなたであり、移行もあなたの担当です。置き換えはそのままです。

```dart
// Before. Requires the implementation import of DartObjectImpl.
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

final invocation = (object as DartObjectImpl).getInvocation();
```

```dart
// After. analyzer 8.1.0 and later. Public API, no src/ import.
import 'package:analyzer/dart/constant/value.dart';

final invocation = object.constructorInvocation;
if (invocation != null) {
  final ctor = invocation.constructor;
  final positional = invocation.positionalArguments;
  final named = invocation.namedArguments;
}
```

`implementation_imports` の ignore も一緒に削除してください。そのうえで自分側の下限を `analyzer: '>=8.1.1'` に設定し、ゲッターを持たない analyzer を pub があなたのコードに渡せないようにします。この下限は飛ばされがちですが、修正済みのパッケージを古い SDK の利用者にとって再び壊れたものに戻してしまうのは、まさにここです。

ついでに、`ConstructorInvocation.constructor2` は存在しますが `constructor` に置き換えられ非推奨になっています。1 つの削除を次の削除と交換するのではなく、同じ作業でまとめて移行してください。

## 落とし穴と紛らわしいケース

**`flutter clean` では直りませんし、直ったこともありません。** build_runner の失敗に対して最も繰り返される助言は `.dart_tool` を削除して再ビルドすることです。ここではそれは、同じ解決済みバージョンに対して同じコンパイルをやり直すだけです。エラーが `.pub-cache` 内のファイルを指しているなら、解決結果そのものが誤っており、キャッシュを消しても何も変わりません。

**`--delete-conflicting-outputs` でも直りません。** このフラグは、あるビルドが別のビルダーの書きたいファイルを生成してしまった場合を扱います。ビルドスクリプトがコンパイルされた後に働くもので、ここではビルドスクリプト自体がコンパイルされていません。

**引き金はたいてい lock ファイルです。** pubspec は何も変わっていません。`dart pub upgrade`、`pubspec.lock` をコミットしていない CI のクリーンな checkout、あるいは同僚の `pub get` が analyzer を 8.4.x に上げた一方で、`source_gen` は 3.1.0 に固定されたままだった、というのが実態です。同僚のマシンではまだビルドできるなら、まず 2 つの lock ファイルを比較してください。

**兄弟のようなエラー、原因は同一です。** `The getter 'name' isn't defined for the class 'NamedType'`、`The getter 'tmp' isn't defined for the class 'Diagnostic'`、`DotShorthandConstructorInvocation isn't defined` はいずれも同じ故障モード、つまり移動した analyzer の API に対してコンパイルされたビルダーです。診断手順は変わりません。エラーのキャッシュパスから 2 つのバージョンを読み取り、古いほうを固定しているパッケージを見つけて更新します。これは[プラグインが名前なしコンストラクターを削除した場合](/ja/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)と同じ形の破壊ですが、今回の API は自分では一度も書いていないパッケージのものです。

**analyzer 9.0.0 は求めている境界ではありません。** 8.4.0 の 8 日後、2025-10-23 に出ています。8.4.x はすでにその下にあるので、`analyzer: <9.0.0` を指定しても守られません。安全な下限は、生成パッケージ側の `source_gen: '>=4.0.1'` と、自分側の `analyzer: '>=8.1.1'` だけです。

## 関連記事

- ここで中心になるのは pub の失敗の論拠を読む力です。[Version solving failed in pubspec.yaml](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) では PubGrub の出力を 1 行ずつ追っています。
- `freezed` も他と同じ `source_gen` ビルダーなので、データクラスにしか使っていないプロジェクトでもこの失敗は起こりえます。[Dart のレコード型と Freezed クラス](/ja/2026/05/dart-records-vs-freezed-classes/)では、そもそもコード生成が必要かどうかを扱っています。
- Riverpod の生成パッケージも同じスタックの上にあります。[Riverpod 2.x から Riverpod 3.0 への移行](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)にはコード生成の更新も含まれます。
- メソッドではなくコンストラクターを削除したパッケージ更新の例です。[The class 'GoogleSignIn' doesn't have an unnamed constructor](/ja/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- 生成パッケージの更新が着地するまでプロジェクトをビルド可能に保つには、[1 つの CI パイプラインから複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)方法を参照してください。

## 出典

- [source_gen の changelog](https://pub.dev/packages/source_gen/changelog)。4.0.1 での `analyzer: ^8.1.1` への移行について。バージョン制約と公開日は 3.1.0、4.0.0、4.0.1 の pub.dev パッケージアーカイブから読み取りました。
- [analyzer の changelog](https://pub.dev/packages/analyzer/changelog)。8.1.0 での `DartObject.constructorInvocation` 追加について。8.3.0 に非推奨の `getInvocation()` が存在し 8.4.0 に存在しないことは、両バージョンの公開アーカイブに対して確認しました。
- [objectbox の changelog](https://pub.dev/packages/objectbox/changelog)。2025-10-29 公開のバージョン 5.0.1 が、このエラーとその修正をそのまま記載しています。
- [pub.dev の build_runner](https://pub.dev/packages/build_runner)。"Failed to compile build script" というメッセージは `lib/src/bootstrap/bootstrapper.dart` に由来します。
- 診断コマンドについては [dart pub deps](https://dart.dev/tools/pub/cmd/pub-deps) と [PubGrub 解決器のドキュメント](https://github.com/dart-lang/pub/blob/master/doc/solver.md)。
