---
title: "Cómo eliminar elementos de una List de Dart mientras la recorres sin un ConcurrentModificationError"
description: "Llamar a remove dentro de un bucle for-in o de forEach lanza ConcurrentModificationError. Usa removeWhere para filtrar en el lugar, crea una lista nueva con where o un collection-for, o recorre el índice hacia atrás. Verificado en Dart 3.13.7, con un benchmark que muestra por qué removeAt en un bucle es la opción lenta."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "collections"
  - "errors"
lang: "es"
translationOf: "2026/10/how-to-remove-items-from-a-dart-list-while-iterating-over-it"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Respuesta corta:** no puedes llamar a `remove`, `removeAt` ni `add` sobre una `List` mientras un bucle `for (final x in list)` o `list.forEach` la está recorriendo, porque el iterador comprueba la longitud de la lista en cada paso y lanza `ConcurrentModificationError` en cuanto cambia. Reemplaza el bucle por `list.removeWhere((x) => condition)` para filtrar en el lugar, o crea una lista nueva con `list.where((x) => !condition).toList()` (o un collection-for) cuando quieras una actualización inmutable. Si de verdad necesitas un bucle por índice, recórrelo hacia atrás desde `list.length - 1` hasta `0`. Todo lo que sigue se ejecutó en Dart 3.13.7 (el SDK que trae Flutter 3.47.8), en la VM, como AOT y compilado a JavaScript.

## El error en contexto

Este es el código que casi todo el mundo escribe primero:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3];
  for (final n in numbers) {
    if (n == 1) numbers.remove(n);
  }
}
```

Y esto es lo que imprime la VM:

```
Unhandled exception:
Concurrent modification during iteration: Instance(length:2) of '_GrowableList'.
#0      ListIterator.moveNext (dart:_internal/iterable.dart:366:7)
#1      main (file:///.../main.dart:4:19)
```

El `length:2` del mensaje es la longitud de la lista *después* de tu modificación, y `_GrowableList` es la clase de implementación de la VM para un literal `[]` normal. En la web el mismo código falla con `Concurrent modification during iteration: Instance of 'JSArray<int>'.`, así que no busques `_GrowableList` en tus logs si el reporte del bug vino de una compilación de Flutter web. Los mapas y los conjuntos producen sus propias variantes, `_Map len:2.` y `_Set len:2.`, con la misma causa raíz.

## Por qué el iterador lanza un error en lugar de simplemente saltar

Un bucle `for-in` sobre una `List` es azúcar sintáctico para obtener `list.iterator` y llamar a `moveNext()` hasta que devuelva `false`. El iterador que Dart usa para listas, `ListIterator` en `dart:_internal`, guarda la longitud de la lista al crearse y la compara en cada `moveNext()`:

```dart
// dart:_internal, sdk/lib/internal/iterable.dart (Dart 3.13.7)
bool moveNext() {
  int length = _iterable.length;
  if (_length != length) {
    throw ConcurrentModificationError(_iterable);
  }
  if (_index >= length) {
    _current = null;
    return false;
  }
  _current = _iterable.elementAt(_index);
  _index++;
  return true;
}
```

`List.forEach` hace la misma comprobación después de cada callback, `removeWhere` comprueba dentro de su propio bucle, y el error se lanza en el paso *siguiente*, no en la línea que modificó la lista. Por eso la traza de pila apunta a `moveNext` y no a `remove`.

La [documentación de `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html) deja claro el contrato: cambiar una colección mientras se recorre en general no está permitido, y la ruptura se señala normalmente lanzando un ConcurrentModificationError la próxima vez que se llama a Iterator.moveNext. La comprobación existe porque la alternativa es peor. Eliminar el elemento `i` desplaza todo lo que viene después una posición a la izquierda, así que un iterador basado en índices se saltaría en silencio el elemento que se deslizó a la posición `i`. Dart prefiere fallar de forma visible.

Dos consecuencias de "el siguiente `moveNext()`" sorprenden a la gente:

- **Eliminar el último elemento también lanza el error.** Podrías esperar que eliminar `4` de `[1, 2, 3, 4]` en la última iteración sea seguro porque no queda nada por visitar. No lo es. El bucle llama a `moveNext()` una vez más para descubrir que terminó, ve que la longitud cambió y lanza el error.
- **Agregar también lo lanza.** `numbers.add(x)` dentro del bucle cambia la longitud igual que `remove`. Dart no tiene un `Iterator.remove()` como el de Java, así que no existe una forma "segura" de modificar la lista a través del propio iterador.

## Elige la solución correcta

Este es el orden de decisión que uso. Cada opción se explica en detalle más abajo.

