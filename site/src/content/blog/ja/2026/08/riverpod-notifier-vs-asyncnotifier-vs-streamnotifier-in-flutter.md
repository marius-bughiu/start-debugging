---
title: "Flutter の Riverpod Notifier と AsyncNotifier と StreamNotifier: どれを継承すべきか"
description: "選択は build() の戻り値の型で決まります。T なら Notifier、FutureOr<T> なら AsyncNotifier、Stream<T> なら StreamNotifier です。判断のための比較表、その理由となる型階層、そして == によるフィルタリングと状態の上書きという落とし穴を解説します。flutter_riverpod 3.4.2 と Flutter 3.44.2 で検証済みです。"
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ja"
translationOf: "2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-15
---

`Notifier`、`AsyncNotifier`、`StreamNotifier` の選択は、たった一つのことで決まります。`build()` メソッドの戻り値の型です。`T` を返すなら `Notifier<T>` を継承します。`Future<T>` を返す場合、あるいは後で非同期にしたくなりそうな素の `T` を返す場合は `AsyncNotifier<T>` を継承します。データソースが最初の値の後も値を送り続けるなら `StreamNotifier<T>` を継承します。それ以外 (ミューテーション用のメソッド、`build` 内での `ref.watch`、family、自動破棄) は 3 つすべてで同一に動作します。本記事の内容はすべて `flutter_riverpod` 3.4.2、Flutter 3.44.2 (stable、2026-06-10)、Dart 3.12.2 で検証しており、コード生成のセクションでは `riverpod_generator` 4.0.4 を使用しています。

## 判断のための比較表

| | `Notifier<T>` | `AsyncNotifier<T>` | `StreamNotifier<T>` |
| --- | --- | --- | --- |
| `build()` の戻り値 | `T` | `FutureOr<T>` | `Stream<T>` |
| プロバイダーが公開する型 | `T` | `AsyncValue<T>` | `AsyncValue<T>` |
| プロバイダーのクラス | `NotifierProvider` | `AsyncNotifierProvider` | `StreamNotifierProvider` |
| ローディング状態 | 一切なし | 最初に `AsyncLoading` | 最初に `AsyncLoading` |
| 2 番目以降の値 | 自分で書き込む | 自分で書き込む | ストリームが書き込む |
| `.future` 修飾子 | なし | あり | あり |
| `update()` ヘルパー | なし | あり | あり |
| `updateShouldNotify` のシグネチャ | `(T, T)` | `(AsyncValue<T>, AsyncValue<T>)` | `(AsyncValue<T>, AsyncValue<T>)` |
| 置き換える対象 (Riverpod 2.x) | `StateNotifier`、`StateProvider` | `FutureProvider` + メソッド | `StreamProvider` + メソッド |

つまずきやすいのは最後の行です。`AsyncNotifier` は、上位集合という意味での「`Notifier` の非同期版」ではありません。ミューテーション用のメソッドを置ける場所を備えた `FutureProvider` です。`StreamNotifier` も同じ性質を備えた `StreamProvider` です。ミューテーション用のメソッドが不要なら、素の `FutureProvider` や `StreamProvider` のほうが小さな答えのままです。

## なぜ戻り値の型がすべてなのか

これはスタイル上の慣習ではありません。`riverpod` 3.4.2 のクラス階層によって強制されています。3 つの公開クラスはいずれも、固定された戻り値の型を持つ抽象 `build()` を宣言しています。

```dart
// package:riverpod/src/providers/notifier/orphan.dart, riverpod 3.4.2
abstract class Notifier<ValueT> extends $Notifier<ValueT> {
  @visibleForOverriding
  ValueT build();
}

// package:riverpod/src/providers/async_notifier/orphan.dart
abstract class AsyncNotifier<StateT> extends $AsyncNotifier<StateT> {
  @visibleForOverriding
  FutureOr<StateT> build();
}

// package:riverpod/src/providers/stream_notifier/orphan.dart
abstract class StreamNotifier<ValueT> extends $StreamNotifier<ValueT> {
  @visibleForOverriding
  Stream<ValueT> build();
}
```

