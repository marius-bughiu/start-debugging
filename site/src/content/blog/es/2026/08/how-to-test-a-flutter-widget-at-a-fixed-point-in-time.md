---
title: "Cómo probar un widget de Flutter en un instante fijo sin un closure withClock"
description: "Dentro de testWidgets el clock ambiental de package:clock ya es falso, pero arranca en la hora del reloj del sistema en la que empezó la prueba. Fíjalo para toda la suite sobrescribiendo runTest en un AutomatedTestWidgetsFlutterBinding personalizado instalado desde flutter_test_config.dart. Verificado en Flutter 3.44.2, clock 1.1.2, fake_async 1.3.3."
pubDate: 2026-08-24
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "how-to"
  - "clock"
lang: "es"
translationOf: "2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time"
translatedBy: "claude"
translationDate: 2026-08-24
---

Si un widget muestra "hace 3 horas" o te saluda con "Buenas noches", necesitas que su noción de `now` sea una constante antes de poder hacer aserciones sobre la salida. El consejo habitual es envolver cada cuerpo de prueba en `withClock(Clock.fixed(...), () async { ... })`, lo cual se vuelve ruidoso rápido. Hay una forma mejor, y empieza con un hecho que casi todos malinterpretan: **dentro de `testWidgets` el `clock` ambiental de `package:clock` ya es falso**. `FakeAsync.run` lo instala por ti, y solo avanza cuando llamas a `tester.pump`. Lo que no hace es arrancar en un instante predecible, porque `FakeAsync()` se inicializa desde el reloj real del sistema. Corrige esa única semilla y toda la suite se vuelve determinista sin ningún closure por prueba. Todo lo que sigue se ejecutó contra Flutter 3.44.2 (Dart 3.12.2), `clock` 1.1.2 y `fake_async` 1.3.3.

## Qué devuelve realmente clock.now() dentro de testWidgets

Empecemos con la sonda más pequeña posible. Sin archivos de configuración, sin bindings personalizados:

```dart
// Flutter 3.44.2, Dart 3.12.2, clock 1.1.2
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('the ambient clock is already fake', (WidgetTester tester) async {
    final a = clock.now();
    await tester.pump(const Duration(hours: 1));
    final b = clock.now();
    print('a=$a');
    print('b=$b delta=${b.difference(a)}');
    print('DateTime.now delta=${DateTime.now().difference(a)}');
  });
}
```

Salida de `flutter test`:

```text
a=2026-08-24 09:19:57.248297
b=2026-08-24 10:19:57.248297 delta=1:00:00.000000
DateTime.now delta=0:00:00.094231
```

Hay dos cosas que leer ahí. La diferencia entre las dos llamadas a `clock.now()` es *exactamente* una hora, al microsegundo, algo que ningún reloj real produce jamás. Y `DateTime.now()` avanzó 94 milisegundos, que es lo que realmente tardó la prueba. Así que `clock` es falso y `DateTime.now()` es real.

La tubería está en `fake_async`. `FakeAsync.run` envuelve su callback en `withClock` por sí mismo:

```dart
// fake_async 1.3.3, lib/fake_async.dart
T run<T>(T Function(FakeAsync self) callback) => runZoned(
      () => withClock(_clock, () => callback(this)),
      // ...timer and microtask interception...
    );
```

Y `AutomatedTestWidgetsFlutterBinding.runTest` (en `packages/flutter_test/lib/src/binding.dart`) ejecuta todo el cuerpo de la prueba exactamente dentro de eso:

```dart
final fakeAsync = FakeAsync();
_currentFakeAsync = fakeAsync; // reset in postTest
_clock = fakeAsync.getClock(DateTime.utc(2015));
fakeAsync.run((FakeAsync localFakeAsync) { /* test body */ });
```

Fíjate en los dos relojes distintos. `fakeAsync.getClock(DateTime.utc(2015))` se guarda como el reloj propio del binding, y por eso `tester.binding.clock.now()` informa `2015-01-01T00:00:00.000Z` en una prueba nueva y avanza con `pump`:

```text
binding.clock            = 2015-01-01T00:00:00.000Z
binding.clock after pump(10m) = 2015-01-01T00:10:00.000Z
```

