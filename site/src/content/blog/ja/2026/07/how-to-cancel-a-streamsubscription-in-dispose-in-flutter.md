---
title: "Flutter で setState-after-dispose クラッシュを避けるために dispose で StreamSubscription をキャンセルする方法"
description: "ユーザーが画面を離れた後も stream はイベントを発行し続け、その onData がすでに破棄された State に対して setState を呼び、Flutter は例外を投げます。subscription を保持し、super.dispose の前に dispose でキャンセルすれば、コールバックは死んだ widget の上で二度と発火しません。Flutter 3.44 向けの完全なパターンです。"
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "ja"
translationOf: "2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

`State` の中で `stream.listen(...)` を呼ぶと、あなたがその subscription を所有することになり、`dispose()` でキャンセルしなければなりません。そうしないと、ユーザーが画面を離れた後も stream はイベントを配信し続け、`onData` コールバックがすでに破棄された `State` に対して `setState` を実行し、Flutter は `setState() called after dispose()` を投げます。解決策は 3 行です。`StreamSubscription` をフィールドに保持し、`initState` で作成し、`super.dispose()` の前に `dispose()` で `_sub.cancel()` を呼びます。キャンセルは配信を止めるので、コールバックはそもそも死んだ widget の上で実行されません。このガイドでは Flutter 3.44（現在の安定版、2026 年）と Dart 3.x を使用します。

重要な区別は次のとおりです。キャンセルが本当の解決策であり、`mounted` チェックは症状にあてた絆創膏にすぎません。`StreamSubscription` は、あなたの widget よりも長生きするソース（`StreamController`、Firestore のスナップショットリスナー、WebSocket、センサー、`connectivity_plus`）と、`this` をキャプチャするコールバックとの間をつなぐ生きたパイプです。そのパイプが開いている限り、あなたの `State` は到達可能であり、`onData` は破棄されているかどうかに関係なくすべてのイベントで実行されます。パイプを閉じることが、メモリリークとクラッシュが同時に消える地点です。

## なぜコールバックは widget より長生きするのか

Flutter の widget のライフサイクルと stream のライフサイクルは完全に独立しています。framework は、その要素がツリーを離れたときにあなたの `State` を破棄します。ユーザーがルートを pop する、親があなたを存在の外へ再構築する、タブが切り替わる、などです。そのどれも stream には触れません。反対側の `StreamController` は、widget がリッスンしていたことも、ましてや widget が消えたことも知りません。イベントを生成し続け、Dart はそれを登録されたすべての subscription、あなたのものも含めて、ディスパッチし続けます。

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _PriceTickerState extends State<PriceTicker> {
  double _price = 0;

  @override
  void initState() {
    super.initState();
    priceStream.listen((value) {   // subscription is never stored
      setState(() => _price = value); // runs even after dispose()
    });
  }
}
```

このコードはあらゆる手早いテストを通過します。手早いテストでは、イベントが飛んでいる最中に画面を離れないからです。`priceStream` がまだ 1 秒に一度発行している最中に新しいルートを push すると、次の tick が `onData` に着地し、消滅した `State` に対して `setState` を呼びます。debug では `FlutterError` が得られます。`setState() called after dispose(): _PriceTickerState#4f2a1(lifecycle state: defunct, not mounted)` です。`listen` が返した subscription は捨てられているので、キャンセルするハンドルもなく、イベントを止めるものもありません。`State` もガベージコレクションできません。stream の内部 subscription リストが、それをキャプチャした closure をまだ参照しているからです。これは [メモリリークを避けるための controller の破棄](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) の裏にあるのと同じ所有権のバグです。作成して一度も解放しなかったリソースです。

## パターン、ステップごとに

### ステップ 1: subscription をフィールドに保持する

