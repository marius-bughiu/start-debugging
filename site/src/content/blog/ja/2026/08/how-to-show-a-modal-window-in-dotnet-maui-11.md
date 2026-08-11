---
title: ".NET MAUI 11 でモーダルウィンドウを表示する方法"
description: ".NET MAUI 11 では、まったく異なる2つのものが「モーダルウィンドウ」と呼ばれています。PushModalAsync は全プラットフォームでモーダルページを提供します。オーナーウィンドウを無効化する本物の OS ウィンドウには MAUI の API がまったく存在しないため、Windows で実際に動作する WinUI の OverlappedPresenter.IsModal と Win32 のオーナーハンドルによる相互運用、そして Mac Catalyst での代替手段を解説します。"
pubDate: 2026-08-11
template: how-to
tags:
  - "dotnet-maui"
  - "dotnet"
  - "csharp"
  - "windows"
  - "winui"
  - "navigation"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-show-a-modal-window-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-08-11
---

これを検索してたどり着いたなら、おそらくまったく異なる2つのうちどちらかを指しているはずで、.NET MAUI はその2つをかなり違う扱いにしています。**モーダルページ**（背後の要素との操作を、閉じられるまでブロックする全画面ページ）は第一級のクロスプラットフォーム機能であり、`Navigation.PushModalAsync` がそれにあたります。一方、デスクトップの意味での**モーダルウィンドウ**（WPF の `ShowDialog` のように、処理が終わるまでオーナーウィンドウを暗くして無効化する、2つめのトップレベルウィンドウ）には MAUI の API がまったくありません。.NET MAUI 11 にも、それ以前のどのバージョンにも存在しません。`Application.Current.OpenWindow` が開くのは*モードレス*な2つめのウィンドウです。Windows で本物のモーダル性を得るには、handler を経由して WinUI の `AppWindow` まで降り、Win32 の呼び出しでオーナーを設定し、`OverlappedPresenter.IsModal` を有効にします。Mac Catalyst に相当する仕組みはないため、そこではモーダルページを使ってください。

.NET MAUI 11 は2026年8月時点で NuGet 上の `11.0.0-preview.6.26360.8` であり、API の形はまだ動いています。以下のスニペットはすべて、.NET SDK 10.0.201 上の安定版 .NET MAUI 10.0.20 ワークロードに対して、`net10.0-windows10.0.19041.0` をターゲットにコンパイルして確認しています。MAUI 11 のプレビューはこれらのメンバーをそのまま引き継いでいます。知っておくべき唯一の名称変更は MAUI 10 で入ったもので、後半で扱います。

## どちらの「モーダル」が必要なのか

| 必要なもの | 使う API | 動作する環境 |
| --- | --- | --- |
| アプリを覆い、ナビゲーションで離脱できないページ | `Navigation.PushModalAsync` | Android、iOS、Mac Catalyst、Windows |
| はい／いいえの質問、または単一のテキスト入力 | `DisplayAlertAsync`、`DisplayPromptAsync` | すべて |
| 現在のページの上に重なる、画面より小さいオーバーレイ | Community Toolkit の `ShowPopupAsync` | すべて |
| オーナーウィンドウを無効化する独立した OS ウィンドウ | MAUI の API はなし。WinUI と Win32 の相互運用 | Windows のみ |

4行目がデスクトップに関する問いへの正直な答えであり、この要望が2022年から MAUI のリポジトリで open のままである理由でもあります。それ以外は解決済みの問題です。

## モーダルページと `PushAsync` の違い

モーダルナビゲーションは、階層ナビゲーションとは別のスタックを使います。`Navigation` は両方を公開しており、モーダル側は意図的に小さくなっています。

```csharp
// .NET MAUI 10.0.20 / 11.0 preview
async void OnOpenModalClicked(object sender, EventArgs e)
{
    await Navigation.PushModalAsync(new ConfirmPage());
}

async void OnCloseModalClicked(object sender, EventArgs e)
{
    await Navigation.PopModalAsync();
}
```

