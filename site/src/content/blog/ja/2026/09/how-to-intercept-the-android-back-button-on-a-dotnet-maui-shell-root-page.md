---
title: ".NET MAUI Shell のルートページで Android の戻るボタンをインターセプトする方法"
description: "ルートページで OnBackButtonPressed をオーバーライドし、.NET MAUI 10.0.101 以降を使います。ルートページが 10.0.70 (Android 16) と 10.0.100 (すべての Android バージョン) から戻る操作を受け取らなくなった理由、.NET 11 RC 1 がまだ影響を受ける理由、Shell.OnNavigating と BackButtonBehavior.Command が役に立たない理由、そして問題のあるバージョン向けの MainActivity での回避策を解説します。"
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "maui-shell"
  - "predictive-back"
  - "dotnet-10"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/how-to-intercept-the-android-back-button-on-a-dotnet-maui-shell-root-page"
translatedBy: "claude"
translationDate: 2026-09-13
---

**結論:** ルートの `ContentPage` (または `AppShell`) で `OnBackButtonPressed()` をオーバーライドし、`true` を返して戻る操作を握りつぶします。そのうえで **.NET MAUI 10.0.101** (2026-09-07 リリース) 以降を使ってください。10.0.70 から 10.0.100 まで、および .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`) では、このオーバーライドはルートページでは一度も呼ばれません。MAUI はポップするものがないと判断すると Android の戻るコールバックを無効にするため、Android はコードに問い合わせることなくユーザーをホーム画面へ送ってしまいます。Android 16 では 10.0.70 から、それ以外のすべての Android バージョンでは 10.0.100 からこの挙動が始まりました。アップグレードできない場合は、`MainActivity` で独自の `OnBackPressedCallback` を登録してください (コードは後述)。`ShellNavigationSource.Pop` を使った `Shell.OnNavigating` や `BackButtonBehavior.Command` では、10.0.101 であってもルートページでのハードウェアまたはジェスチャーによる戻る操作はインターセプトできません。

10.0.101 の修正は .NET 11 RC 1 には含まれていません。その後 `main` と `net11.0` ブランチには取り込まれている (SR10 のサービシングマージ [dotnet/maui#38301](https://github.com/dotnet/maui/pull/38301) 経由) ので、.NET 11 RC 2 で入る見込みです。

## ルートページが戻るボタンを受け取らなくなった理由

Android 16 は、API 36 をターゲットにするアプリで予測型の戻る操作をデフォルトで有効にします。予測型の戻る操作では、アプリが戻るイベントを必要としているかどうかを、システムが *ジェスチャーの開始前に* 判断します。有効なコールバックがなければ、ホームに戻るプレビューアニメーションを再生してタスクをバックグラウンドに移します。非推奨の `Activity.OnBackPressed()` は呼ばれず、`KeyEvent.KEYCODE_BACK` が `OnKeyDown` にディスパッチされることもありません。

.NET MAUI は以前、戻るコールバックを無条件に登録していたため、すべての MAUI アプリでこのアニメーションが動きませんでした ([dotnet/maui#34594](https://github.com/dotnet/maui/issues/34594))。その修正である [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223) は、これを AndroidX の `OnBackPressedCallback` に置き換え、その `Enabled` フラグをナビゲーションが変わるたびに MAUI が再計算するようにしました。`MauiAppCompatActivity` は、現在のページが戻る操作を消費できると `Window.CanConsumeBackNavigation` が判断した場合にだけコールバックを有効にします。

- モーダルページがスタックにある
- Shell セクションのナビゲーションスタックに 2 ページ以上ある
- `NavigationPage` に 2 ページ以上ある
- ユーザーが閉じられるフライアウトが開いている

普通のルート `ContentPage` はどれにも当てはまらないので、コールバックは無効になり、戻る操作はそのままシステムへ渡ります。`OnBackButtonPressed()` のオーバーライドは、一度も始まらないチェーン (`MauiOnBackPressedCallback` -> `AndroidLifecycle.OnBackPressed` -> `IWindow.BackButtonClicked()` -> `Shell.OnBackButtonPressed()` -> `Page.OnBackButtonPressed()`) の末尾にあるわけです。

では、なぜ Android 16 が先に壊れたのでしょうか。10.0.70 から 10.0.90 までは、`MauiAppCompatActivity` がまだ非推奨の `OnBackPressed()` をオーバーライドしており、そこから MAUI の戻る処理を無条件に実行していました。予測型の戻る操作を使わないデバイス (Android 15 以前。ただし `android:enableOnBackInvokedCallback="true"` でオプトインしている場合を除く) では、戻る操作がそのオーバーライド経由で届いていたので、ゲートは関係ありませんでした。10.0.100 でこのオーバーライドが削除され、すべてが `OnBackPressedDispatcher` に移ったため、ゲートがすべての Android バージョンに適用されるようになりました。issue のトリアージもこれと完全に一致します。[#37657](https://github.com/dotnet/maui/issues/37657) と [#38030](https://github.com/dotnet/maui/issues/38030) は Android 16 について `regressed-in-10.0.70` のラベルが付いており、[#37706](https://github.com/dotnet/maui/issues/37706) は 10.0.100 から Android 15 と 17 で失敗すると報告しています。

## 10.0.101 で何が変わったか (実測)

[dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) (バックポートは [#37729](https://github.com/dotnet/maui/pull/37729)) は、`CanConsumeBackNavigation` の先頭にチェックを 1 つ追加します。ページで実際に使われる `OnBackButtonPressed` が `Microsoft.Maui.Controls` 以外のアセンブリで宣言されていれば、コールバックが有効になります。MAUI はデリゲートの `MethodInfo.DeclaringType` からオーバーライドを検出するので、コードを呼び出すことはありません。結果はページインスタンスごとにキャッシュされます。

PR の説明を信じるのではなく判定そのものを見たかったので、.NET 10 のファイルベースアプリから内部メソッド `Window.CanConsumeBackNavigation(Page)` をリフレクションで呼び出しました。`Microsoft.Maui.Controls` の素の `net10.0` ビルドを使うため、エミュレーターは不要です。

```csharp
// probe.cs -- dotnet run probe.cs (SDK 10.0.302; net11.0 + SDK 11.0.100-rc.1 for the RC 1 run)
#:package Microsoft.Maui.Controls@10.0.101
#:property PublishAot=false
#:property TargetFramework=net10.0
using System.Reflection;
using Microsoft.Maui.Controls;

