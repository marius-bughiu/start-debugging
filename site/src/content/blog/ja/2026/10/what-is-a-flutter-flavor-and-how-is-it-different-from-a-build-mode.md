---
title: "Flutter の flavor とは何か。ビルドモードとどう違うのか"
description: "ビルドモード (debug、profile、release) は Flutter が Dart コードをどうコンパイルするかを決めます。flavor (dev、staging、prod) は Gradle と Xcode で定義するネイティブのビルドバリアントで、どのアプリを出荷するかを決めます。この 2 つは独立した軸であり、2 つの flavor と 3 つのモードで 6 つのビルドになります。Flutter 3.44.8 と AGP 9.0.1 で検証し、ソースは 3.47.7 で確認しています。"
pubDate: 2026-10-10
tags:
  - "flutter"
  - "dart"
  - "flavors"
  - "android"
  - "ios"
  - "tooling"
lang: "ja"
translationOf: "2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode"
translatedBy: "claude"
translationDate: 2026-10-10
---

結論から言うと、**ビルドモード**は Flutter が Dart コードをどのようにコンパイルして実行するかを表すものです。モードは `debug`、`profile`、`release` のちょうど 3 つで、エンジンとツールに組み込まれており、コードからは `kDebugMode`、`kProfileMode`、`kReleaseMode` を通じて参照できます。一方、**flavor** は Flutter がまったく管理していないものです。Android では Gradle の `productFlavors`、iOS と macOS では Xcode のスキームとビルド構成として自分で定義するネイティブのビルドバリアントであり、*どのアプリ*をビルドするか (アプリケーション ID、表示名、アイコン、Firebase プロジェクト、API のベース URL) を決めます。Flutter は `--flavor dev` をネイティブビルドに渡し、その名前を Dart に `appFlavor` 定数として公開するだけです。この 2 つは直交しているため、`dev` と `prod` の flavor があるプロジェクトには `devDebug` から `prodRelease` までの 6 つのバリアントがあります。以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2、Android Gradle Plugin 9.0.1、Gradle 9.1.0) でビルドして確認し、関連する `flutter_tools` のソースは現行の安定版である Flutter 3.47.7 と比較しています。

## 2 つの軸、1 つのビルドマトリクス

混乱が生じやすいのは、どちらも同じコマンドラインで渡され、どちらも出力ファイル名に現れるためです。

```bash
# Flutter 3.44.8 / 3.47.7
flutter build apk --release --flavor prod
# -> Running Gradle task 'assembleProdRelease'...
# -> build/app/outputs/flutter-apk/app-prod-release.apk
```

`--release` がモードを選び、`--flavor prod` が flavor を選びます。Gradle はこの 2 つを `prodRelease` という 1 つのバリアント名にまとめ、`assembleProdRelease` を実行します。flavor が 2 つあるプロジェクトの全体のマトリクスは次のとおりです。

| | `--debug` | `--profile` | `--release` |
|---|---|---|---|
| `--flavor dev` | `app-dev-debug.apk` | `app-dev-profile.apk` | `app-dev-release.apk` |
| `--flavor prod` | `app-prod-debug.apk` | `app-prod-profile.apk` | `app-prod-release.apk` |

列は Flutter が決めるもので、"Dart コードはどうコンパイルされるか、ホットリロードできるか"に答えます。行は `build.gradle.kts` と Xcode プロジェクトが決めるもので、"これはステージングのバックエンドに接続し、ホーム画面で `Demo Dev` と表示されるアプリか"に答えます。一方の軸がもう一方の軸について何かを意味することはありません。`prod` の debug ビルドはごく普通のもので、本番環境でのみ発生するバグをブレークポイント付きで再現したいときに実行するものです。

## ビルドモードが実際に変えるもの

ビルドモードは Dart のコンパイルパイプラインに関するもので、Flutter によって固定されています。

- **Debug** はカーネルファイルにコンパイルし、Dart VM の JIT で実行します。assert が有効で、サービス拡張も有効で、ホットリロードとホットリスタートが動作しますが、パフォーマンスは実際の値を反映しません。
- **Profile** は release と同様にネイティブマシンコードへ事前 (AOT) コンパイルしますが、DevTools でのトレースに必要な分だけサービスプロトコルを残します。エミュレーターやシミュレーターでは動作しません。
- **Release** は事前コンパイルを行い、assert とデバッグ情報を取り除きます。出荷するのはこれです。

APK の中身を一覧すると違いがわかります。debug の APK は JIT 用に Dart プログラムを `kernel_blob.bin` として含み、profile と release の APK はプリコンパイル済みの `libapp.so` を含みます。

