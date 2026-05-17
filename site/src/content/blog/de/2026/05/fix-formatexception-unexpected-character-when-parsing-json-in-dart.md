---
title: "Fix: Unhandled Exception: FormatException: Unexpected character beim Parsen von JSON in Dart"
description: "Die Lösung in 30 Sekunden: Ihr Response-Body ist nicht das JSON, das Sie erwarten. Geben Sie die rohen Bytes aus, dekodieren Sie mit utf8.decode(response.bodyBytes) und übergeben Sie niemals eine HTML-Fehlerseite oder einen String mit BOM an jsonDecode."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "json"
  - "http"
lang: "de"
translationOf: "2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart"
translatedBy: "claude"
translationDate: 2026-05-17
---

Die Lösung in einem Satz: `jsonDecode` ist nicht an Ihrem JSON gescheitert. Es ist an etwas gescheitert, das kein JSON ist, im Body, den Sie übergeben haben. In neun von zehn Fällen ist der Body eine HTML-Fehlerseite Ihrer API, ein UTF-8-BOM vor gültigem JSON, eine HTTP-Antwort, die mit dem falschen Zeichensatz dekodiert wurde, oder ein `null`- bzw. leerer String aus einer Anfrage, die der Server bereits abgelehnt hat. Geben Sie die ersten 80 Bytes des Bodys aus, dekodieren Sie die Bytes mit `utf8.decode(response.bodyBytes)`, statt `package:http` den Charset raten zu lassen, und fügen Sie eine Statuscode-Prüfung hinzu, bevor Sie `jsonDecode` aufrufen.

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

Dieser Leitfaden ist gegen Dart 3.7 (Stable-Kanal, Stand Mai 2026), Flutter 3.27 und `package:http` 1.5.0 geschrieben. Das hier beschriebene Verhalten gilt unverändert seit Dart 2.12 und der Einführung von Null Safety. Die `jsonDecode`-API liegt in `dart:convert`; der Parser, der die Exception wirft, ist `_ChunkedJsonParser` im SDK unter [sdk/lib/_internal/vm/lib/convert_patch.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/_internal/vm/lib/convert_patch.dart).

## Warum dieser Fehler fast immer falsch diagnostiziert wird

`FormatException: Unexpected character` aus `dart:convert` ist eine präzise Meldung. Der Parser hat ein Byte gefunden, das er an einem bestimmten Offset keinem gültigen JSON-Token zuordnen konnte, und hat dann mit genau diesem Offset im Feld `offset` der [FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html) geworfen. Der Offset ist die einzige Zahl, die in der Meldung zählt, und die meisten Entwickler ignorieren ihn.

- `at character 0` oder `at character 1`: das allererste Byte ist falsch. Entweder sehen Sie `<!DOCTYPE html>` (eine Fehlerseite), ein UTF-8-BOM (`0xEF 0xBB 0xBF`), einen leeren String oder einen string-quotierten JSON-Envelope ("\"{...}\"").
- `at character 2` bis `at character 5` bei einem Body, der im Debugger in Ordnung aussieht: eine Encoding-Diskrepanz. `package:http` hat die Bytes als Latin-1 dekodiert, weil der Server kein `charset=utf-8` im `Content-Type` mitgeschickt hat, und das erste Nicht-ASCII-Byte ist explodiert.
- `at character N` mit N tief im Body: tatsächlich fehlerhaftes JSON vom Server, oder ein String, der mit Müll konkateniert wurde (sehr häufig bei Logging-Proxies, die ein Banner voranstellen).

Sie können das nicht diagnostizieren, ohne sich die Bytes anzusehen. Ein `try / catch` um `jsonDecode` zu legen, ist als letzte Schicht korrekt, aber es verdeckt den eigentlichen Fehler: Sie lassen ungeprüfte Eingaben in den Parser.

## Ein minimales Repro, das Sie in eine Dart-Datei einfügen können

```dart
// Dart 3.7, package:http 1.5.0
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> fetchUser(String id) async {
  final response = await http.get(Uri.parse('https://api.example.com/users/$id'));
  return jsonDecode(response.body) as Map<String, dynamic>;
}
```

Das ist die Form des Codes, der in 90% der echten Bug-Reports den Fehler wirft. In diesen drei Zeilen verstecken sich vier unabhängige Fehlerquellen:

1. Der Server hat `404` mit einem HTML-Body zurückgegeben. `jsonDecode("<!DOCTYPE...")` wirft an Character 0.
2. Der Server hat `200` zurückgegeben, aber mit `Content-Type: application/json; charset=utf-8` und einem führenden BOM. `jsonDecode("﻿{...}")` wirft an Character 0.
3. Der Server hat `200` mit `Content-Type: application/json` (ohne charset) zurückgegeben. `package:http` fällt auf `latin-1` zurück, der akzentuierte Benutzername wird zu Mojibake, und der JSON-Decoder funktioniert trotzdem noch, bis Ihre Daten eine Byte-Sequenz enthalten, die wie ein Steuerzeichen aussieht, und dann wirft er.
4. Der Server hat bei `204 No Content` einen leeren Body zurückgegeben, aber die aufrufende Stelle hat ihn als JSON behandelt.

