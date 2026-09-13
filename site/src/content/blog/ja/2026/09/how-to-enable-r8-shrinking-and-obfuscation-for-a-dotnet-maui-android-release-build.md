---
title: ".NET MAUI Android のリリースビルドで R8 の縮小と難読化を有効にする方法"
description: "AndroidLinkTool を r8 に設定し、トリミングを有効のままにして、ProguardConfiguration ファイルを追加します。.NET 10 と .NET 11 RC 1 がいまだに難読化されていない Java を出力する理由、新しい AndroidR8ObfuscationMode プロパティがそれをどう変えるか、そして R8 が実際に実行されたことを確認する方法を解説します。"
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "r8"
  - "dotnet-11"
  - "dotnet-10"
  - "google-play"
lang: "ja"
translationOf: "2026/09/how-to-enable-r8-shrinking-and-obfuscation-for-a-dotnet-maui-android-release-build"
translatedBy: "claude"
translationDate: 2026-09-13
---

**結論:** MAUI の `.csproj` にある Release 専用の `PropertyGroup` に `<AndroidLinkTool>r8</AndroidLinkTool>` を追加し、トリミングは有効のままにして (Release ではデフォルトで有効です)、keep ルールがあれば `ProguardConfiguration` ビルドアクションを付けた `proguard.cfg` ファイルに記述します。これでアプリの Java 側に対する R8 の縮小と最適化が有効になります。ただし、現在出荷されている SDK では何も難読化**されません**。.NET for Android 36.1.69 (.NET 10) と 37.0.0-rc.1.2257 (.NET 11 RC 1) は、どちらも R8 の構成に `-dontobfuscate` を注入します。本当の難読化は新しい `AndroidR8ObfuscationMode` プロパティとともに登場します。このプロパティは .NET 11 では RC 1 より後のリリースで `private-members` がデフォルトになり、次回の .NET 10 サービスリリースにはオプトインのバックポートとして入ります。

この最後の点は、以前よりも重要になっています。Google は 2026-08-26 に、2027 年 2 月から Google Play のアプリバンドルには DEX コードの最適化、縮小、難読化のカバレッジが少なくとも 25% 必要になると発表しました (Android vitals がアラートを出すのは、バンドルに含まれる DEX がアプリで 10 MB、ゲームで 50 MB に達した場合のみです)。MAUI アプリは AndroidX と Google Play services の Java を大量に取り込むため、DEX 側は決して小さくありません。

以下の内容はすべて、上記のリリースタグ時点の `dotnet/android` ソースを追跡して確認したものです。そのため、各主張を MSBuild のターゲットと照らし合わせてご自身で検証できます。

## MAUI アプリで R8 が扱うもの、扱わないもの

MAUI の Android パッケージには 2 種類のコードが含まれており、それぞれ別のツールで縮小されます。

