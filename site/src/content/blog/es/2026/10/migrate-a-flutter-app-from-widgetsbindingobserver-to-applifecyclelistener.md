---
title: "Migrar una app de Flutter de WidgetsBindingObserver.didChangeAppLifecycleState a AppLifecycleListener (Flutter 3.13+)"
description: "Reemplaza el código de ciclo de vida artesanal con WidgetsBindingObserver por AppLifecycleListener: el mapeo de callbacks, la máquina de estados que impone, el nuevo estado hidden que rompe los switch exhaustivos, las solicitudes de salida en escritorio y la prueba que de pronto falla una aserción. Probado en Flutter 3.44.8 con Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "app-lifecycle"
lang: "es"
translationOf: "2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener"
translatedBy: "claude"
translationDate: 2026-10-23
---

Si tu app de Flutter todavía mezcla `WidgetsBindingObserver` en un `State` solo para sobrescribir `didChangeAppLifecycleState`, el reemplazo es `AppLifecycleListener`, agregado en Flutter 3.13.0. Creas un único objeto listener en `initState`, le pasas solo los callbacks que te interesan (`onResume`, `onPause`, `onHide`, `onShow`, `onInactive`, `onRestart`, `onDetach`, `onStateChange`, `onExitRequested`) y llamas a `dispose()` sobre él. Sin mixin, sin el par `addObserver`/`removeObserver`, sin `switch` sobre `AppLifecycleState`. Migrar un observer toma unos 10 minutos y conserva el comportamiento siempre que conozcas dos cosas: desde 3.13 el framework inserta los estados intermedios (`resumed` a `paused` ahora llega como `inactive`, `hidden`, `paused`), y el nuevo valor `AppLifecycleState.hidden` convierte todo `switch` exhaustivo sin `default` en un error de compilación. Todo lo que sigue se ejecutó en Flutter 3.44.8 (Dart 3.12.2).

## Por qué abandonar el observer directo

- **Menos código, menos fugas.** El patrón observer necesita tres piezas coordinadas: el mixin, `WidgetsBinding.instance.addObserver(this)` en `initState` y `removeObserver(this)` en `dispose`. Olvidar la última mantiene vivo un `State` ya descartado en la lista de observers del binding y hace que reciba callbacks después de desmontarse. `AppLifecycleListener` se registra en su constructor y se da de baja en `dispose()`, así que hay una sola llamada que recordar, la misma que ya haces con los controladores.
- **Transiciones, no estados.** `didChangeAppLifecycleState` te dice dónde está la app. La mayoría de la lógica de una app se interesa por cómo llegó ahí: "la app volvió del segundo plano" es `paused` a `hidden` (`onRestart`), que es distinto de "se cerró un diálogo del sistema" (`inactive` a `resumed`, `onResume`). El listener recuerda el estado anterior y llama al callback que nombra la transición.
- **Solicitudes de salida de escritorio en el mismo objeto.** `onExitRequested` permite que una app de Windows, macOS o Linux cancele un cierre para mostrar un aviso de "cambios sin guardar". Con el observer directo eso es otro override aparte, `didRequestAppExit`.
- **Puede vivir fuera del árbol de widgets.** El listener es un objeto Dart simple que solo necesita un `WidgetsBinding`. Un repositorio, un servicio de analítica o un provider de Riverpod pueden tener uno y descartarlo junto con el servicio.

## Qué cambia en la app

| Área | Cambio | Gravedad |
| --- | --- | --- |
| Sentencias `switch (state)` | `AppLifecycleState.hidden` (agregado en 3.13) hace que los switch sin `default` fallen con `non_exhaustive_switch_statement` | alta |
| Pruebas de widgets que llaman directamente a `handleAppLifecycleStateChanged` | Saltar de `resumed` a `paused` ahora falla una aserción dentro del listener | alta |
| Clases `State` con observer | Se elimina el mixin y `addObserver`/`removeObserver`; se reemplazan por un campo y `dispose()` | media |
| Orden de los callbacks | `onStateChange` se dispara después del callback de la transición, una vez por cada estado intermedio | baja |
| Manejo de salida | El override de `didRequestAppExit` pasa a `onExitRequested`; `AppExitResponse` viene de `dart:ui` | baja |

