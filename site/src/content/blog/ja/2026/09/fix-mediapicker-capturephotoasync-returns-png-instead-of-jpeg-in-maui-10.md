---
title: "修正: .NET MAUI 10 で MediaPicker.CapturePhotoAsync が JPEG ではなく PNG を返す"
description: "iOS の MAUI 10 は、CompressionQuality が 90 以上で MaximumWidth/Height が設定されていない場合 (既定値を含む) にカメラ写真を PNG として再エンコードします。CompressionQuality を 89 以下にするか、iOS でのみ MaximumWidth を追加してください。"
pubDate: 2026-09-27
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "android"
  - "csharp"
lang: "ja"
translationOf: "2026/09/fix-mediapicker-capturephotoasync-returns-png-instead-of-jpeg-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-27
---

.NET MAUI 10 の `MediaPicker.Default.CapturePhotoAsync()` が `ContentType` `image/png` の `3f2c9a....png` を返してくる場合、PNG を作ったのはカメラではありません。MAUI です。iOS のカメラ経路ではデコード済みの `UIImage` が MAUI に渡され、MAUI 10 は `CompressionQuality` が 90 以上で、かつ `MaximumWidth` も `MaximumHeight` も設定されていないときに、それを `AsPNG()` で再エンコードします。既定の品質は 100 なので、オプションなしの呼び出しは常に PNG を返します。すべてのプラットフォーム、すべての 10.x および 11 のビルドで効く修正は `new MediaPickerOptions { CompressionQuality = 85 }` (0 から 89 の任意の値) です。代わりに iOS で最高品質の JPEG が欲しい場合は、品質を 100 のまま、iOS でのみ大きすぎる `MaximumWidth` を設定します。Android と Windows では、品質 95 から 99 でも PNG のバイト列が返り、Windows ではそれが `.jpg` という名前のままになります。

## エラーの状況

ここでは例外は発生しません。症状は、要求していないファイルが返ってくることです:

```text
// .NET 10, Microsoft.Maui.Essentials 10.0.110, iPhone, CapturePhotoAsync() with no options
FileName:    6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png
ContentType: image/png
First bytes: 89 50 4E 47 0D 0A 1A 0A
```

この問題の検索は、たいていパイプラインのもっと下流から始まります。`image/jpeg` しか受け付けないアップロードエンドポイントが 415 でファイルを拒否する、Blob Storage のバケットが数 MB の PNG で埋まる、サーバー側の画像リサイザーが RGBA 入力でつまずく、あるいはバックエンドが期待していた EXIF データ (撮影日時、GPS) が欠けている、といったものです。4 つとも、MAUI の同じ 1 行のコードに行き着きます。

各リリースタグの `MediaPicker` ソースから読み取った、`CapturePhotoAsync` 呼び出しごとの戻り値は次のとおりです:

| オプション | iOS、MAUI 10.0.0 から 10.0.51 | iOS、MAUI 10.0.60 から 10.0.110 および 11.0 RC 1/RC 2 | Android、全 10.x および 11 RC | Windows、全 10.x および 11 RC |
| --- | --- | --- | --- | --- |
| なし (品質 100) | PNG | PNG | カメラの JPEG、未加工 | カメラの JPEG、未加工 |
| `CompressionQuality` 95 から 99 | PNG | PNG | PNG | `.jpg` という名前の PNG バイト列 |
| `CompressionQuality` 90 から 94 | JPEG、品質 0.9 | PNG | JPEG、再エンコード | JPEG、再エンコード |
| `CompressionQuality` 0 から 89 | JPEG、品質 q/100 | JPEG、品質 q/100 | JPEG、再エンコード | JPEG、再エンコード |
| 品質 100 + `MaximumWidth` | JPEG、品質 0.95 | JPEG、品質 0.95 | PNG | `.jpg` という名前の PNG バイト列 |
| 品質 95 から 99 + `MaximumWidth` | JPEG、品質 0.9 | JPEG、品質 0.9 | PNG | `.jpg` という名前の PNG バイト列 |

目につく点が 2 つあります。すべての列で JPEG が得られる設定は、品質 89 以下だけです。そして iOS のルールは 10.0.60 (SR6) で厳しくなったため、10.0.51 で JPEG を得るために `CompressionQuality = 90` を使っていたアプリは、定例の MAUI 更新の後で PNG を受け取るようになりました。

## MAUI 10 がカメラ写真を PNG に変えてしまう理由