- **マネージドコード** (C#、MAUI、BCL) は、`PublishTrimmed` が `true` のときに ILLink によってトリミングされます。R8 はこれを一切扱いません。C# の難読化は別の問題であり、R8 では解決できません。
- **Java バイトコード** (AndroidX、Material、Google Play services、Firebase、バインドしたあらゆる `.aar`、さらに Java 型を継承するすべてのマネージド型に対してビルドが生成する Java Callable Wrapper) は `classes.dex` に変換されます。デフォルトでは D8 コンパイラーが縮小なしでこれを行います。`AndroidLinkTool=r8` を指定すると、R8 が 1 回のパスで dex 化と縮小を行います。

Google Play のパーセンテージは DEX に対して計測されるので、まさに R8 が担当する側が対象です。つまり "MAUI で R8 を有効にする" と言うとき、それはこの Java 側を小さくし、最終的には名前を変更することを意味します。

縮小だけでも十分に価値があります。[dotnet/android #12535](https://github.com/dotnet/android/issues/12535) では、ある開発者が 36.1.69 上の .NET 10 アプリを計測し、非圧縮の DEX が D8 では 20.18 MB、R8 と SDK のデフォルトルールでは 11.43 MB になりました。手書きの keep ルールなしで、Java コードの半分近くが削減されたことになります。

## 最小限のプロジェクト変更

.NET 10 と .NET 11 をターゲットとする MAUI アプリの構成は、これですべてです。

```xml
<!-- MyApp.csproj, .NET 10 (Microsoft.Android.Sdk 36.1.x) and .NET 11 RC 1 (37.0.0-rc.1) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net11.0-android;net11.0-ios</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <UseMaui>true</UseMaui>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
    <AndroidLinkTool>r8</AndroidLinkTool>
    <!-- Default in Release already. Written out because R8 without trimming strips Java types your C# still uses. -->
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>

  <ItemGroup Condition="$(TargetFramework.Contains('-android'))">
    <ProguardConfiguration Include="Platforms/Android/proguard.cfg" />
  </ItemGroup>
</Project>
```

あとはいつもどおり発行します。

```bash
dotnet publish -f net11.0-android -c Release
```

`proguard.cfg` は空の状態から始めてかまいません。ルールを追加する必要があるのは、リフレクション経由で到達されるものを R8 が削除した場合だけです。これについては後述します。

## AndroidLinkTool を設定したときに SDK が行うこと

`Xamarin.Android.Common.targets` が残りの設定を `AndroidLinkTool` から導出するため、必要なスイッチはこれだけです。.NET 10 と .NET 11 のターゲットから要点を抜き出すと、次のようになります。

```xml
<!-- Xamarin.Android.Common.targets (dotnet/android 36.1.69 and 37.0.0-rc.1.2257), condensed -->
<AndroidDexTool   Condition=" '$(AndroidLinkTool)' == 'r8' ">d8</AndroidDexTool>
<AndroidLinkTool  Condition=" '$(AndroidLinkTool)' == 'proguard' And '$(AndroidEnableDesugar)' == 'True' ">r8</AndroidLinkTool>
<AndroidEnableProguard Condition=" '$(AndroidLinkTool)' != '' ">True</AndroidEnableProguard>
<AndroidCreateProguardMappingFile Condition="'$(AndroidCreateProguardMappingFile)' == '' And '$(AndroidLinkTool)' == 'r8'">True</AndroidCreateProguardMappingFile>
<AndroidProguardMappingFile Condition=" '$(AndroidLinkTool)' == 'r8' And '$(AndroidCreateProguardMappingFile)' == 'True' ">$(OutputPath)mapping.txt</AndroidProguardMappingFile>
```

ここからいくつかの帰結が導かれます。

- D8 ではデシュガーがデフォルトで有効なため、`AndroidLinkTool=proguard` は黙って `r8` に格上げされます。スタンドアロンの ProGuard ツールは、最近の .NET for Android では使われていません。
- Xamarin 時代の古い `AndroidEnableProguard=true` / `EnableProguard=true` も引き続き動作しますが、警告 XA1028 (または XA1027) が出て、リンクツールのデフォルトが `proguard` になり、それがさらに `r8` になります。`AndroidLinkTool` を直接設定して警告を回避してください。
- デフォルトで `$(OutputPath)` に `mapping.txt` が生成され (例: `bin/Release/net11.0-android/mapping.txt`)、`dotnet publish` がそれを発行フォルダーにコピーします。`.aab` をビルドする場合、マッピングファイルはバンドルのメタデータにも `com.android.tools.build.obfuscation/proguard.map` として埋め込まれるため、Play Console が手動アップロードなしで取り込みます。サイドロードする `.apk` の場合は、ご自身でアップロードする必要があります。

## R8 にトリミングの有効化が必要な理由

R8 は、C# がまだ使っている Java 型を自力で判断できません。そのリストは .NET のトリマーから得られます。ILLink の実行後、カスタムステップが `proguard_project_references.cfg` を書き出し、残ったマネージド型がバインドしているすべての Java 型に対する keep ルールを記録します。これを生成するターゲットは、トリミングを条件としています。

```xml
<!-- Microsoft.Android.Sdk.TypeMap.LlvmIr.targets, 37.0.0-rc.1.2257 -->
<Target Name="_GenerateProguardConfiguration"
    AfterTargets="_PrepareLinkedAssembliesForProguard"
    Condition=" '$(PublishTrimmed)' == 'true' and '$(_ProguardProjectConfiguration)' != '' "
```

ところが、R8 を実行するかどうかの判定はトリミングを確認しません。`Xamarin.Android.D8.targets` はパスのプロパティが設定されていることしか要求せず、`_ResolveAssemblies` は `AndroidLinkTool` が空でないすべてのビルドでそれを設定します。

```xml
<!-- Xamarin.Android.D8.targets, same in 36.1.69 and 37.0.0-rc.1.2257 -->
<_UseR8 Condition=" ('$(AndroidLinkTool)' == 'r8' And '$(_ProguardProjectConfiguration)' != '') Or '$(AndroidEnableMultiDex)' == 'True' ">True</_UseR8>
```

そのため `PublishTrimmed=false` (あるいは、リフレクションの問題に対するよくある回避策である Release での `AndroidLinkMode=None`) の場合でも R8 は実行されますが、バインディングを保護するファイルがない状態で実行されます。ビルドは XA4304 ("ProGuard configuration file '...proguard_project_references.cfg' was not found") をログに出すだけで、アプリは R8 が削除した Java 型に初めて触れた時点で `java.lang.ClassNotFoundException` によって落ちます。まさにこの流れが [dotnet/android #6612](https://github.com/dotnet/android/issues/6612) であり、メンテナーは R8 が .NET リンカーの有効化に依存していることを認めています。

プロジェクトファイルの Release 条件が見た目だけのものではない理由もここにあります。Debug ビルドはトリミングを行わないため、無条件の `AndroidLinkTool=r8` は Debug でも参照ファイルなしで R8 を実行させてしまいます。さらに高速デプロイが有効だと XA0119: "Using fast deployment and a code shrinker at the same time is not recommended" も発生します。

## R8 が実際に受け取る構成ファイル

R8 の実行時、SDK は `--pg-conf` の入力を次の順序で組み立てます (`Xamarin.Android.Common.targets` の `_ProguardConfiguration` アイテム)。

1. `$(ProguardConfigFiles)` (このプロパティを設定している場合)。
2. Android SDK の `proguard-android.txt` (最適化なしのベースライン)。`AndroidR8ObfuscationMode=private-members` を備えた新しい SDK では、これが `proguard-android-optimize.txt` になります。
3. `obj/.../proguard/proguard_xamarin.cfg`: `mono.android.**`、`net.dot.jni.**` などのランタイム用 keep ルールです。現在出荷されている SDK では、このファイルは `-dontobfuscate` で始まります。
4. `proguard_project_references.cfg`: 残ったマネージド型がバインドしているすべての Java 型に対する keep ルールで、ILLink の後に生成されます。
5. `proguard_project_primary.cfg`: ACW マップに含まれる Java Callable Wrapper ごとに 1 つの `-keep class X { *; }` ルールがあり、C# で定義したすべての `Activity`、`Service`、カスタム `View` が残るようにします。
6. ご自身の `@(ProguardConfiguration)` アイテム。
7. 参照している `.aar` ファイルから抽出されたコンシューマールール (`proguard.txt`)。

MAUI アプリが自前の型のために手書きの keep ルールをほとんど必要としないのは、4 と 5 があるからです。ビルドは、マネージド側から到達できる Java クラスをすでに把握しています。把握できないのは、Java コードがリフレクション経由で到達するものです。

## 現時点で縮小はされても難読化されない理由

ProGuard のオプションはグローバルです。いずれかの構成ファイルに `-dontobfuscate` があれば、R8 の実行全体で難読化が無効になり、ご自身の `proguard.cfg` に追加してそれを再び有効にできる逆のフラグは存在しません。36.1.69 と 37.0.0-rc.1.2257 の `proguard_xamarin.cfg` にはその行が含まれているため、どちらの SDK でも R8 を有効にした MAUI ビルドは縮小と最適化を行いますが、Java の名前はすべてそのまま残ります。書き出される `mapping.txt` には削除されたメンバーや行番号の変更は記録されますが、名前の変更は現れません。

#12535 の計測結果もこれと一致しています。あるアプリの `mapping.txt` では 15,235 クラス中 34 クラス (0.2%) しか名前が変更されておらず、別のアプリでは Play Console が難読化 1% と報告していました。一部の回答で勧められている `AndroidCreateProguardMappingFile=true` の設定は、ここでは何も変えません。これはマッピングファイルを書き出すかどうかを制御するだけです。

一律の `-dontobfuscate` は安全策でした。JNI はマネージドのピアを名前で Java クラスにバインドするため、Java Callable Wrapper やバインドされた AndroidX のメソッドの名前を変えると、実行時に `JNIEnv` の検索が壊れてしまいます。同じスレッドでは、この行を手作業で削除するだけでも不十分であることがわかりました。生成された keep ルールは、バインディングが JNI 経由で名前で読み取るフィールドを保護しておらず、アプリが起動時にクラッシュしたのです。SDK の構成にパッチを当てるのではなく、以下で紹介するサポートされたスイッチを待ってください。

## AndroidR8ObfuscationMode で本当の難読化を有効にする

2026-09-10 にマージされた [dotnet/android #12668](https://github.com/dotnet/android/pull/12668) は、一律のルールを選択的なルールに置き換え、公開プロパティを追加しています。

| `AndroidR8ObfuscationMode` | 難読化 | 最適化のベースライン | デフォルト |
|---|---|---|---|
| `disabled` | なし、Java の名前はすべて保持 | `proguard-android.txt` | .NET 10 サービスリリース |
| `private-members` | private および package-private メンバーの名前を変更 | `proguard-android-optimize.txt` | .NET 11 (RC 1 より後) |

同じ日に [#12752](https://github.com/dotnet/android/pull/12752) が `disabled` をデフォルトとして `release/10.0.1xx` にバックポートしたため、サービス更新によって既存アプリの挙動が変わることはありません。これを含むリリース済みタグはまだありません (36.1.69 はこれより前で、`release/11.0.1xx-rc1` はマージ前に切り出されました)。そのため、.NET 11 RC 2 と次回の .NET 10 サービス更新で入ると考えてください。

`private-members` モードでは、R8 タスクが `-dontobfuscate` の代わりに次のルールを書き出します。

```proguard
# Generated by the R8 task in dotnet/android main (post .NET 11 RC 1)
-keep,allowshrinking,allowoptimization class **
-keepclassmembers,allowshrinking,allowoptimization class ** {
   public protected *;
}
-keep,allowoptimization interface ** {
   public protected *;
}
-keep,allowshrinking class * implements **
```

これは次のように読めます。すべてのクラスは名前を保持し、すべての public および protected メンバーも名前を保持し、private または package-private のものは名前を変更される可能性があります。使われていないコードは引き続き削除できます。インターフェースのルールがあるのは、マネージドのプロキシ選択が R8 からは見えない `Class.getInterfaces()` を呼び出すためです。これがないと、クラスのマージによってインターフェースの関係が失われ、マネージドコードに誤ったプロキシが渡される可能性があります。

サービスリリースが出た後の .NET 10 でオプトインする場合、または .NET 11 でオプトアウトする場合は次のようにします。

```xml
<!-- .NET 10 servicing (opt in) or .NET 11 (opt out with "disabled") -->
<PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
  <AndroidLinkTool>r8</AndroidLinkTool>
  <AndroidR8ObfuscationMode>private-members</AndroidR8ObfuscationMode>
</PropertyGroup>
```

それ以外の値を指定すると、ビルドは XA1050: "The 'AndroidR8ObfuscationMode' MSBuild property has an invalid value" で失敗します。この PR では、文書化されていなかった `_AndroidR8DontObfuscate` と `_AndroidR8DontOptimize` スイッチも削除されているため、issue のスレッドからコピーしたものがあればプロジェクトから削除してください。

期待値は適切に保ってください。PR の報告によると、Google Play は `dotnet new maui -sc` テンプレートを最適化 62%、縮小 65%、難読化 28% と計測しました。25% の基準はクリアしていますが、JNI から見える名前は変更できないため、難読化が最も余裕のない項目です。`private-members` は "Play の要件を満たすのに十分なもの" として扱い、C# のロジックを保護するものとは考えないでください。

## 本当に意味のある keep ルールの書き方

R8 が削除するのは、到達不能だと証明できる Java コードだけです。ルールが必要なのは、R8 から見えない方法で到達されるコードです。

```proguard
# Platforms/Android/proguard.cfg  (.NET 10 / .NET 11, R8 via AndroidLinkTool=r8)

# A Java SDK that loads its own classes with Class.forName and ships no consumer rules
-keep class com.example.vendorsdk.** { *; }

# Classes you look up by string from C#, e.g. Java.Lang.Class.ForName("com.example.Probe")
-keep class com.example.Probe { *; }

# JSON models serialized by a Java library (Gson, Moshi) that uses reflection
-keepattributes Signature,*Annotation*
-keep class com.example.api.models.** { <fields>; }

# Silence a known-harmless missing optional class instead of ignoring all warnings
-dontwarn androidx.window.extensions.**
```

調整中は、診断用のルールを 2 つ一時的に追加しておく価値があります。ご自身の `ProguardConfiguration` ファイルはアプリケーションの構成として扱われるため、グローバルオプションを使用できるからです。

```proguard
# Temporary: dump what R8 removed and the fully merged configuration
-printusage r8-usage.txt
-printconfiguration r8-merged.txt
```

R8 はこれらの相対パスを構成ファイルのフォルダーを基準に解決するため、どちらも `proguard.cfg` の隣に出力されます。`r8-merged.txt` で `-dontobfuscate` を検索すると、SDK が適用した難読化の挙動を確認できます。また、ルールを書く前に `r8-usage.txt` でクラス名を検索して、R8 がそれを削除したことを確かめてください。どちらの行も Release ビルドのたびに時間がかかるので、コミット前に削除してください。

## 実際にハマりやすい注意点

- **Missing class の警告はデフォルトで隠されます。** `AndroidR8IgnoreWarnings` のデフォルトは `True` で、`-ignorewarnings` が追加され、(.NET 8 以降は) `--map-diagnostics warning info` も渡されます。そのため R8 の "Missing class" メッセージは、詳細なビルドログの info 行として表示されます。[dotnet/maui #10901](https://github.com/dotnet/maui/issues/10901) (`androidx.window.extensions.WindowExtensions`) のような問題が通常ビルドを失敗させないのはこのためです。これを `False` にするとより厳格になり、クラスの欠落がビルドエラーになることがあります。グローバルスイッチを元に戻すのではなく、対象を絞った `-dontwarn` で対処してください。
- **パスのつづり間違いは警告にしかなりません。** `ProguardConfiguration` のパスが存在しない場合、XA4304 ("ProGuard configuration file '...' was not found") が出て、R8 はご自身のルールなしで実行されます。CI では `<WarningsAsErrors>XA4304</WarningsAsErrors>` で XA4304 をエラーとして扱ってください。
- **`EnableR8` と `AndroidLinkMode=r8` は何もしません。** どちらも R8 のスイッチとしては存在しません。MSBuild は未知のプロパティを黙って受け入れますし、`AndroidLinkMode` はマネージドのトリマー (`None`、`SdkOnly`、`Full`) を制御するだけです。R8 を有効にするのは `AndroidLinkTool=r8` だけです。
- **グローバルオプションを含むライブラリのルールはスキップされます。** .NET 11 Preview 7 以降、`.aar` 内の `proguard.txt` に `-dontobfuscate`、`-dontoptimize`、`-printmapping` などが含まれている場合、XA4322 とともに除外されます。これは AGP 9 で導入されたのと同じ制限です。アップグレード後にベンダーのライブラリが突然クラッシュするようになったら、ビルドログで XA4322 を確認し、その keep ルール (グローバルオプションを除いたもの) をご自身の `proguard.cfg` にコピーしてください。
- **MS Learn のビルドアイテムのページは情報が古くなっています。** そこには、`EnableProguard` が `True` でない限り `ProguardConfiguration` ファイルは無視されると書かれています。`AndroidLinkTool=r8` を指定すると `AndroidEnableProguard` が強制的に `True` になるため、アイテムは使用されます。
- **難読化されたスタックトレースにはマッピングファイルが必要です。** `private-members` を有効にすると、クラッシュレポート内の private な Java フレームは `a.b.c` のような表示になります。出荷するすべての Release ビルドの `mapping.txt` を保管してください (`.aab` はそれを Play に届けますが、Firebase Crashlytics のようなクラッシュレポーターには別途アップロードが必要です)。
- **R8 はビルド時間を消費します。** R8 は AndroidX と Play services のすべてのバイトコードに対してプログラム全体の解析を行うため、Release ビルドは目に見えて長くなると考えてください。Release だけで使うようにしてください。

## R8 が本当に実行されたかの確認

プロパティだけを信用せず、ビルド出力で確認してください。

1. バイナリログ付きでビルドします: `dotnet publish -f net11.0-android -c Release -bl`。MSBuild Structured Log Viewer で `msbuild.binlog` を開き、`_CompileToDalvik` の下にある `R8` タスクを検索します。`D8` しか見つからない場合、プロパティが Android のビルドに届いていません。たいていは、その条件が `TargetFramework` に一致していないことが原因です。R8 は実行されたもののログに `proguard_project_references.cfg` に対する XA4304 がある場合は、トリミングが無効になっており、アプリは実行時にクラッシュします。
2. `bin/Release/net11.0-android/mapping.txt` が存在し、タイムスタンプが新しいことを確認します。
3. `obj/Release/net11.0-android/android-arm64/proguard/proguard_xamarin.cfg` を開きます (正確な RID フォルダーは `RuntimeIdentifiers` によって異なります)。36.1.69 または 37.0.0-rc.1.2257 では `-dontobfuscate` で始まります。`AndroidR8ObfuscationMode=private-members` を備えた SDK では、代わりに `-keep,allowshrinking,allowoptimization class **` のブロックで始まります。
4. `.aab` を内部テストトラックにアップロードし、Play Console のアプリバンドル エクスプローラーで最適化、縮小、難読化のパーセンテージを確認します。Google が適用するのはこの数値なので、注視すべきはこれです。Play は、バンドルに `r8.json` ビルドメタデータファイルがあればそこからパーセンテージを読み取り、なければ `mapping.txt` から推定します。SDK が `r8.json` をパッケージに含めるようになるのは [dotnet/android #12646](https://github.com/dotnet/android/pull/12646) からで、これは `release/10.0.1xx` と `main` には入っていますが、37.0.0-rc.1.2257 には含まれていません。

## 関連記事

- Play がネイティブライブラリのアラインメントを理由にバンドルを拒否した場合の対処法は、[16 KB ページサイズを理由に Google Play が MAUI アプリを拒否する問題](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) で解説しています。
- ランタイムを切り替えると R8 が扱う APK の内容も変わります。[.NET 11 で MAUI Android アプリを Mono から CoreCLR に移行する](/ja/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/) を参照してください。
- 今回のサイクルで期限を迎えるもう 1 つの Play の要件は、[.NET MAUI から Android API レベル 36 をターゲットにする](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) で扱っています。
- Release ビルドが黙って進むのではなく Java ツールチェーン内で失敗する場合は、[MAUI Android で Gradle build failed to produce an .apk file が発生する問題](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) から始めてください。
- 上記の `-printusage` の手法は、[Flutter Android のリリースビルドで Firebase Auth のサインインが保持されない問題](/ja/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) で R8 を原因から除外するのに使ったものと同じです。

## 参考資料

- [.NET for Android のビルドプロパティ](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-properties) (`AndroidLinkTool`、`AndroidCreateProguardMappingFile`、`AndroidProguardMappingFile`、`AndroidR8IgnoreWarnings`)
- [.NET for Android のビルドアイテム](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-items) (`ProguardConfiguration`、`AndroidAppBundleMetaDataFile`)
- dotnet/android の [D8 と R8 の統合仕様](https://github.com/dotnet/android/blob/main/Documentation/guides/D8andR8.md)
- 37.0.0-rc.1.2257 時点の [`Xamarin.Android.D8.targets`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Xamarin.Android.D8.targets) と [`proguard_xamarin.cfg`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Resources/proguard_xamarin.cfg)
- [dotnet/android #6612: .NET リンカーなしの R8](https://github.com/dotnet/android/issues/6612) と [#12535: 無条件の -dontobfuscate と Play の要件](https://github.com/dotnet/android/issues/12535)
- [dotnet/android #12668: 構成可能な private メンバーの難読化と最適化](https://github.com/dotnet/android/pull/12668) と [.NET 10 へのバックポート #12752](https://github.com/dotnet/android/pull/12752)
- [Android Developers Blog: メモリ使用量の削減とデバイス移行の改善](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html) (2027 年 2 月の DEX 最適化要件)
- [Android vitals における DEX コードの最適化](https://developer.android.com/topic/performance/vitals/code-optimization) (10 MB / 50 MB の DEX しきい値)
