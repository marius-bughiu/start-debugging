---
title: "Flutter 3.44 выносит Material и Cupertino из SDK и делает SwiftPM умолчанием"
description: "Flutter 3.44 stable замораживает Material и Cupertino внутри SDK и направляет новую работу в пакеты material_ui и cupertino_ui на pub.dev. SwiftPM также становится умолчанием для iOS и macOS, наконец отправляя CocoaPods на покой."
pubDate: 2026-05-16
tags:
  - "flutter"
  - "dart"
  - "swiftpm"
  - "material-design"
lang: "ru"
translationOf: "2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default"
translatedBy: "claude"
translationDate: 2026-05-16
---

Flutter 3.44 на этой неделе попал в стабильный канал, и главная новость скорее структурная, чем визуальная. Библиотеки Material и Cupertino больше не привязаны к поезду релизов SDK. Каноническим домом для `package:flutter/material.dart` и `package:flutter/cupertino.dart` отныне становятся два новых пакета на pub.dev, `material_ui` и `cupertino_ui`, а копии внутри SDK уходят в длинное окно депрекации. Одновременно `flutter config --enable-swift-package-manager` становится новым умолчанием для сборок iOS и macOS, что наконец позволяет убрать Ruby и CocoaPods из свежей установки Flutter.

## Почему UI-библиотеки уходят из SDK

Material и Cupertino всегда поставлялись в собственном трёхмесячном ритме Flutter. Это значило, что каждая правка токена Material 3, каждое исправление клавиатуры в Cupertino и каждый новый аргумент `MenuAnchor` ждали следующего квартального среза. С переходом на самостоятельные пакеты эти команды получают свой ритм релизов. Зафиксируйте `material_ui: ^1.0.0` в `pubspec.yaml` и вы будете получать обновления Material сразу, как только они появятся на pub.dev, независимо от того, на какой версии Dart SDK сейчас ваш CI.

Миграция намеренно сделана с низким трением. В 3.44 существующие импорты по-прежнему работают, но вы увидите предупреждение о депрекации на `package:flutter/material.dart`. Рекомендованная замена механическая:

```dart
// Before (still works in 3.44, deprecated)
import 'package:flutter/material.dart';

// After (new home on pub.dev)
import 'package:material_ui/material_ui.dart';
```

Добавьте пакет обычным способом:

```yaml
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
  cupertino_ui: ^1.0.0
```

Эффект второго порядка это размер бинарника. Приложения, использующие только Cupertino, смогут перестать тащить темизацию, типографику и набор иконок Material в дерево-шейкнутый бандл, как только копии в SDK будут удалены в будущем релизе. Сами [release notes к 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0) называют это "code freeze" встроенных библиотек: только багфиксы, никаких новых API.

## SwiftPM теперь умолчание на iOS и macOS

Второй крупный переключатель в том, что `flutter config --enable-swift-package-manager` теперь включён по умолчанию для новых проектов. `flutter create` больше не генерирует `Podfile`. Плагины, разрешённые через pub, всё ещё получают шим `Package.swift`, а Xcode открывает проект напрямую как граф пакетов Swift. Для существующих приложений путь обновления короткий:

```sh
flutter upgrade
flutter config --enable-swift-package-manager
cd ios && rm -rf Pods Podfile.lock
flutter run -d ios
```

CocoaPods не удалён, он остаётся как fallback, если вы откажетесь от опции или если плагин не опубликовал `Package.swift`. Предупреждения о депрекации теперь отмечают плагины, которые всё ещё поставляют только Pods.

## Что ещё попало в 3.44

Релиз также вводит `Form.clearError()` для сброса состояния валидации без перестроения формы, `RoundedSuperellipseInputBorder` для полей ввода в стиле iOS, окна тултипов на Win32, macOS и Linux, и поддержку predictive back для `FlutterFragment` и `FlutterFragmentActivity` на Android. Есть что покопать, но именно разделение на пакеты первым перекроит файлы `pubspec.yaml` по экосистеме.

Если вы сопровождаете Flutter-пакет, реэкспортирующий виджеты Material или Cupertino, самое время добавить `material_ui` в dev dependencies и начать публиковать импорты в двух вариантах. Предупреждения о депрекации станут громче быстро.
