---
title: "Как поднять минимальную целевую версию развёртывания macOS-приложения на Flutter до macOS 12 для Xcode 27"
description: "Xcode 27 отказывается собирать всё, что ниже macOS 12, а Flutter 3.47 поднял собственный минимум с 10.15 до 12.0. Что переписывает автоматическая миграция, три места, которые она молча пропускает (нестандартные значения, переопределения в post_install в Podfile, podspec плагинов), и исправление Podfile для команд, которые пока остаются на Flutter 3.44."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "macos"
  - "xcode"
  - "cocoapods"
lang: "ru"
translationOf: "2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27"
translatedBy: "claude"
translationDate: 2026-09-18
---

Для большинства macOS-приложений на Flutter это работа на пять минут: обновитесь до Flutter 3.47 или новее (текущий stable 3.47.4, Dart 3.13.3), один раз запустите `flutter build macos` и закоммитьте три строки, которые инструмент переписывает в `macos/Runner.xcodeproj/project.pbxproj`, плюс строку `platform :osx` в `macos/Podfile`. Миграция распознаёт только те точные стандартные значения, которые Flutter когда-либо генерировал (10.11, 10.13, 10.14, 10.15, 11.0), поэтому проект, в котором кто-то вручную выставил `11.5` или `10.14.6`, блок `post_install` в Podfile, закрепляющий поды на старой версии, или устаревший podspec плагина переживут её, а затем упадут на Xcode 27 с ошибкой `The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to ..., but the range of supported deployment target versions is 12.0 to 27.0.x`. Всё описанное ниже проверено на Mac с Xcode 26.6, Flutter 3.44.8 и 3.47.4, а также CocoaPods 1.17.0.

## Почему поднялся минимум

Apple подняла минимальную целевую версию развёртывания macOS в Xcode 27 с macOS 11 до macOS 12 (для iOS она остаётся 15, для watchOS растёт с 8 до 9). Xcode 27 стал общедоступным в середине сентября 2026 года, так что образы CI и машины разработчиков переходят на него прямо сейчас. Ниже этого минимума Xcode 27 не выдаёт предупреждение и не подтягивает значение, как делали прежние версии: он останавливает сборку с ошибкой целостности target.

