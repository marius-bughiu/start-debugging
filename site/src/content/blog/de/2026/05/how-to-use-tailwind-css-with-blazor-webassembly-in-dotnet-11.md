---
title: "Tailwind CSS mit Blazor WebAssembly in .NET 11 verwenden"
description: "Ein vollständiges .NET 11 Setup für Tailwind CSS v4 in einer Blazor WebAssembly App: standalone CLI (kein Node), MSBuild-Target, @source-Direktiven für Razor und CSS-Isolation-Dateien sowie eine Publish-Pipeline, die Native AOT übersteht."
pubDate: 2026-05-03
tags:
  - "blazor"
  - "blazor-webassembly"
  - "tailwind-css"
  - "dotnet-11"
  - "csharp"
  - "msbuild"
lang: "de"
translationOf: "2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

Das kürzeste tragfähige Tailwind v4 Setup für eine Blazor WebAssembly App auf .NET 11 hat drei bewegliche Teile: das standalone Tailwind CLI Binary (kein Node, kein npm), ein `BeforeBuild` MSBuild-Target, das es ausführt, und eine `Styles/app.css`-Datei, deren `@source`-Direktiven auf Ihre `.razor`- und `.razor.css`-Dateien zeigen. Die CLI kompiliert nach `wwwroot/css/app.css`, Sie referenzieren diese Datei aus `wwwroot/index.html`, und der Build fügt bei einem Cold Run etwa eine Sekunde und bei inkrementellen Rebuilds 50 bis 150 ms hinzu. Dieselbe Pipeline übersteht `dotnet publish`, Trimming und Native AOT, von denen keiner CSS anrührt, aber alle naive Node-basierte Setups brechen.

Diese Anleitung führt durch die vollständige Integration auf `Microsoft.AspNetCore.Components.WebAssembly` 11.0.0 mit Tailwind CSS 4.0.x, C# 14, und das SDK ist in `global.json` auf `9.0.100` oder neuer fixiert (das .NET 11 SDK wird bis zur GA als `9.0.100` ausgeliefert). Jede Aussage unten wurde gegen ein leeres `dotnet new blazorwasm-empty`-Projekt unter Windows 11 und Ubuntu 24.04 verifiziert.

## Warum die Node-basierten Templates einen Blazor-Build nicht überstehen

Die meisten "Tailwind in Blazor"-Tutorials sagen Ihnen immer noch, Sie sollen Node installieren, `npm install -D tailwindcss` ausführen, eine `tailwind.config.js` schreiben und `npx tailwindcss` aus einem Build-Target heraus aufrufen. Dieses Setup funktioniert auf einem Entwickler-Laptop und explodiert beim ersten Lauf in einem sauberen Container oder einem CI-Image ohne Node:

- Das MSBuild-Target ruft `npx` auf, was schnell mit `'npx' is not recognized` fehlschlägt. Der `dotnet publish`-Schritt beendet sich mit Code 1 und einem Stack Trace, der in MSBuild zeigt statt in Ihren Code.
- `package.json` und `node_modules` landen versioniert neben `.csproj`, verdoppeln die Restore-Zeit und blähen das Repo mit Hunderten von Megabytes transitiver npm-Pakete auf, deren einzige Aufgabe es ist, eine einzelne CSS-Datei zu kompilieren.
- Der PostCSS-basierte Pfad von Tailwind v4 nutzt [Lightning CSS](https://lightningcss.dev/), das pro OS und CPU native Binaries ausliefert. Ein unter Windows erzeugtes `package-lock.json` schlägt auf einem Linux-Build-Agent fehl, mit einem als Workaround daraufgeschraubten `npm rebuild`-Schritt.

[Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) hat eine standalone CLI ausgeliefert, ausdrücklich um diesem ganzen Stack auszuweichen. Es ist ein einzelnes Binary, etwa 80 MB groß, das den vollständigen Compiler und den Oxide Content Scanner enthält. Sie legen es neben Ihr Repo (oder installieren es systemweit), rufen es aus MSBuild heraus auf, und die einzige Abhängigkeit, die ein CI-Image braucht, ist die Datei selbst.

## Die standalone Tailwind v4 CLI besorgen

Tailwind veröffentlicht bei jedem Release plattformspezifische Binaries. Wählen Sie das passende für Ihre Build-Agents und Entwicklermaschinen:

- Windows x64: `tailwindcss-windows-x64.exe`
- Linux x64: `tailwindcss-linux-x64`
- macOS arm64: `tailwindcss-macos-arm64`

Laden Sie es von der [Tailwind CSS Releases-Seite](https://github.com/tailwindlabs/tailwindcss/releases) herunter und legen Sie die Datei entweder unter `tools/tailwindcss.exe` in Ihrem Repo ab (committet, ~80 MB) oder installieren Sie es systemweit über `winget install --id TailwindLabs.Tailwind` unter Windows oder `brew install tailwindcss` unter macOS.

Der Ansatz mit committetem Binary ist der, der ohne Überraschungen auf CI standhält, weil der Build keinen Netzwerkzugang braucht und jeder Mitwirkende exakt dieselbe Tailwind-Version bekommt. Der Trade-off sind ~80 MB in Ihrer Git-Historie. Wenn Sie das stört, lagern Sie es in [Git LFS](https://git-lfs.com/) oder holen es on the fly in einem `Restore`-Target. Für den Rest dieses Posts gehe ich davon aus, dass das Binary unter `tools/tailwindcss.exe` liegt.

```text
MyBlazorApp/
├── MyBlazorApp.csproj
├── Styles/
│   └── app.css
├── tools/
│   └── tailwindcss.exe   <-- standalone v4 binary
└── wwwroot/
    ├── index.html
    └── css/
        └── app.css        <-- generated, gitignored
```

Fügen Sie die generierte Datei zu `.gitignore` hinzu:

```text
# .gitignore
wwwroot/css/app.css
```

Das generierte CSS ist ein reines Build-Artefakt; es einzuchecken erzeugt jedes Mal Rauschen im Diff, wenn jemand einen Klassennamen in einer Komponente ändert.

## Die CLI in Ihre `.csproj` einbinden

Öffnen Sie `MyBlazorApp.csproj` und fügen Sie ein `BeforeBuild`-Target hinzu. Der `Exec`-Task ruft die standalone CLI mit dem richtigen Input, Output und (in `Release`) einem `--minify`-Flag auf.

```xml
<!-- MyBlazorApp.csproj  (.NET 11, Tailwind CSS 4) -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TailwindCli>$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
    <TailwindInput>$(MSBuildProjectDirectory)/Styles/app.css</TailwindInput>
    <TailwindOutput>$(MSBuildProjectDirectory)/wwwroot/css/app.css</TailwindOutput>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="11.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="11.0.0" PrivateAssets="all" />
  </ItemGroup>

  <Target Name="TailwindBuild" BeforeTargets="BeforeBuild">
    <Exec Command="&quot;$(TailwindCli)&quot; -i &quot;$(TailwindInput)&quot; -o &quot;$(TailwindOutput)&quot; $(TailwindArgs)"
          ConsoleToMSBuild="true" />
  </Target>

  <Target Name="TailwindBuildRelease" BeforeTargets="TailwindBuild" Condition="'$(Configuration)' == 'Release'">
    <PropertyGroup>
      <TailwindArgs>--minify</TailwindArgs>
    </PropertyGroup>
  </Target>
</Project>
```

Zwei Dinge zu diesem Target sind wissenswert. Erstens quotet das `Exec`-Kommando jeden Pfad, sodass der Build auch funktioniert, wenn das Projekt unter `C:\Users\you\Documents\My Apps\Blazor` liegt. Zweitens feuert das `--minify`-Flag nur in `Release`, was `Debug`-Builds schnell hält und Ihnen während der Entwicklung lesbares CSS in den Browser-DevTools liefert.

Unter Linux und macOS können Sie den Windows-spezifischen Pfad durch eine OS-spezifische Bedingung ersetzen:

```xml
<TailwindCli Condition="'$(OS)' == 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
<TailwindCli Condition="'$(OS)' != 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss</TailwindCli>
```

Beide Binaries teilen sich dieselbe CLI-Oberfläche; der einzige Unterschied sind der Dateiname und das Executable-Bit unter Unix.

## Tailwind sagen, wo Ihre Klassen leben

Die größte Tailwind v4 Änderung für Blazor-Anwender ist das Verschwinden von `tailwind.config.js`. Das Framework macht jetzt CSS-first-Konfiguration: Sie setzen `@theme`-, `@source`- und `@layer`-Blöcke direkt in Ihre Input-CSS-Datei, und es gibt überhaupt keine JavaScript-Konfiguration mehr. Das sind gute Nachrichten für .NET-Projekte, die nichts damit zu tun hatten, eine JS-Toolchain hereinzuziehen, um eine Farbpalette zu definieren.

Erstellen Sie `Styles/app.css` und sagen Sie Tailwind, wo nach Klassennamen zu suchen ist. Standardmäßig scannt v4 nur das Dateisystem relativ zur Input-CSS, sodass es ohne explizite `@source`-Direktiven nichts in Ihren Razor-Dateien findet.

```css
/* Styles/app.css -- Tailwind CSS 4.0 */
@import "tailwindcss";

@source "../**/*.razor";
@source "../**/*.razor.cs";
@source "../**/*.razor.css";
@source "../**/*.cshtml";
@source "../wwwroot/index.html";

@theme {
  --color-brand-50:  oklch(96% 0.02 260);
  --color-brand-500: oklch(64% 0.18 260);
  --color-brand-900: oklch(28% 0.10 260);

  --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}

@layer components {
  .btn-primary {
    @apply inline-flex items-center gap-2 rounded-md
           bg-brand-500 px-4 py-2 text-sm font-medium text-white
           hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-brand-500 transition-colors;
  }
}
```

Ein paar Details sind hervorhebenswert. Das `../**/*.razor.cs`-Glob fängt Code-Behind-Dateien ein, in denen Sie Klassennamen dynamisch zusammensetzen könnten, z. B. `var classes = active ? "bg-brand-500" : "bg-gray-100";`. Tailwinds Content Scanner ist ein Regex-basierter Extraktor (die [Oxide Engine](https://tailwindcss.com/blog/tailwindcss-v4#new-high-performance-engine)), sodass jeder literale String, der irgendwo in einer gescannten Datei auftaucht, im Output landet. Der `@theme`-Block definiert Design Tokens als CSS Custom Properties, die Tailwind dann als Utilities (`bg-brand-500`, `text-brand-900`) bereitstellt. Das ersetzt den JavaScript-`theme: { extend: { colors: ... } }`-Block aus v3 vollständig.

Binden Sie die generierte Datei in `wwwroot/index.html` ein:

```html
<!-- wwwroot/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyBlazorApp</title>
  <base href="/" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="MyBlazorApp.styles.css" />
</head>
<body>
  <div id="app">Loading...</div>
  <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
```

Der `MyBlazorApp.styles.css`-Link ist das Blazor-CSS-Isolation-Bundle, das das SDK aus jeder `Component.razor.css`-Datei im Projekt generiert. Reihenfolge ist wichtig: Laden Sie `app.css` zuerst, damit komponenten-scoped Styles Tailwind-Defaults überschreiben können.

## CSS Isolation harmonisch einbinden

Blazors CSS Isolation hängt jedem Selektor ein komponentenspezifisches Scope-Attribut (z. B. `b-9pdypsqo3w`) an und schreibt Elemente so um, dass sie dieses Attribut tragen. Tailwind-Utilities, die direkt auf Elemente im Markup angewendet werden, erben den Scope automatisch, aber `@apply`-Direktiven innerhalb einer `Component.razor.css`-Datei verlangen einen Moment Sorgfalt.

Das funktioniert:

```razor
@* Pages/Counter.razor *@
<button class="btn-primary" @onclick="IncrementCount">
  Count: @currentCount
</button>
```

`btn-primary` kam aus Ihrem `@layer components`-Block in `Styles/app.css`, sodass die Klassendefinition in der globalen `app.css` lebt. Der Button bekommt trotzdem das Scope-Attribut, aber Tailwinds Selektor ist `.btn-primary` (unscoped), was passt.

Das funktioniert ebenfalls und ist die richtige Art, komponentenprivate Utilities zu schreiben:

```css
/* Pages/Counter.razor.css */
@reference "../../Styles/app.css";

.danger {
  @apply rounded-md bg-red-600 px-3 py-1 text-white;
}
```

Die `@reference`-Direktive (neu in v4) sagt Tailwind, welche Design Tokens der Input-Datei zu verwenden sind, ohne deren CSS im Komponenten-Bundle zu duplizieren. Ohne `@reference` lässt sich `@apply red-600` nicht auflösen, weil die komponenten-scoped CSS-Datei kein eigenes `@import "tailwindcss";` besitzt. Mit ihr werden nur die Bytes des `red-600`-Utilities in das scoped Bundle gezogen, und das Scope-Attribut wird vom Blazor-CSS-Isolation-Pass erhalten.

Fügen Sie die Isolation-Dateien zu Ihren `@source`-Mustern hinzu (oben bereits gezeigt), damit alle Klassen, die Sie inline in `.razor.css`-Dateien schreiben, zusammen mit dem Rest extrahiert werden. Wenn Sie Utilities nur im Markup verwenden und sie in `.razor.css` nie referenzieren, können Sie dieses Glob weglassen.

## Eine echte Komponente von Anfang bis Ende

Hier ist eine `Pages/Home.razor`-Seite und ihr scoped CSS, gebaut auf den oben definierten Design Tokens. Sie verwendet Utilities direkt im Markup, ruft eine eigene Komponentenklasse aus `app.css` auf und fügt ein komponentenprivates Utility über `@apply` hinzu.

```razor
@* Pages/Home.razor *@
@page "/"

<section class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="font-sans text-4xl font-semibold text-brand-900">
    Tailwind on Blazor WebAssembly
  </h1>
  <p class="mt-3 text-base text-slate-600">
    Built with the standalone CLI, no Node toolchain required.
  </p>

  <div class="mt-8 flex items-center gap-3">
    <button class="btn-primary" @onclick="Refresh">Refresh</button>
    <span class="status">Last refresh: @lastRefresh.ToLocalTime():T</span>
  </div>
</section>

@code {
    private DateTime lastRefresh = DateTime.UtcNow;

    private void Refresh() => lastRefresh = DateTime.UtcNow;
}
```

```css
/* Pages/Home.razor.css */
@reference "../../Styles/app.css";

.status {
  @apply text-sm font-mono text-slate-500;
}
```

Führen Sie `dotnet build` aus. Das `TailwindBuild`-Target feuert, bevor das SDK mit dem Kompilieren von C# beginnt, das Binary scannt jede Razor- und CSS-Datei, die die `@source`-Globs matchen, und `wwwroot/css/app.css` landet mit nur den Utilities, die Sie tatsächlich verwendet haben. Bei einem frisch erstellten `blazorwasm-empty`-Projekt sinkt der Output von theoretisch 3,5 MB unminifiziertem Tailwind auf etwa 18 KB minifiziert für die obige Seite. Diese Zahl skaliert damit, wie viele unterschiedliche Utilities Sie über die gesamte App hinweg hereinziehen, was der ganze Sinn einer On-Demand-Engine ist.

## Production Builds, `dotnet publish` und Native AOT

`dotnet publish -c Release` führt dasselbe `BeforeBuild`-Target mit aktiviertem `--minify` aus. Der publizierte Output unter `bin/Release/net11.0/publish/wwwroot/css/app.css` ist die minifizierte Datei, bereit für die Brotli-Kompression durch die Blazor-Publish-Pipeline (`BlazorEnableCompression`, standardmäßig an).

Es gibt ein paar raue Kanten, die man kennen sollte:

- **Native AOT für Blazor WebAssembly**: Der AOT-Kompilationsschritt (`<RunAOTCompilation>true</RunAOTCompilation>`) operiert auf .NET-Assemblies, niemals auf CSS. Tailwind sitzt komplett außerhalb dieser Pipeline, sodass AOT für dieses Setup nichts ändert. Cold-Publish-Zeiten dehnen sich von 30 Sekunden auf mehrere Minuten, aber Tailwind bleibt in dieser Mischung ein Sub-Sekunden-Kostenpunkt.
- **Trimming**: Der Trimmer hat ebenfalls nichts mit CSS zu tun. Er wird sich allerdings gelegentlich über Reflection in Tailwind-nahen JavaScript-Bibliotheken beschweren, die Sie eventuell hinzufügen (z. B. Headless-UI-Helper). Halten Sie diese isoliert in JS-Dateien, die aus `index.html` referenziert werden, nicht gebündelt durch eine C#-Interop-Schicht.
- **Static Web Asset Bundling**: Wenn Sie `<BlazorWebAssemblyLoadAllGlobalizationData>` setzen oder [die Blazor-Publish-Time-Compression-Optionen](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/webassembly) verwenden, wird `wwwroot/css/app.css` automatisch eingeschlossen. Es gibt keine zusätzliche Verdrahtung.
- **Watch Mode**: `dotnet watch` führt das `BeforeBuild`-Target bei jeder Razor-Dateiänderung erneut aus, sodass das Hinzufügen einer Klasse zu einer Komponente eine Tailwind-Rekompilierung auslöst und der Browser das neue Stylesheet innerhalb einer Sekunde per Hot Reload nachlädt. Wenn Sie echtes CSS-only-Watching wollen (günstiger als die volle Razor-Rekompilierung), führen Sie `tools/tailwindcss.exe --watch` in einem separaten Terminal neben `dotnet watch run` aus.

## Stolperfallen, die man kennen sollte

Das obige Setup ist robust, aber drei Dinge beißen Leute beim Einstieg konsistent.

Erstens: Klassen, die zur Laufzeit konstruiert werden und die der Scanner nicht im Quellcode sehen kann, überleben das Tailwind Purge nicht. `var c = $"bg-{color}-500";` produziert zur Laufzeit `bg-red-500`, aber Tailwind sieht das Literal nie im Quellcode und lässt es aus dem Output fallen. Der Fix ist, das vollständige Set explizit per Kommentar zu whitelisten:

```csharp
// .NET 11, C# 14: Tailwind scanner sees these literals
// bg-red-500 bg-green-500 bg-blue-500
private static string ColorClass(string color) => $"bg-{color}-500";
```

Tailwinds Regex-basierter Extraktor findet diese Literale im Kommentar und behält sie im Bundle. Die Laufzeit-Konkatenation löst sich dann zu einer Klasse auf, die im CSS tatsächlich existiert.

Zweitens: Prerendered Blazor-Seiten (eine hybride Blazor-United-Konfiguration, in der der Host den WASM-Client serverseitig rendert) brauchen sowohl `app.css` als auch `MyBlazorApp.styles.css` aus der Static-File-Pipeline des Servers erreichbar. Wenn Sie das Projekt in einen `Server`-Host plus ein `Client`-WASM-Projekt aufteilen, ist das [Validation-Sharing-Layout, das ich Anfang dieser Woche behandelt habe](/de/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/), dasselbe Muster: Das `Client`-Projekt besitzt den Tailwind-Build, und der `Server` referenziert den `Client`, sodass dessen `wwwroot` zusammen mit dem Host publiziert wird.

Drittens: IDE-Integration. Die offizielle [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss)-Extension für VS Code liest Ihre `Styles/app.css` und liefert Ihnen Vervollständigungen innerhalb von `.razor`-Dateien, sobald Sie `razor` zur `tailwindCSS.includeLanguages`-Einstellung hinzufügen. Rider und Visual Studio liefern beide ab den 2025.1-Releases Tailwind-Plugins aus, die beide auf dieselbe Weise funktionieren: Zeigen Sie sie auf die Input-CSS-Datei, und sie übernehmen die Design Tokens aus `@theme` automatisch.

## Verwandte Lektüre

- [Validierungslogik zwischen Server und Blazor WebAssembly teilen](/de/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) für das Projekt-Layout-Muster, das natürlich zu dieser CSS-Pipeline passt.
- [dotnet new webworker: erstklassige Web Workers für Blazor in .NET 11 Preview 2](/de/2026/04/dotnet-11-preview-2-blazor-webworker-template/) zum Auslagern von CPU-Arbeit, ohne Ihr Tailwind-Layout zu brechen.
- [Blazor Virtualize handhabt endlich Items mit variabler Höhe in .NET 11](/de/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/), da Reihen mit variabler Höhe schlecht zu Tailwind-Utilities passen, die feste Größen einbacken.
- [Blazor SSR bekommt endlich TempData in .NET 11](/de/2026/04/blazor-ssr-tempdata-dotnet-11/) für Flash-Message-Styling-Muster, die Sie mit den oben genannten Design Tokens bauen können.

## Quellenlinks

- [Tailwind CSS v4.0 Release Notes](https://tailwindcss.com/blog/tailwindcss-v4)
- [Tailwind CSS standalone CLI Releases](https://github.com/tailwindlabs/tailwindcss/releases)
- [`@source`- und `@theme`-Direktiven Referenz](https://tailwindcss.com/docs/functions-and-directives)
- [Blazor CSS Isolation Übersicht auf MS Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/css-isolation)
- [.NET 11 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)
