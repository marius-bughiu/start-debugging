---
title: "Flutter の Android プロジェクトを built-in Kotlin 付きの AGP 9 へ移行する"
description: "kotlin-android を適用している AGP 8 の Flutter アプリから、Flutter 3.47 上で android.builtInKotlin=true を有効にした AGP 9.1 までの全手順です。すべてのステップを実際にビルドして計測しました。省略できそうに見えて実は必須の 2 つの編集も含みます。KGP 2.2 以降では kotlinOptions がコンパイルエラーになり、settings.gradle.kts の KGP の行は残す必要があります。"
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "ja"
translationOf: "2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin"
translatedBy: "claude"
translationDate: 2026-09-18
---

Flutter 3.44 より前に作成された Flutter アプリの場合、移行は 4 つの編集で済みます。Gradle wrapper を 9.3.1 に、AGP を 9.1.0 に上げること、`settings.gradle.kts` の Kotlin Gradle Plugin (KGP) のバージョンを 2.4.0 に上げつつその行自体は残すこと、`kotlinOptions` をトップレベルの `kotlin { compilerOptions { ... } }` ブロックに置き換えること、そして `app/build.gradle.kts` から `id("kotlin-android")` を削除することです。その後 `gradle.properties` で `android.builtInKotlin=true` に切り替えます。これには Flutter 3.47 以降が必要で、依存しているすべてのプラグインが KGP をやめてからでないと有効にできません。依存関係が最新のアプリなら 1 時間ほど、`kotlin-android` を適用したままのプラグインがあればもっとかかると見ておいてください。今やっておく価値はあります。Flutter はすでに 8.14 未満の Gradle や 8.11.1 未満の AGP ではビルドを拒否しますし、KGP サポートを完全に削除することも発表済みです ([flutter#184837](https://github.com/flutter/flutter/issues/184837))。

以下はすべて Flutter 3.47.4 stable (framework revision `9584c6713b`、Dart 3.13)、OpenJDK 17.0.20、Android SDK build-tools 36.1 で実行しました。出発点は Flutter 3.35 の `android-kotlin` テンプレートとまったく同じ構成のプロジェクトで、AGP 8.9.1、KGP 2.1.0、Gradle 8.12、app モジュールに `id("kotlin-android")`、そして `kotlinOptions` ブロックがあります。最終状態は Flutter 3.44.8 でも確認しました。各ステップには実際に得られた出力をそのまま載せています。

## この移行がもはや任意ではない理由

- **Flutter 3.47 は、2025 年時点の AGP 8 プロジェクトが満たしていない下限を強制します。** 3.47.4 の `DependencyVersionChecker.kt` は、Gradle 8.14.0 未満、AGP 8.11.1 未満、KGP 2.2.20 未満でエラーを出し、Gradle 9.1.0、AGP 9.0.1、KGP 2.3.20 未満で警告を出します。手を加えていない 3.35 時代のプロジェクトは、最初のビルドで `Your project's Gradle version (8.12.0) is lower than Flutter's minimum supported version of 8.14.0` により失敗しました。
- **AGP 9 は 2 つのデフォルトを切り替えます。** [AGP 9.0 のリリースノート](https://developer.android.com/build/releases/agp-9-0-0-release-notes)によると、`android.builtInKotlin` と `android.newDsl` はどちらもデフォルトで `true` です。built-in Kotlin とは AGP 自身が Kotlin をコンパイルすることを意味し、`org.jetbrains.kotlin.android` を適用するとエラーになります。
- **オプトアウトはどちら側でも一時的なものです。** Flutter 自身のテンプレートは現在 `android.builtInKotlin=false` と `android.newDsl=false` 付きで出荷されていますが、[built-in Kotlin 移行の概要](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin)には将来の Flutter リリースで KGP サポートが削除されると書かれており、Google は `newDsl=false` という逃げ道が AGP 10 でなくなるとしています。
- **プラグインも同じルールで判定されます。** built-in Kotlin を有効にすると、`kotlin-android` を適用したままのプラグインは、そのプラグインの CI ではなく、あなたのビルドを失敗させます。そうしたプラグインを早めに見つけることが、実際の作業の大半です。

## 壊れるもの

| 領域 | 変更点 | 深刻度 |
| --- | --- | --- |
| Gradle wrapper | Flutter 3.47 は 8.14 未満でエラー、AGP 9.1 は 9.3.1 が必要 | 高 |
| app モジュールの `kotlin-android` | built-in Kotlin を有効にすると失敗 | 高 |
| `kotlinOptions { jvmTarget = ... }` | KGP 2.2 以降でスクリプトのコンパイルエラー | 高 |
| KGP を適用するプラグイン | `android.builtInKotlin=true` にするとビルドが失敗 | 高 |
| `android.newDsl=true` | Flutter Gradle Plugin がまだ古い DSL にキャストするため `ClassCastException` | 高 (`false` のままにする) |
| `settings.gradle.kts` の KGP エントリ | 削除すると Kotlin が AGP 同梱の 2.2.10 に下がり、Flutter の下限を下回る | 中 |
| `build.gradle` (Groovy) プロジェクト | 編集内容は同じで構文が異なる。3.16 より前の `buildscript` 構成では先に declarative plugins への移行が必要 | 中 |

## 事前チェックリスト

- **開発マシンと CI の両方に Flutter 3.47.x。** Flutter 3.44 は built-in Kotlin を*無効*にした状態で AGP 9 をサポートしました。有効化がサポートされるのは 3.47 からです。`flutter --version` で確認してください。
- **Gradle 用に JDK 17 以降。** AGP 9 は JDK 17 を必要とします。`flutter doctor -v` は Flutter が Gradle に渡す JDK を表示します。それが JRE や JDK 11 であれば、先にそちらを直してください (Flutter がどのように JDK を選ぶかは [JAVA_COMPILER ツールチェーンのエラー](/ja/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)を参照)。
- **Android SDK build-tools 36.0.0 以降。** これが AGP 9 の最低要件です。
- **クリーンな作業ツリー。** Flutter ツールは 3.44 以降で初めてビルドする際に `gradle.properties` を勝手に書き換えるので、始める前にコミットし、終わったあとに diff を取ってください。
- **Android プラグインの一覧。** `flutter pub deps --style=compact` で十分です。ステップ 6 で、それぞれの changelog に built-in Kotlin 対応が書かれているか確認します。

## 移行手順

1. **Flutter ツールに 2 つのオプトアウトフラグを追加させ、それを確認します。** Flutter 3.44 以降で Android ビルドを一度実行してください。ツールのマイグレーターは、2 つのフラグが無ければ `android/gradle.properties` に両方を追記します。私のプロジェクトではビルド自体は (Gradle 8.12 のせいで) まだ失敗しましたが、ファイルはすでに書き換えられていました。

   ```properties
   # android/gradle.properties, written by the Flutter 3.47.4 migrators
   org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError
   android.useAndroidX=true
   # This builtInKotlin flag was added automatically by Flutter migrator
   android.builtInKotlin=false
   # This newDsl flag was added automatically by Flutter migrator
   android.newDsl=false
   ```

   add-to-app のホストプロジェクトではマイグレーターは実行されません。ホストは普通の Android プロジェクトだからです。その場合はホストの `gradle.properties` に 2 行を手で追加します。確認: `grep -E 'builtInKotlin|newDsl' android/gradle.properties` が 2 行とも出力すること。

2. **Gradle wrapper を 9.3.1 に上げます。** AGP 9.0.x には Gradle 9.1.0 以降が必要で、Flutter のツールは AGP 9.1.x に 9.3.1 以降を組み合わせます。これは Flutter 3.47 のテンプレートが同梱しているバージョンでもあります。

   ```properties
   # android/gradle/wrapper/gradle-wrapper.properties, Flutter 3.47.4
   distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-all.zip
   ```

   確認: `cd android && ./gradlew --version` が `Gradle 9.3.1` を表示すること。

3. **`settings.gradle.kts` の AGP と KGP を上げ、Kotlin の行は残します。** 以下は 3.47.4 の `flutter create` が書き出すバージョンです。

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.1.0" apply false
       id("org.jetbrains.kotlin.android") version "2.4.0" apply false
   }
   ```

   移行の目的が KGP をやめることなので、`org.jetbrains.kotlin.android` の行を消したくなります。消さないでください。`apply false` 付きであれば、この行はその Kotlin バージョンをビルドのクラスパスに載せるだけで、built-in Kotlin はそのバージョンでコンパイルします。私が削除したところ、AGP 9.1.0 は同梱の Kotlin 2.2.10 にフォールバックし、Flutter Gradle Plugin がビルドを拒否しました: `Your project's Kotlin version (2.2.10) is lower than Flutter's minimum supported version of 2.2.20`。この行は `builtInKotlin=false` の間も重要です。その状態では、Flutter Gradle Plugin が、自分では適用していないすべての Android サブプロジェクトに `kotlin-android` を自ら適用し、そのためにクラスパス上の KGP を必要とするからです。

   確認: まだありません。ステップ 4 まではビルドが失敗し続けます。

4. **`kotlinOptions` を `compilerOptions` DSL に置き換えます。** これは多くの人が驚く編集です。built-in Kotlin に手を付ける前から必須だからです。AGP 9.1.0、KGP 2.4.0、`kotlin-android` を適用したまま、`builtInKotlin=false` の状態で、私のビルドはスクリプトのコンパイル中に失敗しました。

   ```text
   Script compilation errors:
     Line 18:     kotlinOptions {
                  ^ 'fun BaseAppModuleExtension.kotlinOptions(configure: Action<DeprecatedKotlinJvmOptions>): Unit' is deprecated. Please migrate to the compilerOptions DSL.
     Line 19:         jvmTarget = JavaVersion.VERSION_11.toString()
                      ^ 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   ```

   [Kotlin 2.2.0 で `kotlinOptions` の非推奨がエラーに引き上げられ](https://kotlinlang.org/docs/whatsnew22.html)、Flutter 3.47 は KGP 2.2.20 未満にとどまることを許さないので、`kotlinOptions` が生き残るバージョンの組み合わせは存在しません。JVM ターゲットを `android {}` ブロックからトップレベルの `kotlin {}` ブロックへ移します。

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   android {
       // ...
       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }
       // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <- delete
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }
   ```

   `jvmTarget` は `targetCompatibility` と揃えてください。古いテンプレートは 11、新しいテンプレートは 17 を使っていますが、2 つが一致していればどちらでも動きます。確認: `flutter build apk --debug` が成功すること。この時点では `WARNING: Your Android app project: app ... applies the Kotlin Gradle Plugin, which will cause build failures in future versions of Flutter.` も表示されます。この警告は想定どおりで、ステップ 5 で消します。

5. **app モジュールから `kotlin-android` を削除します。** プラグインの行だけを消し、それ以外には触れません。

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4
   plugins {
       id("com.android.application")
       // id("kotlin-android")  <- delete
       // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
       id("dev.flutter.flutter-gradle-plugin")
   }
   ```

   app モジュールがバージョンカタログ形式を使っている場合、削除する行は `alias(libs.plugins.kotlin.android)` です。Groovy の `build.gradle` なら `apply plugin: 'kotlin-android'` または `id "kotlin-android"` で、ステップ 4 の `kotlin { compilerOptions { ... } }` ブロックはそのままで有効な Groovy です。確認: `flutter build apk --debug` が `app` に対する KGP の警告なしで成功すること。`builtInKotlin` がまだ `false` なので、Flutter Gradle Plugin が代わりに KGP を適用しており、それがこの中間状態でビルドが通る理由です。

6. **まだ KGP を適用しているプラグインを見つけます。** `builtInKotlin=false` のままもう一度ビルドし、Gradle の出力を読みます。Flutter 3.47 が名前を挙げてくれます。

   ```text
   WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin (KGP): oldplug
   Future versions of Flutter will fail to build if your app uses plugins that apply KGP.
   Please check the changelogs of these plugins and upgrade to a version that supports Built-in Kotlin.
   ```

   挙げられた各プラグインについて、changelog に built-in Kotlin や AGP 9 への言及がある新しいバージョンが pub.dev にないか確認し、アップグレードします。存在しなければ、プラグインに issue を立て (Flutter のアプリ開発者向けガイドに [issue テンプレート](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers#report-incompatible-kotlin-gradle-plugin-usage-to-plugin-authors)があります)、ここで止めてください。built-in Kotlin を無効にした AGP 9 という状態であり、これはサポートされた状態です。確認: 警告にプラグインが 1 つも挙がらなくなること。

7. **built-in Kotlin を有効にします。** ステップ 6 がクリーンになってからにしてください。

   ```properties
   # android/gradle.properties, Flutter 3.47.4, AGP 9.1.0
   android.builtInKotlin=true
   android.newDsl=false
   ```

   `android.newDsl=false` はそのままにします。確認: `flutter build apk --debug` が KGP の警告なしで成功し、続いて `flutter run` で実機またはエミュレーター上でアプリが起動すること。

## 検証チェックリスト

- `flutter build apk --debug` と `flutter build appbundle --release` の両方が、出力に `applies the Kotlin Gradle Plugin` の警告なしで成功すること。
- Kotlin コードが実際に APK に入っていること。built-in Kotlin はコンパイラーの経路が異なるので、私はこれを確認しました。APK を `unzip` し、`classes*.dex` ファイルから自分の `MainActivity` を探します。移行後の私のプロジェクトでは、`Lnet/sd/app347/MainActivity;` が `classes4.dex` に入っていました。
- `flutter test` と `integration_test` のスイートが Android デバイス上で引き続きパスすること。
- CI が同じ Flutter バージョンと JDK 17 を使っていること。Flutter 3.44 のままの CI イメージは built-in Kotlin を有効にしてもビルドできますが、紛らわしいメッセージを表示します (注意点を参照)。
- `git diff android/` に上記のファイルしか出てこないこと。マイグレーターが黙って他の何かを書き換えていたら、コミット前に読んでおく価値があります。

## ロールバック計画

この移行はどのステップでも元に戻せ、最も手軽なのは部分的なロールバックです。ステップ 7 のあとでプラグインが壊れたら、`android.builtInKotlin=false` に戻してください。このフラグがあれば AGP 9 は KGP を受け入れ、Flutter Gradle Plugin は必要なモジュールに `kotlin-android` を再適用するので、app モジュールに `kotlin-android` の行を戻す必要はありません。AGP 8 への完全なロールバックは `settings.gradle.kts` と wrapper を git から復元することを意味しますが、Flutter 3.47 では AGP 8.11.1、Gradle 8.14、KGP 2.2.20 を下回れないので、"ロールバック" とは実際には元の 8.9 ではなく AGP 8.11 以降を意味します。ステップ 4 の `kotlin { compilerOptions }` への変更は、どちらの場合も残ります。

## 途中でハマった注意点

**最初のエラーは Kotlin とはまったく関係ありません。** 未移行のプロジェクトで、Flutter 3.47.4 は本当の問題 (Gradle 8.12 が 8.14 未満) を Gradle の出力の中に表示し、その下に枠で囲まれた "Flutter Fix" を出して `Starting AGP 9+, only the new DSL interface will be read` と言い、`android.newDsl` をオプトアウトするよう提案しました。プロジェクトは AGP 8.9.1 だったにもかかわらずです。この枠は Flutter Gradle Plugin の適用に失敗すると何でも発火するヒューリスティックなので、まず `* What went wrong:` のセクションを読んでください。これは [assembleDebug の exit code 1 ガイド](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)と同じアドバイスです。

**`kotlin-android` の消し忘れに対するエラーメッセージは KGP のバージョンによって変わります。** KGP 2.4.0 では明示的です。

```text
> Failed to apply plugin 'kotlin-android'.
   > ⛔ Failed to apply plugin 'org.jetbrains.kotlin.android'
     The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.
     Solution: Remove the 'org.jetbrains.kotlin.android' plugin from this project's build file: app/build.gradle.kts.
```

古い KGP バージョンでは同じミスが `Cannot add extension with name 'kotlin'` として現れ、Stack Overflow の回答の多くが引用しているのはこちらの形です。原因がプラグインの場合は `Solution:` の行が役に立ちます。私のテスト用プラグインでは `../../oldplug/android/build.gradle.kts` を指していました。pub.dev のパッケージなら、パスは `~/.pub-cache/hosted/pub.dev/<package>-<version>/android/` の中を指すので、どのパッケージをアップグレードすべきかが正確にわかります。pub キャッシュ内のファイルは編集しないでください。次の `pub get` で上書きされます。

**`android.newDsl=true` は今でも確実に失敗します。** 他をすべて移行した状態でこれを設定すると、`class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated cannot be cast to class com.android.build.gradle.AbstractAppExtension` が発生しました。Flutter Gradle Plugin はまだレガシーな DSL の型を読んでいます ([flutter#180137](https://github.com/flutter/flutter/issues/180137) が移植を追跡しています)。Flutter のリリースが別の指示を出すまでフラグは `false` のままにし、そのリリースが AGP 10 より前に来る前提で計画してください。

**Flutter 3.44 では built-in Kotlin を有効にすると中途半端に動きます。** ドキュメントには `android.builtInKotlin=true` には 3.47 が必要とあります。それでも私は完全に移行したプロジェクトを Flutter 3.44.8 で実行してみました。APK はビルドでき、`MainActivity` も dex に入っていましたが、ツールは `Applying the Kotlin Android Plugin (KGP) was unsuccessful. KGP was not found on the classpath.` と表示しました。これは 3.44 の Flutter Gradle Plugin から来ており、このプラグインはフラグを読まずに KGP を適用しようとします。単純なアプリなら無害ですが CI のログでは紛らわしいので、ドキュメントどおり 3.47 を実質的な最低バージョンとして扱ってください。

**3.16 より前のプロジェクトは、先に別の移行が必要です。** `android/build.gradle` にまだ `buildscript { ext.kotlin_version = '...' }` があり、app モジュールが `apply from: ".../flutter.gradle"` を使っている場合、上記の手順はそのままでは当てはまりません。先に [declarative plugins への移行](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply)を行い、その後ステップ 2 に戻ってください。この記事ではその構成は再現していないので、そちらについては Flutter のドキュメントを参照してください。古い Kotlin バージョンのメッセージで行き詰まっている場合は、[KGP バージョンエラーの記事](/ja/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)で、古い構成ではそのバージョンがどこに書かれているかを解説しています。

**Gradle 9 では他の古い警告もエラーとして表面化します。** Gradle 9 は Gradle 8 で非推奨にとどまっていた API を削除したので、古いプラグインが Kotlin とは無関係な理由で失敗することがあります。`A restricted method in java.lang.System has been called` のような JDK 24 の警告が一緒に出ている場合は、[専用の記事](/ja/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)で扱っています。

## 計測結果

| プロジェクトの状態 (特記なき場合は Flutter 3.47.4) | 結果 |
| --- | --- |
| AGP 8.9.1、KGP 2.1.0、Gradle 8.12、`kotlin-android` | 失敗: Gradle が 8.14 未満 |
| AGP 9.1.0、KGP 2.4.0、Gradle 9.3.1、`kotlinOptions` を維持 | 失敗: スクリプトのコンパイルエラー |
| 同上、`compilerOptions`、`kotlin-android` を維持、`builtInKotlin=false` | ビルド成功、`app` に対する KGP の警告 |
| 同上、`builtInKotlin=true` | 失敗: AGP 9.0 以降 KGP は不要 |
| `kotlin-android` を削除、`builtInKotlin=true` | ビルド成功、インクリメンタルで 4.0 s |
| `settings.gradle.kts` から KGP の行を削除 | 失敗: Kotlin 2.2.10 が 2.2.20 未満 |
| KGP を適用するプラグイン、`builtInKotlin=true` | 失敗、プラグインのビルドファイルを名指し |
| KGP を適用するプラグイン、`builtInKotlin=false` | ビルド成功、警告にプラグインが挙がる |
| 移行済み、`newDsl=true` | 失敗: Flutter Gradle Plugin で `ClassCastException` |
| 移行済み、`builtInKotlin=true`、Flutter 3.44.8 | ビルド成功、紛らわしい "KGP was not found" メッセージ |

## 関連記事

- [修正: Flutter の Android ビルドで Gradle task assembleDebug failed with exit code 1](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [修正: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]](/ja/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)
- [修正: Flutter の Gradle ビルドで A restricted method in java.lang.System has been called](/ja/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)
- [修正: cmdline-tools 23 で flutter doctor --android-licenses が失敗する](/ja/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/ja/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)

## 出典

- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) と [app developer guide](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers)、Flutter ドキュメント。
- [Built-in Kotlin migration for plugin authors](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors)、Flutter ドキュメント。
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes): Gradle 9.1.0、JDK 17、KGP 2.2.10 のランタイム依存、新しいデフォルト。
- [What's new in Kotlin 2.2.0](https://kotlinlang.org/docs/whatsnew22.html): `kotlinOptions` の非推奨がエラーに引き上げ。
- Flutter 3.47.4 のソース: `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` (バージョンの下限)、`FlutterPluginUtils.kt` (`isBuiltInKotlinEnabled`、KGP の自動適用)、`lib/src/android/migrations/disable_built_in_kotlin_migration.dart`。
- Flutter の issue [#181383](https://github.com/flutter/flutter/issues/181383)、[#183909](https://github.com/flutter/flutter/issues/183909)、[#184837](https://github.com/flutter/flutter/issues/184837)、[#180137](https://github.com/flutter/flutter/issues/180137)。
