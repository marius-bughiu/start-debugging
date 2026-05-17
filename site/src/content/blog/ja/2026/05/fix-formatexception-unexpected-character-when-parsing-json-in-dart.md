---
title: "修正: Unhandled Exception: FormatException: Unexpected character — Dart で JSON をパースしているとき"
description: "30 秒で直す: レスポンスボディはあなたが思っている JSON ではありません。生のバイトを出力し、utf8.decode(response.bodyBytes) でデコードし、HTML のエラーページや BOM 付きの文字列を絶対に jsonDecode に渡さないでください。"
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "json"
  - "http"
lang: "ja"
translationOf: "2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart"
translatedBy: "claude"
translationDate: 2026-05-17
---

一言で言うと: `jsonDecode` はあなたの JSON で失敗したわけではありません。あなたが渡したボディの中にある JSON ではない何かで失敗したのです。10 回中 9 回は、ボディは API からの HTML エラーページ、有効な JSON の前にある UTF-8 BOM、誤った文字セットでデコードされた HTTP レスポンス、またはサーバーがすでに拒否したリクエストから返された `null` か空文字列です。ボディの最初の 80 バイトを出力し、`package:http` に文字セットを推測させる代わりに `utf8.decode(response.bodyBytes)` でバイトをデコードし、`jsonDecode` を呼ぶ前にステータスコードのチェックを追加してください。

```text
Unhandled Exception: FormatException: Unexpected character (at character 1)
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Error</title>...
^

#0      _ChunkedJsonParser.fail (dart:convert-patch/convert_patch.dart:1452:5)
#1      _ChunkedJsonParser.parseNumber (dart:convert-patch/convert_patch.dart:1319:9)
#2      _ChunkedJsonParser.parse (dart:convert-patch/convert_patch.dart:907:22)
#3      _parseJson (dart:convert-patch/convert_patch.dart:41:10)
#4      JsonDecoder.convert (dart:convert/json.dart:613:36)
#5      JsonCodec.decode (dart:convert/json.dart:175:41)
#6      jsonDecode (dart:convert/json.dart:96:10)
```

このガイドは、2026 年 5 月時点で安定チャネルにある Dart 3.7、Flutter 3.27、`package:http` 1.5.0 を対象に書かれています。ここで説明する振る舞いは、Dart 2.12 で null safety が導入されて以来変わっていません。`jsonDecode` API は `dart:convert` にあり、例外を投げるパーサーは SDK の [sdk/lib/_internal/vm/lib/convert_patch.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/_internal/vm/lib/convert_patch.dart) にある `_ChunkedJsonParser` です。

## なぜこのエラーはほぼ常に誤診されるのか

`dart:convert` からの `FormatException: Unexpected character` は正確なメッセージです。パーサーは特定のオフセットで有効な JSON トークンのどれとも一致しないバイトを見つけ、そのオフセットを [FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html) の `offset` フィールドに入れてスローします。オフセットはこのメッセージで唯一意味のある数字ですが、多くの開発者はそれを無視します。

- `at character 0` または `at character 1`: 最初のバイトが間違っています。`<!DOCTYPE html>` (エラーページ)、UTF-8 BOM (`0xEF 0xBB 0xBF`)、空文字列、または文字列引用された JSON エンベロープ ("\"{...}\"") のいずれかを見ています。
- `at character 2` から `at character 5` で、デバッガー上ではボディが正常に見える: エンコーディングの不一致です。サーバーが `Content-Type` に `charset=utf-8` を送らなかったため、`package:http` はバイトを Latin-1 としてデコードし、最初の非 ASCII バイトで破綻します。
- `at character N` で N がボディの深い位置: サーバーからの本当に不正な JSON、またはガベージと連結された文字列 (バナーを先頭に付けるロギングプロキシで非常によく起こります)。

バイトを見ずにこれを診断することはできません。`jsonDecode` の周りに `try / catch` を置くのは最終層として正しいですが、実際の原因 (検証されていない入力をパーサーに通している) を隠してしまいます。

## Dart ファイルに貼り付けられる最小の再現コード

```dart
// Dart 3.7, package:http 1.5.0
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> fetchUser(String id) async {
  final response = await http.get(Uri.parse('https://api.example.com/users/$id'));
  return jsonDecode(response.body) as Map<String, dynamic>;
}
```

これは実際のバグレポートの 90% でエラーを投げるコードの形です。この 3 行の中には 4 つの独立した失敗モードが隠れています:

1. サーバーが HTML ボディとともに `404` を返した。`jsonDecode("<!DOCTYPE...")` は character 0 でスローします。
2. サーバーが `Content-Type: application/json; charset=utf-8` と先頭の BOM 付きで `200` を返した。`jsonDecode("﻿{...}")` は character 0 でスローします。
3. サーバーが `Content-Type: application/json` (charset なし) で `200` を返した。`package:http` は `latin-1` にフォールバックし、アクセント付きのユーザー名が文字化けになり、JSON デコーダーはまだ動きます。データに制御文字に見えるバイト列が出てきた瞬間に、スローします。
4. サーバーが `204 No Content` で空のボディを返したのに、呼び出し側がそれを JSON として扱った。

