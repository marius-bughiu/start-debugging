---
title: "Wie man in einer Blazor-Komponente eine Überschrift rendert, deren Ebene (h1-h6) zur Laufzeit gewählt wird"
description: "Razor kennt keine Syntax für einen variablen Tag-Namen, und DynamicComponent rendert ausschließlich Komponententypen. Überschreiben Sie BuildRenderTree und rufen Sie builder.OpenElement(0, $\"h{level}\") auf. Behandelt Attribut-Weitergabe, warum der Tag-Name begrenzt werden muss, bevor er das DOM erreicht, warum ein Ebenenwechsel das Element selbst mit @key aus dem DOM reißt, und eine automatisch nivellierende Variante auf Basis eines Cascading Value."
pubDate: 2026-08-27
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-render-a-heading-with-a-runtime-chosen-level-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-27
---

Razor bietet keine Möglichkeit, `<h@Level>` zu schreiben, und `<DynamicComponent>` hilft nicht weiter, weil dessen `Type`-Parameter `IComponent` implementieren muss. Die Lösung besteht darin, auf `RenderTreeBuilder` hinabzusteigen und das Element selbst zu bauen: Überschreiben Sie `BuildRenderTree` und rufen Sie `builder.OpenElement(0, $"h{level}")` mit einer Ebene auf, die Sie bereits auf 1 bis 6 begrenzt haben. Alles Folgende wurde gegen .NET 10 verifiziert (SDK 10.0.201, `Microsoft.AspNetCore.App` 10.0.5); die APIs sind in den .NET 11 Previews unverändert.

## Warum die beiden naheliegenden Ansätze scheitern

Der erste Reflex ist `<DynamicComponent Type="...">`. Das greift hier nicht. Die Dokumentation beschreibt es als Möglichkeit, "Komponenten nach Typ zu rendern", und die Laufzeit setzt das durch. Die Übergabe eines Elementnamens oder eines beliebigen Typs, der keine Komponente ist, wirft eine Ausnahme, bevor überhaupt etwas gerendert wird:

```text
System.ArgumentException: The component type must implement Microsoft.AspNetCore.Components.IComponent.
```

Ein Gegenstück für HTML-Elemente existiert nicht. `DynamicComponent` dient der Auswahl zwischen `RocketLab.razor` und `SpaceX.razor`, nicht zwischen `h2` und `h3`.

Der zweite Reflex ist, das Tag auf zwei `MarkupString`-Werte aufzuteilen:

```csharp
// .NET 10. Renders correctly in static SSR and breaks interactively.
builder.AddContent(0, (MarkupString)$"<h{Level}>");
builder.AddContent(1, ChildContent);
builder.AddContent(2, (MarkupString)$"</h{Level}>");
```

Das ist die Falle, die man verstehen sollte, denn sie sieht funktionsfähig aus. Über `HtmlRenderer` für statisches serverseitiges Rendering erzeugt sie exakt die richtige Ausgabe:

```html
<h3>Release notes</h3>
```

Das passiert nur, weil statisches SSR die Frames zu einer Zeichenkette verkettet. Ein Blick in den Renderbaum zeigt, was tatsächlich entstanden ist: drei unabhängige Geschwister-Frames, kein Element mit einem Kind.

```text
PrependFrame @sibling 0 frame=[Markup "<h3>"]
PrependFrame @sibling 1 frame=[Text "Release notes"]
PrependFrame @sibling 2 frame=[Markup "</h3>"]
```

In Blazor Server oder WebAssembly durchläuft der Client diese Frames und ruft `insertMarkup` einmal pro Markup-Frame auf, und [`insertMarkup` parst den Inhalt jedes Frames für sich](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts), bevor die entstandenen Knoten eingefügt werden. Der Parser des Browsers macht aus der alleinstehenden Zeichenkette `<h3>` ein leeres `<h3></h3>`-Element und aus der alleinstehenden Zeichenkette `</h3>` überhaupt nichts. Ihr Text landet als Geschwisterknoten *nach* einer leeren Überschrift. Die Komponente besteht einen schnellen Test unter statischem SSR und liefert kaputtes, nicht barrierefreies Markup, sobald der Rendermodus interaktiv wird.

Ein `@switch` über sechs fest verdrahtete Zweige funktioniert tatsächlich. Es sind allerdings sechs Kopien jedes Attributs, jeder CSS-Klasse und des Kindinhalts, die auf Dauer synchron bleiben müssen. Für eine einzelne Komponente ist das vertretbar, für ein Designsystem mit Überschriften, Labels und Abschnittstiteln nicht.

## Schritte: eine Heading-Komponente bauen, die ihr Tag selbst wählt

