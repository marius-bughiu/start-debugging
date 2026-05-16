---
title: "Flutter 3.44 が Material と Cupertino を SDK から切り離し、SwiftPM をデフォルト化"
description: "Flutter 3.44 stable は SDK 内の Material と Cupertino を凍結し、新規の作業を pub.dev 上の material_ui と cupertino_ui パッケージに誘導します。SwiftPM も iOS と macOS のデフォルトとなり、CocoaPods はついに引退します。"
pubDate: 2026-05-16
tags:
  - "flutter"
  - "dart"
  - "swiftpm"
  - "material-design"
lang: "ja"
translationOf: "2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default"
translatedBy: "claude"
translationDate: 2026-05-16
---

Flutter 3.44 が今週 stable チャンネルに到達しました。見出しは見た目よりも構造的な話です。Material と Cupertino ライブラリは、もはや SDK のリリース列車に固定されていません。これからは `package:flutter/material.dart` と `package:flutter/cupertino.dart` の正式な居場所は pub.dev 上の二つの新しいパッケージ、`material_ui` と `cupertino_ui` になり、SDK 内のコピーは長い deprecation 期間に入ります。同時に、`flutter config --enable-swift-package-manager` が iOS と macOS のビルドの新しいデフォルトになり、新規の Flutter セットアップから Ruby と CocoaPods をついに外せるようになります。

## なぜ UI ライブラリが SDK を離れるのか

Material と Cupertino は常に Flutter 自身の 3 か月のケイデンスで出荷されてきました。これは、Material 3 のトークン調整、Cupertino のキーボード修正、`MenuAnchor` の新しい引数のいずれもが次の四半期切りを待たねばならないことを意味していました。スタンドアロンパッケージへの移行で、これらのチームは自前のリリースリズムを持ちます。`pubspec.yaml` で `material_ui: ^1.0.0` を pin すれば、CI が動いている Dart SDK のバージョンと切り離して、pub.dev に着いたそばから Material の更新を受け取れます。

移行は意図的に低摩擦になっています。3.44 では既存の import はまだ動きますが、`package:flutter/material.dart` に対して deprecation の警告が出ます。推奨される置き換えは機械的です。

```dart
// Before (still works in 3.44, deprecated)
import 'package:flutter/material.dart';

// After (new home on pub.dev)
import 'package:material_ui/material_ui.dart';
```

パッケージはいつもどおりに追加します。

```yaml
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
  cupertino_ui: ^1.0.0
```

二次的な利点はバイナリサイズです。Cupertino だけを使うアプリは、将来のリリースで SDK 内のコピーが削除されたあとは、Material のテーミング、タイポグラフィ、アイコンセットをツリーシェイクされたバンドルに引きずり込まなくて済みます。[3.44.0 のリリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)自身がこれを同梱ライブラリの "code freeze" と呼んでいます。バグ修正のみで、新しい API はありません。

## SwiftPM が iOS と macOS のデフォルトに

もう一つの大きな切り替えは、`flutter config --enable-swift-package-manager` が新規プロジェクトでデフォルト ON になることです。`flutter create` はもう `Podfile` を生成しません。pub 経由で解決されるプラグインには引き続き `Package.swift` の shim が用意され、Xcode はプロジェクトを Swift パッケージグラフとして直接開きます。既存アプリのアップグレードパスは短いです。

```sh
flutter upgrade
flutter config --enable-swift-package-manager
cd ios && rm -rf Pods Podfile.lock
flutter run -d ios
```

CocoaPods は削除されません。opt out した場合や、プラグインが `Package.swift` を公開していない場合のフォールバックとして残ります。deprecation 警告は、いまだに Pods のみで出荷しているプラグインを指摘するようになりました。

## 3.44 で他に着地したもの

このリリースは、フォームを再ビルドせずにバリデーション状態をリセットする `Form.clearError()`、iOS スタイルの入力フィールド向け `RoundedSuperellipseInputBorder`、Win32 と macOS と Linux 上の tooltip ウィンドウ、Android 上の `FlutterFragment` と `FlutterFragmentActivity` の predictive back サポートも導入します。掘り下げる材料は多いですが、エコシステム全体の `pubspec.yaml` を最初に作り変える変更はパッケージ分割です。

Material や Cupertino のウィジェットを再エクスポートする Flutter パッケージをメンテしているなら、いまこそ `material_ui` を dev dependencies に追加し、import を両建てで公開し始める時です。deprecation の警告はすぐに大きくなります。
