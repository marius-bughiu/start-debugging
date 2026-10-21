---
title: "修正: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is X, expected version is Y (Flutter Android)"
description: "依存ライブラリが、ビルドのコンパイラーより少なくともマイナーバージョン 2 つ新しい Kotlin でビルドされています。settings.gradle.kts の org.jetbrains.kotlin.android のバージョンを X マイナス 1 以降に上げるか、依存ライブラリを古いバージョンに固定してください。"
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "kotlin"
  - "gradle"
lang: "ja"
translationOf: "2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-21
---

結論から言うと、Android のクラスパス上のあるライブラリ (多くの場合、推移的に取り込まれた新しい `kotlin-stdlib`) が、ビルドで実際に動いているコンパイラーより少なくともマイナーリリース 2 つ先の Kotlin バージョンでコンパイルされています。コンパイラーが読み込めるのは、1 つ先のマイナーバージョンまでのメタデータだけです。`android/settings.gradle.kts` の `org.jetbrains.kotlin.android` のバージョンを少なくとも"X マイナス 1 マイナー"まで上げて (メタデータ 2.4.0 の場合は KGP 2.3.x 以降)、再ビルドしてください。以下の内容はすべて、Flutter 3.44.8、AGP 9.0.1、Gradle 9.1.0、Kotlin 2.4.21 のアーティファクトで再現を確認しています。

## エラーの全体像

`flutter build apk` または `flutter run` を実行すると、`compileDebugKotlin` (または `compileReleaseKotlin`) タスクが失敗し、問題の jar 内の Kotlin モジュールファイルごとに 1 行ずつエラーが出力されます。

```text
> Task :app:compileDebugKotlin FAILED
e: file:///Users/me/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.4.21/.../kotlin-stdlib-2.4.21.jar!/META-INF/kotlin-stdlib.kotlin_module Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0.
e: file:///.../MainActivity.kt:6:19 Unresolved reference 'listOf'.

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details
```

失敗しているコードがアプリ本体ではなくプラグイン側にある場合は、同じ不一致がクラスごとに報告され、メッセージもより新しく親切な文言になります。

```text
> Task :shared_preferences_android:compileDebugKotlin FAILED
e: Incompatible classes were found in dependencies. Remove them from the classpath or use '-Xskip-metadata-version-check' to suppress errors
e: .../shared_preferences_android-2.5.1/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt:47:5 Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read versions up to 2.3.0.
```

末尾の "Unresolved reference" エラー (`listOf`、`startsWith`、`it`) はノイズです。コンパイラーが標準ライブラリの読み込みを拒否するため、標準ライブラリのシンボルがすべて未解決になっているだけです。最初のエラーを直せば、これらはすべて消えます。

## コンパイラーが新しいメタデータを拒否する理由

Kotlin/JVM のクラスファイルにはすべて `@kotlin.Metadata` アノテーションが付いており、すべての jar には `META-INF/*.kotlin_module` ファイルがあります。どちらにも、それを生成したコンパイラーのメタデータバージョンが記録されています。Kotlin の[進化の原則](https://kotlinlang.org/docs/kotlin-evolution-principles.html)は後方互換性 (新しいコンパイラーは古いバイナリをすべて読める) を約束していますが、前方互換性は次の言語リリースまでのベストエフォートで、それ以降は対象外です。コンパイラーはこのルールを最初に強制します。2.2 のコンパイラーは 2.3.0 までのメタデータを受け付け、2.4.0 は拒否します。新しいほうのメッセージが "the compiler version 2.2.0 can read versions up to 2.3.0" と明示しているのは、まさにこのことです。

したがって、エラーに含まれる 2 つの数値は次の意味です。

- **"binary version of its metadata is X"**: パスに示された jar ファイルをコンパイルした Kotlin のバージョンです。
- **"expected version is Y"**: Gradle ビルドが実行している Kotlin コンパイラーのバージョンで、ビルドのクラスパス上の Kotlin Gradle Plugin (KGP) から決まります。Android Studio にインストールされている Kotlin ではなく、入力したバージョンとも限りません。

Flutter アプリで原因になるのは、ほとんどの場合、次のいずれかです (頻度の高い順)。

1. **プラグインまたは AndroidX/Google ライブラリの更新**によって、新しい `kotlin-stdlib` が推移的に取り込まれる場合です。Gradle の競合解決は要求された中で最も高い stdlib を選ぶため、最新の依存ライブラリが 1 つあるだけで、モジュール全体の stdlib が引き上げられます。
2. **プロジェクトの KGP が古い**場合です。何年も前にアプリを作成したまま、`settings.gradle.kts` (または Flutter 3.16 より前の `android/build.gradle` にある `ext.kotlin_version`) を一度も更新していないケースが典型です。
3. **新しい Kotlin でコンパイルされたプラグインが、Kotlin クラスを含むビルド済みの AAR や jar を同梱している**場合です (マップ、決済、分析などの SDK をラップするプラグインでよくあります)。

## 最小の再現手順

新しい Flutter 3.44.8 プロジェクトから始めて、KGP を下げ、Kotlin 2.4 でビルドされた依存ライブラリを 1 つ追加します。

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false // template ships 2.3.20
}
```

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8
dependencies {
    // Stands in for any library compiled with Kotlin 2.4.x
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
}
```

