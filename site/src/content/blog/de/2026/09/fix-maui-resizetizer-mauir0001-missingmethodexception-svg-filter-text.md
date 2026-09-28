---
title: "Fix: MAUIR0001 MissingMethodException im .NET MAUI Resizetizer bei einem SVG mit <filter> oder <text>"
description: "Der MAUI 10.0.101 und 10.0.110 Resizetizer liefert nicht zueinander passende System.Memory-Referenzen aus, wodurch SVGs mit Filtern oder Text fehlschlagen. Pinnen Sie Resizetizer auf 10.0.100 oder entfernen Sie Filter und Text."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "msbuild"
  - "csharp"
lang: "de"
translationOf: "2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text"
translatedBy: "claude"
translationDate: 2026-09-28
---

Wenn Ihr .NET MAUI 10-Build mit `error MAUIR0001: There was an exception processing the image` und einer `System.MissingMethodException` für `SKImageFilter.CreateMatrixConvolution`, `SKTextBlobBuilder.AddPositionedRun` oder `SKTypeface.Clone` fehlschlägt, liegt die Ursache im Resizetizer-Paket selbst, nicht in Ihrem SVG. `Microsoft.Maui.Resizetizer` 10.0.101 und 10.0.110 bündeln einen SkiaSharp 4.150.1-Build, der `System.Memory` 4.0.5.0 verlangt, neben einem `Svg.Skia`, das 4.0.2.0 verlangt, und MSBuild lädt zwei unterschiedliche `ReadOnlySpan<T>`-Typen. Jedes SVG, das ein `<filter>`- oder `<text>`-Element verwendet, stürzt ab. Der schnellste Fix ist, `Microsoft.Maui.Resizetizer` auf 10.0.100 zu pinnen, während der Rest von MAUI auf 10.0.110 bleibt; der dauerhafte Fix ist, Filter zu entfernen und Text in Pfade umzuwandeln in Ihren `MauiIcon`-, `MauiSplashScreen`- und `MauiImage`-SVGs.

## Der Fehler im Kontext

Zwei Varianten des Fehlers wurden Upstream gemeldet. Die Filter-Variante, aus [dotnet/maui#38319](https://github.com/dotnet/maui/issues/38319):

```text
error MAUIR0001: There was an exception processing the image '...\Resources\AppIcon\appicon.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKImageFilter SkiaSharp.SKImageFilter.CreateMatrixConvolution(
    SkiaSharp.SKSizeI, System.ReadOnlySpan`1<Single>, Single, Single,
    SkiaSharp.SKPointI, SkiaSharp.SKShaderTileMode, Boolean, SkiaSharp.SKImageFilter)'.
   at Svg.Skia.SkiaModel.ToSKImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.GetRenderImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.CreateRenderPaint(SKPaint paint)
   at Svg.Skia.SKSvg.Load(String path)
   at Microsoft.Maui.Resizetizer.SkiaSharpSvgTools..ctor(...)
```

Die Text-Variante auf 10.0.101, aus [dotnet/maui#38507](https://github.com/dotnet/maui/issues/38507):

```text
error MAUIR0001: There was an exception processing the image '.../Resources/Images/place_capsule.svg'.
System.MissingMethodException: Method not found: 'Void SkiaSharp.SKTextBlobBuilder.AddPositionedRun
(System.ReadOnlySpan`1<UInt16>, SkiaSharp.SKFont, System.ReadOnlySpan`1<SkiaSharp.SKPoint>)'.
```

Auf 10.0.110 wechselte die Text-Variante zu einer anderen Methode, weil 10.0.110 `Svg.Skia` von 5.1.1 auf 5.2.3 angehoben hat und die neue Version Schriftarten anders auflöst. Das erhalte ich auf 10.0.110 mit einem einfachen `<text>`-Element:

```text
error MAUIR0001: There was an exception processing the image '.../text.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKTypeface SkiaSharp.SKTypeface.Clone(System.ReadOnlySpan`1<SkiaSharp.SKFontVariationPositionCoordinate>)'.
   at Svg.Skia.SkiaModel.ApplyVariableFontWeight(SKTypeface typeface, SKFontStyle style)
   at Svg.Skia.SkiaModel.ResolveSKTypeface(SKTypeface typeface)
   at Svg.Skia.SkiaModel.ToSKFont(SKPaint paint)