```text
# Flutter 3.44.8, flutter build apk --target-platform android-arm64 --flavor dev|prod
app-dev-debug.apk     26146208  assets/flutter_assets/kernel_blob.bin
app-dev-profile.apk    2753424  lib/arm64-v8a/libapp.so
app-prod-release.apk   1508240  lib/arm64-v8a/libapp.so
```

Dart コードは `package:flutter/foundation.dart` の 3 つの定数からモードを知ります。これらはツールが Dart コンパイラーに渡すフラグから導かれるコンパイル時定数であり、そのためコンパイラーは `if (kDebugMode) { ... }` ブロックを release ビルドから完全にツリーシェイクできます。

```dart
// Flutter 3.44.8, packages/flutter/lib/src/foundation/constants.dart (abridged)
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

4 つ目のモードを追加することはできません。"staging" モードというものは Flutter には存在せず、staging は flavor です。

## flavor とは実際には何か

flavor はネイティブアプリのバリアントです。Flutter には独自の flavor 設定フォーマットがありません。`--flavor dev` を渡すと、ツールは次の 3 つのことを行います。

1. Android では、Gradle タスク `assemble<Flavor><Mode>` (たとえば `assembleDevDebug`) を実行します。Gradle ファイルに `dev` という名前の product flavor が宣言されていない場合、ビルドは失敗します。
2. iOS と macOS では、flavor 名にちなんだ Xcode スキーム (先頭を大文字にするため、`dev` はまず `Dev` を探し、次に大文字小文字を区別しない一致を探します) を、`Debug-dev` や `Release-prod` のようなビルド構成 `<Mode>-<scheme>` でビルドします。
3. すべてのプラットフォームで、Dart defines に `FLUTTER_APP_FLAVOR=dev` を追加します。これが Dart では `appFlavor` として現れます。

最終的なバイナリで flavor が変えるものはすべてネイティブ側から来ます。アプリケーション ID のサフィックス、アプリ名の文字列、`google-services.json` または `GoogleService-Info.plist`、ランチャーアイコン、署名設定などです。Flutter は名前を受け渡すだけです。

## AGP 9 での Android の flavor 定義

こちらはデモアプリの Android 側です。Flutter 3.44.8 の標準の `flutter create` テンプレートに flavor ディメンションを追加したものです。

```kotlin
// android/app/build.gradle.kts
// Flutter 3.44.8, Android Gradle Plugin 9.0.1, Gradle 9.1.0
android {
    namespace = "com.example.flavordemo"
    compileSdk = flutter.compileSdkVersion

    defaultConfig {
        applicationId = "com.example.flavordemo"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // AGP 9 turns resValue off by default. Without this block the
    // productFlavors below fail with:
    // "Product Flavor dev contains custom resource values, but the feature is disabled."
    buildFeatures {
        resValues = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "Demo Dev")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Demo")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
```

`buildFeatures` ブロックは、古いチュートリアルの多くが見落としている部分です。AGP 9 より前に書かれた flavor のガイドはアプリ名に `resValue` を使っていますが、新規の Flutter 3.44 プロジェクトでは、その設定は Gradle の構成時に上記コメントのエラーで失敗するようになりました。そのうえで、マニフェストがその文字列を参照するようにすると、flavor ごとに独自のランチャーラベルが付きます。

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application
    android:label="@string/app_name"
    android:name="${applicationName}"
    android:icon="@mipmap/ic_launcher">
```

生成された APK に対する `aapt2 dump badging` により、2 つの軸が本当に独立していることが確認できます。モードはアイデンティティを何も変えず、flavor はコンパイルを何も変えませんでした。

```text
app-dev-debug.apk     package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-profile.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-release.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-prod-release.apk  package: com.example.flavordemo      versionName 0.1.0      label 'Demo'
```

`dev` バリアントはアプリケーション ID が異なるため、同じ端末に本番版と並べてインストールできます。多くのチームが flavor を採用する理由は、これだけで十分です。

## どちらの軸が間違っているかを教えてくれるエラー

Gradle ファイルに product flavor を宣言すると、単純な `flutter build apk` は動作しなくなります。

```text
# Flutter 3.44.8, no --flavor, productFlavors declared
Running Gradle task 'assembleDebug'...                             14.5s
Gradle build failed to produce an .apk file. It's likely that this file was generated
under .../flavordemo/build, but the tool couldn't find it.
```

このメッセージは誤解を招きます。`assembleDebug` は成功して*すべての* flavor をビルドしており (その後ディスク上には `app-dev-debug.apk` と `app-prod-debug.apk` の両方がありました)、ツールが探しているのはもう存在しない `app-debug.apk` なのです。`--flavor` を渡すか、デフォルトを設定してください (後述)。

逆の間違い、つまり product flavor のないプロジェクトに `--flavor` を渡した場合は、はるかにわかりやすいメッセージが出ます。

```text
# Flutter 3.44.8, --flavor dev, no productFlavors
[!]  Gradle project does not define a task suitable for the requested build.
The .../android/app/build.gradle.kts file does not define any custom product flavors.
You cannot use the --flavor option.
```

iOS では、ツールは flavor を Xcode のスキームに対して検証します。まだ `dev` スキームがない同じプロジェクトで `flutter build ios --config-only --no-codesign --flavor dev` を実行すると、次のように表示されました。

```text
The Xcode project defines schemes: FlutterFramework, FlutterGeneratedPluginSwiftPackage, Runner
You must specify a --flavor option to select one of the available schemes.
```

## どちらもバイナリ内の定数になる証拠

`appFlavor` は `package:flutter/services.dart` で宣言されており、Flutter 3.47.7 でも単純な `String.fromEnvironment` の参照のままです。

```dart
// Flutter 3.47.7, packages/flutter/lib/src/services/flavor.dart
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

つまり flavor は、モードと同じ方法、すなわちコンパイル時定数として Dart に届きます。それを証明するため、デモの `main.dart` は両方をログ出力します。

```dart
// Flutter 3.44.8, lib/main.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('FLAVORPROBE appFlavor=$appFlavor kDebugMode=$kDebugMode '
      'kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  runApp(const SizedBox());
}
```

次に、各 APK 内の AOT スナップショットに対して `strings` を実行すると、コンパイラーが文字列補間全体を 1 つのリテラルに畳み込んでいることがわかります。調べるべき実行時の参照は残っていません。

```text
# strings lib/arm64-v8a/libapp.so | grep FLAVORPROBE
app-dev-release.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=false kReleaseMode=true
app-prod-release.apk:  FLAVORPROBE appFlavor=prod kDebugMode=false kProfileMode=false kReleaseMode=true
app-dev-profile.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=true kReleaseMode=false
```

これには実用上の帰結が 2 つあります。バイナリには答えが 1 つしか含まれていないため、実行時に flavor を切り替えることはできません。また、`flutter attach` からのホットリスタートのように、適切な defines なしで Dart を再コンパイルするものは `appFlavor == null` になります。これは [ホットリスタート後に appFlavor を維持する方法](/ja/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) で扱っている問題です。

ツールは名前の保護も行います。define で flavor を偽装しようとすると、ビルドが始まる前に失敗します。

```text
# flutter build apk --dart-define=FLUTTER_APP_FLAVOR=qa
FLUTTER_APP_FLAVOR is used by the framework and cannot be set using --dart-define or --dart-define-from-file
```

## iOS と macOS: スキームとビルド構成

Apple のプラットフォームでは、flavor は一致していなければならない 2 つのものから成ります。flavor 名にちなんだスキームと、`Debug-<flavor>`、`Profile-<flavor>`、`Release-<flavor>` という名前のビルド構成のセットです。モードと flavor のマトリクスが、構成名の中にそのまま書き出されています。Xcode では、flavor ごとに `Debug`、`Profile`、`Release` を複製し、`dev` スキームを作成して、Run アクションを `Debug-dev`、Profile を `Profile-dev`、Archive を `Release-dev` に設定します。これで各構成が独自の `PRODUCT_BUNDLE_IDENTIFIER` と表示名を設定できるようになります。

Flutter 3.47.7 で知っておく価値のある挙動があります。`XcodeProjectInfo.buildConfigurationFor` は、まず `Debug-dev` との完全一致を探し、次にモードとスキームの両方を名前に含む単一の構成 (大文字小文字を区別しない) を探し、どちらも存在しなければ **単純な `Debug` 構成にフォールバックします**。そのため `Debug-dve` のようなタイプミスではビルドは失敗せず、ベース構成と、その構成が持つバンドル識別子 (たいていは本番のもの) で黙ってビルドされます。flavor 付きの iOS ビルドが prod のように見える場合は、何よりも先に構成名を確認してください。

`flutter run`、`flutter build ios`、`flutter build ipa`、`flutter build macos` は `--flavor` を受け付けます。`flutter build web`、`flutter build windows`、`flutter build linux` には 3.44.8 時点でこのオプションがありません。Flutter が受け渡す先のネイティブなバリアントの仕組みが存在しないためです。

## flavor 固有のアセットとデフォルト flavor

pubspec の 2 つの機能により、flavor の扱いが楽になります。アセットを特定の flavor に限定できるため、dev 用のフィクスチャやデバッグ用の設定を本番のバンドルから除外できます。

```yaml
# pubspec.yaml, Flutter 3.44.8
flutter:
  default-flavor: dev
  assets:
    - path: assets/dev/
      flavors:
        - dev
```

デモでは、`assets/flutter_assets/assets/dev/config.json` は `app-dev-debug.apk` と `app-dev-profile.apk` に存在し、`app-prod-debug.apk` と `app-prod-release.apk` には存在しませんでした。共有コード内の `rootBundle.loadString('assets/dev/config.json')` は `prod` では例外をスローするようになる点に注意してください。これは [pubspec のアセットに関するトラブルシューティング記事](/ja/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/) で説明している "Unable to load asset" と同じ失敗です。

`default-flavor` は、`--flavor` が省略されたときにツールが使うものです。`FlutterCommand.getBuildInfo()` ではロジックは `cliFlavor ?? defaultFlavor` の 1 行で、3.47.7 でも変わっていません。これを設定すると、デモでは単純な `flutter build apk --release` が失敗せずに `app-dev-release.apk` を生成しました。開発中の `flutter run` には便利ですが、`default-flavor: prod` をコミットするのはよく考えてください。`--flavor` を付け忘れた CI ジョブが、ファイルに書かれた flavor を黙って出荷してしまいます。

## 設定はどちらの軸に属するか

設定をどこに置くかを判断する簡単な方法です。

- **コードのコンパイルやデバッグの方法に依存するもの** (詳細なログ出力、`debugPaintSizeEnabled`、開発中はオフにするクラッシュレポート、パフォーマンスオーバーレイ): `kDebugMode` / `kReleaseMode` を通じてモードを使います。これらのチェックは release ビルドからツリーシェイクされます。
- **出荷する環境や製品に依存するもの** (API のベース URL、Firebase プロジェクト、バンドル ID、アプリ名、アイコン、課金商品の ID): flavor を使います。OS が読むものはネイティブ側で、Dart が読むものは `appFlavor` を通じて扱います。
- **アイデンティティではなく値であるもの** (機能フラグ、ビルド番号、秘密ではないキー): flavor よりも `--dart-define` や `--dart-define-from-file` のほうが簡単なことが多くあります。define もコンパイル時定数なので、どちらの軸とも組み合わせられます。
- **秘密情報**: 上記のどれでもありません。flavor もモードも define も、上の `strings` の出力が示すとおり、最終的にはバイナリ内の読み取り可能な文字列になります。

避けるべき間違いは、環境をモードに対応づけること、たとえば"debug はステージングに接続し、release は prod に接続する"とすることです。これは、本番環境に対してプロファイルしたいとき、ステージングに対して release でのみ発生するクラッシュをデバッグしたいとき、あるいは release ビルドが必要な TestFlight でステージングビルドをテスターに配布したいときまでは機能します。軸を分けておけば、すべての組み合わせに到達できます。

実際には、Firebase で最もよくつまずきます。flavor ごとの `google-services.json` ファイルは `android/app/src/dev/` のような Android のソースセットに置かれ、そこで不一致があると、[release ビルドで Firebase Auth のサインインが保持されない問題](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) で扱った種類の release 限定の失敗が起こります。flavor のソースセットはコンパイルされる Kotlin クラスにも影響し、これは [MainActivity の ClassNotFoundException](/ja/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/) の原因の 1 つです。また、[release クラッシュ "Could not create Dart VM instance"](/ja/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) の調査でネイティブライブラリを確認するときには、flavor 付きの出力名 (`app-prod-release.apk`、`app-prodRelease.aab`) が重要になります。

## 関連記事

- [flutter attach 使用時にホットリスタート後も appFlavor を維持する方法](/ja/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)
- [修正: Flutter Android アプリの起動時に MainActivity で ClassNotFoundException が発生する](/ja/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/)
- [修正: Flutter Android の release ビルドで Firebase Auth のサインインが保持されない](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [修正: flutter upgrade 後の Flutter release ビルドで Could not create Dart VM instance が発生する](/ja/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)
- [修正: pubspec.yaml に画像を追加した後に Flutter で Unable to load asset が発生する](/ja/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)

## 参考資料

- [Flutter docs: Flutter's build modes](https://docs.flutter.dev/testing/build-modes)
- [Flutter docs: Set up Flutter flavors for Android](https://docs.flutter.dev/deployment/flavors)
- [Flutter docs: Set up Flutter flavors for iOS and macOS](https://docs.flutter.dev/deployment/flavors-ios)
- [Android developers: Configure build variants](https://developer.android.com/build/build-variants)
- [`flavor.dart` at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/services/flavor.dart)
- [`flutter_command.dart` (`getBuildInfo`, `default-flavor`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/runner/flutter_command.dart)
- [`xcodeproj.dart` (scheme and build configuration matching) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/ios/xcodeproj.dart)
- [`constants.dart` (`kReleaseMode`, `kProfileMode`, `kDebugMode`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/foundation/constants.dart)
