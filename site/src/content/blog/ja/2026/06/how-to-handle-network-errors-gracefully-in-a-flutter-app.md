---
title: "Flutter アプリでネットワークエラーを適切に処理する方法"
description: "リクエストは、接続なし、タイムアウト、DNS の失敗、500、不正な JSON など少なくとも 5 通りの形で失敗し、それぞれに異なる対応が必要です。正しい例外をキャッチし、分類し、安全にリトライし、ユーザーが対処できる UI を表示する方法を解説します。"
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "networking"
lang: "ja"
translationOf: "2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app"
translatedBy: "claude"
translationDate: 2026-06-01
---

Flutter のネットワーク呼び出しは少なくとも 5 通りの異なる形で失敗し、適切なアプリはそれぞれを別々に扱います。接続なし、接続タイムアウト、DNS またはソケットの失敗、2xx 以外の HTTP ステータス、そして不正または予期しないレスポンスボディです。解決策は、裸の `catch (e)` ではなく具体的な例外の型をキャッチし、それをユーザーに見える少数の状態（オフライン、タイムアウト、サーバーエラー、リトライ可能、致命的）にマッピングし、呼び出しをタイムアウトと上限付きの backoff リトライで包み、決して解決しないスピナーの代わりにユーザーが実際に対処できる状態をレンダリングすることです。本ガイドでは Flutter 3.44（stable、2026 年 5 月）、Dart 3.x、パッケージ `http` 1.x、`dio` 5.9.2、`connectivity_plus` 7.1.1 を使用します。

ほぼすべての Flutter アプリが初期に犯す誤りは、「ネットワーク」を単一の失敗モードとして扱うことです。呼び出しを `try`/`catch` で包み、「問題が発生しました」と表示するスナックバーを出して先に進みます。しかし「Wi-Fi がない」と「サーバーが 503 を返した」は同じ問題ではなく、汎用的なエラーを見つめるユーザーには、リトライすべきか、待つべきか、あきらめるべきか分かりません。さらに悪いことに、最も一般的なエラーは catch にすら到達しません。タイムアウトがなかったために決して完了しない `Future` が、スピナーを永遠に回し続けるのです。

## Flutter の HTTP 呼び出しが実際に投げる例外

`dart:io` とパッケージ `http` を使うと、失敗したリクエストは型付きの例外として現れ、その型が何が悪かったのかを教えてくれます。

- `SocketException` は、接続そのものを確立できないか切断されたときに投げられます。ホストへのルートがない、DNS 解決が失敗した、接続が拒否された、またはデバイスがオフラインです。これは「ネットワークに到達できない」のグループです。
- `TimeoutException`（`dart:async` から）は、`Future` を `.timeout(...)` で包み、その時間が経過したときに投げられます。パッケージ `http` はそれ自体ではタイムアウトしないため、これを追加しないと、ハングした接続が UI を無期限にブロックします。
- `HttpException` と `ClientException` はプロトコルレベルの問題を扱います。不正なレスポンス、レスポンスの途中で閉じられた接続、またはリダイレクトのループです。
- `FormatException` は、ボディが有効な JSON でないときに `jsonDecode` が投げます。HTML のエラーページを伴う 200 OK（captive portal、プロキシ、設定ミスのゲートウェイ）はここに該当し、ネットワークのグループのいずれにも該当しません。この具体的な落とし穴は [FormatException Unexpected character のガイド](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) で扱いました。

2xx 以外のステータスは、パッケージ `http` ではそもそも例外ではありません。`http.get` は `statusCode == 500` の `Response` を返し、あなた自身でそれをチェックしなければなりません。これは、アプリが静かに空のデータを表示する最も一般的な理由です。開発者が `response.statusCode` を一度も見ずに `response.body` を JSON としてパースし、そのボディがエラーのペイロードだったのです。

## すべてを飲み込む再現コード

避けるべきパターンがこれです。コンパイルでき、速い接続では動作し、そして興味深いすべての形で失敗します。

```dart
// Flutter 3.44, Dart 3.x, http 1.x -- anti-pattern, do not copy.
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<String>> fetchNames() async {
  try {
    final response =
        await http.get(Uri.parse('https://api.example.com/names'));
    final data = jsonDecode(response.body) as List;
    return data.cast<String>();
  } catch (e) {
    return []; // every failure looks like "no data"
  }
}
```

壊れているものが 3 つあります。タイムアウトがないため、停滞した接続は永遠にハングします。ステータスが一度もチェックされないため、エラーの JSON ボディを伴う 500 は `cast` で例外を投げるか、ゴミを返します。そして `catch (e)` は、オフライン、タイムアウト、サーバーエラー、不正な JSON を 1 つの結果に潰します。空のリストであり、「サーバーに正当に名前がない」のと区別できません。UI はユーザーに何の役立つことも伝えられません。関数が、唯一重要だった情報を捨ててしまったからです。

