---
title: "解決: flutter upgrade 後の Flutter リリースビルドで Could not create Dart VM instance が出る"
description: "リリース APK に libapp.so が含まれていません。Flutter 3.44.0 から 3.44.4 はこれを落とすことがありました。3.44.5 以降に更新し、結合された subprojects ブロックを分割してください。"
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "ja"
translationOf: "2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

リリースビルドにコンパイル済みの Dart コードが入っていません。エンジンは `libapp.so` の中から AOT スナップショットを探しますが、何も見つからないため VM を起動できません。Flutter 3.44.0 から 3.44.4 へのアップグレード後であれば、原因はたいてい Gradle プラグインのリグレッションで、APK や App Bundle から `libapp.so` が何の警告もなく抜け落ちていました。APK に `unzip -l` を実行して確認し、Flutter 3.44.5 以降 (現在の stable は 3.47.3) に更新し、`android/build.gradle` の結合された `subprojects` ブロックを 2 つに分割してください。

以下の内容はすべて、GitHub 上の Flutter 3.44.x と 3.47.3 のソース、3.44 のホットフィックス changelog、そしてこれらのログ行を出力するエンジンのコードに照らして確認しています。

## logcat に出力されるエラー

```text
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_data.cc(20)] VM snapshot invalid and could not be inferred from settings.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm.cc(253)] Could not set up VM data to bootstrap the VM from.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_lifecycle.cc(85)] Could not create Dart VM instance.
```

アプリは `main()` が実行される前に終了します。3.44 では、その後に `FlutterJNI.performNativeAttach` でネイティブクラッシュが続くのが普通です。古いエンジンでは 4 行目として `[FATAL:flutter/shell/common/shell.cc] Check failed: vm. Must be able to initialize the VM.` も出ていました。この障害の macOS 版では、VM スナップショットの行の代わりに `dart_vm_data.cc(31)` で `Isolate snapshot invalid and could not be inferred from settings.` が出力されます。こちらは原因が異なるため、後半で説明します。

このページにたどり着く典型的なパターンはこうです。debug ビルドと `flutter run` は動く、`flutter create` で作った新規プロジェクトも動く、しかし実際のアプリのリリースビルドは起動時にクラッシュする。`flutter upgrade` しかしていないのに始まり、ダウングレードすると消えます。

## エンジンが VM スナップショットを見つけられない理由

リリースビルドには Dart のソースも kernel バイトコードも含まれません。`gen_snapshot` がアプリを事前にネイティブの共有ライブラリへコンパイルします。Android では `libapp.so`、iOS と macOS では `App.framework` です。このライブラリが VM スナップショットと isolate スナップショットのシンボルをエクスポートし、エンジンはそこから起動します。

最初のログ行はエンジンの `DartVMData::Create` から出ています。まず embedder から渡されたスナップショットを使います。それが無いか無効な場合は `DartSnapshot::VMSnapshotFromSettings` にフォールバックし、`settings.application_library_paths` に列挙されたライブラリの中からスナップショットのシンボルを探します。そこでも何も返らなければ、エラーを記録して空を返します。残りの 2 行は、その呼び出し元が諦めたことを示しているだけです。つまり "VM snapshot invalid" は、スナップショットが壊れているという意味であることはほとんどありません。探す対象の AOT ライブラリが存在しなかったという意味です。

すると問題は、なぜパッケージに `libapp.so` が入っていないのか、に置き換わります。可能性の高い順に並べると次のとおりです。

1. **Flutter 3.44.0 から 3.44.4 の Gradle リグレッション。** 一部のプロジェクト構成で、APK や App Bundle から `libapp.so` が抜け落ちていました。`flutter upgrade` の後に現れるのはこれです。
2. **release ビルドタイプの `debuggable true`。** この場合 Flutter の Gradle プラグインは Dart を debug モードでビルドするため、AOT ライブラリそのものが生成されません。
3. **Flutter 3.44 以降でビルドしたアプリを macOS Big Sur で実行している。** ライブラリは存在しますが、古い動的ローダーが新しい Mach-O 出力のシンボルを解決できません。

## 確認する: APK の中身を見る

推測せず、確認してください。10 秒で終わります。

```bash
# Flutter 3.44.x, Android release build
flutter build apk --release
unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -E 'lib/[^/]+/lib(app|flutter)\.so' | sort
```

正常な APK では、配布するすべての ABI について両方のライブラリが並びます。

