---
title: "Исправление: PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10) при Google Sign-In во Flutter"
description: "ApiException: 10 означает DEVELOPER_ERROR: Google не узнаёт пару из имени пакета и SHA-1 сертификата подписи установленного APK. Зарегистрируйте SHA-1 ключа, которым действительно подписана сборка, и передайте Web client ID как serverClientId."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "google-sign-in"
  - "firebase"
lang: "ru"
translationOf: "2026/10/fix-platformexception-sign-in-failed-apiexception-10-google-sign-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`ApiException: 10` это `CommonStatusCodes.DEVELOPER_ERROR`: Google Play services отклонили вход, потому что пара "имя пакета Android + SHA-1 сертификата, которым подписан установленный APK" не совпадает ни с одним Android OAuth-клиентом в проекте Google Cloud, стоящем за вашим `serverClientId`. Ваш Dart-код в порядке. Выполните `./gradlew signingReport` (или `apksigner verify --print-certs` для именно того APK, который вы установили), зарегистрируйте этот SHA-1 для именно этого `applicationId` и добавьте SHA-1 ключа Play App Signing для сборок из магазина. Затем проверьте, что `serverClientId` это идентификатор **Web**-клиента, а не Android-клиента. Проверено на `google_sign_in` 6.3.0 (`google_sign_in_android` 6.2.1) и `google_sign_in` 7.2.0 (`google_sign_in_android` 7.2.18, `play-services-auth` 21.6.0, `androidx.credentials` 1.6.0) на Flutter 3.44.8 с AGP 9.0.1.

## Полный текст ошибки

В `google_sign_in` 6.x `GoogleSignIn().signIn()` бросает на Android следующее:

```
PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10: , null, null)
```

В `google_sign_in` 7.x та же неверная конфигурация уже не приходит к вам как `PlatformException`. Android-плагин 7.x возвращает сбои как структурированные результаты, а Dart-сторона превращает их в `GoogleSignInException`. В зависимости от того, на каком шаге происходит сбой, вы увидите одно из этого:

```
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, [28444] Developer console is not set up correctly., null)
GoogleSignInException(code GoogleSignInExceptionCode.canceled, ...)
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, Authorization failed: 10: ..., null)
```

Первое приходит из Credential Manager во время `authenticate()`. Второе самое неприятное: в README плагина прямо предупреждают, что некоторые ошибки конфигурации заставляют Credential Manager вернуть "canceled" после того, как пользователь выбрал аккаунт, а плагин не может отличить это от настоящей отмены. Третье приходит из `authorizationClient.authorizeScopes()`, который по-прежнему идёт через `AuthorizationClient` из Play services и выдаёт тот же код статуса 10. Если вы перешли с 6.x на 7.x и ошибка "изменилась", скорее всего, вы ничего не исправили: первопричина та же, просто сообщается она иначе.

## Почему Google возвращает DEVELOPER_ERROR

Эти числа это константы в Play services, а не магия. Я выгрузил их из jar-файлов, которые Gradle разрешил для этого воспроизведения:

```bash
# play-services-basement 18.1.0, play-services-auth 21.6.0
javap -constants -cp classes.jar com.google.android.gms.common.api.CommonStatusCodes
#   public static final int DEVELOPER_ERROR = 10;
javap -constants -cp classes.jar com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
#   public static final int SIGN_IN_FAILED = 12500;
#   public static final int SIGN_IN_CANCELLED = 12501;
```

В `google_sign_in_android` 6.2.1 функция `errorCodeForStatus` сопоставляет 12501 с `sign_in_canceled`, 4 с `sign_in_required`, 7 с `network_error`, а всё остальное, включая 10, пропускает в `sign_in_failed` с `e.toString()` в качестве сообщения. Поэтому строка, по которой вы ищете, всегда содержит полное имя класса `ApiException`.

