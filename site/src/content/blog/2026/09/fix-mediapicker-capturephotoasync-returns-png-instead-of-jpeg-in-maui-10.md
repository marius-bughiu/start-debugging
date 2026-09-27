---
title: "Fix: MediaPicker.CapturePhotoAsync returns a PNG instead of a JPEG in .NET MAUI 10"
description: "On iOS, MAUI 10 re-encodes camera photos as PNG whenever CompressionQuality is 90 or higher and no MaximumWidth/Height is set, which includes the default. Set CompressionQuality to 89 or lower, or add a MaximumWidth on iOS only."
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
---

If `MediaPicker.Default.CapturePhotoAsync()` in .NET MAUI 10 hands you a `3f2c9a....png` with `ContentType` `image/png`, the camera did not produce a PNG. MAUI did. On iOS the camera path gives MAUI a decoded `UIImage`, and MAUI 10 re-encodes it with `AsPNG()` whenever `CompressionQuality` is 90 or higher and neither `MaximumWidth` nor `MaximumHeight` is set. The default quality is 100, so a call with no options always returns a PNG. The fix that works on every platform and every 10.x and 11 build is `new MediaPickerOptions { CompressionQuality = 85 }` (anything from 0 to 89). If you want iOS's highest-quality JPEG instead, keep quality 100 and set an oversized `MaximumWidth` on iOS only. On Android and Windows, a quality from 95 to 99 also gives you PNG bytes, and on Windows they even keep a `.jpg` name.

## The error in context

There is no exception here. The symptom is a file you did not ask for:

```text
// .NET 10, Microsoft.Maui.Essentials 10.0.110, iPhone, CapturePhotoAsync() with no options
FileName:    6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png
ContentType: image/png
First bytes: 89 50 4E 47 0D 0A 1A 0A
```

Search traffic for this usually starts somewhere further down the pipeline: an upload endpoint that only accepts `image/jpeg` rejects the file with 415, a blob storage bucket fills up with multi-megabyte PNGs, an image resizer on the server chokes on RGBA input, or EXIF data the backend expected (capture time, GPS) is missing. All four go back to the same line of MAUI code.

Here is what each `CapturePhotoAsync` call returns, taken from the `MediaPicker` sources at each release tag:

| Options | iOS, MAUI 10.0.0 to 10.0.51 | iOS, MAUI 10.0.60 to 10.0.110 and 11.0 RC 1/RC 2 | Android, all 10.x and 11 RC | Windows, all 10.x and 11 RC |
| --- | --- | --- | --- | --- |
| none (quality 100) | PNG | PNG | camera JPEG, untouched | camera JPEG, untouched |
| `CompressionQuality` 95 to 99 | PNG | PNG | PNG | PNG bytes named `.jpg` |
| `CompressionQuality` 90 to 94 | JPEG, quality 0.9 | PNG | JPEG, re-encoded | JPEG, re-encoded |
| `CompressionQuality` 0 to 89 | JPEG, quality q/100 | JPEG, quality q/100 | JPEG, re-encoded | JPEG, re-encoded |
| quality 100 + `MaximumWidth` | JPEG, quality 0.95 | JPEG, quality 0.95 | PNG | PNG bytes named `.jpg` |
| quality 95 to 99 + `MaximumWidth` | JPEG, quality 0.9 | JPEG, quality 0.9 | PNG | PNG bytes named `.jpg` |

Two things stand out. The only setting that gives a JPEG in every column is a quality of 89 or lower. And the iOS rule got stricter in 10.0.60 (SR6), so an app that used `CompressionQuality = 90` to get JPEGs on 10.0.51 started getting PNGs after a routine MAUI update.

## Why MAUI 10 turns a camera photo into a PNG

`CapturePhotoAsync` on iOS presents a `UIImagePickerController` with the camera as source. A freshly taken photo is not yet in the photo library, so there is no `PHAsset` to read the original HEIC or JPEG bytes from. MAUI falls back to the `UIImagePickerController.OriginalImage` entry, which is a decoded `UIImage`, and wraps it in an internal `CompressedUIImageFileResult`. That class has to pick a file format before it has any original file name to go on, and it does it in `ShouldUsePngFormat`:

```csharp
// .NET MAUI 10.0.110, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
bool ShouldUsePngFormat()
{
    bool originalWasPng = !string.IsNullOrEmpty(originalFileName) &&
        Path.GetExtension(originalFileName).Equals(".png", StringComparison.OrdinalIgnoreCase);

    return originalWasPng || (compressionQuality >= 90 && !maximumWidth.HasValue && !maximumHeight.HasValue);
}
```