モーダルスタックには `PopModalToRootAsync` も `InsertPageBefore` も `RemovePage` もありません。これらの操作が基盤プラットフォーム全体で一様にサポートされていないためです。参照用の `ModalStack` があるだけです。またモーダル push に `NavigationPage` は不要で、これは Shell アプリで効いてきます。`NavigationPage` は Shell の中で使うと例外を投げますが、モーダルナビゲーションはそこでも問題なく動きます。すでに Shell でルーティングしているなら、状態を動かすためにモーダルページへ手を伸ばす前に、[Shell のルートパラメーターとクエリプロパティでデータを渡す方法](/ja/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)の詳細を確認してください。

`Window` クラスは `ModalPushing`、`ModalPushed`、`ModalPopping`、`ModalPopped`、`PopCanceled` を発行します。これがページ自体の外側からモーダルスタックを観測する手段です。`ModalPoppingEventArgs` は `Cancel` フラグを持つので、「本当に破棄してよいですか」を挟む場所にもなります。

```csharp
// .NET MAUI 10.0.20: veto a modal dismissal from the Window
Window.ModalPopping += (s, e) =>
{
    if (HasUnsavedChanges(e.Modal))
        e.Cancel = true;
};
```

## モーダルページから結果を受け取る

`PushModalAsync` が返す `Task` は、ユーザーの操作が終わったときではなく、push のアニメーションが終わった時点で完了します。ここでほぼ全員が最初につまずきます。定石は、モーダルページ側に `TaskCompletionSource<T>` を置くことです。

```csharp
// .NET MAUI 10.0.20, C# 14
public sealed class ConfirmPage : ContentPage
{
    readonly TaskCompletionSource<bool> _tcs = new();

    public Task<bool> Result => _tcs.Task;

    public ConfirmPage()
    {
        var ok = new Button { Text = "OK" };
        ok.Clicked += async (s, e) =>
        {
            _tcs.TrySetResult(true);
            await Navigation.PopModalAsync();
        };
        Content = ok;
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        // Covers swipe-to-dismiss on iOS and the Android back button.
        _tcs.TrySetResult(false);
    }
}
```

呼び出し側は次のようになります。

```csharp
var confirm = new ConfirmPage();
await Navigation.PushModalAsync(confirm);
bool accepted = await confirm.Result;
```

ここで `SetResult` ではなく `TrySetResult` を使うのは、防御的な冗長さではありません。`OnDisappearing` はボタンのハンドラーが結果を設定した後に実際に走るため、`SetResult` では2回目の呼び出しで `InvalidOperationException` が飛びます。

## ページを本当に回避不能にする

Android では、ハードウェアまたはジェスチャーの戻る操作が、こちらの意図と無関係にモーダルスタックを pop します。モーダルページで `OnBackButtonPressed` をオーバーライドし、`true` を返して飲み込んでください。

```csharp
protected override bool OnBackButtonPressed() => true;
```

iOS では、シート形式のモーダルは下方向のスワイプで閉じられます。これはプレゼンテーションスタイルの話で、次で扱います。

## iOS と Mac Catalyst での見た目を制御する

既定ではモーダルページは全画面で表示されます。iOS の platform-specific がこれを変更します。Catalyst は UIKit のプレゼンテーション機構をそのまま動かすため、これは Mac Catalyst にも効く数少ないつまみのひとつです。

```xaml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:ios="clr-namespace:Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;assembly=Microsoft.Maui.Controls"
             x:Class="MyApp.ConfirmPage"
             ios:Page.ModalPresentationStyle="FormSheet">
</ContentPage>
```

コードからは次のように書きます。

```csharp
using Microsoft.Maui.Controls.PlatformConfiguration;
using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;
using Page = Microsoft.Maui.Controls.Page; // see the gotcha below

On<iOS>().SetModalPresentationStyle(UIModalPresentationStyle.FormSheet);
```