Что DEVELOPER_ERROR означает на практике: Google идентифицирует Android-приложение по имени пакета и отпечатку SHA-1 его сертификата подписи, как описано в руководстве Google [Authenticating Your Client](https://developers.google.com/android/guides/client-auth). Когда приложение запрашивает ID-токен для Web client ID, Google ищет Android OAuth-клиент в **том же проекте** с этим именем пакета и этим отпечатком. Нет совпадения, значит ошибка 10. В порядке частоты, с которой я их встречаю, причины такие:

1. **SHA-1 ключа, которым подписана эта сборка, не зарегистрирован.** Обычно это release-ключ или ключ Play App Signing, иногда debug-ключ на другой машине или на CI.
2. **Имя пакета не совпадает.** Flavor с `applicationIdSuffix` устанавливает `com.example.app.dev`, а зарегистрирован только `com.example.app`.
3. **В качестве `serverClientId` передан не тот client ID.** Android client ID вместо Web или Web-клиент из другого проекта Google Cloud.
4. **Устаревший `google-services.json`** без записи о Web OAuth-клиенте, из-за чего плагин не находит ничего или берёт не тот `default_web_client_id`.

## Минимальное воспроизведение

Самая маленькая конфигурация, которая даёт эту ошибку, это корректная Dart-сторона и проект Google Cloud, который не знает ключ подписи. Это код для 7.x. Здесь нет ничего неверного, в этом и суть:

```dart
// Flutter 3.44.8, google_sign_in 7.2.0 (google_sign_in_android 7.2.18)
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

// Web OAuth client ID (client_type 3), NOT the Android one.
const String kWebClientId = '1234567890-abc.apps.googleusercontent.com';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await GoogleSignIn.instance.initialize(serverClientId: kWebClientId);
  runApp(const MaterialApp(home: SignInPage()));
}

class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  Future<void> _signIn() async {
    try {
      final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
      debugPrint('Signed in as ${user.email}');
    } on GoogleSignInException catch (e) {
      // e.code is a GoogleSignInExceptionCode, e.description holds the
      // platform message, for example "[28444] Developer console is not set up correctly".
      debugPrint('Google Sign-In failed: ${e.code.name} / ${e.description}');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: FilledButton(onPressed: _signIn, child: const Text('Sign in')),
        ),
      );
}
```

Проект вокруг это стандартный шаблон `flutter create` с одним изменением, которое есть у большинства реальных приложений: flavor `dev` с `applicationIdSuffix = ".dev"` и release-сборка, подписанная upload-хранилищем ключей. Зарегистрируйте только debug SHA-1 для базового пакета, и каждый вариант, кроме `prodDebug`, упадёт с ошибкой 10. Для этой статьи я не выполнял живой вход в проект Google Cloud (для этого нужен настоящий аккаунт на устройстве с Play); вывод сборки, подписи и имени пакета ниже измерен на именно этом проекте.

## Исправление 1: зарегистрируйте SHA-1 ключа, которым действительно подписана сборка

Не гадайте, что это за ключ. Спросите у Gradle. Из папки `android/` проекта Flutter:

```bash
# Flutter 3.44.8, AGP 9.0.1, OpenJDK 17
cd android
./gradlew signingReport
```

В выводе перечислены все варианты с их хранилищами ключей и отпечатками. На проекте воспроизведения, в сокращённом виде:

```
Variant: devDebug
Config: debug
Store: /Users/<you>/.android/debug.keystore
SHA1: <debug-sha1>
Variant: devRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
Variant: prodRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
```

Из этого стоит вынести две вещи. Во-первых, debug и release это разные ключи, поэтому нужны два отпечатка. Во-вторых, debug-хранилище лежит в `~/.android/debug.keystore` на **каждой машине**. Ноутбук вашего коллеги и ваш CI-раннер генерируют собственное хранилище при первой сборке, с другими отпечатками. "У меня работает, а у тебя ошибка 10" это именно такой случай.

Затем добавьте отпечаток там, где управляется ваш проект:

- **Firebase**: Project settings, Your apps, выберите Android-приложение, Add fingerprint. Firebase сам создаёт соответствующий Android OAuth-клиент в нижележащем проекте Google Cloud.
- **Только Google Cloud**: Google Auth Platform, Clients, Create client, тип Android, введите имя пакета и SHA-1. Один Android-клиент на каждую пару (имя пакета, SHA-1).

Если вам нужен отпечаток уже имеющейся сборки, читайте его из артефакта, а не из хранилища, которое, по вашему мнению, использовалось. Для APK используйте `apksigner` из Android build-tools:

```bash
# Android build-tools 36.1.0
apksigner verify --print-certs build/app/outputs/flutter-apk/app-dev-release.apk
# Signer #1 certificate DN: CN=Repro
# Signer #1 certificate SHA-256 digest: af3cbfe5...cc071a0a
# Signer #1 certificate SHA-1 digest: 16af74412946e25b13bba5a429c5ccd8368306e9
```

Не используйте `keytool -printcert -jarfile` для APK Flutter. На этом проекте он печатает `Not a signed jar file`, потому что `minSdk` в шаблоне равен 24, и AGP подписывает только схемой APK Signature Scheme v2 (`apksigner verify -v` сообщает `Verified using v1 scheme (JAR signing): false`). `keytool -printcert -jarfile` работает с `.aab`, который подписан как jar ключом upload.

### Сборки из магазина: добавьте и ключ Play App Signing

Это причина большинства сообщений вида "в моём release APK работает, а при установке из Google Play нет". При Play App Signing, который обязателен для новых приложений, Google снимает вашу upload-подпись и заново подписывает доставляемые APK своим ключом подписи приложения. SHA-1, который предъявляют устройства ваших пользователей, принадлежит **этому** ключу, которого у вас локально никогда не было. Скопируйте его из Play Console, раздел Test and release, App integrity, App signing, "App signing key certificate", и зарегистрируйте рядом с upload-ключом. Треки внутреннего тестирования переподписываются так же, поэтому они выявят проблему раньше, чем production.

Стандартный шаблон Flutter усугубляет ситуацию: его тип сборки `release` подписывается debug-ключом ("Signing with the debug keys for now, so `flutter run --release` works"). Release-сборка, которая локально работает, вполне может оказаться сборкой, подписанной debug-ключом, а это ничего не доказывает про ключ, который будет использовать Play.

## Исправление 2: зарегистрируйте имя пакета, которое действительно установлено

`signingReport` не печатает имена пакетов. Прочитайте установленное имя из APK:

```bash
# Android build-tools 36.1.0
aapt2 dump badging build/app/outputs/flutter-apk/app-dev-release.apk | head -1
# package: name='net.startdebugging.gsiapp.dev' versionCode='1' versionName='0.1.0' ...
```

`applicationIdSuffix` у flavor `dev` превратил `net.startdebugging.gsiapp` в `net.startdebugging.gsiapp.dev`, а это с точки зрения Google другое приложение. Каждому flavor нужен собственный Android OAuth-клиент (Firebase: собственное Android-приложение со своим `google-services.json` в `android/app/src/<flavor>/`). Обратите внимание, что `namespace` в `build.gradle.kts` здесь не играет роли: устройство сообщает только `applicationId` (плюс суффиксы). Если flavor для вас в новинку, в статье [что такое flavor во Flutter и чем он отличается от режима сборки](/ru/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/) объясняется, где появляется `applicationIdSuffix`.

## Исправление 3: передайте Web client ID как serverClientId

ID-токен выпускается для вашего **сервера**, поэтому client ID, который вы передаёте плагину, это клиент типа Web application (Firebase называет его `client_type: 3` в `google-services.json`). Android-клиент в коде никогда не передаётся, Google находит его по имени пакета и SHA-1. Если передать Android client ID как `serverClientId` или Web-клиент из другого проекта, вы получите ту же ошибку 10.

```dart
// google_sign_in 7.2.0
await GoogleSignIn.instance.initialize(
  // From Google Auth Platform > Clients, type "Web application",
  // in the SAME project as the Android client.
  serverClientId: '1234567890-web.apps.googleusercontent.com',
);
```

```dart
// google_sign_in 6.3.0 (legacy API)
final googleSignIn = GoogleSignIn(
  serverClientId: '1234567890-web.apps.googleusercontent.com',
  scopes: ['email'],
);
```

Если опустить `serverClientId`, обе версии плагина обращаются к строковому ресурсу `default_web_client_id`, который Gradle-плагин `google-services` генерирует из `google-services.json`. В 7.x, если и этого ресурса нет, вы получите другую, явную ошибку: `GoogleSignInExceptionCode.clientConfigurationError` с сообщением "serverClientId must be provided on Android". Если вы это видите, в вашем `google-services.json` нет записи `oauth_client` с `client_type: 3`. Включите Google как провайдер входа в Firebase (или добавьте в проект веб-приложение) и скачайте файл заново.

## Исправление 4: заново скачайте google-services.json и подождите

После добавления отпечатков в Firebase скачайте `google-services.json` ещё раз и замените `android/app/google-services.json`. Строго говоря, Android-клиент сопоставляется на стороне сервера, поэтому файл в основном важен для `default_web_client_id`, но файл, скачанный до изменения, часто становится источником устаревшей или отсутствующей записи Web-клиента. Затем выполните `flutter clean`, чтобы сгенерированные ресурсы пересобрались. Изменения в Google Cloud тоже применяются не всегда мгновенно; дайте только что добавленному отпечатку несколько минут (сообщения о том, что это занимает больше времени, встречаются часто), прежде чем делать вывод, что это не помогло.

## Подводные камни и похожие ошибки

**`ApiException: 12500` это другая ошибка.** 12500 это `SIGN_IN_FAILED`. Она появляется при проблемах вроде незаполненного экрана согласия OAuth (нет почты поддержки, названия приложения), а не из-за неизвестного пакета и отпечатка. Сначала исправьте конфигурацию экрана согласия.

**`ApiException: 12501` это отмена**, и плагин 6.x сопоставляет её с `sign_in_canceled`. Если пользователь на самом деле ничего не отменял, снова посмотрите на конфигурацию, особенно в 7.x, где Credential Manager может выдать неверную конфигурацию за отмену.

**`ApiException: 7` это сетевая ошибка** (`network_error` в 6.x). Её дают эмуляторы без подключения, а не неверная конфигурация.

**На устройстве нет аккаунта.** В 7.x эмулятор без выполненного входа в аккаунт Google или с отключёнными в настройках аккаунта Google запросами "Sign in with Google" выдаёт `NoCredentialException`, о котором плагин сообщает как "No credential available". Это состояние устройства, а не ошибка 10. Используйте образ эмулятора с Google Play.

**Переход на 7.x не отменяет требование к SHA.** Credential Manager использует тот же поиск Android OAuth-клиента. Если вы посреди миграции и застряли на изменении конструктора, [статья о миграции на синглтон GoogleSignIn](/ru/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) разбирает сторону API.

**Firebase Auth сверху.** Если вы передаёте ID-токен Google в `FirebaseAuth.signInWithCredential`, то при корректной конфигурации Google всё равно остаются проблемы release-сборки на стороне Firebase, например ограничения API-ключа, привязанные к debug SHA-1. Они разобраны в статье [вход через Firebase Auth, который не сохраняется в release-сборке](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

**Сбои только в release могут быть несвязанными.** Если release-сборка падает ещё до входа, это другая проблема, см. [исправление "Could not create Dart VM instance" в release-сборке](/ru/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Чек-лист, который всё решает

1. Соберите именно тот вариант, который падает, и выполните `apksigner verify --print-certs` и `aapt2 dump badging` для этого APK.
2. В проекте Google Cloud, которому принадлежит ваш Web client ID, убедитесь, что есть Android-клиент ровно с этим именем пакета и SHA-1.
3. Для сборок, установленных из Play, добавьте SHA-1 сертификата App signing key из Play Console.
4. Убедитесь, что `serverClientId` (или `default_web_client_id`) это Web-клиент того же проекта.
5. Заново скачайте `google-services.json`, выполните `flutter clean`, пересоберите и дайте Google несколько минут.

Если все пять пунктов в порядке, а ошибка 10 остаётся, вы почти наверняка смотрите на другой проект, чем тот, из которого запрашивается токен. Сравните числовой префикс Web client ID с номером проекта в консоли.

## Связанные материалы

- [Fix: The class 'GoogleSignIn' doesn't have an unnamed constructor](/ru/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [What is a Flutter flavor and how is it different from a build mode?](/ru/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)
- [Fix: Could not create Dart VM instance in a Flutter release build](/ru/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)

## Источники

- [google_sign_in_android README: Integration and Troubleshooting](https://pub.dev/packages/google_sign_in_android)
- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in)
- [Authenticating Your Client (SHA-1 fingerprints, signingReport)](https://developers.google.com/android/guides/client-auth)
- [CommonStatusCodes reference](https://developers.google.com/android/reference/com/google/android/gms/common/api/CommonStatusCodes)
- [Credential Manager troubleshooting guide](https://developer.android.com/identity/sign-in/credential-manager-troubleshooting-guide)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [FlutterFire discussion #18477: ApiException 10 only in the Google Play version](https://github.com/firebase/flutterfire/discussions/18477)
