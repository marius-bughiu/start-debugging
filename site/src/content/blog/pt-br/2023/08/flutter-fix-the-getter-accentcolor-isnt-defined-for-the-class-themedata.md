---
title: "Flutter corrigir 'The getter accentColor isn't defined for the class ThemeData'"
description: "A causa mais provável desse erro é uma atualização do Flutter (flutter upgrade) que gerou alguma incompatibilidade com o seu código ou com as dependências do projeto. A propriedade Theme.of(context).accentColor está obsoleta desde o Flutter 1.17 e foi totalmente removida da versão atual, daí o erro. O que usar no lugar Ou, se..."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "pt-br"
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

A causa mais provável desse erro é uma atualização do Flutter (`flutter upgrade`) que gerou alguma incompatibilidade com o seu código ou com as dependências do projeto.

A propriedade `Theme.of(context).accentColor` [está obsoleta desde o Flutter 1.17](https://docs.flutter.dev/release/breaking-changes/theme-data-accent-properties) e foi totalmente removida da versão atual, por isso o erro.

## O que usar no lugar

```dart
Theme.of(context).colorScheme.secondary
```

Ou, se você está configurando a aparência de componentes do material:

```dart
final ThemeData theme = ThemeData();
MaterialApp(
  theme: theme.copyWith(
    colorScheme: theme.colorScheme.copyWith(secondary: myColor),
  ),
)
```

## Se o problema está nas dependências do projeto

O erro pode não vir do seu código, mas de uma das dependências do projeto, como `material`, por exemplo. Nesse caso, tente atualizar as dependências.

```bash
flutter pub upgrade
```

Isso atualiza as dependências dentro dos limites do seu `pubspec.yaml`. Se você precisa quebrar esses limites (por exemplo, ir para uma nova major), faça:

```bash
flutter pub upgrade --major-versions
```