## Lista de verificación previa

- Flutter 3.13.0 o posterior (`flutter --version`). `AppLifecycleListener` no existe en 3.10 y anteriores, y el archivo `packages/flutter/lib/src/widgets/app_lifecycle_listener.dart` aparece por primera vez en la etiqueta 3.13.0.
- Busca en el código `with WidgetsBindingObserver` y `didChangeAppLifecycleState`. Anota qué observers también sobrescriben otros callbacks como `didChangeMetrics`, `didChangePlatformBrightness`, `didChangeLocales` o `didHaveMemoryPressure`. Esos conservan el mixin para los callbacks que no son de ciclo de vida; solo la parte de ciclo de vida se mueve.
- Busca sentencias `switch` y cadenas `if` sobre `AppLifecycleState`. Cada una necesita una decisión sobre `hidden`.
- Busca `handleAppLifecycleStateChanged` en las pruebas. Esas son las pruebas que empezarán a fallar.
- Haz commit o stash primero. Es una migración solo de código, sin datos involucrados, así que `git revert` es la reversión.

## Pasos de la migración

1. **Asigna cada `case` a un callback.** Los callbacks del listener se nombran según transiciones, no estados. Este es el mapeo, tomado del código fuente de `AppLifecycleListener.didChangeAppLifecycleState` en Flutter 3.44.8:

   | Estado nuevo | Estado anterior | Callback |
   | --- | --- | --- |
   | `resumed` | `inactive` (o ninguno) | `onResume` |
   | `inactive` | `resumed` (o ninguno) | `onInactive` |
   | `inactive` | `hidden` | `onShow` |
   | `hidden` | `inactive` (o ninguno) | `onHide` |
   | `hidden` | `paused` | `onRestart` |
   | `paused` | `hidden` (o ninguno) | `onPause` |
   | `detached` | `paused` (o ninguno) | `onDetach` |
   | cualquiera | cualquiera | `onStateChange(state)`, después del callback específico |

   Un `case AppLifecycleState.paused:` se convierte en `onPause`, y `case AppLifecycleState.resumed:` en `onResume`. Si el código anterior hacía algo en `inactive` sin importar la dirección, usa `onStateChange` y conserva el `if`, porque a `inactive` se llega desde dos direcciones y corresponde a dos callbacks distintos. Verificación: cada rama del `switch` anterior tiene exactamente un destino en tus notas.

2. **Reemplaza el mixin por un campo listener.** Este es el antes típico:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - BEFORE
   class PlayerScreen extends StatefulWidget {
     const PlayerScreen({super.key});
     @override
     State<PlayerScreen> createState() => _PlayerScreenState();
   }

   class _PlayerScreenState extends State<PlayerScreen>
       with WidgetsBindingObserver {
     @override
     void initState() {
       super.initState();
       WidgetsBinding.instance.addObserver(this);
     }

     @override
     void didChangeAppLifecycleState(AppLifecycleState state) {
       switch (state) {
         case AppLifecycleState.resumed:
           _player.resume();
         case AppLifecycleState.paused:
           _player.pause();
           _saveProgress();
         default:
           break;
       }
     }

     @override
     void dispose() {
       WidgetsBinding.instance.removeObserver(this);
       super.dispose();
     }

     // _player, _saveProgress and build() omitted
   }
   ```

   Y el después:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - AFTER
   class _PlayerScreenState extends State<PlayerScreen> {
     late final AppLifecycleListener _lifecycle;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onResume: () => _player.resume(),
         onPause: () {
           _player.pause();
           _saveProgress();
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     // _player, _saveProgress and build() unchanged
   }
   ```

   El constructor llama a `binding.addObserver(this)` por sí mismo, así que crear el objeto equivale a suscribirse. Verificación: `flutter analyze` no reporta problemas de importación sin usar de `WidgetsBindingObserver` y la clase ya no tiene cláusula `with` (a menos que aún necesite otros callbacks de observer, ver el paso 4).

