---
title: "Solución: Looking up a deactivated widget's ancestor is unsafe en Flutter"
description: "Este fallo significa que llamaste a context.of() después de que el widget salió del árbol, normalmente en un callback asíncrono o en dispose(). Captura el valor antes del await o en didChangeDependencies()."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-14
---

Usaste un `BuildContext` para buscar un ancestro (`Navigator.of`, `Theme.of`, `ScaffoldMessenger.of`, `MediaQuery.of`, `Provider.of`, un `InheritedWidget`) después de que el widget dueño de ese contexto fue retirado del árbol. Los dos disparadores habituales son un callback asíncrono que termina después de que el usuario navegó a otra pantalla, y una búsqueda dentro de `dispose()`. La solución es capturar lo que necesites del contexto antes del `await` (o en `didChangeDependencies`), y proteger el trabajo posterior al await con `if (!mounted) return;`. Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

Un `BuildContext` no es más que un identificador de un `Element` en el árbol. Una vez que ese elemento se desactiva, recorrer hacia arriba desde él puede devolver un ancestro obsoleto o un nodo que está a punto de moverse, así que el framework rechaza la búsqueda en lugar de darte una respuesta incorrecta. Es la misma familia de error de ciclo de vida que un [controlador usado después de ser liberado](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/): el objeto todavía existe, pero ya no es válido tocarlo.

## El error en contexto

El mensaje completo que imprime Flutter se ve así:

```
FlutterError (Looking up a deactivated widget's ancestor is unsafe.
At this point the state of the widget's element tree is no longer stable.
To safely refer to a widget's ancestor in its dispose() method, save a reference
to the ancestor by calling dependOnInheritedWidgetOfExactType() in the widget's
didChangeDependencies() method.)
```

En las compilaciones de release el texto de la aserción se elimina y en su lugar ves un fallo a secas o un `Null check operator used on a null value` más abajo en la pila, porque la búsqueda devolvió `null`. La aserción se dispara desde `Element._debugCheckStateIsActiveForAncestorLookup` en `package:flutter/src/widgets/framework.dart`, que toda llamada a `dependOnInheritedWidgetOfExactType` y `findAncestorStateOfType` ejecuta primero en modo debug.

## Por qué "deactivated" es distinto de "disposed"

Flutter desmonta un widget en dos fases. Primero se ejecuta `deactivate()`: el elemento se separa de su padre y se mueve a una lista de inactivos, donde podría reactivarse en ese mismo frame si fue reparentado con una `GlobalKey`. Solo si no se reclama al final del frame se ejecuta `dispose()` y el estado queda definitivamente muerto.

El getter `mounted` de `State` es `false` para ambas fases. Esa es la idea clave: `mounted` no significa "aún no liberado", significa "actualmente adjunto al árbol". Por eso `mounted` es la protección correcta para este error, aunque la palabra del mensaje sea "deactivated" y no "disposed".

```dart
// Flutter 3.44, Dart 3.x
@override
void deactivate() {
  // mounted is already false by the time your async callback resumes here
  super.deactivate();
}
```

## Reproducción mínima: una búsqueda después del await

La forma más común. Tocas un botón, haces trabajo asíncrono y luego usas el contexto. Si el usuario retrocede durante el await, el contexto está desactivado cuando el callback se reanuda.

```dart
// Flutter 3.44, Dart 3.x -- crashes if the user leaves mid-await
class SaveButton extends StatefulWidget {
  const SaveButton({super.key});
  @override
  State<SaveButton> createState() => _SaveButtonState();
}

class _SaveButtonState extends State<SaveButton> {
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 2)); // network call
    // If the widget was popped during those 2s, this throws:
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Saved')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(onPressed: _save, child: const Text('Save'));
  }
}
```

La segunda reproducción es una búsqueda en `dispose()`, que siempre es insegura porque el elemento ya está separado para entonces:

```dart
// Flutter 3.44, Dart 3.x -- always throws in debug
@override
void dispose() {
  // The element is detached; this ancestor lookup is the exact thing the
  // assertion forbids.
  final messenger = ScaffoldMessenger.of(context);
  messenger.clearSnackBars();
  super.dispose();
}
```

## Solución 1: captura antes del await, protege después