`UIModalPresentationStyle` には `FullScreen`、`FormSheet`、`PageSheet`、`OverFullScreen`、`Automatic` があり、.NET MAUI 10 以降は `Popover` も加わりました。`FormSheet` は Mac Catalyst で得られる中ではデスクトップのダイアログに最も近く、アプリのウィンドウ上に中央寄せで画面より小さいパネルとして出ます。モーダルページの背景を透過または半透明にしたい場合は `OverFullScreen` を選びます。

## Windows で本物のモーダルウィンドウを表示する手順

こちらがデスクトップのケースです。独自のタイトルバーを持つ本当に独立したウィンドウで、開いた元のウィンドウを無効化します。

1. `Window` を作成し、`Application.Current.OpenWindow` で開きます。この時点ではウィンドウに handler もプラットフォームビューもないため、まだ何も設定できません。
2. handler を待ちます。開く前に新しい `Window` の `HandlerChanged` を購読するか、すでに割り当てられている場合に備えて先に `Handler` を確認します。ここから先はすべて `#if WINDOWS` ブロックの中に入ります。
3. プラットフォームビューを `MauiWinUIWindow` にキャストし、その `AppWindow` プロパティを読みます。これが表示を司る Windows App SDK のオブジェクトです。
4. オーナーを設定します。オーナーウィンドウの HWND を渡して `SetWindowLongPtr` を `GWLP_HWNDPARENT`（`-8`）で呼び出します。ここを飛ばすのが圧倒的に多い失敗です。
5. `OverlappedPresenter` を適用し、`IsModal` を `true` にします。最小化なし、最大化なし、サイズ変更なしというダイアログの既定値には `OverlappedPresenter.CreateForDialog()` を使います。
6. モーダルウィンドウが閉じたらオーナーウィンドウを再アクティブ化します。MAUI の `Window` の `Destroying` を処理し、オーナーに対して `Activate` を呼びます。そうしないとフォーカスが別のアプリケーションへ移ります。

## Windows の相互運用コード全体

```csharp
// ModalWindowService.cs
// Verified against .NET MAUI 10.0.20 / .NET SDK 10.0.201, net10.0-windows10.0.19041.0
#if WINDOWS
using System.Runtime.InteropServices;
using Microsoft.Maui.Platform;   // MauiWinUIWindow
using Microsoft.UI.Windowing;    // AppWindow, OverlappedPresenter
using WinRT.Interop;             // WindowNative
#endif

namespace MyApp;

public static partial class ModalWindowService
{
    public static void ShowModal(Window owner, Page content, string title)
    {
        var modal = new Window(content) { Title = title, Width = 520, Height = 360 };

#if WINDOWS
        WhenHandlerReady(modal, () => MakeModal(modal, owner));
        modal.Destroying += (s, e) => Application.Current?.ActivateWindow(owner);
#endif

        Application.Current?.OpenWindow(modal);
    }

    static void WhenHandlerReady(Window window, Action action)
    {
        if (window.Handler?.PlatformView is not null)
        {
            action();
            return;
        }

        void OnChanged(object? sender, EventArgs e)
        {
            window.HandlerChanged -= OnChanged;
            if (window.Handler?.PlatformView is not null)
                action();
        }

        window.HandlerChanged += OnChanged;
    }

#if WINDOWS
    const int GWLP_HWNDPARENT = -8;

    static void MakeModal(Window modal, Window owner)
    {
        var nativeModal = (MauiWinUIWindow)modal.Handler!.PlatformView!;
        var nativeOwner = (MauiWinUIWindow)owner.Handler!.PlatformView!;

        nint modalHwnd = WindowNative.GetWindowHandle(nativeModal);
        nint ownerHwnd = WindowNative.GetWindowHandle(nativeOwner);

        // Ownership must be established before IsModal is set.
        SetWindowLongPtr(modalHwnd, GWLP_HWNDPARENT, ownerHwnd);

        AppWindow appWindow = nativeModal.AppWindow;
        var presenter = OverlappedPresenter.CreateForDialog();
        appWindow.SetPresenter(presenter);
        presenter.IsModal = true;
    }

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static partial nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);
#endif
}
```

