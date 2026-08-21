---
title: "Исправление: [firebase_messaging/apns-token-not-set] APNS token has not been set во Flutter на iOS"
description: "getToken() выполняется до того, как APNs передаёт токен устройства в iOS. Опрашивайте getAPNSToken(), пока он не вернёт значение, отличное от null, и только затем вызывайте getToken()."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "firebase"
  - "dart"
lang: "ru"
translationOf: "2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios"
translatedBy: "claude"
translationDate: 2026-08-21
---

Вы вызвали `FirebaseMessaging.instance.getToken()` до того, как APNs передал токен устройства в iOS, и плагин отказывается продолжать. Опрашивайте `getAPNSToken()` в цикле, пока он не вернёт значение, отличное от null, а затем вызывайте `getToken()`. Если через десять секунд значение по-прежнему null, у вас проблема конфигурации, а не состояние гонки: отсутствует возможность Push Notifications, отключена автоматическая инициализация или вы работаете на симуляторе, который не может зарегистрироваться. Всё проверено на `firebase_messaging` 16.5.0 и `firebase_core` 4.13.0 во Flutter 3.44.2.

## Ошибка в контексте

Текущие версии плагина выбрасывают следующее:

```
[firebase_messaging/apns-token-not-set] APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.
```

В более старых версиях формулировка была другой, поэтому результаты поиска по этой проблеме разделены между двумя строками:

```
[firebase_messaging/apns-token-not-set] APNS token has not been set yet. Please ensure the APNS token is available by calling `getAPNSToken()`.
```

Обе строки представляют одно и то же исключение `FirebaseException`, обе несут `code: 'apns-token-not-set'`, и обе приходят из одного места. Сообщение вводит в заблуждение вполне определённым образом: оно предлагает вызвать `getAPNSToken()`, но именно `getAPNSToken()` только что и не сработал. На самом деле имеется в виду "подождите, пока `getAPNSToken()` вернёт хоть что-нибудь".

## Почему токена нет в момент вызова getToken

Проверка находится в Dart, а не в нативном коде. В `firebase_messaging_platform_interface` 4.9.3 файл `method_channel_messaging.dart` определяет приватную защитную функцию:

```dart
// firebase_messaging_platform_interface 4.9.3
Future<void> _APNSTokenCheck() async {
  if (defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.iOS) {
    String? token = await getAPNSToken();

    if (token == null) {
      throw FirebaseException(
        plugin: 'firebase_messaging',
        code: 'apns-token-not-set',
        message:
            'APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.',
      );
    }
  }
}
```