1. Legen Sie eine reine `.cs`-Datei an, keine `.razor`-Datei. Eine Razor-Komponente generiert bereits eine `BuildRenderTree`-Methode, weshalb eine eigene Deklaration in einem `@code`-Block `CS0111: Type 'Heading' already defines a member called 'BuildRenderTree' with the same parameter types` erzeugt.
2. Leiten Sie von `ComponentBase` ab und ergänzen Sie einen Parameter `int Level`, einen Parameter `RenderFragment? ChildContent` sowie ein Dictionary `AdditionalAttributes` mit `[Parameter(CaptureUnmatchedValues = true)]`, damit Aufrufer weiterhin `class`, `id` und `data-`-Attribute übergeben können.
3. Überschreiben Sie `BuildRenderTree` und begrenzen Sie die Ebene mit `Math.Clamp(Level, 1, 6)`, bevor Sie sie in den Tag-Namen interpolieren. Diese Begrenzung ist eine Sicherheitsmaßnahme, keine Bequemlichkeit.
4. Rufen Sie `builder.OpenElement(0, $"h{level}")` auf, danach `builder.AddMultipleAttributes(1, AdditionalAttributes)`, danach `builder.AddContent(2, ChildContent)` und zuletzt `builder.CloseElement()`.
5. Schreiben Sie jede Sequenznummer als Ganzzahlliteral fest. Verwenden Sie keine Zählervariable, auch keine, die harmlos aussieht.

## Die vollständige Komponente

```csharp
// Heading.cs -- .NET 10, C# 14
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

public class Heading : ComponentBase
{
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        var level = Math.Clamp(Level, 1, 6);

        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
}
```

Die Verwendung entspricht exakt der jeder anderen Komponente:

```razor
@* .NET 10 *@
<Heading Level="SectionDepth" class="title" id="release-notes">
    Release notes
</Heading>
```

Über `HtmlRenderer` gerendert entstehen genau die Ergebnisse, die Sie von Hand schreiben würden:

```text
Level= 1 -> <h1 class="title" id="s1">Release notes</h1>
Level= 3 -> <h3 class="title" id="s1">Release notes</h3>
Level= 6 -> <h6 class="title" id="s1">Release notes</h6>
Level= 9 -> <h6 class="title" id="s1">Release notes</h6>
Level=-4 -> <h1 class="title" id="s1">Release notes</h1>
```

Beachten Sie, dass `AddMultipleAttributes` vor `AddContent` steht. Sämtliche Attribut-Frames eines Elements müssen vor jedem Kindinhalt angehängt werden; eine Verschachtelung wirft zur Renderzeit eine Ausnahme.

## Alles in einer .razor-Datei belassen

Wer Razor nicht verlassen möchte, kann das tun, solange `BuildRenderTree` nicht überschrieben wird. Legen Sie die Builder-Logik als `RenderFragment`-Eigenschaft offen und rendern Sie diese als kompletten Rumpf der Komponente:

```razor
@* Heading.razor -- .NET 10 *@
@Rendered

@code {
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private RenderFragment Rendered => builder =>
    {
        builder.OpenElement(0, $"h{Math.Clamp(Level, 1, 6)}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    };
}
```

Das kompiliert sauber und liefert `<h4 class="title">Release notes</h4>` ohne überzählige Leerraumknoten drumherum, weil der Ausdruck `@Rendered` das einzige Markup der Komponente ist. Das generierte `BuildRenderTree` ruft lediglich Ihr Fragment auf. Wählen Sie den Dateityp, nach dem Ihr Team häufiger sucht; der Renderbaum ist identisch.

## Der Tag-Name erreicht das DOM unverändert

Die Begrenzung aus Schritt 3 ist der Teil, den viele überspringen, und zugleich der entscheidende. `OpenElement` validiert oder maskiert sein Argument `elementName` nicht. Die übergebene Zeichenkette wird als Tag-Name in die Ausgabe geschrieben. Hier eine Komponente mit einem nicht validierten Parameter `string Level`, gerendert mit drei verschiedenen Eingaben:

```text
Level="2"                          -> <h2>hi</h2>
Level="2 onload=alert(1)"          -> <h2 onload=alert(1)>hi</h2 onload=alert(1)>
Level="2><script>alert(1)</script" -> <h2><script>alert(1)</script>hi</h2><script>alert(1)</script>
```

Das ist ein Script-Tag auf Ihrer Seite, entstanden aus einem Komponentenparameter. Blazors automatische Kodierung schützt Text und Attribut*werte*; sie schützt den Tag-Namen nicht, weil dieser nie als Benutzerdatum vorgesehen ist. Microsofts eigene Hinweise zu `RenderTreeBuilder` sagen genau das: eine fehlerhafte Komponente "kann zu undefiniertem Verhalten führen", einschließlich "kompromittierter Sicherheit".

