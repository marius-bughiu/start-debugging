---
title: "Исправление: \"does not support provisioning profiles\" при архивации iOS-приложения Flutter после перехода на Swift Package Manager"
description: "Provisioning profile, переданный в xcodebuild в командной строке, применяется к каждой цели resource bundle в SwiftPM. Вместо этого задайте ручную подпись для цели Runner."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "xcode"
  - "ci"
lang: "ru"
translationOf: "2026/10/fix-does-not-support-provisioning-profiles-flutter-ios-archive-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-12
---

Перестаньте передавать `PROVISIONING_PROFILE_SPECIFIER` (и, как правило, вместе с ним `CODE_SIGN_STYLE`, `DEVELOPMENT_TEAM` и `CODE_SIGN_IDENTITY`) в виде аргументов командной строки `xcodebuild` или `xcargs` в fastlane. Параметр сборки, заданный в командной строке, переопределяет этот параметр для **каждой** цели в сборке. После перехода на SwiftPM сюда входит и цель resource bundle, которую Xcode генерирует для каждого плагина, например `url_launcher_ios_url_launcher_ios`, а resource bundle не может иметь provisioning profile. Вместо этого задайте ручную подпись в конфигурации Release цели `Runner`, а архив собирайте через `flutter build ipa`. В CocoaPods те же аргументы работали только потому, что хук `post_install` выставлял `CODE_SIGNING_ALLOWED = NO` для каждого пода. В SwiftPM такого хука нет, поэтому переход и выявляет ошибку. Всё ниже воспроизведено на Flutter 3.44.8, Xcode 27.0 и CocoaPods 1.17.0.

## Полный текст ошибки

Вы получаете по одной ошибке на каждый плагин, поставляющий ресурсы (на практике это каждый плагин с манифестом `PrivacyInfo.xcprivacy`), а затем обычный сбой архивации:

```
.../ios/Flutter/ephemeral/Packages/.packages/url_launcher_ios-6.4.2/Package.swift: error: url_launcher_ios_url_launcher_ios does not support provisioning profiles. url_launcher_ios_url_launcher_ios does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'url_launcher_ios_url_launcher_ios' from project 'url_launcher_ios')
.../ios/Flutter/ephemeral/Packages/.packages/shared_preferences_foundation-2.5.7/Package.swift: error: shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles. shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'shared_preferences_foundation_shared_preferences_foundation' from project 'shared_preferences_foundation')
** ARCHIVE FAILED **
```

Обратите внимание на две вещи: путь, который указывает в `Flutter/ephemeral/Packages/.packages/`, и имя цели, следующее шаблону SwiftPM `<package>_<target>`. Обе подсказывают, что сбойная цель является resource bundle пакета Swift, а не вашим приложением и не кодом плагина.

Совет из сообщения, "Set the provisioning profile value to Automatic in the build settings editor", здесь не помогает. Вы не можете открыть параметры сборки цели, которую Xcode синтезирует из `Package.swift`, и сама эта цель никакого профиля не запрашивает. Профиль навязывается ей снаружи.

## Почему профиль попадает в цели, которые вы не настраивали

Xcode определяет значение параметра сборки через несколько слоёв, от низшего приоритета к высшему: значения платформы по умолчанию, параметры уровня проекта, файлы xcconfig, параметры уровня цели и, наконец, переопределения, которые вы передаёте в `xcodebuild` как `NAME=value`. Верхний слой не привязан к конкретной цели. Когда скрипт CI запускает:

```bash
# Xcode 27.0, Flutter 3.44.8 - the pattern that breaks
xcodebuild -workspace Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=ABCDE12345 \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore"
```

