---
title: "Fix: UIKitThreadAccessException von MediaPicker.PickPhotosAsync beim Auswählen mehrerer Fotos unter .NET MAUI iOS"
description: "Die Auswahl von 2 oder mehr Fotos unter iOS wirft in MAUI 10.0.100 und 10.0.101 eine UIKitThreadAccessException. MAUI liest PHPickerResult.ItemProvider nach einem await, außerhalb des Hauptthreads. Auf 10.0.90 pinnen, auf 10.0.110 aktualisieren oder PHPicker selbst aufrufen."
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
lang: "de"
translationOf: "2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-09-16
---

Wenn `MediaPicker.PickPhotosAsync` unter iOS eine `UIKit.UIKitThreadAccessException` wirft, sobald der Benutzer 2 oder mehr Elemente auswählt, haben Sie eine .NET MAUI Regression aus 10.0.100 getroffen. MAUI liest `PHPickerResult.ItemProvider`, eine von UIKit geschützte Eigenschaft, innerhalb einer Schleife, die mit `ConfigureAwait(false)` wartet, sodass jede Iteration nach der ersten auf einem Thread aus dem Pool läuft. Nichts an der Aufrufstelle behebt das. Pinnen Sie `<MauiVersion>10.0.90</MauiVersion>`, wechseln Sie auf 10.0.110 (SR11) oder MAUI 11.0.0-rc.2, sobald diese erscheinen, oder rufen Sie `PHPickerViewController` selbst auf und lesen Sie die Item Provider vor dem ersten await. Genau ein Foto auszuwählen funktioniert immer, deshalb wirkt das Problem sporadisch, bis man das Muster erkennt.

## Der Fehler im Kontext

```text
UIKit.UIKitThreadAccessException: UIKit Consistency error: you are calling a UIKit method that can only be invoked from the UI thread.
   at UIKit.UIApplication.EnsureUIThread()
   at PhotosUI.PHPickerResult.get_ItemProvider()
   at Microsoft.Maui.Media.MediaPickerImplementation.PickerResultsToMediaFiles(PHPickerResult[] results, MediaPickerOptions options)
   at Microsoft.Maui.Media.MediaPickerImplementation.CompletePickerResultsAsync(PHPickerResult[] results, MediaPickerOptions options, TaskCompletionSource`1 tcs)
