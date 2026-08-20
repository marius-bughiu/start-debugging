---
title: "Решение: The class 'GoogleSignIn' doesn't have an unnamed constructor"
description: "В google_sign_in 7.0.0 класс GoogleSignIn стал синглтоном. Замените GoogleSignIn(scopes: ...) на GoogleSignIn.instance, один раз дождитесь initialize() и вызывайте authenticate()."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "google-sign-in"
  - "firebase"
lang: "ru"
translationOf: "2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-20
---

В `google_sign_in` 7.0.0 (опубликован 2025-06-24) класс `GoogleSignIn` стал синглтоном, поэтому вызов `GoogleSignIn(...)` больше не компилируется. Используйте `GoogleSignIn.instance`, ровно один раз при запуске дождитесь нового метода `initialize()` и вызывайте `authenticate()` вместо `signIn()`. У аргумента `scopes:`, который раньше передавали в конструктор, прямой замены нет: авторизация теперь отдельный шаг через `user.authorizationClient`. Автоматической миграции не существует, так что заложите реальное время на реальное приложение.

## Полный текст ошибки

Анализатор выдаёт это для любого `pubspec.yaml`, который разрешается в `google_sign_in` 7.x, на любой платформе:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor. Try using one
        of the named constructors defined in 'GoogleSignIn' - lib\auth.dart:5:36 -
        new_with_undefined_constructor_default
```

Подсказка ведёт в тупик. Единственный именованный конструктор класса это `GoogleSignIn._()`, он приватный внутри пакета, и вызвать вам его нечем. Диагностика приходит из общего правила анализатора про отсутствие конструктора по умолчанию и ничего не знает о том, что пакет предлагает идти через статическое поле.

Она никогда не приходит одна. Запуск `flutter analyze` для типичного файла входа из 6.x против `google_sign_in` 7.2.0 на Flutter 3.44.2 даёт полный каскад:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor
error - The method 'signIn' isn't defined for the type 'GoogleSignIn'
error - The method 'isSignedIn' isn't defined for the type 'GoogleSignIn'
error - The method 'signInSilently' isn't defined for the type 'GoogleSignIn'
error - The getter 'accessToken' isn't defined for the type 'GoogleSignInAuthentication'
 info - Uses 'await' on an instance of 'GoogleSignInAuthentication', which is not a
        subtype of 'Future'
```

Последнюю строку с `info` стоит прочитать внимательно. `GoogleSignInAccount.authentication` теперь синхронный геттер, поэтому каждый `await account.authentication` в вашем коде не делает ничего, а анализатор помечает это лишь как замечание стиля, а не как ошибку.

## Почему конструктор исчез в google_sign_in 7.0.0

API версии 6.x был обёрткой на Dart над SDK Google Sign-In, который Google объявил устаревшим и на Android, и в вебе. На Android замена это Credential Manager вместе с `AuthorizationClient`, и Google [предупреждает разработчиков с сентября 2024 года](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), что старые API входа из `play-services-auth` будут удалены. У этих SDK принципиально другая форма, поэтому вместе с ними изменилась и поверхность плагина для Flutter.

Три из этих изменений объясняют почти все ошибки компиляции, с которыми вы столкнётесь.

Плагин больше не описывает объект, который вы настраиваете, а потом используете. Нижележащие SDK работают на уровне процесса, и создание двух объектов `GoogleSignIn` в 6.x на самом деле никогда корректно не работало. Руководство по миграции формулирует это прямо: превращение класса в синглтон лишь закрепляет уже существовавшее ограничение.

Конфигурация переехала из конструктора в явный асинхронный вызов `initialize()`. В вебе у этого вызова есть реальная работа, и он может занять заметное время, чего конструктор выразить не может.

Аутентификация и авторизация теперь разделены. В 6.x вызов `GoogleSignIn(scopes: [...])` объединял вопрос о том, кто этот пользователь, с запросом на чтение его контактов в одном окне согласия. В 7.x вы сначала проходите аутентификацию, а scopes запрашиваете в тот момент, когда данные действительно нужны.

## Минимальное воспроизведение: код 6.x, который перестаёт компилироваться

```dart
// Flutter 3.44.2, Dart 3.12.2, google_sign_in 7.2.0
// Every line of this compiled fine on google_sign_in 6.3.0.
import 'package:google_sign_in/google_sign_in.dart';

final GoogleSignIn _googleSignIn = GoogleSignIn(
  scopes: <String>['email', 'https://www.googleapis.com/auth/contacts.readonly'],
);

Future<void> signIn() async {
  final GoogleSignInAccount? account = await _googleSignIn.signIn();
  if (account == null) return;
  final GoogleSignInAuthentication auth = await account.authentication;
  print(auth.accessToken);
  print(auth.idToken);
}
```

