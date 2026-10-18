---
title: "rxdart の BehaviorSubject なしで Dart Stream の最新値を後から購読するリスナーに再送する方法"
description: "broadcast の StreamController は、購読する前に発行されたイベントをすべて破棄します。ここでは、Stream.multi で作る依存関係なしの BehaviorSubject 代替、既存のストリームに使える replayLatest() 拡張、イベントを黙って取りこぼす async* の近道、StreamBuilder の initialData の注意点を、すべて Dart 3.12.2 で検証して紹介します。"
pubDate: 2026-10-18
template: how-to
tags:
  - "dart"
  - "flutter"
  - "streams"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart"
translatedBy: "claude"
translationDate: 2026-10-18
---

**結論:** `StreamController.broadcast()` を小さなクラスで包んで最後の値も保持し、ストリームは `Stream.multi` 経由で公開します。`Stream.multi` は購読者ごとに、その購読者専用の `MultiStreamController` を渡して `onListen` コールバックを一度ずつ呼び出します。そのため、キャッシュした値を新しいリスナーにだけ `add` し、その後 broadcast のイベントを転送できます。これで rxdart の `BehaviorSubject` と同じ動作が、`dart:async` だけの約 40 行で実現できます。`Stream.multi` は Dart 2.9 から SDK に含まれており、以下のコードはすべて Dart 3.12.2 (Flutter 3.44 に同梱される SDK) で実行しました。

この記事の残りでは、通常の broadcast コントローラーが失敗する理由、完成したクラス、既存のストリームを再送型に変える拡張、そして Flutter アプリで問題になるエッジケース (エラー、`close()`、一時停止、キャンセル、`StreamBuilder` の最初のフレーム) を説明します。

## broadcast ストリームがすべてを忘れる理由

single-subscription の `StreamController` は、誰かが購読するまでイベントをバッファリングしますが、リスナーは 1 つだけです。broadcast コントローラーは任意の数のリスナーを許可する代わりに、何もバッファリングしません。イベントは発行された瞬間に購読している相手へ配信され、その後は消えます。

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final controller = StreamController<int>.broadcast();
  controller.add(1);                 // nobody is listening: dropped
  await Future(() {});

  controller.stream.listen((v) => print('late listener got $v'));
  controller.add(2);
  await Future(() {});
}
// Output:
// late listener got 2
```

この挙動は、イベント的なデータ (タップ、通知、ログ行) には適切なデフォルトですが、状態的なデータには不向きです。ストリームが"現在のユーザー"や"接続状態"を表す場合、最後の変更の後に購読したウィジェットは、次の変更があるまで何も表示しません。その変更は永遠に来ないかもしれません。Flutter では、データの読み込みが済んだ後に遷移した画面で、`StreamBuilder` がローディング側のブランチから抜け出せない、という形でよく現れます。

rxdart は `BehaviorSubject` でこれを解決します。最新のイベントを記憶し、新しい購読者すべてに発行します。すでに rxdart に依存しているなら、それを使ってください。この 1 つの動作だけが必要なのであれば、リアクティブ拡張のライブラリ全体を導入するのは過剰で、必要なプリミティブはすでに SDK にあります。

## プリミティブ: Stream.multi はリスナーごとに専用のコントローラーを渡す

`Stream<T>.multi(void Function(MultiStreamController<T>) onListen, {bool isBroadcast = false})` は、何度でも購読できるストリームを作ります。`listen` を呼ぶたびに、新しい `MultiStreamController` を引数に `onListen` が呼び出され、そのコントローラーに `add` したものはその 1 つの購読にだけ届きます。

このリスナーごとのフックこそ、broadcast コントローラーに欠けているものです。`StreamController.broadcast(onListen: ...)` は、リスナー数が 0 から 1 になるときにだけ `onListen` を呼びます。そのため、2 人目、3 人目、100 人目の購読者にはコールバックが一切なく、キャッシュした値を渡す場所がありません。

`isBroadcast` フラグは動作を変えません。`Stream.isBroadcast` ゲッターの値を設定するだけで、これを確認するコンシューマーもあります。ストリームが broadcast のように振る舞う (複数のリスナーを許可し、再送する以外に過去をリスナーごとにバッファリングしない) 場合は `true` に設定します。ここがまさにその場合です。

## 手順: 依存関係なしの BehaviorSubject

1. イベントのハブとして broadcast の `StreamController` を保持します。
2. 最新の値 (と値があるかどうか) をその隣に保存します。
3. `Stream.multi` のインスタンスを 1 つだけ公開し、その `onListen` で、まずキャッシュした値を新しい購読者のコントローラーに追加し、次にハブのイベントを転送します。
4. リスナーごとのコントローラーの一時停止、再開、キャンセルをハブの購読に接続し、何もリークしないようにします。

```dart
// Dart 3.12.2 (Stream.multi requires Dart 2.9+)
import 'dart:async';

