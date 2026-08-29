---
title: "Fix: CA1070 \"Do not declare event fields as virtual\""
description: "CA1070 greift bei feldartigen Ereignissen mit virtual. Entfernen Sie virtual, lassen Sie das Ereignis nicht virtuell und geben Sie abgeleiteten Klassen eine protected virtual OnXxx-Methode."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "analyzers"
  - "events"
lang: "de"
translationOf: "2026/08/fix-ca1070-do-not-declare-event-fields-as-virtual"
translatedBy: "claude"
translationDate: 2026-08-29
---

CA1070 greift, wenn ein feldartiges Ereignis den Modifizierer `virtual` trägt. Die Lösung besteht darin, `virtual` zu entfernen und abgeleiteten Klassen stattdessen eine auslösende Methode `protected virtual void OnThresholdReached(...)` zum Überschreiben zu geben. Das ist keine Stilfrage: Wenn irgendetwas dieses virtuelle Ereignis überschreibt, gibt der Compiler der Basisklasse und der abgeleiteten Klasse zwei getrennte private Backing-Felder, und das Auslösen in der Basisklasse ruft stillschweigend nichts auf.

Der Diagnosetext, nach dem Sie suchen:

```text
warning CA1070: Event 'ThresholdReached' should not be declared virtual
```