## 失敗を、UI がレンダリングできる結果へ分類する

最初の本当の修正は、裸のデータを返すのをやめ、呼び出しがどう終わったかをエンコードする結果を返し始めることです。シールドクラスの階層（Dart 3 のシールドクラス）は、すべてのケースを処理するよう、コンパイラを通じてあなたに強制します。

```dart
// Flutter 3.44, Dart 3.x
sealed class NetworkResult<T> {
  const NetworkResult();
}

class Success<T> extends NetworkResult<T> {
  final T data;
  const Success(this.data);
}

class Offline<T> extends NetworkResult<T> {
  const Offline();
}

class TimedOut<T> extends NetworkResult<T> {
  const TimedOut();
}

class ServerError<T> extends NetworkResult<T> {
  final int statusCode;
  const ServerError(this.statusCode);
}

class BadResponse<T> extends NetworkResult<T> {
  final String detail;
  const BadResponse(this.detail);
}
```

これで、データ層はすべての例外の型とすべてのステータスをこれらのいずれかにマッピングし、未処理の throw として何も漏れ出しません。

```dart
// Flutter 3.44, Dart 3.x, http 1.x
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await http
        .get(Uri.parse('https://api.example.com/names'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode >= 500) {
      return ServerError(response.statusCode);
    }
    if (response.statusCode >= 400) {
      // 4xx is usually a client bug or auth issue, not retryable.
      return BadResponse('HTTP ${response.statusCode}');
    }

    final decoded = jsonDecode(response.body) as List;
    return Success(decoded.cast<String>());
  } on SocketException {
    return const Offline();
  } on TimeoutException {
    return const TimedOut();
  } on FormatException catch (e) {
    return BadResponse('Malformed JSON: ${e.message}');
  } on http.ClientException catch (e) {
    return BadResponse(e.message);
  }
}
```

`on` 節の順序に注目してください。Dart は上から下へ評価し、最初に一致したものを実行するため、最も具体的な例外を先に置きます。`TimeoutException` と `SocketException` は兄弟であり親子ではないため、互いの順序は問題になりませんが、`FormatException` と `ClientException` は広い `catch` よりも前に来る必要があります。ここには意図的に裸の `catch (e)` がありません。私が予期しなかった例外が投げられたら、それは静かに `BadResponse` にマッピングされるのではなく、デバッグでクラッシュし、私のエラーレポートに現れてほしいからです。

## 各分岐をウィジェットでレンダリングする

`NetworkResult` はシールドクラスなので、ウィジェット内の `switch` 式は網羅的です。新しい結果の型を追加すると、コンパイラはそれを処理していないすべての `switch` を指摘します。これがシールド階層の見返りです。

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

Widget buildBody(NetworkResult<List<String>> result, VoidCallback onRetry) {
  return switch (result) {
    Success(data: final names) => ListView(
        children: [for (final n in names) ListTile(title: Text(n))],
      ),
    Offline() => _ErrorState(
        message: 'You appear to be offline. Check your connection.',
        onRetry: onRetry,
      ),
    TimedOut() => _ErrorState(
        message: 'The request took too long. Try again.',
        onRetry: onRetry,
      ),
    ServerError(statusCode: final code) => _ErrorState(
        message: 'The server had a problem (HTTP $code). Try again shortly.',
        onRetry: onRetry,
      ),
    BadResponse(detail: final detail) => _ErrorState(
        message: 'Something went wrong. ($detail)',
        onRetry: null, // not retryable, retry will not help
      ),
  };
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: FilledButton(onPressed: onRetry, child: const Text('Retry')),
            ),
        ],
      ),
    );
  }
}
```

ユーザーにとって重要な区別はこれです。`Offline`、`TimedOut`、`ServerError` はリトライボタンを提供します。リトライが成功するかもしれないからです。`BadResponse` は提供しません。不正なペイロードや 400 は次の試行でも同じように失敗し、決して機能しないリトライボタンはボタンがないことよりも悪いからです。エラーウィジェットは 2 つ目のバグを持ち込まないようシンプルに保ってください。エラー画面そのものがオーバーフローするのは見栄えが悪く、[RenderFlex オーバーフローのガイド](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) がなぜそれが起こるのかを扱っています。

## 一時的な失敗を指数 backoff でリトライする

`Offline`、`TimedOut`、`ServerError`（具体的には 502、503、504）は一時的です。同じリクエストが数秒後に成功する可能性があります。適切なアプリはそれらを自動的に上限付きの回数だけリトライし、苦しんでいるサーバーを叩かないよう遅延を増やしていきます。4xx はリトライせず、永遠にもリトライしないでください。

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'dart:io';

Future<T> withRetry<T>(
  Future<T> Function() action, {
  int maxAttempts = 3,
  Duration baseDelay = const Duration(milliseconds: 400),
}) async {
  var attempt = 0;
  while (true) {
    attempt++;
    try {
      return await action();
    } on SocketException {
      if (attempt >= maxAttempts) rethrow;
    } on TimeoutException {
      if (attempt >= maxAttempts) rethrow;
    }
    // 2^attempt backoff: 0.8s, 1.6s, 3.2s ...
    final delay = baseDelay * (1 << attempt);
    await Future<void>.delayed(delay);
  }
}
```

