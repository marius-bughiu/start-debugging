---
title: "flutter attach 使用時に hot restart 後も appFlavor を保持する方法"
description: "flutter attach には --flavor オプションがないため、起動される常駐コンパイラーは FLUTTER_APP_FLAVOR を定義せず、最初の hot restart で appFlavor 定数が null になります。解決策は 3 つ、pubspec.yaml の default-flavor、flutter run --use-application-binary、そして flavor をネイティブから読み取るプラットフォームチャネルです。Flutter 3.47.2 / Dart 3.13.2 で検証しました。"
pubDate: 2026-09-07
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "flavors"
  - "tooling"
lang: "ja"
translationOf: "2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach"
translatedBy: "claude"
translationDate: 2026-09-07
---

`appFlavor` はコンパイル時定数であってランタイムの参照ではなく、`flutter attach` には `--flavor` オプションがありません。そのため `flutter run` 以外でビルド・起動されたアプリにアタッチすると、ツールが起動するフロントエンドコンパイラーは `-DFLUTTER_APP_FLAVOR=...` なしで立ち上がり、最初の hot restart で正しかった `dev` が `null` に置き換わります。最も手早い解決策は `pubspec.yaml` の `default-flavor` で、これは `FlutterCommand.getBuildInfo()` が `attach` を含むすべてのコマンドで読み取ります。flavor を呼び出しごとに変えたい場合は、アタッチせずに `flutter run --use-application-binary=<path> --flavor dev` を使うか、`appFlavor` を読むのをやめて flavor をプラットフォーム側から取得してください。以下の内容はすべて stable チャネルの Flutter 3.47.2 と Dart 3.13.2 で確認しています。

## appFlavor は 11 行の const であり、話はそれで全部です

`appFlavor` が engine に何かを問い合わせていると思われがちですが、そうではありません。stable ブランチの `packages/flutter/lib/src/services/flavor.dart` にある宣言の全文です。

```dart
// Flutter 3.47.2, packages/flutter/lib/src/services/flavor.dart
/// The flavor this app was built with.
///
/// This is equivalent to the value argued to the `--flavor` option at build time.
/// This will be `null` if the `--flavor` option was not provided.
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

`String.fromEnvironment` は、CFE が kernel をコンパイルするときに、コンパイラープロセスへ渡された `-D` フラグから解決されます。`Platform.environment` とも、実行中の VM とも、インストールした APK とも無関係です。kernel を生成した時点でコンパイラーが持っていた値が、そのまま焼き込まれます。

これが重要なのは、Flutter のデバッグセッションの一生には 2 つのコンパイラーがあるからです。1 つ目はアプリをビルドするときに動きます。`flutter build apk --flavor dev --debug` は `FlutterCommand.getBuildInfo()` で `--flavor` を解決し、dart defines に `FLUTTER_APP_FLAVOR=dev` を追加します。これが frontend server のコマンドラインで `-DFLUTTER_APP_FLAVOR=dev` になります。2 つ目はセッションの残り全体で動きます。hot reload と hot restart を処理するために `flutter run` や `flutter attach` が生かし続ける常駐コンパイラーです。`packages/flutter_tools/lib/src/compile.dart` では、defines はこのプロセスの起動時にちょうど一度だけ展開されます。

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/compile.dart (abridged)
final List<String> command = <String>[
  engineDartPath,
  ...
  '--sdk-root', sdkRoot,
  '--target=$targetModel',
  '--no-print-incremental-dependencies',
  for (final Object dartDefine in dartDefines) '-D$dartDefine',
  ...buildModeOptions(buildMode, dartDefines),
  if (trackWidgetCreation) '--track-creation-locations',
  ...
];
```

その後に `dartDefines` を変更する経路はありません。セッションの残りにおけるすべての hot reload と hot restart は、この 1 つのプロセスがこの 1 組の defines で処理します。起動時のコマンドラインに `FLUTTER_APP_FLAVOR` がなければ、何度リスタートしても戻ってきません。

