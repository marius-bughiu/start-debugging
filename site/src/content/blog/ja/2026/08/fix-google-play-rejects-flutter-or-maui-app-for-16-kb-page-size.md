---
title: "解決: Google Play が Flutter または .NET MAUI アプリを 16 KB メモリページサイズ未対応で却下する"
description: "64 ビットの .so に 4 KB の ELF セグメントが残っているため Play がバンドルを却下します。該当ライブラリを特定し NDK r28 以降で再ビルドし zipalign -P 16 で確認します。"
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "maui"
  - "dotnet"
  - "dotnet-10"
  - "android"
  - "gradle"
lang: "ja"
translationOf: "2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size"
translatedBy: "claude"
translationDate: 2026-08-14
---

この却下が自分のコードに起因することはまずありません。Google Play は app bundle に含まれる 64 ビットのネイティブライブラリをスキャンし、ELF の `LOAD` セグメントが 16 KB (`0x4000`) ではなく 4 KB (`0x1000`) にアライメントされているものが 1 つでもあればリリースをブロックします。Flutter のエンジンも .NET の Android ランタイムも、かなり前から 16 KB アライメント済みのバイナリを出荷しています。したがって原因はほぼ必ず、古い NDK でコンパイルされたサードパーティのプラグインかバインディングライブラリです。それを特定して更新または再ビルドし、`zipalign -c -P 16 -v 4` で確認します。

## エラーの実際の表示

バンドルを Play Console にアップロードすると、リリースをブロックする次のようなメッセージが表示されます。

```
Your app's native libraries are not aligned to 16 KB.
Recompile your app with 16 KB native library alignment.

lib/arm64-v8a/libsomething.so
lib/arm64-v8a/libsomething_jni.so
```

Google 自身のドキュメントの現在の記述は、対象範囲についても期日についても明確です。

> Android 15 (API レベル 35) 以降をターゲットとするすべてのアプリは、Google Play において 64 ビットデバイス上で 16 KB のメモリページサイズをサポートする必要があります。2027-02-01 以降、アプリの更新が 16 KB のメモリページサイズをサポートしていない場合、その更新をリリースできなくなります。

