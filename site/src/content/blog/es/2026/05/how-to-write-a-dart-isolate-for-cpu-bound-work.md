---
title: "Cómo escribir un isolate de Dart para trabajo intensivo de CPU"
description: "Cuando async/await no alcanza: lanza un isolate de Dart para ejecutar trabajo intensivo de CPU fuera del hilo de UI. Isolate.run, la función compute de Flutter, workers de larga vida con SendPort/ReceivePort, qué puede cruzar la frontera y la advertencia para JS/web. Probado en Dart 3.11 y Flutter 3.27.1."
pubDate: 2026-05-05
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "performance"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work"
translatedBy: "claude"
translationDate: 2026-05-05
---

Respuesta corta: para una computación de un solo uso, llama a `await Isolate.run(myFunction)` (Dart 2.19+) o a `await compute(myFunction, arg)` en Flutter. Para un worker que atienda muchas peticiones, usa `Isolate.spawn` con un `ReceivePort` en cada lado y canaliza los mensajes a través de un `SendPort`. La función que entregas al isolate debe ser de nivel superior o `static`, el mensaje y el resultado deben ser enviables, y en la web `compute` se ejecuta en el bucle de eventos porque dart2js no tiene isolates reales. Probado en Dart 3.11 y Flutter 3.27.1 con Android Gradle Plugin 8.7.3.

El asincronismo en Dart no es paralelismo. `Future`, `await` y `Stream` planifican trabajo en el mismo bucle de eventos de un solo hilo donde corre tu UI. Si un paso síncrono dentro de ese future pasa 80 ms parseando un documento JSON de 4 MB o calculando el hash de un archivo, el bucle se bloquea durante 80 ms, la GPU pierde dos fotogramas a 60 fps y aparece `Skipped 5 frames!` en tus logs. Un isolate es la forma en que Dart escapa del hilo único: una heap separada de la VM con su propio bucle de eventos, su propio recolector de basura y sin memoria compartida con el isolate llamador. Mueves el trabajo allí, recibes la respuesta y el hilo de UI sigue dibujando.

## Cuándo un isolate es la herramienta correcta

La operación costosa debe ser **trabajo de CPU síncrono**, no una llamada de red larga. Envolver `http.get` en un isolate no te aporta nada porque `http.get` ya es asíncrono y cede al bucle de eventos mientras espera el socket. Candidatos reales:

- Parseo de un payload JSON mayor a ~1 MB. `jsonDecode` es síncrono y escala linealmente con el tamaño del payload.
- Decodificación y redimensionamiento de imágenes con `package:image`. Dart puro, sin plugin de plataforma, y un JPEG de 12 MP tarda cientos de milisegundos.
- Hashing criptográfico de un archivo (SHA-256 sobre un stream con buffer, BCrypt para verificación de contraseñas).
- Regex sobre un documento grande, especialmente con `multiline: true` y lookbehinds.
- Compresión / descompresión con `package:archive`.
- Trabajo numérico: multiplicación de matrices para un modelo de ML pequeño, FFT, convolución de kernels de imagen.

Si no puedes señalar un frame de pila que corre síncronamente durante más de ~16 ms (el presupuesto de un fotograma a 60 fps), un isolate no te va a ayudar. Perfila con el CPU profiler de Flutter DevTools primero; el timeline del "UI thread" es el que hay que mirar.

## El camino más barato: Isolate.run

`Isolate.run<R>(FutureOr<R> Function() computation, {String? debugName})` se añadió en Dart 2.19 y es la API que la documentación recomienda en 2026. Lanza un isolate, ejecuta la callback, envía el resultado de vuelta sin copia en la VM y desmonta el isolate.

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

Aquí pasan dos cosas. Primero, la lectura del archivo se queda en el isolate llamador porque `readAsString` ya es asíncrono y no bloquea el bucle de eventos. Segundo, `jsonDecode` se ejecuta en un isolate nuevo y la `List<dynamic>` resultante regresa cruzando la frontera. Lanzar un isolate cuesta aproximadamente 1 a 3 ms en un teléfono moderno, así que solo vale la pena cuando el trabajo en sí es al menos diez veces eso.

Un error común es pasar una closure que captura el ámbito circundante:

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