На нативной стороне `getAPNSToken` представляет собой прямое чтение без ожидания и без повторных попыток:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)messagingGetAPNSToken:(id)arguments
         withMethodCallResult:(FLTFirebaseMethodCallResult *)result {
  NSData *apnsToken = [FIRMessaging messaging].APNSToken;
  if (apnsToken) {
    result.success(@{@"token" : [FLTFirebaseMessagingPlugin APNSTokenFromNSData:apnsToken]});
  } else {
    result.success(@{@"token" : [NSNull null]});
  }
}
```

В этом весь механизм. `FIRMessaging.APNSToken` остаётся nil до тех пор, пока iOS не вызовет `application:didRegisterForRemoteNotificationsWithDeviceToken:`, а этот обратный вызов срабатывает по расписанию Apple, после сетевого обмена с APNs. Обычно он приходит через одну или две секунды после запуска, но момент его прихода ваше приложение никак не контролирует. Собственная документация Firebase формулирует ограничение прямо: начиная с iOS SDK 10.4.0 токен APNs должен быть доступен до выполнения запросов к API.

Так что ошибка означает не "что-то сломалось". В типичном случае она означает "вы спросили слишком рано".

## Какие вызовы действительно применяют проверку

В версии 4.9.3 ровно четыре метода ожидают `_APNSTokenCheck()`: `deleteToken()`, `getToken()`, `subscribeToTopic()` и `unsubscribeFromTopic()`. Всё остальное, включая `requestPermission()`, `getInitialMessage()` и поток `onMessage`, работает без неё.

Это объясняет описываемую пользователями картину, которая иначе выглядит противоречиво: запросы разрешений появляются нормально и сообщения на переднем плане приходят, но `subscribeToTopic()` выбрасывает исключение. Подписка на темы защищена проверкой, а доставка сообщений нет.

Сам `getAPNSToken()` проверкой не защищён. Он возвращает null вместо того, чтобы выбрасывать исключение, и именно это делает опрос в цикле безопасным.

## Как выглядит минимальное воспроизведение?

Любое приложение, которое запрашивает токен во время запуска, столкнётся с этим при холодном старте:

```dart
// Flutter 3.44.2, firebase_core 4.13.0, firebase_messaging 16.5.0
Future<String?> brokenRegisterForPush() async {
  await Firebase.initializeApp();
  return FirebaseMessaging.instance.getToken();
}
```

Ошибка возникает нерегулярно, и это худшее её свойство. При тёплом старте или на устройстве, которое недавно уже регистрировалось, токен обычно уже закеширован внутри `FIRMessaging`, и вызов проходит успешно. При чистой установке, на медленной сети или при первом запуске после переустановки приложения вызов падает. Проверяйте на чистой установке, прежде чем считать, что вы всё починили.

## Как дождаться токена APNs перед вызовом getToken?

Ни обратного вызова, ни потока с сообщением "токен APNs теперь доступен" не существует, поэтому опрос в цикле остаётся поддерживаемым подходом. Эта вспомогательная функция проходит анализ без замечаний на `firebase_messaging` 16.5.0:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// Polls `getAPNSToken()` until APNs hands the token to the Firebase iOS SDK.
/// Returns null on non-Apple platforms and on timeout.
Future<String?> waitForAPNSToken({
  Duration timeout = const Duration(seconds: 10),
  Duration interval = const Duration(milliseconds: 250),
}) async {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.iOS &&
          defaultTargetPlatform != TargetPlatform.macOS)) {
    return null;
  }

  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < timeout) {
    final token = await FirebaseMessaging.instance.getAPNSToken();
    if (token != null) return token;
    await Future<void>.delayed(interval);
  }
  return null;
}
```

Возврат null на Android и в вебе имеет значение. Если написать защиту как простой цикл `while (token == null)` без проверки платформы, то на Android `getAPNSToken()` будет возвращать null бесконечно, и вы будете вхолостую крутиться до истечения таймаута при каждом запуске на Android. Реализация в platform interface сразу возвращает null для любой платформы, отличной от Apple, ещё до обращения к method channel.

Встройте это в регистрацию:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPush() async {
  await Firebase.initializeApp();

  final messaging = FirebaseMessaging.instance;
  await messaging.setAutoInitEnabled(true);

  final settings = await messaging.requestPermission();
  debugPrint('authorizationStatus: ${settings.authorizationStatus}');

  final apnsToken = await waitForAPNSToken();
  if (apnsToken == null && !kIsWeb) {
    debugPrint('No APNs token: check Push Notifications capability.');
    return null;
  }

  return messaging.getToken();
}
```

Сделайте то же самое перед вызовами, связанными с темами, поскольку они тоже защищены:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<void> subscribeSafely(String topic) async {
  await waitForAPNSToken();
  await FirebaseMessaging.instance.subscribeToTopic(topic);
}
```

Если вы предпочитаете не перестраивать существующий код запуска, перехватите исключение и повторите вызов один раз. Такой вариант строго хуже, чем ожидание заранее, потому что сначала тратится неудачный сетевой обмен, но изменение получается небольшим:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPushHandled() async {
  try {
    return await FirebaseMessaging.instance.getToken();
  } on FirebaseException catch (e) {
    if (e.code == 'apns-token-not-set') {
      final token = await waitForAPNSToken();
      if (token == null) return null;
      return FirebaseMessaging.instance.getToken();
    }
    rethrow;
  }
}
```

Обратите внимание, что разрешение и доступность токена это разные вещи. Токен устройства APNs порождается именно регистрацией для удалённых уведомлений, и плагин выполняет её во время своей регистрации, а не в ответ на запрос разрешения. У пользователя, который отклонил запрос на уведомления, всё равно может быть действительный токен APNs, и именно благодаря этому работает тихая фоновая доставка push.

## Что происходит при отключённой автоматической инициализации?

Это та причина, которую упускают, и её стоит понять, потому что симптом выглядит как токен, который не приходит никогда, сколько бы вы ни опрашивали.

Если в вашем `Info.plist` параметр `FirebaseMessagingAutoInitEnabled` установлен в `NO` или вы вызвали `setAutoInitEnabled(false)` и это значение сохранилось, плагин при запуске вообще не регистрируется для удалённых уведомлений:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
if ([FIRMessaging messaging].isAutoInitEnabled) {
  [self registerForRemoteNotifications];
}
```

