---
title: "Исправление: Unhandled Exception: FormatException: Unexpected character при разборе JSON в Dart"
description: "Решение за 30 секунд: тело ответа не тот JSON, который вы думаете. Выведите сырые байты, декодируйте через utf8.decode(response.bodyBytes) и никогда не передавайте HTML-страницу с ошибкой или строку с BOM в jsonDecode."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "json"
  - "http"
lang: "ru"
translationOf: "2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart"
translatedBy: "claude"
translationDate: 2026-05-17
---

Решение в одной фразе: `jsonDecode` упал не на вашем JSON. Он упал на чём-то, что не является JSON, в теле, которое вы передали. В девяти случаях из десяти тело — это HTML-страница с ошибкой из вашего API, UTF-8 BOM перед валидным JSON, HTTP-ответ, декодированный с неправильным charset, или `null` либо пустая строка из запроса, который сервер уже отклонил. Выведите первые 80 байт тела, декодируйте байты через `utf8.decode(response.bodyBytes)` вместо того, чтобы позволить `package:http` угадывать charset, и добавьте проверку статус-кода перед вызовом `jsonDecode`.

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

Это руководство написано против Dart 3.7 (стабильный канал на май 2026), Flutter 3.27 и `package:http` 1.5.0. Описанное здесь поведение не менялось с Dart 2.12 и появления null safety. API `jsonDecode` находится в `dart:convert`; парсер, который бросает исключение, — это `_ChunkedJsonParser` в SDK в [sdk/lib/_internal/vm/lib/convert_patch.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/_internal/vm/lib/convert_patch.dart).

## Почему эту ошибку почти всегда диагностируют неправильно

`FormatException: Unexpected character` из `dart:convert` — точное сообщение. Парсер нашёл байт, который не смог сопоставить ни с одним валидным JSON-токеном на конкретном смещении, и бросил исключение с этим смещением в поле `offset` объекта [FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html). Смещение — единственное число, которое имеет значение в сообщении, и большинство разработчиков его игнорируют.

- `at character 0` или `at character 1`: самый первый байт неверен. Либо вы смотрите на `<!DOCTYPE html>` (страница ошибки), либо на UTF-8 BOM (`0xEF 0xBB 0xBF`), либо на пустую строку, либо на JSON-конверт в кавычках ("\"{...}\"").
- `at character 2` — `at character 5` в теле, которое выглядит нормально в отладчике: несоответствие кодировок. `package:http` декодировал байты как Latin-1, потому что сервер не прислал `charset=utf-8` в `Content-Type`, и первый не-ASCII байт всё сломал.
- `at character N` с N глубоко в середине тела: реально некорректный JSON от сервера или строка, склеенная с мусором (очень часто бывает с логирующими прокси, которые приписывают баннер впереди).

Невозможно диагностировать это, не глядя на байты. Обернуть `jsonDecode` в `try / catch` правильно как финальный слой, но это скрывает реальную причину: вы пропускаете в парсер невалидированный ввод.

## Минимальный repro, который можно вставить в файл Dart

```dart
// Dart 3.7, package:http 1.5.0
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> fetchUser(String id) async {
  final response = await http.get(Uri.parse('https://api.example.com/users/$id'));
  return jsonDecode(response.body) as Map<String, dynamic>;
}
```

Это форма кода, который бросает ошибку в 90% реальных багрепортов. В этих трёх строках спрятаны четыре независимых режима отказа:

1. Сервер вернул `404` с HTML-телом. `jsonDecode("<!DOCTYPE...")` падает на символе 0.
2. Сервер вернул `200`, но с `Content-Type: application/json; charset=utf-8` и BOM в начале. `jsonDecode("﻿{...}")` падает на символе 0.
3. Сервер вернул `200` с `Content-Type: application/json` (без charset). `package:http` откатывается на `latin-1`, имя пользователя с диакритикой превращается в моджибаке, и JSON-декодер всё ещё работает, пока в ваших данных не появится последовательность байт, похожая на управляющий символ, и тогда он падает.
4. Сервер вернул пустое тело на `204 No Content`, но место вызова обработало его как JSON.