iOS の `CapturePhotoAsync` は、カメラをソースとする `UIImagePickerController` を表示します。撮影したばかりの写真はまだフォトライブラリに入っていないため、元の HEIC や JPEG のバイト列を読み取るための `PHAsset` がありません。MAUI は `UIImagePickerController.OriginalImage` のエントリ (デコード済みの `UIImage`) にフォールバックし、それを内部クラス `CompressedUIImageFileResult` でラップします。このクラスは、手がかりになる元のファイル名がない状態でファイル形式を選ばなければならず、それを `ShouldUsePngFormat` で行います:

```csharp
// .NET MAUI 10.0.110, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
bool ShouldUsePngFormat()
{
    bool originalWasPng = !string.IsNullOrEmpty(originalFileName) &&
        Path.GetExtension(originalFileName).Equals(".png", StringComparison.OrdinalIgnoreCase);

    return originalWasPng || (compressionQuality >= 90 && !maximumWidth.HasValue && !maximumHeight.HasValue);
}
```

カメラ撮影では `originalFileName` が `null` なので、判定は後半部分だけで決まります。`MediaPickerOptions.CompressionQuality` の既定値は 100 なので、"オプションなし" は `workingImage.AsPNG()` に行き着きます。ファイル名は `Guid` に `.png` を付けたもので、`FileResult.ContentType` はその拡張子から導出されるため、下流のすべてが PNG だと認識します。

