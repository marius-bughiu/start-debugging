---
title: "Fix: вход через Firebase Auth не сохраняется в release-сборке Flutter для Android"
description: "Firebase Auth восстанавливает сессию на Android из приватного файла SharedPreferences без единого сетевого запроса, поэтому выход из аккаунта только в release никогда не является поломкой персистентности. Причина в другом google-services.json, отклонённом обновлении токена, App Check или вашем собственном блоке catch."
pubDate: 2026-08-31
template: how-to
tags:
  - "errors"
  - "flutter"
  - "android"
  - "firebase"
  - "dart"
lang: "ru"
translationOf: "2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build"
translatedBy: "claude"
translationDate: 2026-08-31
---

Вы входите в аккаунт, закрываете приложение, открываете снова, и пользователя нет. Только в release. В debug сессия переживает любой перезапуск. Прежде чем что-либо менять, важно понимать: Firebase Auth на Android восстанавливает вошедшего пользователя из приватного файла `SharedPreferences` вообще без сетевых запросов, поэтому "персистентность сломана в release" почти никогда не соответствует действительности. Либо release-сборка открывает другой файл хранилища, либо что-то это хранилище очистило: обновление токена, которое вернулось отклонённым, а не просто неудачным, принудительная проверка App Check, доверяющая только вашему отладочному сертификату, или ваш собственный код инициализации, вызывающий `signOut()` внутри блока catch. Проверено на `firebase_auth` 6.6.1 и `firebase_core` 4.14.0 во Flutter 3.47.1 с Dart 3.13.1, с разрешением зависимости в `com.google.firebase:firebase-auth:24.2.0` на Android.

## Где на самом деле хранится сессия на Android

Плагин Flutter не реализует персистентность. Он передаёт её в Android SDK, а Android SDK записывает пользователя в файл `SharedPreferences`. В `firebase-auth` 24.2.0 хранилищем является `com.google.firebase.auth.internal.zzce`, конструктор которого разворачивается так:

```java
// Decompiled from com.google.firebase:firebase-auth:24.2.0
// zzce(Context, String persistenceKey)
this.zzc = context.getSharedPreferences(
    String.format("com.google.firebase.auth.api.Store.%s", persistenceKey),
    Context.MODE_PRIVATE);
```

Ключ персистентности берётся из `FirebaseApp.getPersistenceKey()` и представляет собой два URL-безопасных значения base64, соединённых знаком плюс:

```java
// com.google.firebase:firebase-common
// getPersistenceKey() == base64Url(appName) + "+" + base64Url(options.getApplicationId())
```

Для приложения по умолчанию `[DEFAULT]` кодируется как `W0RFRkFVTFRd`, поэтому реальный путь на устройстве выглядит так:

```
/data/data/<applicationId>/shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+<base64url of mobilesdk_app_id>.xml
```

Из этого конструктора следуют два факта, которые задают направление всему разбору. Во-первых, восстановление пользователя это чтение с диска. Конструктор `FirebaseAuth` создаёт `zzce` и достаёт оттуда сохранённого пользователя, поэтому устройство без сети всё равно запускается с активной сессией. Во-вторых, имя файла выводится из Google app ID в вашем `google-services.json`. Измените это значение между вариантами сборки, и вы не потеряете сессию, а просто перестанете открывать файл, в который она была записана.

## Почему у `currentUser` на Android нет состояния гонки

Широко распространено утверждение, что `FirebaseAuth.instance.currentUser` какое-то мгновение после запуска равен null и нужно дождаться `authStateChanges()`. Для веба и десктопных эмбеддеров это верно. Для Android это неверно, и знание этого избавит вас от "починки" состояния гонки, которого не существует.

Android-плагин публикует восстановленного пользователя как константу плагина во время `Firebase.initializeApp()`:

```kotlin
// firebase_auth 6.6.1, android/.../FlutterFirebaseAuthPlugin.kt
override fun getPluginConstantsForFirebaseApp(
    firebaseApp: FirebaseApp?
): Task<MutableMap<String, Any>> {
  // ...
  val firebaseAuth = FirebaseAuth.getInstance(firebaseApp!!)
  val firebaseUser = firebaseAuth.currentUser
  val user = PigeonParser.parseFirebaseUser(firebaseUser)
  if (user != null) {
    constants["APP_CURRENT_USER"] = PigeonParser.manuallyToList(user)
  }
  // ...
}
```

Эти константы попадают в `MethodChannelFirebaseAuth.setInitialValues`, а потоки повторно выдают это значение до того, как что-либо придёт из нативного канала событий:

```dart
// firebase_auth_platform_interface, method_channel_firebase_auth.dart
@override
Stream<UserPlatform?> authStateChanges() async* {
  yield currentUser;
  yield* _authStateChangesListeners[app.name]!.stream.map((event) => event.value);
}
```

Таким образом, на Android после возврата из `await Firebase.initializeApp()` значение `currentUser` уже корректно, и первое событие из `authStateChanges()` это то же самое значение. Если в release оно равно null, хранилище действительно было пустым. Замена `currentUser` на `StreamBuilder` ответа не изменит, хотя по другим причинам это по-прежнему правильная форма для шлюза аутентификации, о чём стоит почитать вместе с [сравнением StreamBuilder и AsyncValue в Riverpod](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

## Шаги диагностики, которые локализуют причину

Выполняйте их по порядку. Каждый отсекает целый класс объяснений, а первые два занимают около пяти минут.

1. **Сделайте release-сборку отлаживаемой, чтобы её можно было исследовать.**
   `adb shell run-as` отказывается работать с пакетом, не помеченным как отлаживаемый, поэтому прочитать хранилище из обычного release-APK не получится. Добавьте одноразовый build type в `android/app/build.gradle.kts`, соберите с ним и удалите, когда закончите.

   ```kotlin
   // android/app/build.gradle.kts, temporary
   buildTypes {
       create("releaseProbe") {
           initWith(getByName("release"))
           isDebuggable = true
           matchingFallbacks += listOf("release")
       }
   }
   ```

2. **Проверьте, существует ли файл хранилища и какой именно это файл.**
   Войдите в аккаунт, принудительно остановите приложение и выведите содержимое каталога настроек. Если файл на месте и не пуст, но приложение всё равно стартует без сессии, у вас проблема в коде, а не в хранилище. Если файла нет, что-то его удалило.

   ```bash
   adb shell run-as com.example.app ls -l shared_prefs/
   adb shell run-as com.example.app cat 'shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+...xml'
   ```

3. **Сравните Google app ID, который каждый вариант действительно вкомпилировал.**
   Gradle-плагин `google-services` записывает разобранные значения в сгенерированный файл ресурсов для каждого варианта. Сравните их. Различие здесь полностью объясняет симптом, и больше ничего исследовать не нужно.

   ```bash
   grep google_app_id android/app/build/generated/res/google-services/debug/values/values.xml
   grep google_app_id android/app/build/generated/res/google-services/release/values/values.xml
   ```

4. **Исключите R8 с помощью отчёта об использовании, а не догадок.**
   Сокращение кода включено в release-сборках Flutter, так что подозрение оправданно, но проверяется дёшево. Добавьте `-printusage build/r8-usage.txt` в `android/app/proguard-rules.pro`, пересоберите и поищите в отчёте `com.google.firebase.auth`.

5. **Понаблюдайте за обновлением токена.**
   Включите подробное логирование Firebase Auth и запустите приложение с холодного старта при включённой сети. Обновление, упавшее с транспортной ошибкой, оставляет сессию нетронутой. Отклонённое обновление это то, что её стирает.

   ```bash
   adb shell setprop log.tag.FirebaseAuth VERBOSE
   adb logcat -s FirebaseAuth:V FirebaseApp:V
   ```

6. **Проверьте отпечатки сертификатов, зарегистрированные в проекте.**
   Выведите отпечатки, которыми ваш release-вариант подписан на самом деле, и сравните их с настройками проекта в Firebase, ограничениями ключа API в Google Cloud и страницей App Signing в Play Console.

   ```bash
   cd android && ./gradlew signingReport
   ```

## Причина 1: release-вариант читает другой `google-services.json`

Это самый частый ответ и самый легко упускаемый, потому что ничто в нём не выглядит как проблема аутентификации.

Source set в Android позволяют положить `google-services.json` в `android/app/src/debug/`, `android/app/src/prod/` или любой каталог flavor, и Gradle-плагин выбирает самый специфичный для собираемого варианта. CLI FlutterFire поощряет ту же раскладку через `--android-out`. Если ваш debug-вариант берёт файл из проекта Firebase для разработки, а release-вариант из продакшена, то `options.getApplicationId()` различается, ключ персистентности различается и имя файла хранилища различается.

Следствие вполне конкретно: сессия, записанная одним вариантом, невидима для другого, а сессия, записанная release-вариантом до смены его конфигурации, невидима после. Шаг 3 выше ловит это одной командой. Исправление не в коде: нужно убедиться, что выпускаемый вариант каждый раз входит и читает данные в одном и том же проекте, и что все тестирующие понимают: смена конфигурации равносильна выходу из аккаунта.

Использование `applicationIdSuffix` в debug даёт похожую, но более простую ситуацию: две отдельные установки с отдельными песочницами. Это ожидаемое поведение и обычно не то, о чём сообщают.

## Причина 2: R8 включён в release, но стандартная конфигурация безопасна

Flutter сам включает сокращение кода для release-сборок. Из Gradle-плагина Flutter, проверено на локальном SDK 3.44.8, где эта логика не менялась с 3.44:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt
if (FlutterPluginUtils.shouldShrinkResources(project)) {
    val releaseBuildType: BuildType = ...buildTypes.getByName("release")
    releaseBuildType.isMinifyEnabled = true
    releaseBuildType.isShrinkResources = FlutterPluginUtils.isBuiltAsApp(project)
    releaseBuildType.proguardFiles.add(...getDefaultProguardFile("proguard-android-optimize.txt"))
    releaseBuildType.proguardFiles.add(flutterProguardRules)
    // plus android/app/proguard-rules.pro if it exists
}
```

`shouldShrinkResources` возвращает true, если только Gradle-свойство `shrink` не выставлено явно в false, а флаг командной строки `--shrink` сегодня является задокументированной пустышкой: его текст справки гласит "This flag has no effect. Code shrinking is always enabled in release builds." Так что да, R8 работает над вашей release-сборкой независимо от того, что написано в `build.gradle.kts`.

При этом R8 всё равно не самый вероятный виновник, потому что `firebase-auth` поставляет consumer-правила, которые AGP применяет автоматически. Весь `proguard.txt` внутри AAR 24.2.0 выглядит так:

```proguard
-keepclassmembers class * extends com.google.android.gms.internal.firebase-auth-api.zzalt {
  <fields>;
}
-dontwarn rx.**
-dontwarn android.crypto.hpke.**
```

Используйте шаг 4, а не добавляйте умозрительные правила вроде `-keep class com.google.firebase.** { *; }`. Общее правило keep скрывает вопрос вместо того, чтобы на него ответить, и если отчёт об использовании покажет, что из `com.google.firebase.auth` ничего не удалено, эта ветка исключена окончательно.

## Причина 3: обновление отклоняется, и только в release

При холодном старте SDK восстанавливает пользователя с диска, а затем обновляет ID-токен, живущий один час, обращаясь к `securetoken.googleapis.com`. Транспортный сбой и отказ SDK обрабатывает по-разному. Транспортный сбой оставляет сохранённого пользователя на месте, поэтому устройство без связи остаётся авторизованным. Отказ с окончательным кодом из таблицы ошибок SDK, например `TOKEN_EXPIRED`, `USER_DISABLED` и `USER_NOT_FOUND`, стирает сохранённого пользователя и вызывает слушатель состояния аутентификации со значением null. Именно поэтому симптом это чистый выход из аккаунта, а не зависание.

Две конфигурации превращают работающее обновление в отклонённое только для release-сборок.

**Ограничения ключа API, привязанные к отладочному сертификату.** Если ключ API Firebase несёт ограничение приложения типа Android apps, каждый запрос должен предъявлять имя пакета и SHA-1-отпечаток сертификата, присутствующие в списке. Ключ, ограниченный SHA-1 отладочного keystore, прекрасно работает при `flutter run` и возвращает `403 PERMISSION_DENIED` с "Requests from this Android client application are blocked", как только приложение подписывается для release. Есть и второй, более неприятный вариант этого. Firebase документирует, что Authentication требует двух API в списке разрешённых API ключа: Identity Toolkit API (`identitytoolkit.googleapis.com`) и Token Service API (`securetoken.googleapis.com`). Разрешите только первый, и вы получите ровно описанную картину: вход проходит, а обновление при следующем запуске нет.

**Принудительная проверка App Check.** Если App Check применяется к Authentication, клиент обязан приложить токен аттестации. Обычная настройка во Flutter переключает провайдера по режиму сборки:

```dart
// firebase_app_check, called after Firebase.initializeApp()
await FirebaseAppCheck.instance.activate(
  androidProvider: kDebugMode ? AndroidProvider.debug : AndroidProvider.playIntegrity,
);
```

Отладочный провайдер регистрируется вручную в консоли Firebase и у вас работает всегда. Play Integrity требует SHA-256-отпечаток сертификата, которым установленное приложение подписано на самом деле, а при использовании Play App Signing это ключ Google, а не ваш ключ загрузки. Пропустите его, и App Check упадёт только в продакшене. Firebase также отмечает, что сборки, распространяемые не через Google Play, не могут получить вердикт `PLAY_RECOGNIZED`, поэтому release-APK для внутреннего распространения требует ослабления соответствующей расширенной настройки, иначе аттестация провалится на совершенно исправном устройстве.

Обе проблемы связаны с отпечатками, и одна и та же ловушка срабатывает дважды: `flutter run --release` подписывает отладочной конфигурацией, потому что собственный шаблон Flutter делает это намеренно. Комментарий в сгенерированном `android/app/build.gradle.kts` так и говорит: "Signing with the debug keys for now, so `flutter run --release` works." Release-сборка, которая работает с вашей машины и падает из Play, это различие отпечатков, а не различие режимов сборки.

## Причина 4: выход выполняет ваш собственный код

Когда хранилище, конфигурация и отпечатки проверены, остаётся только один вариант: это сделало само приложение. Обычная форма это стартовый вызов, обменивающий ID-токен Firebase на сессию в вашем собственном бэкенде:

```dart
// The bug: any failure is treated as an invalid session.
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} catch (_) {
  await FirebaseAuth.instance.signOut(); // wipes a perfectly good session
}
```

В debug этот блок catch не выполняется никогда. В release туда попадает отказ App Check или ключа API, и ваш собственный код выводит пользователя из аккаунта, что затем закрепляется, потому что при следующем запуске хранилище действительно пусто. Разделяйте случаи по коду ошибки:

```dart
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} on FirebaseAuthException catch (e) {
  const fatal = {'user-token-expired', 'user-disabled', 'user-not-found', 'invalid-user-token'};
  if (fatal.contains(e.code)) {
    await FirebaseAuth.instance.signOut();
  } else {
    // network-request-failed, too-many-requests, and anything unexpected:
    // keep the session and retry later.
  }
}
```

Защита этого пути также означает, что вы не уходите с экрана-оболочки, пока асинхронный вызов ещё в полёте, а это та же дисциплина, что и [отмена подписок на потоки в dispose](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Ловушки, которые похожи на это, но таковыми не являются

**Ответ про отсутствующее разрешение INTERNET для Firebase Auth неверен.** Шаблон `src/main/AndroidManifest.xml` во Flutter не объявляет никаких разрешений, тогда как сгенерированные манифесты в `src/debug/` и `src/profile/` оба объявляют `android.permission.INTERNET` с комментарием, что инструменту оно нужно для hot reload. Это действительно ломает обычные вызовы через `http` или `dio` в release-сборках. Firebase Auth это не ломает, потому что манифест библиотеки `firebase-auth` 24.2.0 объявляет разрешение сам, и сборщик манифестов вносит его в ваш APK:

```xml
<!-- com.google.firebase:firebase-auth:24.2.0, AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

