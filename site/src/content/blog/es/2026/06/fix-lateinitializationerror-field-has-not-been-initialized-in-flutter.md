---
title: "Solución: LateInitializationError: Field '...' has not been initialized en Flutter"
description: "Este crash significa que leíste un campo late antes de que algo le asignara un valor. Inicialízalo de forma síncrona en initState, o deja de usar late y modela el valor asíncrono como estado anulable."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Un campo `late` se leyó antes de que algún código le asignara un valor. El campo no tiene expresión inicializadora, así que Dart no puede calcularlo de forma diferida, y la lectura ocurrió antes de la asignación que pretendías. La causa más común en Flutter es un campo `late` que asignas desde un método asíncrono (una petición de red, una lectura de base de datos) mientras `build()` se ejecuta primero y toca el campo antes de que el future se complete. La solución depende del momento: si el valor está disponible de forma síncrona, asígnalo en `initState()` antes del primer build; si solo llega más tarde, no uses `late` en absoluto -- declara el campo como anulable (`Type?`) y renderiza un estado de carga hasta que se asigne. Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x. El modificador `late` en sí existe desde Dart 2.12.

## El error en contexto

El mensaje completo que lanza Dart se ve así:

```
LateInitializationError: Field '_user' has not been initialized.
#0      _MyScreenState._user (package:my_app/screens/my_screen.dart)
#1      _MyScreenState.build (package:my_app/screens/my_screen.dart:42:25)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart)
...
```

El frame de arriba, el getter sintético `_user`, es la lectura que falló. El frame justo debajo, aquí `build`, es la línea de tu código que tocó el campo. Esa línea es donde aflora el crash, pero el bug es la ausencia de una asignación que debió ejecutarse antes. `LateInitializationError` es un subtipo de `Error`, no de `Exception`, que es la forma que tiene Dart de decirte que esto es un error de programación, no una condición recuperable en tiempo de ejecución. Corriges el flujo de control; no lo capturas.

El mensaje tiene tres primos cercanos, y la redacción te dice con cuál te topaste:

```
LateInitializationError: Field '_user' has not been initialized.
LateInitializationError: Local 'result' has not been initialized.
LateInitializationError: Field '_id' has already been initialized.
```

"Field" significa un campo de instancia o estático; "Local" significa una variable local dentro de una función. "has already been initialized" es el error contrario: asignar un campo `late final` dos veces. Comparten una familia de causa raíz pero no la misma solución, y la sección de variantes más abajo cubre los demás.

## Por qué pasa esto

Hay cuatro causas, en orden aproximado de qué tan a menudo muerden.

El valor se asigna de forma asíncrona pero se lee de forma síncrona. Declaraste `late User _user;` y lo asignas dentro de un método `async` que lanzas desde `initState()`. Pero `initState()` retorna de inmediato, el primer `build()` se ejecuta mientras la petición sigue en curso, y `build()` lee `_user`. Nada lo ha asignado aún, así que la lectura lanza la excepción. Esta es de lejos la forma más común del bug, y es insidiosa porque es un crash garantizado, no uno intermitente: el future nunca se completa antes del primer frame, así que falla cada vez que se abre la pantalla.

La asignación vive en una rama que no se ejecutó. Escribiste `late String _label;` y solo lo asignas dentro de un `if` o de un brazo de `switch`. Cuando la condición es falsa o ningún brazo coincide, el campo queda sin asignar, y la siguiente lectura lanza la excepción. El compilador de Dart acepta esto porque `late` es una promesa de tu parte al analizador de que asignarás antes de leer; el analizador deja de comprobar la asignación definitiva y confía en ti.

Olvidaste la asignación por completo. El campo se declaró `late` durante una refactorización, la línea que lo asignaba se borró o nunca se escribió, y el analizador no dijo nada porque `late` se excluye de la comprobación de asignación definitiva. Este es el caso en que la solución es simplemente asignar la cosa.

El campo necesita datos de `InheritedWidget` y lo asignaste demasiado pronto. Si el valor viene de `Theme.of(context)`, `MediaQuery.of(context)`, un `Provider`, o cualquier `InheritedWidget`, no puedes leerlo en el constructor ni en los inicializadores de campo, porque el elemento aún no está montado en el árbol. Asignar en `initState()` también es demasiado pronto para datos heredados. El hook correcto es `didChangeDependencies()`, y equivocarse en esto deja el campo `late` sin asignar en el primer build.

