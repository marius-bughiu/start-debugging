---
title: "修正: Flutter Android アプリの起動時に MainActivity で ClassNotFoundException が発生する"
description: "マニフェストの .MainActivity は Gradle の namespace を基準に解決されますが、その名前のクラスが APK に存在しません。namespace、Kotlin の package 行、マニフェストの三つを一致させます。"
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "ja"
translationOf: "2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches"
translatedBy: "claude"
translationDate: 2026-10-06
---

マージ後の `AndroidManifest.xml` に記載されたアクティビティクラスが、APK の dex ファイル内に存在しません。Flutter アプリの場合、これはほぼ必ず、名前変更の途中で三つの値のいずれかがずれたことを意味します。`android/app/build.gradle.kts` の `namespace` (マニフェストの `.MainActivity` はこれを基準に解決されます)、`MainActivity.kt` 先頭の `package` 行、またはファイルが置かれている flavor のソースセットです。`package` 行を `namespace` と同じ値にし、ストア上の新しいアイデンティティが本当に必要な場合を除いて `applicationId` には手を付けず、`flutter clean` を実行してからリビルドします。`.kt` ファイルが置かれているフォルダーは関係ありません。

以下の内容はすべて macOS 上の Flutter 3.44.8 (Dart 3.12.2) で再現しました。この `flutter create` テンプレートは AGP 9.0.1、Kotlin 2.3.20、Gradle 9.1.0 を固定しており、実行環境は Android 16 (API 36) の arm64 エミュレーターです。各シナリオは `flutter build apk` でビルドし、build-tools 36.1.0 の `aapt2` と `dexdump` で中身を調べ、`adb shell am start` で起動しました。

## エラーの実際の内容