La closure captura `text` y `stopWords`, así que ambos se copian al nuevo isolate. Está bien para entradas pequeñas, pero si `text` pesa 50 MB acabas de pagar 50 MB de asignación y un pase de serialización. Peor aún, si el estado capturado contiene un objeto no enviable (un `Socket` abierto, una `DynamicLibrary`, un `ReceivePort`, cualquier cosa marcada con `@pragma('vm:isolate-unsendable')`) obtendrás un `ArgumentError` en runtime desde la llamada de spawn. La solución es o bien mantener el estado capturado al mínimo, o vincular un punto de entrada de nivel superior y pasarle los argumentos explícitamente.

## La función compute de Flutter, y qué es en realidad

`compute<M, R>(ComputeCallback<M, R> callback, M message)` desde `package:flutter/foundation.dart` es anterior a `Isolate.run` y sigue siendo la API más citada en los tutoriales de Flutter. A partir de Flutter 3.27.1 está documentada como equivalente a `Isolate.run(() => callback(message))` en plataformas nativas. En el target web ejecuta la callback síncronamente sobre el mismo bucle de eventos porque dart2js compila a JavaScript y no hay isolates reales en el navegador; no vas a obtener paralelismo en web por mucho que llames a la API.

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

`_parsePeople` es una función de nivel superior, no una closure ni un método. Esa es la regla que más muerde a la gente: la callback que entregas a `compute` (o a `Isolate.spawn`) tiene que ser una función de nivel superior o `static` para que solo se envíe su identidad, no su ámbito envolvente. Si escribes `compute(this._parsePeople, body)` caerás en la misma trampa de captura de closure de antes, además podrías terminar intentando enviar todo el árbol de widgets contenedor.

## Workers de larga vida: Isolate.spawn con puertos bidireccionales

`Isolate.run` es de un solo uso. Si quieres un worker que atienda muchas peticiones (un índice de búsqueda que carga 200 MB una vez y luego responde 50 consultas) necesitas `Isolate.spawn` más tu propio protocolo encima de `SendPort` / `ReceivePort`.

El patrón es simétrico: cada lado abre un `ReceivePort` y envía el `SendPort` correspondiente al otro lado, y luego ambos lados se hablan a través de esos puertos.

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

Hay un par de cosas que vale la pena destacar. El handshake (el worker crea un `ReceivePort` entrante, manda su `SendPort` de vuelta por el puerto que le dio el host) es boilerplate, pero es inevitable: no existe un registro global de puertos de isolates. El mapa `_pending` con un id monotónico es lo que te permite tener varias consultas en vuelo a la vez; sin ids solo puedes serializar las peticiones. El `null` centinela apaga el worker de forma limpia, y `Isolate.exit()` es más rápido que dejar que `main` retorne porque envía el último mensaje sin copiar.

Si quieres semántica de pause / resume o kill, captura el `Isolate` que devuelve `Isolate.spawn` y llama a `isolate.kill(priority: Isolate.immediate)`. Ten en cuenta que `kill` no ejecuta los finalizers en el worker, así que cualquier archivo o handle de base de datos abierto que el worker tuviera quedará filtrado hasta la salida del proceso.

## Qué puede cruzar la frontera

La mayoría de los objetos de Dart pueden enviarse. Las excepciones, en Dart 3.11, son:

- Objetos con recursos nativos: `Socket`, `RawSocket`, `RandomAccessFile`, `Process`.
- `ReceivePort`, `RawReceivePort`, `DynamicLibrary`, `Pointer`, todos los finalizers de `dart:ffi`.
- Cualquier cosa anotada con `@pragma('vm:isolate-unsendable')`.
- Closures que capturan estado no enviable. La captura se chequea de forma transitiva, así que una closure que referencia una instancia de clase que tiene un campo `Socket` también es no enviable.

Los tipos enviables incluyen todos los primitivos, `String`, `Uint8List` y las demás listas tipadas, `List`, `Map`, `Set`, `DateTime`, `Duration`, `BigInt`, `RegExp` y cualquier instancia de clase cuyos campos sean a su vez enviables. Enviar un buffer de typed-data lo copia a través de la heap, salvo que lo envuelvas en `TransferableTypedData`, que te da una entrega de cero-copia:

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

