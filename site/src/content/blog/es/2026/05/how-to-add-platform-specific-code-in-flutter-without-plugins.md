---
title: "Cómo agregar código específico de plataforma en Flutter sin plugins"
description: "Llama código nativo de Android (Kotlin) e iOS (Swift) desde una aplicación Flutter 3.x sin escribir un plugin: MethodChannel, EventChannel, BasicMessageChannel, la tabla de tipos del StandardMessageCodec, reglas de threading y los casos donde un plugin sigue siendo la mejor opción."
pubDate: 2026-05-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "ios"
  - "platform-channels"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins"
translatedBy: "claude"
translationDate: 2026-05-05
---

Respuesta corta: pon un `MethodChannel` en tu `main.dart`, registra el mismo nombre de canal en el `FlutterActivity` de Android y en el `AppDelegate` de iOS, y llámalo con `await channel.invokeMethod(...)`. Usa `EventChannel` para flujos nativo-a-Dart (sensores, broadcasts) y `BasicMessageChannel` para bytes o cadenas crudas. Solo necesitas un plugin federado cuando quieres reutilizar la integración entre aplicaciones o publicarla en pub.dev. Probado con Flutter 3.27.1, Android Gradle Plugin 8.7.3 y Xcode 16.2 (Swift 5.10).

La frase "código específico de plataforma" suele significar una sola cosa en la documentación de Flutter: un canal de método que cruza el límite Dart-nativo. Ese puente existe en cada aplicación Flutter, con o sin plugin. Un plugin es simplemente un canal empaquetado con una fachada en Dart y un registro en tiempo de compilación en dos archivos `Podfile` / Gradle. Si solo necesitas la integración en una aplicación, el empaquetado es sobrecarga. Esta publicación muestra cómo evitarlo y aún mantener el código mantenible.

## Por qué saltarse el andamiaje de plugin

`flutter create --template plugin` genera un plugin federado: `my_plugin`, `my_plugin_android`, `my_plugin_ios`, `my_plugin_platform_interface`, más una aplicación de ejemplo. Esa es la forma correcta si varias aplicaciones compartirán la integración o si planeas publicarla. Para una sola aplicación te cuesta:

- Seis archivos `pubspec.yaml` adicionales y un `melos.yaml` si quieres CI de un solo paso.
- Una interfaz de plataforma que añade una indirección por cada método.
- Una versión de paquete separada que actualizar cuando el código de tu aplicación quiera llamar un nuevo método nativo.
- Un segundo entorno de pruebas (la aplicación `example/` del plugin) que se desincroniza con tu aplicación real.

En una base de código de una sola aplicación, el canal puede vivir junto a la característica que lo usa. Un botón que activa el estado de la linterna y un `FlashlightService` que envuelve el canal son veinte líneas de Dart y veinte líneas de Kotlin / Swift.

## Los tres canales que realmente necesitas

Flutter incluye tres tipos de canal en `package:flutter/services.dart`. Elige por la forma de la llamada, no por la característica.

- `MethodChannel`: solicitud / respuesta. Dart llama un método con nombre del lado nativo, espera un resultado, el lado nativo puede lanzar un error tipado. Úsalo para "abrir un selector de archivos", "obtener el modelo del dispositivo", "vibrar 200 ms".
- `EventChannel`: flujo desde el lado nativo hacia Dart. El lado nativo abre un `StreamSink`; Dart se suscribe y escucha. Úsalo para sensores, receptores de broadcast del sistema (estado de carga, cambio de red), o cualquier callback que el sistema operativo te dé.
- `BasicMessageChannel`: mensajes crudos sin tipo, con un codec que tú eliges (`StandardMessageCodec`, `JSONMessageCodec`, `StringCodec`, `BinaryCodec`). Úsalo cuando controlas ambos extremos y quieres evitar la sobrecarga del nombre de método, o cuando envías bytes (frames de audio, buffers de imagen).

Los tres son asíncronos del lado de Dart. Los tres serializan su carga útil mediante un `MessageCodec`. El codec por defecto es `StandardMessageCodec`, que entiende un conjunto fijo y pequeño de tipos. Si tu carga útil no encaja en ese conjunto, la serializas tú.

## Tabla de tipos del StandardMessageCodec

Esta es la tabla que conviene tener abierta mientras escribes código de canal. Cualquier cosa fuera de ella vuelve como `null` o lanza, según la plataforma.