## attach が登録するもの、しないもの

`AttachCommand` のコンストラクターは `uses*` 呼び出しの並びです。stable からそのまま引用した該当部分です。

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/commands/attach.dart
addBuildModeFlags(verboseHelp: verboseHelp, defaultToRelease: false, excludeRelease: true);
usesTargetOption();
usesPortOptions(verboseHelp: verboseHelp);
usesIpv6Flag(verboseHelp: verboseHelp);
usesFilesystemOptions(hide: !verboseHelp);
usesFuchsiaOptions(hide: !verboseHelp);
usesDartDefineOption();
usesDeviceUserOption();
```

`usesFlavorOption()` がありません。`RunCommand` は `run.dart` の 40 行目でこれを呼びますが、`AttachCommand` は一度も呼びません。そして `attach` も呼び出す `getBuildInfo()` は、flavor を次のように解決します。

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
final String? defaultFlavor = project.manifest.defaultFlavor;
final String? cliFlavor = getValue(BuildInfoOptions.flavor);
final String? flavor = cliFlavor ?? defaultFlavor;

_ensureReservedDartDefineIsUnset(kAppFlavor, dartDefines);
if (flavor != null) {
  dartDefines.add('$kAppFlavor=$flavor');
}
```

`--flavor` オプションが登録されていないので `cliFlavor` は `null` です。`defaultFlavor` も null なら `flavor` も null になり、`if` は決して実行されず、常駐コンパイラーは define なしで起動します。デバイス上のアプリは `dev` ビルドなのに、それを処理するコンパイラーは flavor など存在しないと思っているわけです。

## 4 ステップの再現手順

これは [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261) で、2026-09-03 に報告され、3.47.2 stable に対してトリアージで確認されています。`platform-android` と `platform-ios` の両方で再現します。

1. アプリに product flavors を設定し、定数を目に見える場所で読み取ります。

   ```dart
   // Flutter 3.47.2 / Dart 3.13.2
   import 'package:flutter/material.dart';
   import 'package:flutter/services.dart';

   void main() => runApp(const FlavorApp());

   class FlavorApp extends StatelessWidget {
     const FlavorApp({super.key});

     @override
     Widget build(BuildContext context) {
       return MaterialApp(
         home: Scaffold(
           body: Center(
             child: Text('appFlavor = $appFlavor',
                 style: const TextStyle(fontSize: 28)),
           ),
         ),
       );
     }
   }
   ```

2. flavor を付けてビルドし、`flutter run` の外で起動します。

   ```bash
   flutter build apk --flavor dev --debug
   adb install -r build/app/outputs/flutter-apk/app-dev-debug.apk
   adb shell monkey -p com.example.flavors.dev 1
   ```

3. アタッチします。`flutter attach --debug` を実行します。まだ何も再コンパイルされていないので、画面は `appFlavor = dev` のままです。

4. `R` を押して hot restart します。画面は `appFlavor = null` になります。

診断を混乱させるのはステップ 3 です。最初のリスタートまでは値が正しいので、不具合がツールではなく、ちょうど編集したコードに属しているように見えてしまいます。

## 解決策 1: pubspec.yaml の default-flavor