`materialize()` es de un solo uso por `TransferableTypedData`, así que el remitente pierde acceso al buffer una vez que el worker lo materializa. Ese es exactamente el punto: la memoria se mueve, no se duplica. Para payloads por encima de unos pocos megabytes, la diferencia entre `TransferableTypedData` y una copia simple es la diferencia entre 1 ms y 30 ms.

## Trampas que atrapan a todos los equipos

**Las closures capturan más de lo que crees.** Incluso una closure vacía dentro de un método captura `this`. Si `this` es el state de un `StatefulWidget`, acabas de fijar todo el subárbol de widgets en la heap del worker hasta que la llamada termine. Siempre extrae los datos que necesitas a variables locales y pásalos como argumentos a una función de nivel superior.

**Lanzar un isolate no es gratis.** Un `Isolate.run` pelado con una callback no-op cuesta unos 2 ms en un Pixel 7 y de 4 a 6 ms en un dispositivo Android más antiguo. Si te encuentras llamando a `compute` 60 veces por segundo para procesar taps, has escrito tu propio cuello de botella. O bien batchea el trabajo, o construye un worker de larga vida.

**El target web es una mentira en cuanto a paralelismo.** Tanto `compute` como `Isolate.run` recurren a ejecutarse en el bucle de eventos actual en web, porque Dart compilado a JavaScript corre en un solo hilo del navegador. Si el paralelismo en web importa, necesitas un Web Worker real, escrito por separado, con su propio protocolo de mensajes. Hay trabajo en curso en el soporte de workers de `dart:js_interop`, pero a partir de Dart 3.11 no es un reemplazo directo de `Isolate.run`.

**`debugPrint` desde un worker puede entremezclarse.** Cada isolate tiene su propio canal de `print`. En Android el orden en `logcat` es best-effort. Si estás depurando una condición de carrera, anexa un número de secuencia a cada línea de log en el worker para que puedas reordenarlas offline.

**No compartas estado por referencia.** Un patrón común de bug es asumir que un `Map` que enviaste a un isolate es "el mismo" mapa. No lo es; el worker recibió una copia profunda. Mutarlo en el worker no tiene efecto en quien llamó. Trata cada frontera de isolate como una frontera de serialización.

## Cómo encaja esto con el resto de tu pipeline de Flutter

Para proyectos de Flutter en concreto, las piezas circundantes importan tanto como el isolate en sí. Perfila el costo de cold-start en DevTools antes de lanzar a hacer spawn, dado que el trabajo del primer frame tiende a dominar en Android de gama baja. Si escribes un worker de larga vida que carga recursos nativos, las mismas reglas de threading aplican que cuando [te metes en código de plataforma con method channels](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), porque las llamadas de `MethodChannel` desde un isolate worker no están soportadas en Android (solo el isolate raíz tiene el binary messenger por defecto). Para reproducibilidad en CI, fija explícitamente tanto Flutter como Dart y corre los tests intensivos en isolates contra cada versión que envíes; el [workflow de matriz de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) es la forma más barata de cazar una regresión en la que cambiaron el costo de spawn o el codec por debajo de ti. Y cuando depures un worker que se cuelga, el [workflow de iOS desde Windows](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) cubre cómo conectar el observer port a través de la red para que veas frames de pila del worker en vivo.

La versión más corta de la regla: si escribiste `await` y la UI sigue congelándose, hay trabajo síncrono en algún punto de la cadena que esperaste. `Isolate.run` para una sola llamada, `compute` si vives dentro de Flutter y quieres un import menos, `Isolate.spawn` más tu propio protocolo de puertos cuando el worker tenga estado de setup que valga la pena mantener caliente. Todo lo demás (las tablas de tipos, las trampas de closures, la advertencia de la web) es la papelería alrededor de esas tres opciones.

## Source links

- [Dart concurrency and isolates](https://dart.dev/language/concurrency)
- [Isolate.run API reference](https://api.dart.dev/stable/dart-isolate/Isolate/run.html)
- [Isolate.spawn API reference](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- [Flutter compute function](https://api.flutter.dev/flutter/foundation/compute.html)
- [TransferableTypedData](https://api.dart.dev/stable/dart-isolate/TransferableTypedData-class.html)
- [`@pragma('vm:isolate-unsendable')` annotation](https://github.com/dart-lang/sdk/blob/main/runtime/docs/pragmas.md)
