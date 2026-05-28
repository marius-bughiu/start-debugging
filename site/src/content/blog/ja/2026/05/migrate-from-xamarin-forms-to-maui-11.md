---
title: "Xamarin.Forms 5.0 から .NET MAUI 11 への移行: 完全チェックリスト"
description: "net11.0 上での Xamarin.Forms 5.0 から .NET MAUI 11 GA へのエンドツーエンド移行。csproj の書き換え、カスタムレンダラーからハンドラーへの変換、AppShell の配線、DependencyService の撤去、MessagingCenter の引退、Resizetizer アセット、実プロダクションコードを噛む落とし穴までカバーします。"
pubDate: 2026-05-28
updatedDate: 2026-05-28
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/migrate-from-xamarin-forms-to-maui-11"
translatedBy: "claude"
translationDate: 2026-05-28
---

Xamarin.Forms は 2024-05-01 にサポート終了となり、それ以降 Microsoft は単一の修正もリリースしていません。.NET MAUI 11 は、借り物の時間で動いているすべての Xamarin.Forms 5.0 アプリにとっての LTS の着地点です。2025 年 11 月の MAUI 11.0 GA をもって、プラットフォームはようやく初期 MAUI リリースに欠けていたレンダラーの配管、`RecyclerView` のパフォーマンス、iOS 18 / Android 15 のターゲットサポートを備えました。10 〜 20 画面と少数のカスタムレンダラーを持つ中規模アプリの 1 人開発者集中型の移行で、1 〜 3 週間かかります。難しい部分は XAML でもビルドシステムでもなく、カスタムレンダラー、`DependencyService`、そしてプラットフォームプロジェクトを直接触ったコードです。本記事ではソースとして `Xamarin.Forms 5.0.0.2622`、ターゲットとして `net11.0` 上の `.NET MAUI 11.0.0` を固定し、`net11.0-android35.0`、`net11.0-ios18.0`、`net11.0-maccatalyst18.0` をアクティブな TFM とします。

ロールバックは簡単ではありません。`.csproj` を `Microsoft.NET.Sdk` と `UseMaui=true` の SDK スタイルに切り替えると、バージョン管理から元の csproj と `packages.config` を復元しない限り Xamarin.Forms の共有プロジェクトには戻れません。移行は片道切符として扱い、ブランチをそれに合わせて作ってください。

## なぜ今移行するのか

- Xamarin.Forms はサポートされていません。Google Play が 2025-08-31 から強制を始めた Android 15 のターゲット SDK 引き上げに対するパッチはなく、Apple は App Store Connect で iOS 17 レガシー SDK にリンクされたビルドを今や拒否します。
- MAUI 11 は Android と iOS でデフォルトとして Mono ではなく CoreCLR 上で動作します。素の Shell アプリで Pixel 8 のコールドスタートは約 1.6 s から 0.9 s に下がり、GC が `SGen` ではなく世代別になったため定常状態のアロケーションも減ります。この切り替えは [MAUI の CoreCLR デフォルトに関する記事](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) で扱っています。
- ハンドラーアーキテクチャはカスタムレンダラーを小さな表面で置き換え、Xamarin.Forms が成長の過程で増やした `Effect` プラス `PlatformEffect` の後付け構造を回避します。
- Resizetizer がインボックスで同梱されます。`Resources/Images/*.svg` パイプラインがビルド時にプラットフォーム固有の PNG を生成するので、`drawable-xhdpi`、`drawable-xxhdpi`、`Assets.xcassets`、`LaunchScreen.storyboard` の動物園をついに削除できます。

## 何が壊れるか