El reloj que ven tus widgets a través de `package:clock` es un `Clock` *distinto* sobre el mismo `FakeAsync`, y su origen viene del constructor de `FakeAsync`:

```dart
// fake_async 1.3.3
FakeAsync({DateTime? initialTime, this.includeTimerStackTrace = true}) {
  final nonNullInitialTime = initialTime ?? clock.now();
  _clock = Clock(() => nonNullInitialTime.add(elapsed));
}
```

`initialTime ?? clock.now()`. El binding llama a `FakeAsync()` sin argumento, así que el origen del reloj falso es lo que el reloj *ambiental* dijera en el momento en que arrancó la prueba. Fuera de cualquier zona, eso es el reloj del sistema. Esa es la única pieza de indeterminismo, y es la pieza que puedes controlar.

## Por qué withClock en flutter_test_config.dart no hace nada

La sugerencia más común para la configuración de toda la suite es `flutter_test_config.dart`. Parece que debería funcionar:

```dart
// test/flutter_test_config.dart -- DOES NOT WORK
import 'dart:async';
import 'package:clock/clock.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await withClock(
    Clock.fixed(DateTime.utc(2026, 3, 14, 9, 26, 53)),
    () async => testMain(),
  );
}
```

Hay dos trampas aquí. La primera es un error de compilación si escribes el obvio `return withClock(fixed, testMain)`: `withClock<T>` infiere `T` del tipo de retorno, así que exige un `Future<void> Function()` mientras que `testExecutable` te entrega un `FutureOr<void> Function()`. Tienes que insertar tu propio closure.

La segunda trampa es que, incluso cuando compila, no tiene ningún efecto. Añadir prints en ambos lados hace evidente el orden:

```text
CFG before testMain, zone clock=2026-08-24T09:16:56.269316
CFG inside zone, clock=2026-03-14T09:26:53.000Z
MAIN body, clock=2026-03-14T09:26:53.000Z
CFG testMain returned, still inside zone
CFG after zone
P12 body, clock=2026-08-24T09:16:56.295534
```

La zona cubre el `main()` de nivel superior del archivo de prueba, que solo *declara* pruebas con `test` y `testWidgets`. `package:test` ejecuta cada cuerpo declarado más tarde, desde su propio linaje de zonas, mucho después de que `testExecutable` haya retornado. `withClock` tiene alcance de zona, así que una zona que ya salió no puede influir en nada. Cualquier artículo que te diga que envuelvas `testMain` en `withClock` nunca lo verificó.

Para lo que `flutter_test_config.dart` *sí* sirve es para ejecutar código una vez antes de la suite. Construir un binding es exactamente ese tipo de código.

## Los tres pasos para fijar el reloj en toda la suite

1. Declara los paquetes que estás por importar. `clock` va en `dependencies` porque el código de producción llamará a `clock.now()`; agrega `meta` a `dev_dependencies` solo si además quieres la anotación `@isTest` de la última sección, de lo contrario el analizador reporta `depend_on_referenced_packages`.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.2
   dependencies:
     flutter:
       sdk: flutter
     clock: ^1.1.2
   ```

2. Deriva de `AutomatedTestWidgetsFlutterBinding` y sobrescribe `runTest` para que `super.runTest` se ejecute dentro de una zona con reloj fijo. Este es todo el truco: `super.runTest` es lo que construye `FakeAsync()`, y `FakeAsync` lee el reloj ambiental para su `initialTime`.

   ```dart
   // test/flutter_test_config.dart -- Flutter 3.44.2
   import 'dart:async';
   import 'package:clock/clock.dart';
   import 'package:flutter/foundation.dart';
   import 'package:flutter_test/flutter_test.dart';

   final DateTime kTestEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

   class FixedStartBinding extends AutomatedTestWidgetsFlutterBinding {
     @override
     Future<void> runTest(
       Future<void> Function() testBody,
       VoidCallback invariantTester, {
       String description = '',
     }) {
       return withClock(
         Clock.fixed(kTestEpoch),
         () => super.runTest(testBody, invariantTester, description: description),
       );
     }
   }
   ```

3. Instancia el binding desde `testExecutable`, antes de que corra cualquier prueba. `TestWidgetsFlutterBinding.ensureInitialized()` devuelve `_instance ?? binding.ensureInitialized(...)`, y el constructor de `AutomatedTestWidgetsFlutterBinding` asigna `_instance` a través de `initInstances`, así que gana el binding que se construya primero. `testWidgets` tomará el tuyo.

   ```dart
   Future<void> testExecutable(FutureOr<void> Function() testMain) async {
     FixedStartBinding();
     await testMain();
   }
   ```

Eso es todo. Sin cambios en ningún archivo de prueba. Un widget que lee el reloj ambiental:

```dart
// Flutter 3.44.2
class AmbientClockBanner extends StatelessWidget {
  const AmbientClockBanner({super.key});

