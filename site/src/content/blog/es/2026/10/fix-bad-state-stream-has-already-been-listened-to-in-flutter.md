---
title: "Solución: Bad state: Stream has already been listened to en Flutter"
description: "Un stream de suscripción única acepta exactamente un listen() durante toda su vida. Crea el stream una sola vez y entrégalo a un único oyente, o compártelo con asBroadcastStream o Stream.multi."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "streams"
lang: "es"
translationOf: "2026/10/fix-bad-state-stream-has-already-been-listened-to-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`Bad state: Stream has already been listened to.` significa que algo llamó a `listen()` por segunda vez sobre un stream de suscripción única. Ese tipo de stream acepta exactamente una suscripción en toda su vida, y cancelar la primera no lo reinicia. En Flutter, el segundo `listen()` casi siempre viene de un `StreamBuilder`: dos builders sobre el mismo stream, un builder que se volvió a montar, o un `.map()`/`.where()` escrito dentro de `build()`. La solución es crear cada stream derivado una sola vez (en `initState` o en tu objeto de estado) y, cuando más de un widget realmente necesita los eventos, compartir el origen con `asBroadcastStream()`, un `StreamController.broadcast()` o un `Stream.multi` por oyente.

Cada repro y solución de abajo se ejecutó en Flutter 3.44.8 con Dart 3.12.2: los casos de Dart puro con `dart run`, los casos de widgets como pruebas de widgets con `flutter test`.

## El error en contexto

En Dart puro la excepción aparece en el segundo `listen()`, y el primer frame es el controlador rechazando a un segundo suscriptor:

```text
StateError: Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:695:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:854:20)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:516:42)
#3      main.<anonymous closure> (file:///.../repro.dart:20:14)
```

En una aplicación Flutter, el mismo `StateError` lo captura la biblioteca de widgets y lo reporta contra lo que se estuviera construyendo en ese momento. Los frames que importan son las dos líneas de `_StreamBuilderBaseState`:

```text
══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════════════
The following StateError was thrown building StatefulBuilder(state: _StatefulBuilderState#352fb):
Bad state: Stream has already been listened to.

When the exception was thrown, this was the stack:
#6      _StreamBuilderBaseState._subscribe (package:flutter/src/widgets/async.dart:133:38)
#7      _StreamBuilderBaseState.didUpdateWidget (package:flutter/src/widgets/async.dart:118:7)
#8      StatefulElement.update (package:flutter/src/widgets/framework.dart:5991:55)
```

Si el frame debajo de `_subscribe` es `initState`, se creó un nuevo estado de `StreamBuilder` y se suscribió a un stream que ya tiene otro dueño. Si es `didUpdateWidget`, el builder recibió un objeto stream *distinto* en una reconstrucción y se suscribió a él, y ese nuevo objeto se apoya sobre un origen que ya está tomado. Esa única línea te dice cuál de las causas de abajo tienes.

## Por qué un stream rechaza un segundo oyente

Dart tiene dos tipos de streams. Un stream de **suscripción única** es una secuencia de un solo uso: acumula eventos hasta que alguien escucha, se los entrega a ese único oyente y termina. Un stream **broadcast** puede tener cualquier número de oyentes, pero no acumula nada: cada evento va a quien esté suscrito en ese momento.

