---
title: "Cómo mantener el rastreo de ubicación de Flutter en segundo plano en Android 15"
description: "Ejecuta un rastreador de ubicación en Flutter que sobreviva al botón de inicio, a deslizarlo fuera de recientes y a un reinicio en Android 15 y 16: un servicio en primer plano de tipo location en su propio motor de Flutter, los permisos exactos y la SecurityException que aparece cuando entran en juego las reglas de uso en primer plano. Probado con geolocator 14.0.3 y flutter_foreground_task 11.0.3."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "location"
  - "foreground-service"
lang: "es"
translationOf: "2026/09/how-to-keep-flutter-location-tracking-running-in-the-background-on-android-15"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Respuesta corta:** en Android 15 (y 16), un rastreador de ubicación de Flutter solo sigue funcionando cuando las actualizaciones de ubicación vienen de un **servicio en primer plano de tipo `location`** que ejecuta **su propio motor de Flutter**, no de un stream en el isolate de tu UI. Declara `FOREGROUND_SERVICE` y `FOREGROUND_SERVICE_LOCATION` además de `ACCESS_FINE_LOCATION`, asigna al servicio `android:foregroundServiceType="location"`, inícialo desde un toque en un botón mientras tu activity está visible y escucha `Geolocator.getPositionStream` dentro de ese servicio. El propio `foregroundNotificationConfig` de `geolocator` basta para "seguir rastreando mientras la app está en segundo plano", pero muere cuando el usuario desliza la app para cerrarla. Si además el rastreador debe volver después de un reinicio o de que el sistema lo reinicie, el usuario tiene que conceder "Allow all the time" (`ACCESS_BACKGROUND_LOCATION`), o Android lanza una `SecurityException` en el momento en que el servicio llama a `startForeground`.

Todo lo que sigue se construyó con Flutter 3.44.8 (que usa por defecto `targetSdkVersion` 36), `geolocator` 14.0.3 (`geolocator_android` 5.0.3) y `flutter_foreground_task` 11.0.3, y se ejecutó en un emulador con Android 16 (API 36). Android 16 aplica todas las reglas de servicios en primer plano de Android 14 y Android 15 descritas aquí, y como Google Play exige `targetSdkVersion` 36 para apps nuevas y actualizaciones a partir del 31 de agosto de 2026, estas son las reglas bajo las que corre tu app, sin importar qué versión de Android tengan tus usuarios.

## Lo que Android 15 cambió de verdad, y lo que no

La mayoría de los reportes de "mi rastreador se detiene en Android 15" no se deben a Android 15 en sí. Las reglas que matan a los rastreadores de ubicación son más antiguas:

- **Android 12 (API 31)** prohíbe iniciar un servicio en primer plano mientras la app está en segundo plano, salvo una lista de [excepciones](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) (arranque del sistema, un toque en una notificación, una alarma exacta, etc.).
- **Android 14 (API 34)** exige que cada servicio en primer plano declare un [tipo](https://developer.android.com/develop/background-work/services/fg-service-types) y tenga el permiso correspondiente. Para `location` es `FOREGROUND_SERVICE_LOCATION`, más `ACCESS_COARSE_LOCATION` o `ACCESS_FINE_LOCATION` concedido en el momento en que el servicio pasa a primer plano.
- **Permisos de uso en primer plano (while-in-use)**: la ubicación precisa y la aproximada solo cuentan mientras tu app está visible. Un servicio `location` iniciado desde segundo plano falla a menos que la app tenga `ACCESS_BACKGROUND_LOCATION`, incluso cuando el propio inicio es una de las excepciones permitidas.

Lo que [Android 15](https://developer.android.com/about/versions/15/behavior-changes-15) añadió es un límite diario de 6 horas para los servicios `dataSync` y `mediaProcessing`, una lista de tipos que un receptor de `BOOT_COMPLETED` ya no puede iniciar (`dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection`, y `microphone` desde Android 14) y una excepción de `SYSTEM_ALERT_WINDOW` más estricta. `location` no está en ninguna de las dos listas. Esto importa porque mucho código de rastreo en Flutter copia un ejemplo de `flutter_foreground_task` que declara `dataSync`. En Android 15 ese rastreador muere después de 6 horas y ya no puede volver tras un reinicio. Declarar el tipo correcto resuelve ambos problemas.

## Por qué se detiene el stream de tu widget

El rastreador ingenuo es un `StreamSubscription<Position>` dentro de un objeto `State`. Sus callbacks se ejecutan en el isolate de UI del motor de Flutter que pertenece a tu `FlutterActivity`. Cuando Android decide que ese proceso está inactivo, o el usuario desliza la app fuera de recientes, ese motor desaparece y tu código Dart con él. Ninguna notificación en primer plano puede mantener código en ejecución en un motor que ya no existe.

`geolocator` ofrece una solución a medias para esto. Pasa un `AndroidSettings` con un `foregroundNotificationConfig` y `geolocator_android` promueve su propio `GeolocatorLocationService` a servicio en primer plano:

```dart
// Flutter 3.44.8, geolocator 14.0.3
final sub = Geolocator.getPositionStream(
  locationSettings: AndroidSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 10,
    intervalDuration: const Duration(seconds: 5),
    foregroundNotificationConfig: const ForegroundNotificationConfig(
      notificationTitle: 'Recording trip',
      notificationText: 'Tracking in the background',
      enableWakeLock: true,
    ),
  ),
).listen((p) => debugPrint('GEO_ONLY ${p.latitude},${p.longitude}'));
```

El manifiesto del propio plugin ya declara ese servicio con `android:foregroundServiceType="location"`. Pero `GeolocatorPlugin` se conecta a él con `bindService`, nunca con `startService`, y lo desvincula cuando el motor se desconecta. El comentario de documentación del plugin lo dice claramente: la notificación "does not run your service in the background". Lo medí en el emulador con API 36:

| Escenario | `geolocator` con `foregroundNotificationConfig` | Servicio de `flutter_foreground_task` + `geolocator` dentro de él |
| --- | --- | --- |
| App visible | Se entregan posiciones | Se entregan posiciones |
| Botón de inicio presionado | Se entregan posiciones, tipo de FGS `0x8` | Se entregan posiciones, tipo de FGS `0x8` |
| Deslizada fuera de recientes | Servicio destruido, no llegan más posiciones | El mismo proceso sigue en ejecución, se entregan posiciones |
| Reinicio, solo uso en primer plano | n/a | `SecurityException` en `startForeground` |
| Reinicio, "Allow all the time" | n/a | Servicio reiniciado, se entregan posiciones |

Después de deslizar, el registro de la versión solo con geolocator terminó con "Unbinding from location service" y "Destroying location service". En la otra compilación, el motor del servicio siguió conectado ("There is still another flutter engine connected, not stopping location service") y la notificación siguió actualizándose con nuevas coordenadas.

Así que `foregroundNotificationConfig` es la herramienta correcta cuando "segundo plano" significa "el usuario cambió a otra app durante un rato en medio de una carrera". Para un registrador de viajes, un rastreador de entregas o una app de fitness que debe seguir hasta que el usuario presione Detener, las actualizaciones tienen que vivir en un servicio que tenga su propio motor.

## Construye el rastreador en un motor de servicio separado

`flutter_foreground_task` inicia un servicio en primer plano real, iniciado (no solo vinculado), levanta un segundo motor de Flutter dentro de él y llama allí a un punto de entrada Dart de nivel superior. Desde ese motor puedes ejecutar cualquier plugin, incluido `geolocator`. Los pasos:

1. Agrega los paquetes.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.8
   dependencies:
     geolocator: ^14.0.3
     flutter_foreground_task: ^11.0.3
   ```

   `flutter_foreground_task` 11.x requiere Flutter 3.44+, Kotlin 2.2.20+ y Gradle 8.11.1+. Un proyecto creado con Flutter 3.44.8 ya usa AGP 9.0.1, Kotlin 2.3.20 y Gradle 9.1.0. Si el tuyo es más antiguo, consulta primero [cómo migrar un proyecto Android de Flutter a AGP 9 con Kotlin integrado](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).

2. Declara los permisos y el servicio en `android/app/src/main/AndroidManifest.xml`.

   ```xml
   <!-- targetSdkVersion 36, flutter_foreground_task 11.0.3 -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
       <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
       <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
       <!-- Only if the tracker must restart after boot or a system kill -->
       <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
       <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

       <application ...>
           <!-- ... your activity ... -->
           <service
               android:name="com.pravera.flutter_foreground_task.service.ForegroundService"
               android:foregroundServiceType="location"
               android:exported="false" />
       </application>
   </manifest>
   ```

   No cambies el nombre del servicio: el plugin lo inicia por este nombre de clase. `FOREGROUND_SERVICE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` y `POST_NOTIFICATIONS` también vienen del manifiesto del propio plugin. `FOREGROUND_SERVICE_LOCATION` no viene de ninguno de los dos plugins, así que tienes que agregarlo tú. `aapt2 dump xmltree` sobre el APK compilado muestra ambos servicios, el del plugin y el de geolocator, con `foregroundServiceType=0x00000008` (location).

3. Escribe el task handler que se ejecuta en el motor del servicio.

   ```dart
   // lib/location_task.dart -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   import 'dart:async';

   import 'package:flutter_foreground_task/flutter_foreground_task.dart';
   import 'package:geolocator/geolocator.dart';

   // Runs in the service's own Flutter engine, not in the UI isolate.
   @pragma('vm:entry-point')
   void startLocationTask() {
     FlutterForegroundTask.setTaskHandler(LocationTaskHandler());
   }

   // Shared by the UI (settings check) and the service (tracking).
   AndroidSettings trackingSettings() => AndroidSettings(
     accuracy: LocationAccuracy.high,
     distanceFilter: 10,
     intervalDuration: const Duration(seconds: 5),
     // No foregroundNotificationConfig: the flutter_foreground_task service
     // already is the location foreground service.
   );

   class LocationTaskHandler extends TaskHandler {
     StreamSubscription<Position>? _sub;

     @override
     Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
       _sub = Geolocator.getPositionStream(locationSettings: trackingSettings())
           .listen(
             (p) {
               FlutterForegroundTask.updateService(
                 notificationText:
                     '${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}',
               );
               FlutterForegroundTask.sendDataToMain(<String, Object>{
                 'lat': p.latitude,
                 'lng': p.longitude,
                 'ts': p.timestamp.millisecondsSinceEpoch,
               });
             },
             onError: (Object e) =>
                 FlutterForegroundTask.sendDataToMain('error: $e'),
           );
     }

     @override
     void onRepeatEvent(DateTime timestamp) {}

     @override
     Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
       await _sub?.cancel();
     }
   }
   ```

   `@pragma('vm:entry-point')` no es opcional. En las compilaciones de release, el tree shaker elimina de lo contrario una función que solo llama el código nativo. Guarda las posiciones aquí (en SQLite, en un archivo o en un lote HTTP) en lugar de depender de `sendDataToMain`: después de deslizar la app o de un reinicio no hay ningún isolate de UI escuchando. Cancela la suscripción en `onDestroy`, por las mismas razones que se explican en [cancelar un StreamSubscription en dispose](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

4. Pide los permisos, resuelve la configuración de ubicación e inicia el servicio desde la UI.

   ```dart
   // lib/main.dart (excerpt) -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   void main() {
     FlutterForegroundTask.initCommunicationPort();
     runApp(const MaterialApp(home: TrackerPage()));
   }

   // In the State's initState:
   FlutterForegroundTask.init(
     androidNotificationOptions: AndroidNotificationOptions(
       channelId: 'tracking',
       channelName: 'Trip tracking',
       channelDescription: 'Shown while a trip is being recorded.',
       onlyAlertOnce: true,
     ),
     iosNotificationOptions: const IOSNotificationOptions(),
     foregroundTaskOptions: ForegroundTaskOptions(
       eventAction: ForegroundTaskEventAction.nothing(),
       autoRunOnBoot: true,
       allowWakeLock: true,
     ),
   );

   Future<bool> _ensurePermissions() async {
     if (!await Geolocator.isLocationServiceEnabled()) return false;

     var perm = await Geolocator.checkPermission();
     if (perm == LocationPermission.denied) {
       perm = await Geolocator.requestPermission();
     }
     if (perm == LocationPermission.denied ||
         perm == LocationPermission.deniedForever) {
       return false;
     }

     // Resolve the "improve location accuracy" prompt here, while there is an
     // Activity. The service engine has none, so geolocator would report
     // "location service disabled" instead of showing the dialog.
     try {
       await Geolocator.getCurrentPosition(
         locationSettings: trackingSettings(),
       ).timeout(const Duration(seconds: 20));
     } on TimeoutException {
       // A slow first fix is fine; the settings check already ran.
     } on LocationServiceDisabledException {
       return false;
     }

     if (await FlutterForegroundTask.checkNotificationPermission() !=
         NotificationPermission.granted) {
       await FlutterForegroundTask.requestNotificationPermission();
     }
     return true;
   }

   Future<void> _start() async {
     if (!await _ensurePermissions()) return;
     // Called from a button tap: the activity is visible, so the
     // while-in-use location permission counts.
     final result = await FlutterForegroundTask.isRunningService
         ? await FlutterForegroundTask.restartService()
         : await FlutterForegroundTask.startService(
             serviceId: 4242,
             serviceTypes: [ForegroundServiceTypes.location],
             notificationTitle: 'Recording trip',
             notificationText: 'Waiting for GPS fix',
             callback: startLocationTask,
           );
     if (result is ServiceRequestFailure) {
       debugPrint('start failed: ${result.error}');
     }
   }
   ```

   Pasa `serviceTypes: [ForegroundServiceTypes.location]` de forma explícita. Sin él, el plugin llama a `startForeground` con `FOREGROUND_SERVICE_TYPE_MANIFEST`, lo que significa todos los tipos del atributo del manifiesto, y un `dataSync` olvidado ahí arrastra el límite de tiempo de Android 15. Envuelve tu `Scaffold` en `WithForegroundTask` si quieres que el botón Atrás del sistema minimice la app en lugar de cerrar la activity.

5. Decide si necesitas "Allow all the time". Si el rastreo solo tiene que sobrevivir mientras el usuario mantiene el viaje en curso, detente aquí: la ubicación precisa más un servicio iniciado desde una activity visible es suficiente, y en mi prueba sobrevivió tanto al botón de inicio como a deslizar la app. Si tiene que volver por sí solo después de un reinicio (`autoRunOnBoot`), de una actualización de la app o de que el sistema mate el proceso, solicita la ubicación en segundo plano como un segundo paso separado. Una vez concedida la ubicación precisa, llamar de nuevo a `Geolocator.requestPermission()` pide `ACCESS_BACKGROUND_LOCATION`, porque `geolocator_android` lo agrega a la solicitud cuando el manifiesto lo declara y el estado actual es `whileInUse`. En Android 11+ esto lleva al usuario a la página de configuración del sistema en lugar de mostrar un diálogo, así que explica el motivo antes de llamarlo.

## La SecurityException que obtienes sin ubicación en segundo plano

Este es el registro de la prueba de reinicio con solo la ubicación de uso en primer plano concedida, `targetSdkVersion` 36, emulador con API 36:

```text
I ActivityManager: Background started FGS: Allowed [callingPackage: net.startdebugging.tracker; ... code:BOOT_COMPLETED; ... allowWiu:-1; targetSdkVersion:36 ...]
W ActivityManager: Foreground service started from background can not have location/camera/microphone access: service net.startdebugging.tracker/com.pravera.flutter_foreground_task.service.ForegroundService
E ForegroundService: java.lang.SecurityException: Starting FGS with type location callerApp=ProcessRecord{b79ac40 3076:net.startdebugging.tracker/u0a214} targetSDK=36 requires permissions: all of the permissions allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION] any of the permissions allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]  and the app must be in the eligible state/exemptions to access the foreground only permission
E ForegroundService: 	at android.app.Service.startForeground(Service.java:863)
E ForegroundService: 	at com.pravera.flutter_foreground_task.service.ForegroundService.startForegroundService(ForegroundService.kt:283)
```

Léelo en dos mitades. La primera línea dice que el *inicio* se permitió: `BOOT_COMPLETED` es una excepción para iniciar en segundo plano, y Android 15 no bloquea `location` desde el arranque. El resto dice que el *acceso a la ubicación* no: `allowWiu:-1` significa que la excepción de uso en primer plano no aplicó, así que el permiso de ubicación precisa no contó y `startForeground` lanzó la excepción. Después de `pm grant ... ACCESS_BACKGROUND_LOCATION` y otro reinicio, el mismo receptor inició el servicio, `geolocator` registró "position updates started" y la notificación mostró coordenadas nuevas.

El mensaje engaña en un aspecto: enumera `FOREGROUND_SERVICE_LOCATION` y los permisos de ubicación precisa y aproximada incluso cuando todos están concedidos. Cuando lo veas, revisa *desde dónde* se inició el servicio antes de revisar el manifiesto. Si `FOREGROUND_SERVICE_LOCATION` realmente falta, obtienes exactamente el mismo texto, esta vez incluso desde un toque en un botón en primer plano.

## Trampas que me costaron tiempo

**El motor del servicio no tiene Activity.** El cliente fused de `geolocator` primero llama a `SettingsClient.checkLocationSettings`. Cuando la opción "Location Accuracy" de Google está desactivada, esa llamada necesita un diálogo de resolución, y sin Activity `geolocator_android` reporta `locationServicesDisabled` en su lugar. En mi primera ejecución, el task handler recibió "The location service on the device is disabled." con la ubicación activada. Ejecutar `getCurrentPosition` con la misma configuración desde la UI antes de iniciar el servicio muestra el diálogo una vez. Después de que el usuario lo acepta, la comprobación también pasa dentro del servicio. `forceLocationManager: true` evita por completo los Play services si prefieres no depender de esa opción.

**`startService` puede reportar éxito mientras el servicio está en un bucle de fallos.** Con `FOREGROUND_SERVICE_LOCATION` eliminado, `FlutterForegroundTask.startService` no devolvió un `ServiceRequestFailure`. El plugin captura la `SecurityException` dentro de `onStartCommand` y detiene el servicio, y luego su lógica de `allowAutoRestart` ("The service will be restarted after 5 seconds because it wasn't properly stopped.") programa otro intento. Eso produjo 8 excepciones idénticas en unos 25 segundos. Revisa `adb logcat | grep ForegroundService` después del primer inicio con cada manifiesto nuevo.

**Inicia solo desde UI visible o desde un disparador permitido.** Un toque en tu app, una acción de notificación o un widget funcionan. Un `Timer` que se dispara después de que el usuario salió de la app, un mensaje de datos de FCM o un trabajo de `WorkManager` no inicia un servicio `location` a menos que la app tenga ubicación en segundo plano, e incluso el propio inicio necesita una de las excepciones de Android 12.

**Los task killers de los fabricantes son un problema aparte.** En un Pixel o en un emulador, un servicio en primer plano `location` con una notificación visible sobrevive indefinidamente. Algunas versiones de los fabricantes aún lo matan. `FlutterForegroundTask.requestIgnoreBatteryOptimization()` ayuda en algunas de ellas y es en sí una de las excepciones para iniciar en segundo plano. Pedírselo a todos los usuarios es una cuestión de políticas de Play, así que solicítalo solo cuando el propósito central de tu rastreador dependa de ello.

**Las notificaciones se pueden ocultar, pero el servicio sigue en ejecución.** En Android 13+, un `POST_NOTIFICATIONS` denegado oculta la notificación del panel. El servicio igual se inicia y sigue apareciendo en el Administrador de tareas. Pide el permiso de todos modos: los usuarios que no ven la notificación no tienen idea de por qué se les agota la batería.

**Play Console pide dos declaraciones.** Las apps que apuntan a Android 14+ deben declarar cada tipo de servicio en primer plano en Play Console con una descripción y un video. `ACCESS_BACKGROUND_LOCATION` necesita además el formulario de declaración de permisos, una divulgación destacada dentro de la app y una política de privacidad. La [guía sobre ubicación en segundo plano](https://support.google.com/googleplay/android-developer/answer/9799150) de Google recomienda preferir el acceso en primer plano siempre que sea posible. Esa es una razón más para incluir el paso 5 solo si de verdad necesitas reinicios automáticos.

**iOS es un modelo distinto.** `flutter_foreground_task` en iOS es un fetch de `BGTaskScheduler` que se ejecuta unos 30 segundos cada 15 minutos. No es rastreo continuo. En iOS, el rastreo continuo significa `UIBackgroundModes` `location` más `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)` en `geolocator`. Mantén las dos plataformas en rutas de código separadas.

## Lecturas relacionadas

- Si terminas escribiendo el servicio tú mismo en Kotlin en lugar de usar un plugin, [agregar código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) cubre la conexión de los canales.
- Apuntar al SDK 35 o superior cambia más que los servicios. Consulta [cómo corregir la UI de Flutter que se superpone con la barra de navegación de Android después de apuntar al SDK 35](/es/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/).
- Para trabajo periódico y no continuo en segundo plano, [la corrección de minSdkVersion de background_fetch](/es/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) es un buen punto de partida.

## Fuentes

- Android Developers: [Foreground service types](https://developer.android.com/develop/background-work/services/fg-service-types) (tipo location, nota sobre uso en primer plano)
- Android Developers: [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- Android Developers: [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) (endurecimiento de FGS, lista de `BOOT_COMPLETED`, tiempo límite de `dataSync`)
- Ayuda de Play Console: [Foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821) y [target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [`geolocator` 14.0.3](https://pub.dev/packages/geolocator) y [código fuente de `geolocator_android` 5.0.3](https://github.com/baseflow/flutter-geolocator/tree/main/geolocator_android) (`GeolocatorLocationService`, `StreamHandlerImpl`, `FusedLocationClient`)
- [`flutter_foreground_task` 11.0.3](https://pub.dev/packages/flutter_foreground_task) (`ForegroundService.kt`, `RebootReceiver.kt`)
