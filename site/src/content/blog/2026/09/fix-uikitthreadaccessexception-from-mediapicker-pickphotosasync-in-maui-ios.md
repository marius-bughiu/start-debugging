---
title: "Fix: UIKitThreadAccessException from MediaPicker.PickPhotosAsync when selecting multiple photos in .NET MAUI iOS"
description: "Picking 2 or more photos on iOS throws UIKitThreadAccessException in MAUI 10.0.100 and 10.0.101. MAUI reads PHPickerResult.ItemProvider after an await, off the main thread. Pin 10.0.90, upgrade to 10.0.110, or use a PHPicker shim."
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
---

If `MediaPicker.PickPhotosAsync` throws `UIKit.UIKitThreadAccessException` on iOS whenever the user picks 2 or more items, you have hit a .NET MAUI regression introduced in 10.0.100. MAUI reads `PHPickerResult.ItemProvider`, a UIKit-guarded property, inside a loop that awaits with `ConfigureAwait(false)`, so every iteration after the first runs on a thread-pool thread. Nothing you do at the call site fixes it. Pin `<MauiVersion>10.0.90</MauiVersion>`, move to 10.0.110 (SR11) or MAUI 11.0.0-rc.2 once they ship, or call `PHPickerViewController` yourself and read the item providers before the first await. Picking exactly one photo always works, which is why this looks intermittent until you notice the pattern.

## The error in context

```text
UIKit.UIKitThreadAccessException: UIKit Consistency error: you are calling a UIKit method that can only be invoked from the UI thread.
   at UIKit.UIApplication.EnsureUIThread()
   at PhotosUI.PHPickerResult.get_ItemProvider()
   at Microsoft.Maui.Media.MediaPickerImplementation.PickerResultsToMediaFiles(PHPickerResult[] results, MediaPickerOptions options)
   at Microsoft.Maui.Media.MediaPickerImplementation.CompletePickerResultsAsync(PHPickerResult[] results, MediaPickerOptions options, TaskCompletionSource`1 tcs)
```

Affected versions, confirmed against the `dotnet/maui` release branches:

| MAUI version | Released | `PickPhotosAsync` with 2+ items |
| --- | --- | --- |
| 10.0.90 (SR9) | 2026-07-22 | works |
| 10.0.100 (SR10) | 2026-08-20 | throws |
| 10.0.101 | 2026-09-07 | throws |
| 11.0.0-rc.1 | 2026-09-08 | throws |
| 10.0.110 (SR11) | unreleased | fixed |
| 11.0.0-rc.2 | unreleased | fixed |

`PickPhotosAsync` and `PickVideosAsync` are both new in .NET MAUI 10 ([dotnet/maui#6903](https://github.com/dotnet/maui/issues/6903)), so there is no earlier major version to fall back to. Android and Windows are unaffected: the broken code is in `MediaPicker.ios.cs` only.

## Why this happens

`PickPhotosAsync` on iOS presents a `PHPickerViewController`. When the user confirms, MAUI's `PhotoPickerDelegate.DidFinishPicking` dismisses the controller and invokes its completion handler from the dismissal callback, which runs on the main thread. That handler calls `PickerResultsToMediaFiles`, and in 10.0.100 that method looked like this:

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

`PHPickerResult.ItemProvider` is bound with a `UIApplication.EnsureUIThread()` guard. The first iteration is fine, because the delegate callback put us on the main thread. Then `LoadFileRepresentationAsync` is awaited with `ConfigureAwait(false)`, which discards the captured context, and the second iteration reads `file.ItemProvider` on whatever thread the continuation landed on.

The part that makes this deterministic rather than a race is inside `PHPickerFileResult`:

```csharp
// .NET MAUI 10.0.100, PHPickerFileResult.LoadFileRepresentationAsync
loadTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
```

`RunContinuationsAsynchronously` means the continuation is never run inline by the thread that completes the `TaskCompletionSource`. Combined with `ConfigureAwait(false)` there is no path back to the main thread, so the second read always happens on the pool. That is why the failure is perfectly reproducible: 1 item always works, 2 or more always throw. If you have chased flaky async bugs before, this is the opposite case, and it is worth understanding [what ConfigureAwait(false) actually discards](/2026/05/configureawait-false-vs-default-in-dotnet-11/) before you go looking for a race that isn't there.

This is a regression from [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) (".NET 10 SR10"), which fixed `FullPath` being empty for PHPicker results. Before that PR, every provider was materialized in one shot:

```csharp
// .NET MAUI 10.0.90 and earlier
var fileResults = results?
    .Select(file => (FileResult)new PHPickerFileResult(file.ItemProvider))
    .ToList() ?? [];
