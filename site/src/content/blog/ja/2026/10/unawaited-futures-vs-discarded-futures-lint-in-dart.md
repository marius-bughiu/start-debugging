---
title: "Dart の unawaited_futures と discarded_futures: どちらのリントがどの await 漏れを検出するか"
description: "unawaited_futures は async 本体の内側だけ、discarded_futures は同期本体の内側だけを調べ、どちらもアロー関数、tear-off、コレクションリテラルは見逃します。Dart 3.12.2 と Flutter 3.44.8 でケースごとに検証し、お勧めの analysis_options.yaml も紹介します。"
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "lints"
  - "async"
lang: "ja"
translationOf: "2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-22
---

**結論:** 2 つのリントは、呼び出しが置かれている関数本体の種類で役割を分担しています。`unawaited_futures` は `async` 本体の内側で破棄された `Future` を報告します。`discarded_futures` は同期本体の内側で破棄された `Future` (または `FutureOr`) を報告します。Flutter では `initState`、`dispose`、そしてすべての `onPressed: () { ... }` ブロックがこれに当たります。両者が同じ行で反応することはありません。片方だけ有効にするなら `unawaited_futures` にしてください。負荷が小さく、検出されたものはほぼバグだからです。ウィジェットのコードで意図的な fire-and-forget 呼び出しすべてに `unawaited(...)` を書く覚悟があるなら、`discarded_futures` も追加します。以下はすべて Dart 3.12.2 (Flutter 3.44.8、`meta` 1.19.0) で `dart analyze` を使って計測した結果です。

どちらのルールも `package:lints` の core や recommended、`package:flutter_lints` 6.0.0 には含まれていないため、新しく `flutter create` したプロジェクトでは、自分で有効にするまでどちらも報告されません。

## 比較一覧

| | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- |
| 対象範囲 | `async` / `async*` 本体内の文 | 同期本体内の文 |
| 報告する型 | `Future` とそのサブタイプ (`TickerFuture` を含む) | `Future`、そのサブタイプ、`FutureOr` |
| 導入時期 | 古くからある (Dart 2.18 より前) | Dart 2.18 |
| `lints` / `flutter_lints` への収録 | なし / なし | なし / なし |
| Flutter での典型的な検出例 | `onPressed: () async { ... }` 内の `Navigator.pushNamed(...)` | `initState` 内の `_load();`、`_controller.forward();` |
| `unawaited(...)` で抑制 | 可能 | 可能 |
| `@awaitNotRequired` (`meta` 1.17.0 以降) で抑制 | 可能 | 可能 |
| `dart fix --apply` による一括修正 | 不可 (IDE のクイックフィックスのみ) | 不可 (IDE のクイックフィックスのみ) |
| Flutter アプリでのノイズ量 | 少ない | 中から多い |

## ルールが 1 つではなく 2 つある理由

どちらのルールも同じビジター、`pkg/linter/lib/src/util/unused_futures.dart` の `UnusedFuturesVisitor` を薄くラップしたものです。このビジターは、式文、カスケードセクション、文字列補間の 3 種類のノードを走査します。各式について、その式が "interesting" かどうかをルールに尋ね、このフィルターこそが 2 つのリントの違いのすべてです。`3.12.2` タグの `unawaited_futures.dart` にあるフィルターは次のとおりです。

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/unawaited_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule is not currently concerned with `FutureOr`.
  if (type == null || !type.isOrImplementsFuture) {
    return false;
  }
  // This rule is only concerned with code in async functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isAsynchronous ?? false;
},
```

そして `discarded_futures.dart` は次のとおりです。

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/discarded_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule does concern itself with `FutureOr`.
  if (type == null || !type.isOrImplementsFutureOrFutureOr) {
    return false;
  }
  // This rule is only concerned with code in sync functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isSynchronous ?? false;
},
```

このコードから 2 つのことが直接わかります。1 つ目は、判定するのは外側のメソッドではなく、最も内側の `FunctionBody` だということです。`async` メソッドの中に書いたブロッククロージャ `() { save(); }` は同期本体なので、`discarded_futures` の担当になります。2 つ目は、`FutureOr` は同期側でしか扱われないということです。`async` メソッド内で破棄された `FutureOr<int>` は、どちらのルールも報告しません。

動機も異なります。`unawaited_futures` が狙うのは `await` の付け忘れです。すでに `async` 関数の中にいるので、修正はキーワード 1 つで済みます。`discarded_futures` が狙うのは `async` の付け忘れです。非同期処理を開始する同期関数は、多くの場合その関数自体が `async` であるべきで、呼び出し側がその完了を待つべきだということを示します。`discarded_futures` の公式ドキュメントもまさにそう述べていて、関数が `async` になった後は `unawaited_futures` が引き継ぐルールだと案内しています。

