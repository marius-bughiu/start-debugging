---
title: "Flutter – Fix The getter ‘accentColor’ isn’t defined for the class ‘ThemeData’"
description: "The most likely cause of this error is an update to Flutter (flutter upgrade) which led to some imcompatibility with your existing code or your project’s dependencies. The Theme.of(context).accentColor property has been deprecated since Flutter 1.17 and is entirely removed from the current version, thus the error your are seeing. What to use instead Or, if…"
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
---
```plaintext
Error: The getter 'accentColor' isn't defined for the class 'ThemeData'.
 - 'ThemeData' is from 'package:flutter/src/material/theme_data.dart' ('/C:/flutter/packages/flutter/lib/src/material/theme_data.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field named 'accentColor'.
        themeData.textTheme.headline5?.copyWith(color: themeData.accentColor);
```

The most likely cause of this error is an update to Flutter (`flutter upgrade`) which led to some imcompatibility with your existing code or your project’s dependencies.

The `Theme.of(context).accentColor` property [has been deprecated since Flutter 1.17](https://docs.flutter.dev/release/breaking-changes/theme-data-accent-properties) and is entirely removed from the current version, thus the error your are seeing.

## What to use instead

```dart
Theme.of(context).colorScheme.secondary
```

Or, if you are configuring the appearance of material components:

```dart
final ThemeData theme = ThemeData();
MaterialApp(
  theme: theme.copyWith(
    colorScheme: theme.colorScheme.copyWith(secondary: myColor),
  ),
)
```

## If the issue is with your project’s dependencies

The error might not be coming from your code, but from one of your project’s dependencies, like `material` for example. In that case, you can try updating your dependencies.

```bash
flutter pub upgrade
```

This will upgrade your dependencies within the constraints of your `pubspec.yaml`. If you need to bypass those constraints (say you want to jump major versions), just:

```bash
flutter pub upgrade --major-versions
```