Не рассчитывайте здесь на `dart fix`. Запуск `dart fix --dry-run` для этого файла с установленным `google_sign_in` 7.2.0 сообщает `Nothing to fix!`, потому что пакет не поставляет слоёв совместимости для удалённых членов. Каждое место вызова придётся править вручную.

## Как заменить GoogleSignIn(...) на синглтон

Вызовите `initialize()` один раз, до того как плагина коснётся что-либо ещё. В приложении на Flutter это `main()` или единоразовая инициализация, а не `initState` экрана входа, который может оказаться в стеке дважды.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await GoogleSignIn.instance.initialize(
    // Both are optional. Omit them if your Info.plist GIDClientID or your
    // google-services.json already supplies the values.
    clientId: 'IOS_OR_WEB_CLIENT_ID.apps.googleusercontent.com',
    serverClientId: 'SERVER_CLIENT_ID.apps.googleusercontent.com',
  );

  runApp(const MyApp());
}
```

`initialize()` принимает `clientId`, `serverClientId`, `nonce` и `hostedDomain`. Переданные здесь значения имеют приоритет над теми, что лежат в файлах конфигурации платформы. Параметра `scopes` нет, как нет и `signInOption`: значение `SignInOption.games` полностью удалено из платформенного интерфейса.

Интерактивный вызов входа выглядит так:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> onSignInPressed() async {
  if (!GoogleSignIn.instance.supportsAuthenticate()) {
    return; // Web. See the renderButton section below.
  }
  try {
    final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
    final String? idToken = user.authentication.idToken; // no await
  } on GoogleSignInException catch (e) {
    if (e.code == GoogleSignInExceptionCode.canceled) return;
    debugPrint('${e.code}: ${e.description}');
  }
}
```

Важны два различия на уровне типов. `authenticate()` возвращает `GoogleSignInAccount`, не допускающий null, поэтому проверка `if (account == null)` из 6.x превращается в мёртвый код. И отмена теперь приходит исключением, а не значением null: если пользователь отказался, бросается `GoogleSignInException` с `code`, равным `GoogleSignInExceptionCode.canceled`. Если убрать старую проверку на null и забыть про try/catch, каждая отменённая попытка входа станет необработанным исключением в ваших журналах.

В `GoogleSignInExceptionCode` есть также `interrupted`, `clientConfigurationError`, `providerConfigurationError`, `uiUnavailable`, `userMismatch` и `unknownError`. В 7.0.0 его случайно не экспортировали и вернули в 7.1.0, так что требуйте минимум 7.1.0, если хотите делать по нему switch.

## Что заменяет signIn, signInSilently и currentUser

Каждый удалённый член и его эквивалент в 7.x, сверено с `google_sign_in` 7.2.0:

| google_sign_in 6.x | google_sign_in 7.x |
| --- | --- |
| `GoogleSignIn(...)` | `GoogleSignIn.instance` плюс `await initialize(...)` |
| `signIn()` | `authenticate({scopeHint})` |
| `signInSilently()` | `attemptLightweightAuthentication()` |
| `isSignedIn()` | отслеживайте сами по `authenticationEvents` |
| `currentUser` | отслеживайте сами по `authenticationEvents` |
| `onCurrentUserChanged` | `authenticationEvents` |
| `canAccessScopes(scopes)` | `authorizationClient.authorizationForScopes(scopes)` |
| `requestScopes(scopes)` | `authorizationClient.authorizeScopes(scopes)` |
| `account.authHeaders` | `authorizationClient.authorizationHeaders(scopes)` |
| `account.serverAuthCode` | `authorizationClient.authorizeServer(scopes)` |
| `clearAuthCache(token:)` | `clearAuthorizationToken(accessToken:)`, добавлен в 7.2.0 |
| `signOut()`, `disconnect()` | без изменений |

Двух выживших стоит отметить отдельно: `signOut()` и `disconnect()` сохранили имена и сигнатуры, и именно поэтому недоделанная миграция может компилироваться в одном файле и падать в следующем.

У метода `attemptLightweightAuthentication()` тип возвращаемого значения выглядит опечаткой, но ей не является. Это `Future<GoogleSignInAccount?>?`, то есть future, допускающий null. Null вместо future означает, что платформа не может ответить быстро (пакет приводит в пример веб с FedCM), и тогда следует отрисовать интерфейс для неавторизованного состояния и ждать `authenticationEvents`, а не ждать чего-либо через await.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
final Future<GoogleSignInAccount?>? attempt =
    GoogleSignIn.instance.attemptLightweightAuthentication();