И даже если регистрацию выполняет что-то другое в вашем приложении, обратный вызов делегата откладывает токен в сторону и возвращается, не передав его в `FIRMessaging`:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)application:(UIApplication *)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken {
  FIRMessaging *messaging = [FIRMessaging messaging];
  if (!messaging.isAutoInitEnabled) {
    _apnsToken = deviceToken;
    return;
  }
  // ... setAPNSToken happens only past this point
}
```

`FIRMessaging.APNSToken` остаётся nil, поэтому `getAPNSToken()` продолжает возвращать null, и ваш цикл опроса упирается в таймаут, хотя iOS успешно выдал приложению токен устройства.

Путь восстановления существует, но его нужно запустить. Вызов `setAutoInitEnabled(true)` выполняет `registerForRemoteNotifications`, а затем сбрасывает отложенный токен, и такой сброс выполняется также в начале каждого вызова метода, который обрабатывает плагин:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)ensureAPNSTokenSetting {
  FIRMessaging *messaging = [FIRMessaging messaging];

  if (messaging.isAutoInitEnabled && messaging.APNSToken == nil && _apnsToken != nil) {
    [messaging setAPNSToken:_apnsToken type:FIRMessagingAPNSTokenTypeSandbox];
    _apnsToken = nil;
  }
}
```

Если вы намеренно откладываете регистрацию FCM по соображениям согласия пользователя, это нормально, но `await messaging.setAutoInitEnabled(true)` должен идти до ожидания токена. Именно поэтому он присутствует в `registerForPush()` выше.

## Что проверить, если токен так и не приходит

Идите по этому списку по порядку. Первые два пункта объясняют большинство случаев, когда опрос упирается в таймаут на физическом устройстве.

1. **Возможность Push Notifications.** В Xcode откройте target Runner, перейдите на вкладку Signing and Capabilities и убедитесь, что Push Notifications присутствует в списке. Без неё у приложения нет права `aps-environment`, вызов `registerForRemoteNotifications` завершается неудачей, и iOS вместо этого вызывает `didFailToRegisterForRemoteNotificationsWithError:`. Плагин записывает эту ошибку через `NSLog` и больше ничего не делает, поэтому её легко пропустить. Поищите в консоли Xcode строку о том, что у приложения нет прав на push.
2. **Background Modes.** Включите Background fetch и Remote notifications. Руководство по настройке FlutterFire требует оба режима, а APNs нужен и для доставки на переднем плане, и в фоне.
3. **Ключ APNs загружен в Firebase.** Firebase Console, Project Settings, вкладка Cloud Messaging. Требуется как минимум один ключ. Отсутствие ключа не блокирует сам токен APNs, но ломает всё, что идёт дальше, поэтому исправьте это заодно.
4. **Method swizzling.** Руководство Firebase по клиенту для Flutter прямо указывает, что swizzling обязателен и что без него обработка токена FCM работать не будет. Если вы установили `FirebaseAppDelegateProxyEnabled` в `NO` в `Info.plist`, вам придётся самостоятельно пробрасывать обратные вызовы делегата APNs. Самое простое решение это удалить такой ключ.
5. **Несовпадение bundle ID.** Идентификатор пакета в Xcode должен совпадать с указанным в `GoogleService-Info.plist`. Расхождение здесь порождает запутанные последующие сбои вместо понятной ошибки.

## Выдаёт ли симулятор iOS токен APNs?

Иногда, и условия достаточно узкие, чтобы перечислить их точно. Симулятор поддерживает настоящие удалённые уведомления и настоящие токены устройства только начиная с iOS 16, при работе на macOS 13 или новее, на компьютере Mac с процессором Apple silicon или чипом T2. Токены уникальны для сочетания конкретного симулятора и конкретного Mac, и симулятор регистрируется в песочнице APNs.

