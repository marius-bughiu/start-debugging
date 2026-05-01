---
title: "Flutter 'The getter accentColor isn't defined for the class ThemeData' を直す"
description: "このエラーの最も多い原因は、Flutter のアップグレード (flutter upgrade) によって、既存のコードやプロジェクトの依存関係との互換性が失われたことです。Theme.of(context).accentColor プロパティは Flutter 1.17 から非推奨で、現行バージョンでは完全に削除されたため、このエラーが出ます。代わりに何を使うか もしくは..."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "ja"
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

このエラーの最も多い原因は、Flutter のアップグレード (`flutter upgrade`) によって、既存のコードやプロジェクトの依存関係との互換性が失われたことです。

`Theme.of(context).accentColor` プロパティは [Flutter 1.17 から非推奨](https://docs.flutter.dev/release/breaking-changes/theme-data-accent-properties) で、現行バージョンでは完全に削除されました。だから今このエラーが出ているわけです。

## 代わりに何を使うか

```dart
Theme.of(context).colorScheme.secondary
```

もしくは、material コンポーネントの外観を設定する場合:

```dart
final ThemeData theme = ThemeData();
MaterialApp(
  theme: theme.copyWith(
    colorScheme: theme.colorScheme.copyWith(secondary: myColor),
  ),
)
```

## 問題がプロジェクトの依存関係にある場合

エラーは自分のコードからではなく、`material` などのプロジェクトの依存関係から出ていることもあります。その場合は、依存関係の更新を試してみましょう。

```bash
flutter pub upgrade
```

これで `pubspec.yaml` の制約の範囲内で依存関係が更新されます。その制約を超えたい (たとえばメジャーバージョンを上げたい) 場合は、次のようにします。

```bash
flutter pub upgrade --major-versions
```
