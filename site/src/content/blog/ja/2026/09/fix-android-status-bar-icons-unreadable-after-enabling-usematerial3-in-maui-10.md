---
title: "修正: .NET MAUI 10 で UseMaterial3 を有効にすると Android のステータスバーアイコンが見えなくなる"
description: "MAUI 10.0.100 はステータスバーアイコンの色を colorPrimary から決定しますが、これは Material 3 の surface とは明るさが逆になるため、白地に白、黒地に黒になります。Microsoft.Maui.Controls を 10.0.101 以降に更新するか、MainActivity で AppearanceLightStatusBars を設定し直してください。"
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "android"
  - "material-3"
  - "csharp"
lang: "ja"
translationOf: "2026/09/fix-android-status-bar-icons-unreadable-after-enabling-usematerial3-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-29
---

`<UseMaterial3>true</UseMaterial3>` を設定した直後から、.NET MAUI 10 アプリのライトモードでは白いステータスバーに白い時計とバッテリーのアイコンが表示され、ダークモードでは黒いステータスバーに黒いアイコンが表示される場合、`Microsoft.Maui.Controls` 10.0.100 を使用しています。このリリースから、ステータスバーのアイコン色をテーマの `colorPrimary` の輝度から選ぶようになりました。Material 3 では、透明なエッジ・ツー・エッジのステータスバーの背後に `colorSurface` が描画されます。Material 3 の primary と surface の色は常に明るさが逆なので、アイコンの色が反転してしまいます。修正するには 10.0.101 以降に更新してください(10.0.110 が最新で、2026-09-22 にリリースされました)。まだアップグレードできない場合は、`MainActivity` の `base.OnCreate` の後で `AppearanceLightStatusBars` を自分で設定します。.NET 11 RC 1 ではメインウィンドウは正常ですが、モーダルページではまだ問題が発生します。RC 2 で修正されています。

## エラーの状況

例外は発生せず、ログにも何も出力されません。症状は見た目だけで、エッジ・ツー・エッジ(.NET MAUI 10 では API 30 以降で有効)の Android 15、16、17 では次のようになります。

```text
// .NET 10, Microsoft.Maui.Controls 10.0.100, <UseMaterial3>true</UseMaterial3>
Light mode: status bar background near-white (Material 3 surface), icons and clock white
Dark mode:  status bar background near-black (Material 3 surface), icons and clock black
```

