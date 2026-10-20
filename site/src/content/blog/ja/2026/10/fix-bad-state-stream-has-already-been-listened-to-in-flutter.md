---
title: "修正: Flutter の Bad state: Stream has already been listened to"
description: "single-subscription ストリームは、生存期間を通じて listen() を 1 回しか受け付けません。ストリームは 1 回だけ作成して 1 つのリスナーに渡すか、asBroadcastStream や Stream.multi で共有してください。"
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "streams"
lang: "ja"
translationOf: "2026/10/fix-bad-state-stream-has-already-been-listened-to-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`Bad state: Stream has already been listened to.` は、single-subscription ストリームに対して `listen()` が 2 回目に呼ばれたことを意味します。この種類のストリームは、生存期間全体を通じて購読を 1 回しか受け付けず、最初の購読をキャンセルしてもリセットされません。Flutter では、2 回目の `listen()` はほとんどの場合 `StreamBuilder` から発生します。同じストリームに対する 2 つのビルダー、再マウントされたビルダー、あるいは `build()` 内に書かれた `.map()`/`.where()` が原因です。派生ストリームは (`initState` や State オブジェクト内で) 1 回だけ作成して修正してください。複数のウィジェットが本当に同じイベントを必要とする場合は、`asBroadcastStream()`、`StreamController.broadcast()`、またはリスナーごとの `Stream.multi` でソースを共有します。

以下の再現コードと修正はすべて Flutter 3.44.8 と Dart 3.12.2 で実行しました。純粋な Dart のケースは `dart run`、ウィジェットのケースは `flutter test` のウィジェットテストで確認しています。

## エラーが発生する状況

純粋な Dart では、例外は 2 回目の `listen()` から発生し、先頭のフレームはコントローラーが 2 つ目の購読者を拒否している箇所になります。

```text
StateError: Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:695:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:854:20)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:516:42)
#3      main.<anonymous closure> (file:///.../repro.dart:20:14)
```

Flutter アプリでは、同じ `StateError` が widgets ライブラリに捕捉され、その時点でビルド中だったものに対して報告されます。注目すべきフレームは 2 行の `_StreamBuilderBaseState` です。

```text
══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════════════
The following StateError was thrown building StatefulBuilder(state: _StatefulBuilderState#352fb):
Bad state: Stream has already been listened to.

When the exception was thrown, this was the stack:
#6      _StreamBuilderBaseState._subscribe (package:flutter/src/widgets/async.dart:133:38)
#7      _StreamBuilderBaseState.didUpdateWidget (package:flutter/src/widgets/async.dart:118:7)
#8      StatefulElement.update (package:flutter/src/widgets/framework.dart:5991:55)
```

`_subscribe` の下のフレームが `initState` なら、新しい `StreamBuilder` の State が作成され、すでに他の誰かが所有しているストリームを購読したことになります。`didUpdateWidget` なら、ビルダーが再ビルド時に*別の*ストリームオブジェクトを受け取って購読しており、その新しいオブジェクトの元になっているソースがすでに使用済みです。この 1 行を見れば、以下のどの原因に当たるかがわかります。

## ストリームが 2 つ目のリスナーを拒否する理由

Dart のストリームには 2 種類あります。**single-subscription** ストリームは 1 回限りのシーケンスです。誰かが listen するまでイベントをバッファリングし、その 1 つのリスナーに配信して終了します。**broadcast** ストリームは任意の数のリスナーを持てますが、何もバッファリングしません。各イベントは、その時点で購読している相手にだけ届きます。

