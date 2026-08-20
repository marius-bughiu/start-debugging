---
title: "Исправление: Unable to find a destination matching the provided destination specifier в сборке Flutter для iOS"
description: "Среды выполнения симулятора iOS 26 содержат только arm64, поэтому забытая строка EXCLUDED_ARCHS arm64 собирает Intel-only Runner, который не запустится ни на одном симуляторе."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "ru"
translationOf: "2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-08-20
---

Удалите строку `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` из вашего `ios/Podfile`, затем выполните `flutter clean` и чистый `pod install`. Эта строка осталась со времён перехода на Apple Silicon в 2020 году, и в Xcode 26 она фатальна: среды выполнения симулятора iOS 26 поставляются только с arm64, поэтому исключение arm64 оставляет `Runner` без единой архитектуры, которую симулятор способен выполнить, а `xcodebuild` сообщает об этом как об отсутствующем назначении, а не как о несовпадении архитектур. Если исключение приходит из плагина, который вы не контролируете, вместо этого установите универсальную среду выполнения командой `xcodebuild -downloadPlatform iOS -architectureVariant universal`.

## Полный текст ошибки

Flutter показывает необработанную ошибку `xcodebuild`, которая называет UDID вашего симулятора, а затем перечисляет назначения, выглядящие вполне корректно:

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
                { id:6B4F9D28-C76C-4146-9527-E844395B4434 }

        Available destinations for the "Runner" scheme:
                { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006020-000221002EE8C01E, name:My Mac }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

Запуск той же схемы из интерфейса Xcode даёт диагноз, который вывод Flutter прячет:

```
iPhone 17 cannot run Runner.
Domain: IDEFoundationErrorDomain
Code: 3
Recovery Suggestion: Runner's architectures (Intel 64-bit) include none that iPhone 17 can execute (arm64).
```

Именно второе сообщение и есть настоящая ошибка. Симулятор существует, он запущен, и его UDID верен. Не хватает общей архитектуры между только что собранным продуктом и устройством, на котором вы попросили его выполнить.

## Почему у симулятора iOS 26 нет подходящего назначения

`xcodebuild -destination` разрешается не в "устройство с этим UDID", а в "устройство с этим UDID, способное выполнить продукт данной схемы". Архитектура входит в условие совпадения, поэтому несовпадение архитектур выглядит как отсутствующее назначение.

До iOS 26 это различие редко имело значение. Среды выполнения симулятора поставлялись универсальными бинарниками, содержащими и срез `x86_64`, и срез `arm64`, поэтому сборка только под Intel всё равно находила срез для запуска под Rosetta на Apple Silicon. Xcode 26 это прекратил. При установке среды выполнения Apple разрешает вариант архитектуры на Apple Silicon в `arm64` и скачивает только этот срез, попутно печатая `Automatically resolved architecture variant for platform iOS as 'arm64'`.

Значит, симулятор iOS 26 выполняет ровно одну архитектуру, и любая настройка сборки, убирающая `arm64` из сборки для симулятора, порождает продукт без единого пригодного среза.

Эта настройка почти всегда приходит из Podfile. В 2020 году каждое руководство по обходным решениям для Apple Silicon советовало добавить исключение arm64, чтобы Intel-only поды линковались, и этот совет скопировали в тысячи проектов. Собственный помощник CocoaPods во Flutter сохраняет его: `packages/flutter_tools/bin/podhelper.rb` пишет исключение для симулятора с `$(inherited)` впереди, из-за чего ваше значение уровня проекта сохраняется, а не заменяется.

```ruby
# Flutter 3.44.2, packages/flutter_tools/bin/podhelper.rb
build_configuration.build_settings['VALID_ARCHS[sdk=iphonesimulator*]'] = '$(ARCHS_STANDARD)'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = '$(inherited) i386'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphoneos*]'] = '$(inherited) armv7'
```

Штатное исключение состоит только из `i386` и безвредно. Сборку убивает унаследованный `arm64`.

