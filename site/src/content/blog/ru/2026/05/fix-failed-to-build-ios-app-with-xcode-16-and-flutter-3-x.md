---
title: "Исправление: Failed to build iOS app с Xcode 16 и Flutter 3.x"
description: "Исправление за 60 секунд: обновите Flutter до 3.24.4 или новее, поднимите платформу Podfile до iOS 13, удалите Pods и DerivedData, затем pod install. Ошибка редко находится в вашем Dart-коде."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "ru"
translationOf: "2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-05-17
---

Исправление в одной фразе: `Failed to build iOS app` после обновления до Xcode 16 почти никогда не является вашим Dart-кодом. Это одна из четырёх причин, в порядке частоты: Flutter SDK старше 3.24.4, который не знает о новом верификаторе модулей Xcode 16; `Podfile`, в котором всё ещё прописано `platform :ios, '11.0'` (Xcode 16 убрал поддержку симулятора iOS 11); устаревший кеш `ios/Pods` и `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex` от предыдущего Xcode; либо плагин, который ещё не выпустил релиз, совместимый со Swift 6 / Xcode 16. Обновите Flutter, поднимите Podfile до iOS 13, снесите оба кеша, выполните `pod install`, пересоберите. Перестаньте бросаться к `flutter clean` как первому шагу; он не трогает кеши iOS, которые действительно сломаны.

```text
Launching lib/main.dart on iPhone 16 Pro in debug mode...
Running Xcode build...
Xcode build done.                                           38.4s
Failed to build iOS app
Error (Xcode): Swift Compiler Error (Xcode): No such module 'Flutter'
/Users/me/MyApp/ios/Runner/AppDelegate.swift:2:8

Could not build the application for the simulator.
Error launching application on iPhone 16 Pro.
```