Проверьте это для своей сборки, а не доверяйте ни одному из утверждений: `build/app/outputs/logs/manifest-merger-release-report.txt` фиксирует, какая библиотека внесла каждый узел.

**Android Auto Backup может подсунуть устройству устаревшую сессию.** `android:allowBackup` по умолчанию равно true, а файлы `SharedPreferences` включаются в резервную копию, поэтому хранилище аутентификации путешествует через облачный бэкап и перенос между устройствами. Ни шаблон Flutter, ни манифест `firebase-auth` его не исключают. Если ваши обращения группируются вокруг новых устройств, восстановленных из резервной копии, исключите его явно:

```xml
<!-- android/app/src/main/res/xml/data_extraction_rules.xml, API 31+ -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="sharedpref" />
  </device-transfer>
</data-extraction-rules>
```

**Удаление приложения очищает хранилище, и очистка данных приложения тоже.** Firebase документирует это как единственный поддерживаемый способ стереть нативную персистентность. Тестировщик, ставящий свежий APK поверх удаления, ваш баг не воспроизводит.

## Связанные материалы

Если вы разбираетесь с проблемами release-сборок под Android и Firebase во Flutter-приложении, эти материалы покрывают соседние сбои: [миграция на синглтон `google_sign_in` 7.x](/ru/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), меняющая способ получения учётных данных перед их передачей в Firebase Auth, [проблема порядка получения токена APNs](/ru/2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios/), дающая на iOS ту же картину "работает в debug, молчит в release", [отклонение из-за размера страницы памяти 16 КБ](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), блокирующее саму загрузку релиза, и [изменение вёрстки edge-to-edge после перехода на SDK 35](/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/), приходящее в том же окне обновления.