経緯を知っておく価値はあります。いまだに出回っているアドバイスの多くが古い日付を引用しているためです。この要件は当初、Android 15 以降をターゲットとする新規アプリと更新に対して 2025-11-01 に導入され、2026-05-31 までの延長を申請でき、非準拠の更新に対する完全なブロックは [Android のページサイズガイド](https://developer.android.com/guide/practices/page-sizes) によれば現在 2027-02-01 に設定されています。

## なぜ 4 KB アライメントのライブラリは 16 KB デバイスで壊れるのか

Android は歴史的に 4 KB のメモリページを前提としてきました。Android 15 以降を搭載して出荷されるデバイスは 16 KB のページを使う場合があり、これによりページテーブルへの負荷が下がり、アプリの起動が計測できるレベルで改善します。動的リンカーは共有ライブラリの各 `PT_LOAD` セグメントをページ境界に合わせたアドレスにマップします。セグメントの `p_align` が 4096 でカーネルのページサイズが 16384 の場合、ローダーはセグメント境界を満たせず、`dlopen` が失敗します。ユーザーにはインストール失敗か、`System.loadLibrary` で即座に落ちる起動として見えます。

実際にはアライメント要件は 2 つあり、この 2 つを混同することが最大の混乱の原因です。

- **ELF セグメントのアライメント**。各 `.so` 内のすべての `PT_LOAD` セグメントは `p_align` が少なくとも 16384 である必要があります。これはライブラリがどうコンパイルおよびリンクされたかという性質です。
- **zip エントリのアライメント**。ネイティブライブラリが APK 内に非圧縮で格納される場合 (`extractNativeLibs="false"`、これが最近のビルドの既定値です)、リンカーは APK から直接それらをマップします。したがって zip エントリ自体が 16 KB 境界から始まる必要があります。これはパッケージがどう組み立てられたかという性質です。

ライブラリは一方のチェックを通過して他方で落ちることがあります。Play は両方をチェックし、対象は 64 ビット ABI のみです。

## Flutter と .NET MAUI のどのバージョンがすでに準拠しているか

どちらのツールチェーンもしばらく前から問題ありません。だからこそ、問題のファイルは通常は依存パッケージ由来なのです。

**Flutter**。ディスク上の Flutter 3.44.2 stable SDK (フレームワークリビジョン `c9a6c48`、エンジン `77e2e94`) を確認すると、`packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt` が `flutter.ndkVersion` の解決先となる NDK を固定しています。

```kotlin
// Flutter 3.44.2 stable, FlutterExtension.kt
val ndkVersion: String = "28.2.13676358"
```

これは NDK r28 であり、既定で 16 KB アライメントのセグメントを出力します。同じ SDK の `DependencyVersionChecker.kt` は AGP 8.6.0 未満でビルドを強制的に失敗させ、AGP 8.11.1 未満で警告します。さらに `gradle_utils.dart` は新規プロジェクトを AGP 9.0.1 と Gradle 9.1.0 で生成します。いずれも、非圧縮ライブラリの正しいアライメントに必要な最小値として Google が挙げる AGP 8.5.1 を余裕で上回っています。Flutter 3.44 のアプリは、プラグインが古い `.so` を持ち込まない限り構造的に準拠しています。

**.NET MAUI**。.NET の Android SDK はパッケージのアライメントを明示的に設定します。.NET 10 ワークロードに同梱される `Microsoft.Android.Sdk.Windows` 36.1.53 の `Microsoft.Android.Sdk.DefaultProperties.targets` より抜粋します。

```xml
<!-- Microsoft.Android.Sdk 36.1.53 (.NET 10) -->
<AndroidZipAlignment Condition=" '$(AndroidZipAlignment)' == '' ">16</AndroidZipAlignment>
```

周囲のコメントには、サポートされる値は `4` と `16` のみと記されています。つまり要件のうち zip 側の半分は既定で処理済みであり、このプロパティを自分で設定する必要はまずありません。引き継いだプロジェクトが `<AndroidZipAlignment>4</AndroidZipAlignment>` を固定している場合は、その行を削除してください。

ELF 側の半分については、このマシン上の .NET 10 Android ランタイムパック (`Microsoft.Android.Runtime.*.36.1.53` および `Microsoft.NETCore.App.Runtime.Mono.android-arm64`) のネイティブライブラリに対してアライメントチェックを実行しました。64 ビットのランタイムライブラリはすべて `p_align` が `0x4000` と報告されます。`libmonosgen-2.0.so`、`libmono-android.release.so`、`libnet-android.release.so`、`libSystem.Native.so`、`libSystem.Security.Cryptography.Native.Android.so`、`libxamarin-native-tracing.so`、および Mono のコンポーネントライブラリが該当します。Mono と CoreCLR の両方のフレーバーがクリーンです。

## APK や AAB の 16 KB アライメントはどう確認するか

Google の `check_elf_alignment.sh` は bash スクリプトなので、Windows でビルドしている場合は扱いにくいです。zip レベルのチェックは Android のビルドツールに同梱されており、どの環境でも動きます。

```powershell
# Windows, Android build-tools 35.0.0 or newer
& "$env:LOCALAPPDATA\Android\sdk\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 app-release.apk
```

app bundle の場合は `bundletool` が設定されたアライメントを報告します。

```bash
bundletool dump config --bundle=app-release.aab
```

ただし、どちらも ELF ヘッダーは調べません。セグメント自体を確認するには、NDK に同梱の `llvm-objdump` を使います。

```bash
# ANDROID_NDK points at an r28 or newer installation
$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump -p libfoo.so | grep LOAD
```

準拠したライブラリは `align 2**14` と出力します。`2**12` や `2**13` は不合格です。

NDK のインストールに依存したくない場合、プログラムヘッダーは直接パースするのが簡単です。次のスクリプトは上記の .NET ランタイムパックの調査に使ったもので、Python が動く環境ならどこでも動きます。

```python
# check_align.py - Python 3.9+, no dependencies
import glob, os, struct, sys

PT_LOAD = 1

def load_aligns(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF":
        return None
    is64 = data[4] == 2
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
        e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
    aligns = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_LOAD:
            continue
        fmt, delta = ("<Q", 0x30) if is64 else ("<I", 0x1C)
        aligns.append(struct.unpack_from(fmt, data, off + delta)[0])
    return is64, aligns

for pattern in sys.argv[1:]:
    for path in sorted(glob.glob(pattern, recursive=True)):
        result = load_aligns(path)
        if result is None:
            continue
        is64, aligns = result
        if not is64:
            continue  # Play only checks 64-bit ABIs
        worst = min(aligns) if aligns else 0
        status = "ALIGNED  " if worst >= 16384 else "UNALIGNED"
        print(f"{status} p_align={hex(worst)} {os.path.basename(path)}")
```

AAB または APK を展開し、64 ビット ABI のディレクトリを指定します。

```bash
unzip -q app-release.aab -d extracted
python check_align.py "extracted/**/lib/arm64-v8a/*.so"
```

`UNALIGNED` と出力されたライブラリが、まさに Play が列挙するものです。

## アライメントされていない Flutter アプリはどう直すか

まず、そのファイルがどのプラグインのものかを特定します。pub のキャッシュとビルド済み APK を検索し、`.so` をパッケージに対応付けます。

```bash
flutter build apk --release
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep "lib/arm64-v8a"
```

原因が分かったら、次の順で対処します。

1. **プラグインを更新する**。圧倒的に多い解決策です。メンテナンスされているパッケージのほとんどは 2025 年中にバイナリを再ビルドしています。`flutter pub outdated` を実行し、該当する依存を上げ、再ビルドして再確認します。
2. **Flutter SDK と Android ツールチェーンを更新する**。Flutter 3.32 以降であること、`settings.gradle.kts` の AGP が 8.5.1 以降であること、そして古い NDK 文字列をハードコードするのではなく `android { ndkVersion = flutter.ndkVersion }` を使っていることを確認します。`android/app/build.gradle.kts` に古い `ndkVersion = "25.1.8937393"` が明示的に残っていると、他の対策がすべて黙って無効化されます。
3. **ネイティブコードを自分で再ビルドする**。プラグインがソースからビルドされ、NDK r27 以前で止まっている場合です。そのプラグインの `CMakeLists.txt` にリンカーオプションを追加します。

   ```cmake
   target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
       "-Wl,-z,max-page-size=16384"
       "-Wl,-z,common-page-size=16384")
   ```

4. **依存を外す**。放棄されている場合です。4 KB のビルド済み `.so` を持ちソースコードのない未メンテナンスのパッケージは完全なブロッカーであり、こちら側のビルドフラグでは直せません。フォークするか置き換えます。

## アライメントされていない .NET MAUI アプリはどう直すか

.NET 10 のランタイムはすでに準拠しているので、NuGet パッケージ、とくにビルド済みの `.aar` や `.so` を埋め込んでいる Android バインディングライブラリを確認します。広告 SDK、解析 SDK、決済 SDK、機械学習ランタイムが定番の容疑者です。

```bash
# .NET 10, MAUI
dotnet publish -f net10.0-android -c Release
```

次に `bin/Release/net10.0-android/publish/` にできた `.aab` を展開し、`base/lib/arm64-v8a/` に対してチェッカーを実行します。バインディングライブラリが原因の場合、解決策は、上流の `.aar` が NDK r28 で再ビルドされたバージョンまで NuGet パッケージを更新することです。そのようなバージョンが存在しない場合は、再ビルドしたネイティブライブラリで `.aar` を自分で再パッケージするか、依存を外すことになります。

ついでにプロジェクトレベルで確認しておきたい点が 2 つあります。非圧縮のネイティブライブラリを無効化していないことを確認してください。zip アライメントの仕組み全体がそれに依存しています。また、ローカルでは問題が隠れて Play では隠れないような形で古い SDK をターゲットにし続けていないかも確認してください。どちらもよくある設定ミスではありませんが、該当する場合は結果が非常に分かりにくくなります。

## チェッカーが指摘する libc.so と 32 ビットライブラリはどう扱うか

誤った検出が 2 つあり、間違ったディレクトリを調べると深みにはまります。どちらも .NET 10 ランタイムパックをスキャンした際にすぐ現れました。

**スタブライブラリは出荷されません**。Android ランタイムパックには `p_align = 0x1000` の `libc.so`、`libdl.so`、`liblog.so`、`libm.so`、`libz.so` が含まれます。これらはリンク時の DSO スタブであり、実際の実装はデバイス側から提供されます。APK には入らないので、そのアライメントは無関係です。`obj/` フォルダーや NuGet のキャッシュではなく、ビルド済みパッケージを調べなければならない理由がこれです。

**32 ビットライブラリは対象外です**。`android-arm` (armeabi-v7a) ランタイムパックのライブラリはすべて `0x1000` と報告されますが、これは正しく、今後も変わりません。32 ビットプロセスにはサポートすべき 16 KB ページモードが存在しないためです。Play は 64 ビット ABI のみをチェックし、.NET の Android SDK 自身のビルド時チェックも同様で、その診断文字列は `Not a 64-bit ELF image.  Ignored.` となっています。上記のスクリプトと同じく、スキャン対象を `arm64-v8a` と `x86_64` に絞ってください。

スキャン結果を信じるのではなく修正を端から端まで実証したい場合は、SDK Manager の "Google APIs Experimental 16 KB Page Size" システムイメージから AVD を作成し、インストール前にエミュレーターが実際に 16 KB ページで動作していることを確認します。

```bash
adb shell getconf PAGE_SIZE
```

これは `16384` と出力される必要があります。そこでインストールして起動するアプリは Play のチェックを通過します。

## 関連記事

ビルドがそもそもバンドルを生成するところまで進まない場合、根本の失敗はたいてい Gradle チェーンの別の箇所にあります。[Gradle タスク assembleDebug が終了コード 1 で失敗する](/ja/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) と [MAUI Android で Gradle build failed to produce an .apk file](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) では、ラップされたログから本当のエラーを読み取る方法を扱っています。NDK や SDK コンポーネントの不足は [flutter doctor が cmdline-tools コンポーネントの不足を報告する](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) として現れ、依存レベルのネイティブな衝突は多くの場合まず [Flutter の Android ビルド中の AndroidX 競合](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/) として表面化します。古いスタックのままのチームは、[Xamarin.Forms から MAUI 11 への移行](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/) の際にこれらすべてに一度に直面します。

## 参考資料

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) (Android Developers)。要件そのもの、2027-02-01 という日付、`zipalign` と `llvm-objdump` によるチェック、NDK r27 以前向けのリンカーフラグについて。
- [Prepare your apps for Google Play's 16 KB page size compatibility requirement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) (Android Developers Blog)。2025-11-01 の当初のアナウンスについて。
- [Preparing your .NET MAUI apps for Google Play's 16 KB page size requirement](https://devblogs.microsoft.com/dotnet/maui-google-play-16-kb-page-size-support/) (.NET Blog)。.NET 側のガイダンスと、報告されている起動時間および消費電力の改善について。
- バージョンとアライメントに関する事実は、Flutter 3.44.2 stable と .NET 10 の Android ワークロード (`Microsoft.Android.Sdk.Windows` および `Microsoft.Android.Runtime.*` 36.1.53) に対してローカルで計測した値です。