同じ例外型、4 つの根本原因、4 つの異なる修正です。

## 修正、答えである頻度順に

### 1. デコードする前にボディを出力する

これはオプションではありません。コードを変える前に、最初の 200 文字と長さを出力してください:

```dart
// Dart 3.7
import 'dart:convert';
import 'package:http/http.dart' as http;

final response = await http.get(uri);
final preview = response.body.length > 200
    ? '${response.body.substring(0, 200)}...'
    : response.body;
print('status=${response.statusCode} '
      'len=${response.bodyBytes.length} '
      'content-type=${response.headers['content-type']}');
print('body[0..200]=$preview');
print('first-bytes=${response.bodyBytes.take(8).toList()}');
```

最初の 8 バイトがすべてを教えてくれます。`[60, 33, 68, 79, 67, 84, 89, 80]` は `<!DOCTYP` で、HTML のエラーページを見ています。`[239, 187, 191, 123, ...]` は UTF-8 BOM で始まります。`[123, 34, ...]` (`{"`) は本物の JSON です。これを 1 回出力すれば、下記のどの修正を適用すべきか分かります。

### 2. デコード前にステータスコードでガードする

```dart
// Dart 3.7, package:http 1.5.0
final response = await http.get(uri);

if (response.statusCode != 200) {
  throw HttpException(
    'GET $uri returned ${response.statusCode}: ${response.body}',
  );
}
if (response.bodyBytes.isEmpty) {
  throw const FormatException('Empty body where JSON was expected');
}

final data = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
```

これは再現リストの 1 と 4 を処理します。HTML ボディ付きの `404` は `jsonDecode` まで届かず、ボディのない `204` は実際の問題を指す明確なエラーをスローします。

### 3. `response.body` ではなく `utf8.decode` でバイトをデコードする

`package:http` の `response.body` は、サーバーが宣言した文字セットでバイトを通し、何も宣言されていないときは `latin-1` にフォールバックします。このフォールバックが「JSON は Postman で見たときは大丈夫だったのにアプリがクラッシュする」というバグのほとんどの源です。API が JSON を話すと分かっているなら、常に `utf8.decode(response.bodyBytes)` を通してください:

```dart
// Dart 3.7
final text = utf8.decode(response.bodyBytes);
final data = jsonDecode(text) as Map<String, dynamic>;
```

エンコーディングが本当に変わる API には、`Content-Type` ヘッダーをパースして適切なコーデックを選んでください。しかし HTTP 越しの JSON の正しいデフォルトは UTF-8 です: [RFC 8259 セクション 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) がそれを要求しています。`body` ゲッターが存在するのは HTTP 仕様が他のエンコーディングを許すからです。JSON は許しません。

### 4. サーバーが BOM を送るなら剥ぎ取る

UTF-8 ストリームの先頭の BOM は Unicode 仕様では合法ですが [RFC 8259 セクション 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) では禁じられているので、JSON パーサーが拒否するのは正しいです。一部の IIS 設定と一握りの CDN エッジ関数は今も JSON レスポンスの前に `0xEF 0xBB 0xBF` を付けます。修正は 1 行です:

```dart
// Dart 3.7
String stripBom(String s) =>
    s.startsWith('﻿') ? s.substring(1) : s;

final text = stripBom(utf8.decode(response.bodyBytes));
final data = jsonDecode(text);
```

または、BOM をスライスした後のバイトに直接 `utf8.decoder` を `allowMalformed: false` で使ってください:

```dart
// Dart 3.7
final bytes = response.bodyBytes;
final start = (bytes.length >= 3 &&
        bytes[0] == 0xEF &&
        bytes[1] == 0xBB &&
        bytes[2] == 0xBF)
    ? 3
    : 0;
final data = jsonDecode(utf8.decode(bytes.sublist(start)));
```

バイトレベル版は文字列割り当てステップを省くため、大きいペイロードで高速です。

### 5. サーバーでの二重エンコーディングをやめる

このエラーのもう 1 つのよくある形は、オフセットが有効に見える文字列の深い位置に入ることです:

```text
Unhandled Exception: FormatException: Unexpected character (at character 2)
"{\"id\":42,\"name\":\"Ana\"}"
 ^
```

ボディは内容が JSON になっている JSON 文字列です。サーバーのどこかで JSON オブジェクトが文字列にシリアライズされ、その文字列がさらにもう一度シリアライズされました (Node の Express ハンドラーでの `JSON.stringify(JSON.stringify(obj))`、または ASP.NET Core でオブジェクトを返す代わりに `Json(json)` を返すなど)。Dart 側の修正の形は正しいです:

```dart
// Dart 3.7
final outer = jsonDecode(text);
final data = outer is String ? jsonDecode(outer) : outer;
```

しかし、サーバーを直す TODO を残してください。二重エンコードされた JSON は Dart だけでなくすべてのクライアントを壊しますし、次にこのエンドポイントを呼ぶ人も同じデバッグの代償を払うことになります。