```kotlin
// android/app/src/main/kotlin/com/example/kapp/MainActivity.kt -- Kotlin source that touches stdlib
package com.example.kapp

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    val doubled = listOf(1, 2, 3).map { it * 2 }
}
```

バージョンを変更し始める前に、再現で分かった 2 つの点を押さえておいてください。

**宣言したバージョンが、実際に動くバージョンとは限りません。** KGP 2.0.21 を宣言したにもかかわらず、エラーには "expected version is 2.2.0" と表示され、Flutter Gradle Plugin も "Flutter support for your project's Kotlin version (2.2.10) will soon be dropped" と警告しました。AGP 9.0.1 は `kotlin-gradle-plugin:2.2.10` へのランタイム依存を宣言しており、Gradle はビルドのクラスパスを要求された中で最も高いバージョンに解決します。AGP が持ち込むバージョンより*低い* KGP を宣言しても、まったく効果はありません。"expected version" は設定ファイルではなく、エラーメッセージから読み取ってください。

**このエラーは、Kotlin コードが新しいクラスに触れたときにだけ発生します。** 既定の 1 行の `class MainActivity : FlutterActivity()` では、同じクラスパスでも問題なくビルドできました。コンパイラーが stdlib のメタデータをデシリアライズする必要がなかったためです。`listOf(...)` を追加した途端に壊れました。このため、依存ライブラリの更新が数週間前だったとしても、`MainActivity` やメソッドチャネルのハンドラーに数行の Kotlin を追加したときに、エラーが"突然"現れるように見えます。

## 修正 1: Kotlin Gradle Plugin を上げる (推奨)

ルールは、KGP のマイナーバージョンが、ライブラリのメタデータのマイナーバージョンから 1 を引いた値以上であることです。メタデータ 2.4.0 なら 2.3.x 以降になります。完全に合わせる (2.4.x) のが最も安全です。

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
```

2.3.20 にすると、同じ再現プロジェクトがきれいにコンパイルできました (`BUILD SUCCESSFUL`)。1 マイナーバージョン分の先読みで十分です。次の順番で進めてください。

1. エラーから X を読み取ります ("binary version of its metadata is 2.4.0")。
2. `android/settings.gradle.kts` (または `settings.gradle`) を開き、`org.jetbrains.kotlin.android` のバージョンを X マイナス 1 マイナー以降に設定します。Flutter 3.16 より前に作成されたプロジェクトでは、バージョンは `android/build.gradle` の `buildscript` 内にある `ext.kotlin_version = '...'` にあるので、そこを変更します。
3. 新しい KGP が AGP と Gradle に対応しているかを、[Kotlin Gradle plugin の互換性表](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)で確認します。KGP 2.3.20 は Gradle 7.6.3 から 9.3.0、AGP 8.2.2 から 9.0.0 に対応しており、KGP 2.4.20 には AGP 8.5.2 以降が必要です。AGP 7.x を使っている古い Flutter プロジェクトでは、同じ変更で AGP と Gradle も上げる必要があります。
4. `flutter clean` を実行して再ビルドし、古いコンパイラーによる Gradle のキャッシュ済み出力が残らないようにします。

Flutter 3.44.8 自身のツールもこれを裏付けています。テンプレートは KGP 2.3.20 を同梱しており、Flutter Gradle Plugin は 2.2.20 未満で警告、2.0.0 未満でエラーにします (`packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` の `warnKGPVersion` と `errorKGPVersion`)。まだ Kotlin 1.x のプロジェクトを使っている場合は、現在のほぼすべての AndroidX リリースでこのエラーに当たることになるので、いずれにせよ行うべきアップグレードです。

## 修正 2: エラーがプラグインモジュールで出ても、アプリ側で直す

失敗しているタスクが `:some_plugin:compileReleaseKotlin` だと、プラグインの `build.gradle` が悪いと考えたくなります。再現結果を見ると、そのファイルを直しても意味がないことが分かります。`shared_preferences_android` 2.5.1 は、自身の buildscript で独自の KGP を宣言しています。

```kotlin
// ~/.pub-cache/hosted/pub.dev/shared_preferences_android-2.5.1/android/build.gradle.kts (excerpt)
val kotlinVersion = "2.3.0"
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
```

それでもエラーには "the compiler version 2.2.0" と出ました。プラグインはアプリの Gradle ビルドのサブプロジェクトであり、ルートビルドで既に読み込まれている KGP (`settings.gradle.kts` 由来で、AGP によって引き上げられている場合もあります) がそれらをコンパイルします。プラグイン側の宣言は優先されません。そのため、次のようにします。

1. 修正 1 と同じように、アプリの `android/settings.gradle.kts` で KGP を上げます。
2. プラグイン自体が古い Kotlin を固定していて、それでも失敗する場合は、プラグインを更新します (`flutter pub upgrade <name>`、または `pubspec.yaml` の制約を引き上げます)。`~/.pub-cache` 配下のファイルは編集しないでください。`pub get` で上書きされます。

## 修正 3: 新しい Kotlin を持ち込んだ依存ライブラリを特定して固定する

今すぐ KGP を上げられない場合 (リリースブランチ、固定された CI イメージなど) もあります。その場合は、新しい stdlib を要求しているのが誰かを突き止め、その依存ライブラリを古いバージョンに固定します。`android/` フォルダーから実行します。

```bash
./gradlew :app:dependencyInsight --dependency org.jetbrains.kotlin:kotlin-stdlib --configuration releaseRuntimeClasspath
```

私の再現では、"Selection reasons" セクションが 1 行で全体像を説明していました。

```text
- By conflict resolution: between versions 2.4.21, 2.2.10, 1.8.22, 2.0.21, 1.6.21, 1.7.10, 1.8.10, 1.3.20, 1.8.20, 1.9.24, 2.0.0, 1.9.25 and 2.0.20
```

その下では、`org.jetbrains.kotlin:kotlin-stdlib:1.x -> 2.4.21` の各行が、それを要求した依存ライブラリの下にインデントされて表示されます。ツリーをたどって 2.4.x を要求しているものを見つけ、そのライブラリか、それを持ち込む Flutter プラグインをダウングレードします。プラグインの推移的依存の場合は、同じコマンドをプラグインのプロジェクトに対して実行します (`:plugin_name:dependencyInsight`)。固定はあくまで短期的な対処です。ライブラリの作者が新しい Kotlin に移行したのには理由があり、他の何かを更新すると、またここに戻ってくることになります。

`resolutionStrategy.force(...)` で `kotlin-stdlib` を強制的に下げて"直そう"とするのはやめてください。ライブラリは新しい stdlib API に対してコンパイルされているため、古い stdlib に存在しない関数を呼び出す可能性があり、コンパイルエラーが実行時の `NoSuchMethodError` に変わってしまいます。

## 修正 4: -Xskip-metadata-version-check (最後の手段)

コンパイラー自身のメッセージがフラグを提案しており、実際に動作します。

```kotlin
// android/app/build.gradle.kts -- Kotlin compiler option, use only temporarily
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

