---
title: "修正: Flutter の Android ビルドで Gradle task assembleDebug failed with exit code 1 が出る"
description: "この行はラッパーであってエラーではありません。flutter run --verbose または ./gradlew assembleDebug --stacktrace で実行し直し、Gradle の本当の失敗を読んで、それを修正してください。"
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "ja"
translationOf: "2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-31
---

一言でいう解決策です。`Gradle task assembleDebug failed with exit code 1` はエラーではなく、Gradle がゼロ以外の終了コードで終わったことを Flutter が報告しているだけです。本当の失敗はその上に出力されており、ほぼ必ずコンソールから切り捨てられています。`flutter run --verbose` で実行し直すか、`android/` に移動して `./gradlew assembleDebug --stacktrace` を実行し、Gradle が `* What went wrong:` の下で実際に述べている内容を修正してください。2026 年 7 月時点で最も多い答えは、Android Gradle Plugin 9 の組み込み Kotlin が旧来の `kotlin-android` プラグインと衝突するケースで、`Cannot add extension with name 'kotlin'` として現れます。

```text
FAILURE: Build failed with an exception.

BUILD FAILED in 47s
Running Gradle task 'assembleDebug'...                             48.2s
Error: Gradle task assembleDebug failed with exit code 1
```

本記事は 2026-07-20 時点の stable チャネルである Flutter 3.44.7 と Dart 3.12.2 を対象に書かれており、Android Gradle Plugin (AGP) 8.x および 9.x、Gradle 8.13、JDK 17 と 21 についての注記を含みます。診断手順は何年も変わっていませんが、以下に順位づけした原因は変わっており、最初の項目は AGP 9 の展開以降に生じた新しいものです。

## メッセージが何も教えてくれない理由

`assembleDebug` は Android の Gradle タスクです。Flutter のツールはプロジェクトの `android/` ディレクトリにある Gradle ラッパーを呼び出し、出力を流し、その後で終了コードを確認します。コードがゼロ以外であれば、ツールはタスク名と終了コードというちょうど 1 行だけを出します。何が失敗したのかはツールには分かりません。Gradle の失敗は型を持たず、単なるテキストだからです。

そこで 2 つの要因があなたに不利に働きます。

1. Flutter のツールは Gradle の出力をフィルタリングします。通常のビルドがきれいに見えるよう設定フェーズの雑多な出力を隠しますが、その過程で必要なブロックまで落としてしまうことがあります。
2. Gradle 自身も切り捨てます。`--stacktrace` なしでは、3 階層に及ぶ `Caused by:` の連鎖が 1 行に要約され、原因となったプラグイン名が現れないことがあります。

ですから最初の一手は決して推測ではありません。ビルドに真実を出力させることです。

## 何かを変更する前に本当のエラーを取得する

次の順で実行し、タスク名と原因を示す `* What went wrong:` ブロックが得られた時点で止めてください。

```bash
# Flutter 3.44.7, Dart 3.12.2
flutter run --verbose
```

それでも不透明なら、Flutter のツールを完全に迂回して Gradle と直接やり取りします。ここが最も多くの人が飛ばす手順であり、そして実際に効く手順です。

```bash
# From the Flutter project root. Use gradlew.bat on Windows.
cd android
./gradlew assembleDebug --stacktrace --info
```

Gradle は原因となったモジュールとともに、完全な失敗内容を出力します。

```text
* What went wrong:
A problem occurred configuring project ':file_picker'.
> Failed to apply plugin 'kotlin-android'.
   > Cannot add extension with name 'kotlin', as there is an extension
     already registered with that name.
```

これが本当の、修正可能なエラーです。`Gradle task assembleDebug failed with exit code 1` は最初からそうではありませんでした。

Gradle のファイルを 1 つも触る前に実行しておく価値のある診断がもう 1 つあります。これだけで原因のひとつのクラス全体を捕まえられるからです。

```bash
# Validates the Java, Gradle, and AGP versions against each other
flutter analyze --suggestions
```

[Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide) がこのバリデーターを説明しています。JDK、Gradle ラッパー、AGP のバージョンを 3 つ組として評価し、どれが範囲外なのかを知らせてくれます。

## 原因 1: AGP 9 の組み込み Kotlin と `kotlin-android` プラグインの衝突

これが 2026 年における支配的な原因であり、最も誤診されやすいものです。Dart や Kotlin のコードが 1 行もコンパイルされる前の、Gradle の設定フェーズで発生するからです。

AGP 9.0 は組み込みの Kotlin サポートを同梱し、`kotlin` という名前の Gradle 拡張を自動的に登録します。旧来の Kotlin Gradle Plugin (`kotlin-android`、KGP とも呼ばれます) をまだ適用しているモジュールは、同じ名前で 2 つ目の拡張を登録しようとし、Gradle がそれを拒否します。

```text
Cannot add extension with name 'kotlin', as there is an extension
already registered with that name.
```

`A problem occurred configuring project ':x'` に示されるモジュール名から、原因が自分のアプリなのか依存しているパッケージなのかが分かります。`file_picker` や `wakelock_plus` のようなプラグインパッケージであれば、自分のビルドファイルでは直せません。パッケージを更新するか、組み込み Kotlin をオフにするかのどちらかです。

[アプリ開発者向けの組み込み Kotlin 移行ガイド](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers) によれば、緊急の逃げ道は `android/gradle.properties` に書きます。

```properties
# android/gradle.properties -- Flutter 3.44, AGP 9.x
android.newDsl=false
android.builtInKotlin=false
```