```

Ein Kommentar zu #38507 berichtet außerdem von einer `HarfBuzzSharp.Font.SetVariations(ReadOnlySpan<Variation>)`-Variante derselben Exception aus dem iOS-Schritt `GenerateSplashStoryboard`. Unabhängig vom Methodennamen: Schauen Sie sich die Signatur an, jede von ihnen nimmt einen `ReadOnlySpan<T>` entgegen. Das ist der ganze Bug.

## Warum der Resizetizer eine Methode nicht findet, die existiert

Das Erste, was jeder tut, ist `SkiaSharp.dll` in einem Decompiler zu öffnen und die Methode dort vorzufinden. Der Melder von #38507 hat genau das getan und per Reflection bestätigt, dass `AddPositionedRun(ReadOnlySpan<ushort>, SKFont, ReadOnlySpan<SKPoint>)` vorhanden ist. Ich habe dasselbe mit `System.Reflection.Metadata` gegen den `buildTransitive`-Ordner jeder Paketversion gemacht, und es stimmt: Die Methoden existieren in 10.0.100, 10.0.101 und 10.0.110.

Der Unterschied liegt in den Assembly-Referenzen. Hier ist, was jede gebündelte Assembly verlangt:

| Resizetizer | SkiaSharp.dll (TFM) | SkiaSharp verlangt System.Memory | Svg.Skia verlangt System.Memory | Ausgelieferte System.Memory.dll |
|---|---|---|---|---|
| 10.0.100 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |
| 10.0.101 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 10.0.110 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 11.0.0-rc.1 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |

Die SkiaSharp-Anhebung kam über [dotnet/maui#37731](https://github.com/dotnet/maui/pull/37731) ("Update SkiaSharp to 4.150.1"), die auf den 10.0.1xx-Servicing-Branch zurückportiert wurde und in 10.0.101 ausgeliefert wurde.

Schauen wir uns nun an, wie `dotnet build` die Abhängigkeiten einer Task lädt. MSBuild unter .NET packt jede Task-Assembly in ihren eigenen `MSBuildLoadContext`. Wenn eine Abhängigkeit angefordert wird, durchsucht es den Ordner der Task, und in [`MSBuildLoadContext.Load`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs) überspringt es die lokale Datei, wenn die lokale Version niedriger ist als die angeforderte:

```csharp
// dotnet/msbuild main, src/Framework/Loader/MSBuildLoadContext.cs (abridged)
AssemblyName candidateAssemblyName = AssemblyLoadContext.GetAssemblyName(candidatePath);
if (candidateAssemblyName.Version < assemblyName.Version)
{
    continue;
}
return LoadFromAssemblyPath(candidatePath);
```

Also in 10.0.101 und 10.0.110:

1. `Svg.Skia` verlangt `System.Memory` 4.0.2.0. Der Task-Ordner enthält 4.0.2.0, also lädt MSBuild diese Datei in den Plugin-Kontext. Diese `System.Memory.dll` ist der Out-of-Band-netstandard2.0-Paket-Build, der **seinen eigenen** `System.ReadOnlySpan<T>`-Typ definiert.
2. `SkiaSharp` verlangt `System.Memory` 4.0.5.0. Die lokale 4.0.2.0 ist zu alt, also fällt die Suche in den Default-Kontext durch, der die `System.Memory`-Facade des Shared Frameworks auflöst. Diese Facade leitet `ReadOnlySpan<T>` per Type-Forwarding an `System.Private.CoreLib` weiter.
3. `Svg.Skia` kompiliert einen Aufruf von `SKImageFilter.CreateMatrixConvolution(..., ReadOnlySpan<float> [from System.Memory.dll], ...)`. `SkiaSharp` stellt `CreateMatrixConvolution(..., ReadOnlySpan<float> [from CoreLib], ...)` bereit. Gleicher Name, gleicher Text, andere Typidentität. Die Runtime kann das nicht binden und wirft `MissingMethodException`, wenn sie die aufrufende Methode JIT-kompiliert.

Das erklärt auch, warum der #38319-Trace `CreateMatrixConvolution` nennt, obwohl das Repro-SVG nur `feGaussianBlur` verwendet: Die Exception tritt auf, wenn `Svg.Skia.SkiaModel.ToSKImageFilter` JIT-kompiliert wird, und diese Methode enthält den Aufruf für jede Filter-Primitive. Jedes SVG mit einem beliebigen `<filter>` erreicht sie. SVGs ohne Filter oder Text berühren beim Rastern nie eine SkiaSharp-API, die einen Span entgegennimmt, weshalb das Standard-Template-Icon weiterhin kompiliert.

Um den Mechanismus zu belegen, habe ich den `buildTransitive`-Ordner von 10.0.110 kopiert, nur `System.Memory.dll` gelöscht und die Task auf die Kopie zeigen lassen. Beide fehlschlagenden SVGs wurden einwandfrei gerastert, weil jetzt jede Anfrage nach `System.Memory` bei der Framework-Facade landet und es nur einen `ReadOnlySpan<T>` gibt. Liefern Sie diesen Hack nicht aus, aber er bestätigt die Diagnose.

## Minimales Repro

Sie brauchen den MAUI-Workload nicht, um das zu reproduzieren, denn der Resizetizer ist eine gewöhnliche MSBuild-Task. Extrahieren Sie `microsoft.maui.resizetizer.10.0.110.nupkg` und führen Sie die Task direkt aus:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Maui.Resizetizer 10.0.110 (extracted nupkg), run.proj -->
<Project>
  <UsingTask AssemblyFile="$(RzDir)/Microsoft.Maui.Resizetizer.dll"
             TaskName="Microsoft.Maui.Resizetizer.ResizetizeImages" />
  <Target Name="Build">
    <ItemGroup><Img Include="$(Svg)" BaseSize="128,128" /></ItemGroup>
    <ResizetizeImages PlatformType="android"
                      IntermediateOutputPath="$(MSBuildThisFileDirectory)out/"
                      InputsFile="$(MSBuildThisFileDirectory)out/inputs.txt"
                      Images="@(Img)" />
  </Target>
</Project>
```

