---
title: "Cómo reemitir el último valor a los suscriptores tardíos de un Stream de Dart sin el BehaviorSubject de rxdart"
description: "Un StreamController broadcast descarta todos los eventos que ocurrieron antes de que te suscribieras. Aquí tienes un reemplazo de BehaviorSubject sin dependencias basado en Stream.multi, una extensión replayLatest() para streams existentes, el atajo con async* que pierde eventos en silencio y el detalle de initialData en StreamBuilder, todo verificado en Dart 3.12.2."
pubDate: 2026-10-18
template: how-to
tags:
  - "dart"
  - "flutter"
  - "streams"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Respuesta corta:** envuelve un `StreamController.broadcast()` en una clase pequeña que también guarde el último valor, y expón el stream mediante `Stream.multi`. `Stream.multi` llama a tu callback `onListen` una vez por suscriptor, con el `MultiStreamController` propio de ese suscriptor, así que puedes hacer `add` del valor en caché solo al nuevo oyente y después reenviar los eventos del broadcast. Ese es todo el comportamiento del `BehaviorSubject` de rxdart, en unas 40 líneas de `dart:async`. `Stream.multi` existe en el SDK desde Dart 2.9, y cada fragmento de código de abajo se ejecutó en Dart 3.12.2 (el SDK que incluye Flutter 3.44).

El resto de este artículo muestra por qué falla el controller broadcast simple, la clase completa, una extensión que convierte cualquier stream existente en uno que reemite, y los casos límite que importan en una aplicación Flutter: errores, `close()`, pausa, cancelación y el primer frame de un `StreamBuilder`.

## Por qué un stream broadcast lo olvida todo

Un `StreamController` de suscripción única guarda los eventos en un búfer hasta que alguien escucha, pero admite exactamente un oyente. Un controller broadcast admite cualquier cantidad de oyentes, y el precio es que no guarda nada en búfer. Un evento se entrega a quien esté suscrito en el momento en que se dispara, y después desaparece.

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final controller = StreamController<int>.broadcast();
  controller.add(1);                 // nobody is listening: dropped
  await Future(() {});

  controller.stream.listen((v) => print('late listener got $v'));
  controller.add(2);
  await Future(() {});
}
// Output:
// late listener got 2
```

Este es el comportamiento correcto por defecto para datos de tipo evento (toques, notificaciones, líneas de registro) y el incorrecto para datos de tipo estado. Si el stream representa "el usuario actual" o "el estado de la conexión", un widget que se suscribe después del último cambio no muestra nada hasta el siguiente cambio, que puede no llegar nunca. En Flutter esto suele manifestarse como un `StreamBuilder` atascado en su rama de carga, en una pantalla a la que navegaste después de que los datos ya se hubieran cargado.

rxdart lo resuelve con `BehaviorSubject`, que recuerda el último evento y lo emite a cada nuevo suscriptor. Si ya dependes de rxdart, úsalo. Si solo necesitas este comportamiento, incorporar una biblioteca completa de extensiones reactivas es excesivo, y el SDK ya tiene la primitiva que necesitas.

## La primitiva: Stream.multi le da a cada oyente su propio controller

`Stream<T>.multi(void Function(MultiStreamController<T>) onListen, {bool isBroadcast = false})` crea un stream al que se puede escuchar cualquier cantidad de veces. Cada llamada a `listen` invoca `onListen` con un `MultiStreamController` nuevo, y lo que hagas `add` en ese controller va solo a esa suscripción.

Ese gancho por oyente es justo lo que le falta a un controller broadcast. `StreamController.broadcast(onListen: ...)` dispara `onListen` solo cuando la cantidad de oyentes pasa de cero a uno, así que el segundo, el tercero y el centésimo suscriptor nunca reciben un callback en el que puedas entregarles el valor en caché.

La bandera `isBroadcast` no cambia el comportamiento. Solo establece el getter `Stream.isBroadcast`, que algunos consumidores revisan. Ponla en `true` cuando tu stream se comporte como un stream broadcast (se permiten varios oyentes, sin búfer por oyente del pasado más allá de lo que reemites), que es el caso aquí.

## Paso a paso: un BehaviorSubject sin dependencias

1. Mantén un `StreamController` broadcast como centro de eventos.
2. Guarda junto a él el último valor (y si existe alguno).
3. Expón una única instancia de `Stream.multi` cuyo `onListen` primero agregue el valor en caché al controller del nuevo suscriptor y luego le reenvíe los eventos del centro.
4. Conecta la pausa, la reanudación y la cancelación del controller por oyente con la suscripción al centro para que nada se fugue.

```dart
// Dart 3.12.2 (Stream.multi requires Dart 2.9+)
import 'dart:async';

