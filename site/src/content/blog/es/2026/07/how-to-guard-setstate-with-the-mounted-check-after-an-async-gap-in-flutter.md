---
title: "Cómo proteger setState con la comprobación mounted tras un hueco asíncrono en Flutter"
description: "Después de un await, el widget puede estar ya destruido, y llamar a setState lanza una excepción. Protege la reanudación con if (!mounted) return; y, mejor aún, cancela el trabajo que lo dispara. El patrón completo para Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "es"
translationOf: "2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

La regla cabe en una línea: dentro de un `State`, nunca llames a `setState` después de un `await` sin comprobar antes `if (!mounted) return;`. Un `await` devuelve el control al bucle de eventos, el usuario puede cerrar la pantalla mientras corre tu trabajo asíncrono, y cuando tu código se reanuda el widget puede estar ya destruido. Llamar a `setState` sobre un `State` destruido lanza `setState() called after dispose()`. El getter `mounted` te dice si el `State` sigue en el árbol, así que proteger la reanudación con él vuelve imposible el fallo. Todavía mejor: cancela el temporizador, la suscripción o la solicitud que llamaría a `setState`, para que el callback nunca se ejecute sobre un widget muerto. Esta guía usa Flutter 3.44 (estable actual, 2026) y Dart 3.x.

`mounted` es un getter de `State<T>`. Es `true` desde el momento en que el framework conecta tu `State` con su `BuildContext`, antes de que se ejecute `initState`, y sigue siendo `true` hasta que se llama a `dispose`, tras lo cual es `false` para siempre. Por dentro no es más que una comprobación de null sobre la referencia al elemento: `bool get mounted => _element != null;`. Ese es todo el mecanismo. Cuando el elemento que respalda tu widget se arranca del árbol, `_element` pasa a null, `mounted` cambia a `false`, y cualquier `setState` que intentes a partir de ese punto es un error que el framework rechaza activamente.

## Por qué un await es donde esto se rompe

Flutter lo mueve todo desde un único hilo de UI. Mientras tu manejador de eventos corre de forma síncrona, el widget que estás mirando no puede desaparecer a mitad del método: nada más obtiene su turno. En el instante en que escribes `await`, esa garantía desaparece. El control vuelve al bucle de eventos, se renderizan otros frames, corren callbacks de gestos, se completan transiciones de ruta. Tu continuación queda programada para alguna microtarea posterior, y entre "antes del await" y "después del await" el usuario podría haber tocado atrás, un padre podría haberte reconstruido fuera de existencia, o un `Navigator.pop` en otro lugar podría haber destruido tu ruta.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _ProfileState extends State<Profile> {
  bool _loading = false;
  User? _user;

  Future<void> _load() async {
    setState(() => _loading = true);      // fine: still on the same frame
    final user = await api.fetchUser();    // control leaves; frames run
    setState(() {                          // may run after dispose()
      _user = user;
      _loading = false;
    });
  }
}
```

Nada en `_load` parece incorrecto, y funciona siempre que lo pruebas en una pantalla que no abandonas. Navega fuera mientras `fetchUser` está en vuelo, en cambio, y el segundo `setState` aterriza sobre un `State` destruido. En depuración obtienes un `FlutterError`: `setState() called after dispose(): _ProfileState#1a2b3(lifecycle state: defunct, not mounted)`. Este es el mismo error estructural descrito desde el lado del contexto en [usar BuildContext de forma segura tras un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), pero aquí la víctima es la mutación de estado, no una búsqueda de widget heredado.

## La protección mínima, paso a paso

Sigue estos tres pasos para cualquier método asíncrono en un `State` que llame a `setState` después de suspenderse.

1. **Haz el trabajo asíncrono.** Deja que el `await` tarde lo que necesite. Todavía no estás sosteniendo nada frágil a través de él; `mounted` es un getter vivo, no un valor que cacheaste.
2. **Protege la reanudación.** Inmediatamente después del `await`, antes de cualquier `setState`, escribe `if (!mounted) return;`. Si el widget dejó el árbol durante el await, te detienes aquí y nunca tocas el `State` destruido.
3. **Llama a setState solo pasada la guarda.** Todo lo que muta el estado y reconstruye el widget va después de la comprobación, en el mismo tick síncrono, de modo que nada pueda destruirte entre la guarda y la llamada.

Aplicado al ejemplo roto:

```dart
// Flutter 3.44, Dart 3.x -- guarded
Future<void> _load() async {
  setState(() => _loading = true);
  final user = await api.fetchUser();   // 1. async work

  if (!mounted) return;                 // 2. guard the resume

  setState(() {                         // 3. safe: State is still mounted
    _user = user;
    _loading = false;
  });
}
```

