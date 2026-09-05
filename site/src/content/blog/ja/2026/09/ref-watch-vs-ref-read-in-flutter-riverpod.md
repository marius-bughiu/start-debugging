---
title: "Riverpod の ref.watch と ref.read の違いと、それぞれをいつ使うか"
description: "ref.watch は購読して再ビルドし、ref.read は一度読むだけで再ビルドしません。watch はすべての build メソッドの中で、read はイベントのコールバックの中だけで使います。判断マトリクス、flutter_riverpod 3.4.3 における両メソッドのソースコード、そして 4 つの静かな失敗パターン (コールバック内の watch、プロバイダー本体での read、autoDispose なプロバイダーへの read、最適化のつもりの read) を解説します。"
pubDate: 2026-09-05
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ja"
translationOf: "2026/09/ref-watch-vs-ref-read-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-09-05
---

`ref.watch` は購読を登録し、`ref.read` は登録しません。この 1 点の違いがそれ以外のすべてを決めます。`ref.watch` は `build` メソッドの中で使ってください。`ConsumerWidget` の `build` でも、プロバイダーや `Notifier` の `build` でも同じです。そして `ref.read` は、イベントに反応して一度だけ実行されるコードの中で使ってください。`onPressed`、`onTap`、`Timer` のコールバック、`Notifier` の更新メソッドなどです。この選択はパフォーマンスのトレードオフではなく、呼び出し位置のルールです。状態が変わったときに再実行されるコードは watch を、ちょうど一度だけ実行されるコードは read を使います。以下の内容はすべて、Flutter 3.47.2 stable と Dart 3.13.2 の上で `riverpod` および `flutter_riverpod` 3.4.3 (2026-09-03 公開)、さらに `riverpod_lint` 3.1.9 に対して検証しています。

## 判断マトリクス

| | `ref.watch` | `ref.read` |
| --- | --- | --- |
| 購読を登録する | する | しない |
| 値が変わったとき呼び出し元を再ビルドする | する | 決してしない |
| `autoDispose` なプロバイダーを生かし続ける | する | しない |
| `build` の中で正しい | はい、ここが唯一の場所です | ほぼ常にバグです |
| `onPressed` / `onTap` / タイマーの中で正しい | いいえ | はい、ここが唯一の場所です |
| `initState` の中で正しい | いいえ | はい、一度だけの初期値設定なら |
| `Notifier` の更新メソッドの中で正しい | いいえ | はい |
| ウィジェットが画面外だと一時停止される (Riverpod 3 の `TickerMode`) | される | 該当なし |
| 通知が `==` でフィルタされる | される | 該当なし |
| 誤った場所で呼ぶとエラーになる | いいえ、静かに失敗します | いいえ |
| 再ビルドを減らすための道具 | `.select` | これではありません |

デバッグ時間を最も奪うのは最後の 2 行です。どちらのメソッドにも実行時のガードはなく、`ref.read` は再ビルドを減らす手段ではありません。

## 2 つのメソッドは 2 つの別々のクラスにあります

Riverpod は `watch` と `read` を、互いに関係のない 2 つの型の上に二重に用意しており、実装は実際に異なります。

`WidgetRef` は `ConsumerWidget`、`Consumer` の builder、または `ConsumerState` が渡してくるものです。その実装は `ConsumerStatefulElement` にあります。

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> target) {
  _assertNotDisposed();
  return _dependencies
          .putIfAbsent(target, () {
            final oldDependency = _oldDependencies?.remove(target);
            if (oldDependency != null) {
              return oldDependency;
            }
            final sub = container.listen<StateT>(
              target,
              (_, _) => markNeedsBuild(),
            );
            _applyTickerMode(sub);
            return sub;
          })
          .readSafe()
          .valueOrProviderException
      as StateT;
}