var canConsume = typeof(Window).GetMethod("CanConsumeBackNavigation",
    BindingFlags.NonPublic | BindingFlags.Static)!;
bool Check(Page p) => (bool)canConsume.Invoke(null, [p])!;

Console.WriteLine($"root page with override        -> {Check(new OverridePage())}");
Console.WriteLine($"Shell override, plain root     -> {Check(MakeShell(new OverrideShell(), new PlainPage()))}");
Console.WriteLine($"Shell OnNavigating only        -> {Check(MakeShell(new NavigatingShell(), new PlainPage()))}");
// ...plus a plain Shell + plain root, and a root with a BackButtonBehavior.Command

static Shell MakeShell(Shell shell, ContentPage root)
{
    shell.Items.Add(new ShellContent { Content = root });
    return shell;
}

class PlainPage : ContentPage { }
class OverridePage : ContentPage { protected override bool OnBackButtonPressed() => true; }
class OverrideShell : Shell { protected override bool OnBackButtonPressed() => true; }
class NavigatingShell : Shell
{
    protected override void OnNavigating(ShellNavigatingEventArgs args)
    {
        base.OnNavigating(args);
        if (args.Source == ShellNavigationSource.Pop) args.Cancel();
    }
}
```

`True` は、そのルートページで MAUI がコールバックを有効にし、コードが実行されることを意味します。`False` は、Android が問い合わせることなくアプリをバックグラウンドに移すことを意味します。

| ルートページの構成 | 10.0.90 | 10.0.101 | 11.0.0-rc.1.26451.6 |
|---|---|---|---|
| 普通の `ContentPage`、オーバーライドなし | False | False | False |
| `OnBackButtonPressed` をオーバーライドした `ContentPage` | False | **True** | False |
| `OnBackButtonPressed` をオーバーライドした `AppShell`、普通のルート | False | **True** | False |
| 普通の `Shell`、ルートページで `OnBackButtonPressed` をオーバーライド | False | **True** | False |
| `OnNavigating` だけをオーバーライドした `AppShell` (`Pop` をキャンセル) | False | False | False |
| `Shell.BackButtonBehavior` の `Command` を持つルートページ | False | False | False |

このプローブが測っているのはゲートであり、デバイスでの実行ではありません。デバイス上の結果については、#37709 に Android 16 エミュレーターでの検証が含まれています。MAUI チームも #37657 の Shell タブの再現手順で修正を確認しており、#37706 の報告者は PR ビルドで自分の NavigationPage アプリが直ったことを確認しています。

## 手順: ルートページで戻る操作をインターセプトする

1. **MAUI のバージョンを確認します。** `.csproj` の `Microsoft.Maui.Controls` パッケージを確認するか、`dotnet list package` を実行してください。10.0.70 から 10.0.100 のいずれかに解決されている場合は、10.0.101 以降に上げます。.NET 11 RC 1 では、RC 2 が出るまで手順 4 の回避策を使ってください。

   ```xml
   <!-- .NET MAUI 10, MyApp.csproj -->
   <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.101" />
   ```

2. **必要なページで `OnBackButtonPressed` をオーバーライドします。** このメソッドは同期的なので、すぐに `true` を返し、確認ダイアログは次のディスパッチャーティックで表示します。オーバーライドを `async` にしてはいけません。`async` のオーバーライドは最初の `await` の時点で、ユーザーが答える前に `false` を返してしまいます。

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- MainPage.xaml.cs (a Shell root page)
   public partial class MainPage : ContentPage
   {
       bool _confirming;

       protected override bool OnBackButtonPressed()
       {
           if (_confirming)
               return true;

           _confirming = true;
           Dispatcher.Dispatch(async () =>
           {
               try
               {
                   bool leave = await DisplayAlertAsync(
                       "Leave the app?", "Unsaved changes will be lost.", "Leave", "Stay");
                   if (leave)
                       LeaveApp();
               }
               finally
               {
                   _confirming = false;
               }
           });
           return true; // swallow this press; the dialog decides what happens next
       }

       static void LeaveApp()
       {
   #if ANDROID
           // Same as Android's own root back since Android 12: background the task, keep the process.
           Platform.CurrentActivity?.MoveTaskToBack(true);
   #endif
       }
   }
   ```

   `MoveTaskToBack(true)` は意図的な選択です。Android の `Application.Current.Quit()` は `FinishAndRemoveTask()` を呼んだあと `Environment.Exit(0)` を呼ぶため、プロセスが終了し、次回起動時に Android が本来与えてくれるウォームスタートが失われます。