Lassen Sie also niemals einen nicht vertrauenswürdigen oder auch nur unvalidierten Wert bis zu `OpenElement` durch. Nehmen Sie ein `int` statt eines `string`, begrenzen Sie es, und falls Ihre API tatsächlich eine Zeichenkette benötigt, validieren Sie diese gegen eine Positivliste der sechs Überschriftennamen, statt sie zu interpolieren.

## Ein Ebenenwechsel zerstört das Element und baut es neu auf

Blazors Diff-Algorithmus ordnet Frames nach Sequenznummer und Frame-Typ zu. Zwei Element-Frames mit gleicher Sequenznummer, aber *unterschiedlichen* Tag-Namen sind nicht dasselbe Element, weshalb das alte entfernt und ein neues eingefügt wird. Der aufgezeichnete Render-Batch beim Wechsel von `Level` 2 auf 3 zeigt genau das:

```text
after Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Zum Vergleich die Änderung allein des `class`-Attributs, die direkt am Element gepatcht wird:

```text
after class change only:
  SetAttribute @sibling 0 frame=[Attribute class=subtitle]
```

Praktisch bedeutet das: Eine Überschrift, die ihre Ebene wechselt, verliert ihren DOM-Knoten. Der Fokus darin geht verloren, jede erfasste `ElementReference` wird ungültig, CSS-Übergänge starten neu, und ein Drittanbieter-Skript, das sich an diesen Knoten gehängt hatte, hängt jetzt an einer Waise. `@key` rettet das nicht. Keys erlauben dem Diff, Elemente über Umsortierungen hinweg zuzuordnen; sie machen aus zwei verschiedenen Tag-Namen kein identisches Element. Eine Variante mit Key erzeugt Byte für Byte dasselbe Edit-Skript:

```text
keyed, Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Das ist selten ein Problem, weil die Ebene einer Überschrift üblicherweise über die gesamte Lebensdauer des Abschnitts fest bleibt. Zum Problem wird es, wenn die Ebene aus etwas abgeleitet wird, das sich häufig ändert, etwa aus einer aufklappbaren Gliederung, die sich beim Ausklappen von Knoten neu nummeriert. In diesem Fall halten Sie die Ebene stabil und ändern stattdessen die Gestaltung.

## Sequenznummern bleiben fest, auch über Zweige hinweg

Diese Regel bricht man am leichtesten, sobald ein zweiter Codepfad hinzukommt. Es ist verlockend, `var seq = 0;` zu schreiben und überall `seq++` zu verwenden, besonders in einer Komponente mit `if`/`else`. Tun Sie es nicht. Microsofts Dokumentation ist eindeutig: "Die Leistung der App leidet, wenn Sequenznummern dynamisch generiert werden", denn ein Zähler löscht genau die Information, anhand derer der Diff-Algorithmus den betretenen Zweig erkennt. Die Folge sind längere Edit-Skripte und, bei verschachtelten Strukturen, ein deutlich tieferer rekursiver Diff.

Das korrekte Muster ist dasselbe, das der Razor-Compiler selbst erzeugt: Literalzahlen, die in der Reihenfolge des *Quelltexts* ansteigen, wobei jeder Zweig seinen eigenen Bereich besitzt.

```csharp
// AutoHeading.cs -- .NET 10, C# 14
protected override void BuildRenderTree(RenderTreeBuilder builder)
{
    var level = Ambient?.Value ?? 1;

    if (level <= 6)
    {
        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
    else
    {
        builder.OpenElement(3, "div");
        builder.AddAttribute(4, "role", "heading");
        builder.AddAttribute(5, "aria-level", level);
        builder.AddMultipleAttributes(6, AdditionalAttributes);
        builder.AddContent(7, ChildContent);
        builder.CloseElement();
    }
}
```

Wächst eine Komponente über eine Bildschirmseite an Builder-Aufrufen hinaus, kapseln Sie die Teile in `OpenRegion`/`CloseRegion`. Jede Region erhält ihren eigenen Sequenznummernraum, sodass Sie darin bei null neu beginnen können, ohne den Diff zu verwirren.

## Automatische Nivellierung über einen Cascading Value

Die obige Fassung deutet die nützlichere Form dieser Komponente bereits an. Statt jeden Aufrufer die richtige Zahl übergeben zu lassen, liest die Überschrift ihre Tiefe aus dem Kontext. Ein kleiner Cascading Value transportiert die Umgebungsebene, und jede Komponente, die einen verschachtelten Abschnitt öffnet, gibt die nächste Ebene weiter:

```csharp
// HeadingLevel.cs -- .NET 10, C# 14
public sealed class HeadingLevel
{
    public int Value { get; init; } = 1;
    public HeadingLevel Next() => new() { Value = Value + 1 };
}
```