@override
StateT read<StateT>(ProviderListenable<StateT> provider) {
  _assertNotDisposed();
  return ProviderScope.containerOf(this, listen: false).read(provider);
}
```

`watch` は element ごとの `_dependencies` マップに `ProviderSubscription` を格納し、そのリスナーは `markNeedsBuild()` を呼びます。`read` は `listen: false` で `ProviderContainer` に到達し、そこで `read` を呼びます。マップへの登録もリスナーも再ビルドも、一切ありません。

`Ref` はプロバイダー本体や `Notifier` が受け取るものです。名前は同じですが仕組みが違います。

```dart
// package:riverpod/src/core/ref.dart, riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  late ProviderSubscription<StateT> sub;
  sub = _element.listen<StateT>(
    listenable,
    (prev, value) => _invalidateSelf(asReload: true, manual: false),
    onError: (err, stack) => _invalidateSelf(asReload: true, manual: false),
    onDependencyMayHaveChanged: _element._markDependencyMayHaveChanged,
  );
  return sub.readSafe().valueOrProviderException;
}

@override
StateT read<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  final result = container.read(listenable);
  if (kDebugMode) _debugAssertCanDependOn(listenable);
  return result;
}
```

プロバイダー側では、`watch` は `listen` に `invalidateSelf` を加えたものです。これは公式ドキュメントが `Ref.watch` のドキュメントコメントで明示しています。`read` は単なるコンテナからの読み取りです。パターンは両方のクラスで同じで、watch はグラフの辺を作り、read は作りません。

## ルールはプロバイダーではなく呼び出し位置についてのものです

自分に 1 つ質問してください。この行は、値が変わったときにもう一度実行される必要がありますか。

- `build` の中なら、はい。`build` の存在意義は Riverpod がそれを再度呼べることにあります。`ref.watch` を使ってください。
- `onPressed` の中なら、いいえ。利用者がもう一度ボタンを押せば、コールバックは新しい値でもう一度実行されます。`ref.read` を使ってください。

公式ドキュメントは、どちらが既定なのかについてはっきりしています。Riverpod の refs のページより: "Do not use Ref.read as a mean to 'optimize' your code by avoiding Ref.watch. This will make your code more brittle." そして 3.4.3 の `Ref.read` 自身のドキュメントコメントより: "If possible, avoid using [read] and prefer [watch], which is generally safer to use."

次の形は Riverpod 2.0 以降のすべてのバージョンで正しい書き方です。

```dart
// flutter_riverpod 3.4.3, Flutter 3.47.2, Dart 3.13.2
final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Rerun this line on every change: watch.
    final count = ref.watch(counterProvider);

    return Column(
      children: [
        Text('$count'),
        ElevatedButton(
          // Runs once per tap: read.
          onPressed: () => ref.read(counterProvider.notifier).increment(),
          child: const Text('increment'),
        ),
      ],
    );
  }
}
```

## コールバック内の `ref.watch` はエラーにならず、それこそが問題です

`ref.watch(counterProvider)` を `onPressed` のクロージャに移しても、アプリはコンパイルされ、アナライザーは黙ったままで、返る値も正しいままです。`riverpod_lint` 3.1.9 のどのルールもこれを指摘しません。ルール一覧は `missing_provider_scope`、`provider_dependencies`、`scoped_providers_should_specify_dependencies`、`avoid_build_context_in_providers`、`provider_parameters`、`avoid_public_notifier_properties`、`unsupported_provider_value`、`functional_ref`、`notifier_extends`、`avoid_ref_inside_state_dispose`、`avoid_keep_alive_dependency_inside_auto_dispose`、`notifier_build`、`riverpod_syntax_error`、`async_value_nullable_pattern`、`protected_notifier_properties` です。「build の外での watch」というルールはありません。

実際に起きることはクラッシュより厄介です。もう一度 `ConsumerStatefulElement.build` を見てください。

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
Widget build() {
  if (_tickerModeNotifier == null) {
    _updateTickerModeNotifier();
  }
  try {
    _oldDependencies = _dependencies;
    for (var i = 0; i < _listeners.length; i++) {
      _listeners[i].close();
    }
    _listeners.clear();
    _dependencies = {};
    return super.build();
  } finally {
    for (final dep in _oldDependencies!.values) {
      dep.close();
    }
    _oldDependencies = null;
  }
}
```

