---
title: "Flutter で runZonedGuarded と PlatformDispatcher.instance.onError を使って捕捉されない非同期エラーをキャッチする方法"
description: "FlutterError.onError が受け取るのは、フレームワークのコールバック内で投げられたエラーだけです。await しない Future、タイマー、ストリーム、await の後のコードで起きたエラーは別の場所に流れます。どのハンドラーがどのエラーを捕捉するかを Flutter 3.44.8 で計測し、Web を含めてすべてを捕捉する main() の設定を紹介します。"
pubDate: 2026-10-18
template: how-to
tags:
  - "flutter"
  - "dart"
  - "error-handling"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher"
translatedBy: "claude"
translationDate: 2026-10-18
---

**結論:** Flutter 3.44 では、ハンドラーは 1 つではなく 2 つ必要です。`FlutterError.onError` が受け取るのは、フレームワークのコールバック (build、レイアウト、描画、同期的な `onPressed`) 内で投げられたエラーです。それ以外で、ルート isolate の誰も捕捉しなかったエラーはすべて `PlatformDispatcher.instance.onError` が受け取ります。たとえば await しない `Future`、`Timer` のコールバック、`onError` のないストリーム、`await` の後に実行されるコード (`async` なボタンハンドラーの本体を含む) です。`main()` の先頭で両方を設定し、ディスパッチャーのコールバックから `true` を返してください。`runZonedGuarded` は後者のエラーを捕捉する従来の方法で、Flutter Web ではいまでも唯一の方法です。Web エンジンは `PlatformDispatcher.onError` を一度も呼び出さないためです。自分で spawn した isolate 内で投げられたエラーは、`onError` ポートを渡さない限り、どちらのハンドラーにも届きません。

以下はすべて Flutter 3.44.8 (stable) と Dart 3.12.2 で計測したものです。各種のエラーを発生させ、どのハンドラーが受け取ったかをログに記録する macOS デスクトップアプリのリリースビルドを使いました。ハンドラーのルーティングは共有のエンジンとフレームワークのコードにあるため、Android と iOS でも同じです。

## FlutterError.onError が非同期エラーを捕捉しない理由

"クラッシュレポーターがこのエラーを検知しない"という疑問の多くは、`FlutterError.onError` をグローバルな捕捉用ハンドラーだと思い込んでいることから生じます。そうではありません。フレームワークは自身の `try`/`catch` ブロックからこれを呼び出します。ウィジェットの `build` が例外を投げたとき、`RenderObject` がレイアウトや描画中に例外を投げたとき、ジェスチャー認識のコールバックが例外を投げたとき、スケジューラーのコールバックが例外を投げたとき、プラットフォームメッセージのハンドラーが例外を投げたときです。これらの箇所ではいずれも、エラーを "while handling a gesture" や "during a platform message callback" のような `context` 文字列を持つ `FlutterErrorDetails` に包み、`FlutterError.reportError` に渡します。`FlutterError.reportError` が `FlutterError.onError` を呼び出します。

呼び出しスタックにフレームワークのフレームが存在しない状態で投げられたエラーは、これらの `try`/`catch` ブロックを通りません。次のボタンを考えてみましょう。

```dart
// Flutter 3.44.8, Dart 3.12.2
ElevatedButton(
  onPressed: () async {
    await api.save();          // throws SocketException
    showSnackBar('Saved');
  },
  child: const Text('Save'),
)
```

ジェスチャー認識が `onPressed` を呼び出し、クロージャーは最初の `await` まで実行されて `Future` を返し、認識側の `try` ブロックは正常に終了します。後で `api.save()` が失敗すると、その例外がこの `Future` をエラーで完了させます。誰もこれを待機していない (認識側は戻り値を無視した) ため、エラーは "uncaught" となり、ゾーンのチェーンを上っていきます。ルートゾーンでは、Flutter エンジンがこれを `PlatformDispatcher.instance.onError` に渡します。これが設定されていなければ、ログに出力されて無視されます。アプリは動き続けるので、ユーザーが"ボタンを押しても何も起きない"と報告するまで、こうしたエラーに気づかないことがよくあります。

## ハンドラーの対応表 (計測結果)

Flutter 3.44.8 で小さな macOS アプリを作り、最初のフレームの後に 1 回の実行につき 1 種類のエラーを発生させ、どのハンドラーが受け取ったかをログに記録しました。設定はドキュメントどおりで、`main()` に `FlutterError.onError` と `PlatformDispatcher.instance.onError` を置き、ゾーンは使っていません。

