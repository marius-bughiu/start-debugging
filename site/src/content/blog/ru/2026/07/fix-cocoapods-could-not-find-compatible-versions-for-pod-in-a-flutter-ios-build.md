---
title: "Решение: CocoaPods could not find compatible versions for pod при сборке Flutter под iOS"
description: "Читайте вторую строку ошибки, а не первую. Именно она называет причину: устаревший Podfile.lock, слишком низкий deployment target или два плагина, фиксирующих один транзитивный pod."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "cocoapods"
lang: "ru"
translationOf: "2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-07-31
---

Решение целиком зависит от строки прямо под ошибкой, и вариантов всего четыре. Если там `In snapshot (Podfile.lock)`, удалите `ios/Podfile.lock` и выполните `pod install`. Если там сказано, что спецификации `required a higher minimum deployment target`, поднимите `platform :ios` в вашем `Podfile`. Если перечислены два плагина, каждый из которых разрешается в свою точную версию одного и того же pod, это настоящий конфликт, и чинится он в `pubspec.yaml`, а не в `Podfile`. Только четвёртый случай, действительно устаревший репозиторий спецификаций, лечится командой `pod repo update`. Запуск `pod repo update` первым делом, что делает почти каждый, тратит две минуты в тех трёх случаях, где он помочь не может.

Статья написана для Flutter 3.44.7 (stable, июль 2026), CocoaPods 1.17.0 (выпущен 2026-07-06), Dart 3.12 и Xcode 16.x на macOS Sequoia.

## Ошибка в контексте

Самая частая форма, возникающая сразу после `flutter pub upgrade`, поднявшего плагин Firebase:

```text
[!] CocoaPods could not find compatible versions for pod "Firebase/CoreOnly":
  In snapshot (Podfile.lock):
    Firebase/CoreOnly (= 10.28.0)

  In Podfile:
    firebase_core (from `.symlinks/plugins/firebase_core/ios`) was resolved to 3.4.0, which depends on
      Firebase/CoreOnly (= 11.0.0)

You have either:
 * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.
 * changed the constraints of dependency `Firebase/CoreOnly` inside your development pod `firebase_core`.
   You should run `pod update Firebase/CoreOnly` to apply changes you've made.

Error running pod install
Error launching application on iPhone 16 Pro.
```

Вторая форма, которая выглядит той же ошибкой, но ею не является:

```text
[!] CocoaPods could not find compatible versions for pod "sqflite_darwin":
  In Podfile:
    sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)

Specs satisfying the `sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)` dependency were
found, but they required a higher minimum deployment target.
```

Обе начинаются с одной и той же заголовочной строки, и именно поэтому результаты поиска по этой ошибке представляют собой мешанину противоречивых советов. Дальше первой строки у них нет ничего общего.

## Почему CocoaPods сообщает об этом вместо того, чтобы просто выбрать версию

CocoaPods разрешает зависимости через Molinillo, решатель с возвратом в стиле SAT. Ему передают набор ограничений и просят найти по одной версии каждого pod, которая удовлетворяет им всем одновременно. Исчерпав пространство поиска без решения, он не гадает. Он печатает ограничения, которые оставались в конфликте на момент отказа, плюс шаблонный список причин, иногда вызывающих конфликты.

Этот список шаблонный в буквальном смысле. Он печатается независимо от того, применим он или нет. Диагностическое содержимое находится в блоке с отступом выше него, где названо каждое ограничение и его источник. Невыполнимое ограничение в этот набор помещают четыре вещи:

1. **`Podfile.lock` фиксирует старую точную версию.** Файл блокировки участвует в разрешении как ограничение с пометкой `In snapshot (Podfile.lock)`. Обновление плагина на стороне Dart изменило требования podspec, а блокировка продолжает настаивать на старом номере. С большим отрывом самая частая причина.
2. **Всем версиям-кандидатам нужен более высокий deployment target, чем объявлен в вашем `Podfile`.** Molinillo отфильтровывает спецификации, у которых `deployment_target` превышает вашу строку платформы, а затем сообщает о пустом наборе кандидатов. Это вариант `required a higher minimum deployment target`.
3. **Два плагина фиксируют несовместимые точные версии общего транзитивного pod.** Настоящий ромб зависимостей. Никакая правка `Podfile` его не решает, потому что ограничение исходит из двух podspec, которые Flutter сгенерировал из вашего `pubspec.yaml`.
4. **Репозиторий спецификаций старше запрашиваемой версии.** Актуально, только если вы используете репозиторий спецификаций на базе git. CDN-источник, который использует стандартный `Podfile` от Flutter, в `pod repo update` не нуждается.

## Минимальное воспроизведение