1. Si quieres quitar elementos de la lista existente en el lugar, llama a `removeWhere` (o a `retainWhere` para lo inverso).
2. Si la lista forma parte de un estado inmutable (Riverpod, Bloc, `ValueNotifier`, un campo `final` que se pasa a widgets), crea una lista nueva con `where(...).toList()` o un collection-for y asígnala.
3. Si la decisión de eliminar depende del índice o de los elementos vecinos, recorre el índice hacia atrás y usa `removeAt`.
4. Si el cuerpo del bucle hace mucho trabajo y solo una parte elimina elementos, recorre una copia (`for (final x in list.toList())`) y elimina de la original.

## Solución 1: `removeWhere` para filtrar en el lugar

Esta es la respuesta canónica y debería ser tu opción por defecto:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 2, 3];
  numbers.removeWhere((n) => n == 2);
  print(numbers); // [1, 3]

  final tasks = <({String title, bool done})>[
    (title: 'write post', done: true),
    (title: 'review PR', done: false),
  ];
  tasks.retainWhere((t) => !t.done);
  print(tasks); // [(done: false, title: review PR)]
}
```

`removeWhere` hace una sola pasada. En la implementación compartida de `ListBase` recorre la lista una vez, reúne los elementos que sobreviven, luego los escribe de vuelta con un único `setRange` y recorta la longitud. Elimina todas las coincidencias, a diferencia de `remove`, que solo elimina el primer elemento igual a su argumento. También es la opción más rápida por mucho, mira el benchmark más abajo.

Los mapas y los conjuntos tienen el mismo método. `map.removeWhere((key, value) => value == 2)` y `set.removeWhere((x) => x.isEven)` son las soluciones para las versiones `_Map` y `_Set` de este error.

Dentro del predicado sigue aplicando una regla: no modifiques la lista desde `test`. Un predicado que llama a `numbers.add(...)` lanza `ConcurrentModificationError` desde dentro de `removeWhere`, por la misma razón que lo hacía el bucle `for-in`.

## Solución 2: crear una lista nueva en lugar de modificarla

Si la lista pertenece a un estado al que otro código tiene una referencia, modificarla en el lugar es el verdadero bug, y el `ConcurrentModificationError` es solo el síntoma que salió a la superficie. Crea una lista nueva:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3, 4];

  final odds = numbers.where((n) => n.isOdd).toList();
  final alsoOdds = [for (final n in numbers) if (n.isOdd) n];

  print(odds);     // [1, 3]
  print(alsoOdds); // [1, 3]
  print(numbers);  // [1, 2, 3, 4], untouched
}
```

En Flutter esta es la forma que quieres para todo lo que provoca una reconstrucción:

```dart
// Flutter 3.47.8, Dart 3.13.7, flutter_riverpod 3.x
class TodoList extends Notifier<List<Todo>> {
  @override
  List<Todo> build() => const [];

  void clearCompleted() {
    state = [for (final t in state) if (!t.done) t];
  }
}
```

Riverpod, Bloc y `ValueNotifier` solo notifican a sus listeners cuando se asigna un valor nuevo y es distinto del anterior. Llamar a `state.removeWhere(...)` modifica la misma instancia de la lista sin asignar nada, así que nada se reconstruye, y si `state` se creó con `const []` o `List.unmodifiable`, lanza `UnsupportedError: Cannot remove from an unmodifiable list` en su lugar. Si estás llevando un widget con `setState` hacia ese modelo, la [migración de setState a un Notifier de Riverpod](/es/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) recorre el resto de la conversión.

Cuidado con la evaluación perezosa. `where` devuelve un `Iterable` perezoso que lee de la lista original a medida que lo consumes, así que esto todavía lanza el error:

```dart
// Dart 3.13.7: throws ConcurrentModificationError
for (final n in numbers.where((n) => n.isEven)) {
  numbers.remove(n);
}
```

El `.toList()` es lo que materializa el resultado y rompe el vínculo con la fuente.

## Solución 3: recorrer el índice hacia atrás

A veces la decisión depende de la posición: "elimina un elemento si es igual al anterior" o "elimina todas las entradas después del primer error". Un bucle por índice está bien aquí, siempre que vaya hacia atrás:

```dart
// Dart 3.13.7
void main() {
  final values = [1, 2, 2, 3, 3, 3, 4];

  // Remove consecutive duplicates.
  for (var i = values.length - 1; i > 0; i--) {
    if (values[i] == values[i - 1]) values.removeAt(i);
  }
  print(values); // [1, 2, 3, 4]
}
```

