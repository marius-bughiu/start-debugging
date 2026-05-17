---
title: "Fix: Unhandled Exception: FormatException: Unexpected character when parsing JSON in Dart"
description: "The fix in 30 seconds: your response body is not the JSON you think it is. Print the raw bytes, decode with utf8.decode(response.bodyBytes), and never feed an HTML error page or a BOM-prefixed string to jsonDecode."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "json"
  - "http"
---

The fix in one breath: `jsonDecode` did not fail on your JSON. It failed on something that is not JSON, sitting in the body you passed in. Nine times out of ten the body is an HTML error page from your API, a UTF-8 BOM in front of valid JSON, an HTTP response decoded with the wrong charset, or a `null` / empty string from a request that the server already rejected. Print the first 80 bytes of the body, decode bytes with `utf8.decode(response.bodyBytes)` instead of letting `package:http` guess the charset, and add a status-code guard before you ever call `jsonDecode`.

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

This guide is written against Dart 3.7 (stable channel as of May 2026), Flutter 3.27, and `package:http` 1.5.0. The behaviour described here is the same all the way back to Dart 2.12 and the introduction of null safety. The `jsonDecode` API lives in `dart:convert`; the parser that throws is `_ChunkedJsonParser` in the SDK at [sdk/lib/_internal/vm/lib/convert_patch.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/_internal/vm/lib/convert_patch.dart).

## Why this error is almost always misdiagnosed

`FormatException: Unexpected character` from `dart:convert` is a precise message. The parser found a byte it could not match against any valid JSON token at a specific offset, then threw with that offset in the `offset` field of the [FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html). The offset is the only number that matters in the message and most developers ignore it.

- `at character 0` or `at character 1`: the very first byte is wrong. Either you are looking at `<!DOCTYPE html>` (an error page), at a UTF-8 BOM (`0xEF 0xBB 0xBF`), at an empty string, or at a string-quoted JSON envelope ("\"{...}\"").
- `at character 2` to `at character 5` on a body that looks fine in a debugger: an encoding mismatch. `package:http` decoded the bytes as Latin-1 because the server did not send a `charset=utf-8` in the `Content-Type`, and the first non-ASCII byte exploded.
- `at character N` with N deep in the middle of the body: actual malformed JSON from the server, or a string that got concatenated with garbage (very common with logging proxies that prepend a banner).

You cannot diagnose this without looking at the bytes. Reaching for `try / catch` around `jsonDecode` is correct as a final layer, but it hides the real fault: you are letting unvalidated input into the parser.

## A minimal repro you can paste into a Dart file

```dart
// Dart 3.7, package:http 1.5.0
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> fetchUser(String id) async {
  final response = await http.get(Uri.parse('https://api.example.com/users/$id'));
  return jsonDecode(response.body) as Map<String, dynamic>;
}
```

This is the shape of code that throws the error in 90% of real bug reports. There are four independent failure modes hiding in those three lines:

1. The server returned `404` with an HTML body. `jsonDecode("<!DOCTYPE...")` throws at character 0.
2. The server returned `200` but with `Content-Type: application/json; charset=utf-8` and a leading BOM. `jsonDecode("﻿{...}")` throws at character 0.
3. The server returned `200` with `Content-Type: application/json` (no charset). `package:http` falls back to `latin-1`, so the accented user name becomes mojibake and the JSON decoder still works -- until your data has a byte sequence that resembles a control character, at which point it throws.
4. The server returned an empty body on `204 No Content` but the call site treated it as JSON.

Same exception type, four root causes, four different fixes.

## Fix, in order of how often it is the answer

### 1. Print the body before you decode it

This is not optional. Before you change any code, print the first 200 characters and the length:

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

The first eight bytes tell you everything. `[60, 33, 68, 79, 67, 84, 89, 80]` is `<!DOCTYP` and you are looking at an HTML error page. `[239, 187, 191, 123, ...]` starts with the UTF-8 BOM. `[123, 34, ...]` (`{"`) is real JSON. Print this once and you know which fix from below to apply.

### 2. Guard on the status code before decoding

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

This handles cases 1 and 4 from the repro list. A `404` with an HTML body never reaches `jsonDecode`, and a `204` with no body throws a clearer error pointing at the actual problem.

### 3. Decode bytes with `utf8.decode`, not `response.body`

`response.body` in `package:http` runs the bytes through whatever charset the server declared, and falls back to `latin-1` when nothing is declared. That fallback is the source of most "the JSON looked fine in Postman but my app crashes" bugs. Always go through `utf8.decode(response.bodyBytes)` if you know the API speaks JSON:

```dart
// Dart 3.7
final text = utf8.decode(response.bodyBytes);
final data = jsonDecode(text) as Map<String, dynamic>;
```

For APIs that genuinely vary their encoding, parse the `Content-Type` header and pick the right codec, but the right default for JSON over HTTP is UTF-8 -- [RFC 8259 section 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) requires it. The `body` getter exists because the HTTP spec allows other encodings; JSON does not.

### 4. Strip the BOM if your server sends one

