---
title: "Lösung: MediaPicker.CapturePhotoAsync liefert in .NET MAUI 10 ein PNG statt eines JPEG"
description: "Unter iOS kodiert MAUI 10 Kamerafotos als PNG neu, sobald CompressionQuality 90 oder höher ist und kein MaximumWidth/Height gesetzt ist, was auch den Standardwert einschließt. Setzen Sie CompressionQuality auf 89 oder niedriger, oder fügen Sie nur unter iOS ein MaximumWidth hinzu."
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
lang: "de"
translationOf: "2026/09/fix-mediapicker-capturephotoasync-returns-png-instead-of-jpeg-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-27
---

Wenn `MediaPicker.Default.CapturePhotoAsync()` in .NET MAUI 10 Ihnen eine `3f2c9a....png` mit dem `ContentType` `image/png` zurückgibt, hat nicht die Kamera ein PNG erzeugt, sondern MAUI. Unter iOS übergibt der Kamerapfad MAUI ein dekodiertes `UIImage`, und MAUI 10 kodiert es mit `AsPNG()` neu, sobald `CompressionQuality` 90 oder höher ist und weder `MaximumWidth` noch `MaximumHeight` gesetzt ist. Die Standardqualität ist 100, daher liefert ein Aufruf ohne Optionen immer ein PNG. Die Lösung, die auf jeder Plattform und in jedem 10.x- und 11-Build funktioniert, ist `new MediaPickerOptions { CompressionQuality = 85 }` (jeder Wert von 0 bis 89). Wenn Sie stattdessen das JPEG mit der höchsten Qualität unter iOS möchten, behalten Sie die Qualität 100 bei und setzen Sie nur unter iOS ein überdimensioniertes `MaximumWidth`. Unter Android und Windows liefert eine Qualität von 95 bis 99 ebenfalls PNG-Bytes, und unter Windows behalten diese sogar einen `.jpg`-Namen.

## Der Fehler im Kontext

Hier gibt es keine Exception. Das Symptom ist eine Datei, die Sie nicht angefordert haben:

```text
// .NET 10, Microsoft.Maui.Essentials 10.0.110, iPhone, CapturePhotoAsync() with no options
FileName:    6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png
ContentType: image/png
First bytes: 89 50 4E 47 0D 0A 1A 0A
```

Suchanfragen dazu beginnen meist weiter hinten in der Pipeline: Ein Upload-Endpunkt, der nur `image/jpeg` akzeptiert, lehnt die Datei mit 415 ab, ein Blob-Storage-Bucket füllt sich mit PNGs von mehreren Megabyte, ein Bildskalierer auf dem Server verschluckt sich an RGBA-Eingaben, oder EXIF-Daten, die das Backend erwartet (Aufnahmezeit, GPS), fehlen. Alle vier gehen auf dieselbe Zeile im MAUI-Code zurück.

Das liefert jeder `CapturePhotoAsync`-Aufruf, entnommen aus den `MediaPicker`-Quellen am jeweiligen Release-Tag:

| Optionen | iOS, MAUI 10.0.0 bis 10.0.51 | iOS, MAUI 10.0.60 bis 10.0.110 und 11.0 RC 1/RC 2 | Android, alle 10.x und 11 RC | Windows, alle 10.x und 11 RC |
| --- | --- | --- | --- | --- |
| keine (Qualität 100) | PNG | PNG | Kamera-JPEG, unverändert | Kamera-JPEG, unverändert |
| `CompressionQuality` 95 bis 99 | PNG | PNG | PNG | PNG-Bytes mit Namen `.jpg` |
| `CompressionQuality` 90 bis 94 | JPEG, Qualität 0,9 | PNG | JPEG, neu kodiert | JPEG, neu kodiert |
| `CompressionQuality` 0 bis 89 | JPEG, Qualität q/100 | JPEG, Qualität q/100 | JPEG, neu kodiert | JPEG, neu kodiert |
| Qualität 100 + `MaximumWidth` | JPEG, Qualität 0,95 | JPEG, Qualität 0,95 | PNG | PNG-Bytes mit Namen `.jpg` |
| Qualität 95 bis 99 + `MaximumWidth` | JPEG, Qualität 0,9 | JPEG, Qualität 0,9 | PNG | PNG-Bytes mit Namen `.jpg` |

Zwei Dinge fallen auf. Die einzige Einstellung, die in jeder Spalte ein JPEG liefert, ist eine Qualität von 89 oder niedriger. Und die iOS-Regel wurde in 10.0.60 (SR6) strenger, sodass eine App, die unter 10.0.51 `CompressionQuality = 90` verwendete, um JPEGs zu erhalten, nach einem routinemäßigen MAUI-Update PNGs bekam.