Los bucles por índice nunca tocan el iterador, así que nunca lanzan `ConcurrentModificationError`. Eso no hace correcto a un bucle hacia adelante:

```dart
// Dart 3.13.7: no exception, wrong answer for adjacent matches
final numbers = [1, 2, 2, 3];
for (var i = 0; i < numbers.length; i++) {
  if (numbers[i] == 2) numbers.removeAt(i);
}
print(numbers); // [1, 2, 3]  (one 2 survived)
```

Cuando se ejecuta `removeAt(1)`, el segundo `2` se desliza al índice 1, y luego `i++` lo pasa de largo. Recorrer hacia atrás evita esto porque eliminar el índice `i` solo desplaza elementos que ya visitaste. Si insistes en un bucle hacia adelante, incrementa `i` solo cuando no eliminaste nada, pero el bucle hacia atrás es más difícil de equivocar.

## Solución 4: recorrer una copia

Cuando el cuerpo del bucle hace trabajo real (registrar eventos, disparar callbacks, actualizar otras estructuras) y la eliminación es un efecto secundario de algunas iteraciones, recorrer una instantánea mantiene el código legible:

```dart
// Dart 3.13.7
void main() {
  final pending = [1, 2, 2, 3];
  for (final job in pending.toList()) {
    final ok = job != 2; // pretend this ran the job
    if (ok) pending.remove(job);
  }
  print(pending); // [2, 2]
}
```

`toList()` cuesta una asignación y una copia de las referencias, algo despreciable para listas del tamaño de una interfaz. Ten en cuenta que `remove(job)` elimina el *primer* elemento igual a `job`, lo cual está bien para objetos únicos y sorprende con valores duplicados. Para un `Map`, el equivalente es `for (final key in map.keys.toList())`.

## Por qué `removeAt` en un bucle es la opción lenta

Cada `removeAt(i)` desplaza todos los elementos después de `i` una posición a la izquierda, así que eliminar `k` elementos de una lista de `n` cuesta aproximadamente `O(n * k)` movimientos de elementos. `removeWhere` y `where(...).toList()` hacen una sola pasada `O(n)`. Medí las tres opciones en una `List<int>` de 200 000 elementos, eliminando los 100 000 números pares, compilado con `dart compile exe` en una Mac con Apple Silicon:

```dart
// Dart 3.13.7, dart compile exe, macOS arm64
void main() {
  const n = 200000;
  var a = List<int>.generate(n, (i) => i);
  var sw = Stopwatch()..start();
  for (var i = a.length - 1; i >= 0; i--) {
    if (a[i].isEven) a.removeAt(i);
  }
  print('removeAt backwards: ${sw.elapsedMilliseconds} ms');

  var b = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  b.removeWhere((x) => x.isEven);
  print('removeWhere: ${sw.elapsedMicroseconds} us');

  var c = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  final d = c.where((x) => x.isOdd).toList();
  print('where.toList: ${sw.elapsedMicroseconds} us (${d.length})');
}
```

| Enfoque | Tiempo (mediana de 3 ejecuciones) |
| --- | --- |
| bucle `removeAt` hacia atrás | ~3 720 ms |
| `removeWhere` | ~1.0 ms |
| `where(...).toList()` | ~1.45 ms |

Son tres órdenes de magnitud y medio. Para una lista de 20 tareas nada de esto importa y deberías elegir la versión que se lea mejor. Para cualquier cosa que procese datos (filas de CSV parseadas, entradas de log, una limpieza de caché), usa `removeWhere` y reserva el bucle por índice para la lógica que realmente necesita posiciones. Si necesitas procesar una lista muy grande fuera del hilo de la interfaz, [ejecutar el trabajo en un isolate de Dart](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) mantiene los frames fluidos, pero no arregla un bucle `O(n^2)`.

## Cuando también necesitas los elementos eliminados

`removeWhere` devuelve `void`, así que no puedes ver lo que quitó. La solución tentadora llama al predicado dos veces:

```dart
final removed = items.where(isExpired).toList();
items.removeWhere(isExpired);
```

Eso solo es correcto si `isExpired` es determinista. Si lee `DateTime.now()`, un elemento puede expirar entre las dos llamadas y desaparecer sin aparecer en `removed`. Mejor particiona en una sola pasada:

```dart
// Dart 3.13.7
extension RemoveAndCollect<E> on List<E> {
  List<E> removeWhereAndCollect(bool Function(E element) test) {
    final removed = <E>[];
    final kept = <E>[];
    for (final e in this) {
      (test(e) ? removed : kept).add(e);
    }
    if (removed.isNotEmpty) {
      setRange(0, kept.length, kept);
      length = kept.length;
    }
    return removed;
  }
}

void main() {
  final items = [1, 2, 3, 4, 5];
  final evens = items.removeWhereAndCollect((x) => x.isEven);
  print(items); // [1, 3, 5]
  print(evens); // [2, 4]
}
```