`listen` は `StreamSubscription<T>` を返します。それを保持してください。そのハンドルが、後でキャンセルする唯一の手段です。

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;
  // ...
}
```

subscription を条件付きで作成する場合は、null 許容フィールド（`StreamSubscription<double>?`）を使い、`dispose` が安全に `_sub?.cancel()` を呼べるようにします。常に `initState` でちょうど一度だけ subscribe する場合は、`late final StreamSubscription<double> _sub;` のほうがきれいです。フィールドが常に代入されることをドキュメント化し、条件なしでキャンセルできるからです。

### ステップ 2: build ではなく initState で subscribe する

subscription は `initState`（stream が inherited widget から来る場合は `didChangeDependencies`）で作成し、`build` では決して作成しないでください。`build` はフレームごとに実行されるので、そこで subscribe すると再構築のたびに新しいリスナーが積み重なり、そのそれぞれが `setState` を発火し、それがさらに別の再構築をスケジュールします。このフィードバックループはこの記事とは別のクラスのバグで、[setState() or markNeedsBuild() called during build](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) として現れます。

```dart
// Flutter 3.44, Dart 3.x
@override
void initState() {
  super.initState();
  _sub = priceStream.listen(
    (value) => setState(() => _price = value),
    onError: (Object e, StackTrace s) => setState(() => _price = -1),
  );
}
```

### ステップ 3: super.dispose の前に dispose でキャンセルする

これが実際にクラッシュを修正する行です。

```dart
// Flutter 3.44, Dart 3.x
@override
void dispose() {
  _sub?.cancel();
  super.dispose();
}
```

順序は controller の場合と同じく重要です。まず自分自身のリソースを解放し、それから `super.dispose()` で制御を framework に渡します。`cancel()` が返った後、subscription は死んでいます。ソースがすでに生成したがまだディスパッチしていないイベントについても、以降の `onData`、`onError`、`onDone` コールバックを一切配信しません。これがあなたが手に入れる保証です。`setState` を呼ぶ closure はもう実行できないので、破棄された `State` は触れられない状態になります。

## なぜ dispose で cancel を待たないのか

`StreamSubscription.cancel()` は `Future<void>` を返し、`dispose()` は `void` を返すので、それを `await` することはできません。これは人を混乱させますが、問題ではありません。future は、stream の `onCancel` コールバックが必要な後始末（ソケットのクローズ、ファイルハンドルの解放）を終えたときに完了します。あなたのコールバックへの配信は、その future がいつ解決するかに関係なく、直ちに止まります。死んだ widget に対して `setState` を呼ばないという目的のためには、await しない `cancel()` は呼ばれた瞬間に完全に有効です。

future が重要になるのは、ソースが後始末を終えたのがいつなのかを具体的に知る必要がある場合だけで、それは widget の中では稀です。`StreamController` を自分で所有していて、その `onCancel` が実行されてから先に進むことを保証したい場合は、その後始末を `dispose` の外、await できる場所で行ってください。

## 1 つの widget 内の複数の subscription

画面はしばしば複数の stream をリッスンします。接続状態、データフィード、キーボードの可視性 stream などです。そのそれぞれをキャンセルしてください。きれいな方法が 2 つあります。

subscription の型が異なり、個別に参照する場合は別々のフィールドにします。

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<ConnectivityResult>? _connSub;
StreamSubscription<Order>? _orderSub;

@override
void dispose() {
  _connSub?.cancel();
  _orderSub?.cancel();
  super.dispose();
}
```

すべてをまとめて片付けたいだけならリストにします。

```dart
// Flutter 3.44, Dart 3.x
final _subs = <StreamSubscription<dynamic>>[];

@override
void initState() {
  super.initState();
  _subs.add(connectivity.onConnectivityChanged.listen(_onConn));
  _subs.add(orders.stream.listen(_onOrder));
}

@override
void dispose() {
  for (final s in _subs) {
    s.cancel();
  }
  super.dispose();
}
```

リストは、新しいフィールドごとに対応する `cancel` 行を追加するのを覚えておく必要なくスケールします。まさにそうした見落としが、数か月後にクラッシュを再び持ち込むのです。

## 古い subscription をリークさせずに再 subscribe する

リッスンしている stream が widget のプロパティや継承された値に依存している場合、widget がマウントされたままソースが変わることがあります。これを `didUpdateWidget` または `didChangeDependencies` で処理し、新しいものを開く前に以前の subscription をキャンセルします。キャンセルを飛ばすと古いものがリークし、その `setState` を同じ `State` の上で生かし続けます。

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(PriceTicker old) {
  super.didUpdateWidget(old);
  if (old.symbol != widget.symbol) {
    _sub?.cancel();                       // drop the old stream
    _sub = priceStreamFor(widget.symbol)  // subscribe to the new one
        .listen((v) => setState(() => _price = v));
  }
}
```

## StreamController を所有しているなら、それも close する

subscription をキャンセルすることと controller を close することは別の責務です。他人の stream の消費者にすぎない場合は、あなたの subscription をキャンセルします。widget が stream を支える `StreamController` も作成した場合は、`dispose` で controller も close してください。そうしないと controller とそのバッファがリークします。

```dart
// Flutter 3.44, Dart 3.x
final _controller = StreamController<String>();
StreamSubscription<String>? _sub;

