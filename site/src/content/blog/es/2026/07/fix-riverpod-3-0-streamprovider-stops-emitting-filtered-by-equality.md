---
title: "Fix: Riverpod 3.0 StreamProvider deja de emitir porque las actualizaciones se filtran con =="
description: "En Riverpod 3.0 cada provider filtra las notificaciones a los listeners con ==, no con identidad. Un StreamProvider que vuelve a emitir el mismo objeto mutable deja de reconstruir la UI después del primer frame. Aquí explicamos por qué pasa y tres formas de solucionarlo. Probado en flutter_riverpod 3.3.2, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-21
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "streams"
lang: "es"
translationOf: "2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality"
translatedBy: "claude"
translationDate: 2026-07-21
---

Si actualizaste a Riverpod 3.0 y un `StreamProvider` de repente reconstruye tu widget exactamente una vez y luego se queda en silencio, la causa es una sola línea de las notas de migración que es fácil de pasar por alto: en 3.0 cada provider filtra las notificaciones a los listeners con `==` en lugar de identidad. Cuando tu stream emite la misma instancia de objeto dos veces (una lista mutable que mutas en el lugar, un modelo respaldado por un controller que vuelves a empujar), Riverpod compara el valor nuevo con el anterior, los encuentra iguales y descarta la notificación. El stream sigue disparándose. Tu `StreamSubscription` fuera de Riverpod seguiría viendo cada evento. Pero `ref.watch` nunca reconstruye, porque en lo que a Riverpod respecta nada cambió. La solución es emitir un valor nuevo, no igual, cada vez, o sobrescribir `updateShouldNotify`. Este post está probado en `flutter_riverpod` 3.3.2 (junio de 2026), Flutter 3.44 y Dart 3.x.

## Qué cambió realmente en 3.0

Antes de 3.0, Riverpod era inconsistente en cómo decidía si un valor nuevo justificaba notificar a los listeners. Algunos tipos de provider comparaban con `==`, otros usaban `identical` y unos pocos tenían lógica a medida. `StreamProvider` estaba del lado de la identidad de esa línea: cualquier evento que el stream produjera se empujaba a los listeners, porque un evento de stream recién entregado, en la práctica, se trataba como nuevo.