class ValueStream<T> {
  ValueStream(T initial) : _value = initial, _hasValue = true;
  ValueStream.empty();

  final _hub = StreamController<T>.broadcast();
  late T _value;
  bool _hasValue = false;
  Object? _error;
  StackTrace? _stackTrace;

  /// Synchronous access, like BehaviorSubject.value.
  T get value => _value;
  bool get hasValue => _hasValue;

  void add(T value) {
    _value = value;
    _hasValue = true;
    _error = null;
    _hub.add(value);
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _error = error;
    _stackTrace = stackTrace;
    _hub.addError(error, stackTrace);
  }

  Future<void> close() => _hub.close();

  late final Stream<T> stream = Stream.multi((controller) {
    // 1. Replay the latest event to this listener only.
    if (_error != null) {
      controller.addError(_error!, _stackTrace);
    } else if (_hasValue) {
      controller.add(_value);
    }

    // 2. Already closed: replay, then finish.
    if (_hub.isClosed) {
      controller.close();
      return;
    }

    // 3. Forward future events.
    final sub = _hub.stream.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    controller
      ..onPause = sub.pause
      ..onResume = sub.resume
      ..onCancel = sub.cancel;
  }, isBroadcast: true);
}
```

Usarlo se ve así:

```dart
// Dart 3.12.2
Future<void> main() async {
  final status = ValueStream<int>(0);
  status.add(1);

  status.stream.listen((v) => print('A got $v'));
  await Future(() {});
  status.add(2);
  await Future(() {});

  status.stream.listen((v) => print('B got $v'));   // subscribes late
  await Future(() {});
  status.add(3);
  await Future(() {});
}
// Output:
// A got 1
// A got 2
// B got 2
// A got 3
// B got 3
```

`B` se suscribió después de que se emitiera `2` y aun así lo recibió, seguido de todos los eventos posteriores. `A` no recibió un `2` duplicado cuando `B` se unió, porque la reemisión fue al controller propio de `B`.

Algunas decisiones deliberadas en esa clase:

- **`stream` es un campo `late final`, no un getter.** Una sola instancia de `Stream.multi` puede escucharse muchas veces, así que no hay razón para crear una nueva en cada acceso. Además hace que `identical(store.stream, store.stream)` sea verdadero, lo que importa para `StreamBuilder` (más abajo).
- **La reemisión usa `add`, no `addSync`.** `MultiStreamController` tiene `addSync`, `addErrorSync` y `closeSync`, que entregan de inmediato. La documentación de la API indica usarlos solo cuando el oyente está listo para recibir eventos, normalmente desde dentro de otro callback asíncrono. Llamarlos dentro de `onListen` entregaría un evento antes de que `listen()` haya devuelto siquiera la suscripción, lo que rompe la convención de Dart según la cual los streams nunca emiten de forma síncrona durante `listen`. El `add` simple pone el evento en cola y preserva el orden: en mi prueba, un `listen` seguido inmediatamente de dos llamadas síncronas a `add` produjo `100, 101, 102`, en ese orden.
- **Los errores también se reemiten.** Si lo último que ocurrió fue un error, un suscriptor tardío ve el error en lugar de un valor obsoleto. Elimina la rama de `_error` si prefieres reemitir el último valor correcto. `BehaviorSubject` reemite el último evento, error incluido, así que esto coincide con su comportamiento.

## Convertir un stream existente en uno que reemite

Muchas veces no eres dueño del controller. Recibes un `Stream<T>` de un plugin, de un snapshot de Firestore o de un `Socket`, y quieres que varios widgets lo compartan con el último valor reemitido. La documentación del SDK de `Stream.multi` incluye un ejemplo de `repeatLatest()` en esta línea. Aquí tienes una versión que además maneja errores, finalización y conexión perezosa:

```dart
// Dart 3.12.2
import 'dart:async';