`StreamController()`, los generadores `async*`, `Stream.value`, `Stream.periodic`, `Future.asStream()`, `File.openRead()`, `Process.stdout` y el cuerpo de un `StreamedResponse` de `http` son todos de suscripción única. Cuando haces `listen()` por segunda vez, el controlador lanza la excepción, incluso si la primera suscripción ya estaba cancelada. Lo comprobé explícitamente:

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final c = StreamController<int>();
  final first = c.stream.listen((_) {});
  await first.cancel();
  c.stream.listen((_) {}); // StateError: Bad state: Stream has already been listened to.
}
```

Dos hechos menos obvios producen la mayor parte de la confusión:

1. **Los operadores escuchan por ti.** `map`, `where`, `expand`, `asyncMap`, `transform`, `distinct` y similares devuelven un nuevo stream que se suscribe a su origen cuando *a él* lo escuchan. Así, `c.stream.where(...)` y `c.stream.map(...)` son dos objetos stream distintos, pero escuchar ambos sigue significando dos llamadas a `listen()` sobre `c.stream`, y la segunda lanza la excepción.
2. **Los métodos de consumo también escuchan.** `first`, `last`, `length`, `toList()`, `forEach`, `drain`, `await for`, `pipe` y `bytesToString()` sobre un cuerpo de `http` son todos `listen()` por debajo. Llamar a `await stream.first` y luego a `await stream.toList()` sobre un stream `async*` lanza la excepción en la segunda llamada.

Tampoco el tipo te dice de forma fiable qué tienes. En Dart 3.12.2, `isBroadcast` es `false` para `Stream.fromIterable`, y aun así ese stream en particular se puede escuchar más de una vez (cada oyente recibe su propio recorrido del iterable), mientras que `Stream.value(1)` y `Future.value(1).asStream()` lanzan la excepción en el segundo `toList()`. Trata todo stream que no hayas creado tú como de suscripción única, salvo que su documentación diga lo contrario.

## Repro mínimo: tres formas en que un StreamBuilder lo dispara

Los tres casos fallan con el error de arriba. El helper es solo un `StreamBuilder` que imprime el último valor:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget sb(Stream<int> s) => StreamBuilder<int>(
      stream: s,
      builder: (context, snap) =>
          Text('${snap.data}', textDirection: TextDirection.ltr),
    );

void main() {
  // A: two StreamBuilders on one single-subscription stream (throws in initState)
  testWidgets('A', (t) async {
    final c = StreamController<int>();
    await t.pumpWidget(Column(children: [sb(c.stream), sb(c.stream)]));
  });

  // B: .map() inside build, then the parent rebuilds (throws in didUpdateWidget)
  testWidgets('B', (t) async {
    final c = StreamController<int>();
    late StateSetter rebuild;
    await t.pumpWidget(StatefulBuilder(builder: (context, set) {
      rebuild = set;
      return sb(c.stream.map((x) => x * 2));
    }));
    rebuild(() {});
    await t.pump();
  });

  // C: same stream object, but the StreamBuilder is remounted (throws in initState)
  testWidgets('C', (t) async {
    final stream = StreamController<int>().stream;
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(1), child: sb(stream)));
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(2), child: sb(stream)));
  });
}
```

El caso B es el que más muerde a la gente, porque el primer frame funciona. `StreamBuilder` solo se vuelve a suscribir cuando `oldWidget.stream != widget.stream` (esa es la comprobación de `didUpdateWidget` en `async.dart`), y `c.stream.map(...)` devuelve un objeto nuevo en cada `build()`. El primer build suscribe `map` #1 al controlador. La siguiente reconstrucción, que puede ser un cambio de tema, la apertura del teclado o un `setState` del padre, crea `map` #2, `StreamBuilder` cancela la suscripción a #1 y se suscribe a #2, y #2 intenta hacer `listen()` sobre el controlador por segunda vez.

El caso C es la forma real de "se cae cuando vuelvo a esta pestaña" o "se cae después de hacer pop y push de la página otra vez". El stream vive en algún lugar de larga duración (un servicio, una variable de nivel superior, un widget padre), la pantalla que aloja el `StreamBuilder` se destruye y se vuelve a crear, y el nuevo `State` llama a `listen()` sobre un stream que ya tuvo su único oyente. Cualquier cosa que cambie la forma del árbol de elementos alrededor del builder produce esto: la navegación, alternativas de `IndexedStack` que reconstruyen a sus hijos, widgets condicionales o un cambio de `Key`.

Como comparación, pasar el *mismo* objeto stream entre reconstrucciones, sin volver a montar, funciona bien. `StreamBuilder` ve un stream idéntico en `didUpdateWidget` y mantiene su suscripción existente. Ese caso pasó en el mismo archivo de pruebas.

## La solución, por orden de preferencia

### 1. Crea los streams derivados una vez, no en build()

Si el stream solo lo usa un widget, la causa B es todo el problema, y la solución es dejar de crear un stream nuevo por cada build. Guárdalo en el `State`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class PriceLabel extends StatefulWidget {
  const PriceLabel({super.key, required this.ticks});
  final Stream<int> ticks;

  @override
  State<PriceLabel> createState() => _PriceLabelState();
}

class _PriceLabelState extends State<PriceLabel> {
  late Stream<String> _formatted;

