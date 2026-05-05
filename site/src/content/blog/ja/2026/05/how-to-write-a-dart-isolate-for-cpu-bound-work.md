---
title: "CPU バウンドな処理のために Dart の isolate を書く方法"
description: "async/await では足りないとき: Dart の isolate を起動して CPU バウンドな処理を UI スレッドの外で実行します。Isolate.run、Flutter の compute、SendPort/ReceivePort を使った長寿命ワーカー、境界を越えられるもの、そして JS/web での注意点。Dart 3.11 と Flutter 3.27.1 で検証済みです。"
pubDate: 2026-05-05
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "performance"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work"
translatedBy: "claude"
translationDate: 2026-05-05
---

短い答えとしては、ワンショットの計算なら `await Isolate.run(myFunction)` を呼んでください (Dart 2.19+)。Flutter なら `await compute(myFunction, arg)` です。多数のリクエストを処理するワーカーが欲しい場合は、`Isolate.spawn` を使い、両側で `ReceivePort` を持ち、メッセージを `SendPort` 経由でやり取りします。isolate に渡す関数はトップレベル関数か `static` 関数でなければならず、メッセージと結果は送信可能でなければなりません。web では dart2js に本物の isolate がないため、`compute` はイベントループ上で実行されます。Dart 3.11、Flutter 3.27.1、Android Gradle Plugin 8.7.3 で検証しました。

Dart の async は並列実行ではありません。`Future`、`await`、`Stream` は、UI が動いているのと同じシングルスレッドのイベントループ上に処理をスケジュールするだけです。その future の中の同期的なステップが 4 MB の JSON ドキュメントのパースやファイルのハッシュ計算で 80 ms を消費すると、ループは 80 ms ブロックされ、GPU は 60 fps で 2 フレーム落とし、`Skipped 5 frames!` がログに現れます。isolate は、Dart がそのシングルスレッドから抜け出す方法です。独自のイベントループ、独自のガベージコレクション、呼び出し元の isolate との共有メモリを持たない、独立した VM ヒープです。処理をそちらへ移し、答えを受け取り、UI スレッドは描画を続けます。

## isolate が正解になるケース

重い処理は **同期的な CPU 処理** でなければなりません。長時間のネットワーク呼び出しは対象外です。`http.get` を isolate でラップしても何も得られません。`http.get` はすでに非同期で、ソケットを待つ間にイベントループへ譲っているからです。本当に対象になる候補:

- 1 MB を超える JSON ペイロードのパース。`jsonDecode` は同期で、ペイロードサイズに対して線形にスケールします。
- `package:image` を使った画像のデコードとリサイズ。純粋な Dart で、プラットフォームのプラグインなし、12 MP の JPEG で数百ミリ秒かかります。
- ファイルの暗号学的ハッシュ計算 (バッファ付きストリームの上での SHA-256、パスワード検証のための BCrypt)。
- 大きなドキュメントに対する正規表現、特に `multiline: true` と後読みを使ったもの。
- `package:archive` での圧縮 / 展開。
- 数値処理: 小さな ML モデルの行列積、FFT、画像カーネルの畳み込み。

~16 ms (60 fps の 1 フレーム分の予算) を超えて同期的に動いているスタックフレームを指差せないなら、isolate は助けになりません。まず Flutter DevTools の CPU profiler でプロファイルしてください。見るべきは "UI thread" のタイムラインです。

## 一番安い経路: Isolate.run

`Isolate.run<R>(FutureOr<R> Function() computation, {String? debugName})` は Dart 2.19 で追加され、2026 年現在ドキュメントが最初に勧めてくる API です。isolate を起動し、コールバックを実行し、結果を VM 上ではコピーなしで送り返し、isolate を片付けます。

```dart
// Dart 3.11
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

Future<List<dynamic>> parseLargeJson(File file) async {
  final text = await file.readAsString();
  return Isolate.run(() => jsonDecode(text) as List<dynamic>);
}
```

