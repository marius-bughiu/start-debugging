---
title: "Миграция iOS-приложения на Flutter с CocoaPods на Swift Package Manager (Flutter 3.44 - 3.47)"
description: "Во Flutter 3.44 Swift Package Manager стал вариантом по умолчанию для iOS и macOS, но существующее приложение остаётся на CocoaPods, пока вы его не уберёте. Как проверить, какие плагины готовы к SwiftPM, дать инструменту перенести проект Xcode, безопасно удалить Podfile, разобраться с плагинами только для pods и собственной логикой в Podfile, а при необходимости откатиться."
pubDate: 2026-10-09
updatedDate: 2026-10-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "cocoapods"
  - "xcode"
lang: "ru"
translationOf: "2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-09
---

Если ваше приложение на Flutter создано до Flutter 3.44, в нём по-прежнему есть `Podfile`, каталог `Pods/` и строки `#include` для CocoaPods в xcconfig-файлах, хотя Swift Package Manager (SwiftPM) используется по умолчанию начиная с 3.44. Обновление Flutter выполняет лишь половину миграции. Первый `flutter build ios` или `flutter run` добавляет пакет SwiftPM в проект Xcode, но не убирает CocoaPods. Это делаете вы сами, и только когда каждый используемый плагин поставляется с `Package.swift`. Для типичного приложения с 5-15 плагинами это занимает около 30 минут. Ломается обычно отредактированный вручную `Podfile` (собственная логика `post_install`, макросы препроцессора, дополнительные pods) и плагины, которые всё ещё существуют только в виде pods. Сделайте это сейчас: CocoaPods trunk станет доступным только для чтения 2 декабря 2026 года. Всё описанное ниже проверено на Flutter 3.44.8 с Xcode 27.0 и CocoaPods 1.17.0, а также сверено с актуальной стабильной версией Flutter 3.47.6.

## Зачем убирать CocoaPods, а не оставлять его

- **На сборочной машине больше не нужен Ruby.** Когда не остаётся ни одного pod, `flutter build ios` перестаёт запускать `pod install`, и CI больше не требует Ruby, гем `cocoapods` и обходной путь `LANG=en_US.UTF-8`.
- **Сборки быстрее.** `flutter_tools` сообщает об этом прямо: "Removing CocoaPods integration will improve the project's build time." Фазы сценариев `[CP] Embed Pods Frameworks` и `[CP] Copy Pods Resources` исчезают из каждой сборки.
- **CocoaPods trunk замораживается.** 2 декабря 2026 года он навсегда становится доступным только для чтения. Уже существующие pods продолжают разрешаться, но после этой даты ни один плагин не сможет опубликовать исправленный podspec. Любой плагин, оставшийся на CocoaPods, это плагин с замороженной iOS-частью.
- **Плагины только для pods предупреждены.** Flutter 3.44+ сообщает, что плагин только для pods "will become an error in a future version of Flutter", а pub.dev теперь снижает оценку пакетов без поддержки SwiftPM.

## Что меняется в проекте

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| `ios/Runner.xcodeproj/project.pbxproj` | `FlutterGeneratedPluginSwiftPackage` добавляется как локальная зависимость пакета для `Runner` (автоматически) | низкая |
| `Runner.xcscheme` | Добавляется предварительное действие сборки "Run Prepare Flutter Framework Script" (автоматически, для каждой схемы) | низкая |
| `ios/Podfile`, `Podfile.lock`, `Pods/`, `.symlinks/` | Удаляются вами | средняя |
| `ios/Flutter/Debug.xcconfig`, `Release.xcconfig` | Строки `#include? "Pods/..."` удаляются вами | средняя |
| Собственная логика в `Podfile` | Хуки `post_install`, `GCC_PREPROCESSOR_DEFINITIONS`, pods не из Flutter нужно перенести в другое место | высокая |
| Плагины только для pods | Заставляют CocoaPods остаться; `Podfile` создаётся заново, если вы его удалите | высокая |
| Минимальная версия iOS | Плагины SwiftPM могут требовать более высокий минимум, чем цель `Runner` | средняя |