実際の仕事をしているのは `IsModal` です。Windows App SDK はこのプロパティを、オーナーウィンドウより優先され、モーダルウィンドウが閉じられるかモーダルでなくなるまでオーナーへの入力をすべてブロックするもの、と説明しています。`IsModal` を設定したあとに `EnableWindow(ownerHwnd, false)` を別途呼ぶ必要はなく、追加すると無効化されたオーナーウィンドウが残り、あとで手作業で有効化し直すことになります。

`OverlappedPresenter.CreateForDialog()` はダイアログ向けの値をあらかじめ設定するため、`IsMinimizable`、`IsMaximizable`、`IsResizable` を個別にオフにする必要はありません。たまたまモーダルであるだけの通常のウィンドウが欲しい場合は `OverlappedPresenter.Create()` を使います。なお .NET MAUI 10 では、クロスプラットフォームの `Window` に `Window.IsMinimizable` と `Window.IsMaximizable` がバインド可能プロパティとして追加されたため、この2つのつまみに関してはもう相互運用は不要です。

## 実際に時間を溶かす落とし穴

**オーナーなしの `IsModal` は例外を投げます。** オーナーのないウィンドウに `IsModal = true` を設定すると `System.ArgumentException: Value does not fall within the expected range.` が発生します。これは Windows App SDK のリポジトリで報告されており、手順4が存在する理由でもあります。あるコードパスでは動くのに別のパスでは失敗する場合、渡したオーナーの HWND がゼロでなかったか確認してください。

**`OpenWindow` の直後は `Handler` が null です。** MAUI はプラットフォームウィンドウを非同期に生成します。`OpenWindow` の次の行で `window.Handler.PlatformView` を読むと `NullReferenceException` になります。上の `WhenHandlerReady` ヘルパーはまさにこのために存在し、`OpenWindow` の呼び出し*前*に `HandlerChanged` を購読することで信頼できるものになります。

**`[LibraryImport]` は `partial` な型を必要とします。** P/Invoke をふつうの `static class` に貼り付けると `SYSLIB1050: Method 'SetWindowLongPtr' is contained in a type 'ModalWindowService' that is not marked 'partial'` が出て、続けて `CS8795` と `CS0751` が出ます。クラスに `partial` を付けてください。古い `[DllImport]` 属性にはこの要件はありませんが、トリミングや Native AOT のビルドではソースジェネレーターによる相互運用のほうが適切です。

**iOS の platform-specific 名前空間が `Page` を隠します。** `Microsoft.Maui.Controls` も使っているファイルに `using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;` を足すと `CS0104: 'Page' is an ambiguous reference between 'Microsoft.Maui.Controls.Page' and 'Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page'` が出ます。`using Page = Microsoft.Maui.Controls.Page;` を追加するか、完全修飾してください。

**`DisplayAlert` は .NET MAUI 10 で改名されました。** `Page` のポップアップ系メソッドは現在 `DisplayAlertAsync`、`DisplayActionSheetAsync`、`DisplayPromptAsync` です。`DisplayPromptAsync` はもともとその名前だったため変わっていません。MAUI 8 や 9 のコードベースを移行する場合、これは静かにビルドを壊す原因になります。

**マルチウィンドウにはプラットフォームごとの設定が必要で、iPhone では決して動きません。** モードレスな `OpenWindow` の経路でさえ、Android では `MainActivity` に `LaunchMode.Multiple` が必要で、iPadOS と Mac Catalyst では `SceneDelegate` クラスと `Info.plist` の `UIApplicationSceneManifest` エントリが必要です。Windows では何も要りません。iPhone 上の iOS ではそもそも不可能です。どのみちデスクトップ専用のアプリなら、[MAUI プロジェクトを Windows と Mac Catalyst だけに絞る](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)ことで、この設定面の大半を取り除けます。