  @override
  void initState() {
    super.initState();
    _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
  }

  @override
  void didUpdateWidget(PriceLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ticks != widget.ticks) {
      _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<String>(
        stream: _formatted,
        builder: (context, snap) => Text(snap.data ?? '...'),
      );
}
```

El override de `didUpdateWidget` importa: si el padre te entrega un origen genuinamente nuevo, quieres un nuevo stream derivado para él, y solo entonces. Es la misma regla que para `FutureBuilder`, y el razonamiento de [inicializar un Future para que FutureBuilder no lo recree en cada reconstrucción](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) se traslada uno a uno. En mi prueba, guardar `c.stream.map(...)` en un `final` y pasarlo a través de una reconstrucción del padre mostró `42` después de `c.add(21)`, sin ningún error.

La misma disciplina aplica fuera de los widgets. Si necesitas tanto el primer valor como el resto, tómalos de una sola suscripción en lugar de llamar a `first` y luego a `listen`:

```dart
// Dart 3.12.2
Future<void> readAll(Stream<int> source) async {
  var isFirst = true;
  await for (final value in source) {
    if (isFirst) {
      print('first: $value');
      isFirst = false;
    }
    print('value: $value');
  }
}
```

### 2. Haz una fábrica, no un campo, cuando cada oyente deba empezar de cero

Si cada consumidor debe recibir su propia secuencia independiente (una consulta, una lectura de archivo, un generador), no guardes el stream en absoluto. Guarda una función que cree uno, y llámala por cada oyente. Una función `async*` ya es esa función:

```dart
// Dart 3.12.2
Stream<int> countdown(int from) async* {
  for (var i = from; i >= 0; i--) {
    yield i;
    await Future<void>.delayed(const Duration(seconds: 1));
  }
}

// Two independent subscriptions, no error:
// countdown(3).listen(print);
// countdown(3).listen(print);
```

Llamar a `countdown(3)` dos veces se ejecutó sin error y le dio a cada llamador `[3, 2, 1, 0]`. Reutilizar un solo `final s = countdown(3)` para dos llamadas a `toList()` lanzó la excepción. La mayoría de las APIs de datos de Flutter ya funcionan así: un método de repositorio como `watchOrders()` que devuelve un stream nuevo por llamada es seguro de invocar desde cada widget que lo necesite, siempre que lo llames en `initState` y no en `build()`.

Cuando quieres un único objeto que se pueda escuchar varias veces pero que siga comportándose por oyente, `Stream.multi` te da exactamente eso. Su callback se ejecuta una vez por cada `listen()` con el controlador propio de ese oyente:

```dart
// Dart 3.12.2
final Stream<int> config = Stream<int>.multi((controller) {
  controller.add(1);
  controller.close();
});

// await config.toList(); // [1]
// await config.toList(); // [1] again, no StateError
```

### 3. Comparte un origen con asBroadcastStream() o un controlador broadcast

Cuando varios widgets deben observar el *mismo* origen en vivo (un socket, una característica BLE, un `Process.stdout`), conviértelo a broadcast una sola vez y reparte ese stream convertido:

```dart
// Flutter 3.44.8, Dart 3.12.2
class ConnectionService {
  ConnectionService(Stream<int> socketEvents)
      : events = socketEvents.asBroadcastStream();