これを付けると、再現プロジェクトはビルドできました。ただし `-X` フラグはサポート対象外であり、安全確認を無効にするだけです。コンパイラーは、理解できない形式のメタデータを読み込むことになります。新しいライブラリが、お使いのコンパイラーで解釈できない形で符号化された言語機能を使っている場合、明確なエラーではなく、誤ったシグネチャやコンパイラーのクラッシュが発生します。また、指定したモジュールにしか適用されないため、失敗しているプラグインモジュールは引き続き失敗します。緊急修正のビルドを通すために使い、KGP を上げたら削除してください。

## ここにたどり着く似たエラー

- **`Your project requires a newer version of the Kotlin Gradle plugin`**: これは Kotlin コンパイラーではなく、Flutter 自身の事前チェックです。対処方法は異なり、[古い KGP バージョンのエラーに関する記事](/ja/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)で解説しています。
- **`Daemon compilation failed: null`**: Kotlin デーモン内で発生するインクリメンタルコンパイルのクラッシュで、バージョンの不一致ではありません。[Daemon compilation failed: null の修正](/ja/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)を参照してください。
- **AGP 9 へ移行した直後の Kotlin エラー**: AGP をアップグレードしたときにビルドが壊れ、`Cannot add extension with name 'kotlin'` が表示される場合は、組み込み Kotlin への移行が原因です。[AGP 9 移行ガイド](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)で、`settings.gradle.kts` の KGP の行を残す必要がある理由も含めて説明しています。
- **`Execution failed for task ':app:compileFlutterBuildDebug'` または単なる `exit code 1`**: Flutter が表示する要約行は、本当の Gradle エラーを隠しています。上にスクロールするか `--verbose` を付けて再実行してください。見る場所は [assembleDebug の exit code 1 ガイド](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)で確認できます。
- **Kotlin 2 だと思っているプロジェクトで "Expected version is 1.x"**: 見ているファイルが違います。`android/build.gradle` に残っている `ext.kotlin_version` や、ルートプロジェクトの `buildscript` ブロックが古い `kotlin-gradle-plugin` をクラスパスに入れていないか確認してください。

## 関連記事

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Fix: Daemon compilation failed: null in a Flutter Android Gradle build](/ja/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Fix: Gradle task assembleDebug failed with exit code 1 in Flutter](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Timeout waiting to lock journal cache in a Flutter Android build](/ja/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## 参考資料

- [Kotlin evolution principles: binary compatibility](https://kotlinlang.org/docs/kotlin-evolution-principles.html)
- [Kotlin Gradle plugin: compatibility with Gradle and AGP](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) (KGP 2.2.10 のランタイム依存)
- [Flutter: Kotlin and Gradle version requirements](https://docs.flutter.dev/release/breaking-changes/kotlin-version)
- [flutter/flutter#179253](https://github.com/flutter/flutter/issues/179253)、期待バージョン 1.8.0 に対してメタデータ 2.2.0 という同じ不一致の報告