`default-flavor` は [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) で pubspec のスキーマに追加され、[#169298](https://github.com/flutter/flutter/pull/169298) がその解決処理を `FlutterCommand.getBuildInfo()` に移したことで、`run` と `build` だけでなく `BuildInfo` を組み立てるすべてのコマンドに適用されるようになりました。`attach` もそのひとつです。だからこれが効きます。

1. `pubspec.yaml` の `flutter:` キーの下にフィールドを追加します。

   ```yaml
   # pubspec.yaml, Flutter 3.47.2
   name: flavors_example
   environment:
     sdk: ^3.13.0

   flutter:
     uses-material-design: true
     default-flavor: dev
   ```

2. attach セッションを再開します。`flutter attach --debug` はマニフェストから `flavor` を `dev` に解決し、defines に `FLUTTER_APP_FLAVOR=dev` を追加するので、hot restart しても `dev` が返り続けます。

3. オプションが存在するところでは引き続き `--flavor` を明示してください。`usesFlavorOption()` のヘルプ本文が "Overrides the value of the `default-flavor` entry in the flutter pubspec" と述べているとおり、`flutter run --flavor staging` は `default-flavor: dev` に勝ちます。

制限はリポジトリに入るファイルへ値を書くことから予想されるとおりです。全員に対して、すべての attach で、たった 1 つの flavor になります。CI があるマシンでは `staging` ビルドに、別のマシンでは `dev` ビルドにアタッチするなら、`default-flavor` はそれに追従できません。プラットフォームごとの `default-flavor` を認める提案 [#191376](https://github.com/flutter/flutter/pull/191376) が出ていますが、これも値を呼び出しごとに変えられるようにするわけではありません。

## --dart-define=FLUTTER_APP_FLAVOR が拒否される理由

素直な回避策は define を手で設定することで、`attach` は `usesDartDefineOption()` を登録しているのでフラグ自体は解析されます。それでも失敗します。

```bash
flutter attach --debug --dart-define=FLUTTER_APP_FLAVOR=dev
# FLUTTER_APP_FLAVOR is used by the framework and cannot be set using
# --dart-define or --dart-define-from-file
```

このガードは意図的なもので、プロセスの環境変数もカバーします。

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
void _ensureReservedDartDefineIsUnset(String define, List<String> dartDefines) {
  if (_platform.environment[define] != null) {
    throwToolExit('$define is used by the framework and cannot be set in the environment.');
  }
  if (dartDefines.any((String d) => d == define || d.startsWith('$define='))) {
    throwToolExit(
      '$define is used by the framework and cannot be '
      'set using --${FlutterOptions.kDartDefinesOption} or --${FlutterOptions.kDartDefineFromFileOption}',
    );
  }
}
```

`FLUTTER_APP_FLAVOR` は、この予約リストで `FLUTTER_BUILD_NAME`、`FLUTTER_BUILD_NUMBER`、`FLUTTER_ENABLED_FEATURE_FLAGS` と並んでいます。ツールを実行する前にシェルで変数を設定してもすり抜けられません。最初の分岐が `_platform.environment` を調べ、別のメッセージで終了します。以前 web ビルドでこれをやっていたなら、それは [#172165](https://github.com/flutter/flutter/issues/172165) で、無効としてクローズされています。事故だったのは 3.32 より前の挙動であって、現在の拒否ではありません。

## 解決策 2: アタッチせずビルド済みバイナリーを実行する

`flutter attach` に手を伸ばす理由はたいてい、アプリを `flutter run` 以外の何かがビルドしたからです。Gradle のタスク、Xcode のスキーム、計測用の harness などです。必要なのが「この成果物をインストールして hot restart のループをくれ」だけなら、`flutter run` が直接それをやってくれますし、`attach` と違って `--flavor` を受け付けます。

```bash
# Flutter 3.47.2. run registers both --use-application-binary and --flavor.
flutter run \
  --use-application-binary=build/app/outputs/flutter-apk/app-dev-debug.apk \
  --flavor dev
```

`RunCommand` は `usesFlavorOption()` を呼び、`--use-application-binary` を `prebuiltApplicationBinaryPath` に読み込みます。つまり自分でビルドしたバイナリーの上に本物の `HotRunner` が立ち、常駐コンパイラーには `FLUTTER_APP_FLAVOR=dev` が入ります。iOS では `flutter build ios --flavor dev --debug` か Xcode のスキームが生成する `.app` バンドルを指定してください。Dart のコードに触れずに済む解決策としては最も正しさに近く、CI で私が最初に選ぶのもこれです。

ネイティブのホストアプリが Flutter をモジュールとして組み込み、自分で engine を起動する場合など、起動を本当に制御できないときには役に立ちません。そのための解決策 3 です。

## 解決策 3: kernel ではなくプラットフォームから flavor を読む

flavor が任意の attach を生き延びる必要があるなら、コンパイラーが知らない値をコンパイル時定数に尋ねるのはやめましょう。flavor はネイティブ側にすでに存在します。Android なら `BuildConfig.FLAVOR`、iOS なら Xcode のスキームを駆動しているビルド設定です。プラットフォームチャネルなら、コンパイル前ではなく isolate の再起動後にそれを読み取れます。手法は [プラグインを書かずにプラットフォーム固有のコードを追加する](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) で扱ったものと同じです。

まず Android です。AGP 8.0 は明示的に要求しない限り `BuildConfig` を生成しなくなり、Flutter のアプリテンプレートは要求していないので、有効にします。

```kotlin
// android/app/build.gradle.kts, AGP 8.13, Flutter 3.47.2
android {
    namespace = "com.example.flavors"

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
    }
}
```

次に `MainActivity` でチャネル呼び出しに応答します。

```kotlin
// android/app/src/main/kotlin/com/example/flavors/MainActivity.kt
package com.example.flavors

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.example.flavors/flavor",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "getFlavor" -> result.success(BuildConfig.FLAVOR)
                else -> result.notImplemented()
            }
        }
    }
}
```

iOS では xcconfig ごとにユーザー定義のビルド設定を追加し (`Debug-dev.xcconfig` に `APP_FLAVOR = dev`)、`Info.plist` に `$(APP_FLAVOR)` を値とする文字列 `FLUTTER_APP_FLAVOR` として露出させ、バンドルから読み取ります。

```swift
// ios/Runner/AppDelegate.swift, Xcode 26.4, Flutter 3.47.2
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.example.flavors/flavor",
      binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "getFlavor" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(Bundle.main.object(forInfoDictionaryKey: "FLUTTER_APP_FLAVOR") as? String)
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