Mit zwei Testbildern:

```xml
<!-- filter.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <filter id="blur"><feGaussianBlur stdDeviation="8" /></filter>
  <rect width="456" height="456" fill="#512BD4" filter="url(#blur)" />
</svg>
```

```xml
<!-- text.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <rect width="456" height="456" fill="#512BD4" />
  <text font-family="Arial" font-size="120" fill="#FFFFFF"><tspan x="60 150 240" y="280">SD!</tspan></text>
</svg>
```

Das Ausführen von `dotnet build run.proj -nodeReuse:false -p:RzDir=<buildTransitive folder> -p:Svg=<file>` gegen jedes Paket ergab bei mir auf macOS mit SDK 10.0.302 Folgendes:

| Resizetizer | einfaches SVG | `<filter>` | `<text>` |
|---|---|---|---|
| 10.0.100 | OK | OK | OK |
| 10.0.101 | OK | `CreateMatrixConvolution` | `AddPositionedRun` |
| 10.0.110 | OK | `CreateMatrixConvolution` | `SKTypeface.Clone` |
| 11.0.0-rc.1.26451.6 | OK | OK | OK |

Das Umstellen von `PlatformType` auf `ios` schlägt auf 10.0.110 genauso fehl, sodass 10.0.110 in meinen Tests keine der beiden Varianten auf keiner der beiden Plattformen behoben hat. Stand heute sind #38319 und #38507 offen, und der vorgeschlagene Fix, [dotnet/maui#38883](https://github.com/dotnet/maui/pull/38883), ist ein Draft, der das gebündelte SkiaSharp gegen dessen netstandard2.0-Build austauscht. Sein CI-Lauf hat native Library-Mismatches zutage gefördert, rechnen Sie also nicht damit, dass er im nächsten Service-Release landet.

## Fix 1: Microsoft.Maui.Resizetizer auf 10.0.100 pinnen

Der Resizetizer wirkt nur zur Build-Zeit. Er generiert PNGs und Ressourcendateien; nichts davon landet in Ihrer App. Das macht es sicher, ihn eine Version zurückzuhalten, während der Rest von MAUI auf 10.0.110 bleibt.

Das MAUI-SDK fügt `Microsoft.Maui.Resizetizer` als impliziten `PackageReference` mit `$(MauiVersion)` hinzu, aber die Targets entfernen das implizite Item, wenn Sie ein explizites mit demselben Namen deklarieren. `Microsoft.Maui.Controls` 10.0.110 hängt außerdem von `Microsoft.Maui.Resizetizer >= 10.0.110` ab, sodass ein einfaches Downgrade den Restore scheitern lässt:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Maui.Resizetizer from 10.0.110 to 10.0.100.
  App -> Microsoft.Maui.Controls 10.0.110 -> Microsoft.Maui.Resizetizer (>= 10.0.110)
  App -> Microsoft.Maui.Resizetizer (>= 10.0.100)
```

Unterdrücken Sie `NU1605` nur für diese eine Referenz, damit Sie keine echten Downgrades an anderer Stelle verbergen:

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.110, App.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="$(MauiVersion)" />

  <!-- Workaround for dotnet/maui#38319 and #38507. Remove when a fixed Resizetizer ships. -->
  <PackageReference Include="Microsoft.Maui.Resizetizer"
                    Version="10.0.100"
                    PrivateAssets="all"
                    NoWarn="NU1605" />
</ItemGroup>
```