```

Betroffene Versionen, geprüft gegen die Release-Branches von `dotnet/maui`:

| MAUI-Version | Veröffentlicht | `PickPhotosAsync` mit 2+ Elementen |
| --- | --- | --- |
| 10.0.90 (SR9) | 2026-07-22 | funktioniert |
| 10.0.100 (SR10) | 2026-08-20 | wirft Exception |
| 10.0.101 | 2026-09-07 | wirft Exception |
| 11.0.0-rc.1 | 2026-09-08 | wirft Exception |
| 10.0.110 (SR11) | unveröffentlicht | behoben |
| 11.0.0-rc.2 | unveröffentlicht | behoben |

`PickPhotosAsync` und `PickVideosAsync` sind beide neu in .NET MAUI 10 ([dotnet/maui#6903](https://github.com/dotnet/maui/issues/6903)), es gibt also keine frühere Hauptversion, auf die man zurückfallen könnte. Android und Windows sind nicht betroffen: der fehlerhafte Code steht ausschließlich in `MediaPicker.ios.cs`.

## Warum das passiert

`PickPhotosAsync` zeigt unter iOS einen `PHPickerViewController`. Bestätigt der Benutzer, schließt MAUIs `PhotoPickerDelegate.DidFinishPicking` den Controller und ruft seinen Completion Handler aus dem Dismiss-Callback auf, der auf dem Hauptthread läuft. Dieser Handler ruft `PickerResultsToMediaFiles` auf, und in 10.0.100 sah diese Methode so aus:

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

`PHPickerResult.ItemProvider` ist mit einer `UIApplication.EnsureUIThread()`-Prüfung gebunden. Die erste Iteration ist unkritisch, weil der Delegate-Callback uns auf dem Hauptthread abgesetzt hat. Danach wird `LoadFileRepresentationAsync` mit `ConfigureAwait(false)` erwartet, was den erfassten Kontext verwirft, und die zweite Iteration liest `file.ItemProvider` auf dem Thread, auf dem die Fortsetzung gelandet ist.

Was das deterministisch statt zu einer Race Condition macht, steckt in `PHPickerFileResult`:

```csharp
// .NET MAUI 10.0.100, PHPickerFileResult.LoadFileRepresentationAsync
loadTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
```

`RunContinuationsAsynchronously` bedeutet, dass die Fortsetzung nie inline von dem Thread ausgeführt wird, der die `TaskCompletionSource` abschließt. Zusammen mit `ConfigureAwait(false)` gibt es keinen Weg zurück auf den Hauptthread, also passiert der zweite Lesezugriff immer im Pool. Deshalb ist der Fehler exakt reproduzierbar: 1 Element funktioniert immer, 2 oder mehr scheitern immer. Wer schon sporadische asynchrone Fehler gejagt hat, erlebt hier den umgekehrten Fall, und es lohnt sich zu verstehen, [was ConfigureAwait(false) tatsächlich verwirft](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/), bevor Sie nach einer Race Condition suchen, die es nicht gibt.

Das ist eine Regression aus [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) (".NET 10 SR10"), womit ein leerer `FullPath` bei PHPicker-Ergebnissen behoben wurde. Vor diesem PR wurden alle Provider in einem Zug materialisiert:

```csharp
// .NET MAUI 10.0.90 and earlier
var fileResults = results?
    .Select(file => (FileResult)new PHPickerFileResult(file.ItemProvider))
    .ToList() ?? [];
```

Jeder `ItemProvider` wurde vor dem ersten `await` gelesen, sodass die UIKit-Prüfung nie einen Thread aus dem Pool sah. Der Ersatz durch eine Schleife mit einem `await` darin hat das kaputt gemacht. Der Fehler wird als [dotnet/maui#37878](https://github.com/dotnet/maui/issues/37878) geführt, mit dem Label `regressed-in-10.0.100` und dem Meilenstein .NET 10 SR11.

## Minimale Reproduktion

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

Auf einem Simulator muss die Mediathek zuerst befüllt werden, sonst bleibt der Picker leer:

```bash
xcrun simctl addmedia booted photo1.png photo2.png photo3.png
```

Ein Foto auswählen: Sie bekommen ein `FileResult`. Zwei auswählen: Sie bekommen die Exception. Der `async void`-Handler ist hier nur deshalb vertretbar, weil jeder Pfad in einem `try` liegt, und das ist die einzige Form, in der [async void zu rechtfertigen ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Fix 1: über die Regression hinweg aktualisieren

Der Fix ist [dotnet/maui#37879](https://github.com/dotnet/maui/pull/37879), gemergt am 2026-08-27, als [#38481](https://github.com/dotnet/maui/pull/38481) nach `release/10.0.1xx-sr11` zurückportiert und als [#38488](https://github.com/dotnet/maui/pull/38488) nach `main` übernommen, beides am 2026-09-12. Der ausgelieferte Code liest nun alle Provider vor dem ersten await:

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

`NSItemProvider` ist ein Foundation-Typ ohne UI-Thread-Prüfung, das Halten der Provider über die awaits hinweg ist daher sicher. Derselbe PR schloss außerdem ein Speicherleck im Fehlerpfad: Ergebnisse, die nach der fehlschlagenden Iteration erzeugt wurden, blieben undisposed.

Stand 2026-09-16 sind weder 10.0.110 noch 11.0.0-rc.2 auf NuGet. Sobald 10.0.110 erscheint, ist es eine Änderung von einer Zeile:

```xml
<!-- Directory.Build.props or the app .csproj -->
<PropertyGroup>
  <MauiVersion>10.0.110</MauiVersion>