`StreamController()`、`async*` ジェネレーター、`Stream.value`、`Stream.periodic`、`Future.asStream()`、`File.openRead()`、`Process.stdout`、`http` の `StreamedResponse` の本文は、すべて single-subscription です。2 回目に `listen()` すると、最初の購読がすでにキャンセルされていてもコントローラーは例外をスローします。これは明示的に確認しました。

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final c = StreamController<int>();
  final first = c.stream.listen((_) {});
  await first.cancel();
  c.stream.listen((_) {}); // StateError: Bad state: Stream has already been listened to.
}
```

混乱の大半は、あまり目立たない次の 2 つの事実から生じます。

1. **演算子が代わりに listen します。** `map`、`where`、`expand`、`asyncMap`、`transform`、`distinct` などは、*自身*が listen されたときにソースを購読する新しいストリームを返します。そのため `c.stream.where(...)` と `c.stream.map(...)` は 2 つの異なるストリームオブジェクトですが、両方を listen すると `c.stream` に対する `listen()` が 2 回になり、2 回目でスローされます。
2. **消費系のメソッドも listen します。** `first`、`last`、`length`、`toList()`、`forEach`、`drain`、`await for`、`pipe`、そして `http` の本文に対する `bytesToString()` は、内部ではすべて `listen()` です。`async*` ストリームに対して `await stream.first` を呼んでから `await stream.toList()` を呼ぶと、2 回目の呼び出しでスローされます。

型を見ても、どちらなのかは確実にはわかりません。Dart 3.12.2 では、`Stream.fromIterable` の `isBroadcast` は `false` ですが、このストリームは複数回 listen できます (各リスナーがイテラブルを個別にたどります)。一方、`Stream.value(1)` と `Future.value(1).asStream()` は 2 回目の `toList()` でスローします。自分で作成していないストリームは、ドキュメントに別の記載がない限り、すべて single-subscription として扱ってください。

## 最小の再現コード: StreamBuilder でエラーになる 3 つのパターン

次の 3 つはいずれも、上記のエラーで失敗します。ヘルパーは、最新の値を表示するだけの `StreamBuilder` です。

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget sb(Stream<int> s) => StreamBuilder<int>(
      stream: s,
      builder: (context, snap) =>
          Text('${snap.data}', textDirection: TextDirection.ltr),
    );

void main() {
  // A: two StreamBuilders on one single-subscription stream (throws in initState)
  testWidgets('A', (t) async {
    final c = StreamController<int>();
    await t.pumpWidget(Column(children: [sb(c.stream), sb(c.stream)]));
  });

  // B: .map() inside build, then the parent rebuilds (throws in didUpdateWidget)
  testWidgets('B', (t) async {
    final c = StreamController<int>();
    late StateSetter rebuild;
    await t.pumpWidget(StatefulBuilder(builder: (context, set) {
      rebuild = set;
      return sb(c.stream.map((x) => x * 2));
    }));
    rebuild(() {});
    await t.pump();
  });

  // C: same stream object, but the StreamBuilder is remounted (throws in initState)
  testWidgets('C', (t) async {
    final stream = StreamController<int>().stream;
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(1), child: sb(stream)));
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(2), child: sb(stream)));
  });
}
```

ケース B は、最初のフレームが正常に動くため、最も多くの人がつまずきます。`StreamBuilder` は `oldWidget.stream != widget.stream` のときだけ再購読します (これが `async.dart` の `didUpdateWidget` のチェックです)。そして `c.stream.map(...)` は `build()` のたびに新しいオブジェクトを返します。最初のビルドで `map` #1 がコントローラーを購読します。次の再ビルド (テーマの変更、キーボードの表示、親の `setState` など) で `map` #2 が作成され、`StreamBuilder` は #1 の購読を解除して #2 を購読し、#2 がコントローラーに対して 2 回目の `listen()` を試みます。

ケース C は、"このタブに戻ってくるとクラッシュする" や "ページを pop して再度 push するとクラッシュする"という現実のパターンです。ストリームは長寿命の場所 (サービス、トップレベル変数、親ウィジェット) にあり、`StreamBuilder` をホストする画面が破棄されて再作成されると、新しい `State` が、すでに 1 つ目のリスナーを持つストリームに対して `listen()` を呼びます。ビルダーの周囲でエレメントツリーの形が変わると、必ずこうなります。ナビゲーション、子を再ビルドする `IndexedStack` の代替、条件付きウィジェット、`Key` の変更などです。

比較として、再マウントせずに*同じ*ストリームオブジェクトを再ビルドをまたいで渡す場合は問題ありません。`StreamBuilder` は `didUpdateWidget` で同一のストリームだと判断し、既存の購読を維持します。このケースは同じテストファイルで成功しました。

## 修正方法 (推奨順)

### 1. 派生ストリームは build() ではなく 1 回だけ作成する

ストリームを 1 つのウィジェットだけが使う場合、ケース B が問題のすべてであり、修正はビルドごとに新しいストリームを作るのをやめることです。`State` に保持してください。

```dart
// Flutter 3.44.8, Dart 3.12.2
class PriceLabel extends StatefulWidget {
  const PriceLabel({super.key, required this.ticks});
  final Stream<int> ticks;

  @override
  State<PriceLabel> createState() => _PriceLabelState();
}

class _PriceLabelState extends State<PriceLabel> {
  late Stream<String> _formatted;

  @override
  void initState() {
    super.initState();
    _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
  }

  @override
  void didUpdateWidget(PriceLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ticks != widget.ticks) {
      _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<String>(
        stream: _formatted,
        builder: (context, snap) => Text(snap.data ?? '...'),
      );
}
```