`1 << attempt` は、各ラウンドで乗数を倍にするビットシフトであり、指数 backoff を書く最も安価な方法です。本番では、同じ障害から回復する 1000 のクライアントが全員同じタイミングでリトライしてサンダリングハードを起こさないよう、ジッター（小さなランダムなオフセット）も欲しくなりますが、中心となる形はこのループです。リトライが `NetworkResult` にマッピングされる前に生の例外を見るよう、`fetchNames` 関数全体ではなく HTTP 呼び出しを包んでください。リトライされるアクション内の処理が CPU 負荷の高いもの（例えば巨大なペイロードのデコード）であれば、[Dart isolate のガイド](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) で説明したように UI の isolate の外へ押し出してください。リトライはそのコストを倍増させるからです。

## dio は型付きエラーとリトライ用の interceptor を提供する

パッケージ `http` でも問題ありませんが、`dio` 5.9.2 はすべての失敗を単一の `DioException` で包み、その `type` フィールドがすでに失敗をあなたのために分類しているため、手動の `on SocketException` の配管の多くを取り除きます。`DioExceptionType` という enum は 8 つの値を持ちます。`connectionTimeout`、`sendTimeout`、`receiveTimeout`、`badCertificate`、`badResponse`、`cancel`、`connectionError`、`unknown` です。タイムアウトは `BaseOptions` で一度設定すれば、すべてのリクエストに適用されます。

```dart
// Flutter 3.44, Dart 3.x, dio 5.9.2
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.example.com',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 10),
));

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await dio.get<List<dynamic>>('/names');
    return Success((response.data ?? []).cast<String>());
  } on DioException catch (e) {
    return switch (e.type) {
      DioExceptionType.connectionError => const Offline(),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout =>
        const TimedOut(),
      DioExceptionType.badResponse =>
        ServerError(e.response?.statusCode ?? 0),
      _ => BadResponse(e.message ?? 'Unknown dio error'),
    };
  }
}
```

`dio` はステータスもデフォルトで検証します。2xx 以外のレスポンスは静かに返るのではなく `type == badResponse` の `DioException` を投げるため、「ステータスのチェックを忘れた」バグは起こり得ません。さらに `dio` は interceptor のパイプラインを公開しているため、各呼び出しを包む代わりにリトライロジックを一元的に取り付けられます。コミュニティのパッケージ `dio_smart_retry` はそのパイプラインに組み込まれ、冪等なリクエストを backoff 付きで標準でリトライします。これは、endpoint が一握りを超えたら採用する価値があります。

## connectivity_plus は無線機について教えるのであって、インターネットについてではない

よくある要望は「呼び出しの前にユーザーがオンラインかどうかをチェックする」というものです。`connectivity_plus` 7.1.1 はその一部を行いますが、それ自身の警告を注意深く読んでください。接続タイプが利用可能であることはインターネットアクセスを保証しません。バージョン 5 以降、API は単一の値ではなく `List<ConnectivityResult>` を返します（デバイスは Wi-Fi と携帯回線に同時につながれます）。これは古い例を基に書かれたコードをつまずかせます。

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
import 'package:connectivity_plus/connectivity_plus.dart';

Future<bool> hasNetworkInterface() async {
  final results = await Connectivity().checkConnectivity();
  return !results.contains(ConnectivityResult.none);
}
```

落とし穴は、これをゲートとして扱うことです。「接続されていれば、リクエストは成功する」。成功しません。携帯電話は、captive portal を通じて認可されていないカフェのネットワークに接続している間も `wifi` を報告するため、すべてのリクエストは依然として `SocketException` かタイムアウトで失敗します。`connectivity_plus` は変化に反応するため（無線機が落ちた瞬間にオフラインバナーを表示し、戻ったら隠す）、そしてそもそもリトライする価値があるかを判断するために使ってください。しかし、リクエストからの例外を実際に処理することの代わりとしては決して使わないでください。接続チェックは最適化であり、例外ハンドラーが真実の源です。

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
// React to connectivity changes for a live offline banner.
final sub = Connectivity().onConnectivityChanged.listen(
  (List<ConnectivityResult> results) {
    final online = !results.contains(ConnectivityResult.none);
    // update a banner; this stream's subscription must be cancelled
    // in dispose() like any other.
  },
);
```

