---
title: "Riverpod Notifier vs AsyncNotifier vs StreamNotifier en Flutter: ¿cuál extiendo?"
description: "Elige según el tipo de retorno de build(): T significa Notifier, FutureOr<T> significa AsyncNotifier, Stream<T> significa StreamNotifier. Aquí está la matriz de decisión, la jerarquía de tipos que lo explica y los problemas de filtrado por == y de sobrescritura de estado que afectan a cada uno. Verificado con flutter_riverpod 3.4.2 en Flutter 3.44.2."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "es"
translationOf: "2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-15
---

La elección entre `Notifier`, `AsyncNotifier` y `StreamNotifier` se decide por una sola cosa: el tipo de retorno de tu método `build()`. Si devuelve `T`, extiende `Notifier<T>`. Si devuelve `Future<T>` o un `T` simple que quizá luego quieras volver asíncrono, extiende `AsyncNotifier<T>`. Si tu fuente de datos sigue enviando valores nuevos después del primero, extiende `StreamNotifier<T>`. Todo lo demás (métodos de mutación, `ref.watch` dentro de `build`, familias, auto-disposición) funciona igual en las tres. Todo lo de este post está verificado con `flutter_riverpod` 3.4.2 en Flutter 3.44.2 (estable, 2026-06-10) y Dart 3.12.2, con `riverpod_generator` 4.0.4 para la sección de generación de código.

## La matriz de decisión

| | `Notifier<T>` | `AsyncNotifier<T>` | `StreamNotifier<T>` |
| --- | --- | --- | --- |
| `build()` devuelve | `T` | `FutureOr<T>` | `Stream<T>` |
| El provider expone | `T` | `AsyncValue<T>` | `AsyncValue<T>` |
| Clase de provider | `NotifierProvider` | `AsyncNotifierProvider` | `StreamNotifierProvider` |
| Estado de carga | nunca | `AsyncLoading` primero | `AsyncLoading` primero |
| Valores tras el primero | los escribes tú | los escribes tú | los escribe el stream |
| Modificador `.future` | no | sí | sí |
| Helper `update()` | no | sí | sí |
| Firma de `updateShouldNotify` | `(T, T)` | `(AsyncValue<T>, AsyncValue<T>)` | `(AsyncValue<T>, AsyncValue<T>)` |
| Reemplaza (Riverpod 2.x) | `StateNotifier`, `StateProvider` | `FutureProvider` + métodos | `StreamProvider` + métodos |

La última fila es la que hace tropezar a la gente. `AsyncNotifier` no es "la versión asíncrona de `Notifier`" en el sentido de ser un superconjunto. Es `FutureProvider` con un lugar donde poner métodos de mutación. `StreamNotifier` es `StreamProvider` con lo mismo. Si no necesitas métodos de mutación, un `FutureProvider` o `StreamProvider` simple sigue siendo la respuesta más pequeña.

## Por qué el tipo de retorno es toda la regla

Esto no es una convención de estilo. Está impuesto por la jerarquía de clases en `riverpod` 3.4.2. Cada una de las tres clases públicas declara un `build()` abstracto con un tipo de retorno fijo:

```dart
// package:riverpod/src/providers/notifier/orphan.dart, riverpod 3.4.2
abstract class Notifier<ValueT> extends $Notifier<ValueT> {
  @visibleForOverriding
  ValueT build();
}

// package:riverpod/src/providers/async_notifier/orphan.dart
abstract class AsyncNotifier<StateT> extends $AsyncNotifier<StateT> {
  @visibleForOverriding
  FutureOr<StateT> build();
}

// package:riverpod/src/providers/stream_notifier/orphan.dart
abstract class StreamNotifier<ValueT> extends $StreamNotifier<ValueT> {
  @visibleForOverriding
  Stream<ValueT> build();
}
```

Elige mal y obtienes un error de compilación, no una sorpresa en tiempo de ejecución. Estos son los diagnósticos exactos de `flutter analyze` en Flutter 3.44.2:

```text
error - 'WrongOne.build' ('Future<int> Function()') isn't a valid override of
        'Notifier.build' ('int Function()') - invalid_override

error - 'WrongTwo.build' ('Stream<int> Function()') isn't a valid override of
        'AsyncNotifier.build' ('FutureOr<int> Function()') - invalid_override

error - 'Ok' doesn't conform to the bound 'AsyncNotifier<int>' of the type
        parameter 'NotifierT' - type_argument_not_matching_bounds
```

El tercero es el error de emparejamiento incorrecto: una subclase de `Notifier` entregada a un `AsyncNotifierProvider`. La clase notifier y la clase provider están unidas por un límite genérico, así que no puedes mezclarlas.

## Cuándo elegir Notifier

Recurre a `Notifier<T>` cuando el estado inicial está disponible de forma síncrona y nada fuera de tus propios métodos lo cambia.

```dart
// flutter_riverpod 3.4.2, Flutter 3.44.2, Dart 3.12.2
class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new);
```

`ref.watch(counterProvider)` te da un `int`, no un `AsyncValue<int>`. No hay rama de carga que renderizar ni rama de error tampoco, y ese es exactamente el punto: la selección de un filtro, la marca de "modificado" de un formulario, el índice de una pestaña seleccionada, un carrito de compras en memoria. Si te encuentras escribiendo `AsyncData(...)` alrededor de un valor que ya tienes, elegiste la clase base equivocada.

Lo que sorprende a quienes vienen de `StateNotifier`: `build()` puede volver a ejecutarse. Si haces `ref.watch` de otro provider dentro, un cambio aguas arriba vuelve a ejecutar `build()` y resetea tu estado. La instancia del notifier se conserva, así que los campos de instancia sobreviven:

```dart
// Verified: constructed once, built twice after the dependency changed.
expect(Instanced.built, 2);        // build() re-ran
expect(Instanced.constructed, 1);  // the object was not recreated
```

## Cuándo elegir AsyncNotifier

Recurre a `AsyncNotifier<T>` cuando el estado inicial viene de un `Future` y todos los valores posteriores vienen de tus propios métodos de mutación.

```dart
// flutter_riverpod 3.4.2
class AsyncCounter extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    return 0;
  }

  Future<void> increment() async {
    final current = await future;      // resolves to the latest non-loading value
    state = AsyncData(current + 1);
  }
}

final asyncCounterProvider =
    AsyncNotifierProvider<AsyncCounter, int>(AsyncCounter.new);
```

El getter `future` dentro del notifier y el modificador `.future` en el provider vienen ambos del mixin `$AsyncClassModifier`. También `update()`, que es la versión ergonómica del leer-modificar-escribir de arriba:

```dart
Future<void> increment() => update((current) => current + 1);
```

Un detalle que vale la pena conocer porque cambia lo que tu widget renderiza en el primer frame: `build()` devuelve `FutureOr<T>`, así que devolver un valor de forma síncrona es legal, y cuando lo haces, el provider nunca pasa por `AsyncLoading`.

```dart
class SyncishAsync extends AsyncNotifier<int> {
  @override
  int build() => 42;   // legal: FutureOr<int> accepts int
}

// Verified: the very first read is AsyncData(42), not AsyncLoading.
expect(container.read(syncishProvider), isA<AsyncData<int>>());
```