`didUpdateWidget` のオーバーライドは重要です。親が本当に新しいソースを渡してきた場合にだけ、そのための新しい派生ストリームが必要になります。これは `FutureBuilder` と同じルールで、[再ビルドのたびに FutureBuilder が Future を再作成しないように Future を初期化する方法](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)の考え方がそのまま当てはまります。私のテストでは、`c.stream.map(...)` を `final` にキャッシュして親の再ビルドを経由して渡したところ、`c.add(21)` の後に `42` が表示され、エラーは発生しませんでした。

ウィジェット以外でも同じ考え方が当てはまります。最初の値とそれ以降の値の両方が必要な場合は、`first` を呼んでから `listen` するのではなく、1 つの購読から取得してください。

```dart
// Dart 3.12.2
Future<void> readAll(Stream<int> source) async {
  var isFirst = true;
  await for (final value in source) {
    if (isFirst) {
      print('first: $value');
      isFirst = false;
    }
    print('value: $value');
  }
}
```

### 2. リスナーごとに最初から始めたい場合は、フィールドではなくファクトリにする

各コンシューマーが独立したシーケンス (クエリ、ファイル読み取り、ジェネレーター) を受け取るべき場合は、ストリームをそもそも保存しないでください。ストリームを作成する関数を保存し、リスナーごとに呼び出します。`async*` 関数はすでにそのような関数です。

```dart
// Dart 3.12.2
Stream<int> countdown(int from) async* {
  for (var i = from; i >= 0; i--) {
    yield i;
    await Future<void>.delayed(const Duration(seconds: 1));
  }
}

// Two independent subscriptions, no error:
// countdown(3).listen(print);
// countdown(3).listen(print);
```

`countdown(3)` を 2 回呼び出してもエラーなく動作し、それぞれの呼び出し元が `[3, 2, 1, 0]` を受け取りました。1 つの `final s = countdown(3)` を 2 回の `toList()` で再利用するとスローされました。Flutter のデータ API の多くはすでにこの方式です。呼び出しごとに新しいストリームを返す `watchOrders()` のようなリポジトリメソッドは、`build()` ではなく `initState` で呼び出す限り、必要とする各ウィジェットから安全に呼び出せます。

繰り返し listen できる単一のオブジェクトでありながら、リスナーごとの動作を保ちたい場合は、まさにそれを実現するのが `Stream.multi` です。コールバックは `listen()` のたびに 1 回実行され、そのリスナー専用のコントローラーが渡されます。

```dart
// Dart 3.12.2
final Stream<int> config = Stream<int>.multi((controller) {
  controller.add(1);
  controller.close();
});

// await config.toList(); // [1]
// await config.toList(); // [1] again, no StateError
```

### 3. asBroadcastStream() または broadcast コントローラーで 1 つのソースを共有する

複数のウィジェットが*同じ*ライブソース (1 つのソケット、1 つの BLE キャラクタリスティック、1 つの `Process.stdout`) を観測する必要がある場合は、1 回だけ broadcast に変換し、その変換後のストリームを配布します。

```dart
// Flutter 3.44.8, Dart 3.12.2
class ConnectionService {
  ConnectionService(Stream<int> socketEvents)
      : events = socketEvents.asBroadcastStream();

  final Stream<int> events;
}
```

`final shared = c.stream.asBroadcastStream()` を使うと、`shared` に対する 2 つの `StreamBuilder` はどちらも `c.add(5)` の後に `5` を表示し、片方を再マウントしてもスローされませんでした。プロデューサーを自分で所有している場合は、最初から `StreamController<T>.broadcast()` として作成してください。

この呼び出しは **1 回だけ** 行う必要があります。`build()` 内の `widget.stream.asBroadcastStream()` はケース B の再発です。呼び出すたびに新しい broadcast ラッパーが作成され、同じ single-subscription ソースを購読しようとします。

## 注意点とバリエーション

**broadcast ストリームは、誰も listen していなかったイベントを破棄します。** これは修正 3 の代償であり、例外ではなく空白の画面として現れます。私のテストでは、`asBroadcastStream()` に後から参加したリスナーは `[3]` だけを受け取り、最初のリスナーは `[1, 2, 3]` を受け取りました。また、broadcast ストリームに再マウントした `StreamBuilder` は、以前に `7` が発行されていたにもかかわらず、次のイベントまで `null` を表示しました。一方、single-subscription のコントローラーは、誰かが listen する前に追加された `1` をバッファリングしていました。ウィジェットが表示されたときに現在の値が必要な場合は、`initialData` を渡すか、再生機能を持つストリームを使ってください。[rxdart を使わずに遅れて参加した購読者へ最新の値を再生する方法](/ja/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)では、`Stream.multi` を使ってそのようなストリームを作っています。

