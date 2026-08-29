---
title: "Dart の isolate とスレッドの違いは何ですか?"
description: "スレッドはプロセス内の他のすべてのスレッドとメモリを共有しますが、Dart の isolate は共有しません。isolate は自分のヒープを所有し、単一のイベントループを回し、他の isolate とはメッセージだけでやり取りします。VM レベルでそれが何を意味するのか、isolate group がどこで境界を曖昧にするのか、そして Flutter、FFI、web でどう現れるのかを解説します。"
pubDate: 2026-08-29
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "threading"
lang: "ja"
translationOf: "2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread"
translatedBy: "claude"
translationDate: 2026-08-29
---

スレッドはプロセスのヒープを他のすべてのスレッドと共有する実行コンテキストであり、だからこそスレッドを使うコードにはロック、アトミック操作、メモリバリアが必要になります。Dart の isolate は自分自身のメモリを所有して単一のイベントループを回す実行コンテキストで、他の isolate に届く唯一の手段はポート経由でメッセージを送ることです。実務上の帰結として、Dart には `lock` キーワードも `volatile` もなく、Dart オブジェクト上のデータ競合も起きません。その代償として、他の isolate に渡すものはすべてコピーされます。2 つある抜け道を使わない限りは、という条件つきです。isolate は実際には VM が管理するプールから取り出した本物の OS スレッド上で動きますが、その対応は 1 対 1 ではなく、あなたがそれを前提にコードを書くことはありません。以下の内容はすべて Dart 3.12.2 と Flutter 3.44.7 を対象にしています。

計算処理で UI がフリーズしていて、それを直すコードが欲しくてここに来たのであれば、実装の手順は [CPU バウンドな処理のための Dart の isolate の書き方](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)にまとまっています。この記事はその下にあるモデルの話です。isolate まわりのバグの多くは、実のところ isolate が何であるかについての誤ったメンタルモデルが原因だからです。

## モデル: isolate ごとに 1 つのヒープと 1 つのイベントループ

Dart 言語のドキュメントは 1 文でこう言い切っています。「isolate はスレッドやプロセスに似ていますが、各 isolate は自分のメモリと、イベントループを回す単一のスレッドを持ちます」。ここには 2 つの主張が詰まっていて、そのどちらも重要です。

自分のメモリを持つとは、各 isolate がすべてのグローバル変数と静的フィールドについて自分のコピーを持つということです。トップレベルの `int requestCount = 0` はプログラム内の 1 つの変数ではなく、isolate ごとに 1 つの変数です。ワーカー側でそれを変更してもメインの isolate のコピーは無傷のままです。ドキュメントの表現では「各 isolate は自分のグローバルフィールドを持ち、ある isolate の状態が他のどの isolate からもアクセスできないことが保証されます」。

単一のイベントループを持つとは、isolate がイベントを 1 つずつ、ずっと処理し続けるということです。概念的には次のようなループになります。

```dart
// The Dart event loop, conceptually. Dart 3.12.
while (eventQueue.waitForEvent()) {
  eventQueue.processNextEvent();
}
```

いったん始まったイベントを何かが横取りすることはありません。JSON のパースに 90 ミリ秒を費やすコールバックは、その 90 ミリ秒のあいだループを占有し、すべてのタイマー、完了した future、そして Flutter ではすべてのフレームがその後ろで待ちます。これはスレッドとは正反対です。スレッドは OS のスケジューラーが命令の途中で停止させ、別のスレッドを走らせることができます。

この 2 つを合わせるとアクターモデルになります。隔離された状態、逐次的な処理、メッセージパッシングです。ドキュメントはこう述べています。「isolate 間で状態を共有しないということは、ミューテックスやロック、データ競合といった並行処理の複雑さが発生しないということです」。

## Dart では書けない競合状態

違いを体感するにはこれが一番わかりやすい例です。C# では次のコードは本物の競合であり、直すには `Interlocked` かロックが必要です。

```csharp
// C# 14, .NET 11. Two threads, one heap, one bug.
static int _counter;

var t1 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
var t2 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
t1.Start(); t2.Start(); t1.Join(); t2.Join();
Console.WriteLine(_counter); // Not 200000. Ever, reliably.
```

Dart に翻訳したものは競合しませんが、初めて見た人が期待する動きもしません。

```dart
// Dart 3.12.
import 'dart:isolate';

int counter = 0; // one copy per isolate, not one per program

void bump(int times) {
  for (var i = 0; i < times; i++) {
    counter++;
  }
}

Future<void> main() async {
  await Future.wait([
    Isolate.run(() { bump(100000); return counter; }),
    Isolate.run(() { bump(100000); return counter; }),
  ]);
  print(counter); // 0
}
```

