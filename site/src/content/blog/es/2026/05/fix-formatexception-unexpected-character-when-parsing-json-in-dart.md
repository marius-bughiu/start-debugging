---
title: "Solución: Unhandled Exception: FormatException: Unexpected character al parsear JSON en Dart"
description: "La solución en 30 segundos: el cuerpo de la respuesta no es el JSON que crees. Imprime los bytes en bruto, decodifica con utf8.decode(response.bodyBytes) y nunca pases una página HTML de error o una cadena con BOM a jsonDecode."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "json"
  - "http"
lang: "es"
translationOf: "2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart"
translatedBy: "claude"
translationDate: 2026-05-17
---

La solución en una frase: `jsonDecode` no falló por tu JSON. Falló por algo que no es JSON dentro del cuerpo que le pasaste. Nueve de cada diez veces el cuerpo es una página HTML de error de tu API, un BOM UTF-8 delante de un JSON válido, una respuesta HTTP decodificada con el conjunto de caracteres incorrecto, o una cadena `null` o vacía de una solicitud que el servidor ya rechazó. Imprime los primeros 80 bytes del cuerpo, decodifica los bytes con `utf8.decode(response.bodyBytes)` en lugar de dejar que `package:http` adivine el charset, y agrega una verificación del código de estado antes de llamar a `jsonDecode`.

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

Esta guía está escrita contra Dart 3.7 (canal estable a mayo de 2026), Flutter 3.27 y `package:http` 1.5.0. El comportamiento descrito aquí es el mismo desde Dart 2.12 y la introducción de null safety. La API `jsonDecode` vive en `dart:convert`; el parser que lanza la excepción es `_ChunkedJsonParser` en el SDK en [sdk/lib/_internal/vm/lib/convert_patch.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/_internal/vm/lib/convert_patch.dart).

## Por qué este error casi siempre se diagnostica mal

`FormatException: Unexpected character` de `dart:convert` es un mensaje preciso. El parser encontró un byte que no pudo emparejar con ningún token JSON válido en un offset específico y lanzó la excepción con ese offset en el campo `offset` de [FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html). El offset es el único número que importa en el mensaje y la mayoría de los desarrolladores lo ignora.

- `at character 0` o `at character 1`: el primer byte está mal. Estás viendo `<!DOCTYPE html>` (una página de error), un BOM UTF-8 (`0xEF 0xBB 0xBF`), una cadena vacía, o un envoltorio JSON entre comillas ("\"{...}\"").
- `at character 2` a `at character 5` en un cuerpo que parece bien en el depurador: una discrepancia de codificación. `package:http` decodificó los bytes como Latin-1 porque el servidor no envió `charset=utf-8` en el `Content-Type`, y el primer byte no ASCII explotó.
- `at character N` con N en medio del cuerpo: JSON realmente malformado del servidor, o una cadena concatenada con basura (muy común con proxies de registro que anteponen un banner).

No puedes diagnosticar esto sin mirar los bytes. Recurrir a `try / catch` alrededor de `jsonDecode` es correcto como última capa, pero oculta la falla real: estás dejando que entren datos sin validar al parser.

## Un repro mínimo que puedes pegar en un archivo Dart

```dart
// Dart 3.7, package:http 1.5.0
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> fetchUser(String id) async {
  final response = await http.get(Uri.parse('https://api.example.com/users/$id'));
  return jsonDecode(response.body) as Map<String, dynamic>;
}
```

Esta es la forma del código que lanza el error en el 90% de los reportes de bugs reales. Hay cuatro modos de falla independientes escondidos en esas tres líneas:

1. El servidor devolvió `404` con un cuerpo HTML. `jsonDecode("<!DOCTYPE...")` falla en el carácter 0.
2. El servidor devolvió `200` pero con `Content-Type: application/json; charset=utf-8` y un BOM al inicio. `jsonDecode("﻿{...}")` falla en el carácter 0.
3. El servidor devolvió `200` con `Content-Type: application/json` (sin charset). `package:http` cae a `latin-1`, así que el nombre acentuado del usuario se convierte en mojibake y el decodificador JSON todavía funciona, hasta que tus datos tienen una secuencia de bytes que parece un carácter de control, y entonces lanza la excepción.
4. El servidor devolvió un cuerpo vacío con `204 No Content` pero el sitio de llamada lo trató como JSON.