A BOM at the start of a UTF-8 stream is legal in the Unicode spec and forbidden in [RFC 8259 section 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), so JSON parsers are right to reject it. Some IIS configurations and a handful of CDN edge functions still prepend `0xEF 0xBB 0xBF` to JSON responses. The fix is one line:

```dart
// Dart 3.7
String stripBom(String s) =>
    s.startsWith('﻿') ? s.substring(1) : s;

final text = stripBom(utf8.decode(response.bodyBytes));
final data = jsonDecode(text);
```

Or use `utf8.decoder` with `allowMalformed: false` directly on the bytes after slicing off the BOM:

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

The byte-level version is faster on large payloads because it skips the string-allocation step.

### 5. Stop double-encoding on the server

The other common shape of this error is the offset being deep into a string that looks valid:

```text
Unhandled Exception: FormatException: Unexpected character (at character 2)
"{\"id\":42,\"name\":\"Ana\"}"
 ^
```

The body is a JSON string whose contents are JSON. Somewhere on the server, the JSON object got serialised to a string and then the string got serialised again (`JSON.stringify(JSON.stringify(obj))` in a Node Express handler, or returning `Json(json)` instead of returning the object in ASP.NET Core). The Dart fix is the right shape:

```dart
// Dart 3.7
final outer = jsonDecode(text);
final data = outer is String ? jsonDecode(outer) : outer;
```

But mark a TODO to fix the server. Double-encoded JSON breaks every client, not just Dart, and the next person to call this endpoint will pay the same debugging tax.

## How to read the offset and the source preview

The `FormatException` Dart throws carries three useful properties: `message`, `source`, and `offset`. When you catch it, log all three:

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

This is the right level of logging in any app that consumes external JSON. The default `toString()` truncates `source` to roughly 78 characters with `^` under the offending byte, which is usually enough on small payloads and useless on a 200KB response.

## Pitfalls that look like a JSON bug but are not

### `response.body` returns `String` even when the body is binary

`package:http`'s `body` getter calls `latin1.decode` when no charset is set, then your code calls `jsonDecode` on a string that is not what hit the wire. If you really need the raw text, use `response.bodyBytes` and decode it yourself. The same applies to `package:dio`: configure `ResponseType.bytes` or `ResponseType.plain` if you want to control decoding.

### `compute(jsonDecode, ...)` swallows the offset

On Flutter you often see `final data = await compute(jsonDecode, text);` to push parsing onto an isolate. When parsing fails, the `FormatException` is rethrown across the isolate boundary and the `source` field is dropped. You will see the message but not the snippet. Decode on the main isolate first to learn what is wrong, then switch back to `compute` once the input is clean.

### A nullable `String?` decoded with `!` hides the empty case

```dart
final body = response.body;
final data = jsonDecode(body!); // unsafe
```

If the server returned `204 No Content`, `body` is `''` and `jsonDecode('')` throws `Unexpected end of input`. Use an explicit `isEmpty` check; do not rely on null safety alone.

### `json.decoder.bind(stream)` reports offsets relative to the chunk

If you parse a streaming response via `response.stream.transform(utf8.decoder).transform(json.decoder)`, the offset in the resulting `FormatException` is local to whichever chunk failed, not to the full body. The Dart issue [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264) tracks the rough edges here. For streamed JSON, switch to `package:json_stream_parser` or buffer the body before decoding.

### Flutter web on Firefox reports the error differently

On Flutter web, the underlying JS `JSON.parse` is called. Firefox throws `SyntaxError: JSON.parse: unexpected character` while Chrome throws `SyntaxError: Unexpected token`, and Flutter funnels both through `FormatException`. The fix is the same as in this guide, but if you are debugging web-only failures, reproduce in the browser's devtools console with the raw response string to see the native browser error first.

## Related

- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) is the .NET cousin of "your HTTP layer is lying to your parser." Same diagnostic discipline applies.
- [Fix: The JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) covers the case where the body really is JSON but the shape is wrong.
- [Fix: A RenderFlex overflowed by N pixels in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) is the other Flutter error that newcomers misdiagnose; the discipline of "print the actual state first" carries over.
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) becomes relevant once your JSON is large enough to justify `compute`, after you have already cleaned the input.

## Sources

- [dart:convert library reference](https://api.dart.dev/stable/dart-convert/dart-convert-library.html), which documents `jsonDecode`, `utf8.decode`, and the `JsonDecoder` contract.
- [FormatException class reference](https://api.dart.dev/stable/dart-core/FormatException-class.html), the API doc that defines `message`, `source`, and `offset`.
- [RFC 8259, section 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), the JSON spec text that mandates UTF-8 over the wire and forbids a BOM.
- [package:http response handling](https://pub.dev/documentation/http/latest/http/Response/body.html), which spells out the charset fallback that surprises most callers.
- [dart-lang/sdk#46959](https://github.com/dart-lang/sdk/issues/46959), the canonical issue with examples of the same exception thrown by different real-world inputs.
- [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264), tracking the chunked-decoder offset behaviour cited above.