生成された各 isolate は自分の `counter` を 100000 まで増やし、それを抱えたまま終了します。メインの isolate は `0` を表示します。追いかけるべき破損した読み取りもなければ、追加すべきロックもありません。そもそも奪い合う単一の変数が存在しなかったからです。戻ってくる必要のある値はすべてメッセージとして戻るしかなく、`Isolate.run` の戻り値はまさにそれです。

## isolate を実際に動かしているもの: VM のスレッドプール

isolate は宙に浮いているわけではありません。Dart VM は isolate を OS スレッド上で実行しており、その関係のルールは Vyacheslav Egorov による Dart VM 内部解説に記されています。

OS スレッドは「一度に 1 つの isolate にしか入れません。別の isolate に入りたければ、現在の isolate から出る必要があります」。逆方向についても「1 つの isolate に同時に関連づけられる mutator スレッドは 1 つだけです。mutator スレッドとは、Dart のコードを実行し、VM の公開 C API を使うスレッドのことです」とあります。

つまり不変条件は双方向で「一度に 1 つ」であって、「永続的に 1 対 1」ではありません。異なる OS スレッドが別々のタイミングで同じ isolate を実行できますし、1 つの OS スレッドが生涯のうちに複数の isolate を担当することもあります。VM は `new Thread()` がデリゲートにスレッドを専有させるようには、isolate にスレッドを専有させません。「VM は内部で OS スレッドを管理するためにスレッドプールを使っており、コードは OS スレッドという概念ではなく ThreadPool::Task という概念を中心に構成されています」。ガベージコレクションや JIT コンパイルのようなバックグラウンド処理は、タスクとしてそのプールに投入されます。

コードを書く側にとっての結論は、isolate があなたが推論する単位であり、スレッドはその下の実装詳細だということです。isolate をコアに固定することはできませんし、スレッドハンドルを期待するネイティブ API に isolate を渡すこともできません。そして、あなたの isolate の OS スレッドとしての同一性が中断ポイントをまたいで保たれると仮定してはいけません。

## isolate group: 言語が隠している共有ヒープ

ここで「各 isolate は自分のメモリを持つ」という説明が、実装レベルでは文字どおりには成り立たなくなります。パフォーマンスの数字を説明してくれるので、知っておく価値があります。

Dart 2.15 以降、VM は isolate を isolate group にまとめています。`Isolate.spawn` と `Isolate.run` は現在のグループの中に新しい isolate を作り、`Isolate.spawnUri` だけがプログラムの新しいコピーとともに新しいグループを開始します。グループ内では VM がプログラムの構造を共有しており、VM 内部解説の言葉を借りれば、グループ内の isolate は「同じガベージコレクション管理下のヒープを共有します」。

Dart 2.15 のアナウンスはその成果を数値で示しています。既存グループ内で追加の isolate を起動するのは「100 倍以上高速」で、そうした isolate はグループ導入以前と比べて「10 分の 1 から 100 分の 1 のメモリしか消費しません」。だからこそ `spawnUri` は遅い経路であり、実際に使うのは `spawn` なのです。

言語レベルの保証は変わりません。他の isolate のオブジェクトには依然として到達できず、隔離はヒープより上のレイヤーで強制され、共有ヒープは実装詳細のままです。ただし、それによって次の 2 つが可能になっています。

## コピーが代償であり、抜け道は 2 つある

既定では、`SendPort` でオブジェクトを送るとそのオブジェクトグラフ全体がコピーされます。50000 エントリの `Map` を送れば受信側の isolate はディープコピーを受け取り、そこで変更しても送信側からは見えません。ほとんどの Dart オブジェクトは送信できます。ドキュメント化されている例外は `Socket` のようなネイティブリソースに支えられたオブジェクトと、`ReceivePort`、`DynamicLibrary`、`Finalizable`、`Finalizer`、`NativeFinalizer`、`Pointer`、`UserTag`、そして `@pragma('vm:isolate-unsendable')` が付いたものです。それ以外は、ドキュメントいわく「どんなオブジェクトでも送信できます」。

1 つ目の抜け道は `Isolate.exit` です。これは「現在の isolate を同期的に終了」させ、最後のメッセージを引き渡します。送信側と受信側は同じグループ、つまり同じヒープ上にいるため、「この最後のメッセージのオブジェクトグラフはコピーされずに受信側の isolate へ再割り当てされます」。コピーは発生しませんが、代償として isolate はその場で終了します。保留中の `finally` ブロックは実行されず、キューに入った非同期処理も実行されません。