選択を誤ると、ランタイムでの意外な挙動ではなくコンパイルエラーになります。以下は Flutter 3.44.2 での `flutter analyze` の正確な診断です。

```text
error - 'WrongOne.build' ('Future<int> Function()') isn't a valid override of
        'Notifier.build' ('int Function()') - invalid_override

error - 'WrongTwo.build' ('Stream<int> Function()') isn't a valid override of
        'AsyncNotifier.build' ('FutureOr<int> Function()') - invalid_override

error - 'Ok' doesn't conform to the bound 'AsyncNotifier<int>' of the type
        parameter 'NotifierT' - type_argument_not_matching_bounds
```

3 つ目は組み合わせ違いのエラーです。`Notifier` のサブクラスを `AsyncNotifierProvider` に渡した場合に出ます。notifier のクラスとプロバイダーのクラスはジェネリックの境界で結び付いているため、混ぜることはできません。

## Notifier を選ぶとき

初期状態が同期的に得られ、自分のメソッド以外がそれを変更しない場合は `Notifier<T>` を選びます。

```dart
// flutter_riverpod 3.4.2, Flutter 3.44.2, Dart 3.12.2
class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new);
```

`ref.watch(counterProvider)` は `AsyncValue<int>` ではなく `int` を返します。描画すべきローディング分岐もエラー分岐も存在せず、それこそが要点です。フィルターの選択、フォームの変更済みフラグ、選択中のタブのインデックス、メモリ上のショッピングカートなどが該当します。すでに手元にある値を `AsyncData(...)` で包んでいることに気づいたら、基底クラスの選択を誤っています。

`StateNotifier` から移ってきた人が驚く点が一つあります。`build()` は再実行されうるということです。`build()` の中で別のプロバイダーを `ref.watch` していると、上流の変更で `build()` が再実行され、状態がリセットされます。notifier のインスタンス自体は保持されるので、インスタンスのフィールドは生き残ります。

```dart
// Verified: constructed once, built twice after the dependency changed.
expect(Instanced.built, 2);        // build() re-ran
expect(Instanced.constructed, 1);  // the object was not recreated
```

## AsyncNotifier を選ぶとき

初期状態が `Future` から来て、その後のすべての値が自分のミューテーション用メソッドから来る場合は `AsyncNotifier<T>` を選びます。

```dart
// flutter_riverpod 3.4.2
class AsyncCounter extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    return 0;
  }

  Future<void> increment() async {
    final current = await future;      // resolves to the latest non-loading value
    state = AsyncData(current + 1);
  }
}

final asyncCounterProvider =
    AsyncNotifierProvider<AsyncCounter, int>(AsyncCounter.new);
```

notifier 内の `future` ゲッターと、プロバイダー側の `.future` 修飾子は、どちらも `$AsyncClassModifier` ミックスインに由来します。`update()` も同じで、これは上記の read-modify-write を簡潔に書いたものです。

```dart
Future<void> increment() => update((current) => current + 1);
```

最初のフレームでウィジェットが何を描画するかが変わるため、知っておく価値のある詳細が一つあります。`build()` は `FutureOr<T>` を返すので、同期的に値を返すことも正当であり、その場合プロバイダーは `AsyncLoading` を一度も通りません。

```dart
class SyncishAsync extends AsyncNotifier<int> {
  @override
  int build() => 42;   // legal: FutureOr<int> accepts int
}

// Verified: the very first read is AsyncData(42), not AsyncLoading.
expect(container.read(syncishProvider), isA<AsyncData<int>>());
```

そのため `AsyncNotifier` は、今は同期的だが将来ネットワーク呼び出しの背後に移す見込みがある状態に対して妥当な既定の選択になります。その代償として、すべてのウィジェットで開かなければならない `AsyncValue` のラッパーが付いてきます。タブのインデックスにこれを使わない理由もそこにあります。そのラッパーをきれいに描画する仕組みは、[AsyncValue でローディングとエラーの状態を表示する](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)で扱ったものと同じです。

## StreamNotifier を選ぶとき

