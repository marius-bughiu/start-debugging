---
title: "unawaited_futures vs discarded_futures en Dart: qué lint detecta qué llamada sin await"
description: "unawaited_futures solo mira dentro de cuerpos async, discarded_futures solo dentro de cuerpos síncronos, y ambos pasan por alto las funciones de flecha, los tear-offs y los literales de colección. Medido caso por caso en Dart 3.12.2 y Flutter 3.44.8, con el analysis_options.yaml que recomiendo."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "lints"
  - "async"
lang: "es"
translationOf: "2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Respuesta corta:** los dos lints se reparten el trabajo según el tipo de cuerpo de función en el que está la llamada. `unawaited_futures` reporta un `Future` descartado dentro de un cuerpo `async`. `discarded_futures` reporta un `Future` (o `FutureOr`) descartado dentro de un cuerpo síncrono, que en Flutter significa `initState`, `dispose` y cada bloque `onPressed: () { ... }`. Nunca se activan en la misma línea. Si solo habilitas uno, habilita `unawaited_futures`: es barato y cada aviso es probablemente un bug. Añade `discarded_futures` cuando estés dispuesto a escribir `unawaited(...)` en cada llamada intencional de tipo "dispara y olvida" en el código de widgets. Todo lo que sigue se midió con `dart analyze` en Dart 3.12.2 (Flutter 3.44.8, `meta` 1.19.0).

Ninguna de las dos reglas está en el conjunto core ni en el recomendado de `package:lints`, ni en `package:flutter_lints` 6.0.0, así que un proyecto nuevo de `flutter create` no reporta ninguna hasta que las actives.

## La comparación de un vistazo

| | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- |
| Dónde mira | sentencias dentro de cuerpos `async` / `async*` | sentencias dentro de cuerpos síncronos |
| Tipos que reporta | `Future` y subtipos (incl. `TickerFuture`) | `Future`, subtipos y `FutureOr` |
| Disponible desde | de larga data, anterior a Dart 2.18 | Dart 2.18 |
| En `lints` / `flutter_lints` | no / no | no / no |
| Aviso típico en Flutter | `Navigator.pushNamed(...)` dentro de `onPressed: () async { ... }` | `_load();` en `initState`, `_controller.forward();` |
| Se silencia con `unawaited(...)` | sí | sí |
| Se silencia con `@awaitNotRequired` (`meta` 1.17.0+) | sí | sí |
| Corrección masiva con `dart fix --apply` | no (solo corrección rápida del IDE) | no (solo corrección rápida del IDE) |
| Nivel de ruido en una app Flutter | bajo | medio a alto |

## Por qué hay dos reglas en lugar de una

Ambas reglas son envoltorios delgados del mismo visitor, `UnusedFuturesVisitor` en `pkg/linter/lib/src/util/unused_futures.dart`. El visitor recorre tres tipos de nodos: sentencias de expresión, secciones de cascada e interpolaciones de cadena. Para cada expresión le pregunta a la regla si es "interesante", y ese filtro es toda la diferencia entre los dos lints. Este es el filtro de `unawaited_futures.dart` en el tag `3.12.2`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/unawaited_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule is not currently concerned with `FutureOr`.
  if (type == null || !type.isOrImplementsFuture) {
    return false;
  }
  // This rule is only concerned with code in async functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isAsynchronous ?? false;
},
```

Y este es el de `discarded_futures.dart`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/discarded_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule does concern itself with `FutureOr`.
  if (type == null || !type.isOrImplementsFutureOrFutureOr) {
    return false;
  }
  // This rule is only concerned with code in sync functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isSynchronous ?? false;
},
```

De ese código se desprenden dos consecuencias. Primero, decide el `FunctionBody` envolvente más cercano, no el método exterior. Un closure de bloque `() { save(); }` escrito dentro de un método `async` es un cuerpo síncrono, así que pertenece a `discarded_futures`. Segundo, `FutureOr` solo se cubre en el lado síncrono. Un `FutureOr<int>` descartado dentro de un método `async` no lo reporta ninguna de las dos reglas.

La motivación también difiere. `unawaited_futures` apunta al `await` olvidado: ya estás dentro de una función `async`, así que la corrección es una palabra clave. `discarded_futures` apunta al `async` olvidado: una función síncrona que inicia trabajo asíncrono suele significar que la propia función debió ser `async` y que sus llamadores deberían esperarla. La documentación oficial de `discarded_futures` dice exactamente eso, y señala a `unawaited_futures` como la regla que toma el relevo cuando la función ya es `async`.

