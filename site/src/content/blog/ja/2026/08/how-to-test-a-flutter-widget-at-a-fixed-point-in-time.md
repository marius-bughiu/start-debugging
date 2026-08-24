---
title: "withClock クロージャなしで Flutter ウィジェットを固定時刻でテストする方法"
description: "testWidgets の中では package:clock のアンビエント clock はすでに偽物ですが、開始時刻はテストが始まった実時刻になります。flutter_test_config.dart から独自の AutomatedTestWidgetsFlutterBinding を導入し runTest をオーバーライドすれば、スイート全体で時刻を固定できます。Flutter 3.44.2、clock 1.1.2、fake_async 1.3.3 で検証しました。"
pubDate: 2026-08-24
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "how-to"
  - "clock"
lang: "ja"
translationOf: "2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time"
translatedBy: "claude"
translationDate: 2026-08-24
---

ウィジェットが "3 時間前" と表示したり "こんばんは" と挨拶したりする場合、出力をアサートする前に、そのウィジェットが持つ `now` の概念を定数にする必要があります。よくあるアドバイスは、テスト本体を毎回 `withClock(Clock.fixed(...), () async { ... })` で包むというものですが、これはすぐに煩雑になります。もっと良い方法があり、その出発点は多くの人が誤解している事実です。**`testWidgets` の中では `package:clock` のアンビエント `clock` はすでに偽物です**。`FakeAsync.run` が代わりに設定してくれ、`tester.pump` を呼んだときだけ進みます。ただし予測可能な時刻から始まるわけではありません。`FakeAsync()` が実際のシステム時計を種にして初期化されるからです。この種の値ひとつを直せば、テストごとのクロージャなしでスイート全体が決定的になります。以下の内容はすべて Flutter 3.44.2 (Dart 3.12.2)、`clock` 1.1.2、`fake_async` 1.3.3 で実行しました。

## testWidgets の中で clock.now() が実際に返す値

まずは可能なかぎり小さいプローブから始めます。設定ファイルもカスタムバインディングもありません。

```dart
// Flutter 3.44.2, Dart 3.12.2, clock 1.1.2
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('the ambient clock is already fake', (WidgetTester tester) async {
    final a = clock.now();
    await tester.pump(const Duration(hours: 1));
    final b = clock.now();
    print('a=$a');
    print('b=$b delta=${b.difference(a)}');
    print('DateTime.now delta=${DateTime.now().difference(a)}');
  });
}
```

`flutter test` の出力です。

```text
a=2026-08-24 09:19:57.248297
b=2026-08-24 10:19:57.248297 delta=1:00:00.000000
DateTime.now delta=0:00:00.094231
```

ここから読み取れることが 2 つあります。2 回の `clock.now()` の差はマイクロ秒単位で *ちょうど* 1 時間で、実際の時計がこんな値を出すことはありません。そして `DateTime.now()` は 94 ミリ秒しか進んでいません。これがテストの実所要時間です。つまり `clock` は偽物で、`DateTime.now()` は本物です。

その配線は `fake_async` にあります。`FakeAsync.run` 自身がコールバックを `withClock` で包んでいます。

```dart
// fake_async 1.3.3, lib/fake_async.dart
T run<T>(T Function(FakeAsync self) callback) => runZoned(
      () => withClock(_clock, () => callback(this)),
      // ...timer and microtask interception...
    );
```

そして `AutomatedTestWidgetsFlutterBinding.runTest` (`packages/flutter_test/lib/src/binding.dart`) は、テスト本体全体をまさにその中で実行します。

```dart
final fakeAsync = FakeAsync();
_currentFakeAsync = fakeAsync; // reset in postTest
_clock = fakeAsync.getClock(DateTime.utc(2015));
fakeAsync.run((FakeAsync localFakeAsync) { /* test body */ });
```

別々の 2 つのクロックがあることに注目してください。`fakeAsync.getClock(DateTime.utc(2015))` はバインディング自身のクロックとして保存されます。だから新しいテストでは `tester.binding.clock.now()` が `2015-01-01T00:00:00.000Z` を返し、`pump` で進みます。

```text
binding.clock            = 2015-01-01T00:00:00.000Z
binding.clock after pump(10m) = 2015-01-01T00:10:00.000Z
```