ビルドのたびに `_dependencies` は新しいマップに差し替えられ、前回から残っていたものは閉じられます。`onPressed` から呼ばれた `ref.watch` は `_oldDependencies` が `null` の状態で実行されるため、生きている `_dependencies` マップにまったく新しい購読を差し込みます。その瞬間から次の再ビルドまで、ウィジェットは自身の `build` メソッドが一度も言及していないプロバイダーを購読した状態になります。その間にプロバイダーが変化すると `markNeedsBuild` が走ってウィジェットが再ビルドされます。そして再ビルドがその購読を破棄します。`build` が登録し直さないからです。結果として 2 回目の変化は何も起こしません。

これはフレームのタイミングに依存する 1 回限りのリアクティビティです。遅い端末でしか再現しない、まさにその種のバグです。

自分でガードしている `ref.listen` との対比に注目してください。

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
void listen<StateT>(
  ProviderListenable<StateT> provider,
  void Function(StateT? previous, StateT value) listener, {
  void Function(Object error, StackTrace stackTrace)? onError,
  bool weak = false,
}) {
  _assertNotDisposed();
  assert(
    debugDoingBuild,
    'ref.listen can only be used within the build method of a ConsumerWidget',
  );
  ...
}
```

`listen` はデバッグビルドで assert します。`watch` はしません。assert がないことを許可と読み替えないでください。

## プロバイダー本体での `ref.read` は依存関係を永久に凍らせます

プロバイダー側での同じ間違いはもっと静かです。再ビルドされないことが目に見えるウィジェットが存在しないからです。

```dart
// riverpod 3.4.3, WRONG
final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

final greetingProvider = Provider<String>((ref) {
  // No graph edge. This provider will never be recomputed when the locale changes.
  final locale = ref.read(localeProvider);
  return locale.languageCode == 'fr' ? 'Bonjour' : 'Hello';
});
```

`greetingProvider` は一度だけ計算し、その結果をキャッシュします。ロケールを変えると `localeProvider` とそれを監視しているすべてのウィジェットは再ビルドされますが、`greetingProvider` は他の何かが無効化するまで古い文字列を抱えたままです。`ref.watch(localeProvider)` に替えれば辺ができます。`Ref.watch` は変化のたびに `_invalidateSelf(asReload: true)` を呼ぶので、`greetingProvider` は必要に応じて再計算されます。

同じことが `Notifier` の中にも当てはまります。3.4.3 の `Notifier.build` のドキュメントコメントはこう書いています: "It is safe to use [Ref.watch] or [Ref.listen] inside this method." `build` では watch を、`increment()` や `submit()` では read を使ってください。

## `autoDispose` なプロバイダーへの `ref.read` は仕事を捨てます

「状態がゼロに戻る」という題名のバグ報告を生むのがこれです。

自動破棄はリスナーで追跡されており、読み取りでは追跡されません。コード生成では `@riverpod` の既定が `keepAlive: false` なので、明示的に指定しない限り生成されたプロバイダーはすべて自動破棄されます。

```dart
// riverpod_annotation 3.x
final class Riverpod {
  const Riverpod({
    this.keepAlive = false,
    ...
  });
}
```

手書きのプロバイダーは逆です。`riverpod` 3.4.3 の `NotifierProvider` と `Provider` はどちらも `super.isAutoDispose = false` を宣言しているので既定では生き続け、`NotifierProvider.autoDispose` または `isAutoDispose: true` で自動破棄を有効にします。

では、画面上の何も監視していない、生成された自動破棄のカウンターを考えてみましょう。

```dart
// riverpod_generator 4.x, riverpod 3.4.3
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

