---
title: "Cómo liberar controladores en Flutter para evitar fugas de memoria"
description: "AnimationController, TextEditingController y ScrollController retienen recursos que el GC de Dart no puede reclamar hasta que los liberas. Aquí tienes el patrón correcto, las reglas de orden y cómo detectar fugas antes de publicar."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "memory"
lang: "es"
translationOf: "2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks"
translatedBy: "claude"
translationDate: 2026-06-01
---

Si un controlador expone un método `dispose()`, debes llamarlo desde tu `State.dispose()`, y debes hacerlo antes de `super.dispose()`. En concreto: crea el controlador en `initState` (o como un campo `late final`), llama a `controller.dispose()` en `dispose()`, y para `AnimationController` añade un `SingleTickerProviderStateMixin` para que el ticker se detenga cuando el widget salga del árbol. Saltarte cualquiera de estos pasos deja vivo y accesible un `Ticker`, una lista de listeners o una suscripción de stream, lo que ancla todo el subárbol de widgets en memoria. Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

La recolección de basura no te salva aquí. El GC de Dart reclama objetos que ya no son accesibles, pero un `AnimationController` en ejecución es accesible desde la lista de tickers del `SchedulerBinding`, y un `TextEditingController` que entregaste a un `TextField` es accesible desde el grafo de listeners mientras algo retenga el controlador. La fuga no es un error del GC. Es un error de propiedad: creaste un recurso y nunca lo liberaste.

## Por qué un controlador sobrevive a su widget

Un `StatefulWidget` es barato y desechable. Flutter reconstruye el objeto widget constantemente. El objeto `State` es lo que tiene un ciclo de vida, y los controladores que creas pertenecen a ese `State`. Cuando el widget se elimina del árbol, Flutter llama a `State.dispose()` exactamente una vez. Esa llamada es tu única oportunidad de liberar recursos nativos y del framework.

Tres categorías de controlador presentan fugas de maneras distintas:

`AnimationController` registra un `Ticker` en el `SchedulerBinding`. El ticker dispara una callback en cada frame mientras la animación se ejecuta. Hasta que liberes el controlador (lo que libera el ticker), el `SchedulerBinding` retiene una referencia al ticker, el ticker retiene una referencia a tu callback, y tu callback captura `this`, tu `State`, y a través de él todo el subárbol. En compilaciones de depuración Flutter de hecho lanza una aserción sobre esto: si olvidas el `dispose`, obtienes `AnimationController.dispose() called more than once` o una aserción de ticker todavía activo cuando se destruye el widget.

`TextEditingController`, `ScrollController` y `FocusNode` son `ChangeNotifier` (o contienen uno). Mantienen una lista de listeners. Un `TextField` se añade a sí mismo como listener para poder repintarse cuando el texto cambia. Si tú también llamas a `controller.addListener(...)` y nunca liberas, el controlador, su lista de listeners y cada closure en esa lista siguen vivos. El controlador retiene a los listeners, no al revés, así que el GC no puede recolectar ninguno de ellos.

`StreamSubscription` y `Timer` tienen la misma forma sin el nombre `dispose()`: llamas a `subscription.cancel()` y `timer.cancel()`. Una suscripción viva es referenciada por el stream, que mantiene viva tu callback `onData`.

La regla unificadora, directa de la [documentación de la API State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html) del equipo de Flutter: "Si el método build de un State depende de un objeto que puede cambiar de estado por sí mismo, ... suscríbete a ese objeto durante initState ... y cancela la suscripción en dispose".

## Un repro mínimo que tiene fugas

Aquí hay un widget que tiene fugas de los tres tipos de recurso. Compila y se ejecuta. Simplemente nunca suelta nada.