たいていの場合、これは自動的に手に入ります。Dart 2.19 で追加された `Isolate.run` は、結果をコピーなしで返すためにまさに `Isolate.spawn` と `Isolate.exit` の上に実装されています。

```dart
// Dart 3.12. One-shot work, result transferred rather than copied.
final parsed = await Isolate.run(() {
  final text = File('bulk.json').readAsStringSync();
  return jsonDecode(text) as Map<String, dynamic>;
});
```

2 つ目の抜け道は `TransferableTypedData` で、バイトバッファの所有権をコピーせずに isolate 間で移動させます。ペイロードがオブジェクトグラフではなくバイト列 (画像、ダウンロードしたファイル、デコード済みの音声バッファ) のときに使ってください。

大きな結果を繰り返し送っていることに気づいたら、Flutter 自身のガイドが明言しているトレードオフに注意してください。「新しい isolate の生成にも、isolate 間でのオブジェクトのコピーにもパフォーマンス上のオーバーヘッドがあります。同じ計算を `Isolate.run` で繰り返し実行しているなら、すぐには終了しない isolate を作ったほうがパフォーマンスが良くなる場合があります」。

## async/await もスレッドではありません

この周辺で最も多い誤解は、`await` が処理を現在の isolate の外へ移すというものです。移しません。`Future`、`Stream`、`await` は、すでにあなたがいる isolate の単一のイベントループ上のスケジューリング構文です。ソケット読み取りを await すると、OS が I/O を行うあいだループを譲るので、ネットワークやファイルの処理には非同期だけで足ります。密なループで 200 ミリ秒を消費する関数を await しても何も譲りません。その内部に中断ポイントがないからです。

原則は短く言えます。非同期は待つためのもの、isolate は計算するためのものです。重いものが同期的な CPU 処理なら、それをループから外せるのは isolate だけです。結果をウィジェットに戻すのであれば、[FutureBuilder と StreamBuilder と Riverpod の AsyncValue の比較](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)がどの非同期プリミティブで見せるべきかを扱っています。

## Flutter でスレッドモデルが透けて見える場所

Flutter はアプリをメイン isolate (ルート isolate とも呼ばれます) で実行します。Flutter のドキュメントいわく「Flutter アプリはすべての処理を単一の isolate、つまりメイン isolate で行います」、そして「すべての UI タスクと Flutter 自身がメイン isolate に結びついています」。

その下でエンジンは実際にラスタライズ、I/O、プラットフォーム処理のために複数の OS スレッドを使っており、その構成は最近変わりました。Flutter 3.29 以降、「iOS と Android では UI スレッドとプラットフォームスレッドが統合されています。具体的には UI スレッドが廃止され、Dart のコードはネイティブのプラットフォームスレッド上で動作します」。これは isolate レベルに対応物のないスレッドの変更であり、2 つのレイヤーが独立していることをよく示しています。あなたの Dart コードは別の isolate に移ったのではなく別の OS スレッドに移ったのであり、isolate モデルの側では誰も気づきませんでした。

バックグラウンド isolate で人を刺す帰結が 2 つあります。

- UI もアセットも扱えません。「生成した isolate では `rootBundle` を使ってアセットにアクセスすることも、ウィジェットや UI の処理を行うこともできません」。`dart:ui` のオブジェクトはすべてメイン isolate に属します。
- プラットフォームチャネルには初期化が必要です。バックグラウンド isolate 向けのプラットフォームチャネルが入って以降、ワーカーから Android や iOS を呼び出せますが、それはルート isolate の messenger に登録したあとに限られ、それでも「ホストプラットフォームからの非要求メッセージは受け取れません」。

```dart
// Dart 3.12, Flutter 3.44.7. Platform channels from a background isolate.
Future<void> _isolateMain(RootIsolateToken rootIsolateToken) async {
  BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken);
  final prefs = await SharedPreferences.getInstance();
  // ... plugin calls now work here
}
```

フレーム落ちを追っていて、そもそも isolate が答えなのかまだ確信が持てないなら、まず計測してください。[DevTools でジャンクをプロファイルする手順](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)では、長い同期コールバックとレイアウトやラスタライズの問題を見分ける方法を説明しています。この 2 つは対処法がまったく違います。処理がプラットフォーム側に属すると判明した場合は、[プラグインを書かずにプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)のほうが安上がりです。

## 本物のスレッドに触れるのは FFI