каждая цель, участвующая в архиве, получает `PROVISIONING_PROFILE_SPECIFIER = MyApp AppStore`. Затем проверка подписи в Xcode отклоняет этот параметр для любого типа продукта, который нельзя подписать профилем, например resource bundle, статические библиотеки и фреймворки. Apple применяла это не всегда последовательно: в [теме на форуме разработчиков](https://developer.apple.com/forums/thread/700327) описана та же ошибка для нативных зависимостей-пакетов Swift. Она появилась в бета-версиях Xcode 13.3, исчезла в 13.3 GM и вернулась в Xcode 14. В Xcode 27.0 проверка применяется.

После перехода в архиве присутствуют цели `Runner`, агрегат `FlutterGeneratedPluginSwiftPackage`, библиотечный продукт каждого плагина и по одной цели `.bundle` на каждый плагин, объявляющий `resources:` в своём `Package.swift`. Большинство первичных плагинов теперь поставляют манифест конфиденциальности именно так, поэтому почти в любом реальном приложении таких bundle несколько.

### Почему это работало в CocoaPods

Я запустил ту же команду для того же приложения с отключённым SwiftPM (`enable-swift-package-manager: false` в разделе `flutter: config:` файла `pubspec.yaml`). Она тоже падает, только с другими именами целей:

```
ios/Pods/Pods.xcodeproj: error: Pods-Runner does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: url_launcher_ios does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: shared_preferences_foundation does not support provisioning profiles. ...
```

Значит, командная строка никогда не была корректной. Проекты, которые собирались с ней, содержали в `Podfile` блок `post_install`, похожий на этот, обычно скопированный много лет назад из ответа на Stack Overflow:

```ruby
# ios/Podfile, CocoaPods 1.17.0
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    end
  end
end
```

Пока этот хук на месте, архивация проходит все цели подов, и по профилю проверяется только `Runner`. Хук работает потому, что Xcode пропускает проверку подписи для цели, которой подписывать запрещено, даже если навязанный профиль всё ещё есть в её параметрах. Когда вы удаляете `Podfile` последним шагом перехода, хук исчезает вместе с ним, а SwiftPM не даёт ничего равнозначного. Для пакетов нет `post_install`, а сгенерированный `Package.swift` в `Flutter/ephemeral` переписывается при каждой сборке.

## Минимальный пример воспроизведения

```bash
# Flutter 3.44.8, Xcode 27.0, SwiftPM enabled (the default since 3.44)
flutter create --platforms=ios -e --org com.example myapp
cd myapp
flutter pub add url_launcher shared_preferences
# Xcode 27 rejects the template's 13.0 deployment target
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' \
  ios/Runner.xcodeproj/project.pbxproj
flutter build ios --simulator --debug   # applies the SwiftPM project migration
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=ABCDE12345 \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore" CODE_SIGN_IDENTITY="Apple Distribution"
```

Настоящий сертификат или профиль для воспроизведения не нужны. Xcode сообщает об ошибках "does not support provisioning profiles" для двух целей bundle на этапе планирования сборки, рядом с ожидаемой ошибкой "No profile for team" для `Runner`.

## Исправление 1: задайте ручную подпись для цели Runner и используйте `flutter build ipa`

Подпись относится к целям, которые производят что-то подписываемое: `Runner` и любые расширения приложения (share extension, notification service extension, виджет). Задавайте её там и больше нигде.

В Xcode откройте `ios/Runner.xcworkspace`, выберите цель `Runner`, перейдите в **Signing & Capabilities**, откройте вкладку **Release**, отключите **Automatically manage signing** и выберите свою команду и профиль. Если хотите увидеть результат, вот что попадает в конфигурацию Release цели `Runner` в `ios/Runner.xcodeproj/project.pbxproj`:

```
/* Flutter 3.44.8, Xcode 27.0 - Runner target, Release configuration */
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = ABCDE12345;
"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "MyApp AppStore";
```

Повторите для конфигурации `Profile`, если вы архивируете профильные сборки. Затем уберите из команды все аргументы подписи и архивируйте как обычно:

```bash
# Flutter 3.44.8
flutter build ipa --release
```

Когда я перенёс те же четыре параметра из командной строки в цель `Runner`, ошибки пакетов исчезли, и осталась только ожидаемая ошибка "No profile ... found" для `Runner`. На моей тестовой машине нет distribution-профиля, поэтому воспроизведение заканчивается здесь, но оставшаяся ошибка является обычной для одного `Runner`, когда указанный профиль не установлен.

`flutter build ipa` не добавляет собственных переопределений подписи. В Flutter 3.44.8 `build_ios.dart` читает итоговые параметры сборки `Runner` после архивации. Если `CODE_SIGN_STYLE` равен `Manual`, а `PROVISIONING_PROFILE_SPECIFIER` и `DEVELOPMENT_TEAM` заданы, он находит соответствующий установленный профиль и генерирует `ExportOptions.plist` с `signingStyle` равным `manual` и записью `provisioningProfiles` для идентификатора вашего bundle. Если нужен полный контроль, например для приложения с расширениями, передайте собственный файл:

```bash
# Flutter 3.44.8
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
```

```xml
<!-- ios/ExportOptions.plist, Xcode 27.0 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>ABCDE12345</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.myapp</key>
    <string>MyApp AppStore</string>
  </dict>
</dict>
</plist>
```

Указывайте в `provisioningProfiles` только идентификаторы bundle приложения и его расширений. Фреймворки и bundle плагинов записей не получают никогда.

## Исправление 2: в fastlane меняйте проект, а не командную строку

Версия плохого шаблона для fastlane выглядит как `build_app(xcargs: "PROVISIONING_PROFILE_SPECIFIER=...")`, а `xcargs` как раз и есть слой командной строки. Используйте `update_code_signing_settings` с `targets:`, чтобы параметр записывался только в `Runner`, а затем собирайте без `xcargs` для подписи:

```ruby
# fastlane 2.x, Flutter 3.44.8, Xcode 27.0
lane :release do
  update_code_signing_settings(
    path: "ios/Runner.xcodeproj",
    use_automatic_signing: false,
    targets: ["Runner"],
    build_configurations: ["Release"],
    team_id: "ABCDE12345",
    code_sign_identity: "Apple Distribution",
    sdk: "iphoneos*",
    profile_name: "MyApp AppStore"
  )
  build_app(
    workspace: "ios/Runner.xcworkspace",
    scheme: "Runner",
    configuration: "Release",
    export_method: "app-store",
    export_options: {
      provisioningProfiles: { "com.example.myapp" => "MyApp AppStore" }
    }
  )
end
```

Параметр `targets` по умолчанию охватывает все цели проекта. Bundle плагинов не входят в `Runner.xcodeproj`, поэтому если его опустить, ошибка не воспроизведётся, но явное указание цели не даст будущему расширению или тестовой цели получить неверный профиль.

## Исправление 3: переключите архивацию на автоматическую подпись

Если конкретный профиль не нужен, пусть им управляет Xcode. Оставьте `CODE_SIGN_STYLE = Automatic` для `Runner` и позвольте `xcodebuild` получать или создавать профили с помощью ключа API App Store Connect:

```bash
# Xcode 27.0
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Runner.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

В этом режиме цели bundle пакетов не нуждаются в подписи, поэтому проходят проверку без дополнительных усилий. Цена в том, что машине CI нужен ключ API, и она сама создаёт профили, а некоторые процессы выпуска этого не допускают.

## Обходные пути, которые выглядят верно, но не работают

- **`CODE_SIGNING_ALLOWED=NO` в командной строке.** Он затрагивает и `Runner`, поэтому вы получаете неподписанный архив, который `-exportArchive` не может превратить в IPA, пригодный для загрузки.
- **Условные параметры в командной строке.** `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]=MyApp AppStore"` не разбирается как условный параметр. В Xcode 27.0 значение превратилось в `iphoneos*]=MyApp AppStore`, и `Runner` упал с ошибкой "No profile ... matching 'iphoneos*]=MyApp AppStore' found". Условия работают только в файлах проекта и файлах xcconfig.
- **`-xcconfig` или `XCODE_XCCONFIG_FILE`.** Оба применяют свой файл как переопределение для всей сборки, поэтому профиль из этого файла достигает целей пакетов так же, как аргумент `NAME=value`.
- **Повторное отключение SwiftPM.** `enable-swift-package-manager: false` вместе со старым хуком `post_install` убирает ошибку, но лишь возвращая CocoaPods. Это выигрыш времени, а не исправление, к тому же CocoaPods trunk станет доступен только для чтения 2 декабря 2026.