`namespace` だけを変更したときの再現環境でのクラッシュです (パスは短縮しています)。

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.RuntimeException: Unable to instantiate activity ComponentInfo{com.example.clsrepro/com.acme.shop.MainActivity}: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[[zip file "/data/app/~~.../com.example.clsrepro-.../base.apk"],nativeLibraryDirectories=[/data/app/~~.../lib/arm64, /system/lib64, /system_ext/lib64]]
E AndroidRuntime: Caused by: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[...]
```

`ComponentInfo{A/B}` の部分を注意深く読んでください。どの値が間違っているかがここからわかります。`A` はアプリがインストールされたアプリケーション ID です。`B` はシステムがインスタンス化しようとした完全修飾クラス名です。`B` が Kotlin コード内に存在するクラスでなければ、マニフェストとコードが食い違っています。ビルドは成功し、APK もインストールされますが、アプリは Flutter エンジンが起動する前に終了するため、Dart のコードやログ出力は一切実行されません。スタックトレースは `adb logcat -b crash` で確認できます。

## クラスが見つからない理由

Android はアプリを起動する際、マージ後のマニフェストからランチャーアクティビティの `android:name` を読み取り、その正確なクラス名を APK の `classes*.dex` から読み込みます。Flutter のテンプレートはこれを省略形で書いています。

```xml
<!-- android/app/src/main/AndroidManifest.xml, Flutter 3.44.8 template -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    ... >
```

ピリオドで始まる名前は、`build.gradle.kts` にあるモジュールの `namespace` の後ろに連結されます。`applicationId` でも、Kotlin ファイルが宣言している package でもありません。一方、dex に入るクラスの名前は `MainActivity.kt` の `package` 行で決まります。ビルドのどこにもこの二つが一致しているかを確認する仕組みはないため、クラッシュに至る経路は三つあります。

1. **`namespace` を変更したが、Kotlin の `package` 行は変更していない。** マニフェストは `<new namespace>.MainActivity` を指すようになり、dex には `<old package>.MainActivity` が残ったままです。
2. **Kotlin の `package` 行を変更したが、`namespace` は変更していない。** 1 の鏡像です。
3. **このバリアントにクラスがまったくコンパイルされていない。** 典型的には `MainActivity.kt` が flavor のソースセット (`src/free/kotlin`) に移動されていて別の flavor をビルドした場合、あるいは誰かが `android/` フォルダーを再生成したときにファイルが削除された場合です。

R8 が原因ではありません。リソース処理のステップ (AAPT2) がマニフェストで参照されるすべてのクラスに keep ルールを生成するため、リリースビルドで `MainActivity` が縮小で削除されることはありません。詳しくは後述します。

## 最小限の再現手順

クリーンなテンプレートから始めて、1 行だけ変更します。

```bash
# Flutter 3.44.8, AGP 9.0.1
flutter create --org com.example --platforms android clsrepro
cd clsrepro
```

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8 template, AGP 9.0.1
android {
    namespace = "com.acme.shop"          // was "com.example.clsrepro"
    // ...
    defaultConfig {
        applicationId = "com.example.clsrepro"
        // ...
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/example/clsrepro/MainActivity.kt, unchanged
package com.example.clsrepro

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

`flutter build apk --debug` は成功します。試したすべてのバリアントについて、APK の中に実際に何が入っていたか、そして起動時に何が起きたかを以下に示します。

| シナリオ | マニフェストの `android:name` (マージ後) | dex 内のクラス | 結果 |
|---|---|---|---|
| テンプレートのまま | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | 起動する |
| `namespace` のみ変更 | `com.acme.shop.MainActivity` | `com.example.clsrepro.MainActivity` | **ClassNotFoundException** |
| `applicationId` のみ変更 | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | 起動する (`com.acme.shop` としてインストール) |
| Kotlin の `package` 行のみ変更 | `com.example.clsrepro.MainActivity` | `com.acme.shop.MainActivity` | **ClassNotFoundException** |
| `namespace` と `package` 行を変更、ファイルは古いフォルダーのまま | `com.acme.shop.MainActivity` | `com.acme.shop.MainActivity` | 起動する |
| `MainActivity.kt` を `src/free/kotlin` に配置、`free` flavor | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | 起動する |
| 同上、`paid` flavor | `com.example.clsrepro.MainActivity` | (なし) | **ClassNotFoundException** |
| テンプレートのまま、`--release` (R8 有効) | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | 起動する |

注目すべき行が二つあります。`applicationId` だけの変更は無害です。クラス名はもともとこの値に依存していないからです。また、新しい package に合わせてファイルを移動する必要もありません。Kotlin はディレクトリが `package` 宣言と一致することを強制しないため、ファイルが `com/example/clsrepro/` の下に残ったままの行でも問題なく起動します。"Flutter のパッケージ名を変更する" 系のガイドの多くはまずフォルダーを移動するよう指示しますが、それこそが最も重要度の低い手順です。

## 修正手順

### 1. 三つの値はソースではなくビルド済み APK から読み取る

ソースファイルは嘘をつくことがあります (未保存のエディター、flavor による上書き、マニフェストのプレースホルダー)。APK は嘘をつきません。Android SDK の build-tools を `PATH` に通した状態で実行します。

```bash
# Android SDK build-tools 36.1.0, after flutter build apk --debug
APK=build/app/outputs/flutter-apk/app-debug.apk

# 1. The application ID it installs as
aapt2 dump packagename $APK

# 2. The activity class the manifest asks for
aapt2 dump xmltree --file AndroidManifest.xml $APK | grep -A2 "E: activity" | grep android:name