El contrato subyacente, según la documentación del lenguaje Dart sobre el [modificador `late`](https://dart.dev/language/variables#late-variables): un campo `late` sin inicializador debe asignarse antes de leerse, y leerlo primero es un error en tiempo de ejecución. Un campo `late` con inicializador es distinto: el inicializador se ejecuta de forma diferida en la primera lectura, así que nunca puede estar "not initialized". Esa distinción es la clave de las soluciones más limpias de abajo.

## Una reproducción mínima

Esta pantalla crashea cada vez que se abre. Compila sin ninguna advertencia.

```dart
// Flutter 3.44, Dart 3.x -- throws "LateInitializationError: Field '_user' has not been initialized".
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late User _user; // promise: I will assign this before reading it

  @override
  void initState() {
    super.initState();
    _load(); // fire-and-forget async; returns before _user is set
  }

  Future<void> _load() async {
    final fetched = await fetchUser(); // ~300ms network round trip
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    // First build runs while _load() is still awaiting. This read throws.
    return Text(_user.name);
  }
}

class User {
  final String name;
  User(this.name);
}

Future<User> fetchUser() =>
    Future.delayed(const Duration(milliseconds: 300), () => User('Ada'));
```

La secuencia es: `initState()` se ejecuta e inicia `_load()`, `_load()` llega a su primer `await` y cede el control, Flutter avanza al primer `build()`, `build()` lee `_user`, y nada lo ha asignado aún. El `setState(() => _user = fetched)` que lo habría asignado se ejecuta 300ms después. El primer frame pierde la carrera cada vez.

## Solución, en detalle

Las soluciones están ordenadas por cuánto las recomiendo. Elige la que coincida con tu causa.

### 1. Si el valor es asíncrono, no uses late -- modélalo como estado anulable (recomendado)

`late` es la herramienta equivocada para un valor que llega después del primer build. Promete que el valor está listo de forma síncrona; una petición con await no lo está. Declara el campo como anulable y renderiza un estado de carga mientras sea null. Ahora el sistema de tipos te obliga a manejar "todavía no cargado" en lugar de crashear con ello.

```dart
// Flutter 3.44, Dart 3.x -- correct: nullable field, explicit loading state.
class _ProfileScreenState extends State<ProfileScreen> {
  User? _user; // null means "not loaded yet"

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final fetched = await fetchUser();
    if (!mounted) return; // the screen may be gone by now
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    final user = _user;
    if (user == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Text(user.name);
  }
}
```

La guarda `if (!mounted) return;` antes de `setState` no es opcional aquí: un callback asíncrono que se resuelve después de que el usuario abandonó la pantalla, de lo contrario, lanzará un error distinto. Esa guarda es la misma disciplina que necesitas para [usar BuildContext de forma segura después de un await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), y viaja con cada callback con await en un `State`.

Para cualquier cosa más allá de un solo valor, prefiere un `FutureBuilder` o, si estás en Riverpod, un `AsyncValue` que codifique carga, error y datos como tres casos explícitos. Escribir el resultado directamente en un campo después de un await es exactamente el patrón que produce este crash y sus hermanos en tiempo de disposición; modelar la petición como estado en su lugar se cubre en [mostrar estados de carga y error con AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 2. Si el valor es síncrono, asígnalo en initState antes del primer build

`late` es correcto cuando el valor está genuinamente disponible antes del build pero no puedes calcularlo en el inicializador del campo (por ejemplo, necesita `widget`). Asígnalo en `initState()`, que se ejecuta una vez antes del primer `build()`.

```dart
// Flutter 3.44, Dart 3.x -- correct: late assigned synchronously, before build.
class _EditorState extends State<Editor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _controller);
}
```

Este es el uso legítimo de `late final` en un `State`: necesitas `widget.initialText`, que no está disponible en un inicializador de campo, pero sí está disponible en `initState()`, que aún se ejecuta antes de cualquier build. Como el controlador se crea exactamente una vez y nunca se reasigna, `late final` es el modificador correcto, y aún le debes un `dispose()`, como expone la [guía de disposición de controladores](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 3. Usa un inicializador diferido para que el campo nunca pueda quedar sin asignar

Si el valor se puede calcular bajo demanda y no depende de `widget` ni de `context`, dale al campo `late` una expresión inicializadora. Dart entonces ejecuta esa expresión de forma diferida en la primera lectura, así que el campo se inicializa a sí mismo la primera vez que alguien lo toca. Un campo `late` con inicializador no puede lanzar "has not been initialized".

```dart
// Flutter 3.44, Dart 3.x -- correct: lazy initializer, computed on first read.
class Report {
  // Expensive to build; only built if something actually reads it.
  late final List<int> histogram = _buildHistogram();

  List<int> _buildHistogram() {
    // ...expensive work...
    return List<int>.filled(256, 0);
  }
}
```

Este es el único caso en que `late` se gana su lugar puramente por rendimiento: el trabajo se difiere hasta que se necesita y se omite por completo si `histogram` nunca se lee. Si el inicializador es barato, descarta `late` e inicializa en la declaración; la inicialización diferida solo vale el modificador cuando el cálculo es costoso o tiene efectos secundarios que quieres diferir.

### 4. Lee los datos de InheritedWidget en didChangeDependencies, no antes

Si el campo `late` se alimenta de `Theme.of`, `MediaQuery.of`, o un provider, mueve la asignación a `didChangeDependencies()`. Se ejecuta después de `initState()` y de nuevo cada vez que cambia una dependencia heredada, y es el punto más temprano donde `context` puede resolver con seguridad los inherited widgets.

```dart
// Flutter 3.44, Dart 3.x -- correct: inherited data resolved in didChangeDependencies.
class _BannerState extends State<Banner> {
  late Color _accent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accent = Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) => ColoredBox(color: _accent);
}
```

Hacer esto en `initState()` o bien lanza la excepción (Flutter más antiguo) o devuelve datos obsoletos que nunca se actualizan cuando cambia el tema. `didChangeDependencies()` arregla ambos: el campo se asigna antes del primer build y se reasigna cada vez que el tema lo hace.

## Trampas y variantes

`LateInitializationError: Field '...' has already been initialized.` La imagen reflejada. Asignaste un campo `late final` dos veces. `late final` permite exactamente una escritura; la segunda lanza esto. Suele pasar cuando `initState()` asigna el campo y una ruta de código posterior (un `didUpdateWidget`, un callback, un segundo `_load`) lo asigna de nuevo. Si genuinamente necesitas reasignar, descarta `final` y deja solo `late`; si no, encuentra la escritura duplicada y bórrala.

`LateInitializationError: Local '...' has not been initialized.` El mismo error en una variable local en lugar de un campo. Escribiste `late int total;` dentro de una función y una rama la dejó sin asignar antes de una lectura. El `late` local rara vez vale la pena: prefiere inicializar la variable en su declaración, o reestructura para que toda ruta la asigne antes de usarla. La comprobación de asignación definitiva del analizador habría atrapado esto por ti si la variable no fuera `late` -- esa comprobación es precisamente lo que `late` desactiva.

Lanza la excepción en release pero el mensaje desapareció. En las compilaciones de release la maquinaria de aserciones se recorta, pero una lectura `late`-sin-inicializador todavía lanza `LateInitializationError`; solo se reduce el rico mensaje de depuración. No asumas que los crashes de `late` son solo de depuración. Llegan a producción.

`late` frente al operador de comprobación de null. Recurrir a `late` para silenciar "el campo no anulable debe inicializarse" es el mismo instinto que hace que la gente esparza `!` para silenciar la anulabilidad. Ambos difieren una garantía en tiempo de compilación a un crash en tiempo de ejecución. Si un valor puede legítimamente estar ausente, modélalo como anulable y maneja el null; `late` es solo para valores que siempre están presentes pero asignados un poco después de la declaración. El modelo mental más amplio de null safety, incluyendo cuándo `late` es y no es la vía de escape correcta, está en la [lista de verificación de null safety de Flutter 2 a 3.x](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

Un campo `late` leído dentro de su propio inicializador. Si un inicializador diferido `late final x = ...x...;` lee `x`, obtienes un `LateInitializationError` sobre leer durante la inicialización. El ciclo es el bug; rómpelo calculando el valor sin referenciar el campo.

La única disciplina que elimina toda esta clase de bugs: usa `late` solo para un valor que siempre está presente y se asigna de forma síncrona antes de la primera lectura (típicamente en `initState()` o `didChangeDependencies()`), y modela cualquier cosa que llegue de forma asíncrona como estado anulable con una rama de carga explícita. Integra esa distinción en tu reflejo y el error deja de aparecer. En el momento en que te encuentres asignando un campo `late` después de un `await`, esa es la señal para cambiarlo a `Type?` y renderizar el estado intermedio en su lugar.

## Relacionados

- [Cómo usar BuildContext de forma segura después de un await en Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) cubre la guarda `mounted` de la que depende la solución asíncrona de arriba.
- [Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) es la alternativa estructurada a escribir resultados asíncronos en un campo `late`.
- [Solución: A TextEditingController was used after being disposed en Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) es la otra mitad del ciclo de vida del controlador en el que participan los controladores `late final`.
- [Cómo desechar controladores en Flutter para evitar fugas de memoria](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) se empareja con el patrón `late final TextEditingController` de la solución 2.
- [Migrar una app de Flutter 2 a Flutter 3.x: lista de verificación de null safety](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) explica dónde encaja `late` en null safety y dónde los tipos anulables son la mejor opción.

## Fuentes

- [late variables, Dart language tour](https://dart.dev/language/variables#late-variables) -- el contrato para campos `late` con y sin inicializadores.
- [Understanding null safety, dart.dev](https://dart.dev/null-safety/understanding-null-safety#late-variables) -- la justificación de `late` y cómo interactúa con la asignación definitiva.
- [State.initState and State.didChangeDependencies, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html) -- qué hook del ciclo de vida puede leer con seguridad datos heredados.
- [LateInitializationError, Dart core library API](https://api.dart.dev/stable/dart-core/LateInitializationError-class.html) -- el tipo de error y qué lo desencadena.