For a camera capture, `originalFileName` is `null`, so the second half is the whole decision. `MediaPickerOptions.CompressionQuality` defaults to 100, which means "no options" lands on `workingImage.AsPNG()`. The file name is a `Guid` plus `.png`, and `FileResult.ContentType` is derived from that extension, so everything downstream agrees that it is a PNG.

This is not new behaviour so much as a leftover. In MAUI 9 and earlier the same camera path used a `UIImageFileResult` that always called `AsPNG()`, no options involved (see [dotnet/maui#11379](https://github.com/dotnet/maui/issues/11379) from 2022). MAUI 10 added `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` and `PreserveMetaData` to `MediaPickerOptions`, and kept PNG as the "highest quality" output. Up to 10.0.51 the threshold was 95. [dotnet/maui#33119](https://github.com/dotnet/maui/issues/33119) pointed out that the method computed a 90 threshold and then returned a 95 one, and [PR #33140](https://github.com/dotnet/maui/pull/33140) (milestone .NET 10 SR6, first shipped in 10.0.60 on NuGet on 2026-04-29) settled on 90. The same code is in the `11.0.100-rc.1.26458.5` tag and on the `release/11.0.1xx-rc2` branch.

Android and Windows take a different route. There the camera writes a real JPEG file (`Guid.jpg` on Android, a `CameraCaptureUIPhotoFormat.Jpeg` capture on Windows), and MAUI only touches it when `ImageProcessor.IsProcessingNeeded` is true, meaning a quality below 100 or a maximum dimension. The shared `ImageProcessor.ProcessImageAsync` then picks the format with its own rule, `qualityPercent >= 95 || (qualityPercent >= 90 && originalWasPng)`, which ignores the resize options entirely. So on Android a quality of 97 converts the camera JPEG into a PNG, and on iOS a quality of 97 with a `MaximumWidth` does not. Same option object, different file formats. Windows adds one more twist: its `ProcessedImageFileResult` names the output with `ImageProcessor.DetermineOutputExtension(imageData, 75, originalFileName)`, a hard-coded 75 instead of your quality, so the PNG bytes get a `.jpg` name and an `image/jpeg` content type.

## Minimal repro

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110, run on a physical iPhone
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
if (photo is null) return; // user cancelled

Console.WriteLine($"{photo.FileName} | {photo.ContentType}");
// 6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png | image/png
```

The iOS Simulator has no camera (`IsCaptureSupported` is false there), so this needs a device. If you have not set one up for a MAUI project yet, the [provisioning profile fix for MAUI iOS](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) covers the usual first hurdle.

## Fix 1: set CompressionQuality to 89 or lower

This is the recommendation for almost every app. It is one line, it produces a JPEG on iOS, Android and Windows, and it behaves the same on every MAUI 10 servicing release and on MAUI 11 RC 1:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(new MediaPickerOptions
{
    CompressionQuality = 85,
});
```

On iOS this calls `UIImage.AsJPEG(0.85f)` on the orientation-normalized image. On Android and Windows it loads the camera JPEG through Microsoft.Maui.Graphics and saves it again as JPEG at quality 0.85. A quality of 85 is visually indistinguishable from the original for photos at phone viewing sizes and cuts the file size substantially compared to a lossless PNG of the same pixels. If you also want to cap the resolution before upload, add `MaximumWidth` and `MaximumHeight` next to it. With a quality under 90 they never flip the format on any platform.

Do not "fix" this with a quality of 90 to 94. That range was a JPEG on iOS up to 10.0.51 and became a PNG in 10.0.60, which is exactly the kind of setting that breaks silently on the next workload update.

## Fix 2: keep maximum quality on iOS with an oversized MaximumWidth

If you need the least lossy JPEG MAUI will produce, there is a quirk worth knowing: on iOS, setting any `MaximumWidth` or `MaximumHeight` disables the PNG branch, and MAUI never upscales (`CalculateResizedDimensions` clamps the scale to 1). With quality 100 that yields `AsJPEG(0.95f)` at full resolution. On Android and Windows the same options would do the opposite and produce a PNG, and there the untouched camera JPEG from a plain call is already what you want. So branch by platform:

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

This relies on an implementation detail of `ShouldUsePngFormat`, so treat it as a workaround, and re-check the table above when you move to a new MAUI release. Fix 1 has no such dependency.

## Fix 3: stop trusting the extension downstream

Even with the options fixed, a MAUI app is only one client, and on Windows the file name can be wrong in the other direction. Anything that receives photos should check the bytes, not the file name. JPEG starts with `FF D8 FF`, PNG with the 8-byte signature `89 50 4E 47 0D 0A 1A 0A`:

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

Use the detected type when you build the upload, so the server sees an honest `Content-Type` even for photos taken by an older app version that still sends PNGs:

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

If the server stores the file in blob storage next to a database row, the [database write plus blob upload consistency post](/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) covers what to do when one of the two fails.

All the C# above compiles against `Microsoft.Maui.Essentials` 10.0.110 on the .NET 10.0.302 SDK. The format table comes from reading `MediaPicker.ios.cs`, `MediaPicker.android.cs`, `MediaPicker.windows.cs` and `ImageProcessor.shared.cs` at the tags `10.0.0`, `10.0.51`, `10.0.60`, `10.0.110` and `11.0.100-rc.1.26458.5`, not from a device matrix, so if your device disagrees, the tag you are actually on is the first thing to check (`dotnet list package --include-transitive | grep Maui`).

## Gotchas that ride along with the PNG

**EXIF is gone on iOS captures, whatever `PreserveMetaData` says.** `CompressedUIImageFileResult` is constructed from the `UIImage` alone, and `PreserveMetaData` is never passed to it. `AsPNG()` and `AsJPEG()` on a `UIImage` write no camera metadata, so capture time, GPS and lens data are not in the file with either fix. If you need them, read the `UIImagePickerController.MediaMetadata` dictionary yourself in a custom picker, or record the timestamp and location in the app when the capture completes. Picking an existing photo (`PickPhotoAsync`) goes through `PHPicker` and the original asset, which is a different path. [dotnet/maui#36581](https://github.com/dotnet/maui/issues/36581) tracks proper metadata APIs for .NET 12.

**Rotated photos become RGBA.** A portrait photo from the iPhone camera arrives as a landscape bitmap with `UIImageOrientation.Right`. MAUI always calls `NormalizeOrientation()` before encoding, which redraws the image with a `UIGraphicsImageRenderer` whose format has `Opaque = false`. The result carries an alpha channel it does not need, and a PNG of it is bigger still. The upside is that the pixels are already upright, so `RotateImage = true` is not needed for iOS captures.

**MAUI 11 `SaveToGallery` saves the PNG, too.** MAUI 11 adds `MediaPickerOptions.SaveToGallery` for capture calls. On iOS it writes the same `FileResult` MAUI returns to you to a temp file and passes it to `PHAssetChangeRequest.FromImage`. With default options that means a PNG lands in the user's photo library. Set a quality below 90 and the gallery copy is a JPEG as well.

**`PickPhotoAsync` can return PNGs for a different reason.** If the user picks a screenshot, the original really is a PNG, and MAUI keeps it as PNG at quality 90 or higher by design (`originalWasPng`). That is not this bug; detect the format as in Fix 3 and handle both.

**Multi-select picking on iOS has its own 10.0.100 problem.** If `PickPhotosAsync` throws when the user selects several images, that is the [UIKitThreadAccessException regression from MediaPicker.PickPhotosAsync](/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), fixed in 10.0.110.

## Related

- [Fix: UIKitThreadAccessException from MediaPicker.PickPhotosAsync in .NET MAUI iOS](/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) covers the other MediaPicker regression in the 10.0.1xx line.
- [What's new in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) for the rest of the release the new picker options shipped in.
- [Fix: provisioning profile doesn't include the currently selected device](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) for getting camera code onto a real iPhone.
- [Keeping a database write and an Azure blob upload consistent in one request](/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) for the server side of a photo upload.

## Sources

- [Media picker for photos and videos, .NET MAUI docs (MS Learn)](https://learn.microsoft.com/dotnet/maui/platform-integration/device-media/picker?view=net-maui-10.0)
- [`MediaPicker.ios.cs` at tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/MediaPicker.ios.cs)
- [`ImageProcessor.shared.cs` at tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/ImageProcessor.shared.cs)
- [dotnet/maui#33119: MediaPicker ShouldUsePngFormat method has conflicting/redundant code](https://github.com/dotnet/maui/issues/33119)
- [dotnet/maui#33140: Refactor image rotation and PNG format logic](https://github.com/dotnet/maui/pull/33140)
- [dotnet/maui#11379: CapturePhotoAsync returns PNG in which the orientation data is lost](https://github.com/dotnet/maui/issues/11379)
- [dotnet/maui#36581: Add image metadata APIs and non-destructive MediaPicker processing](https://github.com/dotnet/maui/issues/36581)