# 3. The MainActivity classes that actually exist
unzip -o -q $APK 'classes*.dex' -d /tmp/dex
for d in /tmp/dex/classes*.dex; do dexdump $d | grep "Class descriptor" | grep MainActivity; done
```

`namespace` を壊した再現環境では、ステップ 2 で `com.acme.shop.MainActivity`、ステップ 3 で `Lcom/example/clsrepro/MainActivity;` が出力されました。ステップ 3 で何も出力されない場合は "このバリアントにコンパイルされていない" ケースなので、手順 4 に進んでください。

### 2. Kotlin の `package` 行を `namespace` に一致させる

コードをどの名前の下に置きたいかを決め、両方をその値に設定します。

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1
android {
    namespace = "com.acme.shop"
    defaultConfig {
        applicationId = "com.acme.shop"   // only if you want a new store identity, see below
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/acme/shop/MainActivity.kt, Flutter 3.44.8
package com.acme.shop

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

整理のためにファイルを `kotlin/com/acme/shop/` に移動してもかまいません。Kotlin では任意です。アクティビティが Java ファイル (`MainActivity.java`、古い Flutter プロジェクトでよく見られます) の場合は移動もしてください。Java の慣例と IDE のリファクタリング機能は、ディレクトリが package と一致することを前提としています。

`namespace` に触れたくない場合は、代わりにマニフェストに完全修飾名 (`android:name="com.example.clsrepro.MainActivity"`) を書くこともできます。これでも動作しますが、不一致を解消するのではなく隠すだけであり、次に `namespace` を変更したときには追従してくれません。

### 3. 古い名前の残りを grep で探す

1 ファイルでも変更漏れがあれば、まさにこのクラッシュが起きます。`android/` ツリー全体を検索してください。他のソースセットのマニフェスト (`src/debug/AndroidManifest.xml`、`src/profile/AndroidManifest.xml`) や、古い package を宣言している他の Kotlin / Java ファイルも対象です。

```bash
# from the Flutter project root
grep -rn "com.example.clsrepro" android/ --include='*.kt' --include='*.java' --include='*.xml' --include='*.kts' --include='*.gradle'
```

先頭がピリオドで宣言されたカスタムの `Application` サブクラス、`BroadcastReceiver`、`Service` も同じように `namespace` を基準に解決されるため、同じ例外でクラッシュします (メッセージに出るクラス名が異なるだけで、`Application` の場合は "Unable to instantiate application" と表示されます)。

### 4. クラスがまったく存在しない場合はソースセットを修正する

`dexdump` に `MainActivity` がまったく表示されない場合は、ファイルの場所を調べます。

```bash
find android/app/src -name 'MainActivity.*'
```

`src/main/` 以下にあるものはすべてのバリアントにコンパイルされます。`src/<flavor>/` や `src/<buildType>/` 以下にあるものは、そのバリアントにのみコンパイルされます。私の再現環境では、`MainActivity.kt` を `src/free/kotlin` に置いて `flutter run --flavor paid` を実行すると、`com.example.clsrepro.paid` というアプリケーション ID の下で `Didn't find class "com.example.clsrepro.MainActivity"` が発生しました。ファイルを `src/main/kotlin` に戻すか、すべての flavor に同じ package のコピーを用意してください。ファイルが単に消えている場合 (`android/` フォルダーを再生成した場合) は、上のテンプレートから作り直します。

### 5. クリーンして再インストールする

```bash
# Flutter 3.44.8
flutter clean
flutter pub get
flutter run
```

古い中間ファイルが残っていると、名前変更後も古い dex が使われ続けることがあります。また、以前のアプリケーション ID でインストールされた古いアプリが、タップしているランチャーアイコンを持ち続けている可能性もあります。`applicationId` を変更した場合は、以前のビルドをテストし続けないよう、古いパッケージをアンインストールしてください (`adb uninstall com.example.clsrepro`)。

## applicationId と namespace の変更の違い

この二つの値は異なる問いに答えるものであり、多くのクラッシュは両者を同じものとして扱うことから生じます。

- `applicationId` はデバイス上および Google Play 上のアイデンティティです。公開後に変更すると、Play からは別のアプリとして扱われます。クラス名には一切影響しません。
- `namespace` は生成される `R` クラスと `BuildConfig` クラスの package であり、マニフェスト内のすべての省略形クラス名の基準です。コードだけに関わる値です。