Gleicher Exception-Typ, vier Grundursachen, vier verschiedene Lösungen.

## Die Lösung, geordnet danach, wie oft sie die richtige ist

### 1. Geben Sie den Body aus, bevor Sie ihn dekodieren

Das ist nicht optional. Bevor Sie irgendeinen Code ändern, geben Sie die ersten 200 Zeichen und die Länge aus:

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

Die ersten acht Bytes sagen Ihnen alles. `[60, 33, 68, 79, 67, 84, 89, 80]` ist `<!DOCTYP`, und Sie sehen eine HTML-Fehlerseite. `[239, 187, 191, 123, ...]` beginnt mit dem UTF-8-BOM. `[123, 34, ...]` (`{"`) ist echtes JSON. Geben Sie das einmal aus, und Sie wissen, welche der untenstehenden Lösungen Sie anwenden müssen.

### 2. Prüfen Sie den Statuscode, bevor Sie dekodieren

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

Das deckt Fall 1 und 4 aus der Repro-Liste ab. Ein `404` mit HTML-Body erreicht `jsonDecode` nie, und ein `204` ohne Body wirft einen klareren Fehler, der auf das eigentliche Problem zeigt.

### 3. Dekodieren Sie Bytes mit `utf8.decode`, nicht `response.body`

`response.body` in `package:http` schickt die Bytes durch den Charset, den der Server deklariert hat, und fällt auf `latin-1` zurück, wenn nichts deklariert ist. Dieser Fallback ist die Quelle der meisten "das JSON sah in Postman gut aus, aber meine App crasht"-Bugs. Gehen Sie immer über `utf8.decode(response.bodyBytes)`, wenn Sie wissen, dass die API JSON spricht:

```dart
// Dart 3.7
final text = utf8.decode(response.bodyBytes);
final data = jsonDecode(text) as Map<String, dynamic>;
```

Für APIs, die ihre Kodierung tatsächlich variieren, parsen Sie den `Content-Type`-Header und wählen Sie den richtigen Codec, aber der korrekte Default für JSON über HTTP ist UTF-8: [RFC 8259 Abschnitt 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) verlangt das. Der `body`-Getter existiert, weil die HTTP-Spezifikation andere Kodierungen erlaubt; JSON nicht.

### 4. Entfernen Sie das BOM, falls Ihr Server eines sendet

Ein BOM am Anfang eines UTF-8-Streams ist nach der Unicode-Spezifikation erlaubt und in [RFC 8259 Abschnitt 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) verboten, JSON-Parser haben also recht, wenn sie es ablehnen. Manche IIS-Konfigurationen und einige CDN-Edge-Funktionen stellen JSON-Antworten immer noch `0xEF 0xBB 0xBF` voran. Die Lösung ist eine Zeile:

```dart
// Dart 3.7
String stripBom(String s) =>
    s.startsWith('﻿') ? s.substring(1) : s;

final text = stripBom(utf8.decode(response.bodyBytes));
final data = jsonDecode(text);
```

Oder verwenden Sie `utf8.decoder` mit `allowMalformed: false` direkt auf den Bytes, nachdem Sie das BOM abgeschnitten haben:

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

Die Byte-Variante ist bei großen Payloads schneller, weil sie den String-Allokationsschritt überspringt.

### 5. Hören Sie auf, serverseitig doppelt zu kodieren

Die andere häufige Form dieses Fehlers: der Offset liegt tief in einem String, der gültig aussieht:

```text
Unhandled Exception: FormatException: Unexpected character (at character 2)
"{\"id\":42,\"name\":\"Ana\"}"
 ^
```

Der Body ist ein JSON-String, dessen Inhalt JSON ist. Irgendwo auf dem Server wurde das JSON-Objekt in einen String serialisiert und der String dann noch einmal serialisiert (`JSON.stringify(JSON.stringify(obj))` in einem Node-Express-Handler oder `Json(json)` zurückgeben statt das Objekt in ASP.NET Core). Die Dart-Lösung hat die richtige Form:

```dart
// Dart 3.7
final outer = jsonDecode(text);
final data = outer is String ? jsonDecode(outer) : outer;
```

Aber notieren Sie ein TODO, den Server zu reparieren. Doppelt kodiertes JSON bricht jeden Client, nicht nur Dart, und die nächste Person, die diesen Endpunkt aufruft, zahlt dieselbe Debugging-Steuer.

## So lesen Sie Offset und Source-Preview

Die `FormatException`, die Dart wirft, trägt drei nützliche Properties: `message`, `source` und `offset`. Wenn Sie sie fangen, loggen Sie alle drei:

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

