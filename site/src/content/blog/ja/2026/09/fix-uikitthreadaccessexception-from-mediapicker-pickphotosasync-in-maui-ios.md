---
title: "修正: .NET MAUI iOS で複数の写真を選ぶと MediaPicker.PickPhotosAsync が UIKitThreadAccessException を投げる"
description: "iOS で 2 枚以上の写真を選ぶと MAUI 10.0.100 と 10.0.101 で UIKitThreadAccessException が発生します。MAUI が await の後、メインスレッド外で PHPickerResult.ItemProvider を読むためです。10.0.90 に固定するか、10.0.110 に更新するか、PHPicker を自前で呼び出してください。"
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
  - "async"
lang: "ja"
translationOf: "2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-09-16
---

iOS でユーザーが 2 つ以上の項目を選ぶたびに `MediaPicker.PickPhotosAsync` が `UIKit.UIKitThreadAccessException` を投げる場合、10.0.100 で入った .NET MAUI のリグレッションを踏んでいます。MAUI は UIKit のガードが付いたプロパティ `PHPickerResult.ItemProvider` を、`ConfigureAwait(false)` で待機するループの中で読んでいるため、2 回目以降のイテレーションはスレッドプールのスレッドで実行されます。呼び出し側で何をしても直りません。`<MauiVersion>10.0.90</MauiVersion>` に固定するか、10.0.110 (SR11) または MAUI 11.0.0-rc.2 が出たらそちらへ移るか、`PHPickerViewController` を自前で呼び出して最初の await より前に item provider を読み取ってください。写真をちょうど 1 枚だけ選んだ場合は必ず成功するので、パターンに気づくまでは不定期な不具合に見えます。

## エラーの実際の内容

```text
UIKit.UIKitThreadAccessException: UIKit Consistency error: you are calling a UIKit method that can only be invoked from the UI thread.
   at UIKit.UIApplication.EnsureUIThread()
   at PhotosUI.PHPickerResult.get_ItemProvider()
   at Microsoft.Maui.Media.MediaPickerImplementation.PickerResultsToMediaFiles(PHPickerResult[] results, MediaPickerOptions options)
   at Microsoft.Maui.Media.MediaPickerImplementation.CompletePickerResultsAsync(PHPickerResult[] results, MediaPickerOptions options, TaskCompletionSource`1 tcs)
```

影響を受けるバージョンです。`dotnet/maui` のリリースブランチで確認しました。

| MAUI のバージョン | リリース日 | 2 つ以上の項目での `PickPhotosAsync` |
| --- | --- | --- |
| 10.0.90 (SR9) | 2026-07-22 | 動作する |
| 10.0.100 (SR10) | 2026-08-20 | 例外が発生する |
| 10.0.101 | 2026-09-07 | 例外が発生する |
| 11.0.0-rc.1 | 2026-09-08 | 例外が発生する |
| 10.0.110 (SR11) | 未リリース | 修正済み |
| 11.0.0-rc.2 | 未リリース | 修正済み |

`PickPhotosAsync` と `PickVideosAsync` はどちらも .NET MAUI 10 で追加されたものなので ([dotnet/maui#6903](https://github.com/dotnet/maui/issues/6903))、戻れる以前のメジャーバージョンはありません。Android と Windows は影響を受けません。壊れているコードは `MediaPicker.ios.cs` だけにあります。

## なぜ発生するのか

iOS の `PickPhotosAsync` は `PHPickerViewController` を表示します。ユーザーが確定すると、MAUI の `PhotoPickerDelegate.DidFinishPicking` がコントローラーを閉じ、その dismiss のコールバックから完了ハンドラーを呼び出します。このコールバックはメインスレッドで実行されます。ハンドラーは `PickerResultsToMediaFiles` を呼び出しますが、10.0.100 ではこのメソッドは次のようになっていました。

```csharp
// .NET MAUI 10.0.100 and 10.0.101, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
var fileResults = new List<FileResult>(results.Length);
PHPickerFileResult fileResult = null;