3. **Decide qué significa `hidden` para tu lógica.** `AppLifecycleState.hidden` se agregó en Flutter 3.13 para escritorio y web, donde una app puede estar minimizada o en una pestaña en segundo plano sin estar "pausada" en el sentido móvil. En iOS y Android el framework lo sintetiza entre `inactive` y `paused`. Si usabas `onPause` para detener un video, eso sigue funcionando en todos los lugares donde funcionaba antes. Si quieres que el video también se detenga cuando se minimiza una ventana de escritorio, `onHide` es el callback que se dispara en todas las plataformas, con `onShow` como su contraparte. Para cualquier cosa que deba ocurrir solo cuando el usuario sale de la app en móvil (guardar un borrador, vaciar la analítica), el par es `onPause` más `onRestart`. Verificación: anota, por cada callback, a qué plataformas lanzas y si se dispara allí (`onRestart` y `onDetach` están documentados como solo móviles).

4. **Conserva el mixin solo para los callbacks que no son de ciclo de vida.** `AppLifecycleListener` cubre `didChangeAppLifecycleState` y `didRequestAppExit` y nada más. Si un observer también sobrescribe `didChangeMetrics` para reaccionar a los insets del teclado, deja el mixin para ese override y mueve solo el método de ciclo de vida. Verificación: busca en la clase los métodos `@override` de `WidgetsBindingObserver` después de la edición; si no queda ninguno, elimina el mixin y las llamadas a `addObserver`/`removeObserver`.

5. **Mueve `didRequestAppExit` a `onExitRequested`** (solo escritorio). El callback devuelve un `Future<AppExitResponse>`, y ese enum vive en `dart:ui`, no en `package:flutter/widgets.dart` ni en `services.dart`. Sin la importación obtienes `Undefined name 'AppExitResponse'`.

   ```dart
   // Flutter 3.44.8, Dart 3.12.2
   import 'dart:ui' show AppExitResponse;
   import 'package:flutter/material.dart';

   class _EditorState extends State<Editor> {
     late final AppLifecycleListener _lifecycle;
     bool _dirty = false;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onExitRequested: () async {
           if (!_dirty) return AppExitResponse.exit;
           final discard = await showDialog<bool>(
             context: context,
             builder: (context) => AlertDialog(
               title: const Text('Discard unsaved changes?'),
               actions: [
                 TextButton(
                   onPressed: () => Navigator.pop(context, false),
                   child: const Text('Cancel'),
                 ),
                 TextButton(
                   onPressed: () => Navigator.pop(context, true),
                   child: const Text('Discard'),
                 ),
               ],
             ),
           );
           return discard == true ? AppExitResponse.exit : AppExitResponse.cancel;
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) => const Placeholder();
   }
   ```

   Solo las salidas cancelables llegan a este callback. `ServicesBinding.instance.exitApplication(AppExitType.required)` sale sin preguntar. Ten en cuenta que `WidgetsBinding.handleRequestAppExit` consulta a todos los observers, incluso después de que uno haya respondido `cancel`, y cancela la salida si alguno lo hizo. Un listener en cualquier parte de la app puede vetar la salida, y el `onExitRequested` de todos los demás listeners igualmente se ejecuta, así que no pongas allí limpieza irreversible. Verificación: ejecuta en escritorio, deja el editor con cambios, cierra la ventana y confirma que aparece el diálogo y que "Cancel" mantiene la ventana abierta.

