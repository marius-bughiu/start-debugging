---
title: "Fix: RZ10012: Found markup element with unexpected name in Blazor"
description: "Der Razor-Compiler von Blazor gibt RZ10012 aus, wenn ein Tag in PascalCase keinen Komponententyp im Sichtbarkeitsbereich findet. Fügen Sie @using für den Namespace der Komponente in _Imports.razor hinzu oder @namespace in der Komponente und kompilieren Sie neu."
pubDate: 2026-05-12
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "razor"
lang: "de"
translationOf: "2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor"
translatedBy: "claude"
translationDate: 2026-05-12
---

Die Lösung: Der Razor-Compiler hat ein Tag in PascalCase (zum Beispiel `<NavMenu />` oder `<MudButton />`) gesehen und konnte es keinem Komponententyp zuordnen, der im Sichtbarkeitsbereich dieser Datei liegt. Fügen Sie `@using <namespace>` entweder zur übergeordneten `.razor`-Datei oder zu einer `_Imports.razor` hinzu, die sie abdeckt, und kompilieren Sie neu. Wenn die Komponente in einer Razor Class Library (RCL) liegt, deren Ordnerstruktur nicht zu ihrem Namespace passt, fügen Sie zusätzlich `@namespace <FullNamespace>` zur `.razor`-Datei der Komponente hinzu. Löschen Sie `bin/`, `obj/` und `.vs/`, wenn die Warnung in der IDE nach einem sauberen Build bestehen bleibt.

```text
RZ10012: Found markup element with unexpected name 'NavMenu'.
If this is intended to be a component, add a @using directive for its namespace.
```

Diese Anleitung wurde gegen .NET 11 preview 4, das in `Microsoft.AspNetCore.App` 11.0.0-preview.4 enthaltene Razor SDK und Visual Studio 17.13 geschrieben. Die Diagnose-ID `RZ10012` und der exakte Wortlaut sind seit .NET Core 3.1 stabil, daher gelten die folgenden Lösungen unverändert für .NET 6, 7, 8, 10 und 11. Blazor Server, Blazor WebAssembly, Blazor United und Razor Class Libraries geben sie alle aus demselben Compiler-Schritt aus.

RZ10012 ist standardmäßig eine **Compiler-Warnung**, kein Fehler. Das Projekt baut weiterhin. Wenn das Tag tatsächlich als Komponente gedacht ist und Sie ohne Korrektur ausliefern, rendert die Laufzeit das Tag als **rohes HTML** (ein `<NavMenu></NavMenu>`-Element ohne Kinder), die Click-Handler werden nie verdrahtet und die Parameter verschwinden lautlos. Deshalb behandelt der Rest dieses Posts es als Fehler, den der Build blockieren sollte.

## Warum der Razor-Compiler Ihr Tag für "unexpected" hält

Der Razor-Compiler klassifiziert jedes Element in einer `.razor`-Datei nach einer Regel: Ein Tag, dessen Name mit einem **großen ASCII-Buchstaben** beginnt, ist eine Komponentenreferenz; alles andere ist HTML. Wenn er `<NavMenu />` sieht, durchläuft er die **Tag-Helper-Descriptor**-Tabelle der aktuellen Datei und sucht nach einem Komponententyp, dessen Kurzname passt und dessen Namespace durch eine `@using`-Direktive importiert ist, die für diese Datei gilt.

Wenn kein Descriptor passt, hat der Compiler zwei Möglichkeiten: HTML annehmen und eine Warnung ausgeben, damit ein Mensch korrigiert, oder den Build fehlschlagen lassen. Die Designer haben sich für Ersteres entschieden, deshalb ist RZ10012 eine Warnung. Die Descriptor-Tabelle wird aus drei Quellen befüllt, in dieser Reihenfolge:

1. **`@using`-Direktiven in der Datei selbst.** Lexikalischer Sichtbarkeitsbereich, nur die deklarierende Datei.
2. **`_Imports.razor`-Dateien**, angewendet **von unten nach oben pro Ordner**. Die `_Imports.razor` neben der Datei wirkt zuerst, dann die im übergeordneten Ordner, und so weiter bis zur Projektwurzel.
3. **Projektweite Imports**, die das SDK injiziert: `Microsoft.AspNetCore.Components`, `Microsoft.AspNetCore.Components.Web` und einige weitere. Deshalb müssen Sie `<EditForm>` nicht manuell importieren.