El `for-in` aquí es seguro porque nada modifica `this` hasta que el bucle terminó.

## Trampas que ocultan el error o lo cambian

**Eliminar y luego agregar en la misma iteración corrompe el bucle en silencio.** El iterador solo compara longitudes. Si una iteración elimina un elemento y agrega otro, la longitud no cambia y no se lanza nada:

```dart
// Dart 3.13.7: no exception, element 3 is never visited
final l = [1, 2, 3, 4];
for (final x in l) {
  print('visit $x'); // visit 1, visit 2, visit 4, visit 20
  if (x == 2) {
    l.remove(x);
    l.add(20);
  }
}
```

`3` se deslizó a la posición que ya se había visitado y se lo saltó. La ausencia de un `ConcurrentModificationError` no prueba que el código sea correcto. Reemplazar un elemento en el lugar, `l[i] = newValue`, está bien de verdad, porque nunca cambia la longitud ni desplaza nada.

**Un `await` dentro del bucle abre la puerta a otro código.** Esta es la versión que aparece en apps de Flutter como un crash intermitente:

```dart
// Dart 3.13.7
import 'dart:async';

Future<void> main() async {
  final items = [1, 2, 3];
  Timer(const Duration(milliseconds: 5), () => items.removeAt(0));

  for (final x in items) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    print('processed $x');
  }
  // processed 1, then ConcurrentModificationError
}
```

Nada dentro del cuerpo del bucle toca `items`. Lo hace un timer, un listener de un stream o el handler de un toque de botón que se ejecuta durante el `await`. La solución es la misma que la Solución 4: recorre `items.toList()`, o haz inmutable la lista compartida y reemplázala. Si el bucle asíncrono vive en un `State`, ese mismo hueco es donde también necesitas la [comprobación de mounted antes de llamar a setState](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/), y una llamada sin `await` dentro del bucle es justo lo que los [lints `unawaited_futures` y `discarded_futures`](/es/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) están para atrapar.

**Los mapas toleran actualizar valores, no cambiar claves.** `for (final k in map.keys) map[k] = 0;` está bien porque actualizar una clave existente no cambia la estructura del mapa. `map.remove(k)` o agregar una clave nueva lanza el error. Eliminar una clave que no está presente no hace nada y no lanza.

**`addAll` sobre sí misma lanza de inmediato.** `list.addAll(list)` sobre una lista growable de la VM lanza `ConcurrentModificationError` sin que haya ningún bucle a la vista. Usa `list.addAll(list.toList())` o `[...list, ...list]`.

**Las listas de longitud fija y las no modificables lanzan `UnsupportedError`, no este error.** `List.filled(3, 0).removeWhere(...)` lanza `Unsupported operation: Cannot remove from a fixed-length list`, y una lista `const` o `List.unmodifiable` lanza `Cannot remove from an unmodifiable list`. La [documentación de `removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) lo dice: la lista debe ser growable. Usa la Solución 2 para esos casos.

**Eliminar de una lista que alimenta un `ListView` necesita keys.** Después de `setState(() => _items.removeWhere(...))`, Flutter empareja los hijos viejos y nuevos por posición a menos que les des keys, así que el estado por elemento (un checkbox, un campo de texto, una animación) puede saltar a la fila equivocada. El [artículo sobre las keys de Flutter](/es/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) cubre la solución con `ValueKey(item.id)`.

### Lee a continuación

- [Cómo proteger setState con la comprobación de mounted después de un hueco asíncrono en Flutter](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [¿Qué es una Key de Flutter y cuándo omitirla causa bugs?](/es/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Migrar un StatefulWidget con setState a un Notifier de Riverpod](/es/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [El lint unawaited_futures frente a discarded_futures en Dart](/es/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

### Fuentes

- [Documentación de la clase `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html), sección sobre cambiar una colección durante la iteración
- [Clase `ConcurrentModificationError`](https://api.dart.dev/dart-core/ConcurrentModificationError-class.html)
- [`List.removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) y [`List.retainWhere`](https://api.dart.dev/dart-core/List/retainWhere.html)
- Código fuente del SDK de Dart: [`ListIterator.moveNext` en `sdk/lib/internal/iterable.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/internal/iterable.dart) y [`ListBase._filter` en `sdk/lib/collection/list.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/collection/list.dart)
