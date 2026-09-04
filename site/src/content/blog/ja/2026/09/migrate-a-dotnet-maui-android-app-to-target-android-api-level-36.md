---
title: ".NET MAUI の Android アプリを API レベル 36 ターゲットに移行する"
description: "Google Play は 2026-08-31 からターゲット API レベル 36 を必須にし、延長は 2026-11-01 までです。net9.0-android から API 36 までの .NET MAUI の移行手順をすべて解説します。target framework の変更、古いレベルに静かに固定してしまう uses-sdk、オプトアウトできなくなった edge-to-edge、予測型の戻る操作、そして大画面のルールまで。"
pubDate: 2026-09-04
updatedDate: 2026-09-04
template: migration
tags:
  - "migration"
  - "maui"
  - "android"
  - "google-play"
  - "dotnet-10"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36"
translatedBy: "claude"
translationDate: 2026-09-04
---

ビルド側の変更は 1 行です。移行の本体は動作の変更のほうです。Google Play は 2026-08-31 から、新規アプリとアプリ更新にターゲット API レベル 36 を要求しはじめました。アプリ単位の延長は Play Console から 2026-11-01 まで申請できます。今週アップデートがリジェクトされたなら、理由はこれです。.NET MAUI アプリでは、ターゲット API レベルは自分で編集するマニフェストの設定ではありません。`TargetFramework` に含まれる Android プラットフォームバージョンから導出され、.NET 9 は API 35 までしか到達しません。つまりこれはマニフェストの微調整ではなく、.NET SDK を .NET 10 (または .NET 11) へ上げる作業です。小さなアプリなら 1 日、画面の向きを固定しているもの、独自の戻るボタンを持つもの、インセットを手作業で調整しているものなら 1 スプリントを見込んでください。本記事は到達点として .NET 10 と .NET MAUI 10.0.100 (2026-08-20 リリース) を対象にし、.NET 11 との差分も併記します。

## Play が確認しているのがターゲットレベルである理由