class ValueStream<T> {
  ValueStream(T initial) : _value = initial, _hasValue = true;
  ValueStream.empty();

  final _hub = StreamController<T>.broadcast();
  late T _value;
  bool _hasValue = false;
  Object? _error;
  StackTrace? _stackTrace;

  /// Synchronous access, like BehaviorSubject.value.
  T get value => _value;
  bool get hasValue => _hasValue;

  void add(T value) {
    _value = value;
    _hasValue = true;
    _error = null;
    _hub.add(value);
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _error = error;
    _stackTrace = stackTrace;
    _hub.addError(error, stackTrace);
  }

  Future<void> close() => _hub.close();

  late final Stream<T> stream = Stream.multi((controller) {
    // 1. Replay the latest event to this listener only.
    if (_error != null) {
      controller.addError(_error!, _stackTrace);
    } else if (_hasValue) {
      controller.add(_value);
    }

    // 2. Already closed: replay, then finish.
    if (_hub.isClosed) {
      controller.close();
      return;
    }

    // 3. Forward future events.
    final sub = _hub.stream.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    controller
      ..onPause = sub.pause
      ..onResume = sub.resume
      ..onCancel = sub.cancel;
  }, isBroadcast: true);
}
```

使い方は次のとおりです。

```dart
// Dart 3.12.2
Future<void> main() async {
  final status = ValueStream<int>(0);
  status.add(1);

  status.stream.listen((v) => print('A got $v'));
  await Future(() {});
  status.add(2);
  await Future(() {});

  status.stream.listen((v) => print('B got $v'));   // subscribes late
  await Future(() {});
  status.add(3);
  await Future(() {});
}
// Output:
// A got 1
// A got 2
// B got 2
// A got 3
// B got 3
```

`B` は `2` が発行された後に購読しましたが、それでも受け取り、その後のイベントもすべて受け取っています。`B` が参加したとき `A` に `2` が重複して届かなかったのは、再送が `B` 専用のコントローラーに対して行われたためです。

このクラスには、意図的な選択がいくつかあります。

- **`stream` はゲッターではなく `late final` フィールドです。** 1 つの `Stream.multi` インスタンスは何度でも購読できるため、アクセスのたびに新しく作る理由はありません。また `identical(store.stream, store.stream)` が true のままになり、これは `StreamBuilder` にとって重要です (後述)。
- **再送には `addSync` ではなく `add` を使います。** `MultiStreamController` には、即座に配信する `addSync`、`addErrorSync`、`closeSync` があります。API ドキュメントによると、これらはリスナーがイベントを受け取る準備ができているときにだけ、通常は別の非同期コールバックの内部から使うものとされています。`onListen` の中で呼ぶと、`listen()` が購読を返す前にイベントが配信されてしまい、ストリームは `listen` の最中に同期的にイベントを発行しないという Dart の慣習に反します。通常の `add` はイベントをキューに入れ、順序を保ちます。私のテストでは、`listen` の直後に同期的な `add` を 2 回呼ぶと、`100, 101, 102` の順に出力されました。
- **エラーも再送されます。** 最後に起きたことがエラーだった場合、後から購読した側は古い値ではなくそのエラーを受け取ります。最後の正常な値を再送したい場合は、`_error` の分岐を削除してください。`BehaviorSubject` はエラーを含む最新のイベントを再送するため、この実装はそれと一致します。

## 既存のストリームを再送型に変える

コントローラーを自分で所有していないことはよくあります。プラグインや Firestore のスナップショット、`Socket` から `Stream<T>` を受け取り、最新の値を再送する形で複数のウィジェットに共有したい場合です。`Stream.multi` の SDK ドキュメントには、これに近い `repeatLatest()` の例があります。ここでは、エラー、完了、遅延接続にも対応したバージョンを示します。

```dart
// Dart 3.12.2
import 'dart:async';