## Контрольный список перед началом

1. Flutter 3.44 или новее (`flutter --version`). SwiftPM был необязательным (opt-in) начиная с 3.24, но именно в 3.44 автоматическая миграция и перечисленные ниже предупреждения включены по умолчанию.
2. Xcode 15 или новее. `flutter_tools` отказывается работать с SwiftPM на более старом Xcode.
3. Чистое рабочее дерево, чтобы изменения в `project.pbxproj` и схеме можно было просмотреть и откатить.
4. SwiftPM не отключён. Убедитесь, что `flutter config --list` не показывает `enable-swift-package-manager: false` и что в `pubspec.yaml` нет `config: enable-swift-package-manager: false` в разделе `flutter:`. В более ранних релизах, когда SwiftPM ещё был opt-in, документировался другой ключ, `disable-swift-package-manager: true`, прямо в разделе `flutter:`. Удалите его, если коллега добавил его в то время.
5. Если вы собираете варианты (flavors), запишите названия всех схем. Предварительное действие добавляется для каждой схемы отдельно.

## Шаги миграции

1. **Сначала обновите плагины.** Многие плагины добавили `Package.swift` в минорном релизе, а старый lock-файл оставляет вас на версии только для pods. Выполните `flutter pub upgrade` и, для всего, что закреплено в `pubspec.yaml`, `flutter pub outdated`. Через `git diff pubspec.lock` убедитесь, что реализации плагинов для iOS (`*_ios`, `*_darwin`, `*_foundation`, `*_apple`) обновились.

2. **Выясните, какие плагины поддерживают SwiftPM, а какие нет.** `flutter_tools` определяет это проверкой файла: плагин поддерживает SwiftPM, если в его пакете существует `ios/<plugin_name>/Package.swift` (или `darwin/<plugin_name>/Package.swift` для плагинов с общим кодом iOS и macOS). Инструмент читает пути плагинов из `.flutter-plugins-dependencies`, поэтому ту же проверку можно выполнить самостоятельно, не трогая проект Xcode:

   ```bash
   #!/usr/bin/env bash
   # Flutter 3.44+, run from the app root after `flutter pub get`. Needs jq.
   jq -r '.plugins.ios[] | [.name, .path, (if .shared_darwin_source then "darwin" else "ios" end)] | @tsv' \
     .flutter-plugins-dependencies |
   while IFS=$'\t' read -r name path dir; do
     base="${path%/}/$dir"
     if [ -f "$base/$name/Package.swift" ]; then echo "swiftpm    $name"
     elif [ -f "$base/$name.podspec" ];     then echo "pods-only  $name"
     else                                       echo "dart-only  $name"
     fi
   done
   ```

   На тестовом приложении с десятью распространёнными плагинами вывод был таким:

   ```text
   swiftpm    audioplayers_darwin
   swiftpm    device_info_plus
   swiftpm    flutter_contacts
   swiftpm    flutter_secure_storage_darwin
   pods-only  flutter_tts
   swiftpm    geolocator_apple
   swiftpm    image_gallery_saver_plus
   swiftpm    package_info_plus
   dart-only  path_provider_foundation
   swiftpm    vibration
   ```

   `dart-only` означает, что в плагине вообще нет нативного кода для iOS (`path_provider_foundation` 2.6.0 обращается к Foundation через FFI), поэтому ни один менеджер зависимостей не задействован. Любая строка `pods-only` означает, что проект Xcode мигрировать можно, но удалить CocoaPods пока нельзя. Переходите к разделу о плагинах только для pods в части "Подводные камни".

