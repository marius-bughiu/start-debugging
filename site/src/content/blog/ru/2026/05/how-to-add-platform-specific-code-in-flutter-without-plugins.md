---
title: "Как добавить платформозависимый код во Flutter без плагинов"
description: "Вызов нативного кода Android (Kotlin) и iOS (Swift) из Flutter 3.x без написания плагина: MethodChannel, EventChannel, BasicMessageChannel, таблица типов StandardMessageCodec, правила потоков и случаи, когда плагин всё же выигрывает."
pubDate: 2026-05-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "ios"
  - "platform-channels"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins"
translatedBy: "claude"
translationDate: 2026-05-05
---

Короткий ответ: добавьте `MethodChannel` в `main.dart`, зарегистрируйте то же имя канала в `FlutterActivity` на Android и в `AppDelegate` на iOS, и вызывайте его через `await channel.invokeMethod(...)`. Используйте `EventChannel` для потоков от нативного кода к Dart (датчики, broadcasts) и `BasicMessageChannel` для сырых байтов или строк. Федерированный плагин нужен только тогда, когда вы хотите переиспользовать интеграцию между несколькими приложениями или опубликовать её на pub.dev. Проверено на Flutter 3.27.1, Android Gradle Plugin 8.7.3 и Xcode 16.2 (Swift 5.10).

Фраза "платформозависимый код" в документации Flutter обычно означает одну вещь: method channel, пересекающий границу Dart и нативного кода. Этот мост существует в каждом Flutter-приложении, с плагином или без. Плагин -- это просто упакованный канал с фасадом на Dart и регистрацией во время сборки в двух файлах `Podfile` / Gradle. Если интеграция нужна только в одном приложении, упаковка -- лишние накладные расходы. В этой статье показано, как пропустить её и при этом сохранить код поддерживаемым.

## Зачем пропускать каркас плагина

`flutter create --template plugin` создаёт федерированный плагин: `my_plugin`, `my_plugin_android`, `my_plugin_ios`, `my_plugin_platform_interface` плюс приложение-пример. Это правильная форма, если интеграцией будут пользоваться несколько приложений или вы планируете её публиковать. Для одного приложения это стоит:

- Шесть дополнительных файлов `pubspec.yaml` и `melos.yaml`, если хочется односложный CI.
- Платформенный интерфейс, добавляющий косвенность для каждого метода.
- Отдельная версия пакета, которую нужно поднимать всякий раз, когда код приложения хочет вызвать новый нативный метод.
- Второй тестовый стенд (приложение `example/` плагина), который расходится с реальным приложением.

В кодовой базе одного приложения канал может жить рядом с фичей, которая его использует. Кнопка, переключающая состояние фонарика, и `FlashlightService`, оборачивающий канал, -- это двадцать строк Dart и двадцать строк Kotlin / Swift.

## Три канала, которые вам реально нужны

Flutter поставляет три типа каналов в `package:flutter/services.dart`. Выбирайте по форме вызова, а не по фиче.

- `MethodChannel`: запрос / ответ. Dart вызывает именованный метод на нативной стороне, ожидает результат, нативная сторона может бросить типизированную ошибку. Подходит для "открыть выбор файла", "получить модель устройства", "вибрация на 200 мс".
- `EventChannel`: push-поток от нативного кода к Dart. Нативная сторона открывает `StreamSink`; Dart подписывается и слушает. Подходит для датчиков, системных broadcast receiver (состояние зарядки, смена сети) или любых колбэков, которые отдаёт ОС.
- `BasicMessageChannel`: сырые, нетипизированные сообщения с кодеком на ваш выбор (`StandardMessageCodec`, `JSONMessageCodec`, `StringCodec`, `BinaryCodec`). Подходит, когда обе стороны ваши и хочется избежать накладных расходов на имя метода, либо когда передаются байты (аудиокадры, буферы изображений).

Все три на стороне Dart асинхронные. Все три сериализуют полезную нагрузку через `MessageCodec`. Кодек по умолчанию -- `StandardMessageCodec`, понимающий небольшой фиксированный набор типов. Если ваша полезная нагрузка не вписывается в этот набор, сериализуйте её сами.

## Таблица типов StandardMessageCodec

Эту таблицу полезно держать открытой, пока пишете код канала. Всё, что вне её, возвращается как `null` или бросает исключение, в зависимости от платформы.

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

