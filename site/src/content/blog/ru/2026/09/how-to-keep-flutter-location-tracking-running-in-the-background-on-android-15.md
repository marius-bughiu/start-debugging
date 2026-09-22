---
title: "Как сохранить отслеживание местоположения во Flutter в фоне на Android 15"
description: "Запускаем трекер местоположения на Flutter, который переживает нажатие кнопки Home, смахивание из списка недавних приложений и перезагрузку на Android 15 и 16: foreground-сервис типа location в собственном движке Flutter, точный набор разрешений и SecurityException, который вы получаете, когда срабатывают правила while-in-use. Проверено с geolocator 14.0.3 и flutter_foreground_task 11.0.3."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "location"
  - "foreground-service"
lang: "ru"
translationOf: "2026/09/how-to-keep-flutter-location-tracking-running-in-the-background-on-android-15"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Коротко:** на Android 15 (и 16) трекер местоположения на Flutter продолжает работать, только если обновления местоположения приходят из **foreground-сервиса типа `location`**, у которого есть **собственный движок Flutter**, а не из потока в вашем UI-изоляте. Объявите `FOREGROUND_SERVICE` и `FOREGROUND_SERVICE_LOCATION` вместе с `ACCESS_FINE_LOCATION`, задайте сервису `android:foregroundServiceType="location"`, запускайте его по нажатию кнопки, пока ваша activity видна, и слушайте `Geolocator.getPositionStream` внутри этого сервиса. Собственного `foregroundNotificationConfig` из `geolocator` достаточно для сценария "продолжать отслеживание, пока приложение в фоне", но он умирает, когда пользователь смахивает приложение. Если трекер должен возвращаться и после перезагрузки или перезапуска системой, пользователь должен выдать разрешение "Разрешить всегда" (`ACCESS_BACKGROUND_LOCATION`), иначе Android выбрасывает `SecurityException` в тот момент, когда сервис вызывает `startForeground`.

Всё, что описано ниже, собрано на Flutter 3.44.8 (по умолчанию `targetSdkVersion` 36), `geolocator` 14.0.3 (`geolocator_android` 5.0.3) и `flutter_foreground_task` 11.0.3 и запущено на эмуляторе Android 16 (API 36). Android 16 применяет все описанные здесь правила foreground-сервисов из Android 14 и Android 15, а поскольку Google Play требует `targetSdkVersion` 36 для новых приложений и обновлений начиная с 31 августа 2026 года, именно по этим правилам работает ваше приложение, какая бы версия Android ни стояла у пользователей.

## Что на самом деле изменилось в Android 15, а что нет

Большинство жалоб в духе "мой трекер останавливается на Android 15" вызваны вовсе не самим Android 15. Правила, которые убивают трекеры местоположения, появились раньше:

- **Android 12 (API 31)** запрещает запускать foreground-сервис, пока приложение находится в фоне, за исключением списка [исключений](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) (загрузка системы, нажатие на уведомление, точный будильник и так далее).
- **Android 14 (API 34)** требует, чтобы каждый foreground-сервис объявлял [тип](https://developer.android.com/develop/background-work/services/fg-service-types) и имел соответствующее разрешение. Для `location` это `FOREGROUND_SERVICE_LOCATION`, а также выданное `ACCESS_COARSE_LOCATION` или `ACCESS_FINE_LOCATION` в момент перевода сервиса на передний план.
- **Разрешения while-in-use**: точное и приблизительное местоположение учитываются только пока ваше приложение видно. Сервис `location`, запущенный из фона, завершается с ошибкой, если у приложения нет `ACCESS_BACKGROUND_LOCATION`, даже когда сам запуск подпадает под одно из разрешённых исключений.

[Android 15](https://developer.android.com/about/versions/15/behavior-changes-15) добавил суточный лимит в 6 часов для сервисов `dataSync` и `mediaProcessing`, список типов, которые получатель `BOOT_COMPLETED` больше не может запускать (`dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection`, а также `microphone` ещё с Android 14), и более строгое исключение для `SYSTEM_ALERT_WINDOW`. `location` нет ни в одном из этих списков. Это важно, потому что большая часть кода отслеживания на Flutter скопирована из примера `flutter_foreground_task`, который объявляет `dataSync`. На Android 15 такой трекер убивается через 6 часов и больше не может вернуться после перезагрузки. Правильный тип решает обе проблемы.

## Почему поток в вашем виджете останавливается

Наивный трекер представляет собой `StreamSubscription<Position>` в объекте `State`. Его колбэки выполняются в UI-изоляте движка Flutter, принадлежащего вашей `FlutterActivity`. Когда Android решает, что процесс простаивает, или пользователь смахивает приложение из списка недавних, этот движок исчезает, а вместе с ним и ваш код на Dart. Никакое foreground-уведомление не удержит код в движке, которого больше не существует.

У `geolocator` для этого есть полумера. Передайте `AndroidSettings` с `foregroundNotificationConfig`, и `geolocator_android` переведёт свой собственный `GeolocatorLocationService` в режим foreground-сервиса:

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

Манифест плагина уже объявляет этот сервис с `android:foregroundServiceType="location"`. Но `GeolocatorPlugin` подключается к нему через `bindService`, а не `startService`, и отвязывается, когда движок отсоединяется. Doc-комментарий плагина прямо говорит, что уведомление "does not run your service in the background". Я измерил это на эмуляторе API 36:

| Сценарий | `geolocator` с `foregroundNotificationConfig` | Сервис `flutter_foreground_task` + `geolocator` внутри него |
| --- | --- | --- |
| Приложение видно | Координаты приходят | Координаты приходят |
| Нажата кнопка Home | Координаты приходят, тип FGS `0x8` | Координаты приходят, тип FGS `0x8` |
| Смахнуто из недавних | Сервис уничтожен, координат больше нет | Тот же процесс продолжает работать, координаты приходят |
| Перезагрузка, только while-in-use | н/д | `SecurityException` на `startForeground` |
| Перезагрузка, "Разрешить всегда" | н/д | Сервис перезапущен, координаты приходят |

После смахивания журнал варианта только с geolocator закончился строками "Unbinding from location service" и "Destroying location service". Во второй сборке движок сервиса остался подключённым ("There is still another flutter engine connected, not stopping location service"), а уведомление продолжало обновляться новыми координатами.

Итак, `foregroundNotificationConfig` подходит, когда "фон" означает "пользователь ненадолго переключился на другое приложение во время пробежки". Для записи поездок, трекера доставки или фитнес-приложения, которое должно работать, пока пользователь не нажмёт Stop, обновления должны жить в сервисе, у которого есть собственный движок.

## Трекер в отдельном движке сервиса

`flutter_foreground_task` запускает настоящий started (а не просто bound) foreground-сервис, поднимает внутри него второй движок Flutter и вызывает там точку входа Dart верхнего уровня. Из этого движка можно использовать любой плагин, включая `geolocator`. Шаги:

1. Добавьте пакеты.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.8
   dependencies:
     geolocator: ^14.0.3
     flutter_foreground_task: ^11.0.3
   ```

   `flutter_foreground_task` 11.x требует Flutter 3.44+, Kotlin 2.2.20+ и Gradle 8.11.1+. Проект, созданный на Flutter 3.44.8, уже использует AGP 9.0.1, Kotlin 2.3.20 и Gradle 9.1.0. Если ваш проект старше, сначала прочитайте про [миграцию Android-проекта Flutter на AGP 9 со встроенным Kotlin](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).

2. Объявите разрешения и сервис в `android/app/src/main/AndroidManifest.xml`.

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

   Не переименовывайте сервис: плагин запускает его по этому имени класса. `FOREGROUND_SERVICE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` и `POST_NOTIFICATIONS` также приходят из собственного манифеста плагина. `FOREGROUND_SERVICE_LOCATION` не приходит ни из одного плагина, поэтому его нужно добавить самостоятельно. `aapt2 dump xmltree` на собранном APK показывает оба сервиса, плагина и geolocator, с `foregroundServiceType=0x00000008` (location).

3. Напишите обработчик задачи, который выполняется в движке сервиса.

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

   `@pragma('vm:entry-point')` обязателен. В релизных сборках tree shaker иначе удалит функцию, которую вызывает только нативный код. Сохраняйте координаты здесь (в SQLite, в файл или пакетом по HTTP), а не полагайтесь на `sendDataToMain`: после смахивания или перезагрузки UI-изолята, который бы слушал, нет. Отменяйте подписку в `onDestroy` по тем же причинам, что описаны в статье об [отмене StreamSubscription в dispose](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

4. Запросите разрешения, разрешите настройки местоположения и запустите сервис из UI.

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

   Передавайте `serviceTypes: [ForegroundServiceTypes.location]` явно. Без этого плагин вызывает `startForeground` с `FOREGROUND_SERVICE_TYPE_MANIFEST`, что означает все типы из атрибута манифеста, и случайный `dataSync` там подтягивает ограничение по времени из Android 15. Оберните ваш `Scaffold` в `WithForegroundTask`, если хотите, чтобы системная кнопка "Назад" сворачивала приложение, а не закрывала activity.

5. Решите, нужно ли вам "Разрешить всегда". Если отслеживание должно работать только пока пользователь не завершил поездку, на этом можно остановиться: точного местоположения плюс сервиса, запущенного из видимой activity, достаточно, и в моём тесте он пережил и Home, и смахивание. Если же он должен сам возвращаться после перезагрузки (`autoRunOnBoot`), после обновления приложения или после того, как система убьёт процесс, запрашивайте фоновое местоположение отдельным, вторым шагом. Когда точное местоположение уже выдано, повторный вызов `Geolocator.requestPermission()` запрашивает `ACCESS_BACKGROUND_LOCATION`, потому что `geolocator_android` добавляет его в запрос, если манифест его объявляет, а текущий статус равен `whileInUse`. На Android 11+ это отправляет пользователя на страницу системных настроек вместо диалога, поэтому объясните причину до вызова.

## SecurityException без фонового местоположения

Это журнал теста с перезагрузкой, когда выдано только местоположение while-in-use, `targetSdkVersion` 36, эмулятор API 36:

```text
I ActivityManager: Background started FGS: Allowed [callingPackage: net.startdebugging.tracker; ... code:BOOT_COMPLETED; ... allowWiu:-1; targetSdkVersion:36 ...]
W ActivityManager: Foreground service started from background can not have location/camera/microphone access: service net.startdebugging.tracker/com.pravera.flutter_foreground_task.service.ForegroundService
E ForegroundService: java.lang.SecurityException: Starting FGS with type location callerApp=ProcessRecord{b79ac40 3076:net.startdebugging.tracker/u0a214} targetSDK=36 requires permissions: all of the permissions allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION] any of the permissions allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]  and the app must be in the eligible state/exemptions to access the foreground only permission
E ForegroundService: 	at android.app.Service.startForeground(Service.java:863)
E ForegroundService: 	at com.pravera.flutter_foreground_task.service.ForegroundService.startForegroundService(ForegroundService.kt:283)
```

Читайте его в две части. Первая строка говорит, что *запуск* был разрешён: `BOOT_COMPLETED` является исключением для запуска из фона, и Android 15 не блокирует `location` при загрузке. Остальное говорит, что *доступ к местоположению* разрешён не был: `allowWiu:-1` означает, что исключение while-in-use не применилось, поэтому разрешение на точное местоположение не учитывалось и `startForeground` выбросил исключение. После `pm grant ... ACCESS_BACKGROUND_LOCATION` и ещё одной перезагрузки тот же получатель запустил сервис, `geolocator` записал в журнал "position updates started", а уведомление показало свежие координаты.

В одном сообщение вводит в заблуждение: оно перечисляет `FOREGROUND_SERVICE_LOCATION` и разрешения fine/coarse, даже когда все они выданы. Увидев его, сначала проверьте, *откуда* был запущен сервис, и только потом манифест. Если `FOREGROUND_SERVICE_LOCATION` действительно отсутствует, вы получите точно такой же текст, причём даже при нажатии кнопки на переднем плане.

## Подводные камни, на которые я потратил время

**У движка сервиса нет Activity.** Fused-клиент `geolocator` сначала вызывает `SettingsClient.checkLocationSettings`. Когда настройка Google "Location Accuracy" выключена, этому вызову нужен диалог разрешения, и без Activity `geolocator_android` вместо этого сообщает `locationServicesDisabled`. При первом запуске обработчик задачи получил "The location service on the device is disabled.", хотя местоположение было включено. Вызов `getCurrentPosition` с теми же настройками из UI до запуска сервиса один раз показывает диалог. После того как пользователь его примет, проверка проходит и внутри сервиса. `forceLocationManager: true` полностью обходит Play services, если вы не хотите зависеть от этой настройки.

**`startService` может сообщить об успехе, пока сервис падает в цикле.** Когда `FOREGROUND_SERVICE_LOCATION` был удалён, `FlutterForegroundTask.startService` не вернул `ServiceRequestFailure`. Плагин перехватывает `SecurityException` внутри `onStartCommand` и останавливает сервис, после чего его логика `allowAutoRestart` ("The service will be restarted after 5 seconds because it wasn't properly stopped.") планирует новую попытку. В итоге получилось 8 одинаковых исключений примерно за 25 секунд. Проверяйте `adb logcat | grep ForegroundService` после первого запуска с каждым новым манифестом.

**Запускайте только из видимого UI или разрешённого триггера.** Нажатие в вашем приложении, действие уведомления или виджет подходят. `Timer`, сработавший после того, как пользователь ушёл из приложения, data-сообщение FCM или задача `WorkManager` не запускают сервис `location`, если у приложения нет фонового местоположения, и даже для самого запуска нужно одно из исключений Android 12.

**Убийцы задач от OEM: отдельная проблема.** На Pixel или эмуляторе foreground-сервис `location` с видимым уведомлением живёт неограниченно долго. Некоторые сборки OEM всё равно его убивают. `FlutterForegroundTask.requestIgnoreBatteryOptimization()` помогает на части из них и сам является одним из исключений для запуска из фона. Просить об этом каждого пользователя упирается в политику Play, поэтому делайте запрос, только когда основное назначение вашего трекера от этого зависит.

**Уведомления можно скрыть, но сервис всё равно работает.** На Android 13+ отклонённое `POST_NOTIFICATIONS` скрывает уведомление из шторки. Сервис всё равно запускается и всё равно виден в Task Manager. Запрашивайте разрешение в любом случае: пользователи, которые не видят уведомления, не понимают, почему садится батарея.

**Play Console требует двух деклараций.** Приложения, нацеленные на Android 14+, должны объявить каждый тип foreground-сервиса в Play Console с описанием и видео. `ACCESS_BACKGROUND_LOCATION` дополнительно требует формы декларации разрешений, заметного раскрытия информации в приложении и политики конфиденциальности. [Руководство Google по фоновому местоположению](https://support.google.com/googleplay/android-developer/answer/9799150) советует по возможности предпочитать доступ на переднем плане. Это ещё одна причина включать шаг 5, только если вам действительно нужны автоматические перезапуски.

**iOS устроен иначе.** `flutter_foreground_task` на iOS представляет собой фоновую задачу `BGTaskScheduler`, которая выполняется около 30 секунд каждые 15 минут. Это не непрерывное отслеживание. На iOS непрерывное отслеживание означает `UIBackgroundModes` `location` плюс `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)` в `geolocator`. Держите две платформы в раздельных ветках кода.

## Что почитать дальше

- Если в итоге вы пишете сервис сами на Kotlin вместо плагина, статья о [добавлении платформенного кода во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) описывает всю обвязку каналов.
- Нацеливание на SDK 35 и выше меняет не только сервисы. Смотрите [исправление UI Flutter, перекрывающего панель навигации Android после перехода на SDK 35](/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/).
- Для периодической, непостоянной фоновой работы хорошей отправной точкой будет [исправление minSdkVersion для background_fetch](/ru/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/).

## Источники

- Android Developers: [Foreground service types](https://developer.android.com/develop/background-work/services/fg-service-types) (тип location, примечание о while-in-use)
- Android Developers: [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- Android Developers: [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) (ужесточение FGS, список `BOOT_COMPLETED`, тайм-аут `dataSync`)
- Play Console Help: [Foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821) и [target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [`geolocator` 14.0.3](https://pub.dev/packages/geolocator) и [исходный код `geolocator_android` 5.0.3](https://github.com/baseflow/flutter-geolocator/tree/main/geolocator_android) (`GeolocatorLocationService`, `StreamHandlerImpl`, `FusedLocationClient`)
- [`flutter_foreground_task` 11.0.3](https://pub.dev/packages/flutter_foreground_task) (`ForegroundService.kt`, `RebootReceiver.kt`)