```text
lib/arm64-v8a/libapp.so
lib/arm64-v8a/libflutter.so
lib/armeabi-v7a/libapp.so
lib/armeabi-v7a/libflutter.so
lib/x86_64/libapp.so
lib/x86_64/libflutter.so
```

このリグレッションの主な報告である [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388) の APK には、3 つの ABI すべてについて `libflutter.so` と `libdartjni.so` があり、`libapp.so` は 1 つもありませんでした。この非対称性こそが目印です。`libflutter.so` は AAR 依存関係から来るので残りました。`libapp.so` は別の経路で届けられていたため、残りませんでした。

App Bundle では、パスは `base/lib/` の下にあります。

```bash
# Flutter 3.44.x
unzip -Z1 build/app/outputs/bundle/release/app-release.aab | grep 'libapp.so'
```

flavor を使っている場合、ファイル名に flavor が入ります (`app-prod-release.apk`、`app-prodRelease.aab`)。arm64 だけでなく、すべての ABI を確認してください。flavor 版のバグでは、1 つの ABI にはあって残りには無い、ということが起こります。

## Flutter 3.44 で何が変わったか

3.44 より前、Flutter の Gradle プラグインは `libapp.so` を jar 依存関係の中に入れて届けていました。そのため AGP によるネイティブライブラリのストリップ処理から見えず、[flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275) (2026-01-26 にマージ、2026-05-15 の 3.44.0 で出荷) がこれを、プラグインが中身を用意する `jniLibs` ソースセットのディレクトリへ移しました。この変更で `libapp.so` はストリップできるようになりましたが、同時に配送が 2 つの点で壊れやすくなりました。修正である [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119) の説明によると次のとおりです。