| Dart                                | Android (Java/Kotlin)               | iOS (Swift)                                  |
| ----------------------------------- | ----------------------------------- | -------------------------------------------- |
| `null`                              | `null`                              | `nil` / `NSNull`                             |
| `bool`                              | `Boolean`                           | `Bool` / `NSNumber(value: Bool)`             |
| `int` (32 or 64 bit)                | `Integer` / `Long`                  | `Int32` / `Int64` / `NSNumber`               |
| `double`                            | `Double`                            | `Double` / `NSNumber(value: Double)`         |
| `String`                            | `String`                            | `String`                                     |
| `Uint8List`                         | `byte[]`                            | `FlutterStandardTypedData(bytes:)`           |
| `Int32List` / `Int64List` / `Float64List` | `int[]` / `long[]` / `double[]` | `FlutterStandardTypedData(int32:)` etc.      |
| `List<dynamic>`                     | `List<Object?>`                     | `[Any?]`                                     |
| `Map<dynamic, dynamic>`             | `Map<Object?, Object?>`             | `[AnyHashable: Any?]`                        |

`DateTime`, las clases personalizadas y `BigInt` no están en la lista. Convierte a `int` (epoch ms), `Map` o `String` en el límite.

## Un ejemplo completo de MethodChannel: nivel de batería

Es el ejemplo canónico de Flutter, ampliado para mostrar la disposición de archivos que realmente entregarías.

### 1. Lado Dart (`lib/services/battery_service.dart`)

```dart
// Flutter 3.27.1, Dart 3.6
import 'package:flutter/services.dart';

class BatteryUnavailable implements Exception {
  final String message;
  BatteryUnavailable(this.message);
  @override
  String toString() => 'BatteryUnavailable: $message';
}

class BatteryService {
  static const _channel = MethodChannel('com.example.app/battery');

  Future<int> getBatteryLevel() async {
    try {
      final level = await _channel.invokeMethod<int>('getBatteryLevel');
      if (level == null) throw BatteryUnavailable('null result');
      return level;
    } on PlatformException catch (e) {
      throw BatteryUnavailable(e.message ?? e.code);
    } on MissingPluginException {
      throw BatteryUnavailable('handler not registered on this platform');
    }
  }
}
```

Tres detalles que vale la pena notar. Primero, el nombre del canal es DNS inverso más un sufijo de característica; es la convención que sigue cada plugin de Flutter y evita colisiones con un futuro paquete. Segundo, `invokeMethod<int>` es genérico, lo que te da una señal en tiempo de compilación de lo que el codec debe producir. Tercero, `MissingPluginException` se lanza cuando el nombre del canal no está registrado en la plataforma en ejecución. Atrápalo y conviértelo en un error razonable, de lo contrario el usuario recibe una traza de pila desde `package:flutter`.

### 2. Lado Android (`android/app/src/main/kotlin/.../MainActivity.kt`)

```kotlin
// AGP 8.7.3, Kotlin 2.0, Flutter 3.27.1
package com.example.app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.app/battery"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getBatteryLevel" -> {
                        val level = readBatteryLevel()
                        if (level >= 0) result.success(level)
                        else result.error("UNAVAILABLE", "Battery level not available", null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun readBatteryLevel(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } else {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val l = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val s = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (l >= 0 && s > 0) (l * 100) / s else -1
        }
    }
}
```

`configureFlutterEngine` se ejecuta una vez por motor, no una vez por recreación de actividad, así que es el lugar seguro para conectar el handler. No registres el canal dentro de `onCreate` si tu `MainActivity` extiende `FlutterFragmentActivity`, o filtrarás handlers entre cambios de configuración.

### 3. Lado iOS (`ios/Runner/AppDelegate.swift`)

```swift
// Xcode 16.2, Swift 5.10, iOS 13+ deployment target, Flutter 3.27.1
import UIKit
import Flutter

@main
@objc class AppDelegate: FlutterAppDelegate {
    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let controller = window?.rootViewController as! FlutterViewController
        let channel = FlutterMethodChannel(
            name: "com.example.app/battery",
            binaryMessenger: controller.binaryMessenger
        )

        channel.setMethodCallHandler { [weak self] call, result in
            guard call.method == "getBatteryLevel" else {
                result(FlutterMethodNotImplemented)
                return
            }
            self?.readBatteryLevel(result: result)
        }

        GeneratedPluginRegistrant.register(with: self)
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    private func readBatteryLevel(result: FlutterResult) {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        if device.batteryState == .unknown {
            result(FlutterError(code: "UNAVAILABLE", message: "Battery info unavailable", details: nil))
        } else {
            result(Int(device.batteryLevel * 100))
        }
    }
}
```