| 領域                     | 変更                                                                            | 重大度   |
| ------------------------ | ------------------------------------------------------------------------------- | -------- |
| プロジェクトレイアウト   | 共有プロジェクトと 3 つの head プロジェクトが 1 つの SDK スタイル csproj に縮約 | 高       |
| `Xamarin.Forms` 名前空間 | `Microsoft.Maui.Controls`、`Microsoft.Maui.Graphics` などに置換                  | 高       |
| カスタムレンダラー       | `ExportRenderer` と `IVisualElementRenderer` は削除。ハンドラーを使用            | 高       |
| `DependencyService`      | 削除。`Microsoft.Extensions.DependencyInjection` を使用                          | 高       |
| `MessagingCenter`        | 非推奨、削除予定。[CommunityToolkit.Mvvm の `IMessenger`](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) を使用 | 高 |
| `Application.Properties` | 削除。`Microsoft.Maui.Storage.Preferences` を使用                                | 中       |
| `ListView`               | `CollectionView` のラッパー。移行が望ましい。[ListView から CollectionView へのガイド](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) を参照 | 中 |
| `MasterDetailPage`       | `FlyoutPage` に改名。XAML の更新が必要                                            | 低       |
| `Frame`                  | ソフト非推奨。`Border` と `StrokeShape` を使用                                   | 低       |
| `OpenGLView`             | 完全に削除                                                                       | 低       |
| Android `MainActivity`   | `MainActivity.cs` と `MainApplication.cs` に分離、どちらも partial                | 中       |
| iOS `AppDelegate`        | `FormsApplicationDelegate` を `MauiUIApplicationDelegate` に置換                  | 中       |
| `App.xaml.cs`            | `Application.MainPage` は MAUI 11 で動くが、Shell-first が新しいデフォルト       | 低       |
| ターゲティング           | `MonoAndroid12.0`、`Xamarin.iOS10` は消失。`net11.0-android35.0` のみ             | 高       |

アップストリームの upgrade assistant は `dotnet tool` として提供され、名前空間の書き換えとプロジェクトファイル変換のかなりの部分をカバーします。カスタムレンダラーと `DependencyService` の登録は扱えず、ここに実際の時間がかかります。

## プリフライトチェックリスト

1. .NET 11 SDK と MAUI ワークロードをインストールします。`dotnet workload list` で確認します。`maui`、`maui-android`、`maui-ios`、`maui-maccatalyst` がすべてバージョン `11.0.x` であることを確認します。

   ```bash
   # .NET 11.0
   dotnet workload install maui
   dotnet workload list
   ```