Mismo tipo de excepción, cuatro causas raíz, cuatro soluciones distintas.

## La solución, en orden de qué tan a menudo es la respuesta

### 1. Imprime el cuerpo antes de decodificarlo

Esto no es opcional. Antes de cambiar cualquier código, imprime los primeros 200 caracteres y la longitud:

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

Los primeros ocho bytes te dicen todo. `[60, 33, 68, 79, 67, 84, 89, 80]` es `<!DOCTYP` y estás viendo una página HTML de error. `[239, 187, 191, 123, ...]` comienza con el BOM UTF-8. `[123, 34, ...]` (`{"`) es JSON real. Imprime esto una vez y sabrás qué solución de las de abajo aplicar.

### 2. Verifica el código de estado antes de decodificar

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

Esto maneja los casos 1 y 4 de la lista del repro. Un `404` con cuerpo HTML nunca llega a `jsonDecode`, y un `204` sin cuerpo lanza un error más claro que apunta al problema real.

### 3. Decodifica los bytes con `utf8.decode`, no con `response.body`

`response.body` en `package:http` pasa los bytes por cualquier charset que el servidor declare, y cae a `latin-1` cuando no se declara nada. Ese fallback es el origen de la mayoría de los bugs del tipo "el JSON se veía bien en Postman pero mi app crashea". Siempre pasa por `utf8.decode(response.bodyBytes)` si sabes que la API habla JSON:

```dart
// Dart 3.7
final text = utf8.decode(response.bodyBytes);
final data = jsonDecode(text) as Map<String, dynamic>;
```

Para APIs que realmente varían su codificación, parsea el header `Content-Type` y elige el codec correcto, pero el valor por defecto correcto para JSON sobre HTTP es UTF-8: [RFC 8259 sección 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1) lo exige. El getter `body` existe porque la especificación HTTP permite otras codificaciones; JSON no.

### 4. Quita el BOM si tu servidor lo envía

Un BOM al inicio de un flujo UTF-8 es legal en la especificación Unicode y prohibido en [RFC 8259 sección 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), por lo que los parsers JSON tienen razón al rechazarlo. Algunas configuraciones de IIS y un puñado de funciones edge de CDN todavía anteponen `0xEF 0xBB 0xBF` a las respuestas JSON. La solución es una línea:

```dart
// Dart 3.7
String stripBom(String s) =>
    s.startsWith('﻿') ? s.substring(1) : s;

final text = stripBom(utf8.decode(response.bodyBytes));
final data = jsonDecode(text);
```

O usa `utf8.decoder` con `allowMalformed: false` directamente sobre los bytes después de cortar el BOM:

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

La versión a nivel de bytes es más rápida en payloads grandes porque salta el paso de asignación de cadena.

### 5. Deja de hacer doble codificación en el servidor

La otra forma común de este error es que el offset cae profundo dentro de una cadena que parece válida:

```text
Unhandled Exception: FormatException: Unexpected character (at character 2)
"{\"id\":42,\"name\":\"Ana\"}"
 ^
```

El cuerpo es una cadena JSON cuyo contenido es JSON. En algún punto del servidor, el objeto JSON se serializó a cadena y luego la cadena se serializó otra vez (`JSON.stringify(JSON.stringify(obj))` en un handler Node Express, o devolver `Json(json)` en lugar de devolver el objeto en ASP.NET Core). La solución en Dart tiene la forma correcta:

```dart
// Dart 3.7
final outer = jsonDecode(text);
final data = outer is String ? jsonDecode(outer) : outer;
```

Pero deja un TODO para arreglar el servidor. El JSON doblemente codificado rompe a todos los clientes, no solo a Dart, y la próxima persona que llame a este endpoint pagará el mismo impuesto de depuración.

## Cómo leer el offset y el preview de la fuente

La `FormatException` que Dart lanza lleva tres propiedades útiles: `message`, `source` y `offset`. Cuando la atrapes, registra las tres:

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

Este es el nivel correcto de registro en cualquier app que consuma JSON externo. El `toString()` por defecto trunca `source` a unos 78 caracteres con `^` debajo del byte ofensivo, lo cual suele bastar en payloads pequeños y es inútil en una respuesta de 200KB.