- **ゲートになるのは `targetSdkVersion` であり、`compileSdk` でも `minSdk` でもありません。** Play は AAB 内のマージ済みマニフェストから `android:targetSdkVersion` を読み取ります。API 36 のプラットフォームに対してビルドするだけでは足りません。
- **既存のインストールは削除されず、新規ユーザーが遮断されます。** [Play Console のターゲット API レベルのポリシー](https://support.google.com/googleplay/android-developer/answer/11926878)によれば、下限を満たさないアプリは既に入っている端末には残りますが、アプリのターゲットより新しい Android バージョンの新規ユーザーには配信されなくなります。インストールのファネルは目に見えて壊れるのではなく、静かに劣化します。
- **各年の下限は前年のリリースです。** API 36 は Android 16 です。2027 年の要件は API 37 (Android 17) になり、.NET for Android はすでに安定版として提供しています。ここでの作業は、これから毎年 1 回繰り返す作業です。

## 何が壊れるか

| 領域 | ターゲット API 36 での変更 | 深刻度 |
| --- | --- | --- |
| Edge-to-edge | `windowOptOutEdgeToEdgeEnforcement` は非推奨になり、Android 16 端末では無視されます | 高 |
| .NET MAUI のセーフエリア | .NET 10 以降 `ContentPage.SafeAreaEdges` の既定値が `None` になり、ページが画面端まで広がります | 高 |
| 予測型の戻る操作 | ホームへの復帰やアクティビティ間のアニメーションが既定で有効になり、`OnBackPressed` は呼ばれません | 高 |
| 大画面 | `sw600dp` 以上で `android:screenOrientation`、`resizableActivity`、`minAspectRatio`、`maxAspectRatio` が無視されます | 高 (タブレット、折りたたみ端末) |
| .NET SDK | API 36 には `net10.0-android` 以降が必要で、.NET 9 のワークロードは API 35 で止まります | 高 |
| 最小 API | .NET 11 は下限を API 21 から API 24 に引き上げます | 中 (.NET 11 のみ) |
| テキスト描画 | `android:elegantTextHeight` は非推奨になり無視されます | 低 |
| スケジューリング | `ScheduledExecutorService.scheduleAtFixedRate` は取りこぼした実行を最大 1 回しか補いません | 低 |
| ヘルスセンサー | `BODY_SENSORS` は粒度の細かい `android.permissions.health` 権限に置き換わります | 低 (心拍を読む場合を除く) |

上の 2 行は重なり合います。API 36 を得るために .NET 10 へ上げると、同じコミットで .NET MAUI 自身のセーフエリアの既定値も変わります。そのため、.NET 9 でターゲット 35 のときは問題なく見えていたアプリが、独立した 2 つの理由でタイトルバーがステータスバーの下に潜った状態で出てくることがあります。

## 事前チェックリスト

- .NET 10 SDK がインストールされ、`maui-android` ワークロードが復元されていること: `dotnet workload install maui-android`。
- API 36 の Android SDK Platform がビルドマシンと CI に実際に存在すること。無いと警告ではなく [XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) になります。
- Android 16 が動作する実機またはエミュレーターイメージ。ここでの動作変更は自分のターゲットだけでなく OS バージョンにも依存するため、Android 14 のエミュレーターではすべて隠れてしまいます。
- 何も変更する前に、現在の UI をスマートフォンとタブレットで撮ったスクリーンショット。インセットのリグレッションを判断するのに必要です。
- 16 KB ページサイズの対応状況を先に片付けておくこと。これは独自の失敗モードを持つ別の Play 要件です。[Google Play が Flutter や MAUI のアプリを 16 KB ページサイズで却下する理由](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/)を参照してください。

## 移行手順

1. **今のターゲットが実際にいくつなのかを確認します。** csproj ではなく、ビルドが生成するマージ済みマニフェストを読んでください。

   ```bash
   dotnet build -f net9.0-android -c Release
   grep -o 'targetSdkVersion="[0-9.]*"' obj/Release/net9.0-android/AndroidManifest.xml
   ```

   **確認:** 数値が 1 つ出力されます。それが `TargetFramework` の Android プラットフォームバージョンより低ければ、何かが値を固定しています。その場合は手順 3 が最重要です。

2. **target framework を .NET 10 に移します。** TFM の Android プラットフォームバージョンがそのまま `targetSdkVersion` になるため、この 1 箇所の編集が移行の実体です。

   ```xml
   <!-- .csproj, .NET 10, .NET MAUI 10.0.100 -->
   <PropertyGroup>
     <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   素の `net10.0-android` は API 36 に解決され、これが [.NET 10 のドキュメント化された既定値](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10)です。後で .NET 11 に移ったときに勝手に動くのではなくビルドを失敗させたいなら、`net10.0-android36.0` と明示的に固定してください。.NET for Android は .NET 11 Preview 5 で API 37 を安定版に昇格させ、.NET 11 プロジェクトの既定を `net11.0-android37` にしているためです。`$(SupportedOSPlatformVersion)` は別の軸で、`minSdkVersion` になるものであり、Play の要件とは関係ありません。

   **確認:** 再ビルドし、手順 1 の `grep` を `obj/Release/net10.0-android/AndroidManifest.xml` に対して実行します。`targetSdkVersion="36"` と表示される必要があります。

3. **マニフェストに直書きされた `uses-sdk` を削除します。** 手順 2 が何も効いていないように見える最大の原因がこれです。.NET for Android がテンプレートのマニフェストに `targetSdkVersion` を書き込むのは、そこにまだ値が無い場合だけで、明示的な値が無条件に優先されます ([`ManifestDocument.cs`](https://github.com/dotnet/android/blob/main/src/Xamarin.Android.Build.Tasks/Utilities/ManifestDocument.cs))。

   ```xml
   <!-- Platforms/Android/AndroidManifest.xml: delete the uses-sdk line entirely -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
     <application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true" />
   </manifest>
   ```

   Microsoft 自身の [XA5207 のガイダンス](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207)が、SDK 更新をまたいでターゲットレベルを保つためにまさにこの要素を追加するよう案内していたので、Xamarin.Forms 時代のプロジェクトには今も残っています。現在の .NET MAUI テンプレートには `uses-sdk` 要素が一切なく、それが望ましい状態です。

   **確認:** `grep -c uses-sdk Platforms/Android/AndroidManifest.xml` が `0` を返し、マージ済みマニフェストには引き続き `targetSdkVersion="36"` が出ること。

4. **edge-to-edge の方針を決めます。もう選択の余地はありません。** ターゲット 36 では、`windowOptOutEdgeToEdgeEnforcement` 属性は Android 16 端末で[非推奨かつ無効](https://developer.android.com/about/versions/16/behavior-changes-16)です。`Platforms/Android/Resources/values/styles.xml` に書いていたなら削除してください。そのうえで、.NET 10 の既定値である `None` をそのまま受け入れるのではなく、ページごとに `SafeAreaEdges` の値を選びます。

   ```xml
   <!-- .NET MAUI 10.0.100: ContentPage defaults to SafeAreaEdges="None" -->
   <ContentPage SafeAreaEdges="Container">
       <Grid SafeAreaEdges="Container" RowDefinitions="Auto,*">
           <Label Text="Not under the status bar" />
       </Grid>
   </ContentPage>
   ```

   `Container` は、システムバーやディスプレイのカットアウトを避ける .NET 9 の動作を再現します。`All` はさらにキーボードも避けるので、Android の platform-specific である `WindowSoftInputModeAdjust.Resize` に依存していたならこちらです。`None` は没入型の選択肢であり、意図して選ぶものであって、うっかり引き継ぐ既定値ではありません。

   **確認:** Android 16 端末で、主要な 3 画面において、ライトテーマとダークテーマの両方でステータスバーとジェスチャーナビゲーションバーがタップ可能なコントロールに重ならないこと。

5. **予測型の戻る操作に飲み込まれる前に、独自の戻る処理を直します。** ターゲット 36 では予測型の戻るアニメーションが既定で有効になり、`onBackPressed()` は呼ばれず、`KeyEvent.KEYCODE_BACK` もディスパッチされません。次のようなアクティビティのオーバーライドは動かなくなります。

   ```csharp
   // Broken at targetSdkVersion 36 on Android 16
   public override void OnBackPressed()
   {
       if (_hasUnsavedChanges) { ShowConfirmDialog(); return; }
       base.OnBackPressed();
   }
   ```

   代わりに .NET MAUI 自身のナビゲーション層で処理してください。こちらはプラットフォームをまたいで動き続けます。

   ```csharp
   // .NET MAUI 10.0.100, cross-platform
   protected override bool OnBackButtonPressed()
   {
       if (!_hasUnsavedChanges)
           return base.OnBackButtonPressed();

       Dispatcher.Dispatch(async () => await DisplayAlertAsync("Discard changes?", "...", "OK"));
       return true; // handled
   }
   ```

   Android 側の逃げ道は `<application>` または個別の `<activity>` に付ける `android:enableOnBackInvokedCallback="false"` ですが、これは応急処置であって解決策ではありません。

   **確認:** 画面の端からスワイプして指を止めます。プレビューのアニメーションが見え、指を離したときにハンドラーの意図どおりの動作になること。

6. **固定した画面の向きとアスペクト比を洗い出します。** `sw600dp` 以上のディスプレイでは、ターゲット 36 によって Android が `android:screenOrientation`、`android:resizableActivity`、`android:minAspectRatio`、`android:maxAspectRatio` と、実行時の `SetRequestedOrientation` を無視します。.NET MAUI では通常、`MainActivity` の属性が該当します。

   ```csharp
   // Ignored on sw600dp+ displays at targetSdkVersion 36
   [Activity(ScreenOrientation = ScreenOrientation.Portrait, /* ... */)]
   public class MainActivity : MauiAppCompatActivity { }
   ```

   一時的なオプトアウトはマニフェストのプロパティで、Google は API レベル 37 では適用されなくなると明言しています。

   ```xml
   <application>
     <property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
               android:value="true" />
   </application>
   ```

   **確認:** タブレットまたは折りたたみ端末のエミュレーターで実行して回転させます。横向きでレイアウトが使い物にならないならレイアウトを直してください。オプトアウトで買える時間は 1 年だけです。

7. **持っていないプラットフォームに対してビルドしないよう CI を更新します。** エージェントに API 36 が無いと XA5207 として表面化しますが、対処はポータルからのダウンロードではなくビルドターゲットです。

   ```bash
   dotnet build -t:InstallAndroidDependencies -f net10.0-android \
     -p:AndroidSdkDirectory="$ANDROID_HOME" \
     -p:AcceptAndroidSDKLicenses=true
   ```

   `-f` 引数は必須で、付けないと MSBuild が `MSB4057: The target "InstallAndroidDependencies" does not exist in the project` を報告します。

   **確認:** SDK キャッシュが空の状態からのクリーンな CI 実行で、XA5207 なしに署名済み AAB が生成されること。

## 検証チェックリスト

- `obj/Release/net10.0-android/AndroidManifest.xml` に `targetSdkVersion="36"` と意図した `minSdkVersion` が入っている。
- 内部トラックでの Play Console の事前起動レポートに、ターゲット API レベルの警告が出ていない。
- Android 16 のスマートフォンで、上下のインセットの重なりを全画面について確認し、キーボードを開いた状態でも確認した。
- 戻るジェスチャー、戻るボタン、終了確認ダイアログが以前と同じ挙動である。
- 大画面向けに配信しているなら、タブレットまたは折りたたみ端末で両方の向きで動作確認した。
- 昇格の前に、内部トラックで 1 週間経過してもクラッシュフリー率と ANR 率が横ばいである。

## ロールバック計画

`TargetFramework` を `net9.0-android` に戻せば、以前のターゲットレベルと以前の .NET MAUI のセーフエリアの動作が復元されます。.NET 10 の API を新たに使い始めていない限り、これはきれいなリバートです。戻せないのは Play 側です。ターゲット 36 の AAB を一度公開すると、その後は同じトラックにそれより低いターゲットレベルを公開できません。Play はアップロードのたびに下限を強制するからです。内部トラックをロールバックの猶予期間とみなし、production への昇格は片道と考えてください。

## 実際に時間を奪う落とし穴

- **マニフェストにはメジャーバージョンだけが書かれます。** `net11.0-android36.1` は `android:targetSdkVersion="36"` を生成します。マニフェスト生成側が API レベルのメジャー部分を取るためです。マージ済みマニフェストに `36.1` が出ると思ってバグを探しに行ったとしても、バグはありません。
- **.NET 9 ではそこに到達できません。** .NET 9 の Android ワークロードは API 35 のバインディングを出してそこで止まったので、`net9.0-android36.0` は有効な TFM ではありません。SDK を動かさずに Play の要件を満たす方法はありません。
- **予測型の戻る操作には実際に .NET MAUI のバグがありました。** `MauiAppCompatActivity` が戻るコールバックを無条件に登録していたため、.NET MAUI が処理すべきものが何も無いルートページでも、Android のホームへ戻るアニメーションが抑制されていました。ナビゲーションが実際に戻れるかどうかを `Enabled` の状態が追随する AndroidX の `OnBackPressedCallback` に切り替えることで修正され ([dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223))、.NET MAUI 10.0.90 で出荷されました。`BlazorWebView` にも同じバグがあり、同じリリースで個別に修正されています。Android 16 で戻るアニメーションがぎこちないなら、自分のコードをデバッグする前に .NET MAUI のバージョンを確認してください。
- **キーボード回避では `ScrollView` が `SafeAreaEdges` を無視します。** `ScrollView` は自前でコンテンツのインセットを管理するため、そこでは `SoftInput` が効きません。`Grid` で包み、コンテナー側に `SafeAreaEdges` を設定してください。
- **新しい画面端まで広がる背景の上で、ステータスバーのアイコンが見えなくなります。** .NET 11 Preview 7 では、アプリのテーマとは独立してアイコンのコントラストを制御する `Window.StatusBarTheme` が Android 6.0 以降向けに追加されました。.NET 10 では `WindowInsetsControllerCompat.AppearanceLightStatusBars` を自分で設定します。
- **Play の延長はアプリ単位で期限付きです。** 2026-11-01 までの延長は、対象アプリの Play Console 通知から申請するもので、自動的に付与されるものではなく、来年の API 37 の期限を動かすものでもありません。

## 関連記事

- [.NET MAUI の Android アプリを .NET 11 で Mono から CoreCLR に移行する](/ja/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)は、API 24 の下限を含む .NET 11 への移行のもう半分を扱っています。
- [Google Play が Flutter や MAUI のアプリを 16 KB ページサイズで却下する理由](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/)は、アップロードを止めるもう 1 つの Play 要件です。
- [.NET MAUI の Android アプリのインストール時に出る "Doesn't support required ABI" を直す](/ja/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/)は、ランタイム識別子を変えた直後に踏むインストール時の失敗です。
- [SDK 35 をターゲットにした後に Flutter の UI が Android のナビゲーションバーに重なる問題を直す](/ja/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/)は、同じ edge-to-edge の強制を Flutter 側から見たものです。
- [Xamarin.Forms から .NET MAUI 11 へ移行する](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)は、手順 3 の直書き `uses-sdk` が問題のうちで最も軽かった場合に読んでください。

## 参照元

- [Google Play アプリのターゲット API レベル要件](https://support.google.com/googleplay/android-developer/answer/11926878)、Play Console ヘルプ。
- [動作の変更点: Android 16 以上をターゲットとするアプリ](https://developer.android.com/about/versions/16/behavior-changes-16)、Android Developers。
- [.NET 10 の .NET MAUI の新機能](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10)と[.NET 11 の新機能](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11)、Microsoft Learn。
- [セーフエリアのレイアウト](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/safe-area)、Microsoft Learn。.NET 10 での `ContentPage` の破壊的変更を含みます。
- [.NET for Android エラー XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) と[ビルドターゲット](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-targets)、Microsoft Learn。
- [.NET for Android 11 Preview 5 のリリースノート](https://github.com/dotnet/android/releases/tag/36.99.0-preview.5.308)。API 37 を安定版にし、.NET 11 の既定を `net11.0-android37` にしています。
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223)、予測型の戻る操作の登録に関する修正。
