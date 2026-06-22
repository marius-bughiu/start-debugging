---
title: "Cómo usar BuildContext de forma segura después de un await en Flutter"
description: "Captura lo que necesitas del context antes del await y luego protege la reanudación con if (context.mounted) return. Aquí tienes el patrón completo, la regla del linter que lo exige y los casos límite que no detecta."
pubDate: 2026-06-22
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "es"
translationOf: "2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

La regla es corta: un `BuildContext` solo es válido mientras su widget está montado, y un `await` puede desmontar el widget antes de que tu código se reanude. Por eso captura todo lo que necesites del context (un `NavigatorState`, un `ScaffoldMessengerState`, un valor del tema) antes del primer `await`, haz el trabajo asíncrono y luego protege la reanudación con `if (!context.mounted) return;` antes de volver a tocar el context. Ese único hábito previene toda la familia de fallos del tipo "usé un context después de que saliera del árbol". Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

Un `BuildContext` no es una bolsa de datos que puedas guardar y reutilizar. Es un handle vivo a un `Element` del árbol de widgets. En el momento en que el usuario navega a otra pantalla, el padre te reconstruye hasta hacerte desaparecer o la ruta se cierra, ese elemento se desactiva y luego se descarta. Leer un ancestro desde un elemento muerto (`Navigator.of`, `Theme.of`, `Provider.of`) es comportamiento indefinido: en depuración obtienes una aserción, en release obtienes un valor obsoleto o una desreferencia nula mucho más tarde. El caso asíncrono es el que más duele porque el hueco entre "el context era válido" y "el context se usa" es invisible en el código fuente: se esconde dentro del `await`.

## Por qué el await es la parte peligrosa

Flutter llama a `build` de forma síncrona y espera que termine antes de que cualquier otra cosa toque el árbol. Mientras tu código se ejecuta de forma síncrona desde un manejador de eventos, el context sigue siendo válido todo el tiempo. En el instante en que haces `await`, devuelves el control al bucle de eventos. Se ejecutan otros frames. El usuario puede pulsar el botón de retroceso, un `StreamBuilder` padre puede reconstruirse, un timeout puede disparar un cierre de ruta. Cuando tu continuación se reanuda, estás en un frame posterior, y el widget que poseía `context` puede haber desaparecido.

```dart
// Flutter 3.44, Dart 3.x -- the gap is invisible but real
Future<void> _onSave() async {
  await api.save(form);            // <-- control leaves here, frames run
  Navigator.of(context).pop();     // <-- may execute on a dead context
}
```

Nada en `_onSave` parece estar mal. El error es estructural: `context` se capturó de forma implícita en el punto de llamada y se reutilizó a través de un punto de suspensión. Esta es exactamente la situación que describe el [fallo de búsqueda del ancestro de un widget desactivado](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) desde el lado del mensaje de error. Aquí lo estamos viendo desde el lado de la prevención.

## El patrón seguro, paso a paso

Sigue estos cuatro pasos cada vez que un método asíncrono necesite un context después de suspenderse. Los dos primeros son los que sostienen todo; el resto es cómo los mantienes honestos.

1. **Lee todo lo del context antes del primer `await`.** Resuelve `Navigator.of(context)`, `ScaffoldMessenger.of(context)`, `Theme.of(context)` y cualquier llamada a `Provider.of`/`context.read` en variables locales mientras el widget aún está montado. Estas devuelven objetos de estado de larga duración que siguen siendo válidos incluso después de que muera el elemento de origen.
2. **Haz el trabajo asíncrono.** Ahora el `await` puede tardar lo que quiera. No estás reteniendo el context a lo largo de él; estás reteniendo los objetos de estado resueltos, que sobreviven al elemento.
3. **Protege la reanudación con una comprobación de mounted.** Inmediatamente después del `await`, escribe `if (!context.mounted) return;` (o `if (!mounted) return;` dentro de un `State`). Si el widget salió del árbol durante el await, te detienes aquí y nunca tocas un context muerto.
4. **Usa solo los objetos capturados después del hueco.** Llama a `navigator.pop()` y `messenger.showSnackBar(...)` sobre las variables locales que capturaste en el paso 1, no sobre `Navigator.of(context)` de nuevo.