@override
void initState() {
  super.initState();
  _sub = _controller.stream.listen((msg) => setState(() => _last = msg));
}

@override
void dispose() {
  _sub?.cancel();       // stop consuming
  _controller.close();  // release the source you own
  super.dispose();
}
```

シングルサブスクリプションの controller は 2 つ目のリスナーの接続を許しません。ですから、この stream を別の場所でも公開する場合は `StreamController.broadcast()` で作成し、broadcast stream 上のリスナーはそれぞれ自分の `cancel` を必要とすることを覚えておいてください。

## なぜ StreamBuilder がしばしばより良い答えなのか

subscription がすることが値を UI に流し込むことだけなら、そもそも subscription を管理する必要はおそらくありません。`StreamBuilder` は挿入されたときに subscribe し、`builder` を通じてイベントごとに再構築し、ツリーから削除されたときに自動的にキャンセルします。`setState` もフィールドも `dispose` での管理もなく、したがって破棄後に subscription を走らせ続ける手段もありません。

```dart
// Flutter 3.44, Dart 3.x
StreamBuilder<double>(
  stream: priceStream,
  builder: (context, snap) => Text('${snap.data ?? 0}'),
)
```

手動の `listen` と `setState` に頼るのは、イベントが描画以外の何かをするときだけにしてください。完了イベントでのナビゲーション、`SnackBar` の表示、別の controller への書き込み、副作用のトリガーなどです。これらはまさに古くなったコールバックが危険なケースであり、まさに `dispose` でのキャンセルが譲れないケースです。手動管理とマネージド管理の同じトレードオフは `TextEditingController` でも現れ、そのため [破棄後に使われた controller](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) は類似のエラーを投げます。

## pause は cancel ではなく、mounted は代替ではない

2 つの近道はこれを解決するように見えて、実際にはしません。

`StreamSubscription.pause()` は配信を一時的に止めますが、一時停止された subscription はまだ登録されており、あなたの `State` を保持し続けます。`dispose` での一時停止はリークします。`cancel` を使わなければなりません。

`onData` の先頭の `if (!mounted) return;` は `setState` の呼び出しを防ぎますが、stream を止めません。subscription は生きたまま、イベントをディスパッチし続け、あなたの `State` を到達可能なまま保ちます。リークが続く間、クラッシュはマスクされます。`mounted` チェックは、それが設計された用途、つまり widget が消えた後に再開する `await` をコールバック内に持つ場合にだけ使い、[非同期の切れ目の後に mounted チェックで setState を守る](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) 方法を学んで徹底的にカバーしてください。「stream が発行し続ける」という単純なケースでは、cancel が正しく完全な解決策です。

`onData` 自体が非同期の場合、両方の問題に同時にぶつかることがあります。subscription がイベントを配信し、ハンドラー内で `await` し、await の最中に widget が破棄される、というものです。cancel が配信を処理し、`mounted` チェックが await 後の再開を処理します。そこでは二重の備えが正当化されます。

## コピー用の 1 ファイル版

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class PriceTicker extends StatefulWidget {
  const PriceTicker({super.key, required this.stream});
  final Stream<double> stream;

  @override
  State<PriceTicker> createState() => _PriceTickerState();
}

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;

  @override
  void initState() {
    super.initState();
    _sub = widget.stream.listen(
      (value) => setState(() => _price = value),
      onError: (Object e, StackTrace s) => setState(() => _price = -1),
    );
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(_price.toStringAsFixed(2));
}
```

subscription を保持し、`super.dispose()` の前にキャンセルすれば、`setState()-after-dispose()` クラッシュは確率的に避けられるのではなく構造的に不可能になります。ネットワークから来るストリーミング状態は、エラー経路でも同じ配慮に値します。これは、失敗した stream が永遠に解決しないスピナーではなくユーザーが対処できる状態を表示するように、[Flutter アプリでネットワークエラーを丁寧に処理する](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) 方法に目を通しておくと組み合わせる価値があります。

## 出典

- [StreamSubscription.cancel API](https://api.flutter.dev/flutter/dart-async/StreamSubscription/cancel.html) - cancel の契約と `Future<void>` の戻り値。
- [State.dispose API](https://api.flutter.dev/flutter/widgets/State/dispose.html) - "subclasses should override this method to release any resources retained by this object (e.g., stop any active animations)".
- [StreamBuilder class](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) - widget のライフサイクルに結びついた自動の subscribe とキャンセル。
- [Dart streams tutorial](https://dart.dev/libraries/async/using-streams) - シングルサブスクリプション stream と broadcast stream、リスナー管理。