Это руководство написано для Flutter 3.41.5 (канал stable, май 2026), линейки Xcode 16.x (с 16.0 по 16.4 на момент написания), CocoaPods 1.16.2 и macOS Sequoia 15.3 на Apple Silicon. Те же исправления применимы к Flutter 3.24.4 и новее; если вы на Flutter 3.19 или старше, посмотрите сначала шаг обновления, потому что никакое количество возни с подами не спасёт вас на той ветке. Релевантные изменения Flutter, благодаря которым Xcode 16 заработал чисто, попали в [flutter/flutter#155438](https://github.com/flutter/flutter/issues/155438), а последующие исправления modulemap в [flutter/flutter#157461](https://github.com/flutter/flutter/issues/157461).

## Что на самом деле говорит вам `Failed to build iOS app`

`Failed to build iOS app` это зонтичное сообщение инструмента Flutter. Оно означает только "xcodebuild вернул ненулевой код выхода". Настоящая диагностика это строка непосредственно выше или ниже, с префиксом `Error (Xcode):`. Под одним и тем же зонтиком всплывает примерно шесть различных нижележащих ошибок:

1. `No such module 'Flutter'` -- компилятор Swift не может найти модуль фреймворка Flutter. Почти всегда проблема Podfile или pod install после обновления до Xcode 16.
2. `no such file or directory: '.../ModuleCache.noindex/Session.modulevalidation'` -- новый верификатор модулей Xcode 16 не может прочитать файл кеша, записанный Xcode 15. Смотрите [issue #157461](https://github.com/flutter/flutter/issues/157461).
3. `Using bridging headers with module interfaces is unsupported` -- паттерн с `module.modulemap` плюс bridging header в плагине, работавший в Xcode 15, теперь является жёсткой ошибкой.
4. `type 'UIApplication' does not conform to protocol 'Launcher'` -- ошибка строгой конформности Swift 6 в устаревшем плагине (обычно `url_launcher_ios` до 6.3.0).
5. `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` -- несоответствие ABI среды выполнения Swift, почти всегда кеш CocoaPods от предыдущего SDK Xcode.
6. `The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0, but the range of supported deployment target versions is 12.0 to 18.4` -- ваш `Podfile` всё ещё фиксирует iOS 11, который Xcode 16 убрал.

Каждая из них это отдельный баг с отдельной первопричиной. Первая задача определить, в какую из них инструмент действительно попал. Прокрутите терминал вверх, пока не найдёте строку `error:`, в которой есть путь к файлу и номер строки. Это правда; `Failed to build iOS app` это симптом.

## Чтение настоящей ошибки из `flutter build`

Запустите с подробным логированием, чтобы нижележащий вывод `xcodebuild` не сокращался:

```bash
# Flutter 3.41.5
flutter build ios --verbose 2>&1 | tee build.log
```

Затем найдите в логе первое `error:` (в нижнем регистре, это префикс Xcode), а не `Error (Xcode)` (это переформатирование Flutter):

```bash
grep -n "error:" build.log | head -20
```

Первое совпадение это то, что нужно исправить. Последующие ошибки обычно являются каскадом от первой. Если у вас нет подробного вывода, вы гадаете.

## Минимальное воспроизведение, демонстрирующее одну из распространённых форм

Самая распространённая форма в 2026 это сочетание пина платформы в `Podfile` с устаревшим каталогом `Pods`. Создайте свежий Flutter-проект и зафиксируйте deployment target iOS на 11.0:

```ruby
# ios/Podfile, Flutter 3.41.5, CocoaPods 1.16.2
platform :ios, '11.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

# ... rest of the default Podfile ...
```

Запустите `flutter build ios --no-codesign` под Xcode 16 и сборка падает с:

```text
[!] Automatically assigning platform `iOS` with version `11.0` on target `Runner`
    because no platform was specified. Please specify a platform for this target
    in your Podfile.
...
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
       but the range of supported deployment target versions is 12.0 to 18.4.
       (in target 'firebase_core' from project 'Pods')
Failed to build iOS app
```

Тот же Podfile под Xcode 15.4 собирается без жалоб. Баг это новый минимум deployment target в Xcode 16, а не ваш код.

## Исправление, в порядке частоты как ответа

Применяйте эти шаги по порядку. Каждый шаг предполагает, что предыдущий не сработал.

### 1. Обновите Flutter до 3.24.4 или новее

Flutter 3.24.4 (октябрь 2024) это первый стабильный релиз, в котором отгружаются исправления Xcode 16 для `xcode_backend.sh` и шаблона Generated.xcconfig. Любой релиз линейки 3.41.x в 2026 актуален. Проверьте, что у вас есть, и обновите:

```bash
flutter --version
flutter upgrade
```

Если `flutter upgrade` отказывается, потому что ваш канал на `master` или у вас локальные модификации движка, переключитесь обратно на `stable`:

```bash
flutter channel stable
flutter upgrade
```

Этот единственный шаг решает большинство сообщений `No such module 'Flutter'`, поданных против Xcode 16 в 2024 и 2025 годах. Команда Flutter закрыла [issue #155438](https://github.com/flutter/flutter/issues/155438) как исправленное в 3.24.4 именно по этой причине.

### 2. Поднимите платформу Podfile до iOS 13

Xcode 16 всё ещё поддерживает iOS 12 как deployment target, но большинство современных плагинов (Firebase, Google Maps, всё, что касается SwiftUI) теперь требуют iOS 13. Установка iOS 13 как минимума это безопасный выбор по умолчанию в 2026:

```ruby
# ios/Podfile, Flutter 3.41.5
platform :ios, '13.0'
```

Вам также нужно отразить это в проекте runner. Откройте `ios/Runner.xcworkspace`, выберите цель `Runner`, перейдите в `Build Settings` и установите `iOS Deployment Target` в `13.0` для debug и release. Build settings workspace выигрывают у `Podfile` для самой цели Runner; строка `Podfile` влияет только на цели подов.

Если у вас есть блок `post_install` в Podfile, заставьте каждый под унаследовать тот же минимум (это сниппет из современного шаблона Flutter):

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
    end
  end
end
```

### 3. Снесите Pods, lockfile и кеш модулей

Это шаг, который исправляет ошибку `ModuleCache.noindex` и большинство сообщений о `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56`. Кеш ABI Swift вашего предыдущего Xcode несовместим с `swiftc` Xcode 16, и `flutter clean` его не трогает. Из корня проекта:

```bash
# Flutter 3.41.5, CocoaPods 1.16.2
flutter clean
cd ios
rm -rf Pods Podfile.lock .symlinks
rm -rf ~/Library/Developer/Xcode/DerivedData
pod cache clean --all
pod install --repo-update
cd ..
flutter pub get
```

`pod install --repo-update` (внимание: не `pod install` сам по себе) обновляет репозиторий specs CocoaPods, чтобы вы получили любой podspec плагина, опубликованный со времени последней сборки. Пропустите это и установите вчерашний `firebase_core.podspec`, который всё ещё фиксирует iOS 11.

### 4. Обновите плагины, особенно те, что названы в ошибке

Если ошибка `type 'UIApplication' does not conform to protocol 'Launcher'`, плагин устарел. Два самых частых нарушителя это `url_launcher_ios` и `webview_flutter_wkwebview`. Поднимите до последней minor-версии:

```bash
flutter pub upgrade --major-versions
```

Если вы не можете сделать полное обновление, потому что какая-то зависимость зажимает, обновите только плагин, названный в ошибке:

```bash
flutter pub upgrade --major-versions url_launcher_ios
```

Затем повторите шаг 3 (поды кешируются по версии; изменение в `pubspec.yaml` не запускает `pod install` автоматически). Для более глубокого руководства по чтению жалоб резолвера `pubspec`, если сам `pub upgrade` падает, смотрите [почему "Version solving failed" это доказательство, а не баг](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 5. Принудительно установите единую версию Swift во всех подах

Часть сбоев сборки происходит из подов, которые не объявили `SWIFT_VERSION`, что под Xcode 16 по умолчанию падает в строгий режим Swift 6 и затем взрывается на совершенно легальном коде Swift 5. Исправление зажать каждый под на Swift 5 в том же блоке `post_install`:

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
      config.build_settings['SWIFT_VERSION'] = '5.0'
    end
  end
end
```

Это обходной путь, а не исправление. Правильное долгосрочное решение завести issue против плагина, чтобы он объявил свою собственную версию Swift, но фиксация разблокирует вас сегодня.

### 6. Удалите и пересоздайте настройки `ios/Runner.xcodeproj` только как последнее средство

Если вы редактировали `project.pbxproj` руками (добавляли нативные цели, кастомные фазы сборки, расширения App Clip) и ничего из вышеперечисленного не помогло, цель Runner может иметь устаревшие build settings, оставшиеся со времён до Xcode 16. Сделайте резервную копию `ios/Runner.xcodeproj`, а затем сравните её со свежесгенерированной:

```bash
# Flutter 3.41.5
flutter create --platforms=ios --project-name=runner /tmp/scratch
diff -r ios/Runner.xcodeproj /tmp/scratch/ios/Runner.xcodeproj
```

Перенесите релевантные build settings (`IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `ENABLE_USER_SCRIPT_SANDBOXING`, `STRING_CATALOG_GENERATE_SYMBOLS`) из черновикового проекта в свой по одной за раз, пересобирая между каждой. Это утомительно, но это также единственный надёжный способ восстановить проект, накопивший пять лет мусора от обновлений Xcode.

## Подводные камни и похожие случаи

Несколько случаев, которые выглядят как эта ошибка, но не являются ею:

- **`Sandbox: rsync deny file-write-create`**: Xcode 16 включил `ENABLE_USER_SCRIPT_SANDBOXING=YES` по умолчанию для новых проектов. `xcode_backend.sh` Flutter пишет вне песочницы. Установите `ENABLE_USER_SCRIPT_SANDBOXING=NO` в Build Settings цели Runner. Шаблон установщика Flutter с 3.24.4 это устанавливает, но проекты, созданные раньше, нет.
- **`Provisioning profile doesn't include the currently selected device`**: это вообще не сбой сборки Flutter. Нативный бинарник собрался нормально; провалился шаг установки. Смотрите [Provisioning profile doesn't include the currently selected device](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) -- статья про MAUI покрывает ту же первопричину на стороне Apple.
- **`Unable to find a valid iOS Simulator runtime`**: Xcode 15 перестал поставлять рантаймы Simulator; Xcode 16 их по-прежнему не поставляет. Запустите `xcodebuild -downloadPlatform iOS`. Подробная статья находится по [Unable to find a valid iOS Simulator runtime during MAUI build](/ru/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/) и применима к Flutter идентично.
- **`Xcode 26 update -- Clang dependency scanning failure: module 'Flutter' not found`**: это вариант для Xcode 26 (превью для разработчиков), отслеживаемый в [flutter/flutter#185210](https://github.com/flutter/flutter/issues/185210). Не выпускайте релизные сборки против Xcode 26 пока; оставайтесь на линии 16.x, пока Flutter не опубликует заметку о совместимости.
- **CI падает, но локальные сборки проходят**: ваш CI на более старом образе Xcode. Образ `macos-14` GitHub Actions содержит Xcode 15.4; вам нужен `macos-15` (или явно `macos-15-large`) для Xcode 16. Зафиксируйте образ runner и выберите версию Xcode командой `sudo xcode-select -s /Applications/Xcode_16.app`. Если вы также жонглируете несколькими версиями Flutter в CI, [паттерн матрицы для Flutter на subosito/flutter-action](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) показывает, как держать сборку зелёной на разных версиях.
- **`No such module 'Flutter'` только в цели watchOS или App Clip**: фреймворк Flutter не встраивается в сопутствующие цели по умолчанию. Вы должны добавить фазу Run Script, которая копирует `Flutter.framework` во встроенные бинарники, или использовать настройку проекта [add-to-app](https://docs.flutter.dev/add-to-app/ios/project-setup). Это задокументировано в [flutter/flutter#164597](https://github.com/flutter/flutter/issues/164597) для случая Apple Watch.
- **`flutter clean` удалил `ios/Flutter/Generated.xcconfig` и теперь ничего не собирается**: это ожидаемо. Запустите `flutter pub get` для регенерации. Если `flutter pub get` успешен, но файл не регенерируется, ваш `pubspec.yaml` не объявляет iOS как платформу; добавьте `flutter:` `plugin:` `platforms:` `ios:` или запустите `flutter create --platforms=ios .`.

Если вы дважды прошли шаги 1-5 и всё ещё видите ту же ошибку, следующий ход бисекция плагинов. Закомментируйте каждую прямую зависимость в `pubspec.yaml`, кроме `flutter` и `cupertino_icons`, запустите цикл сноса и сборки и подтвердите, что пустой проект собирается. Затем раскомментируйте зависимости группами по три. Первая группа, которая снова приведёт к сбою, содержит виновный плагин. Это медленно, но детерминированно и даёт вам готовый к подаче баг-репорт.

## Связанное

- [Исправление: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Исправление: Provisioning profile doesn't include the currently selected device (MAUI iOS)](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)
- [Исправление: Unable to find a valid iOS Simulator runtime during MAUI build](/ru/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)
- [Как нацелиться на несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Отладка Flutter iOS из Windows: рабочий процесс с реальным устройством](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)

## Источники

- [flutter/flutter#155438: After updating to xCode 16, Failed to build iOS app in Flutter 3.19.5](https://github.com/flutter/flutter/issues/155438)
- [flutter/flutter#157461: Xcode 16 and iOS 18 project not compiling: ModuleCache.noindex error](https://github.com/flutter/flutter/issues/157461)
- [flutter/flutter#155873: No such module 'Flutter' after updating to Xcode 16](https://github.com/flutter/flutter/issues/155873)
- [flutter/flutter#164597: Flutter 3.29.0 + Xcode 16 build failure with Apple Watch target](https://github.com/flutter/flutter/issues/164597)
- [flutter/flutter#185210: Xcode 26 update -- Clang dependency scanning failure](https://github.com/flutter/flutter/issues/185210)
- [Flutter add-to-app iOS project setup](https://docs.flutter.dev/add-to-app/ios/project-setup) (docs.flutter.dev)
- [CocoaPods 1.16.x changelog](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