Beachten Sie, dass `_Imports.razor` **nicht transitiv über Projektgrenzen hinweg** ist. Eine `_Imports.razor` in einer Razor Class Library fließt nicht in die konsumierende Anwendung. Die `_Imports.razor` des Konsumenten (oder die Seite selbst) muss `@using MyRcl` deklarieren, damit `<MyRclComponent />` gebunden wird.

## Die minimale Datei, die es reproduziert

Die kleinste Reproduktion sind zwei Dateien im selben Projekt:

```razor
@* .NET 11 preview 4, Razor SDK 11.0.0-preview.4 *@
@* File: Components/Pages/Home.razor *@

<h1>Home</h1>
<NavMenu />
```

```razor
@* File: Components/Layout/NavMenu.razor *@

<nav>Navigation here</nav>
```

`NavMenu` liegt in `MyApp.Components.Layout`. `Home.razor` liegt in `MyApp.Components.Pages`. Keine der Dateien hat ein `@using` für `MyApp.Components.Layout`, und es gibt keine `_Imports.razor`, die eine Brücke schlägt. Build:

```text
Components\Pages\Home.razor(3,2): warning RZ10012: Found markup element with unexpected name 'NavMenu'. If this is intended to be a component, add a @using directive for its namespace.
```

Zur Laufzeit rendert die Seite `<navmenu></navmenu>` als wörtliches HTML-Tag.

## Die vier Lösungen, geordnet

Wenden Sie sie in dieser Reihenfolge an. Bleiben Sie bei der ersten, die Ihren Fall löst.

### 1. `@using` in die nächstgelegene `_Imports.razor` aufnehmen

Das ist die kanonische Lösung und die, auf die der Warnungstext selbst hinweist. Setzen Sie eine einzelne Zeile in die `_Imports.razor`, die Ihren Komponentenbaum abdeckt:

```razor
@* File: Components/_Imports.razor *@
@using MyApp.Components.Layout
@using MyApp.Components.Shared
```

Wenn für den Ordner noch keine `_Imports.razor` existiert, erstellen Sie eine. Die Standardvorlage `dotnet new blazor` legt eine in `Components/_Imports.razor` an, in der die üblichen Usings bereits verdrahtet sind.

Das funktioniert, weil das Razor SDK jede `_Imports.razor` zwischen Projektwurzel und aktueller Datei in den Compiler einspeist, als ob ihre Direktiven am Anfang der aktuellen Datei stünden. Ein hier hinzugefügtes Using propagiert zu jeder `.razor` in oder unter diesem Ordner, einschließlich Layouts, Seiten und Partials.

### 2. `@using` direkt in die konsumierende `.razor`-Datei

Wenn die Komponente von genau einer Datei referenziert wird und Sie die Namespace-Verschmutzung eingegrenzt halten möchten, deklarieren Sie das Using inline:

```razor
@* File: Components/Pages/Home.razor *@
@using MyApp.Components.Layout

<h1>Home</h1>
<NavMenu />
```

Mechanisch identisch zu Lösung 1, nur enger im Sichtbarkeitsbereich. Nützlich, wenn zwei Ordner Komponenten mit demselben Kurznamen definieren und Sie die Disambiguierung nur an einer Stelle möchten.

### 3. `@namespace` in die Komponente einfügen (Razor-Class-Library-Szenario)

Wenn die Komponente in einer RCL liegt, wird der automatisch generierte Namespace aus `RootNamespace` plus dem Dateipfad relativ zur Projektdatei der RCL abgeleitet. Wenn `RootNamespace` der RCL nicht zum tatsächlichen Namespace passt oder die Datei unter einem Ordnernamen liegt, den der C#-Compiler nicht wörtlich akzeptiert (Zahlen, Bindestriche), passt der generierte Namespace nicht zu dem, was der Konsument importiert. Fügen Sie `@namespace` hinzu, um die Diskrepanz an der Quelle zu beheben:

```razor
@* File: src/MyRcl/Components/Button.razor *@
@namespace MyRcl.Components

<button class="my-rcl-button" @onclick="OnClick">@ChildContent</button>

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    [Parameter] public EventCallback OnClick { get; set; }
}
```

Jetzt kann der Konsument `@using MyRcl.Components` schreiben und eine saubere Bindung erhalten. Ohne `@namespace` würde Razor `MyRcl.src.MyRcl.Components` oder `Some.RootNamespace.src.MyRcl.Components` generieren, abhängig vom RCL-Layout, und Ihr `@using` würde den Typ stillschweigend nicht finden.

Sie können auch `RootNamespace` in der `.csproj` der RCL setzen, um die ordnerbasierte Namensbildung komplett zu umgehen:

```xml
<!-- src/MyRcl/MyRcl.csproj -->
<PropertyGroup>
  <RootNamespace>MyRcl</RootNamespace>
</PropertyGroup>
```

### 4. Den IDE-Cache leeren, wenn die Warnung nach einem sauberen Build bleibt

Der Razor-Sprachdienst in Visual Studio cacht Tag-Helper-Descriptoren pro Projekt. Nachdem eine Projektreferenz hinzugefügt oder ein Namespace umbenannt wurde, kann der Cache weiterhin RZ10012 melden, obwohl `dotnet build` aus einem frischen `obj/` sauber durchläuft. Der zuverlässige Reset:

```powershell
# Close Visual Studio first, then from the solution root:
Remove-Item -Recurse -Force .vs, **/bin, **/obj
dotnet build
```

Lösung erneut öffnen. Der erste IntelliSense-Build befüllt den Descriptor-Cache mit dem Stand nach der Korrektur. Bei JetBrains Rider entspricht dem **File > Invalidate Caches**.

## Die Warnung den Build fehlschlagen lassen

Die Standardstufe liefert Builds aus, die kaputte Seiten rendern. Zwei Wege, sie anzuheben:

**Gezielt (empfohlen):** nur RZ10012 als Fehler behandeln.

```xml
<!-- MyApp.csproj, .NET 11 preview 4 -->
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);RZ10012</WarningsAsErrors>
</PropertyGroup>
```

Das Präfix `$(WarningsAsErrors);` erhält, was das SDK schon hochgestuft hat, was wichtig ist, weil neuere .NET-SDKs diese Liste mit der Zeit erweitern.

**Pauschal:** alle Warnungen als Fehler behandeln. Im Allgemeinen die gesündere Disziplin, zwingt Sie aber, jeder anderen Warnung nachzugehen, die das SDK je ausgegeben hat, was für die meisten Teams mehr Aufräumarbeit ist, als sie für eine einzelne Korrektur wollen.