## El archivo de casos: qué se activa dónde

Puse en un solo archivo todas las formas de llamada que se me ocurrieron y ejecuté `dart analyze` con ambas reglas habilitadas sobre `package:lints/recommended.yaml`:

```yaml
# analysis_options.yaml, Dart 3.12.2
include: package:lints/recommended.yaml
linter:
  rules:
    - unawaited_futures
    - discarded_futures
```

```dart
// Dart 3.12.2, meta 1.19.0
import 'dart:async';
import 'package:meta/meta.dart';

Future<void> save() async {}
FutureOr<int> maybeAsync() => 1;
@awaitNotRequired
Future<void> log(String m) async {}

class Repo {
  Future<void> flush() async {}
}

Future<void> asyncCaller() async {
  save(); // A1
  maybeAsync(); // A2 FutureOr in async
  final f = save(); // A3 assigned
  unawaited(save()); // A4
  log('x'); // A5 awaitNotRequired
  Repo()..flush(); // A6 cascade
  print('${save()}'); // A7 interpolation
  var list = [save()]; // A8 collection
  Future.delayed(Duration.zero, () => 1); // A9
  <String, Future<void>>{}.putIfAbsent('k', save); // A10
  void inner() {
    save(); // A11 sync closure inside async
  }
  [1].forEach((_) async {
    save(); // A12 async closure
  });
  save().then((_) {}); // A13 .then chain
  save().ignore(); // A14 ignore()
  await f;
  inner();
  list.length;
}

void syncCaller() {
  save(); // S1
  maybeAsync(); // S2 FutureOr in sync
  final f = save(); // S3 assigned
  unawaited(save()); // S4
  log('x'); // S5 awaitNotRequired
  Repo()..flush(); // S6 cascade
  takesFuture(save()); // S7 argument
  f.ignore();
}

Future<void> syncReturn() {
  return save(); // S8 returned
}

void takesFuture(Future<void> f) {}

void Function() handler = () => save(); // S9 arrow in sync closure
void Function() handler2 = () {
  save(); // S10 block sync closure
};
Future<void> Function() handler3 = () async {
  save(); // S11 async closure
};
```

Los resultados, leídos de la salida de `dart analyze`:

| Caso | Código | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- | --- |
| A1 | `save();` en `async` | reportado | - |
| A2 | `maybeAsync();` (`FutureOr`) en `async` | - | - |
| A3, S3 | `final f = save();` | - | - |
| A4, S4 | `unawaited(save());` | - | - |
| A5, S5 | callee con `@awaitNotRequired` | - | - |
| A6 | `Repo()..flush();` en `async` | reportado | - |
| A7 | `'${save()}'` en `async` | reportado | - |
| A8 | literal de colección `[save()]` | - | - |
| A9 | `Future.delayed(d, computation)` | - | - |
| A10 | `Map.putIfAbsent` | - | - |
| A11 | closure de bloque dentro de un método `async` | - | reportado |
| A12 | closure `async` | reportado | - |
| A13 | `save().then((_) {});` | reportado (en `then`) | - |
| A14 | `save().ignore();` | - | - |
| S1 | `save();` en sync | - | reportado |
| S2 | `maybeAsync();` en sync | - | reportado |
| S6 | `Repo()..flush();` en sync | - | reportado |
| S7 | `takesFuture(save());` | - | - |
| S8 | `return save();` | - | - |
| S9 | closure de flecha `() => save()` | - | - |
| S10 | `() { save(); }` | - | reportado |
| S11 | `() async { save(); }` | reportado | - |

Algunas filas merecen una frase cada una.

- **A9 y A10 son excepciones codificadas a mano.** El visitor omite `Future.delayed` cuando se llama con un argumento de computación, y `Map.putIfAbsent`, porque ambos devuelven valores que la gente suele ignorar a propósito.
- **A13 se reporta en `then`, no en `save`.** `save().then(...)` devuelve un nuevo `Future`, y ese es el que se descarta. Encadenar un `.then` no sustituye el manejo del resultado.
- **A14 está limpio porque `Future.ignore()` devuelve `void`.** Es la alternativa en forma de llamada a método a `unawaited(...)`, disponible desde Dart 2.14. A diferencia de `unawaited`, además se traga cualquier error con el que el future se complete, así que úsalo solo cuando de verdad no te importe.
- **S7 está limpio a propósito.** Pasar el future a un parámetro tipado como `Future<void>` entrega la responsabilidad al callee.

## Los puntos ciegos que comparten ambas reglas