foreach (var file in results)
{
    fileResult = new PHPickerFileResult(file.ItemProvider);   // UIKit call
    await fileResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(fileResult);
    fileResult = null;
}
```

`PHPickerResult.ItemProvider` は `UIApplication.EnsureUIThread()` のガード付きでバインドされています。デリゲートのコールバックがメインスレッド上にいるため、1 回目のイテレーションは問題ありません。その後 `LoadFileRepresentationAsync` を `ConfigureAwait(false)` で待機すると、キャプチャされたコンテキストが破棄され、2 回目のイテレーションは継続が着地したスレッドで `file.ItemProvider` を読むことになります。

これを競合状態ではなく決定的な動作にしているのは `PHPickerFileResult` の中身です。

```csharp
// .NET MAUI 10.0.100, PHPickerFileResult.LoadFileRepresentationAsync
loadTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
```

`RunContinuationsAsynchronously` は、`TaskCompletionSource` を完了させたスレッドが継続をインラインで実行しないことを意味します。`ConfigureAwait(false)` と組み合わさると、メインスレッドへ戻る経路がなくなるので、2 回目の読み取りは必ずプール上で起きます。だからこの不具合は完全に再現します。1 項目なら必ず成功し、2 項目以上なら必ず失敗します。不安定な非同期バグを追ったことがあるなら、これはその逆のケースです。存在しない競合状態を探しに行く前に、[ConfigureAwait(false) が実際に何を捨てるのか](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)を理解しておく価値があります。

これは [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) (".NET 10 SR10") によるリグレッションです。この PR は PHPicker の結果で `FullPath` が空になる問題を修正したものでした。その PR の前は、すべての provider が一度にマテリアライズされていました。

```csharp
// .NET MAUI 10.0.90 and earlier
var fileResults = results?
    .Select(file => (FileResult)new PHPickerFileResult(file.ItemProvider))
    .ToList() ?? [];
```

すべての `ItemProvider` が最初の `await` より前に読まれていたため、UIKit のガードがプールのスレッドを見ることはありませんでした。これを `await` を含むループに置き換えたことが原因です。このバグは [dotnet/maui#37878](https://github.com/dotnet/maui/issues/37878) として追跡されており、`regressed-in-10.0.100` ラベルと .NET 10 SR11 のマイルストーンが付いています。

## 最小限の再現コード

```csharp
// .NET MAUI 10.0.100, net10.0-ios, iOS 26.4 simulator
private async void OnPickClicked(object sender, EventArgs e)
{
    try
    {
        var files = await MediaPicker.Default.PickPhotosAsync(new MediaPickerOptions
        {
            SelectionLimit = 5
        });

        StatusLabel.Text = $"Picked {files.Count}";
    }
    catch (Exception ex)
    {
        StatusLabel.Text = ex.ToString();   // UIKitThreadAccessException with 2+ items
    }
}
```

シミュレーターでは、先にライブラリへ写真を入れておかないとピッカーが空のまま開きます。

```bash
xcrun simctl addmedia booted photo1.png photo2.png photo3.png
```

写真を 1 枚選ぶと `FileResult` が返ります。2 枚選ぶと例外が返ります。ここで `async void` ハンドラーが許容できるのは、すべての経路が `try` の中に入っているからです。これが [async void が正当化できる](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)唯一の形です。

## 対処 1: リグレッションより後のバージョンへ更新する

修正は [dotnet/maui#37879](https://github.com/dotnet/maui/pull/37879) で、2026-08-27 にマージされ、[#38481](https://github.com/dotnet/maui/pull/38481) として `release/10.0.1xx-sr11` にバックポートされ、[#38488](https://github.com/dotnet/maui/pull/38488) として `main` にも取り込まれました。どちらも 2026-09-12 です。出荷されたコードは、最初の await より前にすべての provider を読むようになりました。

```csharp
// .NET MAUI 10.0.110 and 11.0.0-rc.2, MediaPicker.ios.cs
// PHPickerResult.ItemProvider is a UIKit call and must be read on the main thread.
var pickerResults = new List<PHPickerFileResult>(results.Length);
foreach (var file in results)
{
    pickerResults.Add(new PHPickerFileResult(file.ItemProvider));
}

var fileResults = new List<FileResult>(pickerResults.Count);
foreach (var pickerResult in pickerResults)
{
    await pickerResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(pickerResult);
}
```

`NSItemProvider` は UI スレッドのガードを持たない Foundation の型なので、await をまたいで provider を保持しても安全です。同じ PR はエラー経路のリークも塞いでいます。失敗したイテレーションより後に構築された結果が破棄されないままになっていました。

2026-09-16 時点では 10.0.110 も 11.0.0-rc.2 も NuGet にありません。10.0.110 が出たら、変更は 1 行です。

```xml
<!-- Directory.Build.props or the app .csproj -->
<PropertyGroup>
  <MauiVersion>10.0.110</MauiVersion>
</PropertyGroup>
```

## 対処 2: 10.0.90 に固定する

SR11 が出るまでは、SR10 で入った他の変更に依存していないなら、バージョン固定が最もリスクの低い選択肢です。

```xml
<!-- app .csproj, .NET 10 SDK -->
<PropertyGroup>
  <MauiVersion>10.0.90</MauiVersion>