Alles Folgende wurde mit SDK `10.0.302` (.NET 10, C# 14) verifiziert, mit den Analyzern, die im SDK enthalten sind, und gegen den Quellcode von `DoNotDeclareEventFieldsAsVirtual` in `dotnet/sdk`.

## Meldet dotnet build CA1070 überhaupt?

Nein. Der Schweregrad ist standardmäßig Vorschlag, nicht Warnung, denn der Analyzer wird mit `RuleLevel.IdeSuggestion` deklariert:

```csharp
// dotnet/sdk, Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs
internal static readonly DiagnosticDescriptor Rule = DiagnosticDescriptorHelper.Create(
    RuleId,
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualTitle)),
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualMessage)),
    DiagnosticCategory.Design,
    RuleLevel.IdeSuggestion,
    ...
```

Diagnosen auf Vorschlagsebene erscheinen in Visual Studio, Rider und `dotnet format`, aber `dotnet build` gibt sie nicht aus und `TreatWarningsAsErrors` erfasst sie nicht. Ein Projekt voller virtueller Ereignisse kompiliert so:

```text
    0 Warning(s)
    0 Error(s)
```

Zwei Wege, die Regel scharf zu stellen:

```xml
<!-- .NET 10 SDK 10.0.302: promotes the All-mode analyzers, CA1070 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
```

Das ist dieselbe Unsichtbarkeitsfalle wie bei [CA1873 und teuren Logging-Argumenten](/de/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/), und die Abwägungen beim Hochstufen von Vorschlägen in der CI behandelt [TreatWarningsAsErrors ohne die Entwickler-Builds zu sabotieren](/de/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## Was bringt Leute dazu, ein Ereignis als virtual zu markieren?

Fast immer CS0070. Eine abgeleitete Klasse kann ein Ereignis der Basisklasse nicht auslösen:

```csharp
// .NET 10, C# 14
public class Sensor
{
    public event EventHandler? ThresholdReached;
}

public class LoggingSensor : Sensor
{
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}
```

```text
error CS0070: The event 'Sensor.ThresholdReached' can only appear on the left hand side
of += or -= (except when used from within the type 'Sensor')
```

Der Compiler sagt Ihnen damit, dass ein Ereignis außerhalb des deklarierenden Typs nur ein add/remove-Paar ist, niemals das Delegate dahinter. Der naheliegend wirkende Ausweg besteht darin, das Ereignis als `virtual` zu markieren und es in `LoggingSensor` zu überschreiben, damit der Name auf etwas auflöst, das die abgeleitete Klasse besitzt. Das kompiliert. Es zerstört auch das Ereignis.

## Warum zerstört das Überschreiben eines virtuellen feldartigen Ereignisses das Ereignis?

Die Basisklasse löst nicht mehr aus. Hier ist der gesamte Fehler in einer einzigen Datei:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System;

public class Sensor
{
    public virtual event EventHandler? ThresholdReached;   // CA1070
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached;
    public void RaiseFromDerived() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public static class Program
{
    public static void Main()
    {
        LoggingSensor derived = new();
        Sensor asBase = derived;
        asBase.ThresholdReached += (_, _) => Console.WriteLine("handler ran");

        Console.WriteLine("Sensor.Raise():");
        asBase.Raise();                 // fires nothing
        Console.WriteLine("LoggingSensor.RaiseFromDerived():");
        derived.RaiseFromDerived();     // fires the handler
    }
}
```

Tatsächliche Ausgabe unter .NET 10:

```text
Sensor.Raise():
LoggingSensor.RaiseFromDerived():
handler ran
```

Dasselbe Objekt, derselbe Handler: ein Auslösen funktioniert, das andere ist wirkungslos.

Der Grund ist, dass ein feldartiges Ereignis gleichzeitig zwei verschiedene Dinge ist und nur eines davon virtuell. Die Accessoren `add` und `remove` sind echte Methoden und erhalten den Modifizierer `virtual` tatsächlich. Das dahinterliegende Delegate-Feld nicht, denn Felder können nicht virtuell sein. Reflexion über die kompilierte Assembly zeigt genau, was der Compiler erzeugt hat:

```text
Sensor: field ThresholdReached, IsPrivate=True, type=EventHandler
Sensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=Sensor
LoggingSensor: field ThresholdReached, IsPrivate=True, type=EventHandler
LoggingSensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=LoggingSensor
```

Zwei private Felder, eines pro Typ. Also:

- `asBase.ThresholdReached += handler` läuft über den virtuellen add-Accessor, wird an `LoggingSensor.add_ThresholdReached` verteilt und landet im Feld von `LoggingSensor`.
- `Sensor.Raise()` läuft über gar keinen Accessor. Innerhalb des deklarierenden Typs kompiliert `ThresholdReached?.Invoke(...)` zu einem direkten Lesen des eigenen privaten Feldes von `Sensor`, das weiterhin null ist.

Die C#-Spezifikation erlaubt das. Eine virtuelle Ereignisdeklaration macht die Accessoren virtuell, und eine überschreibende Ereignisdeklaration "deklariert kein neues Ereignis, sie spezialisiert lediglich die Implementierungen der Accessoren". Die Formulierung der Spezifikation legt nahe, dass die abgeleiteten Accessoren den Zugriff auf ein gemeinsames Feld spezialisieren sollten, was den Compiler zwingen würde, das Backing-Feld der Basis von privat auf geschützt hochzustufen. Das hat er nie getan. Microsoft hat dies 2007 als bekannten Compilerfehler dokumentiert und entschieden, ihn nicht zu beheben, weil eine Behebung Handler-Aufrufe in Code wiederbeleben würde, der sich still darauf verlassen hat, dass sie nie laufen.

Geändert hat sich seit 2007, dass der Fehler leiser geworden ist. Das ursprüngliche Repro nutzte `myEvent(this, null)` und warf eine `NullReferenceException`, was zumindest auf das Problem hinwies. Der moderne nullbedingte Aufruf, zu dem jeder Analyzer und jede Codekorrektur Sie drängt, macht daraus einen stillen Leerlauf.

## Wie zeigt sich das in einer MVVM-Basisklasse?

Die Form, zu der Leute beim Schreiben von `INotifyPropertyChanged` in einem Basis-View-Model greifen, ist genau der kaputte Fall:

```csharp
// .NET 10, C# 14
public class ViewModelBase : INotifyPropertyChanged
{
    public virtual event PropertyChangedEventHandler? PropertyChanged;   // CA1070
    protected void Notify(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public class OrderViewModel : ViewModelBase
{
    public override event PropertyChangedEventHandler? PropertyChanged;
}
```

Die Binding-Engine abonniert über das Interface `INotifyPropertyChanged`, was zum virtuellen add-Accessor führt, der den Handler auf `OrderViewModel` ablegt. `Notify` läuft innerhalb von `ViewModelBase` und liest das Feld von `ViewModelBase`. Ich habe unter .NET 10 bestätigt, dass der Handler nie aufgerufen wird: die Oberfläche aktualisiert sich schlicht nicht, ohne Exception und ohne Binding-Fehler im Ausgabefenster.

Das `override` im abgeleiteten View-Model ist meist ein Überbleibsel, hinzugefügt von jemandem, der CS0070 hinterherlief, oder aus einer Vorlage kopiert. Es zu löschen repariert das Binding sofort, weil es dann nur noch ein Backing-Feld gibt. Das lohnt sich zu prüfen, bevor Sie irgendetwas umschreiben. Wenn Sie die Benachrichtigungsinfrastruktur von Grund auf bauen, erzeugt [ein Source Generator für INotifyPropertyChanged](/de/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) die korrekte nicht virtuelle Form und macht diesen Fehler nie.

## Wie behebe ich CA1070?

In der Reihenfolge der Präferenz.

**1. Nicht virtuelles Ereignis plus eine protected virtual auslösende Methode.** Das ist das Muster, das die .NET-Designrichtlinien vorschreiben, und genau dorthin lenkt CA1070 Sie. Abgeleitete Klassen bekommen den Erweiterungspunkt, den sie eigentlich wollten, und es gibt genau ein Backing-Feld.

```csharp
// .NET 10, C# 14. Builds clean under AnalysisMode=All.
public class Sensor
{
    public event EventHandler? ThresholdReached;

    protected virtual void OnThresholdReached(EventArgs e)
        => ThresholdReached?.Invoke(this, e);

    public void Raise() => OnThresholdReached(EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    protected override void OnThresholdReached(EventArgs e)
    {
        Console.WriteLine("[derived saw the raise]");
        base.OnThresholdReached(e);
    }
}
```

Beachten Sie, dass die auslösende Methode das Feld liest und daher im deklarierenden Typ liegen muss. Abgeleitete Überschreibungen rufen `base.OnThresholdReached(e)` auf, um tatsächlich auszulösen. Vergessen Sie den `base`-Aufruf, haben Sie das Ereignis unterdrückt, was manchmal genau die Absicht ist.

**2. Ereignis virtuell lassen, aber explizite Accessoren über einem geschützten Feld schreiben.** Nutzen Sie das, wenn die abgeleitete Klasse das Abonnieren wirklich abfangen muss, etwa um beim ersten Abonnenten verzögert einen Hook des Betriebssystems einzuhängen. CA1070 greift hier nicht, weil die Regel nur feldartige Ereignisse betrifft.

```csharp
// .NET 10, C# 14
public class Sensor
{
    protected EventHandler? _thresholdReached;

    public virtual event EventHandler? ThresholdReached
    {
        add => _thresholdReached += value;
        remove => _thresholdReached -= value;
    }

    public void Raise() => _thresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached
    {
        add { Console.WriteLine("[derived add]"); _thresholdReached += value; }
        remove => _thresholdReached -= value;
    }
}
```

Das `+=` auf einem Delegate-Feld ist nicht atomar, verwenden Sie also `Interlocked.CompareExchange` oder ein Lock in den Accessoren, wenn Abonnenten aus mehreren Threads kommen können. Beide Handler wurden in meinem Durchlauf korrekt ausgelöst, weil nun beide Accessoren dasselbe geschützte Feld ansprechen.

**3. Das Ereignis der Basis abstract machen.** Ein abstraktes feldartiges Ereignis kann nicht wie ein Feld verwendet werden, die Basisklasse kann es also physisch nicht auslösen und der Fehler mit getrennten Feldern kann nicht auftreten. CA1070 greift nicht, weil der Analyzer `IsVirtual` prüft, was für abstrakte Member false ist.

```csharp
// .NET 10, C# 14
public abstract class Sensor
{
    public abstract event EventHandler? ThresholdReached;
    public abstract void Raise();
}
```

Das ist korrekt, aber selten das, was Sie wollen, da nun jede abgeleitete Klasse das Ereignis und das Auslösen neu implementieren muss.

## Welche Deklarationen meldet CA1070 tatsächlich?

Nur die `virtual`-Deklaration der Basis, was diejenigen überrascht, die den Analyzer laufen lassen und erwarten, dass er auf die tatsächlich kaputte Zeile zeigt. Die Prüfung ist eine einzige Symbolaktion:

```csharp
// dotnet/sdk, DoNotDeclareEventFieldsAsVirtual.cs
if (!eventSymbol.IsVirtual ||
    eventSymbol.AddMethod?.IsImplicitlyDeclared == false ||
    eventSymbol.RemoveMethod?.IsImplicitlyDeclared == false)
{
    return;
}
```

`IEventSymbol.IsVirtual` ist nur für Member true, die mit dem Schlüsselwort `virtual` deklariert wurden. Ein `override`-Member meldet `IsOverride`, nicht `IsVirtual`, und ein `abstract`-Member meldet `IsAbstract`. Die Diagnose landet also auf der Basisdeklaration und sonst nirgends. Die Prüfungen auf `IsImplicitlyDeclared` beschränken die Regel auf feldartige Ereignisse: Wenn Sie die Accessoren selbst geschrieben haben, sind sie nicht implizit und die Regel bricht ab.

Hier ist die vollständige Matrix, die ich gebaut und gegen SDK 10.0.302 mit `dotnet_diagnostic.CA1070.severity = warning` ausgeführt habe:

| Deklaration | CA1070? |
| --- | :---: |
| `public virtual event EventHandler A;` | ja |
| `protected virtual event EventHandler B;` in einer öffentlichen, nicht versiegelten Klasse | ja |
| `internal virtual event EventHandler C;` | nein |
| `public virtual event EventHandler D { add {} remove {} }` | nein |
| `public override event EventHandler A;` in der abgeleiteten Klasse | nein |
| `public abstract event EventHandler E;` | nein |
| `public virtual event EventHandler F;` innerhalb einer `internal`-Klasse | nein |
| `public event EventHandler G;` (nicht virtuell) | nein |

Die beiden Zeilen, die Leute überraschen, sind die internen, und sie sind konfigurierbar.

## Wie erfasst CA1070 auch internal- und private-Ereignisse?

Standardmäßig analysiert die Regel nur extern sichtbare Symbole, entsprechend dem alten FxCop-Verhalten. Setzen Sie `api_surface`, um sie zu erweitern:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
dotnet_code_quality.CA1070.api_surface = all
```

Auf derselben Matrix meldet `api_surface = all` A, B, C und F. `api_surface = private, internal` meldet nur C und F. Für eine Anwendungsassembly statt einer veröffentlichten Bibliothek ist `all` die richtige Einstellung: dort ist nichts ein öffentlicher API-Vertrag, und dem Fehler ist die Sichtbarkeit egal.

Eine Abweichung in der Dokumentation ist erwähnenswert: Die MS-Learn-Seite führt als anwendbare Sprachen "C# and Visual Basic" auf, der Analyzer ist jedoch mit `[DiagnosticAnalyzer(LanguageNames.CSharp)]` attributiert, samt Unterdrückungskommentar "Construct is invalid in VB.NET". VB kennt von vornherein kein `Overridable` feldartiges Ereignis, es gibt also nichts zu analysieren; die Tabelle in der Dokumentation ist schlicht veraltet.

## Wann ist es sicher, CA1070 zu unterdrücken?

Wenn das virtuelle Ereignis bereits Teil einer ausgelieferten öffentlichen API ist. `virtual` zu entfernen ist eine binäre Breaking Change für jeden, der es überschrieben hat, deshalb lautet die Empfehlung der Regel selbst, zu unterdrücken statt Konsumenten zu brechen. Unterdrücken Sie an der Deklaration, nicht projektweit, und hinterlassen Sie eine Notiz:

```csharp
// Public since v2.0. Removing 'virtual' is a binary break for derived types.
#pragma warning disable CA1070
public virtual event EventHandler? ThresholdReached;
#pragma warning restore CA1070
```

Fügen Sie danach trotzdem die geschützte auslösende Methode hinzu, damit neue abgeleitete Typen einen korrekten Erweiterungspunkt haben und nicht mehr zu `override` greifen. In einer neuen oder internen Codebasis unterdrücken Sie nicht. Beheben Sie es.

## Fallstricke und Verwechslungen, die versehentlich hier landen

**CS0070** ("The event 'X' can only appear on the left hand side of += or -=") ist der Compilerfehler, der Leute dazu bringt, `virtual` zu schreiben, oben behandelt. Die Lösung ist eine geschützte auslösende Methode, niemals ein virtuelles Ereignis.

**CS0067** ("The event 'X' is never used") erscheint am abgeleiteten `override`, sobald Sie diesem Artikel folgen und das Ereignis nicht mehr aus der abgeleiteten Klasse auslösen. Diese Warnung ist der für den Analyzer sichtbare Geist eines Backing-Feldes, in das niemand schreibt; das Löschen des Overrides beseitigt sie.

**CA1030** ("Use events where appropriate") und **CA1003** ("Use generic event handler instances") sind Designregeln zur Form von Ereignissen, nicht zur Virtualität, und keine von beiden hat mit dem Fehler der getrennten Felder zu tun.

**"Ich habe es virtual gemacht, damit Moq oder Castle DynamicProxy es abfangen können."** Proxy-basierte Mocking-Bibliotheken brauchen tatsächlich virtuelle Member, und das Abfangen von Ereignissen ist der eine Fall, in dem ihnen nachzugeben einen echten Fehler einpflanzt. Mocken Sie stattdessen das Interface: extrahieren Sie `IThresholdSource` mit einem schlichten `event EventHandler ThresholdReached` und lassen Sie den Mock es implementieren, dann braucht nichts mehr `virtual`. Dasselbe gilt für eine Basisklasse, die pauschal virtuell gemacht wurde, um EF Core Lazy-Loading-Proxys zu bedienen, wo in Wahrheit nur Navigationseigenschaften das benötigen.

Wenn ein virtuelles Ereignis bereits ausgeliefert wurde und Sie die Folgen suchen, ist das Symptom meist ein Handler, der für immer abonniert bleibt und nie aufgerufen wird, was sich als verwurzeltes Delegate in einem Heap-Dump zeigt. [Ein verwaltetes Speicherleck mit dotnet-gcdump und dotnet-dump diagnostizieren](/de/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) zeigt, wie Sie die überlebende Handler-Kette finden.

CA1070 ist seit den .NET-5-Analyzern dabei, mit Schweregrad Info, und wurde nie hochgestuft. Das ist eine faire Entscheidung für eine Regel, deren Sprengsatz nur zündet, wenn jemand `override` schreibt, bedeutet aber: die Warnung, die Ihnen am ehesten einen Nachmittag "warum aktualisiert sich mein Binding nicht" erspart, gibt Ihr Build nie aus. Sie zur Warnung zu machen kostet eine Zeile `.editorconfig`.

## Verwandt

- [Fix: CA1873 "Evaluation of this argument may be expensive and unnecessary if logging is disabled"](/de/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/)
- [Einen Source Generator für INotifyPropertyChanged schreiben](/de/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [TreatWarningsAsErrors ohne die Entwickler-Builds zu sabotieren (.NET 10)](/de/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [Ein verwaltetes Speicherleck mit dotnet-gcdump und dotnet-dump diagnostizieren](/de/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)

## Quellen

- [CA1070: Do not declare event fields as virtual](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1070) auf MS Learn
- [DoNotDeclareEventFieldsAsVirtual.cs](https://github.com/dotnet/sdk/blob/main/src/Microsoft.CodeAnalysis.NetAnalyzers/src/Microsoft.CodeAnalysis.NetAnalyzers/Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs), der Quellcode des Analyzers
- [Virtual events in C#](https://learn.microsoft.com/en-us/archive/blogs/samng/virtual-events-in-c), der Beitrag des C#-Teams von 2007, der den Compilerfehler und die Entscheidung dagegen dokumentierte
- [How to raise base class events in derived classes](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/events/how-to-raise-base-class-events-in-derived-classes) auf MS Learn
- [Handle and raise events](https://learn.microsoft.com/en-us/dotnet/standard/events/), die .NET-Designrichtlinien für Ereignisse
- [Compiler Error CS0070](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0070) auf MS Learn
- [Konfigurationsoption api_surface](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/code-quality-rule-options#api_surface) für Code-Qualitätsregeln