ソースが値を送り続ける場合は `StreamNotifier<T>` を選びます。Firestore のスナップショットリスナー、WebSocket、プラグインからの `Stream`、周期タイマーなどです。

```dart
// flutter_riverpod 3.4.2
class Ticker extends StreamNotifier<int> {
  @override
  Stream<int> build() {
    final controller = StreamController<int>();
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 5), (_) {
      controller.add(i++);
    });
    ref.onDispose(() {
      timer.cancel();
      controller.close();
    });
    return controller.stream;
  }
}

final tickerProvider = StreamNotifierProvider<Ticker, int>(Ticker.new);
```

決定的な違いは、自分で `state` に書き込まなくても状態が変わり続けることです。このプロバイダーを購読して発行値を集めると `[0, 1, 2, ...]` が得られますが、`AsyncNotifier` ならちょうど 1 回 `AsyncData` を出して止まっていたはずです。

購読は Riverpod が管理します。監視している依存が変わって `build()` が再実行されるとき、新しいストリームを購読する前に以前の購読がキャンセルされます。

```dart
// Verified with a StreamController whose onCancel increments a counter.
expect(Feed.subscribes, 2);  // build re-ran, new stream
expect(Feed.cancels, 1);     // Riverpod cancelled the old subscription
```

それでも、`Timer` のようにストリーム自体が所有していないリソースには上記の `ref.onDispose` が必要です。Riverpod がキャンセルするのは自分がストリームに張った購読だけで、そのストリームに値を供給しているタイマーのことは知りません。これは[Flutter でメモリリークを避けるためにコントローラーを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)のと同じ規律です。

## AsyncNotifier と StreamNotifier は兄弟であって親子ではない

`StreamNotifier` の dartdoc はこれを「`AsyncNotifier` のバリアント」と呼んでおり、継承関係のように読めます。しかし継承ではありません。どちらも同じ内部の基底クラスを継承し、違うのはジェネリック引数 1 つだけです。

```dart
// package:riverpod/src/providers/async_notifier.dart, riverpod 3.4.2
abstract class $AsyncNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, FutureOr<ValueT>> {}

// package:riverpod/src/providers/stream_notifier.dart
abstract class $StreamNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, Stream<ValueT>> {}
```

`$AsyncNotifierBase<ValueT>` はどちらの場合も `AnyNotifier<AsyncValue<ValueT>, ValueT>` を継承しており、だからこそ両者とも `AsyncValue<T>` を公開し、両者とも `future` と `update()` を得ます。唯一の違いは `CreatedT` で、`FutureOr<ValueT>` か `Stream<ValueT>` かです。一方 `$Notifier<StateT>` は `$SyncNotifierBase<StateT>` を継承し、それが `AnyNotifier<StateT, StateT>` を継承しているため、状態の型と値の型が同一になります。

実務上の帰結として、`AsyncNotifier` に対する型チェックは `StreamNotifier` にマッチしません。`if (notifier is AsyncNotifier)` と書いた汎用のヘルパーコードは、ストリーム由来のプロバイダーを黙って読み飛ばします。

```dart
// Verified on riverpod 3.4.2
expect(Ticker(), isNot(isA<AsyncNotifier<int>>()));
expect(AsyncCounter(), isNot(isA<StreamNotifier<int>>()));
```

## == によるフィルタリングは 3 つすべてに影響する

Riverpod 3.0 では、リスナーに通知するかどうかの判定が `==` に統一されました。多くの解説はこれを `Notifier` の問題として扱います。典型的な症状が、`List` をその場で変更しても再ビルドが起きないことだからです。しかしこれは `Notifier` の問題ではありません。`AsyncValue.operator ==` が包んでいる値を `==` で比較するため、`AsyncNotifier` にも `StreamNotifier` にも当てはまります。

```dart
// package:riverpod/src/core/async_value.dart, riverpod 3.4.2
@override
bool operator ==(Object other) {
  return runtimeType == other.runtimeType &&
      other is AsyncValue<ValueT> &&
      other._loading == _loading &&
      other.valueFilled == valueFilled &&
      other._errorFilled == _errorFilled;
}
```