下にあるスレッドが見えてくる唯一の場所が `dart:ffi` です。同期的な FFI 呼び出しは、その時点で isolate の mutator スレッドになっている OS スレッド上で実行され、戻るまでそのスレッドを、したがって isolate のイベントループをブロックします。長いネイティブ呼び出しをワーカー isolate に置くべき理由は、長い Dart のループの場合とまったく同じです。

逆方向のコールバックも「1 スレッドにつき 1 isolate」という同じルールに縛られており、だからこそ `NativeCallable` (Dart 3.1) には複数の種類があります。`NativeCallable.isolateLocal` は「それを作成したのと同じスレッドから呼び出す必要があり」、一方 `NativeCallable.listener` と `NativeCallable.isolateGroupBound` は「任意のスレッドから呼び出せます」。ネイティブライブラリが自前のワーカースレッドからコールバックしてくるなら、`isolateLocal` はクラッシュ予備軍であり、欲しいのは `listener` のほうです。

## web にはどちらもありません

web には isolate がそもそも存在しません。JavaScript にコンパイルされた Dart はブラウザーの単一スレッドで動くため、`compute` は並列化する代わりに穏やかに縮退します。「web プラットフォームでは、これは現在のイベントループ上で callback を実行します。ネイティブプラットフォームでは、これは別の isolate で callback を実行します」。ブラウザー側の答えは web worker ですが、そのまま置き換えられるものではありません。「web worker を作れるのは、別のプログラムのエントリーポイントを宣言して別々にコンパイルした場合だけ」であり、しかも isolate が持つ転送 API なしで境界越しにデータをコピーするからです。

あるコードパスがフレーム予算を守るために並列性に依存しているなら、web では別途テストしてください。動きはしますが、ブロックします。

## これから変わること

厳格なモデルには既知のコストがあります。ゲーム、物理演算、画像処理パイプラインは、論理的には 1 つの計算に属するデータのコピー代を払わされます。Dart チームは選択的な緩和を検討しており、その作業は dart-lang/sdk の共有メモリマルチスレッドのアンブレラ issue で追跡され、Vyacheslav Egorov による言語提案があります。第 1 フェーズは共有ネイティブメモリを対象とし、共有 isolate、自明に共有可能な型に対する `@pragma('vm:shared')` を付けた静的フィールド、任意のネイティブスレッドから isolate group を呼び出す仕組みが含まれます。`NativeCallable.isolateGroupBound` はその作業の見えている先端です。

いずれも既定のモデルを変えるものではなく、Dart 3.12 の時点では実験的なものとして扱い、これを前提に設計する前にトラッキング issue を読むべきです。今日のプロダクションコードにとって安全な前提は変わりません。isolate は自分の状態を所有し、メッセージはコピーであり、コピーを避ける手段は `Isolate.exit` と `TransferableTypedData` だけです。

## 正しいメンタルモデルを選ぶ

- ロックに手が伸びたなら、その問題をスレッドとしてモデリングしています。Dart にロックする対象はありません。メッセージとして組み直してください。
- 大きなオブジェクトを 2 つの isolate で共有することはできません。コピーを送るか、`Isolate.exit` か `TransferableTypedData` で一度だけ転送するか、1 つの isolate に置いたままその isolate にコマンドを送るかです。
- `await` がスレッドを増やすことはありません。並列性を増やすのは isolate だけで、しかもネイティブターゲットに限られます。
- 同じ計算を何度も行うなら、長寿命ワーカーのほうが `Isolate.run` の繰り返しより有利です。生成もコピーも無料ではないからです。
- スレッドの同一性が問題になるのは Dart ではなく FFI です。ネイティブ側がどのスレッドから呼ぶかに合わせて `NativeCallable` のコンストラクターを選んでください。

## 参考リンク

- [Concurrency in Dart](https://dart.dev/language/concurrency)
- [Concurrency and isolates、Flutter ドキュメント](https://docs.flutter.dev/perf/isolates)
- [Introduction to Dart VM、スレッドと isolate の内部](https://mrale.ph/dartvm/)
- [Announcing Dart 2.15、isolate group](https://dart.dev/blog/announcing-dart-2-15)
- [Better isolate management with Isolate.run](https://dart.dev/blog/better-isolate-management-with-isolate-run)
- [Isolate.exit の API リファレンス](https://api.dart.dev/stable/dart-isolate/Isolate/exit.html)
- [NativeCallable の API リファレンス](https://api.dart.dev/stable/dart-ffi/NativeCallable-class.html)
- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
- [Explore shared memory multithreading, dart-lang/sdk#55991](https://github.com/dart-lang/sdk/issues/55991)