ここでは 2 つのことが起きています。1 つ目に、ファイル読み込みは呼び出し元の isolate に残ります。`readAsString` はすでに非同期で、イベントループをブロックしないからです。2 つ目に、`jsonDecode` は新しい isolate で動き、得られた `List<dynamic>` が境界を越えて返ってきます。isolate の起動は最近のスマホでだいたい 1 から 3 ms かかるので、価値があるのは処理本体が少なくともその 10 倍以上かかるときだけです。

よくある間違いは、周囲のスコープをキャプチャするクロージャを渡してしまうことです:

```dart
// Dart 3.11 - works, but copies state you did not intend to send
Future<int> countWordsBuggy(String text, Set<String> stopWords) async {
  return Isolate.run(() {
    return text
        .split(RegExp(r'\s+'))
        .where((w) => !stopWords.contains(w))
        .length;
  });
}
```

このクロージャは `text` と `stopWords` をキャプチャするため、両方が新しい isolate にコピーされます。入力が小さければ問題ありませんが、`text` が 50 MB あれば、その時点で 50 MB のアロケーションとシリアライゼーションのパスを支払ったことになります。さらに悪いことに、キャプチャされた状態に送信不可能なオブジェクト (開いた `Socket`、`DynamicLibrary`、`ReceivePort`、`@pragma('vm:isolate-unsendable')` でマークされたもの) が含まれていると、spawn の呼び出しから実行時に `ArgumentError` が出ます。対策は、キャプチャする状態を最小限に保つか、トップレベルのエントリポイントを束ね、引数を明示的に渡すかのどちらかです。

## Flutter の compute とその実体

`package:flutter/foundation.dart` の `compute<M, R>(ComputeCallback<M, R> callback, M message)` は `Isolate.run` より前から存在し、Flutter のチュートリアルでは今でも一番引用される API です。Flutter 3.27.1 時点では、ネイティブプラットフォーム上では `Isolate.run(() => callback(message))` と同等であるとドキュメントされています。web ターゲットでは、dart2js が JavaScript にコンパイルされ、ブラウザには本物の isolate が存在しないため、コールバックは同じイベントループ上で同期的に実行されます。どの API を呼んでも web で並列実行は手に入りません。

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/foundation.dart';

List<Person> _parsePeople(String body) {
  final raw = jsonDecode(body) as List<dynamic>;
  return raw.cast<Map<String, dynamic>>().map(Person.fromJson).toList();
}

Future<List<Person>> fetchPeople(http.Client client) async {
  final res = await client.get(Uri.parse('https://api.example.com/people'));
  return compute(_parsePeople, res.body);
}
```

`_parsePeople` はトップレベル関数で、クロージャでもメソッドでもありません。これが一番ハマりやすいルールです。`compute` (または `Isolate.spawn`) に渡すコールバックは、識別子だけが渡され、囲んでいるスコープが渡されないように、トップレベル関数か `static` 関数でなければなりません。`compute(this._parsePeople, body)` と書くと、先ほどと同じクロージャキャプチャの罠に引っかかり、それに加えて囲んでいるウィジェットツリー全体を送ろうとしてしまうかもしれません。

## 長寿命ワーカー: 双方向ポートを使った Isolate.spawn

`Isolate.run` はワンショットです。多数のリクエストを処理するワーカー (一度 200 MB をロードしたあと、50 件のクエリに答える検索インデックスなど) が欲しいなら、`Isolate.spawn` に加えて、`SendPort` / `ReceivePort` の上に独自のプロトコルを乗せる必要があります。

パターンは対称です。両側がそれぞれ `ReceivePort` を開き、対応する `SendPort` を相手側に送り、その後はそれらのポート越しにやり取りします。

```dart
// Dart 3.11
import 'dart:async';
import 'dart:isolate';

class SearchWorker {
  late final SendPort _toWorker;
  late final ReceivePort _fromWorker;
  final Map<int, Completer<List<int>>> _pending = {};
  int _nextId = 0;

  static Future<SearchWorker> start(List<String> corpus) async {
    final fromWorker = ReceivePort('search.fromWorker');
    await Isolate.spawn(_entry, [fromWorker.sendPort, corpus],
        debugName: 'search-worker');
    final ready = Completer<SendPort>();
    final iter = StreamIterator(fromWorker);
    if (await iter.moveNext()) ready.complete(iter.current as SendPort);

    final w = SearchWorker._();
    w._toWorker = await ready.future;
    w._fromWorker = fromWorker;
    fromWorker.listen(w._onMessage);
    return w;
  }