## ケース集: どこで何が反応するか

思いつく限りの呼び出しの形を 1 つのファイルにまとめ、`package:lints/recommended.yaml` の上に両方のルールを有効にして `dart analyze` を実行しました。

```yaml
# analysis_options.yaml, Dart 3.12.2
include: package:lints/recommended.yaml
linter:
  rules:
    - unawaited_futures
    - discarded_futures
```

```dart
// Dart 3.12.2, meta 1.19.0
import 'dart:async';
import 'package:meta/meta.dart';

Future<void> save() async {}
FutureOr<int> maybeAsync() => 1;
@awaitNotRequired
Future<void> log(String m) async {}

class Repo {
  Future<void> flush() async {}
}

Future<void> asyncCaller() async {
  save(); // A1
  maybeAsync(); // A2 FutureOr in async
  final f = save(); // A3 assigned
  unawaited(save()); // A4
  log('x'); // A5 awaitNotRequired
  Repo()..flush(); // A6 cascade
  print('${save()}'); // A7 interpolation
  var list = [save()]; // A8 collection
  Future.delayed(Duration.zero, () => 1); // A9
  <String, Future<void>>{}.putIfAbsent('k', save); // A10
  void inner() {
    save(); // A11 sync closure inside async
  }
  [1].forEach((_) async {
    save(); // A12 async closure
  });
  save().then((_) {}); // A13 .then chain
  save().ignore(); // A14 ignore()
  await f;
  inner();
  list.length;
}

void syncCaller() {
  save(); // S1
  maybeAsync(); // S2 FutureOr in sync
  final f = save(); // S3 assigned
  unawaited(save()); // S4
  log('x'); // S5 awaitNotRequired
  Repo()..flush(); // S6 cascade
  takesFuture(save()); // S7 argument
  f.ignore();
}

Future<void> syncReturn() {
  return save(); // S8 returned
}

void takesFuture(Future<void> f) {}

void Function() handler = () => save(); // S9 arrow in sync closure
void Function() handler2 = () {
  save(); // S10 block sync closure
};
Future<void> Function() handler3 = () async {
  save(); // S11 async closure
};
```

`dart analyze` の出力から読み取った結果は次のとおりです。

| ケース | コード | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- | --- |
| A1 | `async` 内の `save();` | 報告 | - |
| A2 | `async` 内の `maybeAsync();` (`FutureOr`) | - | - |
| A3, S3 | `final f = save();` | - | - |
| A4, S4 | `unawaited(save());` | - | - |
| A5, S5 | `@awaitNotRequired` 付きの呼び出し先 | - | - |
| A6 | `async` 内の `Repo()..flush();` | 報告 | - |
| A7 | `async` 内の `'${save()}'` | 報告 | - |
| A8 | `[save()]` コレクションリテラル | - | - |
| A9 | `Future.delayed(d, computation)` | - | - |
| A10 | `Map.putIfAbsent` | - | - |
| A11 | `async` メソッド内のブロッククロージャ | - | 報告 |
| A12 | `async` クロージャ | 報告 | - |
| A13 | `save().then((_) {});` | 報告 (`then` に対して) | - |
| A14 | `save().ignore();` | - | - |
| S1 | 同期内の `save();` | - | 報告 |
| S2 | 同期内の `maybeAsync();` | - | 報告 |
| S6 | 同期内の `Repo()..flush();` | - | 報告 |
| S7 | `takesFuture(save());` | - | - |
| S8 | `return save();` | - | - |
| S9 | `() => save()` アロークロージャ | - | - |
| S10 | `() { save(); }` | - | 報告 |
| S11 | `() async { save(); }` | 報告 | - |

いくつかの行には補足が必要です。

- **A9 と A10 はハードコードされた例外です。** ビジターは、computation 引数付きで呼ばれた `Future.delayed` と `Map.putIfAbsent` をスキップします。どちらも戻り値を意図的に無視するのが一般的だからです。
- **A13 は `save` ではなく `then` に対して報告されます。** `save().then(...)` は新しい `Future` を返し、破棄されるのはそちらです。`.then` を連鎖させても、結果を処理したことにはなりません。
- **A14 がクリーンなのは `Future.ignore()` が `void` を返すからです。** `unawaited(...)` のメソッド呼び出し版で、Dart 2.14 から使えます。`unawaited` と違い、future が完了時に持つエラーも握りつぶすので、本当に気にしない場合にだけ使ってください。
- **S7 は意図的にクリーンです。** future を `Future<void>` 型のパラメーターに渡すことで、責任を呼び出し先に引き渡しています。