`DateTime`, пользовательские классы и `BigInt` в списке отсутствуют. На границе конвертируйте в `int` (epoch ms), `Map` или `String`.

## Полный пример MethodChannel: уровень заряда батареи

Это канонический пример Flutter, расширенный до раскладки файлов, которую вы и правда выпустите.

### 1. Сторона Dart (`lib/services/battery_service.dart`)

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

Три момента стоит отметить. Первое: имя канала -- обратный DNS плюс суффикс фичи; этой конвенции придерживается каждый плагин Flutter, и она избавляет от коллизий с будущим пакетом. Второе: `invokeMethod<int>` -- обобщённый, что даёт сигнал на этапе компиляции о том, что должен вернуть кодек. Третье: `MissingPluginException` бросается, когда имя канала не зарегистрировано на текущей платформе. Поймайте его и преобразуйте в осмысленную ошибку, иначе пользователь увидит трассировку стека из `package:flutter`.

### 2. Сторона Android (`android/app/src/main/kotlin/.../MainActivity.kt`)

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

`configureFlutterEngine` выполняется один раз на движок, а не на каждую пересоздание активности, поэтому это безопасное место для подключения обработчика. Не регистрируйте канал внутри `onCreate`, если ваша `MainActivity` наследует `FlutterFragmentActivity`, иначе при изменении конфигурации обработчики будут утекать.

### 3. Сторона iOS (`ios/Runner/AppDelegate.swift`)

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

Три момента, специфичные для платформы. Первое: `isBatteryMonitoringEnabled` должно быть `true` до чтения `batteryLevel`, иначе вы получите `-1.0`. Второе: `FlutterError` -- аналог `result.error(...)` на iOS, в Dart он всплывает как `PlatformException`. Третье: `GeneratedPluginRegistrant.register(with: self)` остаётся на месте, хотя плагина вы не писали: сборка всё равно создаёт регистрант для любого транзитивного плагина в `pubspec.yaml`.

## EventChannel для потоков

`MethodChannel` не подходит для "сообщи мне, когда состояние батареи изменится". Получится опрос. `EventChannel` позволяет нативной стороне пушить события.

### Подписчик на Dart

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

`receiveBroadcastStream()` возвращает один broadcast-поток, общий для всех слушателей. Отмена последней подписки сообщает нативной стороне разобрать broadcast receiver / observer, поэтому не держите ссылку на подписку, которой не пользуетесь.

### Обработчик на Android

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

Подключите внутри `configureFlutterEngine`:

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/battery_state")
    .setStreamHandler(BatteryStateStreamHandler(applicationContext))