Случай 1 воспроизводится тремя командами в любом проекте с плагином, у которого зафиксирована нативная зависимость:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter create podconflict && cd podconflict
flutter pub add firebase_core:3.1.0 && (cd ios && pod install)
flutter pub add firebase_core:3.4.0 && (cd ios && pod install)   # boom
```

Первый `pod install` записывает `Firebase/CoreOnly (= 11.0.0)` в `ios/Podfile.lock`. Второй `flutter pub add` меняет плагин на тот, чей podspec требует другую точную версию, и ограничение из файла блокировки становится невыполнимым относительно нового podspec.

Случай 2 воспроизводится понижением строки платформы ниже того, что нужно плагину:

```ruby
# ios/Podfile -- Flutter 3.44.7, CocoaPods 1.17.0
platform :ios, '12.0'
```

с плагином, чей podspec объявляет:

```ruby
# .symlinks/plugins/sqflite_darwin/darwin/sqflite_darwin.podspec
s.platform = :ios, '13.0'
```

## Решение по порядку приоритета

### 1. Если в ошибке есть `In snapshot (Podfile.lock)`, удалите блокировку

Файл блокировки представляет собой кеш предыдущего разрешения, а не источник истины. Flutter при каждой сборке заново строит весь граф pod из `pubspec.lock`, поэтому `ios/Podfile.lock`, расходящийся с ним, по определению устарел и авторитетом не является.

```bash
# Flutter 3.44.7, CocoaPods 1.17.0 -- run from the repo root
flutter pub get
cd ios
rm Podfile.lock
pod install
```

Обратите внимание на порядок. `flutter pub get` должен выполняться первым, поскольку именно он переписывает `ios/.symlinks/plugins/`, чтобы каталог указывал на разрешённые версии плагинов в кеше pub. Запуск `pod install` до него разрешает podspec тех версий плагинов, что лежали там в прошлый раз, что даёт ту же ошибку с другими числами и отправляет вас по кругу.

Если плагин ваш собственный или вам нужна точечная правка вместо полного пересчёта:

```bash
# CocoaPods 1.17.0 -- surgical alternative, keeps other pins intact
cd ios && pod update Firebase/CoreOnly
```

В приложении на Flutter предпочтительнее удалить блокировку. `pod update <pod>` уместен в написанном вручную iOS-проекте, где файл блокировки кодирует осознанные фиксации; в приложении на Flutter эти фиксации пришли из `pubspec.lock`, и оттуда же они должны приходить дальше.

### 2. Если в ошибке есть `higher minimum deployment target`, поднимите платформу в двух местах

Это нужно и `Podfile`, и проекту Xcode. Правка только `Podfile` чинит разрешение pod, а затем падает позже на этапе компоновки, потому что собственная настройка сборки цели `Runner` всё ещё объявляет старую нижнюю границу.

```ruby
# ios/Podfile -- Flutter 3.44.7
platform :ios, '15.0'
```

```ruby
# ios/Podfile -- force every pod target to inherit the same floor
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
```

Затем задайте то же и для цели приложения. Откройте `ios/Runner.xcworkspace`, выберите цель `Runner`, перейдите в `Build Settings` и установите `iOS Deployment Target` в то же значение для Debug и Release. Для самого `Runner` настройка workspace побеждает `Podfile`; строка в `Podfile` управляет только целями pod.

Не подбирайте число перебором. Считайте его из podspec, на котором произошёл сбой:

```bash
# Flutter 3.44.7 -- print the floor the failing plugin actually declares
grep -r "s.platform\|deployment_target" ios/.symlinks/plugins/sqflite_darwin/darwin/*.podspec
```

Поднятие нижней границы отсекает старые устройства, поэтому поднимайте ровно до того, что требует podspec, а не до самой новой установленной у вас версии iOS.

### 3. Если два плагина фиксируют один pod на разные точные версии, правьте `pubspec.yaml`

Это тот случай, когда любая правка `Podfile` и любая очистка кеша бесполезны, потому что конфликт лежит выше CocoaPods. Признак: две строки `was resolved to`, называющие два разных плагина:

```text
[!] CocoaPods could not find compatible versions for pod "GTMSessionFetcher/Core":
  In Podfile:
    firebase_auth (from `.symlinks/plugins/firebase_auth/ios`) was resolved to 5.1.0, which depends on
      GTMSessionFetcher/Core (~> 3.3)
    google_sign_in_ios (from `.symlinks/plugins/google_sign_in_ios/darwin`) was resolved to 5.7.6, which depends on
      GTMSessionFetcher/Core (< 3.0, >= 1.1)
```

`~> 3.3` и `< 3.0` не пересекаются. Найдите версии плагинов, чьи podspec согласуются между собой, и зафиксируйте их в `pubspec.yaml`:

```yaml
# pubspec.yaml -- Flutter 3.44.7, Dart 3.12
dependencies:
  firebase_auth: ^5.1.0
  google_sign_in: ^6.2.2   # 6.2.2 ships google_sign_in_ios 5.7.7+, which allows GTMSessionFetcher 3.x
```

Затем пересчитайте оба слоя:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter pub get
cd ios && rm Podfile.lock && pod install
```

Вместо этого можно навязать версию транзитивного pod прямо из `Podfile`:

```ruby
# ios/Podfile -- last resort, use only to unblock while waiting on a plugin release
pod 'GTMSessionFetcher/Core', '3.4.1'
```

Считайте это временной заплаткой со сроком годности. Она перекрывает ограничение, которое автор плагина написал намеренно, и сборка будет проходить чисто ровно до того момента, когда приложение упадёт в среде выполнения из-за отсутствующего селектора.

Если сам `flutter pub get` падает ещё до того, как вы дошли до CocoaPods, у вас проблема разрешения на стороне Dart, а не нативная, и читать нужно другие ограничения: см. [почему "Version solving failed" это доказательство, а не баг](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 4. И только потом обновляйте репозиторий спецификаций

```bash
# CocoaPods 1.17.0
cd ios && pod install --repo-update
```

Это помогает ровно в одной ситуации: вы используете репозиторий спецификаций на базе git (`source 'https://github.com/CocoaPods/Specs.git'` в вашем `Podfile`), и ваш локальный клон старше запрашиваемой версии. Сгенерированный Flutter `Podfile` по умолчанию использует CDN-источник, который запрашивает версии по HTTP для каждого pod и в этом смысле никогда не устаревает. Если строку `source` вы не меняли, `--repo-update` не делает ничего полезного и стоит вам полного клонирования спецификаций.

## Подводные камни и похожие ошибки

**`flutter clean` не трогает `Podfile.lock`.** Он очищает `build/` и `.dart_tool/`. `ios/Podfile.lock` и `ios/Pods/` переживают его нетронутыми, поэтому "я уже выполнял flutter clean" остаётся самым частым ложным следом при этой ошибке. Радикальный вариант, который действительно очищает состояние iOS:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter clean
cd ios && pod deintegrate && rm -rf Pods Podfile.lock .symlinks
cd .. && flutter pub get
cd ios && pod install
```

**`arch -x86_64 pod install` устарел.** Этот обходной приём родом из 2021 года, когда у гема `ffi` не было бинарника под arm64. CocoaPods 1.17.0 на Ruby 3.x работает нативно на Apple Silicon. Префикс `arch -x86_64` сегодня принудительно запускает Ruby под Rosetta, где ваши гемы могут быть не установлены, и приводит к совершенно постороннему сбою.

**Плагин, перешедший на SwiftPM, в графе pod не появится вовсе.** С тех пор как [Flutter 3.44 сделал Swift Package Manager значением по умолчанию](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/), плагины, поставляющие `Package.swift`, разрешаются через SwiftPM, и CocoaPods их никогда не видит. Обычно именно поэтому эта ошибка исчезает после обновления. Это также означает, что конфликт, о котором вы читаете в ответе на StackOverflow от 2024 года, может уже не воспроизводиться, а фиксация pod в вашем `Podfile` ради плагина, который с тех пор мигрировал, тихо ничего не изменит. Проверьте, какой решатель владеет плагином, прежде чем городить обход:

```bash
# Flutter 3.44.7 -- if this file exists, the plugin is on SwiftPM, not CocoaPods
ls ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift
```

**`Error running pod install` без блока ограничений под ним это другая ошибка.** Если раздела с отступом `In Podfile:` нет, CocoaPods упал до разрешения, обычно из-за проблемы с окружением Ruby или Xcode, а не из-за конфликта версий. Это относится к [чек-листу сборки под iOS с Xcode 16](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/), а не сюда.

**Воспроизводимость в CI.** Хранить `ios/Podfile.lock` в репозитории правильно по умолчанию, но из-за этого случай 1 срабатывает в CI в первый же раз, когда кто-то в команде поднимает плагин, не выполнив `pod install` локально. Либо требуйте, чтобы оба файла блокировки менялись одним коммитом, либо зафиксируйте инструментарий, чтобы сбой был хотя бы детерминированным: см. [как нацеливаться на несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/). Android-сторона того же класса проблем разобрана в [сбое assembleDebug с exit code 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Срок, о котором стоит знать

Репозиторий спецификаций CocoaPods Trunk окончательно переходит в режим только для чтения 2026-12-02, с репетиционным отключением с 2026-11-01 по 2026-11-07. Существующие pod продолжат разрешаться, а CDN продолжит отдавать файлы, так что сборки не сломаются, но ни один pod больше никогда не опубликует новую версию. На практике: после этой даты случай 3 перестаёт решаться ожиданием. Если два плагина фиксируют несовместимые версии общего pod и ни один из них не выпустит исправленный podspec до декабря, никакой релиз сверху вас уже не спасёт, и остаются только два выхода: переопределение в `Podfile` или перевод плагина на SwiftPM. Оба стоит закладывать в план сейчас, а не в первом квартале.

## Источники

- [CocoaPods Trunk read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (блог CocoaPods)
- [Swift Package Manager for Flutter app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Заметки о выпусках Flutter](https://docs.flutter.dev/release/release-notes) (docs.flutter.dev)
- [Релизы CocoaPods](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
- [flutter/flutter#168660: could not find compatible versions for pod Firebase/CoreOnly](https://github.com/flutter/flutter/issues/168660) (flutter/flutter)
- [flutter/flutter#148116: could not find compatible versions for pod GTMSessionFetcher/Core](https://github.com/flutter/flutter/issues/148116) (flutter/flutter)