Политика Flutter состоит в том, чтобы [соответствовать диапазону развёртывания текущего Xcode](https://flutter.dev/go/match-xcode-deployment-range), поэтому команда завела [flutter/flutter#187762](https://github.com/flutter/flutter/issues/187762) и влила [flutter/flutter#188520](https://github.com/flutter/flutter/pull/188520) (слит 2026-06-29), который вошёл в 3.47.0. Он делает три вещи:

- `FlutterDarwinPlatform.macos.deploymentTarget()` в `flutter_tools` теперь возвращает `12.0` вместо `10.15`. Это значение определяет сгенерированный пакет SwiftPM, шаблоны плагинов и podspec для `FlutterMacOS`.
- `FlutterMacOS.framework` движка собирается под macOS 12. В моей сборке 3.44.8 его `LC_BUILD_VERSION` показывает `minos 11.0`, а в сборке 3.47.4 показывает `minos 12.0`.
- `MacOSDeploymentTargetMigration` и `podhelper.rb` обновлены так, чтобы переводить существующие проекты на `12.0`.

Второй пункт важен, даже если вы никогда не установите Xcode 27. Приложение на Flutter 3.47, которое по-прежнему заявляет поддержку macOS 11, даёт обещание, которое бинарник движка выполнить не может.

## Что ломается

| Область | Изменение | Серьёзность |
| ---- | ------ | -------- |
| `MACOSX_DEPLOYMENT_TARGET` ниже 12.0 в `Runner` | Ошибка сборки на Xcode 27 | высокая, автоматическая миграция для стандартных значений |
| `platform :osx` ниже 12.0 в `macos/Podfile` | Поды собираются под старую версию, ошибка на Xcode 27 | высокая, автоматическая миграция для стандартных значений |
| `post_install` в Podfile, задающий `MACOSX_DEPLOYMENT_TARGET` для подов | Переопределения переживают миграцию, ошибка на Xcode 27 | высокая, ручное исправление |
| podspec плагина или `Package.swift` с версией ниже 12.0 | Обрабатывается `podhelper.rb` (3.47+) и сгенерированным пакетом SwiftPM | низкая для авторов приложений, наведение порядка для авторов плагинов |
| Пользователи на macOS 10.15 и 11 | Не могут установить новые сборки (`LSMinimumSystemVersion` становится 12.0) | продуктовое решение |

Последняя строка единственная, которая не является проблемой сборки. `macos/Runner/Info.plist` задаёт `LSMinimumSystemVersion` как `$(MACOSX_DEPLOYMENT_TARGET)`, поэтому в момент изменения этой настройки сборки App Store и механизмы обновления в стиле Sparkle перестают предлагать новую версию машинам на Catalina и Big Sur. Проверьте аналитику перед релизом и предупредите поддержку.

## Чек-лист перед началом

- Flutter 3.47.0 или новее на каждой машине и каждом CI-раннере, которые собирают macOS-target. `flutter --version` должен выводить `3.47.x` или новее.
- Чистое рабочее дерево в `macos/`, чтобы diff миграции можно было просмотреть отдельно.
- CocoaPods 1.16 или новее, если вы всё ещё используете CocoaPods для macOS-плагинов (здесь использовался 1.17.0).
- Список всех мест, где ваш репозиторий задаёт версию macOS. Эта однострочная команда их находит:

```bash
# Flutter 3.47.4, run from the project root
grep -rnE "MACOSX_DEPLOYMENT_TARGET|platform :osx|osx.deployment_target|\.macOS\(" \
  macos/ --include='*.pbxproj' --include='Podfile' --include='*.xcconfig' \
  --include='*.podspec' --include='Package.swift'
```

## Шаги миграции

1. Обновите SDK командой `flutter upgrade` (или закрепите 3.47.4 в конфигурации FVM или CI), затем выполните `flutter clean`. Убедитесь с помощью `flutter --version`, что инструмент сообщает 3.47.x или новее.
2. Один раз запустите `flutter build macos --debug`. Инструмент выполняет `MacOSDeploymentTargetMigration` перед `pod install` и ровно один раз выводит `Updating minimum macOS deployment target to 12.0.`. Убедитесь с помощью `git diff --stat macos/`, что `project.pbxproj` и `Podfile` изменились.
3. Повторно выполните grep из чек-листа и убедитесь, что ни в `Runner`, ни в `RunnerTests`, ни в дополнительных target, ни в файлах `.xcconfig`, ни в Podfile не осталось ничего ниже 12.0. Всё, что миграция пропустила, исправьте вручную (подробности ниже).
4. Удалите или обновите блок `post_install` в Podfile, который записывает `MACOSX_DEPLOYMENT_TARGET` в target подов, затем снова запустите `flutter build macos --debug`. Убедитесь с помощью `grep MACOSX_DEPLOYMENT_TARGET macos/Pods/Pods.xcodeproj/project.pbxproj | sort | uniq -c`, что каждое значение равно 12.0 или выше.
5. Проверьте итоговый бинарник: `plutil -p` для `Contents/Info.plist` собранного приложения должен показывать `LSMinimumSystemVersion => 12.0`, а `otool -l` для исполняемого файла должен показывать `minos 12.0`.
6. Переключите CI на образ с Xcode 27 и выполните релизную сборку (`flutter build macos --release`). Только этот шаг доказывает, что проект собирается на Xcode 27.

## Что на самом деле переписывает миграция

На проекте, созданном Flutter 3.44.8 (который везде генерирует 10.15), с добавленным `url_launcher` и включённым CocoaPods первая сборка на 3.47.4 вывела строку статуса и дала ровно такой diff в двух файлах, которыми она управляет:

```diff
# macos/Podfile (Flutter 3.47.4 migration)
-platform :osx, '10.15'
+platform :osx, '12.0'

# macos/Runner.xcodeproj/project.pbxproj (Debug, Release, Profile)
-				MACOSX_DEPLOYMENT_TARGET = 10.15;
+				MACOSX_DEPLOYMENT_TARGET = 12.0;
```

Затем сборка прошла успешно, и каждый `MACOSX_DEPLOYMENT_TARGET` в `Pods.xcodeproj` был равен 12.0, хотя `url_launcher_macos` 3.2.6 по-прежнему объявляет в своём podspec `s.platform = :osx, '10.15'`. Это работа `podhelper.rb`: `flutter_additional_macos_build_settings` удаляет собственную целевую версию развёртывания пода, если её мажорная версия ниже 12, и под наследует платформу из Podfile. До 3.47 порог был 10.15, поэтому под, объявляющий 10.15, сохранял своё значение. Именно из-за этого проекты на Flutter 3.44 падают на Xcode 27 даже после правки target Runner (см. последний раздел).

С SwiftPM (по умолчанию начиная с Flutter 3.44 для проектов без явного отказа) миграция тоже переводит target Runner, а инструмент заново генерирует `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift` на основе `MACOSX_DEPLOYMENT_TARGET` из Runner. В моём запуске значение сменилось с `.macOS("10.15")` на `.macOS("12.0")` при первой сборке на 3.47.4. `Package.swift` внутри `url_launcher_macos` по-прежнему содержит `.macOS("10.15")`, и на Xcode 26.6 это собиралось без проблем. Запустить Xcode 27 на этой машине я не смог, поэтому не проверял, собираются ли там без ошибок манифесты плагинов с версией ниже 12.0.

## Подвох 1: вручную заданная версия невидима для миграции

Мигратор выполняет построчную замену строк. Согласно `macos_deployment_target_migration.dart` на теге `3.47.4`, он ищет только эти литеральные строки и ничего больше:

```dart
// flutter_tools 3.47.4, lib/src/macos/migrations/macos_deployment_target_migration.dart
const deploymentTargetOriginal1015 = 'MACOSX_DEPLOYMENT_TARGET = 10.15;';
const deploymentTargetOriginal110 = 'MACOSX_DEPLOYMENT_TARGET = 11.0;';
const podfilePlatformVersionOriginal1015 = "platform :osx, '10.15'";
const podfilePlatformVersionOriginal110 = "platform :osx, '11.0'";
// ...plus 10.11, 10.13 and 10.14 in both forms
```

Поэтому `11.5`, `10.14.6`, `11.0.1`, значение, заданное в `.xcconfig`, или `platform :osx, "10.15"` в двойных кавычках остаются нетронутыми, без каких-либо сообщений. Я выставил target Runner и Podfile на 11.5 и собрал на 3.47.4. Строки `Updating minimum macOS deployment target` не появилось, `git status` не показал изменений ни в одном из файлов, а сборка на Xcode 26.6 всё равно прошла, с предупреждениями компоновщика, которые легко пролистать:

```text
ld: warning: building for macOS-11.5, but linking with dylib
'@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS' which was built for newer version 12.0
```

У получившегося приложения `LSMinimumSystemVersion` 11.5 и `minos 11.5`, при этом оно поставляется с движком, собранным под 12.0. На Xcode 27 тот же проект просто падает. Исправление: задать значение вручную в Xcode (проект Runner, target Runner, General, Minimum Deployments) или прямо в файле:

```bash
# Flutter 3.47.4 project, replace any leftover value below 12.0
sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = (10\.[0-9.]+|11\.[0-9.]+);/MACOSX_DEPLOYMENT_TARGET = 12.0;/' \
  macos/Runner.xcodeproj/project.pbxproj
sed -i '' -E "s/platform :osx, ['\"][0-9.]+['\"]/platform :osx, '12.0'/" macos/Podfile
```

Поднять платформу в Podfile так же важно, как и target Runner. Когда я оставил Runner на 10.14.6, а Podfile на 11.5, даже Xcode 26.6 остановился с ошибкой `compiling for macOS 10.14.6, but module 'url_launcher_macos' has a minimum deployment target of macOS 11.5` в `GeneratedPluginRegistrant.swift`. Держите эти два значения синхронными.

## Подвох 2: переопределения в post_install в Podfile выживают

Распространённый копипаст времён Xcode 14 принудительно выставляет всем подам одну версию:

```ruby
# macos/Podfile, a pattern that breaks on Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '10.14'
    end
  end
end
```

Миграция изменила строку `platform :osx` в этом Podfile и вывела своё сообщение о статусе, так что всё выглядит завершённым. После сборки `Pods.xcodeproj` содержал 15 записей `MACOSX_DEPLOYMENT_TARGET = 10.14;` и лишь 3 со значением 12.0: переопределение выполняется после `flutter_additional_macos_build_settings` и побеждает. Xcode 26.6 молча собрал эти поды под macOS 11.0 (свой собственный минимум), поэтому никто этого не замечает. Xcode 27 вместо этого выдаёт ошибку на каждом из них.

Удалите внутренний цикл. Если поду действительно нужна закреплённая версия, закрепите её на `12.0` или выше, но никогда не ниже платформы из Podfile.

## Подвох 3: понятная ошибка с подсказкой есть только начиная с 3.47

Когда Xcode отклоняет target, Flutter 3.47 распознаёт строку (логика сопоставления появилась в [flutter/flutter#188812](https://github.com/flutter/flutter/pull/188812) по мотивам [flutter/flutter#187855](https://github.com/flutter/flutter/issues/187855)) и выводит сообщение в рамке:

```text
The macOS deployment target is too low. Xcode requires at least 12.0.

To upgrade your macOS deployment target, follow these steps:
  1. Open the project in Xcode:
     open macos/Runner.xcworkspace
  2. Select the "Runner" project in the project navigator.
  3. Select the "Runner" TARGET, and in the "General" tab:
     Update "Minimum Deployments" to at least 12.0.
```

Есть две оговорки. Сообщение срабатывает, только если строка с ошибкой упоминает `MACOSX_DEPLOYMENT_TARGET` и поддерживаемый диапазон, а совет касается только target Runner, поэтому при ошибке в target пода (подвох 2) предлагаемое исправление не то, что вам нужно. А в Flutter 3.44 и более ранних такой обработки нет вовсе: вы получаете `Build process failed` плюс необработанную строку Xcode, которая в тестовых фикстурах этого PR выглядит так: `error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.11, but the range of supported deployment target versions is 12.0 to 27.0.x. (in target 'Runner' from project 'Runner')`. Суффикс `(in target '...')` подсказывает, какой target нужно исправить.

## Как остаться на Flutter 3.44 с Xcode 27

Иногда обновить Flutter на этой неделе невозможно, а образ CI уже перешёл на Xcode 27. Проект можно поднять вручную, но `podhelper.rb` в 3.44 удаляет целевые версии развёртывания подов только ниже 10.15, поэтому поды, объявляющие версии от 10.15 до 11.x, сохраняют свои значения. На проекте 3.44.8, где Runner и Podfile были вручную выставлены на 12.0, в `Pods.xcodeproj` всё ещё оставалось 9 записей со значением `10.15`. Это дополнение к `post_install` удалило их все, и каждый под остался с унаследованным 12.0:

```ruby
# macos/Podfile, Flutter 3.44.x workaround for Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      pod_target = config.build_settings['MACOSX_DEPLOYMENT_TARGET']
      if pod_target && Gem::Version.new(pod_target) < Gem::Version.new('12.0')
        config.build_settings.delete 'MACOSX_DEPLOYMENT_TARGET'
      end
    end
  end
end
```

Удаление вместо перезаписи это тот же приём, который использует Flutter 3.47: под наследует более высокое значение из проекта, а под, которому действительно нужно что-то новее 12.0, сохраняет собственное требование. Фреймворк движка в 3.44 собран под macOS 11, так что это не меняет того, на чём может запускаться ваш бинарник, а лишь удовлетворяет Xcode 27. Удалите этот блок, как только перейдёте на 3.47, поскольку он станет избыточным.

## Для авторов плагинов

Если вы публикуете macOS-плагин, поднимите в следующем релизе podspec (`s.platform = :osx, '12.0'` или `s.osx.deployment_target = '12.0'`) и платформу в `Package.swift` (`.macOS("12.0")`), а также поднимите ограничение `environment: flutter:` до `>=3.47.0`, если вы полагаетесь на что-то из этого релиза. Приложения на 3.47 уже защищены `podhelper.rb`, так что это скорее гигиена, чем срочная мера, но так ваш плагин перестанет появляться как ложное срабатывание в чьём-то `grep`, а шаблоны плагинов 3.47 в любом случае генерируют 12.0.

## Проверка

- `flutter build macos --release` проходит успешно на раннере с Xcode 27.
- `grep -rn MACOSX_DEPLOYMENT_TARGET macos/ --include='*.pbxproj' --include='*.xcconfig'` не показывает ничего ниже 12.0, включая `macos/Pods/Pods.xcodeproj/project.pbxproj`.
- `plutil -p build/macos/Build/Products/Release/<App>.app/Contents/Info.plist | grep LSMinimumSystemVersion` выводит `12.0`.
- В журнале сборки нет предупреждений `building for macOS-11.x, but linking with dylib ... built for newer version 12.0`.
- Приложение запускается на самой старой macOS, на которой вы ещё тестируете (12.x, если у вас есть для неё машина или виртуальная машина).

## План отката

Изменение исходников обратимо через `git revert`, а вот Flutter SDK нет: начиная с 3.47 движок собирается под macOS 12, и инструмент будет заново запускать миграцию при следующей сборке каждый раз, когда увидит стандартное значение ниже 12.0. Вернуться к поддержке macOS 10.15 или 11 означает остаться на Flutter 3.44.x и Xcode 26, которые Apple перестанет принимать для отправки в App Store, как только начнёт требовать SDK macOS 27. Считайте этот переход односторонним и примите решение о поддержке macOS 11 явно до слияния.

## Связанные материалы

- Android-часть того же обновления до 3.47: [миграция Android-проекта на Flutter на AGP 9 со встроенным Kotlin](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- Что ещё изменилось для десктопа в этом релизе: [Flutter 3.47 делает Impeller рендерером по умолчанию на десктопе](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Почему ваш проект может использовать SwiftPM, хотя вы этого не выбирали: [Flutter 3.44 по умолчанию использует SwiftPM](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Когда проблема с Podfile связана с разрешением версий, а не с целевыми версиями развёртывания: [исправление "CocoaPods could not find compatible versions for pod"](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- Предыдущий раунд той же истории на iOS: [исправление "Failed to build iOS app" с Xcode 16 и Flutter 3.x](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Источники

- [flutter/flutter#187762: Increase macOS minimum supported version from 10.15 to 12 to support Xcode 27](https://github.com/flutter/flutter/issues/187762)
- [flutter/flutter#188520: изменение SDK, шаблонов, podhelper и миграции](https://github.com/flutter/flutter/pull/188520)
- [flutter/flutter#188812: сообщение с подсказкой, когда минимальная версия слишком низкая](https://github.com/flutter/flutter/pull/188812)
- [`macos_deployment_target_migration.dart` на 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/macos/migrations/macos_deployment_target_migration.dart)
- [`podhelper.rb` на 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/bin/podhelper.rb)
- [Примечания к выпуску Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [Примечания к выпуску Xcode 27](https://developer.apple.com/go/?id=xcode-27-sdk-rn)