  SearchWorker._();

  Future<List<int>> query(String term) {
    final id = _nextId++;
    final c = Completer<List<int>>();
    _pending[id] = c;
    _toWorker.send([id, term]);
    return c.future;
  }

  void _onMessage(dynamic msg) {
    final list = msg as List;
    final id = list[0] as int;
    final hits = (list[1] as List).cast<int>();
    _pending.remove(id)?.complete(hits);
  }

  void dispose() {
    _toWorker.send(null); // sentinel
    _fromWorker.close();
  }
}

void _entry(List args) async {
  final replyTo = args[0] as SendPort;
  final corpus = (args[1] as List).cast<String>();
  final inbound = ReceivePort('search.inbound');
  replyTo.send(inbound.sendPort);

  await for (final msg in inbound) {
    if (msg == null) {
      inbound.close();
      break;
    }
    final list = msg as List;
    final id = list[0] as int;
    final term = (list[1] as String).toLowerCase();
    final hits = <int>[];
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].toLowerCase().contains(term)) hits.add(i);
    }
    replyTo.send([id, hits]);
  }
  Isolate.exit();
}
```

いくつか触れておく価値があります。ハンドシェイク (ワーカーが受信用の `ReceivePort` を作り、ホストから渡されたポート越しに自分の `SendPort` を送り返す) はボイラープレートですが、避けようがありません。isolate ポートのグローバルなレジストリは存在しないからです。`_pending` マップに加えて単調増加する id によって、複数のクエリを同時に投げることができます。id がなければリクエストを直列化することしかできません。`null` のセンチネルでワーカーをきれいに止め、`Isolate.exit()` は `main` を素直にリターンさせるより速いです。最後のメッセージをコピーなしで送れるためです。

pause / resume や kill のセマンティクスが欲しいなら、`Isolate.spawn` が返す `Isolate` を捕まえて、`isolate.kill(priority: Isolate.immediate)` を呼びます。`kill` はワーカー側でファイナライザを動かさないので、ワーカーが保持していたファイルや DB ハンドルはプロセス終了までリークすることに注意してください。

## 何が境界を越えられるか

ほとんどの Dart オブジェクトは送信できます。Dart 3.11 時点での例外:

- ネイティブリソースを持つオブジェクト: `Socket`、`RawSocket`、`RandomAccessFile`、`Process`。
- `ReceivePort`、`RawReceivePort`、`DynamicLibrary`、`Pointer`、`dart:ffi` のすべてのファイナライザ。
- `@pragma('vm:isolate-unsendable')` でアノテートされたもの。
- 送信不可能な状態をキャプチャするクロージャ。キャプチャは推移的にチェックされるため、`Socket` フィールドを持つクラスインスタンスを参照しているクロージャも送信不可能です。

送信可能な型には、すべてのプリミティブ、`String`、`Uint8List` とその他の typed list、`List`、`Map`、`Set`、`DateTime`、`Duration`、`BigInt`、`RegExp`、そしてフィールド自身が送信可能なクラスインスタンスが含まれます。typed-data バッファを送ると、それはヒープを越えてコピーされますが、`TransferableTypedData` でラップするとゼロコピーの受け渡しになります:

```dart
// Dart 3.11
import 'dart:typed_data';
import 'dart:isolate';