Есть и второй источник. Если какой-либо pod-таргет исключает `arm64`, Flutter распространяет исключение на само приложение. `packages/flutter_tools/lib/src/ios/xcode_build_settings.dart` решает это при генерации `Generated.xcconfig`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/xcode_build_settings.dart
var excludedSimulatorArchs = 'i386';
if (!(await project.ios.pluginsSupportArmSimulator(printWarnings: printWarnings))) {
  excludedSimulatorArchs += ' arm64';
}
xcodeBuildSettings.add(
  'EXCLUDED_ARCHS[sdk=${XcodeSdk.IPhoneSimulator.platformName}*]=$excludedSimulatorArchs',
);
```

`pluginsSupportArmSimulator` запускает `xcodebuild -showBuildSettings` по `Pods/Pods.xcodeproj` и возвращает false, если `EXCLUDED_ARCHS` любого таргета упоминает `arm64`. Одной плохо настроенной транзитивной зависимости достаточно, чтобы всё приложение стало только Intel.

## Минимальное воспроизведение: строка Podfile, ломающая сборку для симулятора

Добавьте классический обходной приём в стандартное приложение Flutter и запустите его на симуляторе iOS 26:

```ruby
# ios/Podfile, Flutter 3.44.2, CocoaPods 1.16.2, Xcode 26.0.1
post_install do |installer|
  installer.pods_project.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'arm64'
  end
end
```

```bash
# Flutter 3.44.2 (stable, 11 June 2026), Dart 3.12.2
flutter run -d 6B4F9D28-C76C-4146-9527-E844395B4434
```

Flutter собирает аргумент `-destination` из выбранного вами устройства, в `packages/flutter_tools/lib/src/ios/mac.dart`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/mac.dart
buildCommands.add('-destination');
if (deviceID != null) {
  buildCommands.add('id=$deviceID');
} else if (environmentType == EnvironmentType.physical) {
  buildCommands.add(XcodeSdk.IPhoneOS.genericPlatform);
} else {
  buildCommands.add(XcodeSdk.IPhoneSimulator.genericPlatform);
}
```

`genericPlatform` разворачивается в `generic/platform=iOS Simulator`. Обе формы падают одинаково, как только продукт становится только Intel, и поэтому `flutter build ios --simulator` воспроизводит ошибку вообще без выбранного устройства.

## Как убрать исключение arm64?

Двигайтесь изнутри наружу, от собственного проекта к зависимостям.

Во-первых, удалите исключение из `ios/Podfile`. Уберите всё присваивание `EXCLUDED_ARCHS[sdk=iphonesimulator*]`, а не приводите его к пустой строке, чтобы штатное значение `i386` от Flutter применилось начисто.

Во-вторых, проверьте сам проект Xcode, поскольку ту же строку часто вставляют в настройки сборки, а не в Podfile:

```bash
# Xcode 26.0.1
cd ios
xcodebuild -showBuildSettings -project Runner.xcodeproj -scheme Runner \
  -sdk iphonesimulator | grep -i EXCLUDED_ARCHS
```

Всё, что упоминает `arm64` в SDK симулятора, должно уйти. Очистите это в Xcode в разделе Build Settings, Excluded Architectures, и для Debug, и для Release.

В-третьих, пересоберите поды с нуля. Устаревшие `Pods` и `DerivedData` сохраняют старые настройки живыми, и кажется, будто исправление ничего не дало:

```bash
# Flutter 3.44.2, CocoaPods 1.16.2
flutter clean
rm -rf ios/Pods ios/Podfile.lock ~/Library/Developer/Xcode/DerivedData
flutter pub get
cd ios && pod install
```

В-четвёртых, убедитесь, что исключение исчезло из файла, который генерирует Flutter. В `ios/Flutter/Generated.xcconfig` должно быть `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386` без `arm64`. Если `arm64` пережил чистый `pod install`, источник в зависимости, а не в вас.

## Что делать, если плагин по-прежнему исключает arm64?

В Xcode 26 и новее Flutter 3.41.0 (11 февраля 2026) и более свежие версии сами называют виновные таргеты во время сборки, из `packages/flutter_tools/lib/src/xcode_project.dart`:

```
The following target(s) do not support arm64 architecture, which is a requirement for Apple Silicon iOS 26+ simulators:
  - SomePlugin (Flutter plugin)
  - SomeVendorSDK (transitive dependency of Flutter plugin SomePlugin)

Please contact plugin maintainers to request arm64 support to continue to be able to use the plugin on a simulator.
```

Это предупреждение появилось в [PR #177065](https://github.com/flutter/flutter/pull/177065), влитом 5 ноября 2025 года. Сравнение коммита слияния с тегами релизов помещает его вне 3.38.10 и внутрь 3.41.0, так что тот, кто остался на линии 3.38, получает ошибку без всяких пояснений.

Если таргет представляет собой бинарный фреймворк поставщика без среза arm64 для симулятора, убрать исключение не получится. Вместо этого установите универсальную среду выполнения, чтобы Intel-only продукту было где запуститься:

```bash
# Xcode 26.0.1
xcrun simctl delete unavailable
xcodebuild -downloadPlatform iOS -architectureVariant universal
```

Сначала удалите имеющуюся среду выполнения iOS 26 только с arm64 через панель Settings, Components в Xcode. Иначе загрузка разрешится в уже установленную среду и завершится, не забрав универсальный вариант. После этого проверьте:

```bash
# Xcode 26.0.1
xcrun simctl list runtimes --json | grep -i x86_64
```

Именно этот обходной путь рекомендует сам Flutter. Начиная с 3.41.4 (4 марта 2026) инструмент печатает подсказку после неудачной сборки для симулятора, при условии Xcode 26 или новее и того, что у выбранной среды выполнения действительно отсутствует срез `x86_64`:

```
The selected simulator is incompatible with the current build settings.
Please use a simulator that supports x86_64, such as a simulator prior to iOS 26 or download the universal variant of the iOS 26 simulator using "xcodebuild -downloadPlatform iOS -architectureVariant universal".
```

Считайте это временной мерой. Универсальная среда выполнения весит больше, запускает ваше приложение под Rosetta и ничем не помогает следующему коллеге, который поставит среду обычным способом. Удаление исключения остаётся долговременным решением.

## Что делать, если ошибка говорит, что платформа не установлена?

Другой режим отказа печатает тот же заголовок, а под ним блок `Ineligible destinations`:

```
Unable to find a destination matching the provided destination specifier:
                { id:1234D567-890C-1DA2-34E5-F6789A0123C4 }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 17.0 is not installed. To use with Xcode, first download and install the platform }
```

Это не проблема архитектуры. Ваш deployment target или схема ссылаются на среду выполнения, которой на машине нет, что типично сразу после обновления Xcode, поскольку Xcode 26 не переносит старые среды. Flutter вычленяет из этого сообщения фразу `is not installed` и печатает инструкции по установке, указывающие на раздел Components в Xcode. Установите недостающую среду выполнения или поднимите deployment target до той версии, которая у вас есть.

## Что делать, если назначение указывает на устаревший UDID симулятора?

Если UDID из ошибки больше не существует, `xcodebuild` добавляет отдельную строку:

```
The requested device could not be found because no available devices matched the request.
```

Flutter явно исключает этот случай из своей архитектурной диагностики, поэтому такая фраза означает, что вы гонитесь за фантомным устройством, а не за несовпадением архитектур. Обычно это следует за обновлением iOS или Xcode, пересоздавшим набор симуляторов, тогда как конфигурация IDE, файл `launch.json` или алиас в шелле продолжали закреплять старый идентификатор:

```bash
# Xcode 26.0.1, Flutter 3.44.2
xcrun simctl list devices available
xcrun simctl delete unavailable
flutter devices
```

Затем передайте UDID, который `flutter devices` действительно показывает, либо уберите `-d` и дайте Flutter выбрать самому.

## Что ломает это в CI, когда локально всё работает?

На сервере сборки то же сообщение обычно означает, что платформа iOS не установлена вовсе. В [issue #163011](https://github.com/flutter/flutter/issues/163011) список назначений содержал только записи macOS, а именно так выглядит образ macOS с неполным набором компонентов Xcode. `flutter build ipa` передаёт `generic/platform=iOS`, и без установленной платформы iOS сопоставлять просто нечего.

Проверьте образ, прежде чем винить проект:

```bash
# Xcode 26.0.1 on a CI runner
xcodebuild -showsdks
xcrun simctl list runtimes
```

Если iOS отсутствует, добавьте `xcodebuild -downloadPlatform iOS` предварительным шагом сборки и зафиксируйте версию Xcode, чтобы обновление образа не поменяло ответ молча. Это та же дисциплина, что делает предсказуемым [конвейер CI, собирающий сразу под несколько версий Flutter](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Подводные камни и похожие варианты

`ONLY_ACTIVE_ARCH` не заменяет ничего. Flutter и так передаёт `ONLY_ACTIVE_ARCH` и `ARCHS` явно, когда знает активную архитектуру, а ручная установка не вернёт срез, удалённый через `EXCLUDED_ARCHS`.

Следите и за устаревшей формой `VALID_ARCHS[sdk=iphonesimulator*] = x86_64`. Она появилась раньше `EXCLUDED_ARCHS` и даёт точно такой же Intel-only продукт. Помощник podhelper во Flutter сбрасывает её в `$(ARCHS_STANDARD)` для pod-таргетов, но не для таргета вашего приложения.

Сборка под физическое устройство, падающая с той же строкой, представляет собой другую проблему. Там назначением служит `generic/platform=iOS`, а обычной причиной оказывается подпись кода, что ближе к [профилю подготовки, не включающему выбранное устройство](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/).

Наконец, если сборка проходит проверку назначения, а умирает уже при запуске, вы находитесь совсем в другом месте. Отладочная сборка, которая стартует и тут же падает в Dart VM, это [отказ mprotect permission denied](/ru/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), а сборка, которая вообще не линкуется, скорее [конфликт разрешения версий в CocoaPods](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Какая версия Flutter сообщает настоящую причину

Лежащая в основе несовместимость принадлежит Apple, поэтому обновление Flutter не заставит Intel-only продукт работать на среде выполнения только с arm64. Обновление покупает вам диагноз вместо загадки. Flutter 3.41.0 добавляет предупреждение, называющее каждый таргет, исключающий arm64, а 3.41.4 добавляет подсказку про универсальную среду выполнения после отказа. Оба присутствуют в текущем stable 3.47.1, выпущенном 19 августа 2026 года.

Если вы на 3.38 или старше и обновиться не можете, выполните приведённый выше grep по `-showBuildSettings` вручную. Это ровно та проверка, которую Flutter теперь делает за вас. Для более широкого разбора отказов сборки iOS после обновления Xcode по-прежнему подходит порядок сортировки из [разбора отказа сборки с Xcode 16](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Похожие материалы

- [Исправление: mprotect failed: 13 (Permission denied) в отладочной сборке Flutter для iOS](/ru/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)
- [Исправление: CocoaPods could not find compatible versions for pod в сборке Flutter для iOS](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)
- [Исправление: Failed to build iOS app с Xcode 16 и Flutter 3.x](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Flutter 3.44 делает Swift Package Manager вариантом по умолчанию](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)
- [Как собирать под несколько версий Flutter из одного конвейера CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Источники

- [flutter/flutter issue #176188, flutter run не работает на симуляторе iOS 26](https://github.com/flutter/flutter/issues/176188)
- [flutter/flutter PR #177065, удаление исключения arm64 ради поддержки симуляторов Xcode 26](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter issue #163011, отказ destination specifier с обобщённой платформой iOS](https://github.com/flutter/flutter/issues/163011)
- [Форумы Apple Developer, установка сред выполнения симулятора iOS 26 и варианты архитектуры](https://developer.apple.com/forums/thread/801106)
- [Apple, загрузка и установка дополнительных компонентов Xcode](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Apple, установка дополнительных сред выполнения симулятора](https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes)