| 投げられた場所 | 受け取ったハンドラー |
| --- | --- |
| `onPressed` 内の同期的な throw | `FlutterError.onError` (context: "while handling a gesture") |
| `build` 内の throw | `FlutterError.onError` |
| `async` な `onPressed` で `await` の後に throw | `PlatformDispatcher.instance.onError` |
| await しない `Future.delayed(..., () => throw ...)` | `PlatformDispatcher.instance.onError` |
| `Timer` のコールバック | `PlatformDispatcher.instance.onError` |
| `onError` のない `Stream.error(...).listen((_) {})` | `PlatformDispatcher.instance.onError` |
| 存在しないチャンネルに対する await しない `MethodChannel.invokeMethod` | `PlatformDispatcher.instance.onError` (`MissingPluginException`) |
| await しない `Isolate.run(() => throw ...)` | `PlatformDispatcher.instance.onError` |
| 例外を投げる `Isolate.spawn` のエントリーポイント、`onError` ポートなし | どちらでもない。エンジンが `dart_isolate.cc` から `Unhandled exception` を出力した |
| 同上で、`onError: port.sendPort` を指定 | `RawReceivePort` のリスナー |

`Isolate.run` がディスパッチャーに届くのは、子 isolate のエラーをルート isolate で返される `Future` に再スローし、その `Future` を await していなかったためです。素の `Isolate.spawn` はそうなりません。エラーは子 isolate とともに消えます。エンジン自身の `onError` のドキュメントコメントにも、"is not directly invoked by errors in child isolates of the root isolate." とはっきり書かれています。

## 推奨される main() をステップごとに解説

この設定は、Android、iOS、macOS、Windows、Linux で上の表のすべての行を捕捉します。

1. `runApp` の前に非同期の処理 (クラッシュレポーターの初期化、設定の読み込み) を行う場合は、最初に `WidgetsFlutterBinding.ensureInitialized()` を呼び出します。
2. `FlutterError.onError` を設定します。デバッグビルドで赤いエラーボックスとコンソールへのダンプが引き続き表示されるよう、内部で `FlutterError.presentError(details)` を呼び出し、そのうえで `details.exception` と `details.stack` をレポーターに転送します。
3. `PlatformDispatcher.instance.onError` を設定します。エラーとスタックを転送し、`true` を返します。
4. `runApp` を呼び出します。
5. `Isolate.spawn` で作成するすべての isolate に `onError` ポートを渡し、届いたものを同じレポーターに転送します。

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ErrorReporter.instance.initialize();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details); // keep the debug console output
    ErrorReporter.instance.report(
      details.exception,
      details.stack ?? StackTrace.empty,
      fatal: false,
      context: details.context?.toDescription(),
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
    return true; // handled: do not print the default "Unhandled Exception"
  };

  runApp(const MyApp());
}