Dos filas de esa tabla son falsos negativos reales, y ambos están registrados upstream.

**Cuerpos de flecha (S9).** `() => save()` es un cuerpo de expresión síncrono que devuelve el `Future`. El visitor solo mira sentencias, así que no se activa nada, ni siquiera cuando el closure se asigna a un `void Function()` y el llamador tira el future. Es [dart-lang/sdk#61155](https://github.com/dart-lang/sdk/issues/61155).

**Tear-offs hacia callbacks `void`.** También ejecuté esto:

```dart
// Dart 3.12.2
void execute(void Function() cb) => cb();

void tearoffs() {
  execute(save); // Future<void> Function() passed as void Function()
}
```

Ninguna de las dos reglas lo reportó. Dart permite un `Future<void> Function()` donde se espera un `void Function()`, así que el future se descarta dentro de `execute` y ningún lint lo ve. [dart-lang/sdk#56921](https://github.com/dart-lang/sdk/issues/56921) lo cubre. El lint relacionado es `avoid_void_async`, que solo detecta funciones `async` declaradas como `void`, no tear-offs.

Suma los literales de colección (A8) y `FutureOr` dentro de cuerpos `async` (A2) y tendrás la lista completa de formas en las que un future descartado queda sin reportar. Además, `unawaited` hoy no acepta un `FutureOr` ([dart-lang/sdk#63818](https://github.com/dart-lang/sdk/issues/63818)), así que para S2 la corrección limpia es `final _ = maybeAsync();` o esperarlo con await.

## Cómo se ve en un widget de Flutter

La misma división es la que decide el nivel de ruido en una app Flutter, porque la mayoría de los callbacks de widgets son síncronos. En Flutter 3.44.8 con ambas reglas sobre `package:flutter_lints/flutter.yaml`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class _HomeState extends State<Home> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this);

  Future<void> _load() async {}

  @override
  void initState() {
    super.initState();
    _load(); // F1: discarded_futures
    _c.forward(); // F2: discarded_futures (TickerFuture implements Future)
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      TextButton(
        onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const Home())), // F3: nothing
        child: const Text('a'),
      ),
      TextButton(
        onPressed: () {
          Navigator.of(context).pushNamed('/x'); // F4: discarded_futures
        },
        child: const Text('b'),
      ),
      TextButton(
        onPressed: () async {
          await _load();
          if (!context.mounted) return;
          Navigator.of(context).pushNamed('/x'); // F5: unawaited_futures
        },
        child: const Text('c'),
      ),
    ]);
  }
}
```

F2 es el que molesta a la gente. `AnimationController.forward()`, `reverse()`, `repeat()` y `animateTo()` devuelven todos un `TickerFuture`, y casi nadie los espera con await. Con `discarded_futures` activado, cada uno necesita `unawaited(...)`. F1, en cambio, es exactamente el bug para el que existe la regla: `_load()` en `initState` lanza su error a la zona en lugar de a un `try`/`catch` que escribiste tú, y si llama a `setState` después de que el widget ya no exista, estás en [territorio de comprobaciones de mounted](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

F3 y F4 hacen lo mismo. Solo se reporta la forma de bloque, lo que significa que cambiar un callback de `{ ... }` a `=>` silencia `discarded_futures` sin arreglar nada.

## Cuándo elegir unawaited_futures

- **Quieres una sola regla con una tasa de falsos positivos casi nula.** Dentro de una función `async`, un `Future` descartado casi siempre es un `await` olvidado, y el error que lleva se saltará tu `try`/`catch` y caerá en [`PlatformDispatcher.onError` o en tu zona protegida](/es/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).
- **Escribes Dart de servidor o de CLI.** `main` suele ser `async`, así que la mayor parte de tu código queda cubierta, y el código síncrono restante rara vez inicia trabajo asíncrono.
- **Tu equipo ya usa callbacks `async`.** Si tus handlers son `onPressed: () async { ... }`, esta regla los cubre (F5).

## Cuándo añadir discarded_futures

- **Publicas un paquete.** Un método público síncrono que inicia trabajo asíncrono en silencio es un mal olor de API, y esta regla encuentra cada uno.
- **Quieres que el "dispara y olvida" sea visible en la revisión de código.** Con la regla activada, cada descarte intencional se lee como `unawaited(...)` o lleva `@awaitNotRequired` en el callee, que es justamente el objetivo.
- **Has tenido un bug por trabajo en `initState` que nadie esperó.** Ese es el caso F1, y solo esta regla lo ve.

Si la añades a una app Flutter existente, espera que la mayoría de los avisos sean llamadas a `AnimationController` y navegación en callbacks de bloque. Ninguna de las dos reglas tiene una corrección masiva con `dart fix` en Dart 3.12.2 (`dart fix --dry-run` no propuso nada para ellas en mi repro), así que, a diferencia de las [migraciones que puedes aplicar en todo el repositorio con `dart fix`](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/), esta limpieza se hace con una corrección rápida del IDE a la vez.

## Marcar APIs como seguras de descartar con @awaitNotRequired

Para tus propias APIs diseñadas como "dispara y olvida" (registro, analítica, precalentamiento de caché), anota la declaración en lugar de envolver cada sitio de llamada:

```dart
// Dart 3.12.2, meta 1.19.0
import 'package:meta/meta.dart';