extension ReplayLatest<T> on Stream<T> {
  Stream<T> replayLatest() {
    final hub = StreamController<T>.broadcast();
    StreamSubscription<T>? source;
    var hasLatest = false;
    late T latest;
    var done = false;

    void connect() {
      source ??= listen(
        (value) {
          hasLatest = true;
          latest = value;
          hub.add(value);
        },
        onError: hub.addError,
        onDone: () {
          done = true;
          hub.close();
        },
      );
    }

    return Stream.multi((controller) {
      connect();                       // subscribe to the source on first listen
      if (hasLatest) controller.add(latest);
      if (done) {
        controller.close();
        return;
      }
      final sub = hub.stream.listen(
        controller.add,
        onError: controller.addError,
        onDone: controller.close,
      );
      controller
        ..onPause = sub.pause
        ..onResume = sub.resume
        ..onCancel = sub.cancel;
    }, isBroadcast: true);
  }
}
```

Funciona con fuentes de suscripción única, que es justamente el objetivo: la extensión escucha la fuente exactamente una vez y distribuye los eventos.

```dart
// Dart 3.12.2
Future<void> main() async {
  final source = StreamController<int>();          // single-subscription
  final shared = source.stream.replayLatest();

  shared.listen((v) => print('first: $v'));
  source.add(1);
  source.add(2);
  await Future(() {});

  shared.listen((v) => print('late: $v'), onDone: () => print('late: done'));
  await Future(() {});
  source.add(3);
  await source.close();
  await Future(() {});

  shared.listen((v) => print('after close: $v'),
      onDone: () => print('after close: done'));
  await Future(() {});
}
// Output:
// first: 1
// first: 2
// late: 2
// first: 3
// late: 3
// late: done
// after close: 3
// after close: done
```

Fíjate en lo que esta extensión deliberadamente no hace: nunca cancela la suscripción a la fuente, ni siquiera cuando todos los oyentes se han ido. Eso difiere de `shareValue()` de rxdart, que usa conteo de referencias y cancela la fuente cuando se va el último oyente; esta extensión se comporta como `publishValue()` conectado una vez y mantenido vivo, que es lo que quieres para el estado con la vida de la aplicación. Si la fuente es costosa (un stream de GPS, un WebSocket), agrega conteo de referencias: lleva la cuenta de los controllers por oyente activos en `onListen` y `onCancel`, y cancela `source` cuando llegue a cero. Decide desde el principio si un suscriptor tardío posterior a ese punto debería recibir aún el valor antiguo en caché o esperar a una reconexión.

## El atajo con async* que pierde eventos

Lo primero que la mayoría prueba es un generador:

```dart
// Dart 3.12.2 - looks right, is racy
Stream<T> withLatest<T>(T Function() current, Stream<T> updates) async* {
  yield current();
  yield* updates;
}
```

Se lee perfecto, y es incorrecto. Una función `async*` se suspende en `yield` hasta que el evento se ha entregado, y solo entonces continúa hasta la línea `yield*`, que es el momento en que se suscribe al `updates` broadcast. Todo lo que se emita entre la llamada a listen y esa suscripción cae en el hueco. Lo reproduje con un evento programado un microtask después de `listen`:

```dart
// Dart 3.12.2
Future<void> main() async {
  final updates = StreamController<int>.broadcast();
  var current = 20;

  withLatest(() => current, updates.stream)
      .listen((v) => print('got $v'));

  scheduleMicrotask(() {
    current = 21;
    updates.add(21);
  });
  await Future(() {});
  await Future(() {});
}
// Output:
// got 20
```

El `21` nunca se imprime. El suscriptor queda mostrando `20` mientras el estado real es `21`, y ningún evento posterior lo corregirá hasta que cambie otra cosa. La versión con `Stream.multi` no tiene este hueco porque se suscribe al centro de forma síncrona dentro de `onListen`, antes de que pueda dispararse cualquier evento en cola.

## Problemas frecuentes en una aplicación Flutter

**`StreamBuilder` sigue mostrando un frame de "waiting".** La reemisión es asíncrona (esa es la elección de `add` frente a `addSync` de arriba), y `StreamBuilder` construye su primer frame justo después de suscribirse en `initState`. Sin ayuda, ese primer frame tiene `ConnectionState.waiting` y no tiene datos, lo que se muestra como un destello de un frame de tu indicador de carga. Como `ValueStream` expone el valor actual de forma síncrona, pásalo como `initialData`:

```dart
// Flutter 3.44, Dart 3.12.2
StreamBuilder<int>(
  stream: status.stream,
  initialData: status.hasValue ? status.value : null,
  builder: (context, snapshot) {
    if (!snapshot.hasData) return const CircularProgressIndicator();
    return Text('Status: ${snapshot.data}');
  },
)
```

**No construyas el stream dentro de `build`.** `StreamBuilder` se vuelve a suscribir cuando recibe un stream que no es el mismo objeto que la vez anterior. Un getter que devuelve `Stream.multi(...)` o `source.replayLatest()` en cada acceso crea un stream nuevo por cada reconstrucción, de modo que cada reconstrucción cancela y se vuelve a suscribir, y con `replayLatest()` además abre una nueva suscripción a la fuente. Crea el stream una sola vez, en un campo, en un servicio o en `initState`. La misma regla se aplica a los futures, como se explica en [cómo inicializar un Future para que FutureBuilder no lo recree](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

**La cancelación está conectada, pero aún tienes que cancelar.** Como `onCancel` se reenvía a la suscripción al centro, un oyente cancelado se elimina del controller broadcast. En mi prueba `_hub.hasListener` pasó de `true` a `false` tras `cancel()`. A los oyentes a los que llamas `listen` manualmente todavía les hace falta un campo `StreamSubscription` y un `cancel()` en `dispose`, exactamente como en [cancelar un StreamSubscription en dispose](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/). `StreamBuilder` lo hace por ti.

**Cierra el centro cuando su dueño desaparece.** Un `ValueStream` que pertenece al `State` de un widget debe cerrarse en `dispose()`, junto a tus otros controllers, como se describe en [liberar controllers para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/). Escuchar después de `close()` es seguro: el suscriptor recibe el valor final y luego un evento de finalización.

**Los errores reemitidos sin manejar siguen sin manejar.** Si reemites un error a un oyente que no tiene `onError`, se convierte en un error asíncrono no capturado y va al manejador de errores de la zona, que en Flutter es `PlatformDispatcher.instance.onError`. Consulta [cómo capturar errores asíncronos no capturados en Flutter](/es/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/) para ver dónde termina.

**El filtrado por igualdad es una decisión aparte.** `BehaviorSubject` no deduplica, y esta clase tampoco. Si quieres "emitir solo cuando el valor cambie", agrega una guarda `if (value == _value) return;` en `add`, y ten presentes las desventajas con objetos mutables, que cometen el mismo error que [el filtro de igualdad de StreamProvider en Riverpod](/es/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Cuándo no necesitas un stream en absoluto

Si el valor solo alimenta widgets y nunca cruza un límite asíncrono, un `ValueNotifier<T>` con `ValueListenableBuilder` es más simple que cualquier stream: tiene un `value` síncrono, notifica a los oyentes cuando cambia, y el builder lee el valor actual en su primer frame, así que no hay destello de carga. Recurre al stream que reemite cuando necesites operadores de stream (`where`, `asyncMap`, transformaciones al estilo `debounce`), cuando los datos provengan de una API de `Stream` existente, o cuando una biblioteca de gestión de estado como el `StreamProvider` de Riverpod espere un stream. Para una comparación más amplia de esas opciones, consulta [FutureBuilder y StreamBuilder frente al AsyncValue de Riverpod](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

Y cuando necesites más que el último valor, como "reemitir los últimos 10 eventos" o "reemitir todo", la misma estructura con `Stream.multi` funciona con una `Queue<T>` acotada en lugar de un solo campo. En ese punto estás reimplementando el `ReplaySubject` de rxdart, y agregar el paquete es un intercambio razonable.

## Fuentes

- [Stream.multi constructor, Dart API docs](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html)
- [MultiStreamController class, Dart API docs](https://api.dart.dev/stable/dart-async/MultiStreamController-class.html)
- [StreamController.broadcast, Dart API docs](https://api.dart.dev/stable/dart-async/StreamController/StreamController.broadcast.html)
- [Dart SDK 2.9 changelog entry for Stream.multi](https://dart.googlesource.com/sdk/+/refs/tags/2.9.1/CHANGELOG.md)
- [rxdart on pub.dev (BehaviorSubject, ReplaySubject, shareValue)](https://pub.dev/packages/rxdart)
- [Asynchronous programming: streams, dart.dev](https://dart.dev/libraries/async/using-streams)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