</PropertyGroup>
```

代償として [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) の `FullPath` 修正も失われます。10.0.90 では PHPicker 経路の `FileResult` がファイルの存在しないパスを返すことがあり、`File.Copy(result.FullPath, ...)` が失敗するため `await result.OpenReadAsync()` を通す必要があります。アップロード処理がパスでのコピーではなくストリームを使っているなら、気づかないでしょう。

## 対処 3: PHPicker を自前で呼び出す

バージョンを動かせない場合は、iOS の複数選択の経路を 60 行ほどの interop で置き換えます。要点は、何かが await する前に、`DidFinishPicking` の中ですべての `ItemProvider` を読み取ることだけです。

```csharp
// .NET MAUI 10.0.100, net10.0-ios only
using Foundation;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Storage;
using PhotosUI;
using UIKit;

sealed class PhotoPicker
{
    public static Task<List<string>> PickPhotosAsync(int selectionLimit)
    {
        var tcs = new TaskCompletionSource<List<string>>();

        var config = new PHPickerConfiguration
        {
            Filter = PHPickerFilter.ImagesFilter,
            SelectionLimit = selectionLimit
        };

        var picker = new PHPickerViewController(config)
        {
            Delegate = new PickerDelegate(tcs)
        };

        var vc = WindowStateManager.Default.GetCurrentUIViewController(true);
        vc.PresentViewController(picker, true, null);

        return tcs.Task;
    }

    sealed class PickerDelegate : PHPickerViewControllerDelegate
    {
        readonly TaskCompletionSource<List<string>> _tcs;

        public PickerDelegate(TaskCompletionSource<List<string>> tcs) => _tcs = tcs;

        public override void DidFinishPicking(PHPickerViewController picker, PHPickerResult[] results)
        {
            // Main thread. Read every provider now, before any await can move us off it.
            var providers = new List<NSItemProvider>(results.Length);
            foreach (var result in results)
            {
                providers.Add(result.ItemProvider);
            }

            picker.DismissViewController(true, () => _ = LoadAllAsync(providers));
        }

        async Task LoadAllAsync(List<NSItemProvider> providers)
        {
            try
            {
                var paths = new List<string>(providers.Count);
                foreach (var provider in providers)
                {
                    var identifier = provider.RegisteredTypeIdentifiers?.FirstOrDefault();
                    if (string.IsNullOrEmpty(identifier))
                    {
                        continue;
                    }

                    paths.Add(await CopyToCacheAsync(provider, identifier).ConfigureAwait(false));
                }

                _tcs.TrySetResult(paths);
            }
            catch (Exception ex)
            {
                _tcs.TrySetException(ex);
            }
        }

        static Task<string> CopyToCacheAsync(NSItemProvider provider, string identifier)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