Android のドキュメントでは、`applicationId` を常に明示的に設定することが推奨されています。これがない場合は `namespace` にフォールバックするため、コードレベルの名前変更が知らないうちにストア上のアイデンティティまで変えてしまうからです。Flutter のテンプレートはすでに両方を設定しています。新しいストア掲載用に新しいバンドル ID が欲しいだけであれば、`applicationId` だけを変更し、他には触れないでください。上の表の中で、このクラッシュを引き起こさない名前変更はそれだけです。

出荷後にアクティビティクラス自体の名前を変更することにもコストがあります。`<activity>` のドキュメントには、アプリの公開後はエクスポートされたアクティビティの `android:name` を変更しないよう書かれています。Flutter の `MainActivity` はエクスポートされており、ユーザーのホーム画面にあるランチャーショートカットや固定アイコンはクラス名でコンポーネントを参照しています。どうしても移動する必要がある場合は、古い名前で新しいクラスを指す `<activity-alias>` を用意すれば、既存のショートカットは引き続き動作します。

## リリースビルドと R8

リリースビルドで R8 が `MainActivity` を削除したのではないか、とよく推測されます。マニフェストでクラス名が指定されている限り、そうはなりません。リソース処理の際に AAPT2 が、マニフェストで見つけたすべてのコンポーネントに対して keep ルールを書き出すからです。私のリリースビルドでは、`build/app/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt` に以下が含まれていました。

```text
-keep class com.example.clsrepro.MainActivity { <init>(); }
```

また `mapping.txt` では、このクラスは名前変更されず自分自身にマッピングされていました。リリース APK は問題なく起動しました。したがって、デバッグでは動くのにリリースビルドでこのエラーが出る場合は、ProGuard ルールを書き始める前に、バリアント間の違い (`src/release/` にあるリリース専用のマニフェストや flavor のソースセット) を探してください。R8 が実際に削除するクラスは、リフレクション経由でしか到達せずマニフェストにも記載されていないものであり、その場合は通常、`MainActivity` ではなくそのクラスについての `ClassNotFoundException` として後から表面化します。

## よく似た別のエラー

- **`io.flutter.app.FlutterActivity` や `FlutterApplication` に関するビルドエラー**: アプリがまだ v1 の Android embedding を使っています。これは移行の問題であり、[Flutter 2 から 3.x への移行チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) で扱っています。
- **APK ができる前にビルドが失敗する** (Kotlin デーモンや Gradle のエラー): 起動まで到達していません。[Daemon compilation failed: null](/ja/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/) と [Timeout waiting to lock journal cache](/ja/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/) を参照してください。
- **メソッドチャネルでの `MissingPluginException`**: アクティビティは正常に起動していますが、ハンドラーが間違った場所で登録されています。チャネル登録のパターンは [プラグインなしでプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) にあります。

## 関連記事

- [Flutter Android プロジェクトを組み込み Kotlin を使う AGP 9 に移行する](/ja/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)。移行後に `MainActivity` が dex に含まれたことを確認する方法も含みます。
- [修正: Flutter Android の Gradle ビルドで e: Daemon compilation failed: null が発生する](/ja/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Flutter でプラグインなしにプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [修正: Flutter Android ビルドで Timeout waiting to lock journal cache が発生する](/ja/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## 参考資料

- [Configure the app module: namespace and application ID](https://developer.android.com/build/configure-app-module)、Android Developers。
- [`<activity>` element, `android:name`](https://developer.android.com/guide/topics/manifest/activity-element#nm)、Android Developers。
- [Set the application ID](https://developer.android.com/build/configure-app-module#set-application-id)、Android Developers。
- [Shrink, obfuscate, and optimize your app](https://developer.android.com/build/shrink-code)、Android Developers。
- [Build and release an Android app](https://docs.flutter.dev/deployment/android)、Flutter docs。