```

Every `ItemProvider` was read before the first `await`, so the UIKit guard never saw a pool thread. Replacing that with a loop containing an `await` is what broke it. The bug is tracked as [dotnet/maui#37878](https://github.com/dotnet/maui/issues/37878), labelled `regressed-in-10.0.100` and milestoned for .NET 10 SR11.

## Minimal repro

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

On a simulator, seed the library first or the picker comes up empty:

```bash
xcrun simctl addmedia booted photo1.png photo2.png photo3.png
```

Select one photo: you get a `FileResult`. Select two: you get the exception. Note the `async void` handler here is only fine because every path is inside a `try`, which is the one shape where [async void is defensible](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Fix 1: upgrade past the regression

The fix is [dotnet/maui#37879](https://github.com/dotnet/maui/pull/37879), merged 2026-08-27, backported to `release/10.0.1xx-sr11` as [#38481](https://github.com/dotnet/maui/pull/38481) and forward-ported to `main` as [#38488](https://github.com/dotnet/maui/pull/38488), both on 2026-09-12. The shipped code now reads every provider before the first await:

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

`NSItemProvider` is a Foundation type with no UI-thread guard, so holding the providers across the awaits is safe. The same PR also plugged a leak in the error path: results constructed after the failing iteration used to go undisposed.

As of 2026-09-16 neither 10.0.110 nor 11.0.0-rc.2 is on NuGet. Once 10.0.110 ships, this is a one-line change:

```xml
<!-- Directory.Build.props or the app .csproj -->
<PropertyGroup>
  <MauiVersion>10.0.110</MauiVersion>
</PropertyGroup>
```

## Fix 2: pin back to 10.0.90

Until SR11 lands, pinning is the lowest-risk option if you are not depending on anything else that shipped in SR10:

```xml
<!-- app .csproj, .NET 10 SDK -->
<PropertyGroup>
  <MauiVersion>10.0.90</MauiVersion>