ウィジェットが `package:clock` 経由で見るクロックは、同じ `FakeAsync` の上に載った *別の* `Clock` で、その起点は `FakeAsync` のコンストラクターから来ます。

```dart
// fake_async 1.3.3
FakeAsync({DateTime? initialTime, this.includeTimerStackTrace = true}) {
  final nonNullInitialTime = initialTime ?? clock.now();
  _clock = Clock(() => nonNullInitialTime.add(elapsed));
}
```

`initialTime ?? clock.now()` です。バインディングは引数なしで `FakeAsync()` を呼ぶので、偽クロックの起点はテストが始まった瞬間に *アンビエント* クロックが示していた値になります。どのゾーンの外でもない場所ではそれはシステム時計です。ここが唯一の非決定的な部分であり、あなたが制御できる部分でもあります。

## flutter_test_config.dart の withClock が何も効かない理由

スイート全体のセットアップとして最もよく提案されるのが `flutter_test_config.dart` です。動きそうに見えます。

```dart
// test/flutter_test_config.dart -- DOES NOT WORK
import 'dart:async';
import 'package:clock/clock.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await withClock(
    Clock.fixed(DateTime.utc(2026, 3, 14, 9, 26, 53)),
    () async => testMain(),
  );
}
```

ここには罠が 2 つあります。1 つ目は、素直に `return withClock(fixed, testMain)` と書いた場合のコンパイルエラーです。`withClock<T>` は戻り値の型から `T` を推論するため `Future<void> Function()` を要求しますが、`testExecutable` が渡してくるのは `FutureOr<void> Function()` です。自分でクロージャを挟む必要があります。

2 つ目の罠は、コンパイルが通っても効果がまったくないことです。両側に print を入れると順序が明白になります。

```text
CFG before testMain, zone clock=2026-08-24T09:16:56.269316
CFG inside zone, clock=2026-03-14T09:26:53.000Z
MAIN body, clock=2026-03-14T09:26:53.000Z
CFG testMain returned, still inside zone
CFG after zone
P12 body, clock=2026-08-24T09:16:56.295534
```

ゾーンが覆っているのはテストファイルのトップレベル `main()` で、そこは `test` と `testWidgets` でテストを *宣言* するだけです。`package:test` は宣言された各本体を後から、独自のゾーン系列で実行します。`testExecutable` が戻ってからずっと後の話です。`withClock` はゾーンスコープなので、すでに抜けたゾーンは何にも影響できません。`testMain` を `withClock` で包めと書いている記事は、それを検証していません。

`flutter_test_config.dart` が *本当に* 役に立つのは、スイートの前に一度だけコードを走らせる用途です。バインディングを構築するのはまさにその種のコードです。

## スイート全体でクロックを固定する 3 つのステップ

1. これから import するパッケージを宣言します。`clock` は `dependencies` に入れます。プロダクションコードが `clock.now()` を呼ぶからです。`meta` は最後のセクションの `@isTest` アノテーションも使う場合にだけ `dev_dependencies` に追加します。そうしないとアナライザーが `depend_on_referenced_packages` を報告します。

   ```yaml
   # pubspec.yaml -- Flutter 3.44.2
   dependencies:
     flutter:
       sdk: flutter
     clock: ^1.1.2
   ```

2. `AutomatedTestWidgetsFlutterBinding` を継承し、`super.runTest` が固定クロックのゾーン内で実行されるように `runTest` をオーバーライドします。これがすべての仕掛けです。`FakeAsync()` を構築するのは `super.runTest` であり、`FakeAsync` は自分の `initialTime` のためにアンビエントクロックを読みます。

   ```dart
   // test/flutter_test_config.dart -- Flutter 3.44.2
   import 'dart:async';
   import 'package:clock/clock.dart';
   import 'package:flutter/foundation.dart';
   import 'package:flutter_test/flutter_test.dart';

   final DateTime kTestEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

   class FixedStartBinding extends AutomatedTestWidgetsFlutterBinding {
     @override
     Future<void> runTest(
       Future<void> Function() testBody,
       VoidCallback invariantTester, {
       String description = '',
     }) {
       return withClock(
         Clock.fixed(kTestEpoch),
         () => super.runTest(testBody, invariantTester, description: description),
       );
     }
   }
   ```