6. **Corrige los `switch` que rompió el valor `hidden`.** Si conservas un `switch` (por ejemplo dentro de `onStateChange`), debe cubrir `hidden`. Esto compila en Flutter 3.10 y falla en 3.13+:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - fails flutter analyze
   String describe(AppLifecycleState state) {
     switch (state) {
       case AppLifecycleState.resumed:
         return 'resumed';
       case AppLifecycleState.inactive:
         return 'inactive';
       case AppLifecycleState.paused:
         return 'paused';
       case AppLifecycleState.detached:
         return 'detached';
     }
   }
   ```

   El analizador reporta: "The type 'AppLifecycleState' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'AppLifecycleState.hidden'" (`non_exhaustive_switch_statement`). Agrega un `case AppLifecycleState.hidden:` explícito en lugar de un `default`, para que el próximo valor que Flutter agregue al enum vuelva a ser un error de compilación en vez de una caída silenciosa. Verificación: `flutter analyze` queda limpio.

7. **Actualiza las pruebas que provocan cambios de ciclo de vida.** Mira la siguiente sección; aquí es donde la mayoría de las migraciones realmente se atascan. Verificación: `flutter test` pasa.

## Verificación

La prueba más rápida de que el comportamiento no cambió es una prueba de widgets que envía los cambios de ciclo de vida como lo hace el motor: una cadena en el canal `flutter/lifecycle`. Ese camino pasa por el generador de transiciones del binding, exactamente igual que un dispositivo real.

```dart
// Flutter 3.44.8, Dart 3.12.2 - test/lifecycle_test.dart
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> sendLifecycle(WidgetTester tester, AppLifecycleState state) async {
  final message = const StringCodec().encodeMessage(state.toString());
  await tester.binding.defaultBinaryMessenger
      .handlePlatformMessage('flutter/lifecycle', message, (_) {});
}