// For isolates you spawn yourself.
Future<Isolate> spawnReported<T>(void Function(T) entry, T message) {
  final errors = RawReceivePort((Object? pair) {
    final list = pair! as List<Object?>;
    ErrorReporter.instance.report(
      list[0]!,
      StackTrace.fromString(list[1]! as String),
      fatal: false,
    );
  });
  return Isolate.spawn(entry, message, onError: errors.sendPort);
}
```

`onError` ポートが受け取るのは 2 要素のリストで、エラーの `toString()` とスタックトレースの文字列です。isolate の境界で元の例外の型は失われるため、`is` で判定しようとせず、文字列のままログに記録してください。

Firebase Crashlytics を使う場合、ドキュメントにある設定も同じ形です。`FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError` とし、`PlatformDispatcher.instance.onError` では `recordError(error, stack, fatal: true)` を呼び出して `true` を返します。Sentry を含む他のクラッシュ SDK も、自身の初期化中に同等のハンドラーを設定します。そのため、前のハンドラーに連鎖させずに後から上書きしないでください。

## PlatformDispatcher.onError の戻り値の意味

コールバックの戻り値の型は `bool` で、これには意味があります。エンジンのドキュメントでは、エラーを処理した場合は `true` を返し、そうでなければ `false` を返すと、"a fallback mechanism such as printing to stderr will be used" とされています。await しない `Future` のケースで、コールバックが `false` を返すようにして実行してみました。コールバックは実行され、そのうえでエンジンも完全なスタックとともに `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: unawaited Future` を出力しました。`true` を返した場合は、自分のハンドラーだけが実行されました。

どちらの場合もプロセスは終了しませんでした。Flutter では、捕捉されない Dart のエラーでアプリはクラッシュしません。イベントループは次のイベントの処理に進みます。ユーザーにとっては好都合ですが、可視性の面では不都合です。症状が中途半端に終わった操作だけになるからです。フェイルファストの方針にしたい場合は、ハンドラー内で自分で実装してください (たとえば、Flutter のドキュメントが `FlutterError.onError` で示しているように `if (kReleaseMode) exit(1);` とします)。ただし、出荷前によく検討してください。

## runZonedGuarded: それでも必要になる場面

Flutter 3.3 (2022 年 8 月) で `PlatformDispatcher.onError` が追加される前は、`runApp` を `runZonedGuarded` で包み、そのゾーンで動くコードが起こした非同期エラーをルートゾーンではなくゾーンの `onError` コールバックに届けるのが標準的な方法でした。この方法はいまでも動作し、ディスパッチャーと同じ行を捕捉することを確認しました。

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      ErrorReporter.instance.report(details.exception, details.stack ?? StackTrace.empty);
    };
    runApp(const MyApp());
  }, (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
  });
}
```

この設定では、await しない `Future`、`onPressed` 内の `await` の後の throw、await しない `Isolate.run` のすべてがゾーンのコールバックに届きました。`build` のエラーは、ゾーンのエラーになる前にフレームワークが捕捉するため、やはり `FlutterError.onError` に届きました。つまり、ゾーンが置き換えるのはディスパッチャーであり、`FlutterError.onError` ではありません。

両方を設定した場合 (ガードされたゾーンの内側でディスパッチャーを設定した場合) は、ゾーンが優先されます。私の実行では、await しない `Future` に対して発火したのは `runZonedGuarded` のコールバックだけで、`PlatformDispatcher.instance.onError` は一度も呼ばれませんでした。エラーはルートゾーンに届く前に処理されたためです。実害はありませんが、ディスパッチャーに依存するクラッシュ SDK は、自分のゾーン内で起きたエラーを何も受け取れないということです。どちらか一方の仕組みを選んでください。

2026 年にもゾーンを使い続ける理由は 3 つあります。