</PropertyGroup>
```

## Fix 2: auf 10.0.90 zurückpinnen

Bis SR11 erscheint, ist Pinnen die risikoärmste Option, sofern Sie auf nichts anderem aus SR10 aufbauen:

```xml
<!-- app .csproj, .NET 10 SDK -->
<PropertyGroup>
  <MauiVersion>10.0.90</MauiVersion>
</PropertyGroup>
```

Der Preis ist, dass Sie damit auch auf [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) verzichten, den `FullPath`-Fix. Unter 10.0.90 kann ein `FileResult` aus dem PHPicker-Pfad mit einem Pfad zurückkommen, unter dem keine Datei liegt, sodass `File.Copy(result.FullPath, ...)` fehlschlägt und Sie stattdessen über `await result.OpenReadAsync()` gehen müssen. Wenn Ihr Upload-Code ohnehin streamt statt über den Pfad zu kopieren, fällt Ihnen das nicht auf.

## Fix 3: PHPicker selbst aufrufen

Wenn Sie die Version nicht wechseln können, ersetzen Sie den iOS-Mehrfachauswahlpfad durch etwa sechzig Zeilen Interop. Der ganze Trick besteht darin, jeden `ItemProvider` innerhalb von `DidFinishPicking` zu lesen, bevor irgendetwas wartet.

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

Zwei Details sind wichtig. Die `NSUrl`, die der `LoadFileRepresentation`-Callback erhält, zeigt auf eine Datei, die das System löscht, sobald der Callback zurückkehrt, das Kopieren muss also synchron und innerhalb des Callbacks geschehen. Und `PickerDelegate` muss erreichbar bleiben; die Zuweisung an die typisierte `Delegate`-Eigenschaft hält eine verwaltete Referenz, aber bei einem Wechsel auf `WeakDelegate` müssen Sie die Instanz selbst halten, sonst wird sie mitten in der Auswahl eingesammelt.

Verloren geht alles, was `MediaPickerOptions` nach der Auswahl leistet: `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` und `PreserveMetaData` werden von MAUIs eigenem Nachbearbeitungsdurchlauf angewendet, nicht vom Picker. Wenn Sie diese brauchen, skalieren Sie nach dem Kopieren mit `SkiaSharp` oder `Microsoft.Maui.Graphics`.

## Fix 4: stattdessen FilePicker verwenden

`FilePicker.PickMultipleAsync` läuft über `UIDocumentPickerViewController` und `NSUrl[]` und berührt `PHPickerResult` nie, ist also nicht betroffen:

```csharp
// .NET MAUI 10.0.100, cross-platform
var files = await FilePicker.Default.PickMultipleAsync(new PickOptions
{
    PickerTitle = "Select images",
    FileTypes = FilePickerFileType.Images
});
```

Das ist ein anderes Erlebnis: die Dateien-App statt des Fotos-Rasters, keine Fotos-Berechtigungsabfrage und keine Behandlung von Live Photos oder HEIC. Als Überbrückung für "ein paar Bilder anhängen" ist das vertretbar, für alles rund um die Kamerarolle nicht.

## Fallstricke und ähnliche Fehlerbilder

**Ein Release-Build lässt die Exception verschwinden, und das ist kein Fix.** `EnsureUIThread` hängt an `ObjCRuntime.Runtime.CheckForIllegalCrossThreadCalls`, das die ILLink-Substitution in Release-Builds abschaltet. Der Zugriff auf UIKit außerhalb des Threads passiert weiterhin, Sie verlieren nur die Diagnose. In Release zu testen und Erfolg zu melden, ist der Weg, auf dem das als sporadischer Absturz statt als deterministische Exception in den App Store gelangt.

**Setzen Sie nicht `UIApplication.CheckForIllegalCrossThreadCalls = false`.** Das schaltet sämtliche UI-Thread-Prüfungen Ihrer App stumm, nicht nur diese, und der zugrunde liegende Zugriff ist tatsächlich unsicher.

**Den Aufruf in `MainThread.InvokeOnMainThreadAsync` zu verpacken bringt nichts.** Der Thread geht innerhalb von MAUI verloren, nachdem der Delegate des Pickers zurückkehrt, und das dortige `ConfigureAwait(false)` verwirft ausdrücklich jeden Kontext, den Sie an der Aufrufstelle gesetzt haben. Thread-Korrekturen auf Aufruferseite erreichen das nicht, genauso wenig wie sie [einen Deadlock durch Blockieren mit .Result weiter unten im Aufrufstapel](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) erreichen.

**`PickVideosAsync` ist identisch betroffen.** Es läuft über denselben `PhotosAsync`-Helfer und dasselbe `PickerResultsToMediaFiles`. Wenn Ihre Reproduktion Videos statt Fotos verwendet, ist es derselbe Fehler.

**`PickPhotoAsync` (Singular) ist in Ordnung.** Es teilt sich den Codepfad, erzeugt aber genau ein `PHPickerResult`, sodass die Schleife nie zu einem zweiten Lesezugriff kommt. Wenn Sie `UIKitThreadAccessException` bei einer Einzelauswahl sehen, liegt ein anderes Problem vor, üblicherweise Ihre eigene Fortsetzung, die ein Control außerhalb des Hauptthreads anfasst.

**`SelectionLimit = 1` bei `PickPhotosAsync` ist ebenfalls sicher.** Es ist nur in dem Sinn ein Workaround, dass es die Mehrfachauswahl entfernt, also genau die Funktion, wegen der Sie diese API aufgerufen haben.

**Nicht dasselbe wie [dotnet/maui#33954](https://github.com/dotnet/maui/issues/33954).** Dort gab `PickPhotosAsync` weniger Bilder zurück als ausgewählt, wenn `CompressionQuality` gesetzt war; behoben in SR6. Anderes Symptom, keine Exception, und bereits ausgeliefert.

**Android-ANRs sind eine andere Klasse von Thread-Fehlern in MAUI.** Wenn Ihre MAUI-App auch unter Android den UI-Thread blockiert, zeigt sich das als ANR statt als Exception, und die Diagnose verläuft völlig anders: siehe [wie Sie die async void Handler finden, die ANRs in einer .NET MAUI Android App verursachen](/de/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Verwandt

- [ConfigureAwait(false) vs. Standard in .NET 11: spielt das noch eine Rolle?](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [async void vs. async Task in C#: wann was richtig ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Fix: Deadlock beim Aufruf von .Result oder .Wait() auf einer asynchronen Methode in C#](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Wie Sie die async void Handler finden, die ANRs in einer .NET MAUI Android App verursachen](/de/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)
- [Fix: Das Provisioning Profile enthält das aktuell ausgewählte Gerät unter MAUI iOS nicht](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)

## Quellen

- [dotnet/maui#37878 - MediaPicker.PickPhotosAsync wirft UIKitThreadAccessException, wenn 2 oder mehr Elemente ausgewählt sind](https://github.com/dotnet/maui/issues/37878)
- [dotnet/maui#37879 - der Fix](https://github.com/dotnet/maui/pull/37879), zurückportiert als [#38481](https://github.com/dotnet/maui/pull/38481) und [#38488](https://github.com/dotnet/maui/pull/38488)
- [dotnet/maui#35805 - die SR10-Änderung, die die Regression eingeführt hat](https://github.com/dotnet/maui/pull/35805)
- [dotnet/macios - Runtime.EnsureUIThread und CheckForIllegalCrossThreadCalls](https://github.com/dotnet/macios/blob/main/src/ObjCRuntime/Runtime.cs)
- [Apple Developer Dokumentation - PHPickerViewController](https://developer.apple.com/documentation/photokit/phpickerviewcontroller)
- [Microsoft Learn - Media Picker in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/device-media/picker)