その `StreamSubscription` は、キャンセルを忘れるとリークするまさにその種のリソースであり、それは [Flutter でコントローラーとサブスクリプションを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) のテーマそのものです。

## 堅牢なアプリとデモを分けるエッジケース

**dispose 時のキャンセル。** ユーザーがリクエストの途中で別画面へ遷移すると、`Future` はそれでも完了し、すでに defunct な `State` に対して `setState` を呼び、例外を投げる可能性があります。ウィジェット内のすべての `await` の後に `if (!mounted) return;` でガードするか、ナビゲーションを生き延びる状態管理層へ呼び出しを移してください。ここでの所有権の取り扱いの誤りはアプリを再構築する際に繰り返し現れるテーマであり、それが [GetX から Riverpod への移行](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) が非同期処理の置き場所に注意を払わなければならない理由の一部です。

**タイムアウトはサーバーではなくユーザーの忍耐より短くなければなりません。** 30 秒のタイムアウトは技術的には正しく、体験としてはひどいものです。connect timeout を 5 秒前後、receive timeout を 10 秒前後に選び、ユーザーがアプリがフリーズしたと結論づけるよりもずっと前にリトライを提示してください。

**間違ったボディの 200 もやはり失敗です。** スキーマ検証をネットワーク処理の一部として扱ってください。`jsonDecode` が成功しても必須フィールドが欠けていれば、それは `Success` ではなく `BadResponse` です。モデルを構築する前に形を検証してください。さもないと失敗を UI の奥深くへ押しやり、診断がはるかに困難になります。

**すべての層でログして rethrow しないでください。** 1 つの場所（データ層の例外マッピング）を選んでエラーをスタックトレースとともに記録し、残りは型付きの結果に運ばせてください。同じ例外が上へ伝播する間に 3 回ログするのは、クラッシュレポートを騒がしくするだけです。

**リトライは障害中に負荷を増幅します。** backend がすでに苦しんでいるとき、攻撃的なクライアントのリトライは事態を悪化させます。試行回数を上限で抑え、ジッター付きの backoff を使い、サーバーが送ってきたら `Retry-After` ヘッダーを尊重してください。適切なデグレードは、きれいなエラー画面を見せることと同じくらい、良いクライアントであることに関わります。

一貫した筋は、「ネットワークエラー処理」が実際には人々が 1 つに潰してしまう 3 つの仕事だということです。具体的な失敗をキャッチし、UI とリトライロジックが推論できる何かへ分類し、ユーザーが対処できる状態として提示すること。型付きの `catch` 節とシールドな結果を正しく整え、一時的なケースに上限付きの backoff を加え、`connectivity_plus` を保証ではなくヒントとして扱えば、汎用的な「問題が発生しました」スナックバーはあなたのアプリから永久に消えます。

## 関連

- [Flutter でメモリリークを避けるためにコントローラーを破棄する方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) は、接続のリスナーが作る `StreamSubscription` のキャンセルを扱います。
- [Fix: Dart で JSON をパースする際の FormatException Unexpected character](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) は、不正なボディのケースを詳しく扱います。
- [CPU 負荷の高い処理のために Dart isolate を書く方法](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) は、リトライが UI をジャンクさせないよう重いレスポンスのデコードを置くべき場所です。
- [Flutter アプリを GetX から Riverpod へ移行する方法](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) は、状態管理の変更をまたいで非同期のネットワーク処理がどこに置かれるべきかを示します。
- [Fix: Flutter の RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) は、エラーとローディングのウィジェットがレイアウトを壊さないようにします。

## 出典

- [DioException class, dio API リファレンス](https://pub.dev/documentation/dio/latest/dio/DioException-class.html)
- [DioExceptionType enum, dio API リファレンス](https://pub.dev/documentation/dio/latest/dio/DioExceptionType.html)
- [connectivity_plus, pub.dev](https://pub.dev/packages/connectivity_plus)
- [Future.timeout, Dart API リファレンス](https://api.dart.dev/stable/dart-async/Future/timeout.html)
- [SocketException class, Dart API リファレンス](https://api.dart.dev/stable/dart-io/SocketException-class.html)
- [http package, pub.dev](https://pub.dev/packages/http)