## Похожие ошибки от той же командной строки

Если убрать профиль, но оставить остальные переопределения, изменится только ошибка. При `CODE_SIGN_STYLE=Manual` и `CODE_SIGN_IDENTITY` в командной строке и без команды Xcode 27.0 сообщает `Signing for "url_launcher_ios_url_launcher_ios" requires a development team` для каждого bundle. Добавьте `DEVELOPMENT_TEAM`, и на тех же целях bundle появится `No signing certificate "iOS Distribution" found`. У всех трёх одна причина и одно исправление: никаких параметров подписи в командной строке.

Другое сообщение, `exportArchive: SomeKit.framework does not support provisioning profiles`, приходит с шага экспорта, а не архивации. Оно означает, что ваш `ExportOptions.plist` (или `export_options` в fastlane) сопоставляет идентификатор bundle фреймворка с профилем. Удалите эту запись. Там должны быть только приложение и его расширения.

Если архивация проходит подпись, а затем падает на целевых версиях развёртывания, это минимум iOS 15 в Xcode 27, а не проблема подписи. Вариант этого сбоя со стороны CocoaPods разобран в [статье о конфликтах версий CocoaPods в сборках Flutter для iOS](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Связанные материалы

- [Migrate a Flutter iOS app from CocoaPods to Swift Package Manager](/ru/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) описывает переход, который убирает хук из `Podfile`, в том числе как переносить другую пользовательскую логику `post_install`.
- [Flutter 3.44 makes SwiftPM the default](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) объясняет, почему приложения, обновлённые до 3.44, переключились без каких-либо изменений с вашей стороны.
- [Fix: Unable to find a destination matching the provided destination specifier](/ru/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) это ещё один сбой сборки iOS, вызванный остатками настроек времён CocoaPods.
- [Fix: the provisioning profile doesn't include the currently selected device](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) рассматривает сторону provisioning, связанную с регистрацией устройств, с точки зрения .NET MAUI.

## Источники

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers), документация Flutter.
- [Build and release an iOS app](https://docs.flutter.dev/deployment/ios), документация Flutter (`flutter build ipa` и `--export-options-plist`).
- [`build_ios.dart` in flutter_tools](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_ios.dart), генерация ExportOptions для ручной подписи.
- [update_code_signing_settings](https://docs.fastlane.tools/actions/update_code_signing_settings/), документация fastlane.
- [Apple Developer Forums thread 700327](https://developer.apple.com/forums/thread/700327), та же ошибка для нативных зависимостей-пакетов Swift в архиве CI с ручной подписью и то, как менялось её применение между Xcode 13 и 14.
- [Apple Developer Forums thread 726714](https://developer.apple.com/forums/thread/726714), вариант для CocoaPods, возникающий для каждой цели проекта `Pods`.