3. どのテストよりも先に、`testExecutable` でバインディングをインスタンス化します。`TestWidgetsFlutterBinding.ensureInitialized()` は `_instance ?? binding.ensureInitialized(...)` を返し、`AutomatedTestWidgetsFlutterBinding` のコンストラクターは `initInstances` を通じて `_instance` を設定します。つまり最初に構築されたバインディングが勝ち、`testWidgets` はあなたのものを使います。

   ```dart
   Future<void> testExecutable(FutureOr<void> Function() testMain) async {
     FixedStartBinding();
     await testMain();
   }
   ```

これで完了です。テストファイルの変更は不要です。アンビエントクロックを読むウィジェットは、

```dart
// Flutter 3.44.2
class AmbientClockBanner extends StatelessWidget {
  const AmbientClockBanner({super.key});

  @override
  Widget build(BuildContext context) => Text(
        'ambient:${clock.now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}
```

どのマシンでもどの実行でも同じように描画されるようになります。

```text
binding      = FixedStartBinding
ambient      = 2026-03-14T09:26:53.000Z
binding.clock= 2015-01-01T00:00:00.000Z
rendered     = ambient:2026-03-14T09:26:53.000Z
```

そしてクロックを差し替えたのではなく `FakeAsync` に種を与えただけなので、偽の時間はこれまでどおりあなたの制御下で進みます。

```dart
testWidgets('advances with pump only', (WidgetTester tester) async {
  final a = clock.now();
  await tester.pump(const Duration(hours: 3, minutes: 30));
  final b = clock.now();
  print('a=$a b=$b delta=${b.difference(a)}');
});
// a=2026-03-14 09:26:53.000Z
// b=2026-03-14 12:56:53.000Z delta=3:30:00.000000
```

`clock.stopwatch()` も同じ偽クロックに繋がっているので、`pump(Duration(seconds: 42))` は経過時間がちょうど `0:00:42.000000` になります。`runTest` は毎回新しい `FakeAsync` を作るので、各テストは選んだエポックから再開します。

## 開始固定と完全停止: withClock を置く場所が決める

もう 1 つの変種があり、違いはネストの 1 行だけです。`super.runTest` ではなく `testBody` を包むと、あなたのゾーンは `FakeAsync.run` の *内側* に確立されるので、偽クロックを完全に覆い隠します。

```dart
// test/frozen/flutter_test_config.dart -- Flutter 3.44.2
class FrozenClockBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  Future<void> runTest(
    Future<void> Function() testBody,
    VoidCallback invariantTester, {
    String description = '',
  }) {
    return super.runTest(
      () => withClock(Clock.fixed(kFrozen), testBody),
      invariantTester,
      description: description,
    );
  }
}
```

これで `pump` はフレームワークのアニメーション時間を進めますが、`clock.now()` は決して動きません。

```text
a=2026-03-14 09:26:53.000Z b=2026-03-14 09:26:53.000Z delta=0:00:00.000000
```

どちらの変種もアニメーションを妨げません。`Ticker` と `SchedulerBinding` は `package:clock` ではなく `FakeAsync` のフレームタイムスタンプで駆動されるからです。停止クロックのバインディングでも `showDialog` と `pumpAndSettle` は解決し、ダイアログが見つかります。何をアサートするかで選んでください。

| | `super.runTest` を包む | `testBody` を包む |
| --- | --- | --- |
| 開始時刻 | 固定 | 固定 |
| `pump` で進むか | はい | いいえ |
| 仕組み | `FakeAsync.initialTime` に種を与える | `FakeAsync` のクロックを覆い隠す |
| 向いている用途 | 相対タイムスタンプ、カウントダウン、debounce | "こんばんは" 系の挨拶、日付フォーマット |

避けるべきことが 1 つあります。`withClock(Clock(() => this.clock.now()), ...)` のように、バインディング自身のクロックへ委譲する遅延クロックを作らないでください。`FakeAsync` のコンストラクターは、バインディングがテストに入る前に `clock.now()` を呼びますが、`AutomatedTestWidgetsFlutterBinding.clock` は `inTest` をアサートします。

```text
'package:flutter_test/src/binding.dart': Failed assertion: line 2223 pos 12: 'inTest': is not true.
package:clock/src/clock.dart 44:26   Clock.now
package:fake_async/fake_async.dart 106:53   new FakeAsync
package:flutter_test/src/binding.dart 2482:23   AutomatedTestWidgetsFlutterBinding.runTest
```