void main() {
  testWidgets('background and foreground', (tester) async {
    final log = <String>[];
    final listener = AppLifecycleListener(
      onResume: () => log.add('onResume'),
      onInactive: () => log.add('onInactive'),
      onHide: () => log.add('onHide'),
      onShow: () => log.add('onShow'),
      onPause: () => log.add('onPause'),
      onRestart: () => log.add('onRestart'),
      onStateChange: (s) => log.add('state:${s.name}'),
    );
    addTearDown(listener.dispose);

    await sendLifecycle(tester, AppLifecycleState.resumed);
    await sendLifecycle(tester, AppLifecycleState.paused);
    await sendLifecycle(tester, AppLifecycleState.resumed);

    expect(log, [
      'onResume', 'state:resumed',
      'onInactive', 'state:inactive',
      'onHide', 'state:hidden',
      'onPause', 'state:paused',
      'onRestart', 'state:hidden',
      'onShow', 'state:inactive',
      'onResume', 'state:resumed',
    ]);
  });
}
```

Esta prueba pasa en 3.44.8 y documenta tres hechos en un solo lugar. Un salto de plataforma de `resumed` directamente a `paused` llega como tres pasos. El camino de vuelta ejecuta `onRestart`, `onShow`, `onResume`, en ese orden. Y `onStateChange` siempre va después del callback con nombre del mismo paso. Enviar `resumed` dos veces seguidas no produce nada la segunda vez, porque tanto el binding como el listener descartan los estados repetidos.

Luego las comprobaciones manuales: en Android e iOS, manda la app a segundo plano y tráela de vuelta, y confirma que el trabajo que moviste a `onPause` y `onResume` sigue ocurriendo una vez cada uno. En escritorio, minimiza y restaura si moviste algo a `onHide`/`onShow`, y cierra la ventana si implementaste `onExitRequested`.

## Reversión

La migración es un cambio de código puro; no hay estado persistido involucrado. Haz `git revert` del commit y vuelves al observer. Lo único que no se revierte limpiamente es un `switch` que corregiste por `hidden`: conserva esa corrección, porque el código anterior ya estaba roto en 3.13+.

## Problemas encontrados en una migración real

### Las pruebas que llaman a `handleAppLifecycleStateChanged` ahora fallan una aserción

Muchas suites de pruebas simulan el paso a segundo plano con `tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused)`. Ese método despacha el estado dado directamente, sin los estados intermedios sintetizados. A un observer simple no le importa. El listener valida cada transición, así que con la app en `resumed` esta prueba falla:

```dart
// Flutter 3.44.8, Dart 3.12.2 - fails
testWidgets('direct jump', (tester) async {
  final listener = AppLifecycleListener(onPause: () {});
  addTearDown(listener.dispose);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
});
```

El fallo es una aserción lanzada al despachar a los observers: "Invalid state transition from AppLifecycleState.resumed to AppLifecycleState.paused", y `onPause` nunca se llama. Envía tú mismo cada estado intermedio (`inactive`, `hidden`, `paused`) o usa el helper del canal `flutter/lifecycle` de la sección Verificación, que deja que el framework los genere. La aserción solo existe en compilaciones debug, así que el comportamiento en release no se ve afectado; el riesgo es únicamente una suite de pruebas en rojo.

### El listener solo ve los cambios posteriores a su creación

El constructor toma una instantánea de `binding.lifecycleState` y la trata como el estado anterior. Si creas el listener en una pantalla que se abre mucho después del inicio, no se dispara ningún `onResume` para el estado actual, porque no hubo una transición. El observer anterior se comportaba igual, pero a veces el código dependía de una llamada en `initState` para "ejecutar la lógica de reanudación una vez". Mantenlo explícito: lee `WidgetsBinding.instance.lifecycleState` en `initState` si necesitas el estado actual, igual que antes.

### Los observers antiguos también ven los estados sintetizados

La generación de estados intermedios vive en `ServicesBinding`, no en el listener. En la prueba anterior, un `WidgetsBindingObserver` simple registrado junto al listener también recibió `inactive`, `hidden`, `paused` para un solo mensaje `paused` de la plataforma. Así que si un observer que aún no migraste hace "ante cualquier cosa distinta de `resumed`, pausar la reproducción", ahora ejecuta ese código tres veces por cada paso a segundo plano. Haz esos handlers idempotentes o migra esos handlers a un único callback con nombre.

### Crear un listener antes de `runApp`

`AppLifecycleListener()` usa por defecto `WidgetsBinding.instance` como su `binding`, lo cual lanza una excepción si el binding aún no está inicializado. Un listener que pertenece a un servicio construido en `main()` antes de `runApp` necesita primero `WidgetsFlutterBinding.ensureInitialized()`. Para servicios que sobreviven a cualquier widget, asegúrate además de que algo llame a `dispose()`; con Riverpod eso es `ref.onDispose(listener.dispose)` en el provider que lo crea.

### `onExitRequested` no es un hook del botón atrás en móvil

Es tentador tratar `onExitRequested` como "la app está por cerrarse" en Android. No lo es: según el código fuente del motor, solo los embedders de Windows, macOS y Linux envían solicitudes de salida, así que nunca se dispara en Android ni iOS. Para interceptar el gesto de retroceso de Android, usa `PopScope`. Para ejecutar limpieza cuando una app móvil desaparece, usa `onPause`; no se garantiza que `onDetach` se ejecute antes de que el sistema operativo mate un proceso en segundo plano.

## Relacionado

- El `dispose()` del listener va junto al resto de tu limpieza; consulta [cómo hacer dispose de los controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- Pausar un stream cuando la app pasa a segundo plano es un trabajo habitual de `onPause`, y [cancelar una StreamSubscription en dispose](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) cubre la otra mitad.
- `onPause` no es tu última oportunidad en Android: el sistema operativo puede matar el proceso después. [Restaurar el estado de la UI tras la muerte del proceso en Android con RestorationMixin](/es/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) se encarga de lo que vuelve.
- Si estás limpiando varias APIs obsoletas a la vez, [ejecutar dart fix en todo un repositorio](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) automatiza las mecánicas (esta migración no es una de ellas).
- `onExitRequested` importa más en apps de escritorio con varias ventanas; consulta [cómo habilitar el soporte multiventana en una app de escritorio de Flutter](/es/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

## Fuentes

- [`AppLifecycleListener` class](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html) (api.flutter.dev)
- [`AppLifecycleState` enum and state diagram](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html) (api.flutter.dev)
- [`WidgetsBindingObserver` class](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html) (api.flutter.dev)
- [`ServicesBinding.exitApplication`](https://api.flutter.dev/flutter/services/ServicesBinding/exitApplication.html) (api.flutter.dev)
- [`app_lifecycle_listener.dart` source](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/app_lifecycle_listener.dart) y [`ServicesBinding` transition generation](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/services/binding.dart) (flutter/flutter)
- [Breaking change: new `AppLifecycleState.hidden` enum value](https://docs.flutter.dev/release/breaking-changes/add-applifecyclestate-hidden) (docs.flutter.dev)