この問題は [dotnet/maui#37705](https://github.com/dotnet/maui/issues/37705) として報告されており、`i/regression` と `regressed-in-10.0.100` のラベルが付いています。10.0.90 にダウングレードするとアイコンが再び見えるようになります。これが、テーマの問題ではなく MAUI 側の変更であることを示す最初の手がかりです。

各バージョンの動作を、各リリースタグの `WindowExtensions.cs` とウィンドウハンドラーから読み取ってまとめました。

| Microsoft.Maui.Controls | ステータスバーアイコン色の決定方法 | Material 3 での結果 |
| --- | --- | --- |
| 10.0.90 以前 | 昼/夜: ライトテーマでは暗いアイコン | 読める |
| 10.0.100 (2026-08-20) | `android:colorPrimary` の輝度 | 反転して読めない |
| 10.0.101 (2026-09-07), 10.0.110 | Material 3 は `colorSurface`、Material 2 は `colorPrimary` の輝度 | 読める |
| 11.0 RC 1 | `colorPrimary` で決定した後、メインウィンドウのみ `Window.StatusBarTheme` (デフォルトは昼/夜) で上書き | メインウィンドウは読める、モーダルページは反転 |
| 11.0 RC 2 ブランチ | 10.0.101 と同じ | 読める |

## アイコンが反転する理由: colorPrimary と colorSurface

Android では、ステータスバーのアイコンに正確な色を指定することはできません。用意されているのは真偽値の `WindowInsetsControllerCompat.AppearanceLightStatusBars` だけです。`true` の場合、システムはステータスバーの背景が明るいと判断して暗いアイコンを描画します。`false` の場合は明るいアイコンを描画します。

10.0.90 までは、MAUI はこのフラグを昼/夜モードだけから設定していました。

```csharp
// .NET MAUI 10.0.90, src/Core/src/Platform/Android/WindowExtensions.cs
var configuration = activity.Resources?.Configuration;
var isLightTheme = configuration is null ||
    (configuration.UiMode & UiMode.NightMask) != UiMode.NightYes;

windowInsetsController.AppearanceLightStatusBars = isLightTheme;
windowInsetsController.AppearanceLightNavigationBars = isLightTheme;
```

これは、ステータスバーの背後にあるものが昼/夜モードに従っている場合は機能しますが、そうでない場合は破綻します。[dotnet/maui#32987](https://github.com/dotnet/maui/issues/32987) は後者のケースでした。ステータスバーの下に黒い `colorPrimary` のアプリバーを持つライトテーマの Material 2 アプリで、暗いバーに暗いアイコンが表示されていました。その修正である [dotnet/maui#36214](https://github.com/dotnet/maui/pull/36214) は 2026-07-01 にマージされ、10.0.100 で出荷されました。現在のテーマから `android:colorPrimary` を解決し、その輝度を代わりに使用します。

```csharp
// .NET MAUI 10.0.100, src/Core/src/Platform/Android/WindowExtensions.cs
if (TryGetThemeColor(activity, global::Android.Resource.Attribute.ColorPrimary, out var statusBarColor))
    windowInsetsController.AppearanceLightStatusBars = IsLightColor(statusBarColor);
else
    windowInsetsController.AppearanceLightStatusBars = isLightTheme;

// ...
static bool IsLightColor(AColor color) =>
    ColorUtils.CalculateLuminance(color.ToArgb()) > 0.5;
```

`colorPrimary` で塗られた Material 2 のアプリバーであれば、これは正しい動作です。しかし Material 3 では完全に逆になります。`UseMaterial3` を有効にすると、MAUI はアクティビティのテーマを `Maui.Material3.Theme.NoActionBar` に切り替えます。その親は `Theme.Material3.DayNight` です。MAUI 独自の Material 3 スタイルは primary カラーを上書きしないため、Material 3 のベースラインパレットが使われます。Material 3 ではステータスバーの背後に primary ではなく surface カラーが置かれ、パレットは primary が surface と対比するように設計されています。

| テーマ | `colorPrimary` | 相対輝度 | 10.0.100 の判定 | 実際の背景 |
| --- | --- | --- | --- | --- |
| ライト | `#6750A4` | 0.11 (暗い) | 明るいアイコン | ほぼ白の surface |
| ダーク | `#D0BCFF` | 0.57 (明るい) | 暗いアイコン | ほぼ黒の surface |

`Platforms/Android/Resources/values/colors.xml` にあるテンプレートの紫 `#512BD4` も助けにはなりません。その色リソースは Material 3 テーマではなく Material 2 の `Maui.MainTheme` に使われますし、そもそも暗い色(輝度 0.08)です。彩度の高い primary を持つライトテーマの Material 3 パレットは、どれも同じ結果になります。

10.0.101 の修正である [dotnet/maui#37710](https://github.com/dotnet/maui/pull/37710) (SR10 ブランチへのバックポートは [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)) は、輝度を使うという考え方はそのままに、バーの背後に実際にある属性を読み取ります。

```csharp
// .NET MAUI 10.0.101 and 10.0.110, src/Core/src/Platform/Android/WindowExtensions.cs
internal static bool GetStatusBarAppearance(Context context, bool isLightTheme, bool isMaterial3)
{
    // Material 3 draws its surface behind the transparent edge-to-edge status bar.
    // The Material 2 app bar uses colorPrimary in the same area.
    var backgroundAttribute = isMaterial3
        ? Resource.Attribute.colorSurface
        : global::Android.Resource.Attribute.ColorPrimary;

    return TryGetThemeColor(context, backgroundAttribute, out var backgroundColor)
        ? IsLightColor(backgroundColor)
        : isLightTheme;
}
```

## 最小の再現手順

デフォルトのテンプレートから始めて、影響のあるパッケージを固定します。

```xml
<!-- .NET 10 SDK, dotnet new maui, MyApp.csproj -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.100" />
</ItemGroup>
```

Android 11 (API 30) 以降のエミュレーターで実行します。ライトモードのホームページでは、ステータスバーのアイコンが白くなります。エミュレーターをダークモードに切り替えてアプリを再起動すると、アイコンは黒くなります。`10.0.100` を `10.0.90` に変更すると、どちらのモードでも読めるようになります。`10.0.110` に変更しても、どちらのモードでも再び読めるようになります。

エミュレーターを目を凝らして見る代わりに、MAUI が何を決定したかを確認したい場合は、起動後にフラグをログ出力します。

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
protected override void OnResume()
{
    base.OnResume();
    var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(Window!, Window!.DecorView);
    Android.Util.Log.Info("StatusBar", $"AppearanceLightStatusBars={controller.AppearanceLightStatusBars}");
}
```

10.0.100 のライトモードでは `False` と表示されます。これは「背景が暗いので明るいアイコンを描画する」という意味で、実際の背景はほぼ白の surface です。

## 修正 1: Microsoft.Maui.Controls を 10.0.101 以降に更新する

これが本来の修正です。同じ .NET 10 ラインのパッチリリースなので、ターゲットフレームワークの変更は不要です。ビルドマシンにインストールされているワークロードの `$(MauiVersion)` に頼らず、バージョンを明示的に指定してください。

```xml
<!-- .NET 10, MyApp.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
</ItemGroup>
```

変更されたコードは `Microsoft.Maui.Core` にあり、`Microsoft.Maui.Controls` が同じバージョンで取り込みます。プロジェクトが `Microsoft.Maui.Core` や `Microsoft.Maui.Controls.Compatibility` を直接参照している場合は、それらも同じバージョンに上げてください。そうしないと NuGet が混在したセットを解決する可能性があります。`dotnet list package --include-transitive` で実際に取得されたものを確認できます。

その後、クリーンしてリビルドします。Android のリソースやテーマの変更は、インクリメンタルなデプロイでは反映されないことがよくあります。結果を判断する前に、一度デバイスからアプリをアンインストールしてください(`adb uninstall com.companyname.myapp`)。

10.0.110 には、同じく 10.0.100 のリグレッションである [MediaPicker.PickPhotosAsync の UIKitThreadAccessException](/ja/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) の修正も含まれているため、10.0.100 にとどまる理由はほとんどありません。逆方向の注意点として、10.0.101 と 10.0.110 には [filter や text 要素を使う SVG アプリアイコン](/ja/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/)で Resizetizer の問題があります。リリースブランチをアップグレードする前に、アイコンを確認してください。

## 修正 2: MainActivity で AppearanceLightStatusBars を設定し直す

当面 10.0.100 に固定されている場合は、フラグを自分で上書きします。`MauiAppCompatActivity.OnCreate` は `CreatePlatformWindow` を呼び出し、それが `WindowHandler` を接続し、`ConfigureTranslucentSystemBars` を実行して誤った値を書き込みます。これらはすべて `base.OnCreate` の内部で行われるため、その呼び出しの後に設定した値がメインウィンドウでは優先されます。

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
using Android.App;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.View;

namespace MyApp;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                           ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        // MAUI sets the status bar appearance inside base.OnCreate. Correct it afterwards.
        base.OnCreate(savedInstanceState);
        ApplyStatusBarIconContrast(Resources?.Configuration);
    }

    public override void OnConfigurationChanged(Configuration newConfig)
    {
        base.OnConfigurationChanged(newConfig);
        ApplyStatusBarIconContrast(newConfig);
    }

    void ApplyStatusBarIconContrast(Configuration? configuration)
    {
        // MAUI only configures edge-to-edge system bars on API 30+, so mirror that.
        if (!OperatingSystem.IsAndroidVersionAtLeast(30) || Window is null)
            return;

        var isNight = configuration is not null &&
            (configuration.UiMode & UiMode.NightMask) == UiMode.NightYes;

        // true means "light background": Android draws dark icons.
        WindowCompat.GetInsetsController(Window, Window.DecorView)
            .AppearanceLightStatusBars = !isNight;
    }
}
```

これで 10.0.90 の動作が復元されます。`OnConfigurationChanged` のオーバーライドが重要な理由は、テンプレートの `ConfigurationChanges` に `ConfigChanges.UiMode` が含まれているためです。ユーザーがシステムテーマを切り替えても Android はアクティビティを再作成せず、MAUI 10 はウィンドウハンドラーが接続されたときにしかフラグを設定しません。このオーバーライドがないと、次のコールドスタートまでアイコンが前のモードの色のままになります。

10.0.101 以降に移行したら、このオーバーライドは削除してください。組み込みの修正は実際の `colorSurface` からフラグを導き出すため、surface の色をカスタマイズしている場合は昼/夜よりも正確です。

## 修正 3: .NET 11 では Window.StatusBarTheme を使う

.NET 11 では `Window.StatusBarTheme` ([dotnet/maui#34903](https://github.com/dotnet/maui/pull/34903)) が追加されました。`Default`、`Light`、`Dark` を持つ列挙型です。RC 1 では、`WindowHandler.ConnectHandler` が `ConfigureTranslucentSystemBars` (`colorPrimary` のロジックがまだ残っています) を呼び出し、その直後に `StatusBarTheme` を適用します。`Default` は昼/夜にフォールバックするため、.NET 11 RC 1 アプリのメインウィンドウは何もしなくても読めます。

モーダルページは異なります。`ModalNavigationManager` は各モーダルを専用のダイアログウィンドウで表示し、そのウィンドウで `ConfigureTranslucentSystemBars` を呼び出しますが、その後に `StatusBarTheme` を適用しません。そのため RC 1 では、`Navigation.PushModalAsync` で開いたページでアイコンの反転が再び発生します。修正は `release/11.0.1xx-rc2` ブランチにあり、RC 2 で両方とも解決されます。

`StatusBarTheme` は、ライトテーマで暗いヒーロー画像など、surface 以外のものがステータスバーの背後にくる場合にも適したツールです。

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, App.xaml.cs
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());

    // Light = light status bar background, so Android draws dark icons.
    window.SetAppTheme(Window.StatusBarThemeProperty, StatusBarTheme.Light, StatusBarTheme.Dark);

    return window;
}
```

または、特定の画面だけ暗いヘッダーの上で明るいアイコンが必要な場合は、ページのウィンドウに設定し、ページが閉じるときに元に戻します。

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, HeroPage.xaml.cs
protected override void OnAppearing()
{
    base.OnAppearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Dark;
}

protected override void OnDisappearing()
{
    base.OnDisappearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Default;
}
```

命名に注意してください。`StatusBarTheme` はアイコンではなくバーを表します。`Dark` は「バーが暗い」という意味で、明るいアイコンになります。これは `AppearanceLightStatusBars` と同じ規則です。

## 落とし穴とよく似た問題

**Material 2 アプリでは鏡像のような問題が起こりえます。** 10.0.101 と 10.0.110 は、Material 2 のステータスバーを意図的に引き続き `colorPrimary` から導き出します。Material 2 のアプリバーがその色で塗られているためです。Material 2 アプリがナビゲーションバーを非表示にしている(`Shell.NavBarIsVisible="False"`)場合、`colorPrimary` が暗いままだと、白いページがステータスバーの下に表示され、白の上に明るいアイコンが選ばれてしまいます。これは同じソースから導かれる結果であり、デフォルトの Material 2 レイアウトではアプリバーがステータスバーの下にくるため、バグとしては追跡されていません。修正 2 の `MainActivity` のオーバーライドで対処できます。

**ナビゲーションバーのアイコンは影響を受けません。** 上記のどのバージョンでも、`AppearanceLightNavigationBars` は引き続き昼/夜から設定されます。ジェスチャーピルや 3 ボタンバーが読めない場合は別の問題で、多くは [API 36 のエッジ・ツー・エッジの変更](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/)の後で、バーの下にコンテンツが描画されていることが原因です。

**Android 10 以前では問題ありません。** MAUI がこのコードを実行するのは API 30 以降だけです。それ未満ではウィンドウハンドラーが `ConfigureTranslucentSystemBars` を呼び出さないため、古いエミュレーターでテストしてもバグは再現しません。

**Android 15 以降ではステータスバーの色を設定しても効果がありません。** 最初によく試されるのは、`MainActivity` からの `Window.SetStatusBarColor(...)` です。API 35 以上をターゲットにし、Android 15 以降で動作するアプリでは、エッジ・ツー・エッジが強制されるため、この呼び出しは無視されます。バーは透明のままなので、ここで意味を持つ手段はアイコン外観のフラグだけです。

**ダークモードの設定の問題ではありません。** 実行時の `Application.Current.UserAppTheme` の変更後にのみアイコンが誤っていて、コールドスタート後は正しい場合、それはこのリグレッションではなく、修正 2 で説明した再適用の欠落です。[MAUI アプリでダークモードを正しくサポートする方法](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)では、`AppThemeBinding` に従わないその他のネイティブ領域について説明しています。

## 関連記事

- [.NET MAUI 10 SR6 が単一の UseMaterial3 フラグで Android の Material 3 を完成させる](/ja/2026/05/maui-10-material-3-android-usematerial3-flag/)では、このフラグが何を変更し、どのコントロールにスタイルを適用するかを説明しています。
- [.NET MAUI Android アプリを Android API レベル 36 に対応させる](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/)では、そもそもステータスバーを透明にするエッジ・ツー・エッジとセーフエリアの変更を扱っています。
- [MAUI アプリでダークモードを正しくサポートする方法](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)では、テーマに対応した色と `RequestedThemeChanged` への対応を扱っています。
- [修正: .NET MAUI Resizetizer の MissingMethodException (MAUIR0001) が SVG アプリアイコンで発生する](/ja/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/)は、10.0.101 または 10.0.110 にアップグレードする前にご覧ください。

## 参考資料

- [dotnet/maui#37705: Status bar icons become unreadable when UseMaterial3 is enabled in 10.0.100](https://github.com/dotnet/maui/issues/37705)
- [dotnet/maui#36214: Fix status bar icon contrast with custom colorPrimary](https://github.com/dotnet/maui/pull/36214) (リグレッションを引き起こした変更)
- [dotnet/maui#37710: Fix Material 3 status bar icon contrast](https://github.com/dotnet/maui/pull/37710) と 10.0.101 へのバックポート [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)
- [dotnet/maui#34903: Add Window.StatusBarTheme](https://github.com/dotnet/maui/pull/34903)
- [タグ 10.0.100 の `WindowExtensions.cs`](https://github.com/dotnet/maui/blob/10.0.100/src/Core/src/Platform/Android/WindowExtensions.cs) と [タグ 10.0.110 の同ファイル](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/WindowExtensions.cs)
- [タグ 10.0.110 の `styles-material3.xml`](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/Resources/values/styles-material3.xml)
- [WindowInsetsControllerCompat.setAppearanceLightStatusBars (Android Developers)](https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat#setAppearanceLightStatusBars(boolean))
- [Microsoft.Maui.Controls on NuGet](https://www.nuget.org/packages/Microsoft.Maui.Controls) (リリース日の確認用)