if (attempt != null) {
  final GoogleSignInAccount? user = await attempt;
}
```

Обратите внимание и на то, что "облегчённый" не означает "беззвучный". Переименование сделано намеренно: в вебе может появиться плавающая карточка входа, а на Android лист выбора аккаунта. По умолчанию вызов проглатывает `canceled`, `interrupted` и `uiUnavailable` и возвращает для них null; передайте `reportAllExceptions: true`, если хотите получать их исключениями.

## Куда делся аргумент scopes

Он переехал во второй, отдельный шаг. `GoogleSignInAccount` предоставляет `authorizationClient`, и теперь токены доступа живут именно там. Рекомендуемая форма такая: сначала попробовать уже выданное разрешение и показывать интерфейс только если это не сработало.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
const List<String> scopes = <String>[
  'https://www.googleapis.com/auth/contacts.readonly',
];

Future<String> accessTokenFor(GoogleSignInAccount user) async {
  // Returns null instead of prompting if the scopes are not yet granted.
  final GoogleSignInClientAuthorization? existing =
      await user.authorizationClient.authorizationForScopes(scopes);
  if (existing != null) return existing.accessToken;

  // Shows consent UI. Call it from a button press, not from initState.
  final GoogleSignInClientAuthorization granted =
      await user.authorizationClient.authorizeScopes(scopes);
  return granted.accessToken;
}
```

Оба метода приходят в одну и ту же точку входа платформы с одним переключённым флагом. Прогон этого сценария против поддельного `GoogleSignInPlatform` в тесте фиксирует ровно такую последовательность вызовов:

```
init
authenticate scopeHint=[]
clientAuth prompt=false     <- authorizationForScopes
clientAuth prompt=true      <- authorizeScopes
```

Если вам нужно прежнее объединённое окно согласия, передайте `scopeHint` в `authenticate()`. Это именно подсказка и не более: платформы, которые не умеют объединять потоки, её игнорируют, и пакет явно предупреждает, что `authorizationForScopes` после этого всё равно может вернуть null. Запасной путь всё равно напишите.

Для обмена с сервером метод `authorizeServer(scopes)` возвращает `GoogleSignInServerAuthorization` с полем `serverAuthCode`. Это отдельный обход, не совпадающий с клиентской авторизацией, и именно он оказывается самым частым сюрпризом для приложений, которые раньше читали `account.serverAuthCode` прямо из результата входа.

## Куда делся authentication.accessToken

Он переехал в другой тип, потому что токен доступа это артефакт авторизации, а `authentication` теперь несёт только артефакты аутентификации. В 7.x у `GoogleSignInAuthentication` ровно одно поле:

```dart
// google_sign_in 7.2.0, lib/src/token_types.dart
class GoogleSignInAuthentication {
  const GoogleSignInAuthentication({required this.idToken});
  final String? idToken;
}
```

Токен доступа переехал в `GoogleSignInClientAuthorization.accessToken`, где он не допускает null, а серверный код авторизации в `GoogleSignInServerAuthorization.serverAuthCode`.