1. `jniLibs` ディレクトリは `:app` の構成時に即座に解決される一方、コピータスクは遅延して書き込んでいました。`:app` のビルドディレクトリがリダイレクトされる前に `:app` が評価されると、両者でビルドディレクトリの場所が食い違い、用意された `libapp.so` がマージされないままになります。古い結合された `subprojects` ブロックと、Gradle プロジェクト名がアルファベット順で `app` より前に来るプラグインが組み合わさると、これが起こります。
2. コピータスクは Flutter タスク自身の出力ディレクトリの内側に書き込んでいました。出力が重なることで Gradle の up-to-date チェックが崩れました。flavor を使うプロジェクトでは、1 台のデバイス (1 つの ABI) で `flutter run` した後に完全な `flutter build appbundle` を行うと、他の ABI に `libapp.so` が入らないままになりました ([#187388](https://github.com/flutter/flutter/issues/187388))。関連する報告では、flavor を使うインクリメンタルビルドが前回のビルドの `libapp.so` をそのまま出荷していました ([#187553](https://github.com/flutter/flutter/issues/187553))。

App Bundle のほうは、より目に見える形で失敗しました。同じライブラリ欠落が、ビルド時に `Release app bundle failed to strip debug symbols from native libraries` として現れます ([#186810](https://github.com/flutter/flutter/issues/186810))。APK にはこのチェックが無いため、ビルドは問題なく通り、デバイス上でクラッシュします。

## subprojects トリガーの最小再現

これは、Flutter チームが修正と一緒に出荷した統合テスト `gradle_libapp_so_packaging_test.dart` に組み込んだ構成です。古いテンプレートのルート `android/build.gradle` で、2 つの命令が 1 つのブロックに入っています。

```groovy
// android/build.gradle, pre-2021 template shape, broken on Flutter 3.44.0 to 3.44.4
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
    project.evaluationDependsOn(':app')
}
```

名前が `app` より前に来る、ネイティブ Android コードを持つプラグイン (たとえば `android_intent_plus`) を追加し、3.44.4 で `flutter build apk --release` を実行すると、APK に `libapp.so` が入りません。`subprojects {}` はプロジェクトをアルファベット順に処理します。`evaluationDependsOn(':app')` は最初のプラグインを処理した時点で発火し、ループが `:app` に到達してその `buildDir` をリダイレクトするより前に、`:app` の構成を強制します。

## 解決策 1: Flutter 3.44.5 以降に更新する

修正は 2026-06-23 に master へ入り、[Flutter 3.44.5](https://github.com/flutter/flutter/releases/tag/3.44.5) (2026-07-06) に cherry-pick されました。3.44.5 の changelog の項目は "When building Android app bundles using flavors, or with an old app template combined with a plugin coming alphabetically before app, fixes problems with failing to include libapp.so." となっています。現在は専用の `CopyFlutterJniLibsTask` で `libapp.so` を用意し、その出力を AGP のバリアント API `variant.sources.jniLibs.addGeneratedSourceDirectory(...)` で登録しています。これでタスクの依存関係は AGP が管理し、評価順序に関係なくパスを遅延解決します。

```bash
# upgrade to current stable (3.47.3 as of 2026-09-10)
flutter upgrade
flutter --version

# clear the stale intermediates that the broken versions left behind
flutter clean
flutter pub get
flutter build apk --release
```

その後、出荷前にもう一度 `unzip` で確認してください。3.44 系にとどまる必要がある場合、3.44.5 から 3.44.9 にはすべて修正が入っています。3.44.0 から 3.44.4 では、`flutter clean` 単体で効くのは flavor のトリガーだけで、それも次に 1 台のデバイスで `flutter run` するまでです。subprojects のトリガーには何の効果もありません。

CI で FVM や `.flutter-version` ファイルを使って Flutter のバージョンを固定しているなら、その固定値も上げてください。ローカルで `flutter upgrade` しても、パイプラインがビルドに使うバージョンは変わりません。"自分のマシンでは直った" クラッシュが Play Store に届いてしまうのはこのためです。バージョン固定そのものは [再現可能な Flutter ビルドの記事](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) で述べたとおり正しい考え方です。固定値は意図して動かしてください。

## 解決策 2: 結合された subprojects ブロックを分割する

更新した後でも、これは行ってください。結合ブロックは順序のバグを引き起こすため、何年も前にテンプレートから削除されています ([flutter/flutter#91030](https://github.com/flutter/flutter/pull/91030))。また Flutter のメンテナーは [#186810](https://github.com/flutter/flutter/issues/186810) で、3.44 の相互作用は修正されたものの、結合された書き方はおそらく今でも一般的にはサポートされていないと指摘しています。Flutter 3.47.3 の `android-kotlin` テンプレートのルート `build.gradle.kts` は次のとおりです。

```kotlin
// android/build.gradle.kts, Flutter 3.47.3 app template
val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
```

まだ Groovy を使っている場合は、次が同等の書き方です。

```groovy
// android/build.gradle, Groovy equivalent of the Flutter 3.47.3 template
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}
```

ブロックを 2 つに分けることで、何かが `:app` の評価を強制する前に、すべてのプロジェクトのビルドディレクトリがリダイレクトされます。プラグインに値を強制的に設定する 3 つ目の `subprojects { afterEvaluate { ... compileSdkVersion ... } }` ブロックのような残骸がないかも確認してください。これらは昔の Stack Overflow のワークアラウンドに由来するもので、次の Gradle アップグレードで失敗の原因になりがちです。Gradle が黙ってではなく本当に失敗する場合は、[本当のエラーは終了コードの行より上に埋もれていることがほとんどです](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)。

## 解決策 3: release ビルドタイプから debuggable true を外す

この原因は 3.44 より前からあり、3.47.3 でも残っています。Flutter の Gradle プラグインは、`FlutterPluginUtils.buildModeFor` で Android のビルドタイプから Dart のビルドモードを決めています。

```kotlin
// Flutter 3.47.3, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun buildModeFor(buildType: BuildType): String {
    if (buildType.name == "profile") {
        return "profile"
    } else if (buildType.isDebuggable) {
        return "debug"
    }
    return "release"
}
```

そのため次の構成では、パイプラインの残りの部分は release エンジンを前提にしたまま、Dart コードは `libapp.so` の無い debug モードでコンパイルされます。

```kotlin
// android/app/build.gradle.kts, Flutter 3.47.3: this crashes on launch
android {
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isDebuggable = true // makes buildModeFor() return "debug"
        }
    }
}
```

結果は同じ 3 行のログです。報告は [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126) で、今もオープンのままです。`release` から `isDebuggable = true` (Groovy では `debuggable true`) を削除してください。署名済みビルドにネイティブデバッガーをアタッチしたかったのであれば、`flutter build apk --profile` を使うか、そのための別のビルドタイプを追加し、Dart が JIT モードで動くことを受け入れてください。`isDebuggable` を付けない `staging` のようなカスタムビルドタイプは release モードの Dart になり、そこではそれが望ましい動作です。

## macOS Big Sur 版: Isolate snapshot invalid

ログが `Isolate snapshot invalid and could not be inferred from settings.` で、マシンが macOS 11 Big Sur の場合、ライブラリは存在し、パッケージから欠けているものはありません。Flutter 3.44 以降、iOS と macOS の `App.framework` は `ld64` でリンクされるのではなく、`gen_snapshot` が直接書き出しています (`--snapshot_kind=app-aot-macho-dylib`)。新しい dylib には exports trie も目次 (TOC) もありません。そのため Big Sur の dyld (dyld-832) はシンボルテーブルに対する二分探索にフォールバックしますが、新しい出力はその前提を満たしていません。スナップショットのシンボルの一部は解決でき、一部はできないため、VM スナップショットは読み込めても isolate スナップショットで失敗します。Monterey の dyld はこの場合に線形探索を使うため、同じバイナリを問題なく読み込めます。

この件は [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) と [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051) で調査され、修正されないことになりました。Flutter 3.47 は [サポート対象プラットフォームのページ](https://docs.flutter.dev/reference/supported-platforms) で Big Sur (11) 以前をサポート対象外としており、Flutter チームは古い stable 系列へ cherry-pick しません。選択肢は、Big Sur で動かす必要があるビルドは Flutter 3.41.x にとどめるか、`MACOSX_DEPLOYMENT_TARGET` を 12.0 に上げてそのユーザーを切り捨てるかです。コミュニティのワークアラウンドには、ビルド後にシンボルテーブルのエントリを並べ替えて framework に再署名するものがあります。ただ、Dart のメンテナーが後に、その根拠となった分析は部分的に誤りだった (欠けているのはシンボルの順序ではなく目次) と述べているため、私ならこれは出荷しません。

ビルドが何を生成したかは `nm` で確認できます。

```bash
# Flutter 3.47.3, macOS release build
flutter build macos --release
nm -p build/macos/Build/Products/Release/*.app/Contents/Frameworks/App.framework/App | grep kDart
```

## このバグではない、似たエラー

- 起動時に `mprotect failed: 13 (Permission denied)` で落ちる iOS の debug ビルドも Dart VM の失敗ですが、iOS 26 上の JIT モードでの問題です。こちらは [別の解決策: Flutter 3.35 以降への更新](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) です。
- 正常に起動してからおかしな動きをするリリースビルドは、この段階をすでに通過しています。VM は起動しています。たとえばリリースでだけ Firebase のサインインが失われる場合、原因は別の `google-services.json`、拒否されたトークン更新、または App Check です。[リリース限定の Firebase Auth の解決策](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) を参照してください。
- flavor を使うアプリで hot restart 後に `appFlavor` が `null` になるのは `flutter attach` の機能不足で、パッケージングの問題ではありません。[hot restart 後も appFlavor を保持する方法](/ja/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) を参照してください。
- AAR としてビルドした add-to-app モジュールでも、AAR が別のモードでビルドされていたり、改変した Flutter のチェックアウトからビルドされていたりすると、同じ 3 行が出ることがあります ([#114881](https://github.com/flutter/flutter/issues/114881))。改変していない SDK から `flutter build aar` で AAR をビルドし直し、AAR の `jni/` フォルダに `libapp.so` があるか確認してください。

## 関連記事

- リグレッションを持ち込んだリリースで他に何が変わったか: [Flutter 3.44 と SwiftPM のデフォルト化](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)。
- 実際にビルドを失敗させる Gradle のエラー: [Gradle task assembleDebug failed with exit code 1](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)。
- Flutter のバージョン固定がなぜ重要か、そしてなぜ意図して動かす必要があるか: [再現可能な Flutter ビルド](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)。
- もう 1 つの Dart VM 起動時クラッシュ: [iOS での mprotect permission denied](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)。

## 参考資料

- [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388)、すべての ABI で `libapp.so` が欠けていることを示した APK の一覧を含む 3.44.1 の報告。
- [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119)、両方のトリガーについての根本原因の説明を含む修正。
- [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275)、`libapp.so` を jar から外に出した変更。
- [flutter/flutter#186810](https://github.com/flutter/flutter/issues/186810) と [#187553](https://github.com/flutter/flutter/issues/187553)、App Bundle 版と古い flavor が残る版。
- [Flutter CHANGELOG の 3.44.5 ホットフィックス](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md)、3 つの issue すべてを掲載。
- [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126)、release ビルドタイプでの `debuggable true`。
- [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) と [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051)、Big Sur での `App.framework` 読み込み失敗。
- Flutter エンジンのソース、`stable` ブランチの `engine/src/flutter/runtime/dart_vm_data.cc` と `dart_snapshot.cc`、ログ行の出どころとして。