extension ReplayLatest<T> on Stream<T> {
  Stream<T> replayLatest() {
    final hub = StreamController<T>.broadcast();
    StreamSubscription<T>? source;
    var hasLatest = false;
    late T latest;
    var done = false;

    void connect() {
      source ??= listen(
        (value) {
          hasLatest = true;
          latest = value;
          hub.add(value);
        },
        onError: hub.addError,
        onDone: () {
          done = true;
          hub.close();
        },
      );
    }

    return Stream.multi((controller) {
      connect();                       // subscribe to the source on first listen
      if (hasLatest) controller.add(latest);
      if (done) {
        controller.close();
        return;
      }
      final sub = hub.stream.listen(
        controller.add,
        onError: controller.addError,
        onDone: controller.close,
      );
      controller
        ..onPause = sub.pause
        ..onResume = sub.resume
        ..onCancel = sub.cancel;
    }, isBroadcast: true);
  }
}
```

これは single-subscription のソースでも動作します。それがポイントで、拡張はソースを正確に 1 回だけ購読し、イベントを扇状に配ります。

```dart
// Dart 3.12.2
Future<void> main() async {
  final source = StreamController<int>();          // single-subscription
  final shared = source.stream.replayLatest();

  shared.listen((v) => print('first: $v'));
  source.add(1);
  source.add(2);
  await Future(() {});

  shared.listen((v) => print('late: $v'), onDone: () => print('late: done'));
  await Future(() {});
  source.add(3);
  await source.close();
  await Future(() {});

  shared.listen((v) => print('after close: $v'),
      onDone: () => print('after close: done'));
  await Future(() {});
}
// Output:
// first: 1
// first: 2
// late: 2
// first: 3
// late: 3
// late: done
// after close: 3
// after close: done
```

この拡張が意図的に行わないことに注意してください。すべてのリスナーがいなくなっても、ソースの購読をキャンセルしません。これは、最後のリスナーが去るとソースをキャンセルする参照カウント方式の rxdart の `shareValue()` とは異なります。この拡張は、一度接続して維持し続ける `publishValue()` のように動作し、アプリの寿命と同じ状態には向いています。ソースが高コスト (GPS ストリームや WebSocket など) な場合は、参照カウントを追加してください。`onListen` と `onCancel` でリスナーごとのアクティブなコントローラーの数を追跡し、ゼロになったら `source` をキャンセルします。その時点以降に購読した人に古いキャッシュ値を渡すか、再接続を待たせるかは、事前に決めておいてください。

## イベントを取りこぼす async* の近道

多くの人が最初に試すのはジェネレーターです。

```dart
// Dart 3.12.2 - looks right, is racy
Stream<T> withLatest<T>(T Function() current, Stream<T> updates) async* {
  yield current();
  yield* updates;
}
```

読みやすく見えますが、間違っています。`async*` 関数は、イベントが配信されるまで `yield` で一時停止し、その後に `yield*` の行へ進みます。この時点で初めて broadcast の `updates` を購読します。listen の呼び出しからその購読までの間に発行されたものは、隙間に落ちます。`listen` の 1 マイクロタスク後に予約したイベントで再現しました。

```dart
// Dart 3.12.2
Future<void> main() async {
  final updates = StreamController<int>.broadcast();
  var current = 20;

  withLatest(() => current, updates.stream)
      .listen((v) => print('got $v'));

  scheduleMicrotask(() {
    current = 21;
    updates.add(21);
  });
  await Future(() {});
  await Future(() {});
}
// Output:
// got 20
```

`21` は出力されません。実際の状態は `21` なのに、購読者は `20` を表示したままになり、他の何かが変わるまで後続のイベントで修正されません。`Stream.multi` 版には、この隙間がありません。キューに入ったイベントが発火する前に、`onListen` の中で同期的にハブを購読するためです。

## Flutter アプリでの注意点

**`StreamBuilder` は依然として 1 フレームの"waiting"を表示します。** 再送は非同期であり (上の `add` と `addSync` の選択がその理由です)、`StreamBuilder` は `initState` で購読した直後に最初のフレームをビルドします。何もしなければ、この最初のフレームは `ConnectionState.waiting` でデータがなく、ローディングインジケーターが 1 フレームだけ点滅して表示されます。`ValueStream` は現在の値を同期的に公開しているので、それを `initialData` として渡します。

```dart
// Flutter 3.44, Dart 3.12.2
StreamBuilder<int>(
  stream: status.stream,
  initialData: status.hasValue ? status.value : null,
  builder: (context, snapshot) {
    if (!snapshot.hasData) return const CircularProgressIndicator();
    return Text('Status: ${snapshot.data}');
  },
)
```

**`build` の中でストリームを作らないでください。** `StreamBuilder` は、前回と同じオブジェクトではないストリームを受け取ると再購読します。アクセスのたびに `Stream.multi(...)` や `source.replayLatest()` を返すゲッターは、リビルドごとに新しいストリームを作るため、リビルドのたびにキャンセルと再購読が行われ、`replayLatest()` ではソースへの新しい購読も開かれます。ストリームは、フィールド、サービス、または `initState` で 1 回だけ作成してください。同じルールは Future にも当てはまります。詳しくは [FutureBuilder がリビルドのたびに再作成されないように Future を初期化する方法](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)を参照してください。

**キャンセルは接続されていますが、キャンセル自体は必要です。** `onCancel` がハブの購読に転送されるため、キャンセルされたリスナーは broadcast コントローラーから削除されます。私のテストでは、`cancel()` の後に `_hub.hasListener` が `true` から `false` に変わりました。手動で `listen` を呼んだリスナーには、これまでどおり `StreamSubscription` フィールドと `dispose` での `cancel()` が必要です。[dispose での StreamSubscription のキャンセル](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)と同じです。`StreamBuilder` はこれを自動で行います。

**所有者がいなくなったらハブを閉じてください。** ウィジェットの `State` が所有する `ValueStream` は、他のコントローラーと並べて `dispose()` で閉じるべきです。詳しくは[メモリリークを避けるためのコントローラーの dispose](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)を参照してください。`close()` の後に購読しても安全です。購読者は最終値を受け取り、その後に done イベントを受け取ります。

**再送されたエラーが未処理のままなら、やはり未処理です。** `onError` を持たないリスナーにエラーを再送すると、未捕捉の非同期エラーとなり、ゾーンのエラーハンドラー (Flutter では `PlatformDispatcher.instance.onError`) に渡されます。その行き先については、[Flutter で未捕捉の非同期エラーを捕捉する方法](/ja/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)を参照してください。

**等価性によるフィルタリングは別の判断です。** `BehaviorSubject` は重複を除去せず、このクラスも同様です。"値が変わったときだけ発行する"ようにしたい場合は、`add` に `if (value == _value) return;` のガードを追加してください。ただし、[Riverpod の StreamProvider の等価性フィルター](/ja/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/)と同じ間違いを起こす可変オブジェクトでは、トレードオフに注意が必要です。

## ストリームがまったく不要な場合

値がウィジェットに渡されるだけで、非同期の境界を越えないのであれば、`ValueListenableBuilder` を併用した `ValueNotifier<T>` のほうがどのストリームよりも単純です。同期的な `value` があり、変更時にリスナーへ通知し、ビルダーは最初のフレームで現在の値を読むため、ローディングの点滅もありません。再送型のストリームを選ぶのは、ストリーム演算子 (`where`、`asyncMap`、`debounce` 風の変換) が必要なとき、データが既存の `Stream` API から来るとき、または Riverpod の `StreamProvider` のような状態管理ライブラリがストリームを要求するときです。これらの選択肢のより広い比較については、[FutureBuilder と StreamBuilder と Riverpod の AsyncValue の比較](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)を参照してください。

また、最新の値だけでなく"直近 10 件のイベントを再送する"や"すべて再送する"が必要な場合も、単一のフィールドの代わりに上限付きの `Queue<T>` を使えば、同じ `Stream.multi` の構造が使えます。ただしそこまでいくと、rxdart の `ReplaySubject` を再実装していることになり、パッケージを追加するのは妥当なトレードオフです。

## 参考資料

- [Stream.multi constructor, Dart API docs](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html)
- [MultiStreamController class, Dart API docs](https://api.dart.dev/stable/dart-async/MultiStreamController-class.html)
- [StreamController.broadcast, Dart API docs](https://api.dart.dev/stable/dart-async/StreamController/StreamController.broadcast.html)
- [Dart SDK 2.9 changelog entry for Stream.multi](https://dart.googlesource.com/sdk/+/refs/tags/2.9.1/CHANGELOG.md)
- [rxdart on pub.dev (BehaviorSubject, ReplaySubject, shareValue)](https://pub.dev/packages/rxdart)
- [Asynchronous programming: streams, dart.dev](https://dart.dev/libraries/async/using-streams)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