素の `Clock.fixed` を使えばこの問題は丸ごと回避できます。

## 数ファイルだけで必要ならテストごとのラッパー

カスタムバインディングが大掛かりすぎると感じるなら、クロージャを一度だけラッパーとして書きます。`package:meta` の `@isTest` アノテーションがあれば、アナライザーと IDE のテスト検出も満足します。

```dart
// Flutter 3.44.2, clock 1.1.2, meta 1.18.0
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meta/meta.dart';

final DateTime kEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

@isTest
void testWidgetsAt(
  String description,
  WidgetTesterCallback callback, {
  DateTime? at,
  bool skip = false,
}) {
  testWidgets(
    description,
    (WidgetTester tester) =>
        withClock(Clock.fixed(at ?? kEpoch), () => callback(tester)),
    skip: skip,
  );
}
```

ラッパーのゾーンはテスト本体全体にまたがるので、テスト中のすべての再ビルドが固定クロックを見ます。`await` の後の `tap` や `setState` によって起きた再ビルドも含みます。これがテストの一部だけを包む場合との決定的な違いです。`await withClock(fixed, () async { await tester.pumpWidget(w); })` と書いてクロージャを抜けた後にウィジェットを再ビルドすると、その再ビルドはゾーンの外に出てしまい、偽物ではあるが実時刻を種にしたクロックへ黙って戻ります。実測しました。クロージャの内側ではウィジェットは `2026-03-14T09:26:53.000Z` を描画し、その後の `pumpWidget` は `2026-08-24T09:15:30.029972` を描画しました。

ローカルの `withClock` はバインディング全体の設定を上書きするので、2 つの手法は組み合わせられます。`FixedStartBinding` のもとで、本体を `withClock(Clock.fixed(DateTime.utc(2031, 5, 2, 7)))` で包んだテストは `2031-05-02T07:00:00.000Z` を描画します。

## DateTime.now() は偽装できず、どのバインディングも助けにならない

`package:clock` は純粋なゾーン参照です。トップレベルゲッターの実装は全部でこれだけです。

```dart
// clock 1.1.2, lib/src/default.dart
Clock get clock => Zone.current[_clockKey] as Clock? ?? const Clock();
```

代入可能なグローバルはありません。`DateTime.now()` に相当するものもなく、こちらは VM に直行します。これを呼ぶウィジェットは偽の時間を完全に無視します。丸 1 年分でも同じです。

```text
raw:2026-08-24T09:19:57.370144
after pump(365 days) -> raw:2026-08-24T09:19:57.376244
```

差は 6 マイクロ秒、どちらも実時刻です。ですからウィジェットやモデルが `DateTime.now()` を直接呼んでいる場合、ここまでの内容は何の役にも立ちません。その呼び出し箇所を `clock.now()` に移すか、クロックを依存として受け取ってゾーンを完全に使わないかのどちらかです。

```dart
// Flutter 3.44.2
class InjectedClockBanner extends StatelessWidget {
  const InjectedClockBanner({required this.now, super.key});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => Text(
        'injected:${now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}

// test
await tester.pumpWidget(InjectedClockBanner(now: () => kEpoch));
```

新しいコードでは私は注入を選びます。理由は [.NET でアンビエントな static より TimeProvider と FakeTimeProvider が優れているのと同じ](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)で、依存がゾーンに隠れずコンストラクターに見えるからです。バインディングのオーバーライドは、すでに `clock.now()` に依存している既存コードベースや、編集できないサードパーティパッケージに対する現実的な答えです。

Riverpod を使っているなら、テストの `ProviderScope` でオーバーライドした `Provider<Clock>` が、すでにある配線を活かした同じ発想になります。[Notifier vs AsyncNotifier vs StreamNotifier](/ja/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) のパターンとも相性が良いです。

## コミット前に知っておきたい 4 つの落とし穴

**素の `test()` 本体は実時刻のクロックを受け取ります。** `FakeAsync` は `testWidgets` の中にしか存在しないので、同じファイル内の `test('...')` は `clock.now()` も `DateTime.now()` も実時刻を報告します。ユニットテストでも固定クロックが必要なら、その本体を `withClock` で包むか、`package:fake_async` の `fakeAsync` を直接使ってください。