3. **Позвольте Flutter мигрировать проект Xcode.** Запустите настоящую сборку, а не только конфигурацию:

   ```bash
   # Flutter 3.44.8, Xcode 27.0
   flutter build ios --simulator --debug
   ```

   В моём тесте `flutter build ios --config-only` выполнил `pod install` и заново сгенерировал пакет SwiftPM в `ios/Flutter/ephemeral/Packages/`, но не тронул `project.pbxproj` и схему. Интеграция с проектом Xcode происходит непосредственно перед запуском `xcodebuild`. Проверка:

   ```bash
   grep -c FlutterGeneratedPluginSwiftPackage ios/Runner.xcodeproj/project.pbxproj   # > 0
   grep "Run Prepare Flutter Framework Script" ios/Runner.xcodeproj/xcshareddata/xcschemes/*.xcscheme
   ```

   Если все плагины работают через SwiftPM, вывод сборки теперь заканчивается списком действий, составленным под ваш проект:

   ```text
   All plugins found for ios are Swift Packages, but your project still has CocoaPods integration. To remove CocoaPods integration, complete the following steps:
     * In the ios/ directory run "pod deintegrate"
     * Also in the ios/ directory, delete the Podfile
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig" in your ios/Flutter/Debug.xcconfig
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.release.xcconfig" in your ios/Flutter/Release.xcconfig

   Removing CocoaPods integration will improve the project's build time.
   ```

   Если вы получили другое сообщение, "Your project uses a non-standard Podfile and will need to be migrated to Swift Package Manager manually", значит, Flutter побайтово сравнил ваш `Podfile` со своим шаблоном и нашёл правки. Прежде чем продолжить, разберите подводный камень про собственный Podfile. Сделайте коммит на этом этапе: проект теперь собирается с обоими менеджерами, и это ваша точка отката.

4. **Деинтегрируйте CocoaPods.**

   ```bash
   # CocoaPods 1.17.0
   cd ios
   pod deintegrate
   rm -rf Podfile Podfile.lock Pods .symlinks
   cd ..
   ```

   `pod deintegrate` удаляет из `project.pbxproj` фазы сборки `[CP]`, ссылку на `Pods_Runner.framework` и ссылки на xcconfig-файлы Pods. Проверьте командой `grep -c "\[CP\]" ios/Runner.xcodeproj/project.pbxproj`, которая должна вывести `0`.

5. **Уберите включения Pods из xcconfig-файлов.** Оба файла начинаются с необязательного включения, которое `pod deintegrate` не трогает:

   ```text
   // ios/Flutter/Debug.xcconfig, before
   #include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
   #include "Generated.xcconfig"

   // after
   #include "Generated.xcconfig"
   ```

   Сделайте то же самое в `Release.xcconfig` и в любом xcconfig для отдельного варианта, который вы создавали (`Debug-dev.xcconfig` и так далее). Форма `#include?` означает, что отсутствующий файл молча игнорируется, поэтому оставленная строка сборку не сломает. Но `flutter_tools` проверяет наличие этой строки и продолжает выводить список действий по удалению, пока она есть. Проверьте командой `grep -rn "Pods" ios/Flutter/*.xcconfig`, которая ничего не должна вывести.

6. **Приберите ссылку в рабочей области.** `pod deintegrate` завершается сообщением "The workspace referencing the Pods project still remains." Откройте `ios/Runner.xcworkspace/contents.xcworkspacedata` и удалите элемент `<FileRef location = "group:Pods/Pods.xcodeproj">`, чтобы Xcode перестал показывать красный, отсутствующий проект. Сам `Runner.xcworkspace` оставьте; Flutter и Xcode по-прежнему открывают приложение через него.

7. **Пересоберите с нуля.**

   ```bash
   # Flutter 3.44.8 / 3.47.6
   flutter clean
   flutter pub get
   flutter build ios --simulator --debug
   ```

   Проверьте два момента в выводе: нет строки `Running pod install...`, и `ios/Podfile` не был создан заново. Если `Podfile` вернулся, в графе зависимостей всё ещё есть плагин только для pods.