Ich habe verifiziert, dass dies sauber restored und dass `project.assets.json` `Microsoft.Maui.Resizetizer/10.0.100` auflöst. Wenn Sie Central Package Management verwenden, setzen Sie die `Version` auf ein `PackageVersion`-Item und behalten Sie `NoWarn="NU1605"` auf dem `PackageReference` bei.

Die schlichteste Alternative, die beide Issue-Melder verwendet haben, ist, ganz MAUI mit `<MauiVersion>10.0.100</MauiVersion>` zurückzupinnen. Das funktioniert, aber Sie verzichten auf jeden Fix in 10.0.110, um eine Build-Task zu umgehen. Tun Sie das nur, wenn Sie ohnehin schon einen Grund haben, MAUI zurückzuhalten.

## Fix 2: Filter und Text aus den vom Resizetizer verarbeiteten SVGs entfernen

Das ist der Fix, den ich auch beibehalten würde, nachdem Upstream einen Patch ausliefert, weil er außerdem dafür sorgt, dass Ihre Icons überall gleich gerendert werden. Der Resizetizer rastert SVGs mit `Svg.Skia`, und das ist kein Browser. Text hängt von den auf der Build-Maschine vorhandenen Schriftarten ab (Ihr macOS-CI-Runner und Ihr Windows-Laptop wählen unterschiedliche Fallbacks), und SVG-Filter waren schon immer der am wenigsten originalgetreue Teil jedes Nicht-Browser-Renderers.

Wandeln Sie Text in Konturen um. In Inkscape 1.x können Sie das über die Kommandozeile erledigen, was für einen ganzen Ordner voller Assets praktisch ist:

```bash
# Inkscape 1.x, converts <text> to <path> and drops editor metadata
inkscape design/splash-source.svg --export-text-to-path --export-plain-svg --export-filename=Resources/Splash/splash.svg
```

Verwenden Sie in Figma "Outline stroke" / "Flatten" auf der Textebene vor dem Export; in Illustrator "Create Outlines". Bewahren Sie die editierbare Quelldatei irgendwo außerhalb von `Resources/` auf, damit der Resizetizer sie nie zu sehen bekommt.

Für Filter haben Sie zwei Optionen:

- Ersetzen Sie den Effekt durch Geometrie. Ein Drop-Shadow auf einem App-Icon ist meist eine zweite Form mit geringerer Deckkraft, um ein paar Pixel versetzt. Ein weiches Glühen kann ein radialer Gradient sein. Keines von beiden braucht `<filter>`.
- Rastern Sie die Effekt-Ebene selbst und verwenden Sie ein PNG. `MauiIcon` und `MauiSplashScreen` akzeptieren PNGs, und PNGs durchlaufen nie `Svg.Skia`. Exportieren Sie in der größten benötigten Größe (1024x1024 für ein iOS-App-Icon). Laut den [App-Icon-Docs](https://learn.microsoft.com/dotnet/maui/user-interface/images/app-icons) wird eine als Hauptbild verwendete Bitmap nur dann skaliert, wenn Sie `BaseSize` setzen, sodass das einfachste Setup einen SVG-Hintergrund beibehält und den Effekt in ein PNG-Vordergrundbild verlagert:

```xml
<!-- .NET 10, MAUI 10.0.110, App.csproj -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg"
            ForegroundFile="Resources\AppIcon\appiconfg.png"
            Color="#512BD4" />
</ItemGroup>
```

Um jede betroffene Datei zu finden, bevor CI es tut, grep-en Sie nach den beiden Elementnamen:

```bash
# any shell with grep; lists SVGs the 10.0.101/10.0.110 Resizetizer will choke on
grep -rlE "<(filter|text)[ >]" --include="*.svg" Resources/
```

## Fix 3: Auf MAUI 11 wechseln, wenn Sie es ohnehin vorhatten

Der .NET MAUI 11 RC 1 Resizetizer (`11.0.0-rc.1.26451.6`) bündelt weiterhin SkiaSharp 3.116.1 und ein passendes `Svg.Skia` 2.0.0.4, und alle drei Test-SVGs wurden damit einwandfrei gerastert. Das ist kein Grund, wegen eines einzigen Build-Fehlers zu einem Release Candidate zu springen, aber wenn das Upgrade ohnehin schon eingeplant ist, verschwindet dieses Problem damit. Bedenken Sie, dass der 10.0.1xx-Servicing-Branch SkiaSharp 4.150.1 zuerst übernommen hat, sodass ein späterer MAUI-11-Build dieselbe Paarung erben könnte, wenn sie nicht an der Quelle behoben wird.

## Fallstricke und Verwechslungen

- **Es funktioniert lokal und schlägt in CI fehl.** Der Resizetizer arbeitet inkrementell. Wenn die PNGs von einem früheren Build auf 10.0.100 erzeugt wurden, wird das Target übersprungen und Ihr lokaler Build bleibt nach dem Upgrade grün. Clean Builds in CI regenerieren sie und schlagen fehl. Führen Sie `dotnet clean` aus oder löschen Sie `obj/` lokal, um den echten Zustand zu sehen.
- **`dotnet build-server shutdown` hilft nicht.** Das ist kein veralteter MSBuild-Knoten, der ein altes SkiaSharp festhält. Der Melder von #38319 hat bestätigt, dass es sich mit `-nodeReuse:false` reproduzieren lässt, und mein Repro verwendet dieses Flag ebenfalls.
- **Das Hinzufügen eines SkiaSharp-`PackageReference` zu Ihrer App hilft nicht.** Die Task lädt die Kopien aus dem `buildTransitive`-Ordner des Pakets, nicht aus dem Abhängigkeitsgraphen Ihrer App. Das ist auch der Grund, warum das Upgrade keine NuGet-Warnung erzeugt hat.
- **Es gibt unterschiedliche Ursachen für MAUIR0001.** `MAUIR0001` ist der generische "exception processing the image"-Code des Resizetizers. Eine `ArgumentNullException` oder `Unable to allocate pixels for the bitmap` unter demselben Code ist ein anderes Problem mit eigenen Upstream-Issues (zum Beispiel [dotnet/maui#12109](https://github.com/dotnet/maui/issues/12109)). Nur die `MissingMethodException` mit einem `ReadOnlySpan`-Parameter ist dieser Bug.
- **Schriftarten in `MauiFont` sind nicht betroffen.** Der Absturz liegt ausschließlich beim SVG-Rastern. Ihr Runtime-Textrendering, einschließlich benutzerdefinierter Schriftarten, berührt diesen Code nicht.
- **Assembly-Ladefehler in Ihrer eigenen App sehen ähnlich aus, sind es aber nicht.** Wenn Sie `MissingMethodException` oder `FileLoadException` zur Laufzeit statt beim Build bekommen, lesen Sie stattdessen [Could not load file or assembly in einer veröffentlichten App beheben](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/).

## Verwandte Artikel

- Wenn der Android-Build auch direkt nach dem Resizetizer-Schritt fehlschlägt, behandelt ["Gradle build failed to produce an .apk file" in MAUI Android beheben](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) den nächsthäufigen CI-Fehler.
- Für iOS-CI-Runner, die nach einem SDK-Update ebenfalls nicht mehr bauen, siehe [Unable to find a valid iOS Simulator runtime during a MAUI build](/de/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/).
- Die Resizetizer-Asset-Pipeline und die Items `MauiIcon` / `MauiSplashScreen` werden in [Migration von Xamarin.Forms zu .NET MAUI 11](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/) durchgegangen.
- Das Store-Packaging generiert alle Icon-Größen neu, weshalb [eine .NET MAUI App für den Microsoft Store verpacken](/de/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) der Punkt ist, an dem ein gefiltertes SVG-Icon unter Windows zuschlägt.

## Quellen

- [dotnet/maui#38319: Resizetizer schlägt bei jedem SVG-App-Icon mit einem `<filter>` fehl](https://github.com/dotnet/maui/issues/38319)
- [dotnet/maui#38507: Resizetizer 10.0.101 schlägt bei SVG-`<text>`-Elementen fehl](https://github.com/dotnet/maui/issues/38507)
- [dotnet/maui#37731: Update SkiaSharp to 4.150.1](https://github.com/dotnet/maui/pull/37731)
- [dotnet/maui#38883: Fix Resizetizer loading incorrect SkiaSharp assembly (Entwurf)](https://github.com/dotnet/maui/pull/38883)
- [dotnet/msbuild `MSBuildLoadContext.cs`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)
- [Microsoft.Maui.Resizetizer auf NuGet](https://www.nuget.org/packages/Microsoft.Maui.Resizetizer)
- [Bilder zu einem .NET MAUI App-Projekt hinzufügen (MS Learn)](https://learn.microsoft.com/dotnet/maui/user-interface/images/images)
</content>