したがって、同一の `List` インスタンスを新しい `AsyncData` で包み直すと、直前の状態と `==` になる値ができあがり、通知は破棄されます。

```dart
// Verified: both of these are silent no-ops for listeners.
class AsyncTodoList extends AsyncNotifier<List<String>> {
  @override
  List<String> build() => <String>[];

  void addMutating(String v) {
    final list = state.requireValue..add(v);
    state = AsyncData(list);            // same list instance, == is true
  }

  void addReplacing(String v) =>
      state = AsyncData([...state.requireValue, v]);   // new list, notifies
}

final list = ['x'];
expect(AsyncData(list) == AsyncData(list), isTrue);
expect(AsyncData(['x']) == AsyncData(['x']), isFalse);
```

対処法は 3 つのクラスで同じです。変更して再代入するのではなく、常に新しいコレクションのインスタンスを代入してください。逃げ道も同じですが、`updateShouldNotify` は値の型ではなく*状態*の型を受け取るため、基底クラスによってシグネチャが変わる点に注意してください。

```dart
// Notifier<List<String>>
@override
bool updateShouldNotify(List<String> previous, List<String> next) => true;

// AsyncNotifier<List<String>> or StreamNotifier<List<String>>
@override
bool updateShouldNotify(
  AsyncValue<List<String>> previous,
  AsyncValue<List<String>> next,
) => true;
```

ストリームが原因不明で UI を更新しなくなったためにこの記事にたどり着いたなら、同じ根本原因を[Riverpod 3.0 で StreamProvider のイベントが等価性でフィルタされる](/ja/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/)でより詳しく扱っています。

## StreamNotifier の落とし穴: 書き込みが上書きされる

`StreamNotifier` は `state` のセッターを継承しているので、代入を止めるものは何もありません。しかしストリームはまだ生きており、次のイベントが勝ちます。

```dart
// Verified against a StreamNotifier whose build() emits every 5ms.
container.read(tickerProvider.notifier).poke();       // state = AsyncData(999)
expect(container.read(tickerProvider).value, 999);    // holds, briefly

await Future<void>.delayed(const Duration(milliseconds: 20));
expect(container.read(tickerProvider).value, isNot(999));  // the stream won
```

これはバグではありませんし、`StreamNotifier` でミューテーション用のメソッドを避ける理由にもなりません。ミューテーションを楽観的に行い、ストリームに確定させる理由になります。UI の即時応答のために `state` に書き込み、変更をバックエンドに送り、返ってきたストリームのイベントを信頼できる情報源にします。

```dart
// flutter_riverpod 3.4.2
Future<void> send(String message) async {
  state = AsyncData([...(state.value ?? const []), message]);  // optimistic
  await _api.post(message);   // the server echoes this back down the stream
}
```

ストリームがミューテーションを返してこないなら、その問題はストリームの形をしていません。`AsyncNotifier` を使い、状態は自分で持ってください。

## コード生成が選択を代行する

`riverpod_generator` を使うなら、基底クラスの名前を書くことはありません。`@riverpod` を付け、生成された `_$Foo` を継承すれば、ジェネレーターが `build()` の戻り値の型を読み取ります。以下は戻り値の型だけが異なる 3 つのクラスと、`riverpod_generator` 4.0.4 が生成した対応する宣言です。

```dart
// gen.dart
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;
}

@riverpod
class AsyncCounter extends _$AsyncCounter {
  @override
  Future<int> build() async => 0;
}

@riverpod
class Ticker extends _$Ticker {
  @override
  Stream<int> build() => Stream.value(0);
}
```

```dart
// gen.g.dart, generated
final class CounterProvider extends $NotifierProvider<Counter, int> { ... }
abstract class _$Counter extends $Notifier<int> { ... }

final class AsyncCounterProvider
    extends $AsyncNotifierProvider<AsyncCounter, int> { ... }
abstract class _$AsyncCounter extends $AsyncNotifier<int> { ... }

final class TickerProvider extends $StreamNotifierProvider<Ticker, int> { ... }
abstract class _$Ticker extends $StreamNotifier<int> { ... }
```