  @override
  Widget build(BuildContext context) => Text(
        'ambient:${clock.now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}
```

ahora se renderiza igual en cada máquina y en cada ejecución:

```text
binding      = FixedStartBinding
ambient      = 2026-03-14T09:26:53.000Z
binding.clock= 2015-01-01T00:00:00.000Z
rendered     = ambient:2026-03-14T09:26:53.000Z
```

Y como sembraste `FakeAsync` en lugar de reemplazar su reloj, el tiempo falso sigue moviéndose bajo tu control:

```dart
testWidgets('advances with pump only', (WidgetTester tester) async {
  final a = clock.now();
  await tester.pump(const Duration(hours: 3, minutes: 30));
  final b = clock.now();
  print('a=$a b=$b delta=${b.difference(a)}');
});
// a=2026-03-14 09:26:53.000Z
// b=2026-03-14 12:56:53.000Z delta=3:30:00.000000
```

`clock.stopwatch()` está conectado al mismo reloj falso, así que `pump(Duration(seconds: 42))` produce un tiempo transcurrido de exactamente `0:00:42.000000`. Cada prueba vuelve a arrancar en la época elegida, porque `runTest` construye un `FakeAsync` nuevo cada vez.

## Inicio fijo frente a reloj congelado: dónde pones withClock lo decide

Hay una segunda variante, y la diferencia es una línea de anidamiento. Envuelve `testBody` en lugar de `super.runTest` y tu zona queda establecida *dentro* de `FakeAsync.run`, así que oculta por completo el reloj falso:

```dart
// test/frozen/flutter_test_config.dart -- Flutter 3.44.2
class FrozenClockBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  Future<void> runTest(
    Future<void> Function() testBody,
    VoidCallback invariantTester, {
    String description = '',
  }) {
    return super.runTest(
      () => withClock(Clock.fixed(kFrozen), testBody),
      invariantTester,
      description: description,
    );
  }
}
```

Ahora `pump` mueve hacia adelante el tiempo de animación del framework pero `clock.now()` no se mueve nunca:

```text
a=2026-03-14 09:26:53.000Z b=2026-03-14 09:26:53.000Z delta=0:00:00.000000
```

Ninguna de las dos variantes interfiere con las animaciones, porque `Ticker` y `SchedulerBinding` se guían por las marcas de tiempo de frame de `FakeAsync`, no por `package:clock`. Un `showDialog` más `pumpAndSettle` bajo el binding congelado sigue resolviéndose y encuentra el diálogo. Elige según lo que estés afirmando:

| | Envolver `super.runTest` | Envolver `testBody` |
| --- | --- | --- |
| Instante inicial | fijo | fijo |
| Avanza con `pump` | sí | no |
| Mecanismo | siembra `FakeAsync.initialTime` | oculta el reloj de `FakeAsync` |
| Bueno para | marcas de tiempo relativas, cuentas atrás, debounce | saludos tipo "Buenas noches", formato de fechas |

Una cosa que hay que evitar: no construyas un reloj perezoso que delegue en el reloj propio del binding, como en `withClock(Clock(() => this.clock.now()), ...)`. El constructor de `FakeAsync` llama a `clock.now()` antes de que el binding haya entrado en la prueba, y `AutomatedTestWidgetsFlutterBinding.clock` afirma `inTest`:

```text
'package:flutter_test/src/binding.dart': Failed assertion: line 2223 pos 12: 'inTest': is not true.
package:clock/src/clock.dart 44:26   Clock.now
package:fake_async/fake_async.dart 106:53   new FakeAsync
package:flutter_test/src/binding.dart 2482:23   AutomatedTestWidgetsFlutterBinding.runTest
```

Un simple `Clock.fixed` evita todo el problema.

## Un wrapper por prueba cuando solo lo necesitas en unos pocos archivos

Si un binding personalizado es más maquinaria de la que quieres, escribe el closure una sola vez como wrapper. La anotación `@isTest` de `package:meta` mantiene contentos al analizador y al descubrimiento de pruebas del IDE:

```dart
// Flutter 3.44.2, clock 1.1.2, meta 1.18.0
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meta/meta.dart';

final DateTime kEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

@isTest
void testWidgetsAt(
  String description,
  WidgetTesterCallback callback, {
  DateTime? at,
  bool skip = false,
}) {
  testWidgets(
    description,
    (WidgetTester tester) =>
        withClock(Clock.fixed(at ?? kEpoch), () => callback(tester)),
    skip: skip,
  );
}
```

Como la zona del wrapper abarca todo el cuerpo de la prueba, cada reconstrucción durante la prueba ve el reloj fijo, incluidas las disparadas por `tap` y `setState` después de un `await`. Esa es la diferencia crucial con envolver solo una parte de una prueba. Si escribes `await withClock(fixed, () async { await tester.pumpWidget(w); })` y luego reconstruyes el widget después de que el closure salga, la reconstrucción escapa de la zona y cae en silencio al reloj falso pero sembrado con la hora del sistema. Lo medí: dentro del closure el widget renderizó `2026-03-14T09:26:53.000Z`, y un `pumpWidget` posterior renderizó `2026-08-24T09:15:30.029972`.

Un `withClock` local sigue prevaleciendo sobre el que aplica a todo el binding, así que las dos técnicas se combinan. Bajo `FixedStartBinding`, una prueba que envuelve su cuerpo en `withClock(Clock.fixed(DateTime.utc(2031, 5, 2, 7)))` renderiza `2031-05-02T07:00:00.000Z`.

## DateTime.now() no se puede falsear, y ningún binding te va a salvar

`package:clock` es pura consulta de zona. Toda su implementación del getter de nivel superior es:

```dart
// clock 1.1.2, lib/src/default.dart
Clock get clock => Zone.current[_clockKey] as Clock? ?? const Clock();
```

No hay ningún global asignable. Tampoco hay nada análogo para `DateTime.now()`, que va directo a la VM. Un widget que lo llama ignora por completo el tiempo falso, incluso un año entero de él:

```text
raw:2026-08-24T09:19:57.370144
after pump(365 days) -> raw:2026-08-24T09:19:57.376244
```

Seis microsegundos de diferencia, ambos reales. Así que si tu widget o tu modelo llama a `DateTime.now()` directamente, nada de lo anterior ayuda. O migras esos puntos de llamada a `clock.now()`, o tomas el reloj como dependencia y te saltas las zonas por completo:

```dart
// Flutter 3.44.2
class InjectedClockBanner extends StatelessWidget {
  const InjectedClockBanner({required this.now, super.key});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => Text(
        'injected:${now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}

// test
await tester.pumpWidget(InjectedClockBanner(now: () => kEpoch));
```

La inyección es el enfoque al que recurro en código nuevo, por la misma razón por la que [TimeProvider y FakeTimeProvider superan a los estáticos ambientales en .NET](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/): la dependencia es visible en el constructor en lugar de estar oculta en una zona. La sobrescritura del binding es la respuesta pragmática para una base de código existente que ya se apoya en `clock.now()`, o para paquetes de terceros que no puedes editar.

Si usas Riverpod, un `Provider<Clock>` sobrescrito en el `ProviderScope` de la prueba es la misma idea con el cableado que ya tienes, y encaja bien con los patrones de [Notifier vs AsyncNotifier vs StreamNotifier](/es/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/).

## Cuatro detalles que conviene conocer antes de hacer commit

**Los cuerpos de `test()` simples reciben el reloj real.** `FakeAsync` solo existe dentro de `testWidgets`, así que un `test('...')` en el mismo archivo informa la hora del sistema tanto para `clock.now()` como para `DateTime.now()`. Si necesitas un reloj fijo también en pruebas unitarias, envuelve esos cuerpos con `withClock` o usa `fakeAsync` de `package:fake_async` directamente.

**`integration_test` y las pruebas dirigidas por `flutter run` corren en tiempo real.** Cuando `FLUTTER_TEST` no está presente, `flutter_test` selecciona `LiveTestWidgetsFlutterBinding`, cuyo reloj está fijado en el código:

```dart
// packages/flutter_test/lib/src/binding.dart
@override
Clock get clock => const Clock();
```

Nada de `FakeAsync`, nada de reloj falso. Mantén el archivo de configuración en `test/` y no en la raíz del proyecto, porque el recorrido de descubrimiento busca `flutter_test_config.dart` en un directorio antes de comprobar en ese directorio el centinela `pubspec.yaml`: una configuración en la raíz aplica también a `integration_test/`, donde construir un `AutomatedTestWidgetsFlutterBinding` pelearía con `IntegrationTestWidgetsFlutterBinding`. No confíes en un reloj fijado en pruebas de integración.

**El descubrimiento del archivo de configuración es de lo más cercano primero.** `flutter_tools` sube desde el archivo de prueba buscando `flutter_test_config.dart` y se detiene en el primer directorio que contenga un `pubspec.yaml`. Así que `test/frozen/flutter_test_config.dart` oculta a `test/flutter_test_config.dart` para todo lo que esté bajo `test/frozen/`, y solo un archivo de configuración aplica jamás a una prueba dada. Así puedes correr una suite con reloj congelado y otra con inicio fijo en paralelo, pero también significa que no puedes superponerlas.

**La web funciona igual.** `flutter test --platform chrome` pasa por `_binding_web.dart`, cuyo `ensureInitialized` también devuelve `AutomatedTestWidgetsFlutterBinding.ensureInitialized()`, y el bootstrap web llama a `testExecutable` igualmente. El binding personalizado aplica sin cambios.

El modelo mental que conviene guardar: `testWidgets` ya te da un reloj falso, `FakeAsync` decide dónde arranca, y la única palanca sobre esa decisión es el reloj ambiental en el momento en que `runTest` construye el `FakeAsync`. Todo lo demás es cuestión de elegir a qué lado de `super.runTest` se sitúa tu `withClock`.

## Relacionado

- [Cómo probar código dependiente del tiempo con TimeProvider y FakeTimeProvider en .NET 11](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) cubre el mismo problema en el ecosistema .NET, donde la abstracción viene incluida en la BCL.
- [Cómo proteger setState con la comprobación mounted después de un hueco asíncrono en Flutter](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) es la otra mitad de escribir pruebas de widgets que sobreviven a los límites de `await`.
- [Cómo cancelar un StreamSubscription en dispose en Flutter](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) importa aquí porque un timer pendiente al desmontar dispara la misma aserción de `_verifyInvariants` que disparan los timers falsos pendientes.
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier en Flutter](/es/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) para cablear un reloj inyectado a través de una sobrescritura de provider en lugar de una zona.
- [Fix: A TextEditingController was used after being disposed en Flutter](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) para la clase de fallos de prueba que aparecen cuando el tiempo falso empieza a moverse en saltos grandes.

## Fuentes

- [Documentación de la API de `package:clock`](https://pub.dev/documentation/clock/latest/) y la [implementación de `withClock`](https://pub.dev/packages/clock), versión 1.1.2.
- [`package:fake_async`](https://pub.dev/packages/fake_async) 1.3.3, en particular el constructor de `FakeAsync` y `FakeAsync.run`.
- [`AutomatedTestWidgetsFlutterBinding`](https://api.flutter.dev/flutter/flutter_test/AutomatedTestWidgetsFlutterBinding-class.html) y [`TestWidgetsFlutterBinding.clock`](https://api.flutter.dev/flutter/flutter_test/TestWidgetsFlutterBinding/clock.html) en la referencia de la API de Flutter 3.44.
- [La documentación de la biblioteca `flutter_test`](https://api.flutter.dev/flutter/flutter_test/flutter_test-library.html) para `flutter_test_config.dart` y `testExecutable`.
- Código fuente del SDK de Flutter en el tag 3.44.2: `packages/flutter_test/lib/src/binding.dart`, `packages/flutter_test/lib/src/_binding_web.dart` y `packages/flutter_tools/lib/src/test/test_config.dart`.