3. **タブ単位のルールには、代わりに `AppShell` でオーバーライドします。** よくある要件は "どのタブでもルートで戻ると最初のタブに戻り、最初のタブでだけアプリを離れる" というものです。これはすべてのルートページを見渡せる Shell に置くべき処理です。

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- AppShell.xaml.cs
   public partial class AppShell : Shell
   {
       protected override bool OnBackButtonPressed()
       {
           var section = CurrentItem?.CurrentItem;
           bool atTabRoot = section is not null && section.Stack.Count <= 1;

           if (atTabRoot && CurrentItem is TabBar tabs && tabs.CurrentItem != tabs.Items[0])
           {
               tabs.CurrentItem = tabs.Items[0];
               return true;
           }

           return base.OnBackButtonPressed(); // pops pages, then raises Navigating(Pop)
       }
   }
   ```

   `base.OnBackButtonPressed()` を返すと、Shell の通常の動作が保たれます。表示中のページの `OnBackButtonPressed` を呼び、ポップできるものがあればセクションのスタックをポップし、なければ `ShellNavigationSource.Pop` 付きで `Navigating` を発生させて `args.Cancelled` を返します。つまり、何らかのオーバーライドがコールバックを有効にしていれば、ドキュメントにある `OnNavigating` のキャンセルパターンもルートページで *実際に* 機能します。それ単体では一度も実行されません。

4. **10.0.70 から 10.0.100、または .NET 11 RC 1 では、`MainActivity` に独自のコールバックを追加します。** AndroidX のディスパッチャーは、最後に追加された有効なコールバックから順に呼び出します。そのため `base.OnCreate` のあとに追加したコールバックは、MAUI 自身のコールバックが無効になっている場合も含めて、MAUI のものより先に実行されます。

   ```csharp
   // .NET MAUI 10.0.70-10.0.100 and 11.0.0-rc.1 only -- Platforms/Android/MainActivity.cs
   using Android.App;
   using Android.Content.PM;
   using Android.OS;
   using AndroidX.Activity;

   [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
       ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                              ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity
   {
       protected override void OnCreate(Bundle? savedInstanceState)
       {
           base.OnCreate(savedInstanceState);
           OnBackPressedDispatcher.AddCallback(this, new RootBackCallback(this));
       }

       sealed class RootBackCallback(MainActivity activity) : OnBackPressedCallback(true)
       {
           public override void HandleOnBackPressed()
           {
               // Runs the same chain MAUI would: modal stack, Shell, then the visible page.
               var window = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()
                   as Microsoft.Maui.IWindow;
               if (window?.BackButtonClicked() == true)
                   return;

               // Nothing consumed it: step aside and let the system (or MAUI) handle this press.
               Enabled = false;
               try { activity.OnBackPressedDispatcher.OnBackPressed(); }
               finally { Enabled = true; }
           }
       }
   }
   ```

   これは互換性のためのシムであり、残しておくべきパターンではありません。コールバックが常に有効なので、ホームに戻るアニメーションは一切再生されません。また、MAUI 自身のコールバックも有効 (たとえばフライアウトが開いている) で、どのページも戻る操作を処理しなかった場合、オーバーライドが 2 回実行されます。10.0.101 に移行したらシムは削除してください。10.0.101 で残したままにすると、オーバーライドしているページで処理されなかった戻る操作がすべて `OnBackButtonPressed` を 2 回通ることになります。[#37657](https://github.com/dotnet/maui/issues/37657) には、非推奨の `Activity.OnBackPressed()` に再入するもっと短い変種があります。上のバージョンは、新しいコードから非推奨 API を呼ぶことを避けています。

5. **実機の Android 16 デバイスか API 36 エミュレーターで確認します。** ジェスチャーナビゲーションと 3 ボタンナビゲーションの両方を使ってください。メソッドをオーバーライドしたルートページで端からスワイプして止めると、ホームに戻るプレビューは表示されず、指を離すとハンドラーが実行されるはずです。オーバーライドのないルートページでは、引き続きプレビューアニメーションが表示されるはずです。これで、アプリ全体で予測型の戻る操作を無効にしていないことがわかります。

## 動きそうに見えて動かないもの

**`BackButtonBehavior.Command` は Android のハードウェア戻るボタンのハンドラーではありません。** `Shell.OnBackButtonPressed` がコマンドを実行するのは `#if WINDOWS || !PLATFORM` の下だけです。Android では、コマンドは `ShellToolbarTracker.OnClick`、つまりナビゲーションバーの矢印から実行されます。ルートページには戻る矢印がない (フライアウト Shell ではその位置はハンバーガーメニューになる) ので、ルートページではこのコマンドは無関係です。プローブでも、コールバックを有効にしないことが確認できます。

**ライフサイクルイベントではゲートは開きません。** `builder.ConfigureLifecycleEvents(e => e.AddAndroid(a => a.OnBackPressed(...)))` は `AndroidLifecycle.OnBackPressed` のデリゲートをもう 1 つ登録します。ゲートは *何らかの* デリゲートが存在するかどうかしか確認せず、MAUI は常に自身の `HandleWindowBackButtonPressed` を登録するので、あなたのデリゲートは何も変えません。ページが戻る操作を消費できない場合、コールバックは無効のままで、デリゲートは一度も実行されません。

**`MainActivity` での `OnKeyDown(Keycode.Back, ...)` と `OnBackPressed()` のオーバーライドは、Android 16 ではデッドコードです。** Google の予測型の戻る操作のガイドは、`KEYCODE_BACK` から戻るイベントをインターセプトすることは "もうサポートされていない" と明記しています。[.NET MAUI から Android API レベル 36 をターゲットにする](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) の移行チェックリストでは、ターゲット 36 で沈黙するほかのオーバーライドも扱っています。

**オーバーライドするたびに、そのページではホームに戻るアニメーションが失われます。** MAUI はオーバーライドが返す値ではなく、型で判断します。ページが `OnBackButtonPressed` を宣言した時点で、たとえメソッドが `base.OnBackButtonPressed()` を返すだけでも、そのページではコールバックが有効になります。`Microsoft.Maui.Controls` の外にある基底クラスから継承したオーバーライドも同じなので、オーバーライドを持つ共通の `BasePage` はすべての派生ページをオプトインさせ、`AppShell` でのオーバーライドはすべてのページをオプトインさせます。Android のガイダンスでは、戻るコールバックを有効にするのは UI ロジック (未保存の変更の確認や、ページ内ポップアップを閉じるなど) のためだけにし、ログ出力や分析のためには決して使わないよう求めています。オーバーライドは、それを必要とする最も狭いページに置いてください。

**`android:enableOnBackInvokedCallback="false"` は修正になりません。** これは予測型の戻る操作のアニメーションを無効にし、`OnBackInvokedCallback` を機能しなくします。MAUI が使っている `OnBackPressedCallback` の呼び出しは引き続き機能します。10.0.70 から 10.0.90 では、たまたま Android 16 の戻る操作が再びレガシーな経路を通るようになります。10.0.100 ではレガシーなオーバーライドが残っていないので、ルートページのゲートについては何も変わりません。

**モーダルページは一度も影響を受けていません。** 空でないモーダルスタックは常にコールバックを有効にします。そのため、モーダルページでの `protected override bool OnBackButtonPressed() => true;` はこの間ずっと機能し続けていました。[.NET MAUI 11 でモーダルウィンドウを表示する](/ja/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/) を参照してください。

**オーバーライドから fire-and-forget をしてはいけません。** `true` を返してからダイアログを待機するのが安全なのは、`Dispatcher.Dispatch` がラムダを UI スレッドで実行するからです。例外を投げる `async void` ヘルパーは、それでもプロセスを落とします。[MAUI Android アプリで ANR を引き起こしている `async void` ハンドラーを見つける](/ja/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) で、その追跡方法を紹介しています。

## 関連記事

- データを伴う戻るナビゲーション (`..?saved=true`) と、.NET MAUI 11 の `AccessibilityLabel` を含む `BackButtonBehavior` のプロパティについては、[.NET MAUI 11 の Shell ルートパラメーターとクエリプロパティ](/ja/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/) で扱っています。
- API 36 移行における予測型の戻る操作の手順と、ホームに戻るアニメーションを復活させた 10.0.90 の修正は、[MAUI の Android アプリを API レベル 36 ターゲットに移行する](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) にあります。
- モーダルページで戻る操作を握りつぶす方法と、モーダルがモーダルウィンドウではない理由は、[.NET MAUI 11 でモーダルウィンドウを表示する方法](/ja/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/) にあります。
- 手順 2 のディスパッチャーパターンは、[ANR を引き起こす `async void` ハンドラーを見つける](/ja/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) で分析した fire-and-forget コードの安全な形です。

## 出典

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation) (Microsoft Learn: `BackButtonBehavior`、`Navigating`、`ShellNavigationSource.Pop`、ナビゲーションの遅延)
- [Add support for the predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture) (Android Developers: コールバックがアニメーションを無効にする条件、`KEYCODE_BACK`、`enableOnBackInvokedCallback`)
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223): ホームに戻るアニメーションのためのゲート付き `OnBackPressedCallback`
- [dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) と 10.0.101 へのバックポート [#37729](https://github.com/dotnet/maui/pull/37729): ルートページでの `OnBackButtonPressed`
- リグレッションの報告: [#37657](https://github.com/dotnet/maui/issues/37657) (Shell タブ)、[#37706](https://github.com/dotnet/maui/issues/37706) (ルート `ContentPage`)、[#38030](https://github.com/dotnet/maui/issues/38030) (`FlyoutPage`)
- リリースタグ時点のソース: [10.0.101 の `Window.cs`](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Window/Window.cs)、[10.0.101 の `MauiAppCompatActivity.cs`](https://github.com/dotnet/maui/blob/10.0.101/src/Core/src/Platform/Android/MauiAppCompatActivity.cs)、[10.0.101 の `Shell.cs`](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Shell/Shell.cs)、[11.0.100-rc.1.26458.5 の `Window.cs`](https://github.com/dotnet/maui/blob/11.0.100-rc.1.26458.5/src/Controls/src/Core/Window/Window.cs)