Esa es la corrección entera para el caso común. `mounted` es `false` en el momento en que `dispose` se ha ejecutado, así que la guarda se salta el `setState` exactamente cuando habría lanzado la excepción. Fíjate en que la guarda lee `mounted` fresco después del await; una comprobación colocada *antes* del await no te dice nada, porque el hueco que te importa es el propio await.

## Por qué comprobar mounted es el suelo, no el techo

El framework de Flutter es contundente sobre esto en el propio texto del error de `setState`. Su corrección recomendada no es solo comprobar `mounted`, es cancelar el trabajo que llamaría a `setState` en primer lugar. El razonamiento: una guarda `mounted` evita la excepción, pero el trabajo asíncrono igual corrió hasta el final y consumió CPU, red y batería produciendo un resultado que luego descartas. Si un `Timer` se dispara cada segundo en una pantalla que el usuario dejó hace diez minutos, proteger cada tick con `mounted` detiene el fallo pero deja el temporizador corriendo para siempre.

Así que trata `if (!mounted) return;` como la última línea de defensa, y cancela la fuente en `dispose` como la corrección de verdad allá donde la fuente sea cancelable.

```dart
// Flutter 3.44, Dart 3.x -- cancel the source, then guard as backup
class _ClockState extends State<Clock> {
  Timer? _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;             // backstop
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();                   // the real fix: stop the source
    super.dispose();
  }
}
```

Con el `cancel()` en `dispose`, el callback deja de dispararse en el momento en que el widget se va, así que la guarda `mounted` casi nunca salta. Mantener la guarda de todos modos no cuesta nada y cubre la carrera estrecha donde un tick ya está encolado cuando corre `dispose`. Esta es la misma disciplina que aplicas cuando [liberas controladores para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): adueñarte del ciclo de vida de cualquier cosa que pueda volver a llamar a tu widget.

## Las suscripciones a Stream son el infractor clásico

Una `StreamSubscription` cuyo `onData` llame a `setState` seguirá entregando eventos después de que el widget se haya ido a menos que la canceles. Guarda la suscripción y cancélala en `dispose`.

```dart
// Flutter 3.44, Dart 3.x
class _FeedState extends State<Feed> {
  StreamSubscription<Item>? _sub;
  final _items = <Item>[];

  @override
  void initState() {
    super.initState();
    _sub = repository.itemStream.listen((item) {
      if (!mounted) return;
      setState(() => _items.add(item));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
```