Dart 側では一度だけ解決し、ネイティブハンドラーのないプラットフォームでは `appFlavor` にフォールバックします。

```dart
// Flutter 3.47.2 / Dart 3.13.2
import 'package:flutter/services.dart';

const _channel = MethodChannel('com.example.flavors/flavor');

/// Survives hot restart under `flutter attach`, because it is a call, not a const.
Future<String?> resolveFlavor() async {
  try {
    return await _channel.invokeMethod<String>('getFlavor') ?? appFlavor;
  } on MissingPluginException {
    return appFlavor; // desktop, web, unit tests
  }
}
```

代償は、`resolveFlavor()` が非同期であるのに対して `appFlavor` はそうではない点です。`main()` で flavor により同期的に分岐していた箇所は、`runApp` の前で待機するか、provider から読むように変える必要があります。これは本物のリファクタリングなので、解決策 1 と解決策 2 のどちらも使えないときにだけ選ぶことになります。

## この不具合に似ているが別物のもの

**3.32.1 のホットフィックス。** この症状で検索すると [#165803](https://github.com/flutter/flutter/issues/165803) と [#169160](https://github.com/flutter/flutter/issues/169160) にたどり着きます。そこでは素の `flutter run --flavor` での hot restart 後や `flutter test --flavor` の実行中に `appFlavor` が null になっていました。あれは別の原因でした。`build_system/targets/common.dart` の `KernelSnapshot` が、ビルドの xcodebuild 側からすでに define が存在する場合に flavor の追加をスキップしていたのです。[PR #169602](https://github.com/flutter/flutter/pull/169602) が、既存のエントリーを削除してから自分のものを最後に追加するよう変更し、changelog の項目は **Flutter 3.32.1** に入りました。3.32.1 以降で `flutter run` でも依然として null が出るなら、それはこの問題ではなく新しい不具合です。

**hot restart だけでなく hot reload も。** defines の組は常駐コンパイラーの起動時に固定されるので、完全なリスタートだけでなくすべてのインクリメンタルコンパイルを支配します。`appFlavor` を読むライブラリーを再コンパイルする hot reload は、そのライブラリーでだけ定数を null に評価し直すことがあり、他のライブラリーは古い値を保ったままになります。`R` が危ないからといって `r` は安全だと決め込まないでください。

**Gradle にしか存在しない flavor。** `appFlavor` が報告するのは `--flavor` に渡された値であり、それは product flavor の名前と一致していなければなりません。`build.gradle.kts` で flavor の名前を変えたのに古い名前でビルドし続けていれば、この話に到達する前にビルドが失敗します。flavor のディメンション自体の設定は本記事の範囲外です。失敗しているのが `assembleDevDebug` なら、[終了コード 1 で失敗する assembleDebug のチェックリスト](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) のほうが近い話題です。

**IDE の Attach アクション。** IntelliJ は反対側から同じ壁にぶつかりました。flutter-intellij#5237 では、Attach アクションが `--flavor` を渡して `Could not find an option named 'flavor'` で落ちていました。IDE 側の修正はフラグを外すことだったので、Android Studio や VS Code からのアタッチでもこの挙動が出ます。IDE のコマンドラインは制御できないため、現状 IDE 経路を直せるのは `default-flavor` だけです。

#192261 の upstream 提案は 1 行です。`AttachCommand` のコンストラクターで `usesFlavorOption()` を呼ぶだけ。`getBuildInfo()` はすでにオプションを define に変換しているので、それ以上の配線は不要です。これが入るまでは、`attach` 配下の `appFlavor` は「ちょうど一度だけ正しい」ものとして扱い、起動をどこまで制御できるかに応じて上記 3 つの解決策から選んでください。

## 関連記事

- [Flutter でプラグインなしにプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) は、解決策 3 が依存する `MethodChannel` の設定を順に解説しています。
- [Fix: Flutter の Android ビルドで Gradle タスク assembleDebug が終了コード 1 で失敗する](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) は、`appFlavor` が関係する前にビルドを壊す flavor と NDK の設定ミスを扱っています。
- [1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) は解決策 2 と併せて読む価値があります。`--use-application-binary` はほぼ CI 向けの一手だからです。
- [Windows から Flutter iOS をデバッグする: 実機での実際のワークフロー](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) は `flutter attach` が活躍するもうひとつの場面で、定数とランタイムの区別も同じように効いてきます。
- [Fix: Flutter の Android release ビルドで Firebase Auth のサインインが保持されない](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) は、flavor が Firebase プロジェクトの違いも意味している場合の良い相棒です。

## 参考資料

- [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261)、`attach` に `--flavor` がないことを追跡しているオープンな issue。3.47.2 でトリアージによる確認あり。
- Flutter API ドキュメントの [`appFlavor` 定数](https://api.flutter.dev/flutter/services/appFlavor-constant.html)、およびそのソース `packages/flutter/lib/src/services/flavor.dart`。
- `default-flavor` フィールドについては [Flutter pubspec のオプション](https://docs.flutter.dev/tools/pubspec)、flavor の設定そのものについては [Android 向けの Flutter flavor の設定](https://docs.flutter.dev/deployment/flavors)。
- [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) が `default-flavor` を追加し、[#169298](https://github.com/flutter/flutter/pull/169298) とその roll-forward である [#169602](https://github.com/flutter/flutter/pull/169602) が flavor の解決を `getBuildInfo()` へ移しました。
- [Flutter の CHANGELOG](https://github.com/flutter/flutter/blob/main/CHANGELOG.md)、`flutter test` と hot restart における `appFlavor` を扱う 3.32.1 ホットフィックスの項目。
- [Android Gradle Plugin 8.0 のリリースノート](https://developer.android.com/build/releases/past-releases/agp-8-0-0-release-notes)、解決策 3 が回避しなければならない `buildFeatures.buildConfig` の既定値変更について。