```razor
@* Section.razor -- .NET 10 *@
<CascadingValue Value="_child" IsFixed="true">
    <section>@ChildContent</section>
</CascadingValue>

@code {
    [CascadingParameter] public HeadingLevel? Ambient { get; set; }
    [Parameter] public RenderFragment? ChildContent { get; set; }

    private HeadingLevel _child = default!;

    protected override void OnParametersSet()
        => _child = (Ambient ?? new HeadingLevel()).Next();
}
```

`AutoHeading` benötigt dann überhaupt keinen `Level`-Parameter mehr. Eine Karten-Komponente, die drei Abschnitte tief eingesetzt wird, rendert ein `h4`, ohne irgendetwas über ihren Einsatzort zu wissen, und genau diese Eigenschaft macht wiederverwendbare Komponenten überhaupt erst komponierbar. Setzen Sie `IsFixed="true"` auf dem `CascadingValue`, wenn sich die Ebene nach dem Rendern des Abschnitts nicht mehr ändern kann; damit kann Blazor das Abonnieren jedes Nachfahren auf Änderungsbenachrichtigungen überspringen.

## Was jenseits von h6 zu tun ist

HTML endet bei `h6`, eine tief verschachtelte Gliederung nicht. Statt still zu begrenzen und drei benachbarte `h6`-Elemente zu erzeugen, die assistive Technologie als gleichrangig vorliest, greifen Sie auf das ARIA-Äquivalent zurück. `role="heading"` zusammen mit `aria-level` drückt jede Tiefe aus:

```text
ambient=2 -> <h2 class="title">Release notes</h2>
ambient=6 -> <h6 class="title">Release notes</h6>
ambient=7 -> <div role="heading" aria-level="7" class="title">Release notes</div>
```

Native Elemente bleiben die bessere Wahl, wo es sie gibt. Verwenden Sie daher die echten Tags `h1` bis `h6` für die Ebenen 1 bis 6 und reservieren Sie den ARIA-Rückfall für den Überlauffall. In der Praxis ist der Bedarf an Ebene 7 meist ein Hinweis darauf, dass die Seitenstruktur flacher werden sollte; es lohnt sich also, im Entwicklungsmodus eine Warnung zu protokollieren, sobald der Rückfall greift.

Eine letzte Anmerkung zu den Renderbaum-Typen selbst: Die Dokumentation kennzeichnet alles unterhalb von `Microsoft.AspNetCore.Components.RenderTree` als instabile Framework-Interna. `RenderTreeBuilder` und `ComponentBase.BuildRenderTree` sind öffentliche, unterstützte API und bedenkenlos verwendbar. `RenderBatch` und `RenderTreeEdit` zu lesen, wie ich es oben zur Aufzeichnung der Diff-Ausgabe getan habe, ist zur Diagnose in Ordnung, gehört aber nicht in Produktivcode.

## Verwandte Beiträge

- Die Tag-Auflösung des Razor-Compilers ist der Grund, warum ein variabler Tag-Name überhaupt unmöglich ist, und steckt auch hinter dem Fehler in [Markup-Element mit unerwartetem Namen in Blazor gefunden](/de/2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor/).
- Komponentencode, der auf das DOM zugreift, muss die Grenze des Rendermodus beachten, wie in [JavaScript-Interop-Aufrufe können zu diesem Zeitpunkt nicht ausgeführt werden](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) beschrieben.
- Derselbe Impuls, JS für etwas zu vermeiden, das das Framework nativ beherrscht, gilt beim [Herunterladen einer Datei aus einer Blazor-Komponente ohne JavaScript-Interop](/de/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/).
- Wenn ein Neuaufbau der Überschrift Zustand verliert, der Ihnen wichtig ist, beschreibt [Zustand über die Grenze zwischen statischem und interaktivem Rendering hinweg erhalten](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) den Mechanismus.
- Der gewählte Rendermodus entscheidet, ob der obige `MarkupString`-Fehler überhaupt erreichbar ist; siehe [Blazor Server vs WebAssembly vs United](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Quellen

- [Erweiterte Blazor-Szenarien in ASP.NET Core (Aufbau des Renderbaums)](https://learn.microsoft.com/en-us/aspnet/core/blazor/advanced-scenarios?view=aspnetcore-10.0), einschließlich der Hinweise zu Sequenznummern und der Sicherheitswarnung zu fehlerhaften Komponenten.
- [Dynamisch gerenderte Razor-Komponenten in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/dynamiccomponent?view=aspnetcore-10.0) für den Vertrag von `DynamicComponent`.
- [API-Referenz zu `RenderTreeBuilder.OpenElement`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendering.rendertreebuilder.openelement).
- [`BrowserRenderer.ts` in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) dazu, wie Markup-Frames auf dem Client geparst und eingefügt werden.