Aplicado al ejemplo defectuoso:

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _onSave() async {
  final navigator = Navigator.of(context);          // 1. capture
  final messenger = ScaffoldMessenger.of(context);

  await api.save(form);                              // 2. async work

  if (!context.mounted) return;                      // 3. guard

  messenger.showSnackBar(                            // 4. use captures
    const SnackBar(content: Text('Saved')),
  );
  navigator.pop();
}
```

Dos cosas independientes hacen que esto sea correcto. Capturar `navigator` y `messenger` antes del await significa que nunca llamas a `.of(context)` sobre un elemento desactivado. La comprobación de `context.mounted` luego se salta el trabajo de UI por completo cuando el usuario ya se fue, que casi siempre es el comportamiento que quieres: no tiene sentido mostrar un snackbar en una pantalla que nadie está mirando.

## mounted en State frente a mounted en BuildContext

Hay dos getters `mounted` y no son intercambiables en cuanto a dónde recurres a ellos, aunque respondan a la misma pregunta.

`State.mounted` ha existido desde siempre. Dentro de la clase de estado de un `StatefulWidget`, escribe `if (!mounted) return;`. Es `true` entre `initState` y `dispose`, y, lo que es crucial, ya es `false` durante `deactivate`, así que captura correctamente el caso de "el widget se está yendo", no solo el de "el widget está totalmente muerto".

`BuildContext.mounted` llegó en Flutter 3.7 (Dart 2.19) para el caso en que solo tienes un context, no un `State`: funciones auxiliares, callbacks en un `StatelessWidget`, métodos de extensión. Devuelve si el elemento subyacente sigue montado.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass:
if (!mounted) return;          // State.mounted

// In a helper that only has a context:
if (!context.mounted) return;  // BuildContext.mounted
```

Prefiere `State.mounted` cuando estés dentro de una clase de estado, porque lee el ciclo de vida del widget que realmente posees. Usa `context.mounted` cuando un context es todo lo que tienes. Ambos deben comprobarse *después* del await, nunca antes: el hueco es el await, así que una comprobación que se ejecuta antes de él no te dice nada sobre el estado posterior.

## Por qué capturar por sí solo no basta, y proteger por sí solo no basta

La gente a menudo hace una de las dos mitades y asume que está cubierta. No lo está.

Si solo **capturas** pero te saltas la protección, evitas el fallo del context desactivado, pero aún puedes ejecutar efectos secundarios de UI contra una pantalla que el usuario ya abandonó: un snackbar que parpadea en la ruta equivocada, un `pop()` que cierra una ruta que ya no es la tuya. Capturar hace que la llamada sea legal; la protección la hace *correcta*.

Si solo **proteges** pero te saltas la captura, tienes un error sutil de orden. Considera:

```dart
// Flutter 3.44, Dart 3.x -- still wrong despite the guard
Future<void> _onSave() async {
  await api.save(form);
  if (!context.mounted) return;
  Navigator.of(context).pop();   // re-reads context AFTER the gap
}
```

Esto suele funcionar, porque la comprobación de `context.mounted` pasó en el mismo tick síncrono que la llamada a `Navigator.of`. Pero es frágil: si añades un segundo `await` entre la comprobación y la búsqueda, la ventana se reabre. El patrón de capturar primero elimina la búsqueda de la ruta posterior al await por completo, así que no queda nada que pueda quedar obsoleto. Trata "capturar antes, proteger después, usar las capturas" como un único movimiento indivisible.

## La regla del linter que lo exige: use_build_context_synchronously

Dart incluye una regla del linter, `use_build_context_synchronously`, que marca un `BuildContext` usado después de un hueco asíncrono sin una protección de `mounted` entre el await y el uso. Está habilitada por defecto en el paquete `flutter_lints`, que los nuevos proyectos de Flutter incluyen mediante `analysis_options.yaml`:

```yaml
# analysis_options.yaml -- on by default in flutter_lints
include: package:flutter_lints/flutter.yaml
```

Si tu proyecto es anterior al valor por defecto o eliminaste el include, añade la regla explícitamente:

```yaml
# analysis_options.yaml
linter:
  rules:
    use_build_context_synchronously: true
```

La regla entiende la protección. Escribir `if (!context.mounted) return;` (o `if (context.mounted) { ... }`) después del await elimina la advertencia, porque el analizador puede demostrar que el context está vivo en la ruta que lo usa. Por eso la forma canónica es `if (context.mounted)` y no algún equivalente que escribiste a mano: el linter compara con los patrones de las formas conocidas como seguras. Versiones anteriores del analizador incluso producían un falso positivo cuando `BuildContext.mounted` se usaba fuera de la forma literal `if (context.mounted) {}`, registrado en la lista de issues del SDK de Dart; las versiones actuales manejan las formas comunes, pero es una razón más para ceñirse a la protección idiomática.

Lo que el linter **no** detecta es igual de importante. Es una comprobación sintáctica, así que no puede ver a través de los límites de las funciones. Si pasas un `BuildContext` a una función auxiliar y haces `await` dentro de esa función, el analizador a menudo no puede conectar el hueco con el uso posterior. Tampoco te salvará de una lógica que captura un context en un campo y lo reutiliza mucho más tarde. El linter es una sólida primera línea de defensa, no una prueba.

## Pasar un context a una función auxiliar

Una vía frecuente para escapar del linter es mover el await a una función auxiliar que toma `BuildContext` como parámetro. El patrón está bien, pero la función auxiliar ahora asume la responsabilidad de la protección, y debería volver a comprobar `mounted` ella misma en lugar de confiar en quien la llama.

```dart
// Flutter 3.44, Dart 3.x -- the helper guards its own context use
Future<void> confirmAndDelete(BuildContext context, Item item) async {
  final messenger = ScaffoldMessenger.of(context);

  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const ConfirmDialog(),
  );

  if (ok != true) return;
  if (!context.mounted) return;   // guard inside the helper

  await repository.delete(item);
  if (!context.mounted) return;   // second await, second guard

  messenger.showSnackBar(const SnackBar(content: Text('Deleted')));
}
```

Dos awaits significan dos protecciones. Cada punto de suspensión reabre la ventana, así que una comprobación de `mounted` corresponde después de cada uno que preceda a un uso del context, no solo del primero. Capturar `messenger` por adelantado significa que la última línea nunca vuelve a leer el context.

## Bucles, reintentos y múltiples awaits

Donde sea que un uso del context se sitúe después de más de una posible suspensión, audita cada ruta. Un bucle de reintentos es el caso de manual:

```dart
// Flutter 3.44, Dart 3.x
Future<void> _uploadWithRetry() async {
  final messenger = ScaffoldMessenger.of(context);

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.upload(file);     // suspension point inside the loop
      break;
    } catch (_) {
      if (attempt == 3) rethrow;
      await Future<void>.delayed(const Duration(seconds: 1)); // another one
    }
  }

  if (!context.mounted) return;   // single guard after the loop is enough
  messenger.showSnackBar(const SnackBar(content: Text('Uploaded')));
}
```

Aquí no necesitas una protección dentro del bucle porque nada dentro del bucle toca el context; el único uso del context es después de él, así que una sola protección cubre todas las rutas de salida. El principio se generaliza: coloca la protección inmediatamente antes de cada uso del context, después del último await que pueda precederlo. Recurrir a un enfoque estructurado como el [manejo elegante de errores y carga](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) mantiene estos flujos legibles, porque los estados de reintento y de error se convierten en datos que tu widget renderiza en lugar de llamadas imperativas de UI dispersas después de los awaits.

## StatelessWidget no tiene mounted, así que usa el context

