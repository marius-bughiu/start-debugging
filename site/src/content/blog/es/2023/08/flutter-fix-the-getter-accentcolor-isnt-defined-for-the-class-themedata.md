---
title: "Flutter Arreglar 'The getter accentColor isn't defined for the class ThemeData'"
description: "La causa más probable de este error es una actualización de Flutter (flutter upgrade) que provocó una incompatibilidad con tu código existente o con las dependencias del proyecto. La propiedad Theme.of(context).accentColor está obsoleta desde Flutter 1.17 y se ha eliminado por completo en la versión actual, de ahí el error que ves. Qué usar en su lugar O, si..."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "es"
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

La causa más probable de este error es una actualización de Flutter (`flutter upgrade`) que provocó una incompatibilidad con tu código existente o con las dependencias de tu proyecto.

La propiedad `Theme.of(context).accentColor` [está obsoleta desde Flutter 1.17](https://docs.flutter.dev/release/breaking-changes/theme-data-accent-properties) y se ha eliminado por completo en la versión actual, de ahí el error que ves.

## Qué usar en su lugar

```dart
Theme.of(context).colorScheme.secondary
```

O, si estás configurando la apariencia de los componentes de material:

```dart
final ThemeData theme = ThemeData();
MaterialApp(
  theme: theme.copyWith(
    colorScheme: theme.colorScheme.copyWith(secondary: myColor),
  ),
)
```

## Si el problema viene de las dependencias del proyecto

El error podría no venir de tu código, sino de una de las dependencias del proyecto, como `material`, por ejemplo. En ese caso, puedes intentar actualizar las dependencias.

```bash
flutter pub upgrade
```

Esto actualizará las dependencias dentro de las restricciones de tu `pubspec.yaml`. Si necesitas saltarte esas restricciones (por ejemplo, quieres saltar de versión mayor), simplemente:

```bash
flutter pub upgrade --major-versions
```