```

Используйте `applicationContext`, а не активность, иначе утечёте активность на всё время жизни broadcast receiver.

### Обработчик на iOS

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

И в `AppDelegate`:

```swift
let stateChannel = FlutterEventChannel(
    name: "com.example.app/battery_state",
    binaryMessenger: controller.binaryMessenger
)
stateChannel.setStreamHandler(BatteryStateStreamHandler())
```

Отправьте начальное значение в `onListen`, чтобы первый `await for (final s in service.watch())` не зависал в ожидании первого OS-broadcast.

## BasicMessageChannel для сырых полезных нагрузок

`BasicMessageChannel` пропускает диспетчер по имени метода и использует тот кодек, что вы передали. Полезен, когда обе стороны ваши и полезная нагрузка однородна.

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

Для бинарных полезных нагрузок используйте `BinaryCodec` на обеих сторонах: получите `ByteData` в Dart, `ByteBuffer` в Kotlin, `FlutterStandardTypedData` в Swift.

## Модель потоков и подводные камни

Сам канал асинхронный, но колбэк обработчика выполняется на потоке платформы, а не в фоновом потоке.

- **Android**: обработчики выполняются в главном потоке Android. Долгая работа блокирует поток UI и приведёт к ANR. Перенесите работу в корутину или `Executors.newSingleThreadExecutor()`, после чего вернитесь в главный поток для вызова `result.success(...)` (`Handler(Looper.getMainLooper()).post { ... }`).
- **iOS**: обработчики выполняются в главной `DispatchQueue`. Правило то же: делайте работу в фоновой очереди, а вызов `result(...)` диспетчеризуйте обратно в главную.
- **Фоновые isolate**: исторически `MethodChannel` требовал корневой isolate. Начиная с Flutter 3.7+ можно из фонового isolate передать собственный `binaryMessenger`, используя `BackgroundIsolateBinaryMessenger.ensureInitialized(token)`, но только для каналов, которые вы создаёте сами, и только для кодеков, не захватывающих локальное для isolate состояние.
- **Hot restart**: hot restart перезапускает `main()`, но не перезапускает `configureFlutterEngine`. Обработчики, зарегистрированные в `configureFlutterEngine`, переживают hot restart, что вам и нужно. Обработчики, зарегистрированные в `initState` Flutter-виджета, не переживают, потому что движок удерживает предыдущую регистрацию, и в итоге у вас два обработчика.

Ловушка "двух обработчиков" -- самая распространённая причина `MissingPluginException` после hot reload: разработчик зарегистрировал обработчик из виджета, виджет пересобрался, старый обработчик остался на месте, а новый дерётся за канал. Регистрируйте каналы ровно один раз -- в `MainActivity.configureFlutterEngine` или `AppDelegate.application(_:didFinishLaunchingWithOptions:)`.

## Ошибки, типы и кодеки на практике

Три правила делают код канала скучным:

1. **Всегда типизируйте сторону Dart**: `invokeMethod<int>`, `invokeMethod<String>`, `invokeMethod<Map<Object?, Object?>>`. Кодек динамический в рантайме; вам нужна статическая проверка.
2. **Всегда отправляйте `result.error(code, message, details)` из нативного кода**: `code` становится `PlatformException.code`, и именно по нему ваш Dart-код делает switch. Никогда не бросайте из самого обработчика; `MethodChannel` не сможет превратить исключение Kotlin в `PlatformException`, если вы его не обернёте.
3. **Конвертируйте на границе**: не отправляйте `Map<String, Object>` со смешанными типами и потом не парсите на другой стороне. Опишите крошечный DTO (`{level: int, charging: bool}`) и напишите конструктор `fromMap` на каждой стороне. Если DTO растёт сверх четырёх полей, используйте [Pigeon](https://pub.dev/packages/pigeon) для генерации marshalling, но сами каналы остаются вашими.

## Когда плагин всё же выигрывает

Не делайте плагин, пока не выполнено одно из условий:

- Вы хотите опубликовать на pub.dev. У плагинов жёсткий контракт на платформенный интерфейс.
- Та же интеграция нужна в трёх или более приложениях. Третья копия -- это момент, когда стоимость приватного пакета становится ниже стоимости синхронизации каналов.
- Нужны условные импорты для `web`, `windows` или `linux`, чтобы Dart-код не пытался обратиться к несуществующей нативной стороне. Шаблон федерированного плагина решает это пустой реализацией по умолчанию; в одном приложении ту же идею вы повторяете руками через класс-заглушку.
- Нужно зарегистрировать несколько каналов и хочется, чтобы они подключались лениво. `FlutterPlugin.onAttachedToEngine` -- поддерживаемый хук жизненного цикла; самописный аналог легко сломать на Android, как только вы начинаете обрабатывать attach / detach активности.

Для длинного хвоста (один канал, одно приложение, одна пара платформ) встроенный подход выше -- это то, что реально делают живые Flutter-кодовые базы.

## По теме

- [Решение MissingPluginException 'No implementation found for method getAll'](/ru/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) -- что делать, когда зарегистрированный канал всё равно бросает исключение в release-сборках (ProGuard, регистрация плагина, hot restart).
- Для мультиверсионной CI-настройки, прогоняющей ваш код канала против нескольких SDK Flutter, см. [как нацелиться на несколько версий Flutter из одного CI-конвейера](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- Если ваш платформенный код находится на стороне .NET и интеграция -- это MAUI вместо Flutter, [руководство по MAUI только для Windows и macOS](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) показывает аналог через target framework.

## Источники

- Документация Flutter, [Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels).
- Справочник API Flutter, [MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html), [EventChannel](https://api.flutter.dev/flutter/services/EventChannel-class.html), [BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html).
- Справочник API Flutter, [StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html) -- таблица поддерживаемых типов.
- Документация Android, [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager).
- Документация Apple, [UIDevice batteryLevel](https://developer.apple.com/documentation/uikit/uidevice/1620042-batterylevel).
- Каналы фоновых isolate Flutter, [BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html) (Flutter 3.7+).