Именно это изменение ломает интеграции с Firebase Auth, и исправление меньше, чем предполагает большинство обсуждений миграции. `GoogleAuthProvider.credential` в `firebase_auth` 6.5.7 объявлен как `credential({String? idToken, String? accessToken})` с assert, требующим хотя бы одно из двух значений. Одного ID-токена достаточно:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0, firebase_auth 6.5.7
Future<UserCredential> signInWithGoogle() async {
  final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();

  final AuthCredential credential = GoogleAuthProvider.credential(
    idToken: user.authentication.idToken,
  );
  return FirebaseAuth.instance.signInWithCredential(credential);
}
```

Не вызывайте `authorizeScopes` только ради получения `accessToken` для этого вызова. Так вы покажете пользователям окно согласия, которое им не нужно, ради scopes, которыми не собираетесь пользоваться.

## Что происходит с authenticate во Flutter web

Он бросает исключение. `google_sign_in_web` 1.1.3 возвращает `false` из `supportsAuthenticate()`, а `authenticate()` выбрасывает:

```
UnimplementedError: authenticate is not supported on the web.
Instead, use renderButton to create a sign-in widget.
```

Google Identity Services требует, чтобы кнопку входа отрисовывал его собственный SDK, поэтому ваш собственный `ElevatedButton` запустить этот поток не может. Ставьте проверку `supportsAuthenticate()`, а в вебе отрисовывайте виджет из `package:google_sign_in_web/web_only.dart` и забирайте результат из `authenticationEvents`. Учтите, что руководство по миграции описывает это как `UnsupportedError`, тогда как реализация на самом деле бросает `UnimplementedError`, так что не сопоставляйте по точному типу.

Смежная ловушка, только для веба: `authorizationRequiresUserInteraction()` там возвращает `true`, потому что поток авторизации использует всплывающее окно, которое браузеры блокируют вне пользовательского жеста. Вызов `authorizeScopes` из `FutureBuilder` или из `initState` работает на мобильных платформах и падает в вебе.

## Можно ли просто зафиксировать google_sign_in 6.x

Ненадолго можно. `google_sign_in: 6.3.0` до сих пор чисто разрешается на Flutter 3.44.2, подтягивая `google_sign_in_android` 6.2.1 и `google_sign_in_ios` 5.9.0. Ничто в текущем стабильном SDK Flutter этому не мешает.

Относитесь к этому как к временной мере, а не как к плану. Android-часть 6.x опирается на устаревшие API входа из `play-services-auth`, про которые [собственная страница миграции Google](https://developer.android.com/identity/sign-in/legacy-gsi-migration) говорит, что они будут удалены. Вы выбираете, когда делать эту миграцию, а не делать ли её вообще.

## Ловушки, которые переживают чистую компиляцию

**Пропущенный `initialize()` тихо убивает поток событий.** Пакет со стороны приложения порождает события в `authenticationEvents` только тогда, когда `initialize()` определил, что у платформенной реализации нет собственного потока событий. Тест с поддельной платформой подтверждает этот сценарий: пройдите аутентификацию без инициализации, и поток останется пустым, никакого исключения не будет. Вход работает, интерфейс не обновляется никогда.

**Вызов `initialize()` более одного раза это неопределённое поведение.** Пакет документирует это именно такими словами. Инициализация, которая перезапускается при пересборке провайдера, попадает ровно в эту ситуацию.

**На Android ошибка конфигурации может прийти как `canceled`.** SDK Credential Manager для части неверных конфигураций возвращает отмену, и плагин не может отличить одно от другого. Если `authenticate()` бросает `canceled` сразу после выбора аккаунта, проверьте SHA подписи для этого варианта сборки и убедитесь, что в вашем `google-services.json` есть запись `oauth_client` с `client_type: 3`.

**Ваша версия Flutter может ограничить Android-реализацию.** Сам `google_sign_in` 7.2.0 требует Flutter 3.29 и Dart 3.7, а `google_sign_in_android` 7.2.16 требует Flutter 3.44 и Dart 3.12. На более старом Flutter pub вместо ошибки разрешит более старый пакет реализации, поэтому версия плагина в `pubspec.lock` рассказывает не всю историю. Это ловушка того же класса, что и [фиксация версии движка Flutter ради воспроизводимых сборок](/ru/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

**Собственный `testing.dart` пакета всё ещё описывает API версии 6.x.** У `FakeSignInBackend` в комментарии документации показаны `GoogleSignIn()` и `setMockMethodCallHandler`. Его не обновили под 7.x, и имена каналов методов больше не совпадают с плагином. Вместо этого напишите поддельный `GoogleSignInPlatform` и присвойте его `GoogleSignInPlatform.instance`.

## Связанные материалы

- Такая же форма обновления встречается при [миграции с Riverpod 2.x на Riverpod 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), где ошибки компиляции это лёгкая часть, а изменения поведения нет.
- Обновление плагина, которое переименовывает значения ошибок, а не API: [biometric_signature 10.0.0 и новые значения BiometricError](/ru/2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x/).
- Вход это длинный асинхронный разрыв, поэтому [защита setState проверкой mounted после асинхронного разрыва](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) напрямую относится к коду, который вы переписываете.
- Если обновление плагина сломало ещё и сборку под iOS, начните с [CocoaPods could not find compatible versions for pod](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- Чтобы приложение оставалось собираемым сразу на нескольких SDK, пока идёт такая миграция, посмотрите [как нацеливаться на несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Источники

- [google_sign_in на pub.dev](https://pub.dev/packages/google_sign_in), версия 7.2.0, опубликована 2025-09-17. Файл `MIGRATION.md` внутри пакета это авторитетное соответствие между 6.x и 7.x.
- [Журнал изменений google_sign_in](https://pub.dev/packages/google_sign_in/changelog), где перечислены ломающие изменения 7.0.0 и исправление экспорта `GoogleSignInExceptionCode` в 7.1.0.
- [google_sign_in_android на pub.dev](https://pub.dev/packages/google_sign_in_android), в README которого описаны требование `serverClientId` и поведение, когда `canceled` означает неверную конфигурацию.
- [About the migration from legacy Google Sign-In](https://developer.android.com/identity/sign-in/legacy-gsi-migration) на Android Developers.
- [Streamlining Android authentication: Credential Manager replaces legacy APIs](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), объявление от сентября 2024 года, стоящее за переписыванием плагина.

Каждая строка ошибки, разрешение версий и последовательность вызовов выше воспроизведены локально на Flutter 3.44.2 с Dart 3.12.2.
