---
title: "Cómo capturar errores asíncronos no controlados en Flutter con runZonedGuarded y PlatformDispatcher.instance.onError"
description: "FlutterError.onError solo ve los errores lanzados dentro de callbacks del framework. Los futuros sin esperar, los temporizadores, los streams y el código posterior a un await van a otro lugar. Aquí tienes qué manejador captura qué error, medido en Flutter 3.44.8, y la configuración de main() que los captura todos, también en web."
pubDate: 2026-10-18
template: how-to
tags:
  - "flutter"
  - "dart"
  - "error-handling"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Respuesta corta:** en Flutter 3.44 necesitas dos manejadores, no uno. `FlutterError.onError` recibe los errores lanzados dentro de callbacks del framework (build, layout, paint, un `onPressed` síncrono). `PlatformDispatcher.instance.onError` recibe todo lo demás que nadie capturó en el isolate raíz: un `Future` sin esperar, un callback de `Timer`, un stream sin `onError` y cualquier código que se ejecute después de un `await`, incluido el cuerpo de un manejador de botón `async`. Configura ambos al inicio de `main()` y devuelve `true` desde el callback del dispatcher. `runZonedGuarded` es la forma más antigua de capturar el segundo grupo y sigue siendo la única en Flutter web, porque el motor web nunca llama a `PlatformDispatcher.onError`. Los errores lanzados en un isolate que creas tú mismo no llegan a ninguno de los dos manejadores, a menos que pases un puerto `onError`.

Todo lo que sigue se midió en Flutter 3.44.8 (estable) con Dart 3.12.2, ejecutando una compilación release de una aplicación de escritorio macOS que dispara cada tipo de error y registra qué manejador lo recibió. El enrutamiento de los manejadores es el mismo en Android e iOS, ya que vive en el código compartido del motor y del framework.

## Por qué FlutterError.onError no ve los errores asíncronos

La mayoría de las preguntas del tipo "mi reportero de fallos no ve este error" nacen de suponer que `FlutterError.onError` es un captador global. No lo es. El framework lo llama desde sus propios bloques `try`/`catch`: cuando el `build` de un widget lanza una excepción, cuando un `RenderObject` lanza durante layout o paint, cuando el callback de un reconocedor de gestos lanza, cuando lanza un callback del planificador y cuando lanza un manejador de mensajes de plataforma. Cada uno de esos sitios envuelve el error en un `FlutterErrorDetails` con una cadena `context` como "while handling a gesture" o "during a platform message callback" y lo entrega a `FlutterError.reportError`, que llama a `FlutterError.onError`.

Un error que se lanza cuando no hay ningún frame del framework en la pila de llamadas nunca pasa por uno de esos bloques `try`/`catch`. Considera este botón:

```dart
// Flutter 3.44.8, Dart 3.12.2
ElevatedButton(
  onPressed: () async {
    await api.save();          // throws SocketException
    showSnackBar('Saved');
  },
  child: const Text('Save'),
)
```

El reconocedor de gestos llama a `onPressed`, el closure se ejecuta hasta el primer `await`, devuelve un `Future` y el bloque `try` del reconocedor termina sin problemas. Cuando `api.save()` falla más tarde, la excepción completa ese `Future` con un error. Nadie lo espera (el reconocedor ignoró el valor devuelto), así que el error queda "no controlado" y sube por la cadena de zonas. En la zona raíz, el motor de Flutter lo enruta a `PlatformDispatcher.instance.onError`. Si no está configurado, se imprime en el registro y se ignora. La aplicación sigue funcionando, y por eso estos errores suelen pasar desapercibidos hasta que un usuario reporta un botón que "no hace nada".

## La matriz de manejadores, medida

Construí una pequeña aplicación macOS en Flutter 3.44.8 que, tras su primer frame, dispara un tipo de error por ejecución y registra qué manejador lo recibió. La configuración fue la documentada: `FlutterError.onError` más `PlatformDispatcher.instance.onError` en `main()`, sin zonas.

