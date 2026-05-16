---
title: "Исправление: provisioning profile не включает текущее выбранное устройство в MAUI iOS"
description: "Профиль, который выбрал Visual Studio, был сгенерирован до регистрации UDID этого iPhone. Перерегистрируйте устройство, пересоздайте профиль разработки, скачайте, разверните заново."
pubDate: 2026-05-16
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "signing"
lang: "ru"
translationOf: "2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios"
translatedBy: "claude"
translationDate: 2026-05-16
---

Исправление: provisioning profile разработки, которым MAUI пытался подписать, не содержит UDID iPhone. Либо профиль был сгенерирован до того, как вы зарегистрировали устройство, либо устройство зарегистрировано под другой командой, чем та, которую использует Visual Studio, либо Bundle ID в вашем csproj не совпадает с App ID, к которому привязан профиль. Добавьте UDID в Apple Developer Account, пересоздайте профиль iOS App Development, чтобы он включал новое устройство, нажмите Download All Profiles в Visual Studio (или `Download Manual Profiles` в Xcode, если вы используете путь через CLI), и разверните заново. Если вы используете автоматическое provisioning, обычно отключение и повторное подключение устройства запускает повторный запуск provisioning в Visual Studio и захват нового UDID.

```text
Could not find any available provisioning profiles for iOS.
error : The provisioning profile doesn't include the currently selected device "iPhone (00008130-001A2C3D0EF8401E)".

error MT1006: Could not install the application 'com.example.app' on the device 'iPhone'.
error : A valid provisioning profile for this executable was not found. (0xe8008015)
```

Это руководство написано для .NET 11 GA, target framework `net11.0-ios`, .NET MAUI 11.0.0, Xcode 16.4 и Visual Studio 17.14 в паре с Mac build host. Та же ошибка и то же исправление без изменений применимы к .NET MAUI 8 и 9; между релизами меняются только ID воркладов (`maui-ios`, `ios`) и минимальная поставляемая версия Xcode. Исключение выбрасывается `mlaunch`, инструментом, который MAUI использует под капотом для отправки `.app` bundle на реальное устройство, после того как `codesign` уже принял бинарь. Сама сборка успешна. Отказывает шаг установки.

## Почему MAUI iOS связывает профили с UDID устройств

Модель подписи кода iOS у Apple имеет три подвижные части: сертификат подписи (вашу идентичность разработчика), App ID (bundle identifier, к которому привязан профиль) и provisioning profile (подписанный blob, который связывает сертификат, App ID, команду и список разрешённых UDID устройств). Профиль разработки действителен только для устройств, которые Apple записала в него в момент генерации. Подключите новый iPhone, и любой ранее существовавший профиль разработки молча его не покрывает. ОС отклоняет установку с `0xe8008015`, ошибкой MISAgent для "no valid provisioning profile". `mlaunch` от MAUI показывает это как сообщение "provisioning profile doesn't include the currently selected device" и в более старых тулчейнах как более загадочное `MT1006`.

Во время сборки нет никакого предупреждения. `codesign` проверяет только сертификат и App ID профиля; он не инспектирует список устройств. Список устройств применяет `installd` на самом iPhone, поэтому ошибка всегда появляется при развёртывании, никогда при сборке.

Это вызывают три вещи:

1. UDID устройства отсутствует в профиле (самое частое, особенно сразу после подключения нового тестового устройства).
2. Bundle ID в вашем csproj отклонился от App ID, к которому привязан профиль (переименование проекта, смена префикса организации, копирование шаблона).
3. Visual Studio подписывает профилем из другой команды, чем та, которая зарегистрировала устройство (личная команда против команды организации, или устаревший профиль, закэшированный локально).

## Минимальная репродукция

Возьмите любой проект MAUI 11 iOS, установите Bundle Signing в Manual, направьте `CodesignProvision` на профиль разработки, сгенерированный неделю назад, затем подключите сегодня совершенно новый iPhone.