## Источники

- [Get Started with Firebase Authentication on Flutter](https://firebase.google.com/docs/auth/flutter/start) - утверждение о том, что нативная персистентность не настраивается, и разница между `authStateChanges`, `idTokenChanges` и `userChanges`.
- [Learn about and manage API keys for Firebase](https://firebase.google.com/docs/projects/api-keys) - Authentication требует и Identity Toolkit API, и Token Service API в списке разрешённых для ключа API.
- [Get started using App Check with Play Integrity on Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider) - требование зарегистрировать SHA-256 и оговорка про `PLAY_RECOGNIZED` для сборок, распространяемых вне Google Play.
- [flutterfire issue #12727](https://github.com/firebase/flutterfire/issues/12727) - ошибка 403 "Requests from this Android client application are blocked", которую порождают ограничения Android-приложений на ключе API.
- `com.google.firebase:firebase-auth:24.2.0` - `com/google/firebase/auth/internal/zzce` для имени хранилища `SharedPreferences`, `com/google/firebase/auth/internal/zzaq` для таблицы серверных кодов ошибок, а также вложенные `proguard.txt` и `AndroidManifest.xml`.
- `firebase_auth` 6.6.1 - `android/.../FlutterFirebaseAuthPlugin.kt` для `getPluginConstantsForFirebaseApp` и `firebase_auth_platform_interface` `method_channel_firebase_auth.dart` для потоков, повторно выдающих `currentUser`.
- Flutter SDK 3.44.8 - `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt` для значений по умолчанию при сокращении в release, `runner/flutter_command.dart` для флага-пустышки `--shrink`, а также шаблоны манифеста и Gradle в `android.tmpl`.