Riverpod 3.0 unificó todo eso en una sola regla. De la [guía oficial de migración a 3.0](https://riverpod.dev/docs/3.0_migration): "all providers now use `==` to filter updates." La guía nombra los providers con más probabilidad de verse afectados: "The most likely way for you to be impacted by this change is when using `StreamProvider`/`StreamNotifier`, as stream values will now be filtered by `==`."

Es un buen cambio para la consistencia. Significa que un provider que recomputa un valor igual al último no reconstruirá innecesariamente cada widget aguas abajo, que es la misma optimización que de otro modo buscarías con `select`. El problema es el modo de falla silenciosa que introduce para un patrón que era perfectamente válido en 2.x: emitir un objeto mutable, mutarlo y volver a emitirlo.

## La reproducción mínima

Aquí está lo más pequeño que se rompe. Un repositorio contiene una `List<int>`, le agrega elementos y empuja la misma lista a través de un `StreamController` después de cada agregado.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
import 'dart:async';

class CounterRepository {
  final _values = <int>[];
  final _controller = StreamController<List<int>>.broadcast();

  Stream<List<int>> get stream => _controller.stream;

  void add(int value) {
    _values.add(value);
    _controller.add(_values); // same List instance every time
  }
}
```

Conéctalo a un `StreamProvider` y obsérvalo:

```dart
// flutter_riverpod 3.3.2
final repositoryProvider = Provider((ref) => CounterRepository());

final valuesProvider = StreamProvider<List<int>>((ref) {
  return ref.watch(repositoryProvider).stream;
});

class ValuesView extends ConsumerWidget {
  const ValuesView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(valuesProvider);
    return async.when(
      data: (values) => Text('Count: ${values.length}'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('Error: $e'),
    );
  }
}
```

En 2.x esto muestra `Count: 1`, luego `Count: 2`, luego `Count: 3` a medida que llamas a `add`. En 3.0 muestra `Count: 1` y luego nunca vuelve a actualizarse. El widget se queda atascado en la primera emisión.

## Por qué == devuelve true aquí aunque los datos cambiaron

La trampa es que `_values` es el mismo objeto en cada emisión. Cuando llamas a `_controller.add(_values)` una segunda vez, el stream entrega la misma referencia de `List` idéntica. Riverpod envuelve cada evento de stream en un `AsyncData<List<int>>` y pregunta si el nuevo `AsyncValue` es igual al anterior.

`AsyncValue` implementa igualdad por valor, y dos instancias de `AsyncData` son iguales cuando los valores que contienen son iguales. Para tu lista, `==` recae en la igualdad por defecto de `List`, que para una `List` simple es igualdad por referencia: una lista solo es igual a sí misma. Como es literalmente el mismo objeto, `previous == next` es `true`. Riverpod concluye que el valor no cambió y suprime la notificación. La mutación que realizaste entre emisiones es invisible para la comparación porque no hay ningún "snapshot anterior" contra el cual comparar. Solo hay una lista, y siempre es igual a sí misma.

Esta es la parte que la guía de migración minimiza. Un [issue de GitHub sobre exactamente este comportamiento](https://github.com/rrousselGit/riverpod/issues/4310) lo describe como una falla silenciosa que costó tres días de depuración: los callbacks directos de `stream.listen` siguen recibiendo cada evento, así que el stream parece sano en aislamiento, pero la capa del provider deduplica en silencio. El desajuste entre "el stream se dispara" y "la UI no se reconstruye" es lo que lo hace tan difícil de detectar.

## Solución 1: emitir una instancia nueva cada vez

La solución más directa, y la que casi siempre quieres, es dejar de reutilizar el mismo objeto mutable. Emite un snapshot inmutable para que cada evento sea un valor distinto que no sea `==` al último.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
void add(int value) {
  _values.add(value);
  _controller.add(List<int>.unmodifiable(_values)); // fresh instance each emit
}
```

`List<int>.unmodifiable(_values)` reserva una lista nueva que contiene los elementos actuales. Es un objeto distinto del de la emisión anterior, así que `previous == next` es `false` y Riverpod notifica. Como bono, ya no estás filtrando una lista mutable hacia tu árbol de widgets, lo cual era un bug latente sin importar la versión de Riverpod: cualquier consumidor podría haber mutado el estado interno de tu repositorio a través de la referencia que recibió.

Esta no es una regla específica de Riverpod. Empujar la misma colección mutable a través de un stream y mutarla en el lugar es frágil con cualquier consumidor que tome snapshots o compare valores. Las emisiones inmutables son la solución duradera.

## Solución 2: usar igualdad por valor deliberadamente, y entonces simplemente funciona

A veces *quieres* que `==` compare contenidos, porque estás emitiendo una clase modelo y quieres que la UI omita reconstrucciones cuando nada significativo cambió. En ese caso, dale a tu tipo emitido una igualdad por valor real y el comportamiento de 3.0 se vuelve una ventaja en lugar de un bug.

```dart
// Dart 3.x records give you value equality for free
final positionProvider = StreamProvider<({double lat, double lng})>((ref) {
  return locationStream(); // each event is a new record
});
```

Los records de Dart comparan estructuralmente, así que dos records con los mismos campos son `==`. Eso significa que un stream de GPS que emite las mismas coordenadas dos veces omitirá correctamente la reconstrucción, y uno que emite una posición nueva la disparará. Lo mismo aplica para una clase con un `==`/`hashCode` generado por `freezed`, o un `operator ==` escrito a mano. La regla práctica: si el valor es inmutable y tiene igualdad por valor, 3.0 hace lo correcto automáticamente. Solo se comporta mal cuando cuelas un objeto mutable pasando el chequeo de igualdad al mantener la misma referencia.

## Solución 3: sobrescribir updateShouldNotify en un StreamNotifier

Si genuinamente no puedes cambiar lo que emite el stream (una fuente de terceros, un repositorio heredado que no controlas), puedes sobrescribir la comparación. Esto solo está disponible en la API basada en clases, así que conviertes el `StreamProvider` funcional en un `StreamNotifierProvider` y sobrescribes `updateShouldNotify`.

```dart
// flutter_riverpod 3.3.2 with riverpod_annotation 3.x
@riverpod
class Values extends _$Values {
  @override
  Stream<List<int>> build() {
    return ref.watch(repositoryProvider).stream;
  }

  @override
  bool updateShouldNotify(
    AsyncValue<List<int>> previous,
    AsyncValue<List<int>> next,
  ) {
    return true; // always notify, restore the 2.x behavior for this provider
  }
}
```

Devolver `true` incondicionalmente restaura el comportamiento previo a 3.0 de "notificar en cada emisión" para este único provider sin cambiar el valor por defecto global para el resto de tu app. También puedes hacerlo más inteligente, por ejemplo comparando longitudes o un contador de versión, si las reconstrucciones incondicionales son demasiado agresivas. Ten en cuenta que el `StreamProvider((ref) => ...)` funcional puro no tiene un hook `updateShouldNotify`, así que esta solución requiere la forma basada en clases. Si todavía estás decidiendo entre los estilos funcional y basado en clases, la guía de [migración de Riverpod 2.x a 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) recorre cuándo vale la pena cada uno.

## Cómo confirmar que este es tu bug y no otra cosa

El síntoma (un widget respaldado por stream que se actualiza una vez y se congela) tiene varias causas posibles, así que verifica que sea el filtro de igualdad antes de recurrir a estas soluciones:

1. Agrega un `print` dentro de la fuente del stream, justo antes de `_controller.add(...)`. Si se imprime en cada evento pero el widget no se reconstruye, los eventos están llegando al stream pero se están filtrando aguas abajo.
2. Adjunta un listener puro temporal: `ref.watch(repositoryProvider).stream.listen((v) => debugPrint('raw: $v'))`. Si el listener puro se dispara cada vez pero `ref.watch(valuesProvider)` no se reconstruye, la capa del provider está deduplicando, lo que confirma el filtro `==`.
3. Verifica si el objeto emitido es la misma instancia. Si estás empujando un campo, una lista cacheada o un modelo singleton, casi con seguridad estás cayendo en esto.

Si en cambio el stream mismo deja de dispararse, ese es un problema distinto: un `StreamSubscription` que fue cancelado, un controller que fue cerrado, o un provider que fue desechado y recreado. Para el lado del desecho en los ciclos de vida de stream, mira [cancelar un StreamSubscription en dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Trampas relacionadas en la misma versión 3.0

El filtro de igualdad es uno de un grupo de cambios de 3.0 que aparecen en tiempo de ejecución en lugar de en tiempo de compilación, que es lo que los hace caros de depurar. Otros dos que vale la pena conocer antes de que despliegues:

- **Los errores ahora salen envueltos.** Un provider que lanza ya no relanza tu excepción original directamente. Mira [Riverpod 3.0 lanza ProviderException en lugar del error original](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) para saber cómo desenvolverlo.
- **Los providers fallidos reintentan automáticamente.** Un `FutureProvider` o `StreamProvider` que da error reintentará con backoff exponencial por defecto, lo que puede enmascarar un bug o martillar un endpoint que está fallando. Desactívalo por provider o globalmente como se describe en [desactivar el reintento automático de providers de Riverpod 3.0](/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/).

Y si los huecos asíncronos dentro de tu notifier tocan `ref` después de un `await`, protégelos con el chequeo mounted que se cubre en [verificar Ref.mounted después de un hueco asíncrono](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## La regla de una línea para recordar

Riverpod 3.0 reconstruye cuando `previous != next`. Si tu `StreamProvider` reutiliza un objeto mutable, `previous` y `next` son la misma referencia, así que siempre son iguales y nunca se reconstruye. Emite snapshots inmutables (o dale a tu tipo de valor una igualdad real) y el framework hace lo correcto. Recurre a `updateShouldNotify` solo cuando no puedas controlar el valor emitido. Para una mirada más amplia a cuándo un `StreamProvider` y su `AsyncValue` son siquiera la herramienta correcta frente a los widgets builder más antiguos, la comparación de [FutureBuilder y StreamBuilder frente al AsyncValue de Riverpod](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) es una buena lectura siguiente.

## Fuentes

- [Migrating from 2.0 to 3.0, Riverpod official docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [rrousselGit/riverpod issue #4310: updateShouldNotify changes are downplayed in the migration guide](https://github.com/rrousselGit/riverpod/issues/4310)
- [StreamProvider class reference, flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/StreamProvider-class.html)