8. **Обновите CI.** Удалите шаги `pod install`, `pod repo update`, настройки Ruby и кеширования CocoaPods. Кешируйте `~/Library/Developer/Xcode/DerivedData/<project>/SourcePackages` или передайте `-clonedSourcePackagesDirPath` в `xcodebuild`, если вы собираете напрямую из Xcode. Проверьте, запустив конвейер на образе раннера без установленного гема `cocoapods`.

## Проверка

- `flutter build ios --release --no-codesign` завершается успешно и не выводит строку `pod install`.
- `flutter run` на реальном устройстве работает, включая горячую перезагрузку. Это доказывает, что предварительное действие правильно подготовило `Flutter.framework`.
- В Xcode у каждой выпускаемой схемы есть предварительное действие "Run Prepare Flutter Framework Script" в разделе Edit Scheme, Build, Pre-actions. Чаще всего его не хватает у схем вариантов, созданных вручную.
- Каждый плагин с нативным кодом работает во время выполнения: запросите одно разрешение, откройте один URL, прочитайте одно значение из защищённого хранилища. Плагин, который скомпилировался, но потерял конфигурацию, ломается именно здесь, а не на этапе сборки (см. подводный камень про `permission_handler`).
- Архив собирается: `flutter build ipa` завершается успешно, а загрузка проходит проверку App Store Connect, и именно там в первую очередь проявится отсутствующий ресурс плагина или манифест конфиденциальности.

## Откат

Эта миграция обратима. Если вы сделали коммит после шага 3, `git revert` коммита с деинтеграцией и `cd ios && pod install` вернут смешанную конфигурацию. Чтобы полностью отказаться от SwiftPM, отключите его для всего проекта в `pubspec.yaml`:

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

Затем удалите `FlutterGeneratedPluginSwiftPackage` из Package Dependencies и из Frameworks, Libraries, and Embedded Content цели `Runner`, а также удалите предварительное действие из каждой схемы. Само по себе отключение оставляет интеграцию SwiftPM в файле проекта, и Flutter продолжает генерировать для неё пустой пакет. Считайте отключение временной мерой, потому что поддержка CocoaPods находится в режиме сопровождения и со временем исчезнет.

## Подводные камни реальной миграции

### Плагины только для pods возвращают Podfile

Если хотя бы у одного плагина нет `Package.swift`, Flutter работает в смешанном режиме. Я добавил `flutter_tts` 4.2.5 в полностью мигрированное приложение без `Podfile`, и следующая сборка вывела:

```text
The following plugins do not support Swift Package Manager for ios:
  - flutter_tts
This will become an error in a future version of Flutter. Please contact the plugin maintainers to request Swift Package Manager adoption.
Running pod install...
```

Flutter заново сгенерировал `ios/Podfile` из своего шаблона и вернул строки `#include?` в оба xcconfig-файла. Смешанный режим собирается нормально, так что это не авария. Ваши варианты: заменить плагин, перенести его iOS-код в локальный пакет с `Package.swift` или оставить смешанную конфигурацию и проверить плагин позже. Не удаляйте заново созданный `Podfile` в цикле; он будет возвращаться, пока этот плагин есть в `pubspec.lock`.

### permission_handler игнорирует макросы из вашего Podfile при работе через SwiftPM

Классическая настройка `permission_handler` помещает `PERMISSION_CAMERA=1` и подобные макросы в `GCC_PREPROCESSOR_DEFINITIONS` в блоке `post_install` файла `Podfile`. При работе через SwiftPM этот блок больше не выполняется. Начиная с `permission_handler_apple` 9.4.8 манифест пакета включает разрешение, если в вашем `Info.plist` есть соответствующий ключ `NS*UsageDescription`. В 9.5.1 исправили определение для plist, специфичных для конфигурации сборки и варианта, а в 9.6.0 добавили `permission_handler.yaml` для разрешений по вариантам, так что убедитесь, что ваш lock-файл разрешается в 9.6.x. Два следствия: разрешение без описания использования вырезается при компиляции и во время выполнения возвращает `denied`, а не ломает сборку, и манифест кешируется, поэтому после изменения `Info.plist` нужно один раз выполнить `rm -rf ~/Library/Developer/Xcode/DerivedData`. Именно поэтому так важна проверка во время выполнения из списка выше.