            provider.LoadFileRepresentation(identifier, (url, error) =>
            {
                if (error is not null)
                {
                    tcs.TrySetException(new NSErrorException(error));
                    return;
                }

                try
                {
                    // The URL is only valid inside this callback, so copy synchronously.
                    var destination = Path.Combine(
                        FileSystem.CacheDirectory,
                        Guid.NewGuid().ToString("n") + Path.GetExtension(url.Path));

                    File.Copy(url.Path, destination, overwrite: true);
                    tcs.TrySetResult(destination);
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            });

            return tcs.Task;
        }
    }
}
```

重要な点が 2 つあります。`LoadFileRepresentation` のコールバックに渡される `NSUrl` は、コールバックから戻った時点でシステムが削除するファイルを指しています。したがってコピーはコールバック内で同期的に行う必要があります。そして `PickerDelegate` は到達可能なままにしておく必要があります。型付きの `Delegate` プロパティへ代入すればマネージド参照が保持されますが、`WeakDelegate` に切り替える場合はインスタンスを自分で保持しないと、選択の途中で回収されます。

失われるのは、選択後に `MediaPickerOptions` が行うすべての処理です。`CompressionQuality`、`MaximumWidth`、`MaximumHeight`、`RotateImage`、`PreserveMetaData` はピッカーではなく MAUI 自身の後処理パスが適用しています。これらが必要なら、コピーの後に `SkiaSharp` または `Microsoft.Maui.Graphics` でリサイズしてください。

## 対処 4: 代わりに FilePicker を使う

`FilePicker.PickMultipleAsync` は `UIDocumentPickerViewController` と `NSUrl[]` を経由し、`PHPickerResult` に触れないので影響を受けません。

```csharp
// .NET MAUI 10.0.100, cross-platform
var files = await FilePicker.Default.PickMultipleAsync(new PickOptions
{
    PickerTitle = "Select images",
    FileTypes = FilePickerFileType.Images
});
```

体験は別物です。写真グリッドではなくファイル App が開き、写真ライブラリの権限ダイアログは出ず、Live Photos や HEIC の扱いもありません。「画像を何枚か添付する」程度のフローなら妥当なつなぎですが、カメラロール中心の用途には向きません。

## 注意点と紛らわしいケース

**Release ビルドにすると例外は消えますが、それは修正ではありません。** `EnsureUIThread` は `ObjCRuntime.Runtime.CheckForIllegalCrossThreadCalls` によって制御されており、ILLink の置換が Release ビルドではこれを無効にします。スレッド外からの UIKit アクセス自体はそのまま残り、診断だけが失われます。Release でテストして解決したと判断することが、決定的な例外ではなく不定期なクラッシュとして App Store に出荷されてしまう典型的な経路です。

**`UIApplication.CheckForIllegalCrossThreadCalls = false` にしてはいけません。** アプリ内のすべての UI スレッドアサーションを黙らせてしまいますし、そもそも根本のアクセスが本当に安全ではありません。

**呼び出しを `MainThread.InvokeOnMainThreadAsync` で包んでも効果はありません。** スレッドはピッカーのデリゲートが戻った後、MAUI の内部で失われますし、そこにある `ConfigureAwait(false)` が呼び出し側で設定したコンテキストを明示的に捨てます。呼び出し側のスレッド対策では届きません。[スタックの奥で .Result をブロッキング呼び出ししたことによるデッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)に届かないのと同じです。

**`PickVideosAsync` もまったく同様に影響を受けます。** 同じ `PhotosAsync` ヘルパーと同じ `PickerResultsToMediaFiles` を通ります。写真ではなく動画で再現しているなら、同じバグです。

**`PickPhotoAsync` (単数形) は問題ありません。** コード経路は共有していますが、`PHPickerResult` がちょうど 1 つしか生成されないため、ループが 2 回目の読み取りに到達しません。単一選択で `UIKitThreadAccessException` が出るなら別の問題で、たいていは自分の継続がメインスレッド外でコントロールに触れています。

**`PickPhotosAsync` に `SelectionLimit = 1` を指定するのも安全です。** ただしそれは複数選択、つまりこの API を呼び出した理由そのものを取り除くという意味での回避策にすぎません。

**[dotnet/maui#33954](https://github.com/dotnet/maui/issues/33954) とは別物です。** こちらは SR6 で修正済みで、`CompressionQuality` を指定すると `PickPhotosAsync` が選択枚数より少ない画像しか返さないというものでした。症状が異なり、例外も出ず、すでに出荷されています。

**Android の ANR は MAUI のスレッド問題としては別の種類です。** MAUI アプリが Android でも UI スレッドをブロックしているなら、それは例外ではなく ANR として現れ、診断方法もまったく異なります。[.NET MAUI Android アプリで ANR を起こしている async void ハンドラーを見つける方法](/ja/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)を参照してください。

## 関連記事

- [.NET 11 における ConfigureAwait(false) と既定値の比較: まだ意味はあるのか](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [C# の async void と async Task: どちらが正しいか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [修正: C# の非同期メソッドで .Result や .Wait() を呼んだときのデッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [.NET MAUI Android アプリで ANR を起こしている async void ハンドラーを見つける方法](/ja/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)
- [修正: MAUI iOS でプロビジョニングプロファイルに選択中のデバイスが含まれていない](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)

## 参照元

- [dotnet/maui#37878 - 2 つ以上の項目を選ぶと MediaPicker.PickPhotosAsync が UIKitThreadAccessException を投げる](https://github.com/dotnet/maui/issues/37878)
- [dotnet/maui#37879 - 修正](https://github.com/dotnet/maui/pull/37879)、バックポートは [#38481](https://github.com/dotnet/maui/pull/38481) と [#38488](https://github.com/dotnet/maui/pull/38488)
- [dotnet/maui#35805 - リグレッションを持ち込んだ SR10 の変更](https://github.com/dotnet/maui/pull/35805)
- [dotnet/macios - Runtime.EnsureUIThread と CheckForIllegalCrossThreadCalls](https://github.com/dotnet/macios/blob/main/src/ObjCRuntime/Runtime.cs)
- [Apple Developer ドキュメント - PHPickerViewController](https://developer.apple.com/documentation/photokit/phpickerviewcontroller)
- [Microsoft Learn - .NET MAUI のメディアピッカー](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/device-media/picker)