Тот же тип исключения, четыре корневые причины, четыре разных решения.

## Решение, в порядке частоты применимости

### 1. Выведите тело перед декодированием

Это не опционально. Прежде чем менять любой код, выведите первые 200 символов и длину:

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

Первые восемь байт говорят всё. `[60, 33, 68, 79, 67, 84, 89, 80]` — это `<!DOCTYP`, и вы смотрите на HTML-страницу с ошибкой. `[239, 187, 191, 123, ...]` начинается с UTF-8 BOM. `[123, 34, ...]` (`{"`) — это настоящий JSON. Выведите это один раз — и вы поймёте, какое из решений ниже применять.

### 2. Проверьте статус-код перед декодированием

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

Это покрывает случаи 1 и 4 из списка repro. `404` с HTML-телом никогда не доходит до `jsonDecode`, а `204` без тела бросает более понятную ошибку, указывающую на настоящую проблему.

### 3. Декодируйте байты через `utf8.decode`, а не через `response.body`

`response.body` в `package:http` прогоняет байты через тот charset, который объявил сервер, и откатывается на `latin-1`, когда не объявлено ничего. Этот fallback — источник большинства багов вида "JSON выглядел нормально в Postman, но моё приложение падает". Всегда используйте `utf8.decode(response.bodyBytes)`, если знаете, что API говорит на JSON:

```dart
// Dart 3.7
final text = utf8.decode(response.bodyBytes);
final data = jsonDecode(text) as Map<String, dynamic>;
```

Для API, действительно меняющих кодировку, разбирайте заголовок `Content-Type` и выбирайте нужный кодек, но правильный дефолт для JSON по HTTP — это UTF-8: [RFC 8259, раздел 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) этого требует. Геттер `body` существует потому, что спецификация HTTP позволяет другие кодировки; JSON — нет.

### 4. Уберите BOM, если ваш сервер его шлёт

BOM в начале UTF-8-потока легален по спецификации Unicode и запрещён [RFC 8259, раздел 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), поэтому JSON-парсеры правы, отклоняя его. Некоторые конфигурации IIS и часть edge-функций CDN до сих пор приписывают `0xEF 0xBB 0xBF` к JSON-ответам. Решение в одну строку:

```dart
// Dart 3.7
String stripBom(String s) =>
    s.startsWith('﻿') ? s.substring(1) : s;

final text = stripBom(utf8.decode(response.bodyBytes));
final data = jsonDecode(text);
```

Или используйте `utf8.decoder` с `allowMalformed: false` прямо на байтах после среза BOM:

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

Байтовый вариант быстрее на больших payload, потому что пропускает шаг выделения строки.

### 5. Прекратите двойное кодирование на сервере

Другая частая форма этой ошибки — смещение глубоко внутри строки, которая выглядит валидной:

```text
Unhandled Exception: FormatException: Unexpected character (at character 2)
"{\"id\":42,\"name\":\"Ana\"}"
 ^
```

Тело — это JSON-строка, содержимое которой — тоже JSON. Где-то на сервере JSON-объект сериализовали в строку, а потом строку сериализовали ещё раз (`JSON.stringify(JSON.stringify(obj))` в Node Express-обработчике или возврат `Json(json)` вместо объекта в ASP.NET Core). Форма решения в Dart правильная:

```dart
// Dart 3.7
final outer = jsonDecode(text);
final data = outer is String ? jsonDecode(outer) : outer;
```

Но оставьте TODO исправить сервер. Дважды закодированный JSON ломает каждого клиента, а не только Dart, и следующий вызвавший этот endpoint заплатит тем же временем на отладку.

## Как читать offset и превью source

`FormatException`, которую бросает Dart, несёт три полезных свойства: `message`, `source` и `offset`. Когда ловите её, логируйте все три:

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