## 両方のルールに共通する盲点

表の 2 行は本物の偽陰性で、どちらも upstream で追跡されています。

**アロー本体 (S9)。** `() => save()` は `Future` を返す同期の式本体です。ビジターは文しか見ないため、クロージャが `void Function()` に代入され、呼び出し側が future を捨てる場合でも、何も報告されません。これは [dart-lang/sdk#61155](https://github.com/dart-lang/sdk/issues/61155) です。

**`void` コールバックへの tear-off。** 次のコードも試しました。

```dart
// Dart 3.12.2
void execute(void Function() cb) => cb();

void tearoffs() {
  execute(save); // Future<void> Function() passed as void Function()
}
```

どちらのルールも報告しませんでした。Dart は `void Function()` が期待される場所に `Future<void> Function()` を渡すことを許可するため、future は `execute` の内部で破棄され、どのリントにも見えません。これは [dart-lang/sdk#56921](https://github.com/dart-lang/sdk/issues/56921) が扱っています。関連するリントは `avoid_void_async` ですが、これが検出するのは `void` を返すと宣言された `async` 関数だけで、tear-off は対象外です。

コレクションリテラル (A8) と `async` 本体内の `FutureOr` (A2) を加えると、破棄された future が報告されない形の全リストになります。また、`unawaited` は現時点で `FutureOr` を受け付けないため ([dart-lang/sdk#63818](https://github.com/dart-lang/sdk/issues/63818))、S2 のきれいな修正方法は `final _ = maybeAsync();` か、await することです。

## Flutter ウィジェットでの見え方

Flutter アプリでノイズ量を左右するのも同じ分担です。ウィジェットのコールバックの大半が同期だからです。Flutter 3.44.8 で、`package:flutter_lints/flutter.yaml` の上に両方のルールを有効にした結果です。

```dart
// Flutter 3.44.8, Dart 3.12.2
class _HomeState extends State<Home> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this);

  Future<void> _load() async {}

  @override
  void initState() {
    super.initState();
    _load(); // F1: discarded_futures
    _c.forward(); // F2: discarded_futures (TickerFuture implements Future)
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      TextButton(
        onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const Home())), // F3: nothing
        child: const Text('a'),
      ),
      TextButton(
        onPressed: () {
          Navigator.of(context).pushNamed('/x'); // F4: discarded_futures
        },
        child: const Text('b'),
      ),
      TextButton(
        onPressed: () async {
          await _load();
          if (!context.mounted) return;
          Navigator.of(context).pushNamed('/x'); // F5: unawaited_futures
        },
        child: const Text('c'),
      ),
    ]);
  }
}
```

F2 は不満の出やすいケースです。`AnimationController.forward()`、`reverse()`、`repeat()`、`animateTo()` はすべて `TickerFuture` を返しますが、await する人はほとんどいません。`discarded_futures` を有効にすると、これらすべてに `unawaited(...)` が必要になります。一方、F1 はまさにこのルールが存在する理由そのもののバグです。`initState` 内の `_load()` は、自分で書いた `try`/`catch` ではなくゾーンにエラーを投げますし、ウィジェットが破棄された後に `setState` を呼べば、[mounted チェックの領域](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)に入ります。

F3 と F4 は同じことをしています。報告されるのはブロック形式だけなので、コールバックを `{ ... }` から `=>` に書き換えると、何も直さないまま `discarded_futures` を黙らせてしまえます。

## unawaited_futures を選ぶ場合

- **偽陽性がほぼゼロのルールを 1 つ欲しい場合。** `async` 関数の内側で破棄された `Future` は、ほぼ確実に `await` の付け忘れで、それが持つエラーは `try`/`catch` をすり抜け、[`PlatformDispatcher.onError` またはガード付きゾーン](/ja/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)に到達します。
- **サーバーまたは CLI の Dart を書いている場合。** `main` はたいてい `async` なので、コードの大部分がカバーされ、残りの同期コードが非同期処理を開始することはまれです。
- **チームがすでに `async` コールバックを使っている場合。** ハンドラーが `onPressed: () async { ... }` なら、このルールがカバーします (F5)。

## discarded_futures を追加する場合

- **パッケージを公開している場合。** 非同期処理を黙って開始する同期のパブリックメソッドは API の臭いであり、このルールはそのすべてを見つけます。
- **fire-and-forget をレビューで見えるようにしたい場合。** ルールを有効にすると、意図的な破棄はすべて `unawaited(...)` として読めるか、呼び出し先に `@awaitNotRequired` が付くので、それこそが狙いです。
- **誰も await していない `initState` の処理でバグを出したことがある場合。** それが F1 のケースで、見つけられるのはこのルールだけです。

既存の Flutter アプリに追加する場合、検出の大半は `AnimationController` の呼び出しとブロックコールバック内のナビゲーションになると考えてください。Dart 3.12.2 にはどちらのルールにも `dart fix` による一括修正がなく (手元の再現では `dart fix --dry-run` は何も提案しませんでした)、[`dart fix` でリポジトリ全体に適用できるマイグレーション](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)とは違い、この整理は IDE のクイックフィックスを 1 つずつ適用するしかありません。

## @awaitNotRequired で安全に破棄できる API を示す

ログ出力、アナリティクス、キャッシュのウォームアップなど、fire-and-forget を前提に設計した自作 API では、呼び出し側すべてをラップする代わりに宣言へアノテーションを付けます。

```dart
// Dart 3.12.2, meta 1.19.0
import 'package:meta/meta.dart';

@awaitNotRequired
Future<void> track(String event) async {
  // send to analytics, errors handled inside
}

void onTap() {
  track('tap'); // neither rule reports this
}
```

`@awaitNotRequired` は `package:meta` 1.17.0 で追加され、1.18.1 で typedef にも付けられるようになりました。そのため、アノテーション付き typedef を型に持つコールバックパラメーターも除外されます。両方のリントがこれを尊重し (上の A5 と S5)、チェックはオーバーライドされたメンバーにも及ぶので、アノテーション付きメソッドのオーバーライドも除外されたままです。使うのは、その関数が自分でエラーを処理する場合だけにしてください。このアノテーションは future を破棄しても安全だとアナライザーに伝えるもので、それを真にするのはあなたの責任です。Flutter 3.47 は `package:flutter/foundation.dart` からこのアノテーションを再エクスポートします。これを使うパッケージが 3.44 のビルドを壊す場合は、[`awaitNotRequired` 未定義名の修正](/ja/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)を参照してください。

## 選択を決める落とし穴

コードベースがアローコールバック (`onPressed: () => doThing()`) に依存している場合、アロー形式は `discarded_futures` から見えないため (S9、F3)、そのノイズの多さに見合う成果は得られません。そうしたコードベースでは、`unawaited_futures` だけを有効にし、"非同期処理は `async` コールバックに置く" というチームルールを加えれば、価値の大半が得られます。コードベースがブロックコールバックと `initState` でのロード処理を使っているなら、それらの呼び出しを見られるのは `discarded_futures` だけなので、`unawaited` を増やす手間をかける価値があります。

C# 開発者にはおなじみの問題の形でしょう。これは [CS4014 "this call is not awaited"](/ja/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) の Dart 版で、ただし C# は `async` メソッドの中でしか報告しません。これは `unawaited_futures` 側にあたります。Dart では、もう半分も自分で有効にできます。

## お勧めの設定

すべての Dart と Flutter プロジェクトで、今すぐ `unawaited_futures` を有効にしてください。パッケージや、fire-and-forget を明示したいアプリでは `discarded_futures` を追加し、`unawaited(_controller.forward())` と書くことを受け入れます。私が使っている設定は次のとおりです。

```yaml
# analysis_options.yaml, Flutter 3.44.8 / Dart 3.12.2
include: package:flutter_lints/flutter.yaml

linter:
  rules:
    - unawaited_futures
    - discarded_futures
    - avoid_void_async
```

`avoid_void_async` はその相棒です。`void bad() async {}` を報告し、`Future<void>` と宣言させることで、future が型システム上に存在し、他の 2 つのルールや呼び出し側から見えるようにします。tear-off の穴は埋まりませんが、誰も await できない future を持つ新しい `async` 関数を作ってしまうことは防げます。

## 関連記事

- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/ja/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [How to use BuildContext safely after an await in Flutter](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [How to run dart fix across a whole repo to apply Flutter migrations](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/ja/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Fix CS4014: because this call is not awaited, execution continues](/ja/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)

## 参考資料

- dart.dev の [unawaited_futures](https://dart.dev/tools/linter-rules/unawaited_futures) と [discarded_futures](https://dart.dev/tools/linter-rules/discarded_futures)。
- タグ 3.12.2 のルールのソース: [unawaited_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unawaited_futures.dart)、[discarded_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/discarded_futures.dart)、[unused_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/util/unused_futures.dart)。
- [`awaitNotRequired` in package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html) と [meta の changelog](https://pub.dev/packages/meta/changelog)。
- upstream の issue: [#61155](https://github.com/dart-lang/sdk/issues/61155) (アロー本体)、[#56921](https://github.com/dart-lang/sdk/issues/56921) (tear-off)、[#63818](https://github.com/dart-lang/sdk/issues/63818) (`unawaited` と `FutureOr`)。