Tres puntos específicos de la plataforma. Primero, `isBatteryMonitoringEnabled` debe ser `true` antes de leer `batteryLevel`, de lo contrario obtendrás `-1.0`. Segundo, `FlutterError` es el análogo en iOS de `result.error(...)` en Android; aparece en Dart como `PlatformException`. Tercero, `GeneratedPluginRegistrant.register(with: self)` se mantiene aunque no escribiste ningún plugin: el build aún emite un registrante para cualquier plugin transitivo en `pubspec.yaml`.

## EventChannel para flujos

`MethodChannel` no sirve para "avísame cuando cambie el estado de la batería". Acabarías haciendo polling. `EventChannel` permite que el lado nativo empuje los eventos.

### Suscriptor en Dart

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

class BatteryStateService {
  static const _events = EventChannel('com.example.app/battery_state');

  Stream<String> watch() => _events
      .receiveBroadcastStream()
      .map((dynamic event) => event as String);
}
```

`receiveBroadcastStream()` devuelve un único stream broadcast compartido por todos los oyentes. Cancelar la última suscripción le dice al lado nativo que desmonte su receptor de broadcast / observador, así que no guardes una referencia a una suscripción que no usas.

### Handler en Android

```kotlin
// AGP 8.7.3, Kotlin 2.0
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import io.flutter.plugin.common.EventChannel

class BatteryStateStreamHandler(private val context: Context) : EventChannel.StreamHandler {
    private var receiver: BroadcastReceiver? = null

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                               status == BatteryManager.BATTERY_STATUS_FULL
                events.success(if (charging) "charging" else "discharging")
            }
        }
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    }

    override fun onCancel(arguments: Any?) {
        if (receiver != null) {
            context.unregisterReceiver(receiver)
            receiver = null
        }
    }
}
```

Conéctalo dentro de `configureFlutterEngine`:

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/battery_state")
    .setStreamHandler(BatteryStateStreamHandler(applicationContext))
```

Usa `applicationContext`, no la actividad, o filtrarás la actividad durante toda la vida del receptor de broadcast.

### Handler en iOS

```swift
// Swift 5.10
import Flutter
import UIKit

class BatteryStateStreamHandler: NSObject, FlutterStreamHandler {
    private var sink: FlutterEventSink?

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(stateChanged),
            name: UIDevice.batteryStateDidChangeNotification,
            object: nil
        )
        stateChanged()
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        NotificationCenter.default.removeObserver(self)
        sink = nil
        return nil
    }

    @objc private func stateChanged() {
        let s = UIDevice.current.batteryState
        sink?(s == .charging || s == .full ? "charging" : "discharging")
    }
}
```

Y luego en `AppDelegate`:

```swift
let stateChannel = FlutterEventChannel(
    name: "com.example.app/battery_state",
    binaryMessenger: controller.binaryMessenger
)
stateChannel.setStreamHandler(BatteryStateStreamHandler())
```

Envía un valor inicial en `onListen` para que el primer `await for (final s in service.watch())` no se quede esperando el primer broadcast del sistema operativo.

## BasicMessageChannel para cargas crudas

`BasicMessageChannel` se salta el dispatcher de nombres de método y usa el codec que le des. Útil cuando ambos extremos son tuyos y la carga útil es uniforme.

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

final _logChannel = BasicMessageChannel<String>(
  'com.example.app/log',
  StringCodec(),
);

Future<void> sendLog(String line) => _logChannel.send(line) as Future<void>;
```

```kotlin
// AGP 8.7.3, Kotlin 2.0
import io.flutter.plugin.common.BasicMessageChannel
import io.flutter.plugin.common.StringCodec

BasicMessageChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/log", StringCodec.INSTANCE)
    .setMessageHandler { message, reply ->
        android.util.Log.i("flutter", message ?: "")
        reply.reply(null)
    }