Un `StatelessWidget` no tiene `State`, así que no hay campo `mounted`. Usa `context.mounted`, que es exactamente para lo que existe:

```dart
// Flutter 3.44, Dart 3.x -- StatelessWidget callback
ElevatedButton(
  onPressed: () async {
    final navigator = Navigator.of(context);
    await Future<void>.delayed(const Duration(seconds: 1));
    if (!context.mounted) return;
    navigator.pop();
  },
  child: const Text('Close'),
);
```

Si te encuentras necesitando varias protecciones en los callbacks de un widget sin estado, eso suele ser señal de que el widget debería ser stateful, o de que el trabajo asíncrono pertenece a un controlador o notifier en lugar de estar incrustado en el manejador del botón.

## Trampas y casos parecidos

**`Navigator.pop` y luego un uso del context.** Un clásico de dos líneas: `Navigator.pop(context)` seguido de otra llamada a `.of(context)`. El pop empieza a desactivar el elemento de la ruta, así que la segunda búsqueda puede fallar aunque no haya ningún await a la vista. Captura el navigator (y cualquier otra cosa) antes de cerrar.

**`initState` no puede hacer búsquedas de inherited.** `Theme.of`, `MediaQuery.of` y cualquier `dependOnInheritedWidgetOfExactType` son ilegales en `initState` porque el elemento aún no está conectado a sus dependencias heredadas. Mueve esas lecturas a `didChangeDependencies`, donde el context es totalmente válido. Esa es una aserción distinta de la asíncrona, pero surge de la misma pregunta "¿es válido el context ahora mismo?".

**Los builds de release ocultan el fallo.** La aserción del context desactivado solo se dispara en depuración. En profile y release la búsqueda devuelve null y obtienes un `Null check operator used on a null value` en algún punto más abajo. Si un fallo aparece solo en release y solo después de navegar, sospecha de un uso del context posterior al await sin protección. La [protección de setState llamado durante build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) tiene el mismo carácter de aserción solo en depuración.

**El equivalente en Riverpod.** Si tienes un `WidgetRef` en lugar de un `BuildContext`, el fallo equivalente es [Cannot use "ref" after the widget was disposed](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Misma causa raíz, misma solución: leer antes del await, proteger después. Modelar el trabajo asíncrono como [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) evita la mayoría de las protecciones manuales, porque el framework rastrea el ciclo de vida del widget por ti y dejas de hurgar en el context a mano.

**Timers y listeners de streams.** Un context usado en un `Timer`, un `Stream.listen` o un listener de estado de animación puede dispararse después de que el widget haya desaparecido. Protege con `mounted`, y además cancela la fuente en `dispose` para que el callback deje de dispararse del todo, la misma disciplina que aplicas cuando [descartas controladores para evitar fugas](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## El único hábito que retira toda esta clase de error

Trata un `BuildContext` como válido solo desde el inicio de una ejecución síncrona hasta el siguiente `await`. Antes de suspenderte, extrae los objetos de estado que vas a necesitar. Después de reanudarte, comprueba `mounted` antes de tocar cualquier cosa atada al árbol. Hazlo de forma mecánica y el fallo del ancestro desactivado, el fallo del controlador descartado y la desreferencia nula posterior al await dejan de aparecer, porque nunca fueron tres errores. Eran una regla, rota de tres maneras.

## Fuentes

- [Regla del linter use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously), reglas del linter de Dart, que define qué marca el analizador y las formas de protección que reconoce.
- [Propiedad BuildContext.mounted](https://api.flutter.dev/flutter/widgets/BuildContext/mounted.html), documentación de la API de Flutter (añadida en Flutter 3.7).
- [Propiedad State.mounted](https://api.flutter.dev/flutter/widgets/State/mounted.html), documentación de la API de Flutter.
- [flutter/flutter#19462](https://github.com/flutter/flutter/issues/19462), el issue canónico que rastrea el fallo del context desactivado hasta los callbacks asíncronos.
