---
title: "Flutter Beheben von 'The getter accentColor isn't defined for the class ThemeData'"
description: "Die wahrscheinlichste Ursache dieses Fehlers ist ein Flutter-Update (flutter upgrade), das zu einer Inkompatibilität mit Ihrem bestehenden Code oder den Projektabhängigkeiten geführt hat. Die Eigenschaft Theme.of(context).accentColor ist seit Flutter 1.17 deprecated und wurde in der aktuellen Version vollständig entfernt, daher der Fehler. Was stattdessen zu verwenden ist Oder, falls..."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "de"
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

Die wahrscheinlichste Ursache dieses Fehlers ist ein Flutter-Update (`flutter upgrade`), das zu einer Inkompatibilität mit Ihrem bestehenden Code oder den Projektabhängigkeiten geführt hat.

Die Eigenschaft `Theme.of(context).accentColor` [ist seit Flutter 1.17 deprecated](https://docs.flutter.dev/release/breaking-changes/theme-data-accent-properties) und wurde in der aktuellen Version vollständig entfernt. Daher der Fehler.

## Was stattdessen zu verwenden ist

```dart
Theme.of(context).colorScheme.secondary
```

Oder, falls Sie das Erscheinungsbild von Material-Komponenten konfigurieren:

```dart
final ThemeData theme = ThemeData();
MaterialApp(
  theme: theme.copyWith(
    colorScheme: theme.colorScheme.copyWith(secondary: myColor),
  ),
)
```

## Wenn das Problem an den Projektabhängigkeiten liegt

Der Fehler stammt nicht zwangsläufig aus Ihrem Code, sondern kann aus einer Ihrer Projektabhängigkeiten kommen, etwa `material`. In dem Fall können Sie versuchen, die Abhängigkeiten zu aktualisieren.

```bash
flutter pub upgrade
```

Damit werden Ihre Abhängigkeiten innerhalb der in der `pubspec.yaml` definierten Constraints aktualisiert. Müssen Sie diese überschreiten (zum Beispiel auf eine neue Major-Version wechseln), nutzen Sie einfach:

```bash
flutter pub upgrade --major-versions
```