```dart
// Flutter 3.44, Dart 3.x -- DO NOT COPY, this leaks on purpose.
import 'dart:async';
import 'package:flutter/material.dart';

class LeakyScreen extends StatefulWidget {
  const LeakyScreen({super.key});

  @override
  State<LeakyScreen> createState() => _LeakyScreenState();
}

class _LeakyScreenState extends State<LeakyScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))
        ..repeat();
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final StreamSubscription<int> _ticks =
      Stream.periodic(const Duration(seconds: 1), (i) => i).listen((_) {});

  // No dispose() override. Every push/pop of this screen leaks
  // one AnimationController, one ticker, one TextEditingController,
  // one ScrollController, and one live StreamSubscription.

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Empuja y saca esta pantalla 50 veces y tendrás 50 tickers disparándose en cada frame, 50 suscripciones de stream entregando eventos y 50 subárboles de widgets desconectados que el GC nunca tocará. Solo los tickers de animación degradarán visiblemente los tiempos de frame, porque cada uno de ellos todavía quiere ejecutarse en cada vsync.

## El patrón de liberación, completo

La corrección es mecánica una vez que la interiorizas. Refleja cada recurso que creas con una llamada de liberación en `dispose()`, y pon `super.dispose()` al final.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class StableScreen extends StatefulWidget {
  const StableScreen({super.key});

  @override
  State<StableScreen> createState() => _StableScreenState();
}

class _StableScreenState extends State<StableScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  late final TextEditingController _text;
  late final ScrollController _scroll;
  late final FocusNode _focus;
  StreamSubscription<int>? _ticks;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _text = TextEditingController();
    _scroll = ScrollController()..addListener(_onScroll);
    _focus = FocusNode();
    _ticks = Stream.periodic(const Duration(seconds: 1), (i) => i)
        .listen(_onTick);
  }

  void _onScroll() {/* react to scroll offset */}
  void _onTick(int value) {/* react to each tick */}

  @override
  void dispose() {
    // Cancel subscriptions and remove listeners first.
    _ticks?.cancel();
    _scroll.removeListener(_onScroll);
    // Then dispose every controller you own.
    _anim.dispose();
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    // super.dispose() LAST, always.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text, focusNode: _focus),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Algunas cosas en ese código son fundamentales, así que vale la pena ser explícito sobre cada una.

### Crea en initState, no en build

`build` se ejecuta muchas veces. Si escribes `final _text = TextEditingController()` como inicializador de campo con un valor no `late`, estás bien porque los inicializadores de campo se ejecutan una sola vez. Pero si alguna vez construyes un controlador dentro de `build`, asignas uno nuevo en cada reconstrucción y dejas huérfano el anterior de inmediato. Construye controladores en `initState` o como campos `late final`, nunca en `build`.

### Por qué super.dispose() va al final

La convención es la inversa de `initState`. En `initState` llamas a `super.initState()` primero, luego configuras tu estado. En `dispose` desmantelas tu estado primero, luego llamas a `super.dispose()` al final. El `State.dispose()` base marca el objeto como difunto; tocar tus propios campos después de eso es un error, y la compilación de depuración del framework señalará un `dispose` llamado sobre un `State` ya liberado. Desmantelar tus recursos antes de devolver el control a la clase base mantiene el orden coherente.

### removeListener antes de dispose, o simplemente dispose

Si llamaste a `addListener` sobre un controlador, puedes llamar a `removeListener` con la misma callback antes de `dispose`, o confiar en que `dispose()` descarte toda la lista de listeners. Liberar un `ChangeNotifier` limpia sus listeners, así que un `removeListener` explícito justo antes de `dispose` del mismo objeto es redundante. La razón para mantener el `removeListener` explícito es cuando te añadiste como listener a un controlador que no posees (uno pasado desde un padre). Debes quitar tu listener de ese controlador en `dispose`, porque no eres tú quien lo libera.

## AnimationController necesita un TickerProvider

`AnimationController` es el único controlador que necesita más que una llamada a `dispose`: necesita un argumento `vsync`, que es un `TickerProvider`. El `TickerProvider` es lo que vincula el ticker del controlador a la tasa de refresco de la pantalla y, crucialmente, al ciclo de vida del widget.

Usa `SingleTickerProviderStateMixin` cuando el `State` posee exactamente un `AnimationController`. Usa `TickerProviderStateMixin` cuando posee varios. El mixin de ticker único es una pequeña optimización y lanza una aserción si accidentalmente creas dos controladores contra él, lo cual es una protección útil.

```dart
// Flutter 3.44 -- one controller
class _OneAnim extends State<OneAnim>
    with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _c.dispose(); super.dispose(); }
}

