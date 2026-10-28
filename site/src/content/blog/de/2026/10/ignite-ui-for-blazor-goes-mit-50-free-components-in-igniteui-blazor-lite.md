---
title: "Ignite UI for Blazor wird MIT: über 50 kostenlose Komponenten in IgniteUI.Blazor.Lite 1.0.0"
description: "Infragistics hat mehr als 50 Ignite UI for Blazor Steuerelemente unter MIT als Open Source veröffentlicht, ausgeliefert als IgniteUI.Blazor.Lite und IgniteUI.Blazor.GridLite 1.0.0 für net8.0, net9.0 und net10.0. Was kostenlos ist, wie Sie es einbinden und welche Stolperfallen es gibt."
pubDate: 2026-10-28
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
lang: "de"
translationOf: "2026/10/ignite-ui-for-blazor-goes-mit-50-free-components-in-igniteui-blazor-lite"
translatedBy: "claude"
translationDate: 2026-10-28
---

Am 2026-10-27 hat das ASP.NET-Team [angekündigt](https://devblogs.microsoft.com/dotnet/blazor-welcomes-infragistics/), dass Infragistics nun Blazor-Contributor ist. Die wichtigste Nachricht für die meisten von uns ist die Lizenz: Mehr als 50 Ignite UI for Blazor Steuerelemente stehen jetzt unter MIT, sind kostenlos für den kommerziellen Einsatz nutzbar, und der Quellcode liegt auf [GitHub](https://github.com/IgniteUI/igniteui-blazor). Das ist kein Testangebot. Es ist eine dauerhafte Teilmenge der kommerziellen Suite.

## Was tatsächlich kostenlos ist

Zwei Pakete, beide in Version 1.0.0 auf NuGet und beide mit den Zielen `net8.0`, `net9.0` und `net10.0`:

- `IgniteUI.Blazor.Lite`: Eingabe-, Navigations- und Layout-Steuerelemente. Combo, Date Picker, Date Range Picker, Tree, Stepper, Tile Manager, Splitter, Dialog, Tabs, Calendar, Mask Input, Slider, Rating, Chat (Vorschau) und rund 40 weitere.
- `IgniteUI.Blazor.GridLite`: ein schlankes Datengrid mit Spaltenfilterung und benutzerdefinierten Zellvorlagen.

Das vollständige Grid, Tree Grid, Pivot Grid, Hierarchical Grid und der Dock Manager bleiben kommerziell im Paket `IgniteUI.Blazor`. Wer Gruppierung, Bearbeitung oder Excel-Export braucht: Grid Lite ist nicht dieses Grid.

## Einbindung in eine Blazor Web App

```bash
dotnet add package IgniteUI.Blazor.Lite --version 1.0.0
```

Registrieren Sie die Dienste in `Program.cs` und importieren Sie den Namespace in `_Imports.razor`:

```csharp
builder.Services.AddIgniteUIBlazor();
```

```razor
@using IgniteUI.Blazor.Controls
```

Fügen Sie anschließend ein Theme in `Components/App.razor` ein (oder in `wwwroot/index.html` bei eigenständigem WebAssembly):

```html
<link href="_content/IgniteUI.Blazor/themes/light/bootstrap.css" rel="stylesheet" />
```

Beachten Sie den Pfad: Er lautet `_content/IgniteUI.Blazor/`, nicht `_content/IgniteUI.Blazor.Lite/`. Ich habe das Paket 1.0.0 geprüft, und der `BasePath` seiner statischen Web-Assets ist auf `_content/IgniteUI.Blazor` gesetzt, sodass das Lite-Paket und die kommerziellen Pakete dieselben Asset-URLs verwenden. Wer den "naheliegenden" Pfad errät, erhält unformatierte Komponenten und einen 404 im Netzwerk-Tab. Themes gibt es als `bootstrap`, `fluent`, `indigo` und `material`, jeweils in `light` und `dark`.

Ein `<script>`-Tag ist nicht nötig. Ein JavaScript-Initializer lädt die Web Components, sobald Blazor startet.

## Ein Combo mit echter Datenbindung

`IgbCombo` ist generisch über `TValue` und `TItem`, und `Value` ist immer ein `TValue[]`, auch mit `SingleSelect`. Darüber stolpert man beim ersten Mal:

```razor
@rendermode InteractiveServer

<IgbCombo TItem="City" TValue="int"
          Data="cities"
          ValueKey="Id"
          DisplayKey="Name"
          Label="Destination"
          SingleSelect="true"
          @bind-Value="selected" />

<p>Selected id: @(selected.FirstOrDefault())</p>

@code {
    record City(int Id, string Name);

    City[] cities = [new(1, "Bucharest"), new(2, "Cluj"), new(3, "Iasi")];
    int[] selected = [];
}
```

Die Zeile `@rendermode` ist wichtig. Die Komponenten basieren auf JavaScript-Interop und benötigen daher `InteractiveServer`, `InteractiveWebAssembly` oder `InteractiveAuto`. Statisches SSR wird nicht unterstützt, und eine Seite ohne Rendermodus rendert nur inaktives Markup.

## Der Teil, der mit .NET 11 kommt

Infragistics-Entwickler haben außerdem zwei Blazor-Analyzer beigesteuert, die für .NET 11 in [dotnet/aspnetcore#67176](https://github.com/dotnet/aspnetcore/pull/67176) und [#67383](https://github.com/dotnet/aspnetcore/pull/67383) gemergt wurden. Der erste markiert `StateHasChanged()`-Aufrufe, die `ComponentBase` bereits überflüssig macht, etwa ein Aufruf direkt vor dem ersten `await` in `OnInitializedAsync`, und liefert einen Code Fix, der sie entfernt. Der zweite warnt, wenn eine Klasse `GetAuthenticationStateAsync()` aufruft, ohne `AuthenticationStateChanged` zu abonnieren. So landet man bei einem veralteten, zwischengespeicherten Benutzer.

Für Coding-Agents gibt es außerdem einen Skill `use-igniteui-blazor` in [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-blazor/skills/use-igniteui-blazor) sowie einen Scaffolder, der in [dotnet/Scaffolding#3823](https://github.com/dotnet/Scaffolding/pull/3823) noch geprüft wird.

Für Teams, die Komponentenanbieter wegen der Lizenzierung pro Arbeitsplatz gemieden haben, ist ein kostenloses MIT-Combo samt Date Range Picker und Tree, die die Trimming- und Barrierefreiheitsvorgaben des Blazor-Teams erfüllen, einen Spike in dieser Woche wert.