// In a widget that does NOT watch counterProvider anywhere:
onPressed: () {
  ref.read(counterProvider.notifier).increment(); // state becomes 1
},
```

`ref.read` はプロバイダーを生成し、`build()` を実行し、notifier を返しますが、リスナーは 1 つも追加しません。破棄についてのドキュメントがそのタイミングを説明しています。リスナー数がゼロになるとプロバイダーは "not used" と見なされ、Riverpod は "waits for one frame" し、それでも使われていなければプロバイダーは破棄されます。つまりインクリメントは、1 フレーム後に取り壊される `Counter` に着地します。次のタップはまた `0` から始まります。

修正はコールバックを `ref.watch` にすることではありません。何かが正当にそのプロバイダーを監視するようにすること、普通はカウントを表示するウィジェットがそれです。あるいは状態が本当にリスナーより長生きする必要があるなら `build` の中で `ref.keepAlive()` を呼ぶことです。

## 値は watch し、notifier は read する

`ref.read(counterProvider.notifier)` が更新メソッドに到達する定石であり、`Notifier` のドキュメントコメントにそのまま載っています。`ref.watch(counterProvider.notifier)` は罪ではありませんが無意味です。Riverpod は 3.x ですべての通知を `==` でフィルタしており、`Notifier` のドキュメントコメントは `build` が再実行されても "the [Notifier] will **not** be recreated. Its instance will be preserved between executions of [build]." と述べています。同じインスタンスは自分自身と等しいので、`.notifier` を watch してもほとんど通知は起きません。通知が起きるのはプロバイダーが完全に破棄されて作り直されたときだけです。頼んでもいない自動破棄の抑止だけが付いてくる、何の得もない購読を抱えることになります。

つまり、値には `ref.watch(provider)`、メソッドには `ref.read(provider.notifier)` です。

## `initState` はどちらも求めていません

`ConsumerState` では `initState` は最初の `build` より前に走ります。そこでの `ref.watch` はエラーになりませんが、作られた購読は最初のビルドで破棄されます。ただし `build` がたまたま同じプロバイダーを watch していれば残るので、挙動が偶然に左右されます。`ref.listen` は `debugDoingBuild` の assert を投げます。サポートされている API は `listenManual` です。

```dart
// flutter_riverpod 3.4.3
class _FormState extends ConsumerState<MyForm> {
  late final ProviderSubscription<AsyncValue<void>> _sub;

  @override
  void initState() {
    super.initState();
    // Seed a controller once: read is correct here.
    _controller.text = ref.read(draftProvider);

    // Subscribe outside build: listenManual is correct here.
    _sub = ref.listenManual(submitProvider, (previous, next) {
      next.whenOrNull(error: (e, _) => showErrorBar(context, e));
    });
  }
}
```

`listenManual` は `initState` で安全に使えるよう、意図的に `listen: false` でコンテナを読みます。そして `ConsumerStatefulElement.unmount` は `State.dispose` の実行後に手動リスナーを閉じます。自分で閉じる必要はありませんが、返された購読で閉じることもできます。

`State` のライフサイクルのコードにいるついでに、もう一方の端も思い出してください。`dispose` の中で `ref` に触れるとエラーになり、`riverpod_lint` の `avoid_ref_inside_state_dispose` はまさにそのためにあります。3.4.3 でのメッセージは `Using "ref" when a widget is about to or has been unmounted is unsafe.` で、これは古い [Cannot use "ref" after the widget was disposed エラー](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)の現在の文言です。

## Riverpod 3 は watch の購読を一時停止するので、read を選ぶ最後の理由も消えます

「read のほうが安い」という言い伝えは Riverpod 3 より前のものです。3.x では `WidgetRef.watch` が作る購読が `TickerMode` に参加します。

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
void _updateTickerMode() {
  final isActive = _tickerModeNotifier!.value;
  if (isActive != _isActive) {
    _isActive = isActive;
    for (final sub in _dependencies.values) {
      if (isActive) {
        sub.resume();
      } else {
        sub.pause();
      }
    }
  }
}
```