| Qué lanzó el error | Manejador que lo recibió |
| --- | --- |
| Throw síncrono en `onPressed` | `FlutterError.onError` (context: "while handling a gesture") |
| Throw en `build` | `FlutterError.onError` |
| Throw después de un `await` en un `onPressed` `async` | `PlatformDispatcher.instance.onError` |
| `Future.delayed(..., () => throw ...)` sin esperar | `PlatformDispatcher.instance.onError` |
| Callback de `Timer` | `PlatformDispatcher.instance.onError` |
| `Stream.error(...).listen((_) {})` sin `onError` | `PlatformDispatcher.instance.onError` |
| `MethodChannel.invokeMethod` sin esperar sobre un canal inexistente | `PlatformDispatcher.instance.onError` (`MissingPluginException`) |
| `Isolate.run(() => throw ...)` sin esperar | `PlatformDispatcher.instance.onError` |
| Punto de entrada de `Isolate.spawn` que lanza, sin puerto `onError` | Ninguno. El motor imprimió `Unhandled exception` desde `dart_isolate.cc` |
| Lo mismo, con `onError: port.sendPort` | El listener del `RawReceivePort` |

`Isolate.run` llega al dispatcher porque vuelve a lanzar el error del hijo en el `Future` devuelto en el isolate raíz, y ese `Future` no se esperó. Un `Isolate.spawn` directo no hace eso: el error muere con el isolate hijo. El comentario de documentación del propio motor sobre `onError` lo dice de forma directa: "is not directly invoked by errors in child isolates of the root isolate."

## El main() recomendado, paso a paso

Esta es la configuración que captura todas las filas de la tabla en Android, iOS, macOS, Windows y Linux.

1. Llama primero a `WidgetsFlutterBinding.ensureInitialized()` si haces algún trabajo asíncrono antes de `runApp` (inicializar tu reportero de fallos, leer preferencias).
2. Asigna `FlutterError.onError`. Llama a `FlutterError.presentError(details)` dentro para que el cuadro rojo de error y el volcado en consola sigan apareciendo en las compilaciones de depuración, y luego reenvía `details.exception` y `details.stack` a tu reportero.
3. Asigna `PlatformDispatcher.instance.onError`. Reenvía el error y la traza de pila, y devuelve `true`.
4. Llama a `runApp`.
5. Para cada isolate que crees con `Isolate.spawn`, pasa un puerto `onError` y reenvía lo que llegue al mismo reportero.

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ErrorReporter.instance.initialize();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details); // keep the debug console output
    ErrorReporter.instance.report(
      details.exception,
      details.stack ?? StackTrace.empty,
      fatal: false,
      context: details.context?.toDescription(),
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
    return true; // handled: do not print the default "Unhandled Exception"
  };

  runApp(const MyApp());
}