Это правильный уровень логирования в любом приложении, потребляющем внешний JSON. Дефолтный `toString()` обрезает `source` примерно до 78 символов с `^` под проблемным байтом — обычно достаточно на маленьких payload и бесполезно на ответе в 200 КБ.

## Подводные камни, которые выглядят как JSON-баг, но им не являются

### `response.body` возвращает `String`, даже если тело бинарное

Геттер `body` в `package:http` вызывает `latin1.decode`, когда charset не задан, и затем ваш код вызывает `jsonDecode` на строке, которая не есть то, что пришло по сети. Если действительно нужен сырой текст, используйте `response.bodyBytes` и декодируйте сами. То же касается `package:dio`: настраивайте `ResponseType.bytes` или `ResponseType.plain`, если хотите контролировать декодирование.

### `compute(jsonDecode, ...)` глотает offset

В Flutter часто можно увидеть `final data = await compute(jsonDecode, text);`, чтобы вытолкнуть парсинг в isolate. Когда парсинг падает, `FormatException` перебрасывается через границу isolate, и поле `source` теряется. Вы увидите сообщение, но не сниппет. Сначала декодируйте на основном isolate, чтобы понять, что не так, затем переключайтесь обратно на `compute`, когда вход чист.

### Nullable `String?`, декодированный через `!`, скрывает пустой случай

```dart
final body = response.body;
final data = jsonDecode(body!); // unsafe
```

Если сервер вернул `204 No Content`, `body` равно `''`, и `jsonDecode('')` бросает `Unexpected end of input`. Используйте явную проверку `isEmpty`; не полагайтесь только на null safety.

### `json.decoder.bind(stream)` сообщает смещения относительно чанка

Если вы парсите стримовый ответ через `response.stream.transform(utf8.decoder).transform(json.decoder)`, смещение в результирующем `FormatException` локально к чанку, который упал, а не ко всему телу. Issue Dart [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264) отслеживает шероховатости здесь. Для стримового JSON переключайтесь на `package:json_stream_parser` или буферизуйте тело перед декодированием.

### Flutter web в Firefox сообщает об ошибке иначе

В Flutter web вызывается базовый JS `JSON.parse`. Firefox бросает `SyntaxError: JSON.parse: unexpected character`, тогда как Chrome бросает `SyntaxError: Unexpected token`, и Flutter оборачивает оба в `FormatException`. Решение такое же, как в этом руководстве, но если вы отлаживаете отказы только в web, сначала воспроизведите в консоли devtools браузера с сырой строкой ответа, чтобы увидеть нативную ошибку браузера.

## Связанные

- [Исправление: TaskCanceledException: A task was canceled в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) — это .NET-родственник проблемы "ваш HTTP-слой обманывает ваш парсер". Применима та же диагностическая дисциплина.
- [Исправление: The JSON value could not be converted to System.DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) покрывает случай, когда тело действительно JSON, но форма неверна.
- [Исправление: A RenderFlex overflowed by N pixels в Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) — это другая ошибка Flutter, которую новички диагностируют неправильно; та же дисциплина "сначала вывести реальное состояние".
- [Как написать Dart isolate для CPU-задач](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) становится актуальной, когда ваш JSON достаточно велик, чтобы оправдать `compute`, после того как вы уже почистили вход.

## Источники

- [Справочник библиотеки dart:convert](https://api.dart.dev/stable/dart-convert/dart-convert-library.html), документирующий `jsonDecode`, `utf8.decode` и контракт `JsonDecoder`.
- [Справочник класса FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html), API-документация, определяющая `message`, `source` и `offset`.
- [RFC 8259, раздел 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), текст спецификации JSON, требующий UTF-8 по сети и запрещающий BOM.
- [Обработка ответа в package:http](https://pub.dev/documentation/http/latest/http/Response/body.html), где описан fallback charset, удивляющий большинство вызывающих.
- [dart-lang/sdk#46959](https://github.com/dart-lang/sdk/issues/46959), каноническая issue с примерами того же исключения, брошенного на разных реальных входах.
- [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264), отслеживающая поведение offset чанкового декодера, упомянутое выше.