```

Para cargas binarias usa `BinaryCodec` en ambos lados y obtienes `ByteData` en Dart, `ByteBuffer` en Kotlin, `FlutterStandardTypedData` en Swift.

## Modelo de threading y los detalles que muerden

El canal en sí es asíncrono, pero el callback del handler corre en el hilo de plataforma, no en un hilo en segundo plano.

- **Android**: los handlers corren en el hilo principal de Android. Trabajo largo bloquea el hilo de UI y disparará un ANR. Mueve el trabajo a una corrutina o a `Executors.newSingleThreadExecutor()`, y luego llama `result.success(...)` de regreso en el hilo principal (`Handler(Looper.getMainLooper()).post { ... }`).
- **iOS**: los handlers corren en el `DispatchQueue` principal. Misma regla: haz el trabajo en una cola en segundo plano y despacha la llamada `result(...)` de vuelta al hilo principal.
- **Isolates en segundo plano**: `MethodChannel` históricamente requería el isolate raíz. Desde Flutter 3.7+ puedes pasar un `binaryMessenger` personalizado desde un isolate en segundo plano usando `BackgroundIsolateBinaryMessenger.ensureInitialized(token)`, pero solo para canales que crees tú, y solo para codecs que no capturen estado local del isolate.
- **Hot restart**: el hot restart re-ejecuta `main()` pero no re-ejecuta `configureFlutterEngine`. Los handlers registrados en `configureFlutterEngine` sobreviven a un hot restart, que es lo que quieres. Los handlers registrados dentro del `initState` de un widget de Flutter no, porque el motor retiene el registro previo y terminas con dos handlers.

La trampa de "dos handlers" es la causa más común de `MissingPluginException` después de un hot reload: alguien registró el handler desde un widget, el widget se reconstruyó, el handler antiguo sigue ahí, el nuevo pelea por el canal. Registra los canales exactamente una vez, en `MainActivity.configureFlutterEngine` o en `AppDelegate.application(_:didFinishLaunchingWithOptions:)`.

## Errores, tipos y codecs en la práctica

Tres reglas mantienen el código de canal aburrido:

1. **Tipa siempre el lado Dart**: `invokeMethod<int>`, `invokeMethod<String>`, `invokeMethod<Map<Object?, Object?>>`. El codec es dinámico en tiempo de ejecución; tú quieres la verificación estática.
2. **Envía siempre `result.error(code, message, details)` desde nativo**: `code` se vuelve `PlatformException.code`, que es lo que tu código Dart usa en el switch. Nunca lances desde dentro del handler; `MethodChannel` no puede convertir una excepción de Kotlin en `PlatformException` a menos que la envuelvas.
3. **Convierte en el límite**: no envíes un `Map<String, Object>` con tipos mezclados y luego lo parsees del otro lado. Define un DTO pequeño (`{level: int, charging: bool}`) y escribe un constructor `fromMap` en cada lado. Si el DTO crece más allá de cuatro campos, usa [Pigeon](https://pub.dev/packages/pigeon) para generar el marshalling, pero los canales en sí siguen siendo tuyos.

## Cuándo gana un plugin

Sáltate el plugin hasta que se cumpla alguna de estas:

- Quieres publicar en pub.dev. Los plugins tienen un contrato firme para la interfaz de plataforma.
- La misma integración se necesita en tres o más aplicaciones. La tercera copia es cuando el costo de un paquete privado cae por debajo del costo de mantener los canales sincronizados.
- Necesitas imports condicionales para `web`, `windows` o `linux` para que el código Dart no intente llamar a un lado nativo inexistente. El patrón de plugin federado maneja esto con una implementación por defecto vacía; en una sola aplicación replicas la misma idea a mano con una clase stub.
- Necesitas registrar varios canales y quieres que se conecten de forma diferida. `FlutterPlugin.onAttachedToEngine` es el hook de ciclo de vida soportado; hacerlo a mano es fácil de equivocar en Android una vez que empiezas a manejar attach / detach de actividades.

Para la cola larga (un canal, una aplicación, un par de plataformas), el enfoque inline de arriba es lo que las bases de código Flutter en producción realmente hacen.

## Relacionado

- La [solución para MissingPluginException 'No implementation found for method getAll'](/es/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) cubre qué hacer cuando un canal registrado igual lanza en builds de release (ProGuard, registro de plugin, hot restart).
- Para una configuración de CI multi-versión que ejerce tu código de canal contra varios SDK de Flutter, mira [cómo apuntar a varias versiones de Flutter desde una sola pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- Si tu código de plataforma está del lado .NET y la integración es MAUI en lugar de Flutter, la [guía MAUI solo para Windows y macOS](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) muestra el equivalente de gating por target framework.

## Fuentes

- Documentación de Flutter, [Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels).
- Referencia de la API de Flutter, [MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html), [EventChannel](https://api.flutter.dev/flutter/services/EventChannel-class.html), [BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html).
- Referencia de la API de Flutter, [StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html) para la tabla de tipos soportados.
- Documentación de Android, [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager).
- Documentación de Apple, [UIDevice batteryLevel](https://developer.apple.com/documentation/uikit/uidevice/1620042-batterylevel).
- Canales de isolate en segundo plano de Flutter, [BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html) (Flutter 3.7+).