// Flutter 3.44 -- multiple controllers
class _ManyAnim extends State<ManyAnim>
    with TickerProviderStateMixin {
  late final _a = AnimationController(vsync: this, duration: ...);
  late final _b = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _a.dispose(); _b.dispose(); super.dispose(); }
}
```

Si tu animación es simple, la forma más limpia de nunca tener una fuga de controlador es no poseer ninguno. Los widgets de animación implícita como `AnimatedContainer`, `AnimatedOpacity` y `TweenAnimationBuilder` gestionan sus propios controladores internamente y los liberan por ti. Recurre a un `AnimationController` explícito solo cuando necesites conducir, revertir, repetir o encadenar la animación tú mismo. Perfilar el jank de animación es una habilidad aparte: si tus animaciones son fluidas pero la app aún se entrecorta, la causa suele ser trabajo en el hilo de UI, lo cual cubro en [la guía sobre perfilar el jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

## Quién posee el controlador decide quién lo libera

La fuga más común del mundo real (y el crash por doble liberación más común) viene de una propiedad poco clara. La regla: quien crea el controlador lo libera. Si un controlador se crea en el widget A y se pasa al widget B, entonces A lo libera, y B no debe hacerlo.

Esto importa porque los widgets de Flutter aceptan con frecuencia un controlador como parámetro de constructor precisamente para que un padre pueda controlarlos. `TextField`, `ListView`, `PageView` y `TabBar` todos toman un controlador opcional. Cuando pasas uno, conservas la responsabilidad de liberarlo:

```dart
// Flutter 3.44, Dart 3.x
class FormSection extends StatefulWidget {
  // This widget OWNS the controller, so it disposes it.
  const FormSection({super.key});
  @override
  State<FormSection> createState() => _FormSectionState();
}

class _FormSectionState extends State<FormSection> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose(); // owner disposes
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The child widget receives the controller but must NOT dispose it.
    return NameField(controller: _name);
  }
}

class NameField extends StatelessWidget {
  final TextEditingController controller;
  const NameField({super.key, required this.controller});