Вне этого сочетания симулятор не может зарегистрироваться для удалённых уведомлений, `getAPNSToken()` возвращает null бесконечно, и никакая настройка это не исправит. До Xcode 14 ни один симулятор вообще не мог выдать токен устройства. Если вы ловите эту ошибку на старом симуляторе, на Mac с процессором Intel или на среде выполнения iOS 15, перейдите на физическое устройство, прежде чем менять код.

## Подводные камни и похожие случаи

**Тип токена: песочница против продакшена.** Плагин выбирает тип токена APNs по препроцессорному макросу `DEBUG` на этапе компиляции, используя `FIRMessagingAPNSTokenTypeSandbox` в отладочных сборках и `FIRMessagingAPNSTokenTypeProd` во всех остальных. Это никогда не вызывает `apns-token-not-set`, но именно отсюда берётся классическая жалоба "в debug работает, в TestFlight тишина". Если уведомления перестают приходить в релизной сборке, смотреть надо туда, а не сюда.

**Переустановка обесценивает токены.** Удаление и повторная установка приложения порождают новый токен APNs и новый токен FCM. Серверные записи токенов для прежней установки мертвы. Подпишитесь на `FirebaseMessaging.instance.onTokenRefresh` и загружайте токен заново, а не получайте его один раз при первом запуске и кешируйте навсегда.

**Возврат null из `getAPNSToken()` это не данное исключение.** Если вы видите пустой токен APNs, но никакой выброшенной ошибки, значит, вы вызвали `getAPNSToken()` напрямую. Он возвращает null по замыслу; только четыре защищённых метода превращают этот null в `FirebaseException`.

**Таймаут в десять секунд это предположение, а не гарантия.** На устройстве без сети обратный вызов просто никогда не сработает. Считайте таймаут мягким отказом: верните null, дайте приложению работать дальше и повторите регистрацию позже, вместо того чтобы навсегда блокировать экран запуска.

## Связанные материалы

Если вы разбираетесь с проблемами сборки и интеграции iOS во Flutter-приложении, эти материалы охватывают соседние сбои: [ошибки разрешения версий CocoaPods](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/), которые появляются сразу после добавления плагинов Firebase, [поломка сборки iOS в Xcode 16](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) и её четыре различные причины, [ошибка об отсутствующем destination](/ru/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/), вызванная устаревшим исключением архитектуры в Podfile, [аварийное завершение виртуальной машины Dart в отладочных сборках iOS](/ru/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), которое не лечится никакими правами, и [переход на синглтон в google_sign_in 7.0](/ru/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), если вы одновременно настраиваете Firebase Auth.

## Источники

- [Настройка клиентского приложения Firebase Cloud Messaging во Flutter](https://firebase.google.com/docs/cloud-messaging/flutter/client) - требование к токену APNs начиная с iOS SDK 10.4.0 и требование к method swizzling.
- [Руководство FlutterFire по интеграции с Apple](https://firebase.flutter.dev/docs/messaging/apple-integration/) - возможность Push Notifications, Background Modes, загрузка ключа APNs.
- `firebase_messaging_platform_interface` 4.9.3, `lib/src/method_channel/method_channel_messaging.dart` - защитная функция `_APNSTokenCheck()` и четыре метода, которые её ожидают.
- `firebase_messaging` 16.5.0, `ios/firebase_messaging/Sources/firebase_messaging/FLTFirebaseMessagingPlugin.m` - `messagingGetAPNSToken`, `ensureAPNSTokenSetting` и условие автоматической инициализации при регистрации.
- [Issue #10625 в flutterfire](https://github.com/firebase/flutterfire/issues/10625) - тот issue, на который комментарий в исходном коде `_APNSTokenCheck` ссылается как на причину существования проверки.
- [Поддержка push-уведомлений в симуляторе в Xcode 14](https://github.com/firebase/firebase-ios-sdk/pull/10503) - изменение в firebase-ios-sdk, благодаря которому токены устройства в симуляторе стали пригодны к использованию.