## オフセットとソースのプレビューを読む方法

Dart がスローする `FormatException` は 3 つの有用なプロパティを持ちます: `message`、`source`、`offset`。キャッチしたら、3 つすべてをログ出力してください:

```dart
// Dart 3.7
try {
  final data = jsonDecode(text);
} on FormatException catch (e) {
  print('JSON parse failed at offset ${e.offset}.');
  if (e.source is String) {
    final src = e.source as String;
    final start = (e.offset ?? 0) - 20;
    final end = (e.offset ?? 0) + 20;
    final window = src.substring(start.clamp(0, src.length), end.clamp(0, src.length));
    print('context: "$window"');
  }
  rethrow;
}
```

これは外部 JSON を消費するどのアプリでも正しいログ出力のレベルです。デフォルトの `toString()` は `source` を約 78 文字に切り詰め、問題のバイトの下に `^` を付けます。これは小さなペイロードでは十分ですが、200KB のレスポンスでは役に立ちません。

## JSON のバグに見えて違うもの

### `response.body` はボディがバイナリでも `String` を返す

`package:http` の `body` ゲッターは、charset が設定されていないとき `latin1.decode` を呼び、その結果あなたのコードは通信路で実際にやり取りされたものではない文字列で `jsonDecode` を呼びます。本当に生のテキストが必要なら `response.bodyBytes` を使い、自分でデコードしてください。`package:dio` でも同様で、デコードを制御したいなら `ResponseType.bytes` または `ResponseType.plain` を設定してください。

### `compute(jsonDecode, ...)` はオフセットを呑み込む

Flutter ではパースを isolate に押し出すために `final data = await compute(jsonDecode, text);` をよく見ます。パースが失敗すると、`FormatException` は isolate 境界を越えて再スローされ、`source` フィールドは捨てられます。メッセージは見えますが、スニペットは見えません。まずメイン isolate でデコードして何が間違っているかを学び、入力がきれいになってから `compute` に戻してください。

### `!` でデコードされた nullable な `String?` は空のケースを隠す

```dart
final body = response.body;
final data = jsonDecode(body!); // unsafe
```

サーバーが `204 No Content` を返した場合、`body` は `''` で、`jsonDecode('')` は `Unexpected end of input` をスローします。null safety だけに頼らず、明示的な `isEmpty` チェックを使ってください。

### `json.decoder.bind(stream)` はチャンク相対のオフセットを報告する

`response.stream.transform(utf8.decoder).transform(json.decoder)` でストリームレスポンスをパースする場合、結果の `FormatException` のオフセットは、失敗したチャンクに対してローカルで、ボディ全体に対するものではありません。Dart の issue [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264) がここの粗いエッジを追跡しています。ストリーミング JSON では `package:json_stream_parser` に切り替えるか、デコード前にボディをバッファリングしてください。

### Firefox 上の Flutter web はエラーを別の形で報告する

Flutter web では、基盤の JS の `JSON.parse` が呼ばれます。Firefox は `SyntaxError: JSON.parse: unexpected character` をスローし、Chrome は `SyntaxError: Unexpected token` をスローします。Flutter は両方を `FormatException` を通して中継します。修正はこのガイドと同じですが、web 限定の失敗をデバッグしているなら、まずブラウザの devtools コンソールで生のレスポンス文字列を再現し、ネイティブのブラウザエラーを確認してください。

## 関連

- [修正: TaskCanceledException: A task was canceled — HttpClient で](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) は「HTTP 層がパーサーに嘘をついている」の .NET 版です。同じ診断の規律が適用できます。
- [修正: The JSON value could not be converted to System.DateTime](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) はボディが本当に JSON だが形が間違っているケースをカバーします。
- [修正: A RenderFlex overflowed by N pixels — Flutter で](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) は初心者が誤診するもう一つの Flutter のエラーで、「まず実際の状態を出力する」の規律が同じく当てはまります。
- [CPU バウンドな処理のための Dart isolate の書き方](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) は、JSON が `compute` を正当化できるほど大きくなり、入力をきれいにし終わった後で関係してきます。

## ソース

- [dart:convert ライブラリリファレンス](https://api.dart.dev/stable/dart-convert/dart-convert-library.html)。`jsonDecode`、`utf8.decode`、`JsonDecoder` の契約を文書化しています。
- [FormatException クラスリファレンス](https://api.dart.dev/stable/dart-core/FormatException-class.html)。`message`、`source`、`offset` を定義する API ドキュメント。
- [RFC 8259 セクション 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1)。通信路上で UTF-8 を必須とし BOM を禁ずる JSON 仕様のテキスト。
- [package:http のレスポンスハンドリング](https://pub.dev/documentation/http/latest/http/Response/body.html)。多くの呼び出し側を驚かせる charset フォールバックを綴ったドキュメント。
- [dart-lang/sdk#46959](https://github.com/dart-lang/sdk/issues/46959)。異なる実世界の入力で投げられた同じ例外の例を集めた標準的な issue。
- [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264)。上で引用したチャンク化デコーダーのオフセットの振る舞いを追跡。
