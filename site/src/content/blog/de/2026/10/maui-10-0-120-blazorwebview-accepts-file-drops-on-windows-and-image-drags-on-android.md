---
title: "MAUI 10.0.120: BlazorWebView akzeptiert endlich Datei-Drops unter Windows und Bild-Drags unter Android"
description: ".NET MAUI 10.0.120 aktiviert AllowDrop für das Windows-BlazorWebView und registriert unter Android den AndroidX-DropDataContentProvider, sodass Drop-Zonen in Blazor Hybrid ohne Plattformcode funktionieren. Hier steht, was sich geändert hat, der neue Schalter MauiEnableAndroidWebViewDragDrop und die Warnung MAUI1002."
pubDate: 2026-10-22
tags:
  - "maui"
  - "blazor"
  - "blazor-hybrid"
  - "dotnet"
lang: "de"
translationOf: "2026/10/maui-10-0-120-blazorwebview-accepts-file-drops-on-windows-and-image-drags-on-android"
translatedBy: "claude"
translationDate: 2026-10-22
---

[.NET MAUI 10.0.120](https://github.com/dotnet/maui/releases/tag/10.0.120) ist am 21. Oktober 2026 mit 213 Commits erschienen. Das meiste davon sind Fehlerbehebungen, aber zwei Änderungen am BlazorWebView beseitigen einen Workaround, den jede Blazor-Hybrid-App mit einem Feld "Dateien hier ablegen" seit .NET 6 mitschleppt: Eine Datei, die unter Windows aus dem Explorer auf ein `BlazorWebView` gezogen wird, erreicht jetzt das HTML-Drop-Ziel, und Bilder, die unter Android innerhalb eines `BlazorWebView` gezogen werden, liefern jetzt echte Drag-Daten.

## Windows: AllowDrop ist jetzt standardmäßig aktiv

Bisher hat der Windows-Handler sein WinUI-`WebView2` mit `AllowDrop` auf `false` erstellt. Das DOM bekam für Dateien von außerhalb der App nie ein `drop`-Ereignis, sodass eine Blazor-Drop-Zone, die im Browser funktionierte, im Desktop-Build stillschweigend nichts tat. Üblicherweise behalf man sich mit einem eigenen Handler-Mapping. [PR #37904](https://github.com/dotnet/maui/pull/37904) ändert `BlazorWebViewHandler.CreatePlatformView` wie folgt:

```csharp
protected override WebView2Control CreatePlatformView()
{
    return new WebView2Control
    {
        AllowDrop = true,
    };
}
```

Damit funktioniert ein einfaches `InputFile`, das über eine Ablagefläche gelegt wird, unter Windows ohne jeden Plattformcode:

```razor
<div class="dropzone">
    <InputFile OnChange="OnFilesDropped" multiple />
    <p>Drop files here</p>
</div>

@code {
    async Task OnFilesDropped(InputFileChangeEventArgs e)
    {
        foreach (var file in e.GetMultipleFiles(maxAllowedFiles: 10))
        {
            await using var stream = file.OpenReadStream(maxAllowedSize: 20 * 1024 * 1024);
            // save or process the stream
        }
    }
}
```

Wenn Sie einen Mapper geschrieben haben, der `AllowDrop = true` selbst setzt, können Sie ihn nach dem Upgrade löschen. Eine Einschränkung bleibt: Das native Ziehen von Elementen und Bildern innerhalb der Seite funktioniert unter Windows mit der aktuellen Abhängigkeit von Windows App SDK 1.8 in MAUI weiterhin nicht. Der PR-Autor hat Windows App SDK 2.0.1 getestet und festgestellt, dass diese Szenarien dort funktionieren, sobald `AllowDrop` aktiv ist. Diese Einstellung ist also auch eine Vorarbeit für den Wechsel.

## Android: DropDataContentProvider wird für Sie registriert

Unter Android löste das Ziehen eines `<img>` in einem `BlazorWebView` zwar DOM-Drag-Ereignisse aus, enthielt aber keine verwendbaren Bilddaten. Dafür benötigt der Android WebView den `DropDataContentProvider` aus AndroidX WebKit im Manifest. [PR #37975](https://github.com/dotnet/maui/pull/37975) lässt `Microsoft.AspNetCore.Components.WebView.Maui` für Android-Ziele von `Xamarin.AndroidX.WebKit` 1.16.0.1 abhängen und führt diesen Provider über ein `AndroidManifestOverlay` in Ihr Manifest ein:

```xml
<provider
  android:name="androidx.webkit.DropDataContentProvider"
  android:authorities="${applicationId}.DropDataProvider"
  android:exported="false"
  android:grantUriPermissions="true" />
```

Wenn Ihre App denselben Provider bereits deklariert, werden die beiden Einträge zu einem zusammengeführt. Wenn Sie ihn mit einer anderen Konfiguration deklarieren, schalten Sie die automatische Registrierung ab:

```xml
<PropertyGroup>
  <MauiEnableAndroidWebViewDragDrop>false</MauiEnableAndroidWebViewDragDrop>
</PropertyGroup>
```

Diese Eigenschaft steuert nur den Manifest-Eintrag. Die Paketreferenz auf `Xamarin.AndroidX.WebKit` bleibt in jedem Fall bestehen.

## Auf MAUI1002 achten

Projekte, die weiterhin `<AndroidManifestMerger>legacy</AndroidManifestMerger>` setzen, sehen jetzt die Warnung `MAUI1002`, weil der Legacy-Merger `AndroidManifestOverlay`-Elemente ignoriert und der Provider nie im Manifest landet. Wechseln Sie entweder zu `manifestmerger.jar` (dem Standard) oder setzen Sie `MauiEnableAndroidWebViewDragDrop` auf `false` und deklarieren Sie den Provider selbst in `Platforms/Android/AndroidManifest.xml`. Wenn Sie mit "Warnungen als Fehler" kompilieren, ist dies die eine Zeile in 10.0.120, die Ihre CI brechen kann.

## Aktualisieren

Aktualisieren Sie `Microsoft.Maui.Controls` und `Microsoft.AspNetCore.Components.WebView.Maui` auf `10.0.120`, beide sind bereits auf NuGet verfügbar. Dasselbe Release setzt außerdem die Leck-Bereinigung fort, die ich im [Beitrag zu 10.0.110](/de/2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter/) behandelt habe, darunter ein `BlazorWebView`-Leck unter iOS, bei dem `DisconnectHandlers()` Seiten innerhalb einer `Shell` nie erreichte.