2. PR の途中で移行ブランチがサイレントに前進しないよう、`global.json` で SDK を固定します:

   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```

3. 現在の Xamarin.Forms ビルドをバージョン管理でタグ付けします。`git tag pre-maui-migration` で十分です。移行が 2 週目に脱線した場合に、きれいな復元ポイントが必要になります。
4. プラットフォームアセットのスナップショットを取ります。`Drawable*` フォルダー、`Assets.xcassets`、スプラッシュストーリーボード、Info.plist / AndroidManifest.xml のエントリを巡回します。Resizetizer はこのツリー全体を再編成するので、アセットが失われた場合に備えて「移行前」の在庫が必要です。
5. `DependencyService` の登録を棚卸しします。`grep -rn "DependencyService\\|Dependency(typeof" .` で完全なリストが返ります。それぞれが `services.AddSingleton` または `services.AddTransient` 呼び出しになります。
6. カスタムレンダラーを棚卸しします。`ExportRenderer` で grep し、それぞれを読みます。完全に削除できるもの (MAUI のデフォルトは Xamarin.Forms のデフォルトより優れています) もあれば、ハンドラーになるもの、`Behaviors` になるものもあります。
7. Xamarin.Forms ツリーで `dotnet test` を実行し、グリーンのベースラインを保存します。3 つのテストリグレッションを導入する移行は、すでに 5 つの flaky テストがあったコードベースに着地する移行よりはるかに診断が容易です。

## 移行ステップ

1. **まず共有プロジェクトで upgrade assistant を実行します。** csproj を SDK スタイルに書き換え、最も明白な名前空間 (`Xamarin.Forms` → `Microsoft.Maui.Controls`) を更新し、扱えなかったレンダラーや `DependencyService` のサイトを印付けます。

   ```bash
   # .NET 11
   dotnet tool install -g upgrade-assistant
   upgrade-assistant upgrade ./src/MyApp/MyApp.csproj --target-tfm net11.0
   ```

   検証: 新しい csproj で `dotnet restore` が成功し、`git status` が期待される書き換えを示します。head プロジェクトではまだ実行しないでください。これから削除する対象です。

2. **head プロジェクトを 1 つの SDK スタイル csproj に縮約します。** Xamarin.Forms は 1 つの共有プロジェクトと `MyApp.Android`、`MyApp.iOS`、オプションで `MyApp.UWP` の head プロジェクトとして出荷されます。MAUI はマルチターゲティング付きの 1 つの csproj として出荷されます。Android 固有のコードを `Platforms/Android/` 配下に、iOS 固有のコードを `Platforms/iOS/` 配下に移動し、head の csproj ファイルを削除します。新しい csproj のヘッダーはこうなります:

   ```xml
   <!-- src/MyApp/MyApp.csproj, .NET MAUI 11, net11.0 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFrameworks>net11.0-android35.0;net11.0-ios18.0;net11.0-maccatalyst18.0</TargetFrameworks>
       <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
       <OutputType>Exe</OutputType>
       <UseMaui>true</UseMaui>
       <SingleProject>true</SingleProject>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
       <RootNamespace>MyApp</RootNamespace>
       <ApplicationId>net.mycompany.myapp</ApplicationId>
       <ApplicationDisplayVersion>1.0</ApplicationDisplayVersion>
       <ApplicationVersion>1</ApplicationVersion>
     </PropertyGroup>
   </Project>
   ```

   検証: `dotnet build -t:Restore` が成功し、Visual Studio 2026 17.14 または Rider 2026.1 で「unsupported project type」警告なしにプロジェクトが読み込まれます。

3. **`App.xaml.cs` を `MauiProgram.CreateMauiApp` を使うように書き換えます。** Xamarin.Forms は `MainActivity.OnCreate` で `LoadApplication(new App())` を介して起動していました。MAUI はこれを `MauiAppBuilder` に渡します。エントリポイントはこうなります:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11, C# 14
   using Microsoft.Extensions.Logging;
   using Microsoft.Maui.Hosting;

   namespace MyApp;

   public static class MauiProgram
   {
       public static MauiApp CreateMauiApp()
       {
           var builder = MauiApp.CreateBuilder();
           builder
               .UseMauiApp<App>()
               .ConfigureFonts(fonts =>
               {
                   fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                   fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
               });

           builder.Services.AddSingleton<IAuthService, AuthService>();
           builder.Services.AddTransient<MainPageViewModel>();

           return builder.Build();
       }
   }
   ```

   検証: `dotnet build -f net11.0-android35.0` が 0 で終了し、IDE が任意のページコンストラクターから `MauiProgram` を解決します。

4. **すべての `DependencyService` 登録を `IServiceCollection` に変換します。** これは機械的ですが必須です。`DependencyService.Get<T>()` は MAUI 11 でなくなりました。置換:

   ```csharp
   // Before, Xamarin.Forms 5.0
   DependencyService.Register<IAuthService, AuthService>();
   var auth = DependencyService.Get<IAuthService>();

   // After, .NET MAUI 11
   // Registration moves to MauiProgram.CreateMauiApp (step 3).
   // Resolution moves to the constructor or to IPlatformApplication.Current.Services.
   public partial class MainPage : ContentPage
   {
       public MainPage(IAuthService auth) // injected
       {
           InitializeComponent();
       }
   }
   ```

   コンストラクターインジェクションが現実的でない場所 (静的ヘルパー、`AppShell` ハンドラー) では、`IPlatformApplication.Current!.Services.GetRequiredService<IAuthService>()` が脱出ハッチです。

   検証: `grep -rn "DependencyService" src/` がゼロヒットを返します。そうでなければ CI を失敗させます。