Olvidar el `cancel()` aquí es una de las formas más comunes de ver `setState() called after dispose()` en los registros de producción: el stream sobrevive al widget, y cada evento que llega tras la destrucción es un fallo que la guarda `mounted` está absorbiendo en silencio. Cancela la suscripción y los eventos se detienen en la fuente. Cancelar en `dispose` cada listener que abres vale la pena volverlo tan automático como la [liberación de controladores que previene fugas](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## mounted en State frente a mounted en BuildContext

Hay dos getters `mounted`, y elegir el correcto importa. `State.mounted` es del que trata toda esta guía: vive en tu clase de estado, sigue el ciclo de vida del widget que posees, y es lo que compruebas antes de `setState`. Ha existido desde las primeras versiones de Flutter.

`BuildContext.mounted` llegó en Flutter 3.7 para código que solo tiene un contexto, no un `State`: funciones auxiliares, callbacks de `StatelessWidget`, métodos de extensión. Responde a la misma pregunta de "¿este elemento sigue en el árbol?", pero echas mano de él cuando no hay un `State` en alcance.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass, before setState:
if (!mounted) return;          // State.mounted

// In a helper that only has a BuildContext:
if (!context.mounted) return;  // BuildContext.mounted
```

Dentro de un `State`, prefiere `mounted` sobre `context.mounted`. Normalmente coinciden, pero `State.mounted` lee el ciclo de vida del objeto exacto sobre el que estás a punto de llamar `setState`, que es precisamente lo que puede estar difunto. Reserva `context.mounted` para las situaciones cubiertas en [usar BuildContext de forma segura tras un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), donde la carga útil es una búsqueda de `Navigator` o `ScaffoldMessenger` en vez de una mutación de estado.

## Varios awaits significan varias guardas

Cada punto de suspensión reabre la ventana. Si un método hace await dos veces y llama a `setState` después de cada uno, necesita una guarda tras cada await, no solo tras el primero.

```dart
// Flutter 3.44, Dart 3.x
Future<void> _submit() async {
  setState(() => _status = 'validating');
  final valid = await validate(form);
  if (!mounted) return;                 // guard after await #1

  setState(() => _status = valid ? 'saving' : 'invalid');
  if (!valid) return;

  await repository.save(form);
  if (!mounted) return;                 // guard after await #2

  setState(() => _status = 'done');
}
```

Una guarda cubre solo los awaits que la preceden. Añade un nuevo `await` entre una guarda existente y un `setState`, y has reabierto el hueco en silencio. Cuando un método brota más de dos de estas guardas, eso suele ser una señal de que el trabajo asíncrono pertenece a un controlador, un `AsyncNotifier` o un stream que tu widget renderiza de forma declarativa, en vez de a un montón de llamadas `setState` imperativas. Modelarlo como [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) le entrega al framework la contabilidad del ciclo de vida y elimina la mayoría de las guardas manuales por completo.

## El linter no detecta esta

Vale la pena ser claro sobre lo que las herramientas hacen y no hacen aquí. El linter `use_build_context_synchronously` de `flutter_lints` marca un `BuildContext` usado tras un hueco asíncrono sin una guarda. **No** marca un `setState` desnudo tras un await, porque `setState` no toma un contexto y el linter no lo está buscando. No hay ninguna regla de análisis que subraye el `setState` desprotegido del primer ejemplo de este post. Eso hace que el hábito sea enteramente tuyo de mantener: el compilador está callado, el analizador está callado, y la única señal es un fallo en un registro después de que un usuario navegara fuera en el momento equivocado.

La consecuencia práctica es que no puedes apoyarte en un subrayado rojo para encontrarlos. Audita cualquier método de `State` que a la vez haga `await` y llame a `setState`, y vuelve la guarda un reflejo del mismo modo en que ya tratas `super.dispose()`.

## Trampas y falsos parecidos

**Este es un fallo distinto de setState durante el build.** El fallo `setState() called after dispose()` y el fallo `setState() or markNeedsBuild() called during build` no están relacionados pese al texto parecido. El de dispose trata de llamar a `setState` demasiado tarde, después de que el widget se haya ido; el de build trata de llamarlo demasiado pronto, de forma síncrona dentro de una pasada de build. Las correcciones son distintas, y la [guarda de setState llamado durante el build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) cubre la segunda. Si tu traza de pila dice "during build", la comprobación `mounted` no es tu corrección.

**Las builds de release igual fallan, solo que más tarde.** El error `setState() called after dispose()` es un `FlutterError` realmente lanzado, no una aserción solo de depuración, así que a diferencia de las búsquedas de contexto destruido sí aparece en release. Pero como se dispara desde un callback asíncrono, la traza de pila a menudo apunta a código del framework lejos de tu método `_load`, lo que facilita atribuirlo mal. Un fallo que solo aparece tras la navegación, desde dentro de un `Future.then` o un manejador de stream, es casi siempre un `setState` posterior al await sin proteger.

**`FutureBuilder` y `StreamBuilder` esquivan la guarda.** Si le pasas el trabajo asíncrono a un `FutureBuilder` o un `StreamBuilder` en vez de llamar a `setState` a mano, el builder sigue el ciclo de vida del widget por ti y nunca llama a `setState` sobre un `State` muerto. Echar mano de [FutureBuilder o StreamBuilder en vez de setState manual](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) elimina una categoría entera de estos fallos, a costa de reestructurar el flujo asíncrono en torno al builder.

**El equivalente en Riverpod.** Si sostienes un `WidgetRef` o el `Ref` de un notifier en vez de un `State`, el fallo correspondiente es un error de ref destruido en vez de un error de `State` destruido, y la guarda es `ref.mounted` en vez de `mounted`. La misma causa raíz, la misma forma de corrección, cubierta en [comprobar Ref.mounted tras un hueco asíncrono en Riverpod 3.0](/es/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## El hábito que retira el fallo

Lee un `State` como válido solo desde el inicio de una corrida síncrona hasta el siguiente `await`. Después de reanudarte, comprueba `mounted` antes de llamar a `setState`. Y allá donde la cosa que dispara `setState` sea un temporizador, una suscripción o cualquier fuente de larga vida, cancélala en `dispose` para que el callback nunca se dispare sobre un widget que ya se fue. Haz eso mecánicamente y `setState() called after dispose()` deja de aparecer en tus registros, porque eliminaste tanto el fallo como el trabajo desperdiciado detrás de él.

## Fuentes

- [Propiedad State.mounted](https://api.flutter.dev/flutter/widgets/State/mounted.html), documentación de la API de Flutter, sobre cuándo `mounted` es true y false a lo largo del ciclo de vida del `State`.
- [Método State.setState](https://api.flutter.dev/flutter/widgets/State/setState.html), documentación de la API de Flutter, que detalla el error `setState() called after dispose()` y recomienda cancelar la fuente antes que solo comprobar `mounted`.
- [Método State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html), documentación de la API de Flutter, sobre liberar temporizadores y suscripciones cuando el widget deja el árbol.
- [Regla del linter use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously), reglas del linter de Dart, sobre lo que el analizador marca y lo que no.