`Future<int> build()` を `Stream<int> build()` に変えてビルダーを再実行すれば、他に一切手を加えなくても基底クラスが入れ替わります。この論点に関しては、これがコード生成を選ぶ最も強い実務上の理由です。

生成された出力が可視化してくれる非対称性が一つあります。生成されたプロバイダーは自動破棄され、手書きのものはされません。

```dart
// gen.g.dart: every generated provider passes isAutoDispose: true
CounterProvider._() : super(..., isAutoDispose: true, ...);

// Hand-written, verified on riverpod 3.4.2:
expect(counterProvider.isAutoDispose, isFalse);
expect(asyncCounterProvider.isAutoDispose, isFalse);
expect(tickerProvider.isAutoDispose, isFalse);
```

`StreamNotifier` にとってこの差は高くつきます。手書きのストリームプロバイダーは、何かが一度読み取ったら購読を永遠に開いたままにします。`NotifierProvider`、`AsyncNotifierProvider`、`StreamNotifierProvider` はいずれも `isAutoDispose` の既定値が `false` だからです。生成せずに生成時と同じ挙動が欲しいなら `NotifierProvider(..., isAutoDispose: true)` を渡してください。

## バージョンに関する注意点

Flutter 3.44.2 では、現時点で最新のパッケージ同士が一緒には解決できません。`flutter_riverpod` 3.4.2 と `riverpod_generator` のいずれのバージョンの組み合わせも、この Flutter SDK が `flutter_test` 経由で固定している `matcher` 0.12.19 と `test_api` 0.7.11 に対してバージョン解決に失敗します。きれいに解決できる組み合わせは `flutter_riverpod` 3.3.2 と `riverpod_annotation` 4.0.3、`riverpod_generator` 4.0.4 で、上記の生成結果はこの組み合わせから得たものです。クラス選択のルールは 3.3.2 と 3.4.2 で何も変わりませんが、コード生成を使うなら、SDK の制約が追いつくまではランタイム側のパッケージより 1 マイナーバージョン遅れることを見込んでおいてください。

## 推奨

I/O に触れるものは既定で `AsyncNotifier`、触れないものは `Notifier`、そして本当にソースが複数の値を送ってくる場合だけ `StreamNotifier` にしてください。`Notifier` で足りるところに `AsyncNotifier` を選んだ場合の失敗は、ウィジェット側で `AsyncValue` を開くノイズが少し増える程度です。データが非同期なのに `Notifier` を選んだ場合の失敗は、`late` フィールドと `LateInitializationError` と手書きのローディング用の真偽値であり、こちらのほうが明確に悪い結果です。そしてコード生成を使っているなら、この問題は考えるのをやめてください。書きたい `build()` をそのまま書き、選択はジェネレーターに任せればよいのです。

## 関連記事

- [インストールすべき Riverpod のパッケージ: riverpod、flutter_riverpod、hooks_riverpod](/ja/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [FutureBuilder と StreamBuilder を Riverpod の AsyncValue と比較する](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod 2.x から 3.0 への完全な移行ガイド](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [setState を使う StatefulWidget を Riverpod の Notifier に移す](/ja/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [FutureBuilder を Riverpod の AsyncNotifier に置き換える](/ja/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## 参考資料

- [Riverpod 3.0 の新機能](https://riverpod.dev/docs/whats_new)、notifier クラスの統合と、通知フィルタリングの `==` への移行について。
- [pub.dev の riverpod 3.4.2](https://pub.dev/packages/riverpod/versions/3.4.2)、上記で引用した `Notifier`、`AsyncNotifier`、`StreamNotifier` の宣言の出典。
- [pub.dev の flutter_riverpod 3.4.2](https://pub.dev/packages/flutter_riverpod/versions/3.4.2)。
- [pub.dev の riverpod_generator 4.0.4](https://pub.dev/packages/riverpod_generator/versions/4.0.4)、コード生成のセクションで出力を示したジェネレーター。