ウィジェットが画面外に出ると、`TabBarView` の非アクティブなタブの中や、上に積まれたルートの下などで、その watch の購読はすべて一時停止され、背後のプロバイダーは仕事を止めます。`ref.read` に切り替えても同等の節約は得られません。`ref.read` にはそもそも一時停止できる購読がないからです。watch の実行時コストは `HashMap` のエントリ 1 つとリスナーのコールバック 1 つであり、フレーム予算を圧迫している正体はそこではありません。

本当に再ビルドを減らしたいなら、道具は `read` ではなく `.select` です。

```dart
// flutter_riverpod 3.4.3
// Rebuilds on every user field change:
final user = ref.watch(userProvider);
Text(user.name);

// Rebuilds only when the name changes, because select's output is compared with ==:
final name = ref.watch(userProvider.select((u) => u.name));
Text(name);
```

`select` は購読を保ちます。つまりリアクティビティも生存維持も保ったまま、何を変化と見なすかだけを絞り込みます。それが最適化です。`ref.read` は最適化ではなく、機能の削除です。

なお `==` によるフィルタは Riverpod 3.0 では全体に効き、`watch` にも `select` にも `listen` にも同じように適用されます。状態クラスが等価性を実装していない場合、これ自体が別種の落とし穴になります。期待した watch が発火しないときは、呼び出し位置を疑う前に `==` を確認してください。[Riverpod 3.0 で StreamProvider がイベントを取りこぼす](/ja/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/)のと同じ仕組みです。

## 実際に何を書くか

既定は `ref.watch` です。`ref.read` を使うのはちょうど 3 か所です。イベントのコールバック、`Notifier` の更新メソッド、そしてサービスが再生成されずに現在の値を取得できるよう、あえて素のサービスクラスに保持した `Ref` です。最後のものは `Ref.read` 自身のドキュメントが示しているユースケースです。それ以外はすべて watch です。何かの再ビルドを止めるために watch を read に置き換えているなら、それは `select` の出番か、粒度が粗すぎるプロバイダーを見つけたということであって、グラフから辺を切り落とす理由ではありません。

そして `ref.watch` がコールバックに属するように見えるなら、おそらく欲しいのは `build` の中の `ref.listen` (ウィジェットが生きている間の副作用) か、`initState` の中の `ref.listenManual` (`State` に紐づいた副作用) です。

## 関連記事

- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/ja/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)
- [Riverpod 3 で非同期ギャップの後に ref.mounted を確認する](/ja/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [どの Riverpod パッケージを入れるか: riverpod、flutter_riverpod、hooks_riverpod](/ja/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [AsyncValue でローディングとエラーの状態を表示する](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Riverpod 2.x から 3.0 への完全な移行ガイド](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## 参考資料

- [Refs](https://riverpod.dev/docs/concepts2/refs)、`Ref.watch`、`Ref.read`、`Ref.listen` の公式ページ。
- [Automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)、1 フレームの猶予とリスナー数による追跡について。
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)、`==` によるフィルタと `TickerMode` に基づく一時停止について。
- [pub.dev の flutter_riverpod 3.4.3](https://pub.dev/packages/flutter_riverpod/versions/3.4.3)、上で引用した `ConsumerStatefulElement` の出典。
- [pub.dev の riverpod 3.4.3](https://pub.dev/packages/riverpod/versions/3.4.3)、上で引用した `Ref.watch` と `Ref.read` の出典。
- [pub.dev の riverpod_lint 3.1.9](https://pub.dev/packages/riverpod_lint)、本文で参照したルールの完全な一覧。