**`integration_test` と `flutter run` 経由のテストは実時間で動きます。** `FLUTTER_TEST` がないとき `flutter_test` は `LiveTestWidgetsFlutterBinding` を選び、そのクロックはコードに固定されています。

```dart
// packages/flutter_test/lib/src/binding.dart
@override
Clock get clock => const Clock();
```

`FakeAsync` も偽クロックもありません。設定ファイルはプロジェクトルートではなく `test/` に置いてください。探索の走査は、あるディレクトリの `pubspec.yaml` センチネルを確認する前に、同じディレクトリの `flutter_test_config.dart` を確認します。つまりルートに置いた設定は `integration_test/` にも適用され、そこで `AutomatedTestWidgetsFlutterBinding` を構築すると `IntegrationTestWidgetsFlutterBinding` と衝突します。統合テストで固定クロックを前提にしないでください。

**設定ファイルの探索は近い順です。** `flutter_tools` はテストファイルから上へ辿って `flutter_test_config.dart` を探し、`pubspec.yaml` を含む最初のディレクトリで止まります。したがって `test/frozen/flutter_test_config.dart` は `test/frozen/` 配下のすべてに対して `test/flutter_test_config.dart` を覆い隠し、ひとつのテストに適用される設定ファイルは常に 1 つだけです。これにより停止クロックのスイートと開始固定のスイートを並べて運用できますが、同時に両者を重ねることはできないという意味でもあります。

**Web でも同じように動きます。** `flutter test --platform chrome` は `_binding_web.dart` を経由し、その `ensureInitialized` も `AutomatedTestWidgetsFlutterBinding.ensureInitialized()` を返します。Web のブートストラップも `testExecutable` を呼びます。カスタムバインディングはそのまま適用されます。

覚えておくべきモデルはこうです。`testWidgets` はすでに偽クロックを与えており、どこから始まるかを決めるのは `FakeAsync`、そしてその決定に対する唯一のレバーは `runTest` が `FakeAsync` を構築する瞬間のアンビエントクロックです。あとは `super.runTest` のどちら側に `withClock` を置くかという選択だけです。

## 関連記事

- [.NET 11 で TimeProvider と FakeTimeProvider を使って時間依存コードをテストする方法](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) は同じ問題を .NET エコシステムで扱っています。あちらでは抽象が BCL に同梱されています。
- [Flutter で非同期ギャップの後に mounted チェックで setState を守る方法](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) は、`await` の境界を越えても壊れないウィジェットテストを書くためのもう半分です。
- [Flutter で dispose 内の StreamSubscription をキャンセルする方法](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) がここで関係するのは、ティアダウン時に残ったタイマーが、残った偽タイマーと同じ `_verifyInvariants` のアサーションを踏むからです。
- [Flutter の Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/ja/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) は、ゾーンではなくプロバイダーのオーバーライドで注入したクロックを配線する話です。
- [Fix: A TextEditingController was used after being disposed in Flutter](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) は、偽の時間が大きく飛ぶようになったときに現れるテスト失敗の類型についてです。

## 参照

- [`package:clock` の API ドキュメント](https://pub.dev/documentation/clock/latest/) と [`withClock` の実装](https://pub.dev/packages/clock)、バージョン 1.1.2。
- [`package:fake_async`](https://pub.dev/packages/fake_async) 1.3.3、特に `FakeAsync` のコンストラクターと `FakeAsync.run`。
- Flutter 3.44 API リファレンスの [`AutomatedTestWidgetsFlutterBinding`](https://api.flutter.dev/flutter/flutter_test/AutomatedTestWidgetsFlutterBinding-class.html) と [`TestWidgetsFlutterBinding.clock`](https://api.flutter.dev/flutter/flutter_test/TestWidgetsFlutterBinding/clock.html)。
- `flutter_test_config.dart` と `testExecutable` については [`flutter_test` ライブラリのドキュメント](https://api.flutter.dev/flutter/flutter_test/flutter_test-library.html)。
- タグ 3.44.2 の Flutter SDK ソース: `packages/flutter_test/lib/src/binding.dart`、`packages/flutter_test/lib/src/_binding_web.dart`、`packages/flutter_tools/lib/src/test/test_config.dart`。