```xml
<!-- .NET 11, .NET MAUI 11.0.0, net11.0-ios -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
  <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
  <CodesignProvision>MyApp Dev Profile</CodesignProvision>
  <CodesignEntitlements>Platforms/iOS/Entitlements.plist</CodesignEntitlements>
</PropertyGroup>
```

Затем:

```bash
# .NET 11.0.100, MAUI workload 11.0.0
dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:udid=00008130-001A2C3D0EF8401E"
```

Сборка успешна. Развёртывание падает с сообщением "устройство не включено", потому что профиль `MyApp Dev Profile` был сгенерирован до того, как `00008130-001A2C3D0EF8401E` стало устройством, которое Apple знает.

## Путь исправления A: автоматическое provisioning, которое устарело

Если ваша схема `iOS Bundle Signing` установлена в **Automatic Provisioning** (рекомендуемое значение по умолчанию для разработки), Visual Studio должен повторно запускать provisioning каждый раз, когда подключается новое устройство, и молча регенерировать профиль, чтобы включить его. Когда этот механизм застревает, читаемая вами ошибка является симптомом.

1. Откройте **Tools > Options > Xamarin > Apple Accounts**, выберите вашу команду, нажмите **View Details**. Убедитесь, что ожидаемая вами команда это та команда, которую использует Visual Studio. Если вы видите две команды (личную команду "Marius Bughiu" и команду организации), у каждой свой пул профилей, и Visual Studio будет авто-provisioning только против команды, текущая привязанной к проекту.
2. Правый клик на проекте, **Properties**, **iOS > Bundle Signing**. Убедитесь, что **Scheme** это **Automatic Provisioning**, **Signing Identity** и **Provisioning Profile** оба установлены в **Automatic**, и **Configure Automatic Provisioning** показывает зелёную галочку. Если диалог сообщает об ошибке, прочитайте её; "Authentication Service Is Unavailable" почти всегда означает, что есть непринятое соглашение в [App Store Connect](https://appstoreconnect.apple.com/) или [Apple Developer](https://developer.apple.com/account).
3. Отсоедините iPhone от Mac build host, подождите две секунды, подключите его обратно. Visual Studio слушает USB-событие и повторно запускает автоматическое provisioning, что регистрирует новый UDID и пересоздаёт профиль разработки. Наблюдайте за панелью **Output > General** в ожидании `Automatic provisioning succeeded` перед повторным развёртыванием.
4. Если вы сменили Mac с момента последней успешной сборки, приватный ключ вашего сертификата подписи, скорее всего, никогда не перенёсся. Visual Studio скажет вам об этом в диалоге Apple Accounts со статусом **Not in Keychain**. Экспортируйте `.p12` из Keychain Access на исходном Mac и импортируйте через **Import Certificate** в диалоге Apple Accounts, затем повторите попытку.

Автоматическое provisioning всё ещё требует, чтобы Mac build host был спарен и доступен. Если `Pair to Mac` показывает жёлтый, USB-событие устройства не распространится, и ваш свежий UDID никогда не регистрируется. Сначала пересоедините.

## Путь исправления B: ручное provisioning, явный путь через csproj

Если вы держите подпись iOS под явным контролем (CI, корпоративная дистрибуция, аккаунт Apple, общий для команды), выполняйте регистрацию и регенерацию вручную.

1. На Mac, **Xcode > Window > Devices and Simulators**, выберите iPhone, скопируйте строку **Identifier**. Это UDID, который проверяет `installd`. Формат `00008130-001A2C3D0EF8401E` для устройства A12+. Не вбивайте; копируйте. UDID это 25 символов с дефисом; один неверный символ, и профиль молча не совпадает.
2. В браузере, [Devices в Apple Developer](https://developer.apple.com/account/resources/devices/list), **+**, выберите платформу **iOS, tvOS, watchOS**, вставьте UDID, дайте запоминающееся имя, **Continue**, **Register**.
3. [Profiles](https://developer.apple.com/account/resources/profiles/list), найдите ваш профиль разработки, **Edit**, отметьте недавно добавленное устройство в списке Devices, **Save**, **Download**. Редактирование профиля пересоздаёт его; имя файла остаётся прежним, содержимое меняется. Apple не пушит новый файл на вашу машину; вам нужно его скачать.
4. Установите пересозданный профиль. На Mac двойной клик на `.mobileprovision` регистрирует его в `~/Library/MobileDevice/Provisioning Profiles/`. На Windows, в Visual Studio перейдите в **Tools > Options > Xamarin > Apple Accounts**, выберите вашу команду, **View Details**, **Download All Profiles**. Профиль синхронизируется и на Windows, и на спаренный Mac.
5. Убедитесь, что ваш csproj указывает на правильный профиль. Строка в `CodesignProvision` должна точно совпадать с **Name** профиля в Apple Developer, не с именем файла, не с UUID:

    ```xml
    <!-- .NET 11, .NET MAUI 11.0.0 -->
    <PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
      <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
      <CodesignProvision>MyApp Dev Profile</CodesignProvision>
    </PropertyGroup>
    ```

    `CodesignKey` это common name сертификата в том виде, как он отображается в Keychain Access в **My Certificates**. `CodesignProvision` это имя профиля, которое вы ввели в шаге 3 рабочего процесса Apple Developer. Оба чувствительны к регистру. См. [CodesignKey](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) и [CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignprovision) для полной схемы.

6. Пересоберите и разверните заново. Если сбой сохраняется, переходите к gotchas ниже; UDID зарегистрирован корректно, значит что-то ещё не так.

## Проверьте, что профиль действительно содержит устройство

Прежде чем разбирать проект, докажите, что профиль правильный. `security` на macOS декодирует CMS-конверт вокруг `.mobileprovision`:

```bash
# macOS, security tool ships with the OS
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -convert xml1 -o - - \
  | grep -A1000 ProvisionedDevices \
  | head -50
```

Вы должны увидеть элемент `<string>` с вашим UDID внутри `<key>ProvisionedDevices</key>`. Если его нет, профиль в вашей папке Provisioning Profiles это копия до регенерации. Удалите её и заново скачайте из Visual Studio или Xcode. macOS не перезаписывает существующий профиль более новым с тем же UUID, пока вы сначала не удалите старый файл; это ловит многих, кто думает, что у них "новый профиль", но на самом деле у них прошлонедельный.

Пока вы там, проверьте значение `<key>application-identifier</key>`. Оно должно равняться `<TEAM_ID>.<bundle-id>`, где bundle id это в точности **Application ID** в вашем csproj. Если они отличаются, ваш csproj или ваш `Info.plist` отклонились. См. раздел про смещение Bundle ID в gotchas.

## Gotchas и похожие случаи

**Вы разворачиваете на симулятор, а не на устройство.** Симулятор вообще не требует provisioning profile, но `mlaunch` всё равно будет жаловаться, если ваш проект форсит профиль через `CodesignProvision`, и вы случайно выбрали target `iPhone 15 Pro Simulator`. Переключите **Debug Target** в панели инструментов Visual Studio на **iOS Remote Devices** и выберите физическое устройство.

**Вы запускаете Distribution, а не Development.** Профиль разработки включает только устройства, способные на Development, и подписывает только сертификатом `Apple Development`. Если `Configuration` это `Release` и проект использует сертификат `Apple Distribution`, требуется ad-hoc distribution профиль, и ваш dev профиль не будет выбран. См. официальное руководство по [публикации для ad-hoc дистрибуции](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) для параллельных ручных шагов.

**Смещение Bundle ID.** Application ID в **Project Properties > MAUI Shared > General** должен совпадать с Bundle ID, который покрывает wildcard или explicit App ID. Wildcard профиль `com.example.*` покрывает `com.example.app`, но не `com.example.app.dev`. Если вы форкнули sample и так и не обновили App ID, ваш профиль отклоняется по несовпадению App ID, а `mlaunch` сообщает об этом как об ошибке "устройство не включено", потому что ОС сваливает обе проверки в один и тот же код 0xe8008015.

**Wildcard профиль, но entitlement, требующий explicit App ID.** Push Notifications, App Groups, Apple Pay, iCloud, Game Center, HealthKit, HomeKit, NFC, Associated Domains, In-App Purchase и Wireless Accessory Configuration все требуют explicit App ID. Если вы включили один из них в `Entitlements.plist`, пока ваш профиль wildcard, установка падает. Переключитесь на explicit App ID, совпадающий с вашим bundle identifier, и пересоздайте профиль с отмеченным entitlement.

**Два профиля, тот же App ID, разные команды.** Закэшированные профили не индексируются по команде. Если вы когда-либо логинились в другую команду Apple Developer на той же машине, профили обеих команд лежат бок о бок в `~/Library/MobileDevice/Provisioning Profiles/`. Visual Studio выбирает один, часто более старый или первый по алфавиту, и список устройств не совпадает, потому что устройство зарегистрировано под другой командой. Удалите устаревшие файлы профилей и заново скачайте через **Download All Profiles**.

**Устройство supervised или потеряло доверие.** На iPhone в **Settings > General > VPN & Device Management** должен быть указан сертификат разработчика, и вам должно быть позволено нажать **Trust**. Если "Trust This Computer" был отклонён, `installd` отклоняет развёртывание без явной причины, и `mlaunch` может всплыть сообщением "устройство не включено". Пересоедините, нажмите Trust, повторите.

**Бесплатные аккаунты Apple ID имеют срок жизни профиля 7 дней.** Личные команды (без платного членства) генерируют профили разработки, которые истекают через семь дней после создания. Истечение проявляется во время развёртывания тем же образом, что и случай отсутствующего устройства. Исправление пересоздать, нажав Run в Xcode хотя бы один раз, или обновиться до платного аккаунта Apple Developer Program.

**`MT1006: Could not install the application`.** Это обёртка `mlaunch` для любого сбоя развёртывания, не конкретная причина. Первая соседняя строка в логе сборки это настоящая ошибка; в случае отсутствующего устройства это строка "provisioning profile doesn't include". Разбор Khalid Abuhakmeh про [missing entitlements](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues) проходится по варианту entitlements той же поверхности MT1006.

## Связанное

- Android аналог "обёртка сборки скрывает реальную ошибку" покрыт в [разборе сбоя сборки Gradle XA1029](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- Если вы настраиваете iOS hot-reload в том же проекте, [dotnet watch на MAUI Android и iOS в .NET 11 preview 4](/ru/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) покрывает цикл watch, к которому можно вернуться, как только подпись починена.
- Для потоков дистрибуции после того, как цикл разработки работает, см. [упаковку приложения MAUI для Microsoft Store](/ru/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) для стороны Windows и [документацию ad-hoc дистрибуции](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) для стороны iOS.
- Если ваш target только desktop, и вы хотите вообще пропустить мобильную подпись, [приложение MAUI, которое запускается только на Windows и macOS, без мобильных targets](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) показывает, как сбросить TFM `net11.0-ios`.
- Для контекста подлежащей среды выполнения на iOS в .NET 11 пост [MAUI CoreCLR по умолчанию для Android и iOS в .NET 11 preview 4](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) покрывает, что изменилось под `mlaunch`.

## Источники

- [Manual provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/manual-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Automatic provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/automatic-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Device provisioning for .NET MAUI apps on iOS](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/?view=net-maui-10.0) (Microsoft Learn)
- [Build properties for iOS: CodesignKey and CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) (Microsoft Learn)
- [Publish a .NET MAUI iOS app for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) (Microsoft Learn)
- [Manual iOS Provisioning, dotnet/maui#7056](https://github.com/dotnet/maui/issues/7056) (GitHub)
- [Khalid Abuhakmeh: Fix .NET MAUI MissingEntitlement and Provisioning Profiles Issues](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues)