5. **カスタムレンダラーをハンドラーに置き換えます。** これが最も時間がかかるステップです。`OnElementPropertyChanged` をオーバーライドしていた Xamarin.Forms のカスタムレンダラーは、[`Mapper` ディクショナリを持つ MAUI ハンドラー](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) になります。例: Android の `Entry` から下線を取り除くレンダラー:

   ```csharp
   // .NET MAUI 11, C# 14
   // Platforms/Android/EntryHandlerCustomization.cs
   using Microsoft.Maui.Handlers;

   public static class EntryHandlerCustomization
   {
       public static void Apply()
       {
           EntryHandler.Mapper.AppendToMapping("NoUnderline", (handler, entry) =>
           {
               handler.PlatformView.BackgroundTintList =
                   Android.Content.Res.ColorStateList.ValueOf(
                       Android.Graphics.Color.Transparent);
           });
       }
   }
   ```

   カスタマイズを `MauiProgram.CreateMauiApp` で `builder.ConfigureMauiHandlers(...)` 経由で登録するか、`MauiProgram` の `partial void` から `Apply()` を呼び出して Android でのみ動くようにします。iOS では `Platforms/iOS/` 配下で同じパターンを維持します。

   検証: 古いレンダラーに依存していたすべてのページが `dotnet build -t:Run -f net11.0-android35.0` で正しくレンダリングされること。ビルド通過だけでなく視覚的なスモークテストです。

6. **`MessagingCenter` を CommunityToolkit messenger に切り替えます。** `MessagingCenter` は MAUI 11 で obsolete とマークされ、MAUI 12 で削除予定です。`CommunityToolkit.Mvvm` 8.4.0 以降を採用します:

   ```bash
   # .NET MAUI 11
   dotnet add package CommunityToolkit.Mvvm --version 8.4.0
   ```

   パターンの入れ替え:

   ```csharp
   // Before, Xamarin.Forms 5.0
   MessagingCenter.Subscribe<LoginViewModel>(this, "LoggedIn", _ => RefreshUi());
   MessagingCenter.Send(this, "LoggedIn");

   // After, .NET MAUI 11 with CommunityToolkit.Mvvm 8.4.0
   public sealed record LoggedInMessage;
   WeakReferenceMessenger.Default.Register<LoggedInMessage>(this, (r, m) => RefreshUi());
   WeakReferenceMessenger.Default.Send(new LoggedInMessage());
   ```

   `WeakReferenceMessenger` は、長時間動作する shell アプリで `MessagingCenter` がリークする原因となっていたライフタイムバグを回避します。

7. **アセットを Resizetizer に移します。** `Resources/drawable-*`、`Assets.xcassets`、重複したランチ画面を削除します。`Resources/AppIcon/` と `Resources/Splash/` 配下に 1 つの `appicon.svg` と 1 つの `splash.svg` を置きます。csproj は upgrade assistant が発行した `MauiIcon` と `MauiSplashScreen` のアイテムで既にこれらを認識しています。ビルド時リサイズが密度ラダー全体を置き換えます。

   ```xml
   <!-- src/MyApp/MyApp.csproj fragment -->
   <ItemGroup>
     <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
     <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
     <MauiImage Include="Resources\Images\*" />
     <MauiFont Include="Resources\Fonts\*" />
   </ItemGroup>
   ```

   検証: `dotnet build -f net11.0-android35.0` が手作業なしで `bin/Debug/net11.0-android35.0/Resources/drawable-xxhdpi/appicon.png` を生成します。