</PropertyGroup>
```

The trade-off is that you also give up [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805), the `FullPath` fix. On 10.0.90, a `FileResult` from the PHPicker path can come back with a path that no file exists at, so `File.Copy(result.FullPath, ...)` fails and you have to go through `await result.OpenReadAsync()` instead. If your upload code already streams rather than copying by path, you will not notice.

## Fix 3: call PHPicker yourself

If you cannot move versions, replace the iOS multi-pick path with about sixty lines of interop. The whole trick is reading every `ItemProvider` inside `DidFinishPicking`, before anything awaits.

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

Two details matter. The `NSUrl` handed to the `LoadFileRepresentation` callback points at a file the system deletes as soon as the callback returns, so the copy has to be synchronous and inside the callback. And `PickerDelegate` must stay reachable; assigning it to the strongly-typed `Delegate` property keeps a managed reference, but if you switch to `WeakDelegate` you have to hold the instance yourself or it gets collected mid-pick.

What you lose is everything `MediaPickerOptions` does after the pick: `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` and `PreserveMetaData` are all applied by MAUI's own post-processing pass, not by the picker. If you need those, resize with `SkiaSharp` or `Microsoft.Maui.Graphics` after copying.

## Fix 4: use FilePicker instead

`FilePicker.PickMultipleAsync` goes through `UIDocumentPickerViewController` and `NSUrl[]`, never touching `PHPickerResult`, so it is not affected:

```csharp
// .NET MAUI 10.0.100, cross-platform
var files = await FilePicker.Default.PickMultipleAsync(new PickOptions
{
    PickerTitle = "Select images",
    FileTypes = FilePickerFileType.Images
});
```

This is a different experience: the Files app rather than the Photos grid, no Photos permission prompt, and no live-photo or HEIC handling. It is a reasonable stopgap for "attach some images" flows and a bad one for anything camera-roll centric.

## Gotchas and lookalikes

**A Release build makes the exception disappear, and that is not a fix.** `EnsureUIThread` is gated on `ObjCRuntime.Runtime.CheckForIllegalCrossThreadCalls`, which the ILLink substitution turns off for Release builds. The off-thread UIKit access still happens; you just lose the diagnostic. Testing in Release and declaring victory is how this ships to the App Store as an intermittent crash instead of a deterministic exception.

**Do not set `UIApplication.CheckForIllegalCrossThreadCalls = false`.** It silences every UI-thread assertion in your app, not just this one, and the underlying access is genuinely unsafe.

**Wrapping the call in `MainThread.InvokeOnMainThreadAsync` does nothing.** The thread is lost inside MAUI, after the picker's delegate returns, and the `ConfigureAwait(false)` there explicitly drops whatever context you established at the call site. Caller-side threading fixes cannot reach it, the same way they cannot reach [a deadlock caused by blocking on .Result deeper in the stack](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**`PickVideosAsync` is affected identically.** It routes through the same `PhotosAsync` helper and the same `PickerResultsToMediaFiles`. If your repro is videos rather than photos, it is the same bug.

**`PickPhotoAsync` (singular) is fine.** It shares the code path but produces exactly one `PHPickerResult`, so the loop never reaches a second read. If you see `UIKitThreadAccessException` from a single pick, you are looking at a different problem, usually your own continuation touching a control off the main thread.

**`SelectionLimit = 1` on `PickPhotosAsync` is also safe.** It is a workaround only in the sense that it removes multi-select, which is the feature you called this API for.

**Not the same as [dotnet/maui#33954](https://github.com/dotnet/maui/issues/33954).** That one, fixed in SR6, was `PickPhotosAsync` returning fewer images than selected when `CompressionQuality` was set. Different symptom, no exception, and already shipped.

**Android ANRs are a separate class of MAUI threading bug.** If your MAUI app is also blocking the UI thread on Android, that shows up as an ANR rather than an exception, and the diagnosis is completely different: see [finding the async void handlers causing ANRs in a MAUI Android app](/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Related

- [ConfigureAwait(false) vs default in .NET 11: does it still matter?](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Fix: deadlock when calling .Result or .Wait() on an async method in C#](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [How to find the async void handlers causing ANRs in a .NET MAUI Android app](/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)
- [Fix: provisioning profile doesn't include the currently selected device in MAUI iOS](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)

## Sources

- [dotnet/maui#37878 - MediaPicker.PickPhotosAsync throws UIKitThreadAccessException when 2 or more items are selected](https://github.com/dotnet/maui/issues/37878)
- [dotnet/maui#37879 - the fix](https://github.com/dotnet/maui/pull/37879), backported as [#38481](https://github.com/dotnet/maui/pull/38481) and [#38488](https://github.com/dotnet/maui/pull/38488)
- [dotnet/maui#35805 - the SR10 change that introduced the regression](https://github.com/dotnet/maui/pull/35805)
- [dotnet/macios - Runtime.EnsureUIThread and CheckForIllegalCrossThreadCalls](https://github.com/dotnet/macios/blob/main/src/ObjCRuntime/Runtime.cs)
- [Apple developer documentation - PHPickerViewController](https://developer.apple.com/documentation/photokit/phpickerviewcontroller)
- [Microsoft Learn - Media picker in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/device-media/picker)