### Собственный Podfile нужно переносить, а не удалять

Прежде чем удалить `Podfile`, поищите в нём три вещи. Pods не из Flutter (`pod 'GoogleMLKit/...'`, SDK аналитики) нужно превратить в зависимости Swift-пакетов, добавленные через вкладку Package Dependencies Xcode в проекте `Runner`. Переопределения параметров сборки в `post_install` (`ENABLE_BITCODE`, `EXCLUDED_ARCHS`, целевые версии развёртывания) влияли только на цели pods, поэтому большинство из них можно просто убрать. Макросы препроцессора, которые используют плагины, требуют эквивалента для SwiftPM у самого плагина, как в случае с `permission_handler` выше. Если это пропустить, сборка обычно всё равно проходит, а функция молча пропадает.

### Несовпадение минимальной версии iOS

Плагин SwiftPM может требовать более высокую платформу, чем ваше приложение, и тогда сборка падает с ошибкой "The package product 'plugin_name_ios' requires minimum platform version 14.0 for the iOS platform, but this target supports 12.0". Повысьте Minimum Deployments у цели `Runner` и выполните `flutter build ios --config-only`, чтобы заново сгенерировать конфигурацию. В Xcode 27 есть второй порог: он отклоняет любую целевую версию iOS ниже 15.0, а проект, созданный Flutter 3.44.8, всё ещё указывает 13.0. Эта ошибка затрагивает проект `Runner` и, в смешанном режиме, каждую цель pod. Для pods добавьте переопределение в блок `post_install` после `flutter_additional_ios_build_settings(target)`:

```ruby
# ios/Podfile, Flutter 3.44.8 + Xcode 27.0, mixed mode only
target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
end
```

У macOS есть собственная версия этой проблемы, описанная в материале [повышение минимальной целевой версии развёртывания приложения Flutter для macOS до macOS 12 из-за Xcode 27](/ru/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).

### Старые советы со StackOverflow перестают работать

Закрепление версии pod в `Podfile` для разрешения конфликта ничего не даёт, когда плагин разрешается через SwiftPM, потому что CocoaPods его не видит. Если раньше вы боролись с [ошибкой CocoaPods "could not find compatible versions for pod"](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/), при миграции удалите эти закрепления, а не переносите их дальше.

### Модули add-to-app устроены иначе

Модуль Flutter, встроенный в нативное приложение iOS, использует собственный `Podfile` модуля, которого `flutter_tools` намеренно не касается. Вместо описанных выше шагов следуйте руководству по настройке проекта add-to-app.

## Связанные материалы

- Релиз, который изменил значение по умолчанию: [Flutter 3.44 делает Swift Package Manager вариантом по умолчанию](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Если проблема в самом Xcode, а не в менеджере зависимостей, начните с [ошибки сборки iOS-приложения в Xcode 16 и Flutter 3.x](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).
- Чтобы развернуть миграцию на несколько версий Flutter в CI, не сломав старые ветки, смотрите [сборку под несколько версий Flutter из одного конвейера CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Источники

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Swift Package Manager for plugin authors](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors) (docs.flutter.dev)
- [Saying goodbye to CocoaPods](https://flutter.dev/blog/saying-goodbye-to-cocoapods-swift-package-manager-is-soon-the-default-in-flutter) (flutter.dev blog)
- [`darwin_dependency_management.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/macos/darwin_dependency_management.dart), источник процитированных выше предупреждений (flutter/flutter)
- [`permission_handler_apple` changelog](https://github.com/Baseflow/flutter-permission-handler/blob/main/permission_handler_apple/CHANGELOG.md) (Baseflow/flutter-permission-handler)
- [CocoaPods Specs repo read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods blog)