Future<int> sumBytes(Uint8List bytes) async {
  final transferable = TransferableTypedData.fromList([bytes]);
  return Isolate.run(() {
    final view = transferable.materialize().asUint8List();
    var sum = 0;
    for (final b in view) {
      sum += b;
    }
    return sum;
  });
}
```

`materialize()` は `TransferableTypedData` ごとにワンショットなので、ワーカーが materialize した時点で送信側はそのバッファへのアクセスを失います。それがまさにポイントです。メモリは移動されるのであって、複製されません。数 MB を超えるペイロードでは、`TransferableTypedData` と素直なコピーの差は 1 ms と 30 ms の差になります。

## どのチームも引っかかる落とし穴

**クロージャはあなたが思っているより多くをキャプチャします。** メソッド内の空のクロージャでさえ `this` をキャプチャします。`this` が `StatefulWidget` の state であれば、呼び出しが終わるまでウィジェットのサブツリー全体をワーカーのヒープに留めたことになります。必要なデータは常にローカル変数に取り出し、トップレベル関数に引数として渡してください。

**isolate の起動はタダではありません。** no-op のコールバックを渡した素の `Isolate.run` は、Pixel 7 でだいたい 2 ms、古めの Android デバイスで 4 から 6 ms かかります。タップ処理のために 1 秒間に 60 回 `compute` を呼んでいる自分に気づいたら、自前のボトルネックを書いてしまっています。処理をバッチ化するか、長寿命のワーカーを組むかしてください。

**web ターゲットは並列実行については嘘をついています。** `compute` も `Isolate.run` も、web では現在のイベントループ上での実行にフォールバックします。JavaScript にコンパイルされた Dart はブラウザの単一スレッドで動くからです。web で並列性が必要なら、別途書いた本物の Web Worker と独自のメッセージプロトコルが必要です。`dart:js_interop` のワーカーサポートは進んでいますが、Dart 3.11 時点では `Isolate.run` のドロップイン置き換えにはなっていません。

**ワーカーからの `debugPrint` は混ざることがあります。** isolate ごとに独自の `print` パイプラインを持っています。Android では `logcat` 上の順序は best-effort です。レースをデバッグしているなら、ワーカー側で各ログ行にシーケンス番号を付けて、オフラインで並べ替えできるようにしてください。

**参照で状態を共有しないでください。** よくあるバグのパターンは、isolate に送り込んだ `Map` が "同じ" map だと思い込むことです。違います。ワーカーが受け取ったのはディープコピーです。ワーカー側で書き換えても呼び出し元には影響しません。すべての isolate 境界をシリアライゼーション境界として扱ってください。

## これが Flutter のパイプラインの残りとどう噛み合うか

特に Flutter プロジェクトでは、isolate そのものと同じくらい周辺の部品も重要です。spawn に手を伸ばす前に、まず DevTools でコールドスタートのコストをプロファイルしてください。下位の Android ではファーストフレームの処理が支配的になりがちです。ネイティブリソースをロードする長寿命ワーカーを書くなら、[method channels でプラットフォームコードに踏み込む](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)ときと同じスレッドルールが適用されます。Android では、ワーカー isolate からの `MethodChannel` 呼び出しはサポートされていません (デフォルトで binary messenger を持つのはルート isolate だけです)。CI での再現性のためには、Flutter と Dart の両方を明示的にピンし、isolate を多用するテストを出荷するすべてのバージョンで走らせてください。[マトリクス CI ワークフロー](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)は、spawn のコストやコーデックが下で変わったリグレッションを掴まえる一番安い方法です。そしてハングするワーカーをデバッグするときは、[Windows から iOS をデバッグするワークフロー](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)が、observer port にネットワーク越しでアタッチしてワーカーのスタックフレームをライブで見る方法をカバーしています。

ルールの一番短い形: `await` を書いたのに UI がまだ固まるなら、await したチェーンのどこかに同期処理があります。一回だけの呼び出しには `Isolate.run`、Flutter の中で生きていて import を一つ減らしたいなら `compute`、ワーカーに温めておく価値のあるセットアップ状態があるなら `Isolate.spawn` と独自のポートプロトコル。それ以外 (型のテーブル、クロージャの罠、web の注意点) はその 3 つの選択肢のまわりの事務処理にすぎません。

## Source links

- [Dart concurrency and isolates](https://dart.dev/language/concurrency)
- [Isolate.run API reference](https://api.dart.dev/stable/dart-isolate/Isolate/run.html)
- [Isolate.spawn API reference](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- [Flutter compute function](https://api.flutter.dev/flutter/foundation/compute.html)
- [TransferableTypedData](https://api.dart.dev/stable/dart-isolate/TransferableTypedData-class.html)
- [`@pragma('vm:isolate-unsendable')` annotation](https://github.com/dart-lang/sdk/blob/main/runtime/docs/pragmas.md)