Eso hace de `AsyncNotifier` un valor por defecto razonable para estado que hoy es síncrono pero que esperas mover detrás de una llamada de red más adelante. Lo pagas con un envoltorio `AsyncValue` que tienes que desenvolver en cada widget, y por eso no lo usaría para el índice de una pestaña. Para renderizar ese envoltorio con limpieza, la mecánica es la misma que se cubre en [mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Cuándo elegir StreamNotifier

Recurre a `StreamNotifier<T>` cuando la fuente sigue enviando valores. Un listener de snapshots de Firestore, un WebSocket, un `Stream` de un plugin, un temporizador periódico.

```dart
// flutter_riverpod 3.4.2
class Ticker extends StreamNotifier<int> {
  @override
  Stream<int> build() {
    final controller = StreamController<int>();
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 5), (_) {
      controller.add(i++);
    });
    ref.onDispose(() {
      timer.cancel();
      controller.close();
    });
    return controller.stream;
  }
}

final tickerProvider = StreamNotifierProvider<Ticker, int>(Ticker.new);
```

El comportamiento distintivo es que el estado sigue cambiando sin que tú escribas en `state`. Escuchar ese provider y recolectar las emisiones da `[0, 1, 2, ...]`, donde un `AsyncNotifier` habría dado exactamente un `AsyncData` y luego se habría detenido.

Riverpod gestiona la suscripción por ti. Cuando `build()` vuelve a ejecutarse porque cambió una dependencia observada, la suscripción anterior se cancela antes de suscribirse al nuevo stream:

```dart
// Verified with a StreamController whose onCancel increments a counter.
expect(Feed.subscribes, 2);  // build re-ran, new stream
expect(Feed.cancels, 1);     // Riverpod cancelled the old subscription
```

Aun así necesitas el `ref.onDispose` de arriba para recursos que el stream mismo no posee, como el `Timer`. Riverpod cancela su suscripción a tu stream; no sabe nada del temporizador que lo alimenta. Es la misma disciplina que en [liberar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## AsyncNotifier y StreamNotifier son hermanos, no padre e hijo

El dartdoc de `StreamNotifier` lo llama "una variante de `AsyncNotifier`", lo que se lee como herencia. No lo es. Ambos extienden la misma base interna y difieren solo en un argumento genérico:

```dart
// package:riverpod/src/providers/async_notifier.dart, riverpod 3.4.2
abstract class $AsyncNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, FutureOr<ValueT>> {}

// package:riverpod/src/providers/stream_notifier.dart
abstract class $StreamNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, Stream<ValueT>> {}
```

`$AsyncNotifierBase<ValueT>` extiende `AnyNotifier<AsyncValue<ValueT>, ValueT>` en ambos casos, y por eso ambos exponen `AsyncValue<T>` y ambos obtienen `future` y `update()`. La única diferencia es `CreatedT`: `FutureOr<ValueT>` frente a `Stream<ValueT>`. Mientras tanto `$Notifier<StateT>` extiende `$SyncNotifierBase<StateT>`, que extiende `AnyNotifier<StateT, StateT>`, así que su tipo de estado y su tipo de valor son el mismo.

La consecuencia práctica es que una comprobación de tipo contra `AsyncNotifier` no coincidirá con un `StreamNotifier`, así que el código genérico que hace `if (notifier is AsyncNotifier)` omite en silencio tus providers respaldados por streams:

```dart
// Verified on riverpod 3.4.2
expect(Ticker(), isNot(isA<AsyncNotifier<int>>()));
expect(AsyncCounter(), isNot(isA<StreamNotifier<int>>()));
```

## El problema del filtrado por == afecta a las tres

Riverpod 3.0 estandarizó el uso de `==` para decidir si notificar a los listeners. La mayoría de los artículos lo plantean como un problema de `Notifier`, porque el síntoma clásico es mutar una `List` en el sitio y no ver ningún rebuild. No es un problema de `Notifier`. También aplica a `AsyncNotifier` y `StreamNotifier`, porque `AsyncValue.operator ==` compara el valor envuelto con `==`:

```dart
// package:riverpod/src/core/async_value.dart, riverpod 3.4.2
@override
bool operator ==(Object other) {
  return runtimeType == other.runtimeType &&
      other is AsyncValue<ValueT> &&
      other._loading == _loading &&
      other.valueFilled == valueFilled &&
      other._errorFilled == _errorFilled;
}
```

Envolver la misma instancia de `List` en un `AsyncData` nuevo produce por tanto un valor que es `==` al estado anterior, y la notificación se descarta:

```dart
// Verified: both of these are silent no-ops for listeners.
class AsyncTodoList extends AsyncNotifier<List<String>> {
  @override
  List<String> build() => <String>[];

  void addMutating(String v) {
    final list = state.requireValue..add(v);
    state = AsyncData(list);            // same list instance, == is true
  }

  void addReplacing(String v) =>
      state = AsyncData([...state.requireValue, v]);   // new list, notifies
}

final list = ['x'];
expect(AsyncData(list) == AsyncData(list), isTrue);
expect(AsyncData(['x']) == AsyncData(['x']), isFalse);
```

La solución es la misma en las tres clases: asigna siempre una instancia nueva de la colección en vez de mutar y reasignar. La escotilla de escape también es la misma, pero fíjate en que la firma cambia con la clase base, porque `updateShouldNotify` recibe el tipo de *estado*, no el tipo de valor:

```dart
// Notifier<List<String>>
@override
bool updateShouldNotify(List<String> previous, List<String> next) => true;

// AsyncNotifier<List<String>> or StreamNotifier<List<String>>
@override
bool updateShouldNotify(
  AsyncValue<List<String>> previous,
  AsyncValue<List<String>> next,
) => true;
```

Si llegaste aquí después de que un stream dejara misteriosamente de actualizar la UI, la misma causa raíz se cubre con más profundidad en el artículo sobre [los eventos de StreamProvider filtrados por igualdad en Riverpod 3.0](/es/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## El problema de StreamNotifier: tus escrituras se sobrescriben

`StreamNotifier` hereda el setter de `state`, así que nada te impide asignarle un valor. Pero el stream sigue vivo, y el siguiente evento gana:

```dart
// Verified against a StreamNotifier whose build() emits every 5ms.
container.read(tickerProvider.notifier).poke();       // state = AsyncData(999)
expect(container.read(tickerProvider).value, 999);    // holds, briefly

await Future<void>.delayed(const Duration(milliseconds: 20));
expect(container.read(tickerProvider).value, isNot(999));  // the stream won
```

Esto no es un bug, y no es razón para evitar métodos de mutación en un `StreamNotifier`. Es razón para hacer la mutación optimista y dejar que el stream la confirme. Escribe en `state` para la respuesta inmediata de la UI, envía el cambio al backend y deja que el evento devuelto por el stream se convierta en la fuente de verdad:

```dart
// flutter_riverpod 3.4.2
Future<void> send(String message) async {
  state = AsyncData([...(state.value ?? const []), message]);  // optimistic
  await _api.post(message);   // the server echoes this back down the stream
}
```

Si el stream no devuelve tus mutaciones, tu problema no tiene forma de stream. Usa un `AsyncNotifier` y gestiona el estado tú mismo.

## La generación de código elige por ti

Con `riverpod_generator` nunca nombras la clase base. Anotas con `@riverpod`, extiendes el `_$Foo` generado, y el generador lee el tipo de retorno de `build()`. Aquí hay tres clases que difieren solo en ese tipo de retorno, y las declaraciones generadas correspondientes de `riverpod_generator` 4.0.4:

```dart
// gen.dart
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;
}

@riverpod
class AsyncCounter extends _$AsyncCounter {
  @override
  Future<int> build() async => 0;
}

@riverpod
class Ticker extends _$Ticker {
  @override
  Stream<int> build() => Stream.value(0);
}
```

```dart
// gen.g.dart, generated
final class CounterProvider extends $NotifierProvider<Counter, int> { ... }
abstract class _$Counter extends $Notifier<int> { ... }

final class AsyncCounterProvider
    extends $AsyncNotifierProvider<AsyncCounter, int> { ... }
abstract class _$AsyncCounter extends $AsyncNotifier<int> { ... }

final class TickerProvider extends $StreamNotifierProvider<Ticker, int> { ... }
abstract class _$Ticker extends $StreamNotifier<int> { ... }
```

Cambia `Future<int> build()` por `Stream<int> build()`, vuelve a ejecutar el builder, y la clase base cambia por debajo sin ninguna otra edición. Ese es el argumento práctico más fuerte a favor de la generación de código en esta pregunta concreta.

Una asimetría que la salida generada hace visible: los providers generados son auto-disposing, los escritos a mano no.

```dart
// gen.g.dart: every generated provider passes isAutoDispose: true
CounterProvider._() : super(..., isAutoDispose: true, ...);

// Hand-written, verified on riverpod 3.4.2:
expect(counterProvider.isAutoDispose, isFalse);
expect(asyncCounterProvider.isAutoDispose, isFalse);
expect(tickerProvider.isAutoDispose, isFalse);
```

Para un `StreamNotifier` esa diferencia sale cara: un provider de stream escrito a mano mantiene su suscripción abierta para siempre en cuanto algo lo lee, porque `NotifierProvider`, `AsyncNotifierProvider` y `StreamNotifierProvider` ponen `isAutoDispose` en `false` por defecto. Pasa `NotifierProvider(..., isAutoDispose: true)` si quieres el comportamiento generado sin generar.

## Una advertencia más sobre versiones

En Flutter 3.44.2 los paquetes más nuevos no se resuelven juntos ahora mismo. `flutter_riverpod` 3.4.2 más cualquier versión de `riverpod_generator` falla la resolución de versiones contra el `matcher` 0.12.19 y el `test_api` 0.7.11 que este SDK de Flutter fija a través de `flutter_test`. La combinación que resuelve limpiamente es `flutter_riverpod` 3.3.2 con `riverpod_annotation` 4.0.3 y `riverpod_generator` 4.0.4, que es de donde salió la salida generada de arriba. Nada de la regla de selección de clase difiere entre 3.3.2 y 3.4.2, pero si usas generación de código, espera ir una versión menor por detrás del paquete de runtime hasta que la restricción del SDK se ponga al día.

## La recomendación

Por defecto usa `AsyncNotifier` para todo lo que toque E/S, `Notifier` para todo lo que no, y `StreamNotifier` solo cuando una fuente realmente envía más de un valor. El modo de fallo de elegir `AsyncNotifier` cuando bastaba `Notifier` es un poco de ruido de desenvolver `AsyncValue` en tus widgets. El modo de fallo de elegir `Notifier` cuando los datos son asíncronos es un campo `late`, un `LateInitializationError` y un booleano de carga manual, que es estrictamente peor. Y si usas generación de código, deja de pensar en esto: escribe el `build()` que realmente quieres y deja que el generador elija.

## Relacionados

- [Qué paquete de Riverpod instalar: riverpod, flutter_riverpod o hooks_riverpod](/es/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [FutureBuilder y StreamBuilder comparados con el AsyncValue de Riverpod](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [La guía completa de migración de Riverpod 2.x a 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Mover un StatefulWidget con setState a un Notifier de Riverpod](/es/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Convertir un FutureBuilder en un AsyncNotifier de Riverpod](/es/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Fuentes

- [Qué hay de nuevo en Riverpod 3.0](https://riverpod.dev/docs/whats_new), sobre la unificación de notifiers y el cambio a `==` para el filtrado de notificaciones.
- [riverpod 3.4.2 en pub.dev](https://pub.dev/packages/riverpod/versions/3.4.2), fuente de las declaraciones de `Notifier`, `AsyncNotifier` y `StreamNotifier` citadas arriba.
- [flutter_riverpod 3.4.2 en pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.2).
- [riverpod_generator 4.0.4 en pub.dev](https://pub.dev/packages/riverpod_generator/versions/4.0.4), el generador cuya salida se muestra en la sección de generación de código.