これは新しい挙動というより、名残です。MAUI 9 以前では、同じカメラ経路はオプションとは無関係に常に `AsPNG()` を呼ぶ `UIImageFileResult` を使っていました (2022 年の [dotnet/maui#11379](https://github.com/dotnet/maui/issues/11379) を参照)。MAUI 10 は `MediaPickerOptions` に `CompressionQuality`、`MaximumWidth`、`MaximumHeight`、`RotateImage`、`PreserveMetaData` を追加し、"最高品質" の出力としては PNG を残しました。10.0.51 まではしきい値は 95 でした。[dotnet/maui#33119](https://github.com/dotnet/maui/issues/33119) が、このメソッドはしきい値 90 を計算しておきながら 95 のものを返していると指摘し、[PR #33140](https://github.com/dotnet/maui/pull/33140) (マイルストーン .NET 10 SR6、NuGet では 2026-04-29 の 10.0.60 で初出荷) が 90 に統一しました。同じコードは `11.0.100-rc.1.26458.5` タグと `release/11.0.1xx-rc2` ブランチにもあります。

Android と Windows は別の経路をたどります。こちらではカメラが本物の JPEG ファイル (Android では `Guid.jpg`、Windows では `CameraCaptureUIPhotoFormat.Jpeg` による撮影) を書き出し、MAUI がそれに手を加えるのは `ImageProcessor.IsProcessingNeeded` が true のとき、つまり品質が 100 未満か最大寸法が指定されているときだけです。その場合、共有の `ImageProcessor.ProcessImageAsync` が独自のルール `qualityPercent >= 95 || (qualityPercent >= 90 && originalWasPng)` で形式を選びますが、このルールはリサイズのオプションをまったく考慮しません。そのため Android では品質 97 がカメラの JPEG を PNG に変換し、iOS では品質 97 に `MaximumWidth` を付けると変換されません。同じオプションオブジェクトで、ファイル形式が異なるのです。Windows にはさらにもう一つひねりがあります。その `ProcessedImageFileResult` は出力の名前を `ImageProcessor.DetermineOutputExtension(imageData, 75, originalFileName)` で決めており、指定した品質ではなくハードコードされた 75 を使うため、PNG のバイト列に `.jpg` という名前と `image/jpeg` のコンテンツタイプが付きます。

## 最小限の再現コード

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110, run on a physical iPhone
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
if (photo is null) return; // user cancelled

Console.WriteLine($"{photo.FileName} | {photo.ContentType}");
// 6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png | image/png
```

iOS Simulator にはカメラがない (そこでは `IsCaptureSupported` が false) ため、これには実機が必要です。まだ MAUI プロジェクト用に実機をセットアップしていない場合は、[MAUI iOS のプロビジョニングプロファイルの修正](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) が最初によくぶつかる壁を扱っています。

## 修正 1: CompressionQuality を 89 以下に設定する

ほぼすべてのアプリに対する推奨はこれです。1 行で済み、iOS、Android、Windows で JPEG を生成し、MAUI 10 のすべてのサービスリリースと MAUI 11 RC 1 で同じように動作します:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(new MediaPickerOptions
{
    CompressionQuality = 85,
});
```

iOS では、向きを正規化した画像に対して `UIImage.AsJPEG(0.85f)` を呼び出します。Android と Windows では、カメラの JPEG を Microsoft.Maui.Graphics で読み込み、品質 0.85 の JPEG として保存し直します。品質 85 は、スマートフォンでの表示サイズなら写真として元画像と見分けがつかず、同じピクセルのロスレス PNG と比べてファイルサイズを大幅に削減できます。アップロード前に解像度も制限したい場合は、隣に `MaximumWidth` と `MaximumHeight` を追加してください。品質が 90 未満であれば、どのプラットフォームでもそれらが形式を切り替えることはありません。

品質 90 から 94 で "修正" してはいけません。この範囲は 10.0.51 までは iOS で JPEG でしたが、10.0.60 で PNG になりました。まさに次のワークロード更新で気づかないうちに壊れる種類の設定です。

## 修正 2: 大きすぎる MaximumWidth で iOS の最高品質を維持する

MAUI が生成する中で最も劣化の少ない JPEG が必要な場合、知っておく価値のある癖があります。iOS では、`MaximumWidth` または `MaximumHeight` をどちらか設定すると PNG の分岐が無効になり、しかも MAUI は拡大を一切行いません (`CalculateResizedDimensions` がスケールを 1 に制限します)。品質 100 なら、フル解像度のまま `AsJPEG(0.95f)` になります。Android と Windows では同じオプションが逆の結果になって PNG を生成してしまい、しかもそちらではオプションなしの呼び出しで得られる未加工のカメラ JPEG がすでに望みどおりのものです。そこでプラットフォームごとに分岐します:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Devices;
using Microsoft.Maui.Media;

static MediaPickerOptions JpegCaptureOptions()
{
    if (DeviceInfo.Platform == DevicePlatform.iOS ||
        DeviceInfo.Platform == DevicePlatform.MacCatalyst)
    {
        // Any maximum dimension disables the PNG branch on iOS.
        // 16384 is larger than any iPhone sensor, so nothing is resized.
        return new MediaPickerOptions
        {
            CompressionQuality = 100, // encoded as AsJPEG(0.95f)
            MaximumWidth = 16384,
            MaximumHeight = 16384,
        };
    }

    // Android and Windows: quality 100 and no limits means MAUI returns
    // the camera's own JPEG file without re-encoding it.
    return new MediaPickerOptions();
}

FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(JpegCaptureOptions());
```

これは `ShouldUsePngFormat` の実装詳細に依存しているので、回避策として扱い、新しい MAUI リリースに移行するときは上の表を確認し直してください。修正 1 にはそのような依存はありません。

## 修正 3: 下流で拡張子を信用しない

オプションを修正しても、MAUI アプリはクライアントの一つにすぎず、Windows ではファイル名が逆方向に間違っていることもあります。写真を受け取る側はすべて、ファイル名ではなくバイト列を確認すべきです。JPEG は `FF D8 FF` で始まり、PNG は 8 バイトのシグネチャ `89 50 4E 47 0D 0A 1A 0A` で始まります:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Storage;

static async Task<string?> DetectImageFormatAsync(FileResult file)
{
    await using var stream = await file.OpenReadAsync();
    var header = new byte[8];
    var read = await stream.ReadAtLeastAsync(header, header.Length, throwOnEndOfStream: false);

    if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        return "image/jpeg";

    if (read >= 8 && header.AsSpan().SequenceEqual(
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
        return "image/png";

    return null;
}
```

アップロードを組み立てる際には検出した型を使ってください。そうすれば、まだ PNG を送ってくる古いバージョンのアプリで撮影された写真であっても、サーバーは正しい `Content-Type` を受け取れます:

```csharp
// .NET 10, C# 14
static async Task UploadAsync(HttpClient http, FileResult photo)
{
    var contentType = await DetectImageFormatAsync(photo) ?? "application/octet-stream";
    var extension = contentType == "image/png" ? ".png" : ".jpg";

    await using var stream = await photo.OpenReadAsync();
    using var content = new MultipartFormDataContent();
    var file = new StreamContent(stream);
    file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
    content.Add(file, "photo", $"capture{extension}");

    using var response = await http.PostAsync("api/photos", content);
    response.EnsureSuccessStatusCode();
}
```

サーバーがファイルをデータベースの行と並べて Blob Storage に保存する場合、どちらか一方が失敗したときの対処は [データベース書き込みと Blob アップロードの整合性に関する記事](/ja/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) で扱っています。

上記の C# はすべて、.NET 10.0.302 SDK 上で `Microsoft.Maui.Essentials` 10.0.110 に対してコンパイルできます。形式の表は、タグ `10.0.0`、`10.0.51`、`10.0.60`、`10.0.110`、`11.0.100-rc.1.26458.5` の `MediaPicker.ios.cs`、`MediaPicker.android.cs`、`MediaPicker.windows.cs`、`ImageProcessor.shared.cs` を読んで作成したもので、デバイスの組み合わせで検証したものではありません。お使いのデバイスで結果が違う場合は、まず実際に使っているタグを確認してください (`dotnet list package --include-transitive | grep Maui`)。

## PNG に付随する落とし穴

**iOS の撮影では、`PreserveMetaData` の値にかかわらず EXIF が失われます。** `CompressedUIImageFileResult` は `UIImage` だけから構築され、`PreserveMetaData` が渡されることはありません。`UIImage` に対する `AsPNG()` と `AsJPEG()` はカメラのメタデータを書き込まないため、どちらの修正でも撮影日時、GPS、レンズの情報はファイルに含まれません。必要な場合は、カスタムピッカーで `UIImagePickerController.MediaMetadata` ディクショナリを自分で読み取るか、撮影完了時にアプリ側でタイムスタンプと位置情報を記録してください。既存の写真の選択 (`PickPhotoAsync`) は `PHPicker` と元のアセットを経由する別の経路です。[dotnet/maui#36581](https://github.com/dotnet/maui/issues/36581) が .NET 12 向けの本格的なメタデータ API を追跡しています。

**回転した写真は RGBA になります。** iPhone のカメラで撮った縦向きの写真は、`UIImageOrientation.Right` 付きの横向きビットマップとして届きます。MAUI はエンコード前に必ず `NormalizeOrientation()` を呼び出し、フォーマットの `Opaque = false` である `UIGraphicsImageRenderer` で画像を描き直します。その結果、不要なアルファチャンネルが付き、それを PNG にするとさらに大きくなります。利点としては、ピクセルがすでに正しい向きになっているので、iOS の撮影では `RotateImage = true` が不要です。

**MAUI 11 の `SaveToGallery` も PNG を保存します。** MAUI 11 は撮影の呼び出し向けに `MediaPickerOptions.SaveToGallery` を追加しました。iOS では、MAUI が返すのと同じ `FileResult` を一時ファイルに書き出し、`PHAssetChangeRequest.FromImage` に渡します。つまり既定のオプションでは、ユーザーのフォトライブラリに PNG が保存されます。品質を 90 未満にすれば、ギャラリーのコピーも JPEG になります。

**`PickPhotoAsync` は別の理由で PNG を返すことがあります。** ユーザーがスクリーンショットを選んだ場合、元の画像は本当に PNG であり、MAUI は仕様として品質 90 以上ではそれを PNG のまま保持します (`originalWasPng`)。これはこのバグではありません。修正 3 のように形式を検出して、両方を処理してください。

**iOS の複数選択には、10.0.100 固有の別の問題があります。** ユーザーが複数の画像を選んだときに `PickPhotosAsync` が例外をスローする場合、それは [MediaPicker.PickPhotosAsync による UIKitThreadAccessException のリグレッション](/ja/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) で、10.0.110 で修正されています。

## 関連記事

- [修正: .NET MAUI iOS で MediaPicker.PickPhotosAsync から UIKitThreadAccessException が発生する](/ja/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) は、10.0.1xx 系のもう一つの MediaPicker のリグレッションを扱っています。
- [.NET MAUI 10 の新機能](/ja/2025/04/whats-new-in-net-maui-10/) では、新しいピッカーオプションが含まれたリリースの残りの内容を紹介しています。
- [修正: プロビジョニングプロファイルに現在選択中のデバイスが含まれていない](/ja/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) は、カメラのコードを実際の iPhone で動かすための記事です。
- [データベース書き込みと Azure Blob アップロードを 1 つのリクエストで整合させる](/ja/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) は、写真アップロードのサーバー側を扱っています。

## 参考資料

- [写真とビデオのメディアピッカー、.NET MAUI ドキュメント (MS Learn)](https://learn.microsoft.com/dotnet/maui/platform-integration/device-media/picker?view=net-maui-10.0)
- [タグ 10.0.110 の `MediaPicker.ios.cs`](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/MediaPicker.ios.cs)
- [タグ 10.0.110 の `ImageProcessor.shared.cs`](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/ImageProcessor.shared.cs)
- [dotnet/maui#33119: MediaPicker ShouldUsePngFormat method has conflicting/redundant code](https://github.com/dotnet/maui/issues/33119)
- [dotnet/maui#33140: Refactor image rotation and PNG format logic](https://github.com/dotnet/maui/pull/33140)
- [dotnet/maui#11379: CapturePhotoAsync returns PNG in which the orientation data is lost](https://github.com/dotnet/maui/issues/11379)
- [dotnet/maui#36581: Add image metadata APIs and non-destructive MediaPicker processing](https://github.com/dotnet/maui/issues/36581)