8. **Android の `MainActivity` と `MainApplication` を更新します。** Xamarin.Forms には `FormsAppCompatActivity` から派生した 1 つの `MainActivity` がありました。MAUI はこれを `MainActivity` と `MainApplication` に分けます:

   ```csharp
   // Platforms/Android/MainActivity.cs, .NET MAUI 11
   using Android.App;
   using Android.Content.PM;
   using Android.OS;

   namespace MyApp;

   [Activity(Theme = "@style/Maui.SplashTheme",
             MainLauncher = true,
             ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation |
                                    ConfigChanges.UiMode | ConfigChanges.ScreenLayout |
                                    ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity { }

   // Platforms/Android/MainApplication.cs, .NET MAUI 11
   [Application]
   public class MainApplication : MauiApplication
   {
       public MainApplication(IntPtr handle, Android.Runtime.JniHandleOwnership ownership)
           : base(handle, ownership) { }

       protected override MauiApp CreateMauiApp() => MyApp.MauiProgram.CreateMauiApp();
   }
   ```

   iOS では同等物は `MauiUIApplicationDelegate` から派生した 1 つの `AppDelegate` です。パターンは同一です: `CreateMauiApp` をオーバーライドし、共有 `MauiProgram` を呼び出します。

9. **XAML 名前空間を変換します。** すべての `xmlns="http://xamarin.com/schemas/2014/forms"` を `xmlns="http://schemas.microsoft.com/dotnet/2021/maui"` に変えます。upgrade assistant がほとんどを扱いますが、名前空間が混在するファイル (`xamarin.toolkit` を取り込んでいたカスタムコントロールライブラリ) は手動スイープが必要です。`Frame` はあと 1 リリースは動きますが、ビルド警告を出します。`Border` と `StrokeShape="RoundRectangle 12"` と `BackgroundColor` への置き換えを計画してください。`MasterDetailPage` は XAML とコードビハインドの両方で `FlyoutPage` に改名する必要があります。`x:TypeArguments` も含めて。

10. **`Application.Properties` から `Preferences` への監査を行います。** `Application.Current.Properties["key"] = value` に書き込んでいたコードは、`Microsoft.Maui.Storage` の `Preferences.Set("key", value)` に移す必要があります。形は似ていますが、ストレージバックエンドが異なるので、初回起動でワンショットのコピーが必要かもしれません。再実行されないよう `"migrated_to_preferences"` フラグでコピーを冪等にしてください。

11. **すべての NuGet 依存関係を MAUI 互換バージョンに固定します。** アップグレード後に `dotnet list package --vulnerable` と `dotnet list package --outdated` を実行します。よくある容疑者: `Xamarin.Essentials` (消失、MAUI に統合)、`Xamarin.Forms.Maps` (`Microsoft.Maui.Controls.Maps` に置換)、`Xamarin.Forms.Visual.Material` (MAUI の Material 3 スタイルに置換、[MAUI 10 の Material 3 に関する記事](/ja/2026/05/maui-10-material-3-android-usematerial3-flag/) を参照)。

## 検証

上記の手順の後:

- 移行ブランチのクリーンクローンで `dotnet restore` が 0 で終了します。
- `dotnet build -f net11.0-android35.0` と `-f net11.0-ios18.0` がどちらも 0 で終了します。
- `net11.0` にリターゲットされたユニットテストプロジェクトが `dotnet test` をクリーングリーンで実行します。
- `dotnet build -t:Run -f net11.0-android35.0` がエミュレーターでアプリを起動し、未処理例外なしに最初のページに到達します。
- Xamarin.Forms ツリーでカスタムレンダラーを含んでいたすべてのページの実機での手動スモークテスト。
- ランチャーのタップから最初のフレームまで、ストップウォッチでコールドスタート時間を移行前後で比較します。CoreCLR と AOT は 2024 年のミドルレンジ Android 端末で中規模アプリを 1 秒未満に押し込むはずです。リグレッションがあればステップ 5 を再確認してください。UI スレッドで同期的にレイアウト作業をするハンドラーが定番の犯人です。