@awaitNotRequired
Future<void> track(String event) async {
  // send to analytics, errors handled inside
}

void onTap() {
  track('tap'); // neither rule reports this
}
```

`@awaitNotRequired` llegó en `package:meta` 1.17.0, y la 1.18.1 lo permitió en typedefs, así que un parámetro callback tipado con un typedef anotado también queda exento. Ambos lints lo respetan (A5 y S5 arriba), y la comprobación también recorre los miembros sobrescritos, de modo que una sobrescritura de un método anotado sigue exenta. Úsalo solo cuando la función maneje sus propios errores: la anotación le dice al analizador que descartar el future es seguro, y es tu trabajo hacer que eso sea cierto. Flutter 3.47 reexporta la anotación desde `package:flutter/foundation.dart`; si un paquete que la usa rompe tu compilación en 3.44, consulta [la corrección del nombre indefinido `awaitNotRequired`](/es/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).

## El detalle que decide por ti

Si tu base de código depende de callbacks de flecha (`onPressed: () => doThing()`), `discarded_futures` te aporta menos de lo que sugiere su ruido, porque la forma de flecha le es invisible (S9, F3). En esa base de código, `unawaited_futures` solo, más una regla de equipo de "el trabajo asíncrono va en callbacks `async`", te da la mayor parte del valor. Si tu base de código usa callbacks de bloque y cargadores en `initState`, `discarded_futures` es la única regla que ve esas llamadas, y compensa el trabajo extra de `unawaited`.

Los desarrolladores de C# reconocerán la forma del problema: es la versión en Dart de [CS4014, "this call is not awaited"](/es/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/), salvo que C# lo reporta solo en métodos `async`, que es la mitad de `unawaited_futures`. Dart te deja activar también la otra mitad.

## Mi recomendación

Activa `unawaited_futures` hoy en todos los proyectos Dart y Flutter. Añade `discarded_futures` en paquetes y en apps donde quieras que el "dispara y olvida" sea explícito, y acepta escribir `unawaited(_controller.forward())`. Esta es la configuración que uso:

```yaml
# analysis_options.yaml, Flutter 3.44.8 / Dart 3.12.2
include: package:flutter_lints/flutter.yaml

linter:
  rules:
    - unawaited_futures
    - discarded_futures
    - avoid_void_async
```

`avoid_void_async` es el complemento: reporta `void bad() async {}` y te obliga a declarar `Future<void>`, de modo que el future exista en el sistema de tipos donde las otras dos reglas (y tus llamadores) puedan verlo. No arregla el hueco de los tear-offs, pero evita que crees nuevas funciones `async` cuyos futures nadie puede esperar.

## Relacionado

- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/es/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [How to use BuildContext safely after an await in Flutter](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [How to run dart fix across a whole repo to apply Flutter migrations](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/es/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Fix CS4014: because this call is not awaited, execution continues](/es/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)

## Fuentes

- [unawaited_futures](https://dart.dev/tools/linter-rules/unawaited_futures) y [discarded_futures](https://dart.dev/tools/linter-rules/discarded_futures) en dart.dev.
- Código fuente de las reglas en el tag 3.12.2: [unawaited_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unawaited_futures.dart), [discarded_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/discarded_futures.dart), [unused_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/util/unused_futures.dart).
- [`awaitNotRequired` en package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html) y el [changelog de meta](https://pub.dev/packages/meta/changelog).
- Issues upstream: [#61155](https://github.com/dart-lang/sdk/issues/61155) (cuerpos de flecha), [#56921](https://github.com/dart-lang/sdk/issues/56921) (tear-offs), [#63818](https://github.com/dart-lang/sdk/issues/63818) (`unawaited` y `FutureOr`).