## Trampas que parecen un bug de JSON pero no lo son

### `response.body` devuelve `String` aunque el cuerpo sea binario

El getter `body` de `package:http` llama a `latin1.decode` cuando no hay charset, y luego tu código llama a `jsonDecode` sobre una cadena que no es lo que llegó por la red. Si realmente necesitas el texto en bruto, usa `response.bodyBytes` y decodifícalo tú. Lo mismo aplica a `package:dio`: configura `ResponseType.bytes` o `ResponseType.plain` si quieres controlar la decodificación.

### `compute(jsonDecode, ...)` se traga el offset

En Flutter muchas veces ves `final data = await compute(jsonDecode, text);` para empujar el parseo a un isolate. Cuando el parseo falla, la `FormatException` se relanza a través del límite del isolate y se descarta el campo `source`. Verás el mensaje pero no el snippet. Decodifica en el isolate principal primero para aprender qué está mal, después regresa a `compute` cuando la entrada esté limpia.

### Un `String?` anulable decodificado con `!` esconde el caso vacío

```dart
final body = response.body;
final data = jsonDecode(body!); // unsafe
```

Si el servidor devolvió `204 No Content`, `body` es `''` y `jsonDecode('')` lanza `Unexpected end of input`. Usa una verificación explícita `isEmpty`; no confíes solo en null safety.

### `json.decoder.bind(stream)` reporta offsets relativos al chunk

Si parseas una respuesta en streaming con `response.stream.transform(utf8.decoder).transform(json.decoder)`, el offset en la `FormatException` resultante es local al chunk que falló, no al cuerpo completo. El issue de Dart [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264) registra las asperezas aquí. Para JSON en streaming, cambia a `package:json_stream_parser` o haz buffer del cuerpo antes de decodificar.

### Flutter web en Firefox reporta el error de forma diferente

En Flutter web se llama al `JSON.parse` subyacente de JS. Firefox lanza `SyntaxError: JSON.parse: unexpected character` mientras que Chrome lanza `SyntaxError: Unexpected token`, y Flutter canaliza ambos a través de `FormatException`. La solución es la misma que en esta guía, pero si depuras fallas solo en web, reproduce en la consola de devtools del navegador con la cadena de respuesta cruda para ver el error nativo del navegador primero.

## Relacionados

- [Solución: TaskCanceledException: A task was canceled en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) es la prima de .NET de "tu capa HTTP le miente a tu parser". Aplica la misma disciplina de diagnóstico.
- [Solución: The JSON value could not be converted to System.DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cubre el caso donde el cuerpo realmente es JSON pero la forma está mal.
- [Solución: A RenderFlex overflowed by N pixels en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) es el otro error de Flutter que los nuevos diagnostican mal; la disciplina de "imprime el estado real primero" se aplica igual.
- [Cómo escribir un isolate de Dart para trabajo intensivo en CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) se vuelve relevante cuando tu JSON es lo bastante grande como para justificar `compute`, después de haber limpiado la entrada.

## Fuentes

- [Referencia de la biblioteca dart:convert](https://api.dart.dev/stable/dart-convert/dart-convert-library.html), que documenta `jsonDecode`, `utf8.decode` y el contrato de `JsonDecoder`.
- [Referencia de la clase FormatException](https://api.dart.dev/stable/dart-core/FormatException-class.html), la doc de API que define `message`, `source` y `offset`.
- [RFC 8259, sección 8.1](https://datatracker.ietf.org/doc/html/rfc8259#section-8.1), el texto de la especificación JSON que exige UTF-8 en la red y prohíbe un BOM.
- [Manejo de respuestas en package:http](https://pub.dev/documentation/http/latest/http/Response/body.html), que detalla el fallback de charset que sorprende a la mayoría de los llamadores.
- [dart-lang/sdk#46959](https://github.com/dart-lang/sdk/issues/46959), el issue canónico con ejemplos de la misma excepción lanzada por diferentes entradas reales.
- [dart-lang/sdk#56264](https://github.com/dart-lang/sdk/issues/56264), que rastrea el comportamiento del offset del decoder por chunks citado arriba.