  @override
  Widget build(BuildContext context) =>
      TextField(controller: controller); // no dispose here
}
```

Si `NameField` liberara un controlador que no creó, el padre intentaría más tarde usar un controlador liberado y se estrellaría con `A TextEditingController was used after being disposed`. Ese error exacto tiene su propio diagnóstico, pero la causa raíz casi siempre son dos widgets peleándose por el ciclo de vida de un controlador.

El error opuesto eleva un controlador a una capa de gestión de estado (un `ChangeNotifier`, un `Notifier` de Riverpod, un controlador de GetX) y luego olvida que la capa ahora posee la liberación. Si mueves un `TextEditingController` fuera de un `State` y a un provider de Riverpod, el `onDispose`/`dispose` del provider es donde ahora vive la llamada `controller.dispose()`, no el widget. Cuando estás reestructurando la propiedad del ciclo de vida durante una migración de gestión de estado, este es exactamente el tipo de cosa que se rompe en silencio, lo que es parte de por qué escribí [migrar una app Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) como un movimiento cuidadoso, paso a paso, en lugar de un buscar y reemplazar.

## Casos límite que muerden

**Creación condicional.** Si un controlador solo se crea en algunas rutas de código, haz el campo anulable y protege la liberación: `_optional?.dispose();`. No dejes un controlador `late final` sin inicializar y luego llames a `dispose` sobre él, lo que lanza `LateInitializationError`.

**Recrear un controlador al actualizar el widget.** Si tu controlador depende de una propiedad del `widget`, puede que necesites liberar el viejo y crear uno nuevo en `didUpdateWidget`. El patrón es: en `didUpdateWidget`, compara `oldWidget.x` con `widget.x`, y si difieren, `_controller.dispose()` y luego asigna uno nuevo. Olvidar la liberación en `didUpdateWidget` tiene fuga de un controlador por cada cambio de propiedad relevante.

**GlobalKey y los controladores son cosas distintas.** Una `GlobalKey` no necesita liberación, pero un controlador alcanzado a través de una key sí. No confundas ambas cosas.

**El hot reload oculta las fugas.** El hot reload preserva el `State`, así que un `dispose` olvidado puede no aparecer durante el desarrollo. Solo lo notas cuando la pantalla se empuja y se saca de verdad, o bajo el rastreador de fugas. Prueba la ruta de navegación real, no solo el hot reload.

**El trabajo pesado en una callback de controlador pertenece fuera del hilo de UI.** Si tu listener de `ScrollController` o `AnimationController` hace cómputo significativo, ese trabajo se ejecuta en el isolate de UI y compite con el renderizado. Muévelo a un isolate en segundo plano; lo recorro en [escribir un isolate de Dart para trabajo intensivo en CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

## Detectar fugas antes de publicar

No tienes que encontrarlas leyendo código. Flutter incluye `leak_tracker`, y desde Flutter 3.x el framework de pruebas se integra con él para que las fugas de liberación hagan fallar tus pruebas de widget automáticamente cuando el rastreo de fugas está habilitado. El equipo de Flutter documenta el flujo en la [guía oficial de rastreo de fugas](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md). El modelo mental: se espera que cada objeto desechable sea liberado; si el GC recolecta uno que nunca fue liberado, eso es una fuga "no liberado", y si uno es liberado pero nunca recolectado, eso es una fuga "no recolectado por GC". Ambas se reportan con la traza de pila de la asignación, así que te apuntan directo al `initState` que creó al huérfano.

Para una app en ejecución, abre DevTools y usa la vista de Memoria. Empuja y saca la pantalla sospechosa varias veces, fuerza un GC, y observa el conteo de instancias de `AnimationController`, `TextEditingController` o tu clase `State`. Si el conteo sube y nunca baja, tienes una fuga, y la vista de ruta de retención te muestra qué sigue apuntando al objeto. La misma sesión de DevTools es donde investigarías el timing de los frames, lo que se solapa con el flujo de perfilado de jank.

La disciplina es lo bastante simple para enunciarla en una línea y vale la pena convertirla en un reflejo de revisión de código: por cada `Controller`, `FocusNode`, `StreamSubscription` y `Timer` que creas en un `State`, hay exactamente una llamada de liberación correspondiente en `dispose()`, y `super.dispose()` es la última instrucción del método. Conecta `leak_tracker` a tus pruebas de widget y el framework te lo exigirá.

## Relacionado

- [Cómo perfilar el jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cubre las vistas de Memoria y Rendimiento que usas para confirmar una fuga.
- [Cómo escribir un isolate de Dart para trabajo intensivo en CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) es donde deberían ejecutarse las callbacks de controlador que hacen trabajo real.
- [Cómo migrar una app Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) muestra cómo se mueve la propiedad de la liberación cuando cambias de capa de gestión de estado.
- [Solución: RenderFlex overflowed en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) es el otro error clásico de Flutter con el que te topas construyendo las mismas pantallas.

## Fuentes

- [State.dispose, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/State/dispose.html)
- [AnimationController, referencia de la API de Flutter](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [TextEditingController, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html)
- [Resumen de leak_tracker, dart-lang/leak_tracker](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md)
- [Usar la vista de Memoria, documentación de Flutter DevTools](https://docs.flutter.dev/tools/devtools/memory)