Das ist das richtige Logging-Niveau in jeder App, die externes JSON konsumiert. Das Default-`toString()` schneidet `source` auf etwa 78 Zeichen mit `^` unter dem fehlerhaften Byte ab, was bei kleinen Payloads meist reicht und bei einer 200KB-Antwort nutzlos ist.

## Fallstricke, die wie ein JSON-Bug aussehen, aber keiner sind

### `response.body` liefert `String`, auch wenn der Body binär ist

Der `body`-Getter von `package:http` ruft `latin1.decode` auf, wenn kein Charset gesetzt ist, und Ihr Code ruft dann `jsonDecode` auf einem String auf, der nicht das ist, was über die Leitung kam. Wenn Sie wirklich den Rohtext brauchen, verwenden Sie `response.bodyBytes` und dekodieren selbst. Dasselbe gilt für `package:dio`: konfigurieren Sie `ResponseType.bytes` oder `ResponseType.plain`, wenn Sie die Dekodierung steuern möchten.

### `compute(jsonDecode, ...)` schluckt den Offset

In Flutter sieht man oft `final data = await compute(jsonDecode, text);`, um das Parsen auf einen Isolate auszulagern. Wenn das Parsen fehlschlägt, wird die `FormatException` über die Isolate-Grenze hinweg erneut geworfen und das Feld `source` geht verloren. Sie sehen die Meldung, aber nicht den Snippet. Dekodieren Sie zuerst auf dem Haupt-Isolate, um herauszufinden, was falsch ist, und wechseln Sie zurück auf `compute`, wenn die Eingabe sauber ist.

### Ein nullbarer `String?`, mit `!` dekodiert, verbirgt den Leer-Fall

```dart
final body = response.body;
final data = jsonDecode(body!); // unsafe
```

Wenn der Server `204 No Content` zurückgegeben hat, ist `body` gleich `''`, und `jsonDecode('')` wirft `Unexpected end of input`. Verwenden Sie eine explizite `isEmpty`-Prüfung; verlassen Sie sich nicht allein auf Null Safety.

### `json.decoder.bind(stream)` meldet Offsets relativ zum Chunk

Wenn Sie eine gestreamte Antwort über `response.stream.transform(utf8.decoder).transform(json.decoder)` parsen, ist der Offset in der resultierenden `FormatException` lokal zu dem Chunk, der fehlgeschlagen ist, und nicht zum gesamten Body. Das Dart-Issue [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264) verfolgt die rauen Kanten hier. Für gestreamtes JSON wechseln Sie zu `package:json_stream_parser` oder puffern Sie den Body, bevor Sie dekodieren.

### Flutter Web auf Firefox meldet den Fehler anders

In Flutter Web wird das darunterliegende JS-`JSON.parse` aufgerufen. Firefox wirft `SyntaxError: JSON.parse: unexpected character`, während Chrome `SyntaxError: Unexpected token` wirft, und Flutter leitet beides durch `FormatException`. Die Lösung ist dieselbe wie in diesem Leitfaden, aber wenn Sie Fehler nur im Web debuggen, reproduzieren Sie sie zuerst in der DevTools-Konsole des Browsers mit dem rohen Response-String, um den nativen Browser-Fehler zu sehen.

## Verwandt

- [Fix: TaskCanceledException: A task was canceled in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) ist der .NET-Cousin von "Ihre HTTP-Schicht lügt Ihren Parser an". Dieselbe Diagnose-Disziplin gilt.
- [Fix: The JSON value could not be converted to System.DateTime](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) behandelt den Fall, in dem der Body wirklich JSON ist, aber die Form falsch.
- [Fix: A RenderFlex overflowed by N pixels in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) ist der andere Flutter-Fehler, den Einsteiger falsch diagnostizieren; die Disziplin "erst den tatsächlichen Zustand ausgeben" überträgt sich.
- [So schreiben Sie einen Dart-Isolate für CPU-gebundene Arbeit](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) wird relevant, sobald Ihr JSON groß genug ist, um `compute` zu rechtfertigen, nachdem Sie die Eingabe bereinigt haben.

## Quellen

- [Referenz der dart:convert-Bibliothek](https://api.dart.dev/stable/dart-convert/dart-convert-library.html), die `jsonDecode`, `utf8.decode` und den `JsonDecoder`-Vertrag dokumentiert.
- [Klassenreferenz FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html), die API-Doku, die `message`, `source` und `offset` definiert.
- [RFC 8259, Abschnitt 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), der JSON-Spec-Text, der UTF-8 auf der Leitung vorschreibt und ein BOM verbietet.
- [Response-Handling in package:http](https://pub.dev/documentation/http/latest/http/Response/body.html), das den Charset-Fallback beschreibt, der die meisten Aufrufer überrascht.
- [dart-lang/sdk#46959](https://github.com/dart-lang/sdk/issues/46959), das kanonische Issue mit Beispielen derselben Exception, ausgelöst durch verschiedene reale Eingaben.
- [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264), das das oben zitierte Chunked-Decoder-Offset-Verhalten verfolgt.