これでビルド全体が AGP 9 以前の挙動に戻り、Flutter の一時的な KGP シムが旧プラグインを動かし続けます。これは時間稼ぎであって、到達点ではありません。Flutter は将来のバージョンに向けて [KGP サポートの削除](https://github.com/flutter/flutter/issues/184837) と [旧 AGP DSL の削除](https://github.com/flutter/flutter/issues/184839) を登録済みです。

依存するすべてのプラグインが AGP 9 に対応したあとの本来の移行は、`android/app/build.gradle.kts` からプラグインと `kotlinOptions` ブロックを削除することです。

```kotlin
// android/app/build.gradle.kts -- AGP 9.0+, Flutter 3.47+
plugins {
    id("com.android.application")
    // id("kotlin-android")  <-- delete this line
}

android {
    // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <-- delete this block
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
```

そのうえでフラグを切り替えます。

```properties
# android/gradle.properties
android.builtInKotlin=true
```

バージョンの下限に注意してください。Flutter 3.44 はサポートする KGP の最小バージョンを 2.0.0 に引き上げ、ドキュメントは組み込み Kotlin の有効化に Flutter 3.47 以降が必要だと述べています。3.44 stable では、正しい選択は中途半端な移行ではなく、`android.builtInKotlin=false` とパッケージの更新です。逆に Kotlin プラグイン自体が古すぎるとビルドが訴える場合は、別の失敗であり解決策も異なります。詳しくは [Kotlin Gradle plugin のバージョンエラー](/ja/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) を参照してください。

## 原因 2: JDK と Gradle ラッパーが食い違っている

特徴はクラスファイルのメジャーバージョン番号です。

```text
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
...
Unsupported class file major version 65
```

メジャーバージョン 61 は Java 17、65 は Java 21 です。この数字はビルドを実行している JDK を示し、失敗の内容は Gradle ラッパーがそのバイトコードを理解するには古すぎることを示します。7.3 より前の Gradle は Java 17 ではそもそも動作せず、各 Gradle リリースには受け入れられる最新 JDK の上限があります。

これが最も痛いのは、自分では何も変えていないときです。Android Studio が更新され、同梱の JDK が 17 から 21 に変わり、5 年前の Gradle ラッパーが一晩で壊れます。

Flutter が使っている JDK を確認します。

```bash
flutter doctor -v
```

そのうえで、ラッパーを上げるか。

```bash
# From android/. Pick the version flutter analyze --suggestions recommends.
./gradlew wrapper --gradle-version=8.13
```

あるいは、ラッパーが扱える JDK に Flutter を固定します。

```bash
# macOS example. /usr/libexec/java_home -V lists installed JDKs.
flutter config --jdk-dir=/opt/homebrew/Cellar/openjdk@17/17.0.13/libexec/openjdk.jdk/Contents/Home
```

Gradle を前に進めるほうを選んでください。古い JDK に固定するのは、次の AGP 更新でもう一度代価を払う決断です。

## 原因 3: プラグイン間の NDK バージョン不一致

ネイティブコードを含むパッケージは NDK のバージョンを宣言します。そのうち 2 つがアプリの設定と食い違うと、ビルドは止まります。

```text
* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1101] NDK at .../ndk/26.3.11579264 did not have a source.properties file
```

あるいは、より明示的に次のように出ます。

```text
Your project is configured with Android NDK 26.3.11579264, but the following
plugin(s) depend on a different Android NDK version:
- path_provider_android requires Android NDK 27.0.12077973
```

NDK のリリースは後方互換なので、いずれかの依存が要求する最も高いバージョンを採用するのが解決策です。

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44
android {
    ndkVersion = "27.0.12077973"
}
```

エラーが `source.properties` の欠落に言及している場合、示された NDK ディレクトリは存在するものの、ダウンロードが途中で終わっています。Android SDK の `ndk/` フォルダー配下にあるそのディレクトリを削除し、SDK Manager からそのバージョンを再インストールしてから `flutter clean` を実行してください。

## 原因 4: プラグインが minSdkVersion を自分より高く引き上げている

マニフェストのマージは `assembleDebug` の中で行われるため、SDK レベルの衝突も同じ汎用ラッパーとして現れます。

```text
* What went wrong:
Execution failed for task ':app:processDebugMainManifest'.
> Manifest merger failed : uses-sdk:minSdkVersion 21 cannot be smaller than
  version 23 declared in library [:some_plugin]
```

`tools:overrideLibrary` でマージを抑え込むのではなく、下限を引き上げてください。抑え込みは、除外した端末でのクラッシュをランタイムに先送りするだけです。

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 23
    }
}
```

具体的なパッケージでの同じ形の失敗は、[background_fetch が minSdkVersion 21 を要求する件](/ja/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) の記事で順を追って扱っています。マージャーがサポートライブラリの重複クラスについて訴えている場合は、まったく別の問題です。[Flutter の Android ビルドにおける AndroidX の衝突](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/) を参照してください。

## 原因 5: メンテナンスされていないプラグインに namespace がない

AGP 8.0 は `namespace` プロパティを必須にし、`AndroidManifest.xml` の `package` を読まなくなりました。AGP 7 の時代から更新されていないパッケージは設定段階で失敗します。

```text
* What went wrong:
A problem occurred configuring project ':some_old_plugin'.
> Namespace not specified. Specify a namespace in the module's build file.
```

自分のアプリから他人のパッケージに namespace を注入する、サポートされた方法はありません。望ましい順に、パッケージを更新する、置き換える、フォークして `android/build.gradle` に `namespace 'com.example.some_old_plugin'` を追加する、のいずれかです。このエラーに対して `~/.pub-cache` 配下のファイルを書き換えるスクリプトが広く出回っていますが、これは罠です。キャッシュは再生成されるため、修正は次のマシンでも CI でも消えます。

## 原因 6: ディスク上の状態以外に問題がない

終了コード 1 のすべてが設定の問題というわけではありません。`build/` に書きかけのアーティファクトが残っている、Gradle デーモンが古い classpath を保持している、`.dart_tool` ディレクトリが別の SDK バージョンのものである。いずれも構造的に見えて実はそうではない失敗を生みます。長いデバッグセッションに入る前に、安上がりなケースを片付けましょう。

```bash
flutter clean
cd android && ./gradlew --stop && ./gradlew clean && cd ..
flutter pub get
flutter run
```

これでビルドが通れば、古い状態の問題だったのであり、他に直すものはありません。途中で `pub get` が失敗する場合、制約ソルバーの出力はそれ自体が別の診断作業です。[pubspec.yaml の version solving failed エラーの読み方](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) で扱っています。

## 誤ってこのページに辿り着く類似ケース

- **`Gradle task assembleRelease failed with exit code 1`**: release バリアントを包む同じラッパーです。上記すべてが当てはまり、加えて release でしか動かない R8 と縮小処理が関わります。debug は通って release が通らないなら、まず `isMinifyEnabled = false` にして R8 が原因かどうかを確かめ、縮小を切ったままにするのではなく不足している keep ルールを補ってください。
- **`Gradle task assembleDebug failed with exit code 1` が 2 秒以内に即座に出る**: これはコンパイルの失敗ではありません。Gradle が起動できなかったのです。`android/gradle/wrapper/gradle-wrapper.properties` のラッパー配布 URL と、`services.gradle.org` へのネットワークアクセスを確認してください。
- **`Execution failed for task ':app:checkDebugAarMetadata'`**: 依存関係がアプリの宣言より高い `compileSdk` を要求しています。`android/app/build.gradle.kts` の `compileSdk` を上げてください。これはコンパイル時の上限であってランタイムのターゲットではないため、上げても端末上の挙動は変わりません。
- **CI でだけ失敗する**: ランナーの JDK、Android SDK、NDK のバージョンを自分のマシンと比較してください。ローカルは通るのに CI で落ちるという報告のほぼすべてが原因 2 と原因 3 で説明でき、どちらもコードではなく環境の形をした問題です。
- **Flutter をアップグレードしたあとに失敗が出はじめた**: 症状をデバッグする前に、そのリリースの破壊的変更の一覧を確認してください。テンプレートの AGP と Gradle のバージョンも動かすフレームワークの大きな更新は、上記の原因を一度に複数踏むことがあります。[Flutter 2 から Flutter 3 へのアップグレード](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) と同じ構図です。

一般的な教訓はこのメッセージ 1 つにとどまりません。Flutter のビルド失敗が Gradle のタスク名と終了コードを挙げているときは、ツールは伝達役にすぎません。`android/` に移動し、自分でそのタスクを `--stacktrace` 付きで実行し、`* What went wrong:` の下のブロックを読んでください。解決策は常にそのブロックにあり、Flutter が出力した行には決してありません。

## 関連記事

- [修正: Flutter の Android ビルドにおける AndroidX の衝突](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)：同じ設定失敗の重複クラス版と、AGP 8 が Jetifier をオフにしたことで再燃した理由。
- [Flutter: プロジェクトにより新しい Kotlin Gradle plugin が必要です](/ja/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)：KGP のバージョン下限。上記の AGP 9 の拡張衝突とは別の失敗です。
- [修正: background_fetch が minSdkVersion 21 を要求する](/ja/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/)：原因 4 のマニフェストマージにおける SDK 衝突の具体例。
- [修正: pubspec.yaml の Version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)：クリーンアップ手順の `flutter pub get` 自体が失敗したときの対処。
- [Flutter 2 のアプリを Flutter 3.x へ移行する: null safety チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)：これらの Gradle 起因の問題を一度に複数踏みがちな、より広いアップグレード経路。

## 参考資料

- [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide)、Flutter ドキュメント
- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin)、Flutter ドキュメント
- [Built-in Kotlin migration for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers)、Flutter ドキュメント
- [Flutter maintained plugins should support AGP 9.0](https://github.com/flutter/flutter/issues/181383)、flutter/flutter
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html#java)、Gradle ドキュメント
- [Android Gradle Plugin release notes](https://developer.android.com/build/releases/gradle-plugin)、Android Developers