  final Stream<int> events;
}
```

Con `final shared = c.stream.asBroadcastStream()`, dos `StreamBuilder` sobre `shared` mostraron ambos `5` después de `c.add(5)`, y volver a montar uno de ellos no lanzó ninguna excepción. Si eres dueño del productor, créalo como `StreamController<T>.broadcast()` desde el principio.

La llamada tiene que ocurrir **una sola vez**. `widget.stream.asBroadcastStream()` dentro de `build()` es el caso B otra vez: cada llamada crea un nuevo envoltorio broadcast que intenta suscribirse al mismo origen de suscripción única.

## Trampas y variantes

**Los streams broadcast descartan los eventos que nadie estaba escuchando.** Este es el precio de la solución 3, y aparece como una pantalla en blanco en lugar de una excepción. En mis pruebas, un oyente tardío sobre `asBroadcastStream()` recibió solo `[3]` mientras que el primer oyente recibió `[1, 2, 3]`, y un `StreamBuilder` vuelto a montar sobre un stream broadcast mostró `null` hasta el siguiente evento, aunque `7` se hubiera emitido antes. Un controlador de suscripción única, en cambio, acumuló en búfer el `1` que se añadió antes de que alguien escuchara. Si un widget necesita el valor actual cuando aparece, pasa `initialData` o usa un stream que reproduzca el último valor; [reproducir el último valor a suscriptores tardíos sin rxdart](/es/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/) construye uno sobre `Stream.multi`.

**`asBroadcastStream()` mantiene viva la suscripción al origen.** Por defecto, cuando el último oyente broadcast cancela, el envoltorio solo pausa, y el `onCancel` del origen nunca se ejecuta. Mi sonda imprimió `sourceCancelled(default)=false`. Pasar `onCancel: (sub) => sub.cancel()` sí cancela el origen, pero entonces el origen queda agotado para siempre: el siguiente oyente del envoltorio recibió solo `done`. Para un socket o un sensor que quieres cerrar cuando la pantalla desaparece, gestiona el ciclo de vida de forma explícita en lugar de depender del envoltorio.

**Cancelar no es reiniciar.** Algunas soluciones que circulan en línea sugieren cancelar la suscripción anterior antes de volver a escuchar. Eso evita fugas, y deberías hacerlo (consulta [cancelar un StreamSubscription en dispose](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)), pero no vuelve reutilizable a un stream de suscripción única. Solo un stream nuevo lo hace.

**El hot reload conserva el stream roto.** El hot reload preserva el `State` y las variables de nivel superior, así que después de corregir el código, un stream que ya fue consumido en la aplicación en ejecución sigue consumido. Haz hot restart, o detén y vuelve a ejecutar, antes de decidir que la solución no funcionó.

**Los cuerpos de `http` son de un solo uso.** `StreamedResponse.stream` se puede leer una sola vez. Un middleware de registro que llama a `response.stream.bytesToString()` y luego devuelve la misma respuesta al llamador hace que la lectura del llamador lance este error. Lee el cuerpo una vez a bytes y luego construye un nuevo `http.Response` a partir de ellos si algo más adelante lo necesita de nuevo.

**Las bibliotecas de gestión de estado casi siempre se encargan de esto por ti.** El `stream` de un `Bloc` y el `StreamProvider` de Riverpod ya exponen streams broadcast o por oyente, así que el error normalmente significa que se pasó un controlador sin procesar junto a ellos. Si estás sacando una pantalla de los `StreamBuilder` sin procesar, [FutureBuilder y StreamBuilder frente al AsyncValue de Riverpod](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) y [Notifier vs AsyncNotifier vs StreamNotifier](/es/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) explican qué tipo de provider es dueño del ciclo de vida del stream.

**Parecido: `Bad state: Cannot add new events after calling close`.** Mismo tipo de `StateError`, lado opuesto del stream: el productor llamó a `add` sobre un controlador cerrado, normalmente desde un temporizador o callback que sobrevivió a `dispose()`. **Parecido: `Bad state: No element`.** Eso viene de `first`, `single` o `last` sobre un stream (o iterable) que terminó vacío. Ninguno de los dos se arregla con streams broadcast.

## Relacionado

- [How to cancel a StreamSubscription in dispose to avoid a setState-after-dispose crash in Flutter](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [How to replay the latest value to late subscribers of a Dart stream without rxdart](/es/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)
- [How to initialize a Future so FutureBuilder does not recreate it on every rebuild](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [FutureBuilder and StreamBuilder vs Riverpod AsyncValue in Flutter](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/es/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)

## Fuentes

- [Asynchronous programming: Streams](https://dart.dev/libraries/async/using-streams) en dart.dev, la sección sobre suscripción única frente a broadcast.
- [Creating streams in Dart](https://dart.dev/libraries/async/creating-streams), que cubre `async*`, `StreamController` y cuándo usar cada uno.
- Referencia de la API de [`Stream.asBroadcastStream`](https://api.dart.dev/stable/dart-async/Stream/asBroadcastStream.html) y de [`Stream.multi`](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html).
- Referencia de la API de [`StreamBuilder`](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html), y la implementación de `_StreamBuilderBaseState.didUpdateWidget` en `packages/flutter/lib/src/widgets/async.dart` de Flutter 3.44.8.