## Warum MAUI 10 ein Kamerafoto in ein PNG verwandelt

`CapturePhotoAsync` zeigt unter iOS einen `UIImagePickerController` mit der Kamera als Quelle an. Ein gerade aufgenommenes Foto liegt noch nicht in der Fotomediathek, daher gibt es kein `PHAsset`, aus dem sich die originalen HEIC- oder JPEG-Bytes lesen ließen. MAUI greift auf den Eintrag `UIImagePickerController.OriginalImage` zurück, ein dekodiertes `UIImage`, und verpackt es in ein internes `CompressedUIImageFileResult`. Diese Klasse muss ein Dateiformat wählen, ohne einen originalen Dateinamen als Anhaltspunkt zu haben, und das geschieht in `ShouldUsePngFormat`:

```csharp
// .NET MAUI 10.0.110, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
bool ShouldUsePngFormat()
{
    bool originalWasPng = !string.IsNullOrEmpty(originalFileName) &&
        Path.GetExtension(originalFileName).Equals(".png", StringComparison.OrdinalIgnoreCase);

    return originalWasPng || (compressionQuality >= 90 && !maximumWidth.HasValue && !maximumHeight.HasValue);
}
```

Bei einer Kameraaufnahme ist `originalFileName` gleich `null`, also entscheidet allein die zweite Hälfte. `MediaPickerOptions.CompressionQuality` hat den Standardwert 100, womit "keine Optionen" bei `workingImage.AsPNG()` landet. Der Dateiname besteht aus einer `Guid` plus `.png`, und `FileResult.ContentType` wird aus dieser Endung abgeleitet, sodass alles Nachgelagerte übereinstimmend von einem PNG ausgeht.

