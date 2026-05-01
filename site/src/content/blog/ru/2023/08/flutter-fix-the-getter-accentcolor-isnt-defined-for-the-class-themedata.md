---
title: "Flutter Исправляем 'The getter accentColor isn't defined for the class ThemeData'"
description: "Наиболее вероятная причина этой ошибки — обновление Flutter (flutter upgrade), которое привело к несовместимости с вашим кодом или зависимостями проекта. Свойство Theme.of(context).accentColor устарело начиная с Flutter 1.17 и полностью удалено в текущей версии, отсюда и ошибка. Чем заменить Или, если..."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "ru"
translationOf: "2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata"
translatedBy: "claude"
translationDate: 2026-05-01
---
```plaintext
Error: The getter 'accentColor' isn't defined for the class 'ThemeData'.
 - 'ThemeData' is from 'package:flutter/src/material/theme_data.dart' ('/C:/flutter/packages/flutter/lib/src/material/theme_data.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field named 'accentColor'.
        themeData.textTheme.headline5?.copyWith(color: themeData.accentColor);
```

Наиболее вероятная причина этой ошибки — обновление Flutter (`flutter upgrade`), которое привело к несовместимости с вашим существующим кодом или зависимостями проекта.

Свойство `Theme.of(context).accentColor` [помечено устаревшим начиная с Flutter 1.17](https://docs.flutter.dev/release/breaking-changes/theme-data-accent-properties) и полностью удалено в текущей версии, отсюда и ошибка.

## Чем заменить

```dart
Theme.of(context).colorScheme.secondary
```

Или, если вы настраиваете внешний вид material-компонентов:

```dart
final ThemeData theme = ThemeData();
MaterialApp(
  theme: theme.copyWith(
    colorScheme: theme.colorScheme.copyWith(secondary: myColor),
  ),
)
```

## Если проблема в зависимостях проекта

Ошибка может приходить не из вашего кода, а из одной из зависимостей проекта, например `material`. В этом случае можно попробовать обновить зависимости.

```bash
flutter pub upgrade
```

Это обновит зависимости в рамках ограничений `pubspec.yaml`. Если нужно выйти за эти ограничения (например, перейти на новую мажорную версию), просто:

```bash
flutter pub upgrade --major-versions
```