## ロールバック計画

csproj を書き換えてしまうと自動ロールバックはありません。現実的な計画は:

1. プリフライトチェックリストの `pre-maui-migration` git タグを保持する。
2. 検証が Android と iOS の両方でグリーンになるまで、移行を独自ブランチに留める。
3. main にマージした後で revert する必要がある場合、安全な経路はマージコミットの `git revert` を実行し、その後 Xamarin.Forms ツリーをクリーンに復元して再デプロイすることです。SDK スタイルの csproj をレガシーの共有プロジェクトレイアウトに in-place で「ダウングレード」することはできません。

リリース枠が片道移行を許容しない場合は、MAUI ビルドを並列アプリケーション ID (`net.mycompany.myapp.maui`) としてストアに 1 サイクル公開し、プロダクションのトラフィックでクラッシュフリー率を 99.5 % 超に到達させてから、強制アップデートでバンドル ID を切り替えてください。

## 遭遇した落とし穴

- **Android のリソースシュリンキングがフォントを削り取ります。** Resizetizer のリネーム後、`Resources/Fonts/OpenSans-Regular.ttf` は `Resources/font/opensans_regular.ttf` 配下に落ち着きます。R8 のリソースシュリンカーは XAML からは未参照に見えるフォントを嬉々として除去します。`<MauiAsset Include="Resources/Fonts/**/*.ttf" />` を明示的に追加し、次のリリースまでシュリンキングを無効にすることで修正します: Debug でのみ `<AndroidLinkResources>false</AndroidLinkResources>`。
- **iOS `Info.plist` の `UIRequiredDeviceCapabilities` に `arm64` が必要です。** Mono から CoreCLR への切り替えは ARM64 バイナリのみを出荷します。`Info.plist` がまだ `armv7` を列挙していると、App Store Connect はアップロードを拒否します。
- **`OnPlatform` マークアップ拡張の `Default` の挙動が異なります**。Xamarin.Forms では未指定の `Default` がプラットフォーム値にフォールスルーしました。MAUI 11 ではマークアップ拡張形式で使用する際に `Default` を明示的に設定する必要があります。`Default` 値を追加するか、`<OnPlatform>` 要素形式に切り替えてください。
- **`Grid` 内の `Frame` が高さゼロに潰れます。** `Border` 置換は `Frame` のデフォルト `HorizontalOptions="Fill"` を継承しません。明示的に: `HorizontalOptions="Fill" VerticalOptions="Fill"`。
- **`Microsoft.Maui.Controls.Compatibility` は無料ではありません。** これは存在し、移行を完了させる間に頑固なレンダラーを 1 つや 2 つ生かしておくのに役立ちますが、`Compatibility` への参照それぞれがレガシーレンダラーチェーンをビルドに保持し、CoreCLR のコールドスタート向上の一部を打ち消します。橋として使い、目的地として使わないでください。

## 関連

- [高パフォーマンスな Xamarin.Forms ListView から MAUI CollectionView への移行](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)
- [.NET 8 から .NET 11 への移行: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [2026 年に .NET Framework 4.8 から .NET 11 へ移行する](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [2026 年における MAUI vs Avalonia vs Uno](/ja/2026/05/maui-vs-avalonia-vs-uno-in-2026/)
- [2026 年の新規モバイルプロジェクトのための Flutter vs React Native vs MAUI](/ja/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)

## ソース

- [.NET MAUI upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) MS Learn より。
- [.NET MAUI ハンドラードキュメント](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) レンダラー置換について。
- [.NET MAUI 11.0 リリースノート](https://github.com/dotnet/maui/releases) GitHub より。
- [`Microsoft.Maui.Storage.Preferences`](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences) `Application.Properties` の置換として。
- [CommunityToolkit.Mvvm messenger ガイド](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) `MessagingCenter` の置換として。