Das ist weniger ein neues Verhalten als ein Überbleibsel. In MAUI 9 und früher nutzte derselbe Kamerapfad ein `UIImageFileResult`, das immer `AsPNG()` aufrief, ganz ohne Optionen (siehe [dotnet/maui#11379](https://github.com/dotnet/maui/issues/11379) aus dem Jahr 2022). MAUI 10 fügte `MediaPickerOptions` die Eigenschaften `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` und `PreserveMetaData` hinzu und behielt PNG als Ausgabe für "höchste Qualität" bei. Bis 10.0.51 lag der Schwellenwert bei 95. [dotnet/maui#33119](https://github.com/dotnet/maui/issues/33119) wies darauf hin, dass die Methode einen Schwellenwert von 90 berechnete und dann einen von 95 zurückgab, und [PR #33140](https://github.com/dotnet/maui/pull/33140) (Meilenstein .NET 10 SR6, erstmals ausgeliefert in 10.0.60 auf NuGet am 2026-04-29) legte sich auf 90 fest. Derselbe Code steckt im Tag `11.0.100-rc.1.26458.5` und im Branch `release/11.0.1xx-rc2`.

Android und Windows gehen einen anderen Weg. Dort schreibt die Kamera eine echte JPEG-Datei (`Guid.jpg` unter Android, eine `CameraCaptureUIPhotoFormat.Jpeg`-Aufnahme unter Windows), und MAUI rührt sie nur an, wenn `ImageProcessor.IsProcessingNeeded` true ist, also bei einer Qualität unter 100 oder einer maximalen Abmessung. Das gemeinsame `ImageProcessor.ProcessImageAsync` wählt das Format dann nach seiner eigenen Regel, `qualityPercent >= 95 || (qualityPercent >= 90 && originalWasPng)`, die die Größenoptionen vollständig ignoriert. Unter Android wandelt eine Qualität von 97 das Kamera-JPEG also in ein PNG um, während unter iOS eine Qualität von 97 mit einem `MaximumWidth` das nicht tut. Dasselbe Optionsobjekt, unterschiedliche Dateiformate. Windows fügt noch eine Wendung hinzu: Sein `ProcessedImageFileResult` benennt die Ausgabe mit `ImageProcessor.DetermineOutputExtension(imageData, 75, originalFileName)`, einer fest kodierten 75 statt Ihrer Qualität, sodass die PNG-Bytes einen `.jpg`-Namen und den Content Type `image/jpeg` erhalten.

## Minimale Reproduktion

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110, run on a physical iPhone
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
if (photo is null) return; // user cancelled

Console.WriteLine($"{photo.FileName} | {photo.ContentType}");
// 6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png | image/png
```

Der iOS Simulator hat keine Kamera (`IsCaptureSupported` ist dort false), daher braucht es ein echtes Gerät. Falls Sie noch keines für ein MAUI-Projekt eingerichtet haben, behandelt die [Lösung zum Provisioning Profile für MAUI iOS](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) die übliche erste Hürde.

## Lösung 1: CompressionQuality auf 89 oder niedriger setzen

Das ist die Empfehlung für fast jede App. Es ist eine Zeile, sie erzeugt ein JPEG unter iOS, Android und Windows und verhält sich in jedem MAUI 10 Servicing-Release und in MAUI 11 RC 1 gleich:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(new MediaPickerOptions
{
    CompressionQuality = 85,
});
```

Unter iOS ruft das `UIImage.AsJPEG(0.85f)` auf dem orientierungsnormalisierten Bild auf. Unter Android und Windows lädt es das Kamera-JPEG über Microsoft.Maui.Graphics und speichert es erneut als JPEG mit Qualität 0,85. Eine Qualität von 85 ist bei Fotos in typischen Smartphone-Anzeigegrößen optisch nicht vom Original zu unterscheiden und verringert die Dateigröße deutlich gegenüber einem verlustfreien PNG derselben Pixel. Wenn Sie vor dem Upload zusätzlich die Auflösung begrenzen möchten, fügen Sie `MaximumWidth` und `MaximumHeight` hinzu. Bei einer Qualität unter 90 ändern sie auf keiner Plattform das Format.

"Beheben" Sie das Problem nicht mit einer Qualität von 90 bis 94. Dieser Bereich ergab unter iOS bis 10.0.51 ein JPEG und wurde in 10.0.60 zu einem PNG, genau die Art von Einstellung, die beim nächsten Workload-Update stillschweigend bricht.

## Lösung 2: Maximale Qualität unter iOS mit einem überdimensionierten MaximumWidth erhalten

Wenn Sie das am wenigsten verlustbehaftete JPEG benötigen, das MAUI erzeugt, gibt es eine wissenswerte Eigenheit: Unter iOS deaktiviert jedes gesetzte `MaximumWidth` oder `MaximumHeight` den PNG-Zweig, und MAUI skaliert nie hoch (`CalculateResizedDimensions` begrenzt den Skalierungsfaktor auf 1). Mit Qualität 100 ergibt das `AsJPEG(0.95f)` in voller Auflösung. Unter Android und Windows würden dieselben Optionen das Gegenteil bewirken und ein PNG erzeugen, und dort ist das unveränderte Kamera-JPEG aus einem einfachen Aufruf bereits das, was Sie wollen. Verzweigen Sie daher nach Plattform:

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

Das stützt sich auf ein Implementierungsdetail von `ShouldUsePngFormat`, betrachten Sie es also als Workaround und prüfen Sie die Tabelle oben erneut, wenn Sie auf ein neues MAUI-Release wechseln. Lösung 1 hat keine solche Abhängigkeit.

## Lösung 3: Der Dateiendung nachgelagert nicht mehr vertrauen

Selbst mit korrigierten Optionen ist eine MAUI-App nur ein Client, und unter Windows kann der Dateiname in die andere Richtung falsch sein. Alles, was Fotos entgegennimmt, sollte die Bytes prüfen, nicht den Dateinamen. JPEG beginnt mit `FF D8 FF`, PNG mit der 8-Byte-Signatur `89 50 4E 47 0D 0A 1A 0A`:

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

Verwenden Sie den erkannten Typ beim Aufbau des Uploads, damit der Server einen ehrlichen `Content-Type` sieht, auch bei Fotos aus einer älteren App-Version, die noch PNGs sendet:

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

Wenn der Server die Datei neben einer Datenbankzeile im Blob Storage ablegt, behandelt der [Beitrag zur Konsistenz von Datenbankschreibvorgang und Blob-Upload](/de/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/), was zu tun ist, wenn einer der beiden fehlschlägt.

Der gesamte C#-Code oben kompiliert gegen `Microsoft.Maui.Essentials` 10.0.110 mit dem .NET 10.0.302 SDK. Die Formattabelle stammt aus dem Lesen von `MediaPicker.ios.cs`, `MediaPicker.android.cs`, `MediaPicker.windows.cs` und `ImageProcessor.shared.cs` an den Tags `10.0.0`, `10.0.51`, `10.0.60`, `10.0.110` und `11.0.100-rc.1.26458.5`, nicht aus einer Gerätematrix. Wenn Ihr Gerät also etwas anderes zeigt, ist der Tag, den Sie tatsächlich verwenden, das Erste, was Sie prüfen sollten (`dotnet list package --include-transitive | grep Maui`).

## Stolperfallen, die mit dem PNG einhergehen

**EXIF fehlt bei iOS-Aufnahmen, egal was `PreserveMetaData` sagt.** `CompressedUIImageFileResult` wird allein aus dem `UIImage` erzeugt, und `PreserveMetaData` wird nie an es übergeben. `AsPNG()` und `AsJPEG()` auf einem `UIImage` schreiben keine Kamera-Metadaten, sodass Aufnahmezeit, GPS und Objektivdaten mit keiner der Lösungen in der Datei landen. Wenn Sie sie benötigen, lesen Sie das Dictionary `UIImagePickerController.MediaMetadata` selbst in einem eigenen Picker aus, oder erfassen Sie Zeitstempel und Standort in der App, wenn die Aufnahme abgeschlossen ist. Das Auswählen eines vorhandenen Fotos (`PickPhotoAsync`) läuft über `PHPicker` und das originale Asset, also einen anderen Pfad. [dotnet/maui#36581](https://github.com/dotnet/maui/issues/36581) verfolgt ordentliche Metadaten-APIs für .NET 12.

**Gedrehte Fotos werden zu RGBA.** Ein Hochformatfoto von der iPhone-Kamera kommt als Querformat-Bitmap mit `UIImageOrientation.Right` an. MAUI ruft vor dem Kodieren immer `NormalizeOrientation()` auf, das das Bild mit einem `UIGraphicsImageRenderer` neu zeichnet, dessen Format `Opaque = false` hat. Das Ergebnis trägt einen Alphakanal, den es nicht braucht, und ein PNG davon ist noch größer. Der Vorteil ist, dass die Pixel bereits aufrecht stehen, sodass `RotateImage = true` für iOS-Aufnahmen nicht nötig ist.

**`SaveToGallery` in MAUI 11 speichert ebenfalls das PNG.** MAUI 11 fügt `MediaPickerOptions.SaveToGallery` für Aufnahmeaufrufe hinzu. Unter iOS schreibt es dasselbe `FileResult`, das MAUI Ihnen zurückgibt, in eine temporäre Datei und übergibt sie an `PHAssetChangeRequest.FromImage`. Mit Standardoptionen landet also ein PNG in der Fotomediathek des Benutzers. Setzen Sie eine Qualität unter 90, und auch die Kopie in der Galerie ist ein JPEG.

**`PickPhotoAsync` kann aus einem anderen Grund PNGs liefern.** Wählt der Benutzer einen Screenshot, ist das Original tatsächlich ein PNG, und MAUI behält es bei einer Qualität von 90 oder höher absichtlich als PNG bei (`originalWasPng`). Das ist nicht dieser Fehler; erkennen Sie das Format wie in Lösung 3 und behandeln Sie beide Fälle.

**Die Mehrfachauswahl unter iOS hat ihr eigenes 10.0.100-Problem.** Wenn `PickPhotosAsync` eine Exception auslöst, sobald der Benutzer mehrere Bilder auswählt, handelt es sich um die [UIKitThreadAccessException-Regression aus MediaPicker.PickPhotosAsync](/de/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), behoben in 10.0.110.

## Verwandte Beiträge

- [Lösung: UIKitThreadAccessException aus MediaPicker.PickPhotosAsync in .NET MAUI iOS](/de/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) behandelt die andere MediaPicker-Regression in der 10.0.1xx-Reihe.
- [Neuerungen in .NET MAUI 10](/de/2025/04/whats-new-in-net-maui-10/) für den Rest des Releases, mit dem die neuen Picker-Optionen ausgeliefert wurden.
- [Lösung: Provisioning Profile enthält das aktuell ausgewählte Gerät nicht](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/), um Kamera-Code auf ein echtes iPhone zu bringen.
- [Datenbankschreibvorgang und Azure-Blob-Upload in einer Anfrage konsistent halten](/de/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) für die Serverseite eines Foto-Uploads.

## Quellen

- [Media Picker für Fotos und Videos, .NET MAUI-Dokumentation (MS Learn)](https://learn.microsoft.com/dotnet/maui/platform-integration/device-media/picker?view=net-maui-10.0)
- [`MediaPicker.ios.cs` am Tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/MediaPicker.ios.cs)
- [`ImageProcessor.shared.cs` am Tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/ImageProcessor.shared.cs)
- [dotnet/maui#33119: MediaPicker ShouldUsePngFormat method has conflicting/redundant code](https://github.com/dotnet/maui/issues/33119)
- [dotnet/maui#33140: Refactor image rotation and PNG format logic](https://github.com/dotnet/maui/pull/33140)
- [dotnet/maui#11379: CapturePhotoAsync returns PNG in which the orientation data is lost](https://github.com/dotnet/maui/issues/11379)
- [dotnet/maui#36581: Add image metadata APIs and non-destructive MediaPicker processing](https://github.com/dotnet/maui/issues/36581)