Esta es la solución correcta para el caso asíncrono y la primera a la que recurrir. Un `BuildContext` solo es seguro de leer mientras el widget está montado, así que lee todo lo que necesites de él de forma síncrona, antes del primer `await`. Después, cualquier objeto que hayas capturado (un `NavigatorState`, un `ScaffoldMessengerState`) sigue siendo válido aunque el widget salga del árbol, porque esos objetos de estado sobreviven a la búsqueda individual del elemento.

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _save() async {
  // Capture the ancestor state objects while still mounted.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  await Future<void>.delayed(const Duration(seconds: 2));

  if (!mounted) return; // the widget left the tree; stop here

  messenger.showSnackBar(const SnackBar(content: Text('Saved')));
  navigator.pop();
}
```

Aquí hay dos cosas trabajando. Capturar `messenger` y `navigator` antes del `await` significa que nunca llamas a `.of(context)` sobre un contexto desactivado. El `if (!mounted) return;` luego omite por completo las actualizaciones de la interfaz si el usuario ya se fue, que casi siempre es lo que quieres de todos modos. Ten en cuenta que `mounted` debe comprobarse después del `await`, no antes, porque el await es donde se abre el hueco.

Desde Flutter 3.7 también existe un getter `BuildContext.mounted`, así que si solo tienes un contexto (no un `State`) puedes escribir `if (!context.mounted) return;`. La regla de lint `use_build_context_synchronously`, activada por defecto en `flutter_lints`, marca exactamente la protección que falta en esta reproducción, así que actívala y deja que el analizador atrape estos casos antes de tiempo de ejecución.

## Solución 2: lee los inherited widgets en didChangeDependencies

Si realmente necesitas un valor heredado durante `dispose()`, por ejemplo para desregistrarte de algo que encontraste vía `.of(context)`, no puedes buscarlo en el momento del dispose. Captúralo antes. `didChangeDependencies()` se ejecuta justo después de `initState` y de nuevo cada vez que cambia una dependencia heredada, y el contexto es totalmente válido allí.

```dart
// Flutter 3.44, Dart 3.x -- safe dispose-time access
class _MyWidgetState extends State<MyWidget> {
  late MyModel _model;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Captured while mounted; survives into dispose().
    _model = MyModelScope.of(context);
  }

  @override
  void dispose() {
    _model.removeListener(_onChange); // no context lookup needed
    super.dispose();
  }
}
```

Esto es exactamente lo que el mensaje de error te indica que hagas, modernizado: el texto todavía dice `dependOnInheritedWidgetOfExactType()`, que es la llamada de bajo nivel que envuelven `Theme.of`, `MediaQuery.of` y compañía. Rara vez la llamas directamente; llamar al accesor tipado `.of` en `didChangeDependencies` hace lo mismo.

## Solución 3: no busques contexto dentro de callbacks que no controlas

Una variante sutil: la búsqueda no está en tu `dispose()` sino en un callback que se dispara después del dispose, como un `Timer`, un listener de stream, un listener de estado de animación o un `Future.then`. La solución es la misma protección, pero también conviene cancelar la fuente en `dispose()` para que el callback deje de dispararse por completo.

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<int>? _sub;

@override
void initState() {
  super.initState();
  _sub = someStream.listen((value) {
    if (!mounted) return;          // guard
    Navigator.of(context).pushNamed('/next');
  });
}

@override
void dispose() {
  _sub?.cancel();                  // stop the source
  super.dispose();
}
```

Cancelar la suscripción es el cinturón; la comprobación de `mounted` son los tirantes. Cancelar por sí solo suele arreglarlo, pero un callback que ya estaba en vuelo cuando se ejecuta `cancel()` aún puede reanudarse una vez, así que mantén la protección. El mismo emparejamiento aplica cuando [liberas controladores y otros recursos](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): libera la fuente y protege cualquier cosa que pueda dispararse tarde.

## Detalles a vigilar y casos parecidos

**`initState` es demasiado pronto para `.of(context)` con inherited widgets.** Puedes leer `context` en `initState` para algunas cosas, pero `dependOnInheritedWidgetOfExactType` (y por tanto `Theme.of`, `MediaQuery.of`) no está permitido allí porque el elemento todavía no está conectado a sus dependencias heredadas. Mueve esas lecturas a `didChangeDependencies`. Esto lanza una aserción distinta ("dependOnInheritedWidgetOfExactType was called before initState completed"), así que si tu mensaje menciona `initState`, estás ante la variante de búsqueda temprana, no la de desactivación.

**`Navigator.pop` seguido de un uso del contexto.** Un patrón frecuente en FlutterFlow y en formularios hechos a mano es `Navigator.pop(context)` y luego, en la línea siguiente, otra llamada `.of(context)`. Tras el pop, el elemento de la ruta empieza a desactivarse, así que la segunda búsqueda puede lanzar el error. Captura el navigator o el messenger antes de hacer el pop.

**Reparentado con `GlobalKey`.** Si mueves un subárbol con una `GlobalKey` y algo dentro de él hace una búsqueda de ancestro durante el frame del reparentado, puedes toparte con esto de forma transitoria. Es más raro; la solución es aplazar la búsqueda a después del frame con `WidgetsBinding.instance.addPostFrameCallback` y luego volver a comprobar `mounted`.

**Las compilaciones de release lo ocultan.** Como el mensaje viene de un `assert`, solo se imprime en debug. En profile y release la búsqueda devuelve `null` en silencio y fallas más tarde con una desreferencia de null. Si ves un `Null check operator used on a null value` solo en release y solo después de navegar, sospecha de esto. La [protección de `setState() called during build`](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) se comporta igual: una aserción solo de debug que oculta un null en modo release.

**La versión de Riverpod de esto.** Si usas un `WidgetRef` en vez de `BuildContext`, el fallo equivalente es [`Cannot use "ref" after the widget was disposed`](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Misma causa raíz, misma solución: lee antes del await, protege después. Recurrir a un patrón asíncrono estructurado como [`AsyncValue` para estados de carga y error](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) evita la mayoría de estas protecciones manuales porque el framework rastrea el ciclo de vida del widget por ti.

## La única regla que previene todos estos casos

Trata el `BuildContext` como válido solo entre `build` y el siguiente punto de suspensión. En el momento en que haces `await`, el contexto puede haber desaparecido al volver, así que captura lo que necesites primero y protégelo con `mounted`, o reestructura para que la búsqueda nunca cruce una frontera asíncrona. Una vez que ese hábito está en su sitio, el fallo de "deactivated widget's ancestor", el de controlador liberado y el de ref liberado dejan de aparecer todos por la misma razón.

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html) y [State.didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html), documentación de la API de Flutter.
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html), documentación de la API de Flutter (la llamada nombrada en el mensaje de error).
- [flutter/flutter#19462: "Looking up a deactivated widget's ancestor is unsafe"](https://github.com/flutter/flutter/issues/19462), el issue canónico que lo rastrea hasta `Navigator.push` dentro de un callback asíncrono.
- [use_build_context_synchronously lint](https://dart.dev/tools/linter-rules/use_build_context_synchronously), reglas del linter de Dart, que marca la protección faltante de forma estática.