**Mac Catalyst に `IsModal` 相当はありません。** Catalyst に `OverlappedPresenter` の類似物は存在せず、MAUI は `beginSheet` を公開していません。Catalyst では `FormSheet` でモーダルページを表示し、その範囲がアプリ全体ではなくウィンドウ単位であることを受け入れてください。すべてのデスクトッププラットフォームでアプリ単位の本物のモーダルウィンドウが厳しい製品要件であるなら、それは[MAUI が Avalonia や Uno に劣る](/ja/2026/05/maui-vs-avalonia-vs-uno-in-2026/)具体的なケースのひとつです。

## popup のほうが適している場合

本当に欲しいものが、画面より小さく現在のページの上に浮かぶオーバーレイであるなら、モーダルページも2つめのウィンドウも正解ではありません。.NET MAUI Community Toolkit（2026年8月時点で 15.0.0）には `ShowPopupAsync`、型付き結果のための `Popup<T>`、ビューモデル駆動で表示するための `IPopupService` があります。`CanBeDismissedByTappingOutsideOfPopup` を `false` にすれば、上記の相互運用をいっさい使わずにブロッキングなオーバーレイが手に入ります。知っておくとよいのは、toolkit の popup が `ContentPage` のオーバーレイとして実装されている点です。そのため呼び出し元のページには引き続き `OnNavigatingFrom`、`OnDisappearing`、`OnNavigatedFrom` が届きます。これらのイベントを「ユーザーがこの画面を離れた」という意味で使っていたなら、popup でも同じように発火します。

習慣ではなくスコープで選んでください。1つのウィンドウの中で1つのタスクをブロックするならモーダルページです。Windows でアプリ全体をブロックするなら上の相互運用です。それ以外はすべて popup です。

## 関連記事

- [.NET MAUI 11 で Shell のルートパラメーターとクエリプロパティを使ってナビゲーションする方法](/ja/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)
- [Windows と macOS だけで動く MAUI アプリを書く方法（モバイルなし）](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)
- [.NET MAUI 11 でドラッグアンドドロップを実装する方法](/ja/2026/05/how-to-implement-drag-and-drop-in-maui-11/)
- [.NET MAUI アプリでダークモードを正しくサポートする方法](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)
- [MAUI と Avalonia と Uno Platform：2026年にどれを選ぶべきか](/ja/2026/05/maui-vs-avalonia-vs-uno-in-2026/)

## 参考資料

- [Window - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/window?view=net-maui-11.0)
- [NavigationPage, Perform modal navigation - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pages/navigationpage?view=net-maui-11.0)
- [Display pop-ups - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pop-ups?view=net-maui-11.0)
- [Modal page presentation style on iOS - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/ios/platform-specifics/page-presentation-style?view=net-maui-11.0)
- [OverlappedPresenter.IsModal Property, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter.ismodal)
- [OverlappedPresenter Class, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter)
- [microsoft/WindowsAppSDK#3258, ArgumentException when OverlappedPresenter.IsModal is set to true](https://github.com/microsoft/WindowsAppSDK/issues/3258)
- [microsoft/WindowsAppSDK discussion #4435, on the issue of modal windows](https://github.com/microsoft/WindowsAppSDK/discussions/4435)
- [dotnet/maui#6210, Multi-Window in Windows with all options](https://github.com/dotnet/maui/issues/6210)
- [SYSLIB1050, source-generated P/Invoke diagnostics](https://learn.microsoft.com/dotnet/fundamentals/syslib-diagnostics/syslib1050)
- [.NET MAUI Community Toolkit Popup documentation](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/views/popup)