- **Flutter Web。** Web エンジンはコールバックを保存するだけで、呼び出しません。3.44.8 のソースでは、`lib/web_ui/lib/src/engine/platform_dispatcher.dart` のセッターの上に `// TODO(dnfield): make this work on web.` と書かれており、追跡用の issue [flutter/flutter#100277](https://github.com/flutter/flutter/issues/100277) はまだ open のままです。Web では、`runZonedGuarded` が非同期エラーをグローバルに捕捉する唯一の方法です。
- **ゾーンの値。** `zoneValues` (リクエスト単位のロガー、テスト用のクロックなど) を使っているなら、すでにゾーンをフォークしているので、そこにエラーハンドラーを追加できます。
- **スコープを限定した処理。** ゾーンで単一のサブシステム (たとえば同期ジョブ) を包めば、そのエラーにタグを付け、アプリの他の部分とは別にルーティングできます。

Web にも出荷するクロスプラットフォームアプリでは、現実的な設定は次のとおりです。ディスパッチャーのハンドラーを設定し (モバイルとデスクトップをカバーします)、`kIsWeb` が true の場合にのみ `main` の本体を `runZonedGuarded` で包みます。どちらのコールバックも同じレポーターを指すようにしてください。

## "Zone mismatch" 警告

Flutter 3.10 以降、デバッグビルドでは、バインディングの初期化が、後で `runApp` を呼び出すのと同じゾーンで行われたかどうかが検査されます。よくある誤ったコードは次のとおりです。

```dart
// Flutter 3.44.8: triggers "Zone mismatch" in debug builds
void main() {
  WidgetsFlutterBinding.ensureInitialized(); // root zone
  runZonedGuarded(() => runApp(const MyApp()), reportError); // child zone
}
```

私のデバッグビルドでは、これがコンテキスト "during runApp" として `FlutterError.onError` に報告されました。

```text
Zone mismatch.
The Flutter bindings were initialized in a different zone than is now being used.
```

これはクラッシュではなく警告で、私の実行では、`initState` が `runApp` のゾーン内で実行されたため、await しない `Future` は引き続きゾーンのコールバックに届きました。危険なのは、バインディングがルートゾーンにいる間にエンジンへ登録したコールバックです。ポインターイベント、プラットフォームメッセージ、フレームコールバックは、登録時に有効だったゾーンで呼び出されます。これらの経路で起きたエラーはガードされたゾーンをすり抜ける可能性があり、これこそが警告の述べている不整合です。対処法は、`ensureInitialized()` (およびそれを必要とする `await`) を、前のセクションのように `runZonedGuarded` の本体の内側に移すことです。CI でこれを失敗させたい場合は、`main` の最初の文として `BindingBase.debugZoneErrorsAreFatal = true` を設定してください。

## それでもエラーが隠れてしまう落とし穴

- **何も返さない `catchError`。** `Future<int>` に対する `future.catchError((e) => log(e))` は、Dart 3 では実行時に `ArgumentError` を投げます。ハンドラーは future の型の値を返さなければならないためです。代わりに `try`/`await`/`catch` を使ってください。
- **`unawaited()` が隠すのは意図であり、エラーではありません。** 呼び出しを `unawaited(...)` で包むと `unawaited_futures` の lint は出なくなりますが、エラーはやはりディスパッチャーに届きます。多くの場合それが望む動作ですが、エラー処理とは考えないでください。
- **`onError` のない `StreamSubscription`。** そのようなサブスクリプションのエラーイベントはすべて、捕捉されなかったエラーとして報告されます。長く生きるストリームが繰り返しエラーを出すと、レポーターにはイベントごとに 1 件のレポートが届きます。自分で持つサブスクリプションには `onError` を追加し、キャンセルも行ってください。キャンセルについては [StreamSubscription を dispose でキャンセルするガイド](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)で扱っています。
- **ネイティブのクラッシュ。** プラグインの Kotlin、Swift、C のコードでのセグメンテーション違反は、Dart には届きません。これらには、クラッシュ SDK のネイティブ側が必要です。
- **`flutter test`。** テストフレームワークは各テストを専用のゾーンで実行し、捕捉されなかったエラーがあるとテストを失敗させます。そのため、`main()` で設定したハンドラーはウィジェットテストでは実行されません。レポートのテストは、ハンドラー関数を直接呼び出して行ってください。
- **SDK とのハンドラーの順序。** SDK が `FlutterError.onError` を設定した後で自分でも代入すると、気づかないうちに置き換えてしまいます。以前の値を保存しておき (`final previous = FlutterError.onError;`)、自分のハンドラーから呼び出してください。

## 関連記事

- [Flutter アプリでネットワークエラーを適切に処理する方法](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)では、エラーを発生した場所で捕捉する方法を扱っています。グローバルハンドラーに頼るより、常にこちらのほうが優れています。
- [CPU バウンドな処理のために Dart の isolate を書く方法](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)では、`Isolate.run` と `Isolate.spawn` の違いを説明しています。この違いが、isolate のエラーがそもそもルート isolate に届くかどうかを決めます。
- [Dart の isolate とスレッドの違いは何か](/ja/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/)では、エラーがオブジェクトとして isolate の境界を越えられない理由を説明しています。
- [Flutter で await の後に BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)では、`async` なボタンハンドラーにあるもう 1 つの典型的なバグを扱っています。

## 参考資料

- Flutter docs: [Handling errors in Flutter](https://docs.flutter.dev/testing/errors)
- Flutter docs: [Zone mismatch message](https://docs.flutter.dev/release/breaking-changes/zone-errors) and [flutter/flutter#122836](https://github.com/flutter/flutter/pull/122836)
- API reference: [PlatformDispatcher.onError](https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html), [FlutterError.onError](https://api.flutter.dev/flutter/foundation/FlutterError/onError.html), [runZonedGuarded](https://api.dart.dev/stable/dart-async/runZonedGuarded.html), [Isolate.spawn](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- Issue: [Implement PlatformDispatcher.onError for web (flutter/flutter#100277)](https://github.com/flutter/flutter/issues/100277)
- Firebase: [Customize your Crashlytics crash reports (Flutter)](https://firebase.google.com/docs/crashlytics/flutter/customize-crash-reports)