```xml
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

In beiden Fällen stoppt ein fehlendes `@using` jetzt den Build, statt als Ticket "der Button tut nichts" in die QA durchzusickern.

## Häufige Varianten, die hier versehentlich landen

**Tagname in Kleinbuchstaben.** `<navMenu />` löst kein RZ10012 aus, weil der erste Buchstabe klein ist und Razor es als HTML einstuft. Wenn Ihre Komponente als wörtliches Markup gerendert wird und **keine** Warnung erscheint, haben Sie einen Schreibweise-Bug, keinen Namespace-Bug. Benennen Sie das Tag in PascalCase um.

**`@inherits` maskiert die Komponente.** In .NET 7.0.302 und älter gibt es ein bekanntes Problem ([dotnet/razor#8800](https://github.com/dotnet/razor/issues/8800)), bei dem das Hinzufügen von `@inherits MyBase` zu einer Komponente dazu führte, dass der Compiler die Komponenteneigenschaft verlor und RZ10012 überall dort ausgab, wo sie verwendet wurde. In .NET 8 behoben. Wenn Sie noch auf .NET 7 sind und nicht aktualisieren können, umgehen Sie es, indem Sie in `@code { protected partial class ... }` vererben statt über die Direktive.

**Drittanbieter-Komponentenbibliothek nicht registriert.** Wenn Sie MudBlazor, Radzen, Telerik oder Syncfusion verwenden, liefert die Bibliothek ein `_Imports.razor`-Snippet, das Sie in Ihr eigenes einfügen müssen. Wird es vergessen, leuchtet jedes `<MudButton />` mit RZ10012 auf. Die "Getting started"-Seite des Anbieters hat die exakte Liste (MudBlazor braucht `@using MudBlazor`, Radzen braucht `@using Radzen` und `@using Radzen.Blazor`, usw.).

**Generische Komponente mit Typparameter.** `<MyList T="string" />` warnt weiterhin, wenn `MyList<T>` nicht im Sichtbarkeitsbereich ist. Das Attribut `T="..."` importiert keinen Namespace; die `@using`-Regel gilt genauso.

**Editor-Falschpositiv in VS 17.4.x.** [dotnet/razor#8146](https://github.com/dotnet/razor/issues/8146) verfolgt eine Reihe von Falschpositiven in frühen VS-2022-Releases. Wenn der Build sauber ist und nur die IDE RZ10012 markiert, aktualisieren Sie VS auf 17.6 oder neuer und leeren Sie `.vs/` wie in Lösung 4.

**Komponente in einem referenzierten Projekt, das ein anderes Framework anzielt.** Eine Razor Class Library, die `net6.0` anzielt und von einer `net11.0`-App konsumiert wird, kann ihre Komponenten nicht offenlegen, wenn der RCL `<UseRazorSourceGenerator>true</UseRazorSourceGenerator>` fehlt oder eine veraltete SDK-Referenz hat. Aktualisieren Sie die `<PackageReference>` der RCL auf `Microsoft.AspNetCore.App` 11 und kompilieren Sie neu.

## Eine 30-Sekunden-Checkliste

Wenn RZ10012 in CI auftaucht und Sie einen Flug erreichen müssen, arbeiten Sie diese Liste von oben nach unten ab:

1. Ist das Tag PascalCase? Wenn klein, umbenennen.
2. Liegt die Komponente in **diesem** Projekt? Wenn ja, ihren Namespace per `@using` in die nächstgelegene `_Imports.razor`.
3. Liegt die Komponente in einer RCL? Prüfen Sie, dass die RCL `@namespace` passend zum Import hat und der Konsument das Paket oder Projekt der RCL referenziert.
4. Drittanbieter-Bibliothek? Das Snippet des Anbieters in `_Imports.razor` einfügen.
5. Warnt es nach einem sauberen Build immer noch? `.vs/`, `bin/`, `obj/` löschen und neu kompilieren.
6. Soll das den CI fehlschlagen lassen? `RZ10012` zu `<WarningsAsErrors>` hinzufügen.

Neunzig Prozent der Fälle sind Schritt 2 oder Schritt 4. Der Rest ist Namespace-Klempnerei.

## Verwandt

- [Fix: The type or namespace name could not be found after a project reference](/de/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) deckt die C#-Seite derselben Familie von Namespace-Auflösungsfehlern ab.
- [Validierungslogik zwischen Server und Blazor WebAssembly teilen](/de/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) geht durch das Multi-Projekt-Layout, in dem RZ10012 am häufigsten zubeißt.
- [Tailwind CSS mit Blazor WebAssembly in .NET 11 verwenden](/de/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) zeigt ein sauberes Blazor-Projekt-Layout zum Vergleich.
- [Einen globalen Ausnahmefilter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) ist das Laufzeit-Gegenstück zum Abfangen der "Tag als rohes HTML gerendert"-Bugs, die RZ10012 verhindert hätte.

## Quellen

- [dotnet/aspnetcore#45427: Referenced Razor Class Library component reporting error RZ10012](https://github.com/dotnet/aspnetcore/issues/45427)
- [dotnet/razor#8800: `@inherits` breaks component recognition](https://github.com/dotnet/razor/issues/8800)
- [dotnet/razor#8146: Unusable Blazor analyzers blinking invalid RZ10012 warnings in VS 17.4.x](https://github.com/dotnet/razor/issues/8146)
- [Microsoft Learn: ASP.NET Core Blazor namespaces](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-9.0#namespaces)
- [Jonathan Crozier: Treat Blazor component warnings as errors](https://jonathancrozier.com/blog/treat-blazor-component-warnings-as-errors-found-markup-element-with-unexpected-name)
