---
title: "Как исправить: MissingPluginException: No implementation found for method getAll"
description: "Исправляем `MissingPluginException` 'No implementation found for method getAll' во Flutter для shared_preferences и подобных плагинов (package_info_plus и др.): ProGuard, регистрация плагина, minSdkVersion, hot restart."
pubDate: 2023-10-30
updatedDate: 2023-11-01
tags:
  - "flutter"
lang: "ru"
translationOf: "2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall"
translatedBy: "claude"
translationDate: 2026-05-01
---
Это довольно распространённая проблема, которая обычно возникает в release-сборках Flutter. Чаще всего причина в том, что ProGuard на этапе сборки удаляет некоторые необходимые API, что приводит к исключениям об отсутствии реализации, как в примере ниже.

```plaintext
Unhandled exception:
MissingPluginException(No implementation found for method getAll on channel plugins.flutter.io/shared_preferences)
      MethodChannel.invokeMethod (package:flutter/src/services/platform_channel.dart:278:7)
<asynchronous suspension>
      SharedPreferences.getInstance (package:shared_preferences/shared_preferences.dart:25:27)
<asynchronous suspension>
      main (file:///lib/main.dart)
<asynchronous suspension>
      _startIsolate.<anonymous closure> (dart:isolate/runtime/libisolate_patch.dart:279:19)
      _RawReceivePortImpl._handleMessage (dart:isolate/runtime/libisolate_patch.dart:165:12)
```

При этом у этой проблемы на самом деле может быть несколько причин и, соответственно, несколько возможных решений. Ниже мы разберём их все.

## Отключите минификацию и shrinking

Если виноват действительно ProGuard, проблему можно быстро решить парой небольших изменений в конфигурации. Откройте файл `/android/app/build.gradle` и измените конфигурацию сборки `release` с:

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

на это:

```gradle
buildTypes {
        release {
            signingConfig signingConfigs.release
            
            minifyEnabled false
            shrinkResources false
        }
}
```

## Обновите конфигурацию ProGuard

Если предыдущий шаг не помог, можно пойти дальше и изменить конфигурацию ProGuard. Для этого добавьте в файл `build.gradle` две следующие строки сразу после строки `shrinkResources false`.

```gradle
useProguard true
proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
```

Затем создайте новый файл `proguard-rules.pro` в той же папке, где лежит `build.gradle` (`android/app/proguard-rules.pro`), со следующим содержимым:

```gradle
-keep class androidx.lifecycle.DefaultLifecycleObserver
```

## Жёстко сошлитесь на плагин в `main.dart`

Если вы не хотите отключать минификацию или shrinking ProGuard, можно попробовать явно сослаться на плагин в файле `main.dart`. Это поможет ProGuard правильно учесть все необходимые зависимости и не вырезать их при сборке.

Просто вызовите любой метод плагина прямо в `main.dart` и снова запустите приложение.

## Плагин не был зарегистрирован

Убедитесь, что ваш плагин зарегистрирован, вызвав метод `registerWith` в `main.dart`.

```dart
if (Platform.isAndroid) {
    SharedPreferencesAndroid.registerWith();
} else if (Platform.isIOS) {
    SharedPreferencesIOS.registerWith();
}
```

## Работа с `background_fetch`

При работе с `background_fetch` важно повторно регистрировать плагины внутри headless-задачи. Просто возьмите код регистрации выше и добавьте его в начало функции задачи.

```dart
void backgroundFetchTask(HeadlessTask task) async {
    if (Platform.isAndroid) {
        SharedPreferencesAndroid.registerWith();
    } else if (Platform.isIOS) {
        SharedPreferencesIOS.registerWith();
    }
}
```

## Слишком низкий `minSdkVersion`

Возможно, вы нацелены на версию SDK, которая ниже минимальной, требуемой плагином. В таком случае при холодном запуске приложения вы должны увидеть ошибку, похожую на ту, что ниже.

```gradle
The plugin shared_preferences requires a higher Android SDK version.
Fix this issue by adding the following to the file android\app\build.gradle:

android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

Просто следуйте инструкциям из сообщения об ошибке, и проблема должна решиться.

## Возможно, сборка в некорректном состоянии

Может быть, с вашим кодом и зависимостями проекта всё в порядке. Проект мог попасть в некорректное состояние во время установки плагина. Чтобы попробовать это исправить, выполните команду `flutter clean`, а затем `flutter pub get`. Это выполнит чистое восстановление зависимостей проекта. Запустите приложение снова и проверьте, осталась ли проблема.

## Конфликты с другими пакетами

Существует несколько известных конфликтующих пакетов, которые могут приводить к этой проблеме. Попробуйте удалять их по одному и проверять, исчезает ли проблема, а после того как найдёте виновника, попробуйте обновить пакет — конфликты могут быть устранены в более новых версиях.

Вот список пакетов, которые могут вызывать `MissingPluginException`:

-   admob\_flutter
-   flutter\_webrtc
-   flutter\_facebook\_login