**`asBroadcastStream()` はソースの購読を維持し続けます。** デフォルトでは、最後の broadcast リスナーがキャンセルしてもラッパーは一時停止するだけで、ソースの `onCancel` は実行されません。私のプローブでは `sourceCancelled(default)=false` と出力されました。`onCancel: (sub) => sub.cancel()` を渡すとソースはキャンセルされますが、その場合ソースは完全に使い切られます。ラッパーへの次のリスナーは `done` だけを受け取りました。画面がなくなったときに閉じたいソケットやセンサーについては、ラッパーに頼らず、ライフサイクルを明示的に自分で管理してください。

**キャンセルはリセットではありません。** ネット上の修正案には、再度 listen する前に古い購読をキャンセルするよう勧めるものがあります。それはリークを避けられるので行うべきです ([dispose で StreamSubscription をキャンセルする方法](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)を参照してください)。しかし、それで single-subscription ストリームが再利用可能になるわけではありません。再利用できるのは新しいストリームだけです。

**ホットリロードは壊れたストリームを保持し続けます。** ホットリロードは `State` とトップレベル変数を保持するため、コードを修正した後でも、実行中のアプリですでに消費されたストリームは消費済みのままです。修正が効かなかったと判断する前に、ホットリスタートするか、停止して再実行してください。

**`http` の本文は 1 回限りです。** `StreamedResponse.stream` は 1 回しか読み取れません。`response.stream.bytesToString()` を呼んでから同じレスポンスを呼び出し元に返すロギングミドルウェアは、呼び出し元の読み取りでこのエラーを引き起こします。本文を一度バイト列として読み取り、下流で再度必要な場合はそのバイト列から新しい `http.Response` を作成してください。

**状態管理ライブラリは、ほとんどの場合これを処理してくれます。** `Bloc` の `stream` や Riverpod の `StreamProvider` は、すでに broadcast またはリスナーごとのストリームを公開しているため、このエラーが出る場合は通常、生のコントローラーがそれらと並べて渡されています。画面を生の `StreamBuilder` から移行する場合は、[FutureBuilder と StreamBuilder vs Riverpod の AsyncValue](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)と [Notifier vs AsyncNotifier vs StreamNotifier](/ja/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)で、どのプロバイダー型がストリームのライフサイクルを所有するかを解説しています。

**よく似たエラー: `Bad state: Cannot add new events after calling close`。** 同じ `StateError` 型ですが、ストリームの反対側で発生します。プロデューサーが閉じたコントローラーに `add` を呼んだもので、通常は `dispose()` より長く生き残ったタイマーやコールバックが原因です。**よく似たエラー: `Bad state: No element`。** こちらは、空のまま完了したストリーム (またはイテラブル) に対する `first`、`single`、`last` から発生します。どちらも broadcast ストリームでは解決しません。

## 関連記事

- [Flutter で setState-after-dispose のクラッシュを避けるために dispose で StreamSubscription をキャンセルする方法](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [rxdart を使わずに Dart ストリームの遅れて参加した購読者へ最新の値を再生する方法](/ja/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)
- [再ビルドのたびに FutureBuilder が Future を再作成しないように Future を初期化する方法](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [Flutter における FutureBuilder と StreamBuilder vs Riverpod AsyncValue](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod の Notifier vs AsyncNotifier vs StreamNotifier](/ja/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)

## 参考資料

- dart.dev の [Asynchronous programming: Streams](https://dart.dev/libraries/async/using-streams)。single-subscription と broadcast のセクションです。
- [Creating streams in Dart](https://dart.dev/libraries/async/creating-streams)。`async*`、`StreamController`、およびそれぞれの使い分けを扱っています。
- [`Stream.asBroadcastStream`](https://api.dart.dev/stable/dart-async/Stream/asBroadcastStream.html) と [`Stream.multi`](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html) の API リファレンス。
- [`StreamBuilder`](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) の API リファレンスと、Flutter 3.44.8 の `packages/flutter/lib/src/widgets/async.dart` にある `_StreamBuilderBaseState.didUpdateWidget` の実装。