// For isolates you spawn yourself.
Future<Isolate> spawnReported<T>(void Function(T) entry, T message) {
  final errors = RawReceivePort((Object? pair) {
    final list = pair! as List<Object?>;
    ErrorReporter.instance.report(
      list[0]!,
      StackTrace.fromString(list[1]! as String),
      fatal: false,
    );
  });
  return Isolate.spawn(entry, message, onError: errors.sendPort);
}
```

El puerto `onError` recibe una lista de dos elementos: el `toString()` del error y la traza de pila como cadena. Pierdes el tipo original de la excepción en la frontera del isolate, así que registra la cadena tal cual en lugar de intentar comprobarla con `is`.

Si usas Firebase Crashlytics, su configuración documentada tiene la misma forma: `FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError` y `PlatformDispatcher.instance.onError` llamando a `recordError(error, stack, fatal: true)` y devolviendo `true`. Otros SDK de fallos, Sentry incluido, instalan manejadores equivalentes durante su propia inicialización, así que no los sobrescribas después sin encadenar con el manejador anterior.

## Qué hace el valor de retorno de PlatformDispatcher.onError

El tipo de retorno del callback es `bool`, y importa. El motor lo documenta así: devuelve `true` si manejaste el error; de lo contrario devuelve `false` y "a fallback mechanism such as printing to stderr will be used". Ejecuté el caso del `Future` sin esperar con el callback devolviendo `false`. El callback se ejecutó y después el motor también imprimió `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: unawaited Future` con la traza de pila completa. Con `true`, solo se ejecutó mi manejador.

En ninguno de los dos casos terminó el proceso. Un error de Dart no controlado en Flutter no hace caer la aplicación: el bucle de eventos continúa con el siguiente evento. Eso es bueno para los usuarios pero malo para la visibilidad, porque el único síntoma es una acción a medio terminar. Si quieres una política de fallo inmediato, impleméntala tú mismo en el manejador (por ejemplo `if (kReleaseMode) exit(1);`, como muestra la documentación de Flutter para `FlutterError.onError`), y piénsalo bien antes de publicarla.

## runZonedGuarded: cuándo sigues necesitándolo

Antes de que Flutter 3.3 (agosto de 2022) añadiera `PlatformDispatcher.onError`, el consejo estándar era envolver `runApp` en `runZonedGuarded`, de modo que todo error asíncrono generado por código que se ejecuta en esa zona llegara a su callback `onError` en lugar de a la zona raíz. Sigue funcionando, y verifiqué que captura las mismas filas que el dispatcher:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      ErrorReporter.instance.report(details.exception, details.stack ?? StackTrace.empty);
    };
    runApp(const MyApp());
  }, (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
  });
}
```

Con esta configuración, el `Future` sin esperar, el throw después de un `await` en `onPressed` y el `Isolate.run` sin esperar llegaron todos al callback de la zona. El error de `build` siguió yendo a `FlutterError.onError`, porque el framework lo captura antes de que pueda convertirse en un error de zona. Es decir, la zona reemplaza al dispatcher, no a `FlutterError.onError`.

Si configuras ambos (el dispatcher asignado dentro de la zona protegida), gana la zona. En mi ejecución, solo se disparó el callback de `runZonedGuarded` para el `Future` sin esperar, y `PlatformDispatcher.instance.onError` nunca se llamó, porque el error se manejó antes de llegar a la zona raíz. Es inofensivo, pero significa que un SDK de fallos que dependa del dispatcher no verá nada de los errores generados dentro de tu zona. Elige un solo mecanismo.

Hay tres razones para seguir usando una zona en 2026:

- **Flutter web.** El motor web guarda el callback y nunca lo llama. En el código fuente de 3.44.8, `lib/web_ui/lib/src/engine/platform_dispatcher.dart` tiene `// TODO(dnfield): make this work on web.` sobre el setter, y el issue de seguimiento [flutter/flutter#100277](https://github.com/flutter/flutter/issues/100277) sigue abierto. En web, `runZonedGuarded` es la única forma de capturar errores asíncronos de manera global.
- **Valores de zona.** Si dependes de `zoneValues` (un logger con alcance de solicitud, un reloj de pruebas), ya estás creando una zona derivada y puedes añadir ahí el manejador de errores.
- **Manejo con alcance.** Una zona puede envolver un solo subsistema, por ejemplo un trabajo de sincronización, de modo que sus errores se etiqueten y se enruten por separado del resto de la aplicación.

Para una aplicación multiplataforma que también se publica en web, la configuración pragmática es: asigna el manejador del dispatcher (cubre móvil y escritorio) y envuelve el cuerpo de `main` en `runZonedGuarded` solo cuando `kIsWeb` sea true. Mantén ambos callbacks apuntando al mismo reportero.

## La advertencia "Zone mismatch"

Desde Flutter 3.10, las compilaciones de depuración comprueban que el binding se haya inicializado en la misma zona que después llama a `runApp`. Esta es la versión incorrecta, muy común:

```dart
// Flutter 3.44.8: triggers "Zone mismatch" in debug builds
void main() {
  WidgetsFlutterBinding.ensureInitialized(); // root zone
  runZonedGuarded(() => runApp(const MyApp()), reportError); // child zone
}
```

Mi compilación de depuración la reportó a través de `FlutterError.onError` con el contexto "during runApp":

```text
Zone mismatch.
The Flutter bindings were initialized in a different zone than is now being used.
```

Es una advertencia, no un fallo, y en mi ejecución el `Future` sin esperar siguió llegando al callback de la zona, porque `initState` se ejecutó dentro de la zona de `runApp`. El peligro está en los callbacks que el binding registró en el motor mientras estaba en la zona raíz: los eventos de puntero, los mensajes de plataforma y los callbacks de frame se invocan en la zona que estaba activa cuando se registraron. Los errores de esas rutas pueden esquivar tu zona protegida, que es justo la inconsistencia que describe la advertencia. La solución es mover `ensureInitialized()` (y cualquier `await` que lo necesite) dentro del cuerpo de `runZonedGuarded`, como en la sección anterior. Asigna `BindingBase.debugZoneErrorsAreFatal = true` como primera instrucción de `main` si quieres que la CI falle por esto.

## Trampas que ocultan errores de todos modos

- **`catchError` que no devuelve nada.** `future.catchError((e) => log(e))` sobre un `Future<int>` lanza un `ArgumentError` en tiempo de ejecución en Dart 3, porque el manejador debe devolver un valor del tipo del futuro. Usa `try`/`await`/`catch` en su lugar.
- **`unawaited()` oculta la intención, no los errores.** Envolver una llamada en `unawaited(...)` silencia el lint `unawaited_futures`, pero el error sigue yendo al dispatcher. Normalmente es lo que quieres, pero no lo trates como manejo de errores.
- **Un `StreamSubscription` sin `onError`.** Cada evento de error en esa suscripción se reporta como no controlado. Con un stream de larga duración que falla repetidamente, tu reportero recibe un informe por evento. Añade `onError` a las suscripciones que posees y cancélalas, como se explica en [la guía para cancelar un StreamSubscription en dispose](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).
- **Fallos nativos.** Un segfault en código Kotlin, Swift o C de un plugin nunca llega a Dart. Para esos necesitas la parte nativa de tu SDK de fallos.
- **`flutter test`.** El framework de pruebas ejecuta cada prueba en su propia zona y hace fallar la prueba ante cualquier error no controlado, así que los manejadores que configuras en `main()` no se ejercitan en las pruebas de widgets. Prueba tu reporte llamando directamente a las funciones manejadoras.
- **Orden de los manejadores con SDK.** Si un SDK asigna `FlutterError.onError` y tú lo asignas de nuevo después, lo reemplazas en silencio. Guarda el valor anterior (`final previous = FlutterError.onError;`) y llámalo desde tu manejador.

## Relacionado

- [How to handle network errors gracefully in a Flutter app](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) cubre cómo capturar los errores donde ocurren, lo cual siempre es mejor que depender del manejador global.
- [How to write a Dart isolate for CPU-bound work](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) explica `Isolate.run` frente a `Isolate.spawn`, lo que decide si el error de un isolate llega al isolate raíz.
- [What is the difference between a Dart isolate and a thread](/es/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) explica por qué los errores no pueden cruzar la frontera de un isolate como objetos.
- [How to use BuildContext safely after an await in Flutter](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) trata el otro error clásico de los manejadores de botón `async`.

## Fuentes

- Flutter docs: [Handling errors in Flutter](https://docs.flutter.dev/testing/errors)
- Flutter docs: [Zone mismatch message](https://docs.flutter.dev/release/breaking-changes/zone-errors) y [flutter/flutter#122836](https://github.com/flutter/flutter/pull/122836)
- API reference: [PlatformDispatcher.onError](https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html), [FlutterError.onError](https://api.flutter.dev/flutter/foundation/FlutterError/onError.html), [runZonedGuarded](https://api.dart.dev/stable/dart-async/runZonedGuarded.html), [Isolate.spawn](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- Issue: [Implement PlatformDispatcher.onError for web (flutter/flutter#100277)](https://github.com/flutter/flutter/issues/100277)
- Firebase: [Customize your Crashlytics crash reports (Flutter)](https://firebase.google.com/docs/crashlytics/flutter/customize-crash-reports)
