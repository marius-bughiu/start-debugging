---
title: "C# 14: Das field-Schlüsselwort und Eigenschaften mit field-basierter Speicherung"
description: "C# 14 führt das kontextuelle Schlüsselwort field für Eigenschafts-Accessoren ein. So können Sie zu Auto-Properties benutzerdefinierte Logik hinzufügen, ohne ein separates Hintergrundfeld zu deklarieren."
pubDate: 2025-04-05
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/c-14-the-field-keyword-and-field-backed-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 14 führt ein neues kontextuelles Schlüsselwort ein, **`field`**, das innerhalb der Accessoren einer Eigenschaft (den Blöcken `get`, `set` oder `init`) verwendet werden kann, um auf die zugrunde liegende Speicherung der Eigenschaft zu verweisen. Einfach gesagt ist `field` ein Platzhalter, der die verborgene Variable repräsentiert, in der der Wert einer Eigenschaft gespeichert wird. Mit diesem Schlüsselwort können Sie automatisch implementierten Eigenschaften benutzerdefinierte Logik hinzufügen, ohne manuell ein separates privates Feld zu deklarieren. Es war erstmals als Vorschau in C# 13 verfügbar (mit .NET 9 und der Sprachversion auf Preview gesetzt) und ist offiziell Teil der Sprache in C# 14.

**Warum ist das nützlich?** Wollten Sie vor C# 14 Logik (etwa Validierung oder Änderungs-Benachrichtigung) zu einer Eigenschaft hinzufügen, mussten Sie sie zu einer vollständigen Eigenschaft mit privatem Hintergrundfeld machen. Das bedeutete mehr Boilerplate-Code und das Risiko, dass andere Klassenmitglieder versehentlich direkt auf das Feld zugreifen und so die Eigenschaftslogik umgehen. Das neue `field`-Schlüsselwort löst diese Probleme, indem der Compiler das Hintergrundfeld für Sie erzeugt und verwaltet, während Sie in Ihrem Eigenschaftscode einfach `field` verwenden. Das Ergebnis sind klarere, wartungsfreundlichere Eigenschaftsdeklarationen, und das Hintergrundspeicher leakt nicht in den restlichen Gültigkeitsbereich Ihrer Klasse.

## Vorteile und Anwendungsfälle von `field`

Das Schlüsselwort `field` wurde eingeführt, um Eigenschaftsdeklarationen prägnanter und weniger fehleranfällig zu machen. Hier die wichtigsten Vorteile und Szenarien, in denen es nützlich ist:

-   **Manuelle Hintergrundfelder entfallen:** Sie müssen nicht mehr für jede Eigenschaft ein privates Mitgliedsfeld schreiben, nur um benutzerdefiniertes Verhalten hinzuzufügen. Der Compiler stellt automatisch ein verborgenes Hintergrundfeld bereit, auf das über das Schlüsselwort `field` zugegriffen wird. Das reduziert Boilerplate-Code und hält Ihre Klassendefinition übersichtlicher.
-   **Eigenschaftszustand bleibt gekapselt:** Das vom Compiler erzeugte Hintergrundfeld ist nur über die Accessoren der Eigenschaft (per `field`) zugänglich, nicht woanders in Ihrer Klasse. Das verhindert versehentlichen Missbrauch des Felds aus anderen Methoden oder Eigenschaften und stellt sicher, dass Invarianten oder Validierungen im Eigenschafts-Accessor nicht umgangen werden können.
-   **Einfachere Eigenschaftslogik (Validierung, Lazy Initialization usw.):** Es bietet einen sauberen Weg, Logik zu Auto-Properties hinzuzufügen. Häufige Szenarien sind:
    
    -   _Validierung oder Bereichsprüfung:_ z. B. sicherstellen, dass ein Wert nicht negativ ist oder in einem Bereich liegt, bevor er akzeptiert wird.
    -   _Änderungs-Benachrichtigung:_ z. B. `INotifyPropertyChanged`-Ereignisse nach dem Setzen eines neuen Werts auslösen.
    -   _Lazy Initialization oder Standardwerte:_ z. B. im Getter `field` beim ersten Zugriff initialisieren oder einen Standardwert zurückgeben, falls noch nicht gesetzt.


    In früheren C#-Versionen erforderten diese Szenarien eine vollständige Eigenschaft mit separatem Feld. Mit `field` können Sie sie direkt in der `get`/`set`-Logik der Eigenschaft umsetzen, ohne zusätzliche Felder.
-   **Mischen von automatischen und benutzerdefinierten Accessoren:** C# 14 erlaubt, dass ein Accessor automatisch implementiert ist und der andere einen Body verwendet, der `field` benutzt. Beispielsweise können Sie einen benutzerdefinierten `set` bereitstellen und `get` automatisch lassen, oder umgekehrt. Der Compiler erzeugt, was für den nicht geschriebenen Accessor nötig ist. Das war früher nicht möglich; vorher musste man, sobald man einem Accessor einen Body gab, für beide eine explizite Implementierung liefern.

Insgesamt verbessert `field` die Lesbarkeit und Wartbarkeit, indem redundanter Code wegfällt und der Fokus nur auf dem benötigten benutzerdefinierten Verhalten liegt. Konzeptionell ist es vergleichbar mit der Funktionsweise des Schlüsselworts `value` in einem Setter (das den zugewiesenen Wert repräsentiert); hier steht `field` für die zugrunde liegende Speicherung der Eigenschaft.

## Vorher vs. nachher: manuelles Hintergrundfeld vs. `field`-Schlüsselwort

Um den Unterschied zu sehen, vergleichen wir, wie Sie eine Eigenschaft, die eine Regel erzwingt, **vor** C# 14 deklariert hätten und **nach** der Einführung des neuen `field`-Schlüsselworts.

**Szenario:** Angenommen, wir wollen eine Eigenschaft `Hours`, die niemals auf eine negative Zahl gesetzt werden darf. In älteren C#-Versionen hätten wir Folgendes geschrieben:

**Vor C# 14, mit manuellem Hintergrundfeld:**

```cs
public class TimePeriodBefore
{
    private double _hours;  // backing field

    public double Hours
    {
        get { return _hours; }
        set 
        {
            if (value < 0)
                throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
            _hours = value;
        }
    }
}
```

In diesem Code vor C# 14 mussten wir ein privates Feld `_hours` einführen, um den Wert zu speichern. Der Getter der Eigenschaft gibt dieses Feld zurück, und der Setter führt eine Prüfung durch, bevor er `_hours` zuweist. Das funktioniert, ist aber wortreich: Wir haben zusätzlichen Code, um `_hours` zu deklarieren und zu verwalten, und `_hours` ist überall in der Klasse zugänglich (das heißt, andere Methoden **könnten** in `_hours` schreiben und die Validierungslogik umgehen, wenn man nicht aufpasst).

**Ab C# 14, mit dem `field`-Schlüsselwort:**

```cs
public class TimePeriod
{
    public double Hours
    {
        get;  // auto-implemented getter (compiler provides it)
        set => field = (value >= 0) 
            ? value 
            : throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
    }
}
```

Hier ist die Eigenschaft `Hours` ohne explizites Hintergrundfeld deklariert. Wir verwenden `get;` ohne Body, was auf einen automatischen Getter hinweist, und stellen einen Body für `set` bereit, der `field` nutzt. Der Ausdruck `field = ...` im Setter weist den Compiler an, dem Hintergrundfeld der Eigenschaft etwas zuzuweisen. Der Compiler erzeugt im Hintergrund automatisch ein privates Feld und implementiert den `get`-Accessor so, dass er dieses Feld zurückgibt. Im obigen Setter werfen wir bei negativem `value` eine Ausnahme; andernfalls weisen wir `field` zu (das den Wert speichert). Wir mussten `_hours` **nicht** selbst deklarieren, und der Body des Getters muss auch nicht geschrieben werden; das übernimmt der Compiler. Das Ergebnis ist eine prägnantere Eigenschaftsdefinition mit demselben Verhalten.

Beachten Sie, wie viel klarer die C#-14-Variante ist:

-   wir haben das explizite Feld `_hours` entfernt; der Compiler kümmert sich darum.
-   der `get`-Accessor bleibt ein einfacher, automatisch implementierter (`get;`), den der Compiler in "gib das Hintergrundfeld zurück" verwandelt.
-   der `set`-Accessor enthält nur die Logik, die uns interessiert (die Prüfung auf nicht negativ); die eigentliche Zuweisung an die Speicherung erledigt `field = value`.

Sie können `field` bei Bedarf auch in einem `get`-Accessor verwenden. Um beispielsweise eine Lazy-Initialisierung zu implementieren, könnten Sie etwa Folgendes schreiben:

```cs
public string Name 
{
    get => field ??= "Unknown";
    set => field = value;
}
```

In diesem Fall weist der Getter beim ersten Zugriff auf `Name`, falls noch nicht gesetzt, dem Hintergrundfeld einen Standardwert `"Unknown"` zu und gibt ihn zurück. Folgende Lese- oder Schreibzugriffe nutzen dasselbe `field`. Ohne dieses Feature hätten Sie ein privates Feld und mehr Code im Getter gebraucht, um dasselbe Verhalten zu erreichen.

## Wie behandelt der Compiler das `field`-Schlüsselwort?

Wenn Sie `field` in einem Eigenschafts-Accessor verwenden, erzeugt der Compiler im Hintergrund ein verborgenes Hintergrundfeld für diese Eigenschaft (sehr ähnlich wie bei einer automatisch implementierten Eigenschaft). Dieses Feld sehen Sie in Ihrem Quellcode nie, der Compiler vergibt aber einen internen Namen (z. B. so etwas wie `<Hours>k__BackingField`) und nutzt es, um den Wert der Eigenschaft zu speichern. Folgendes passiert unter der Haube:

-   **Erzeugung des Hintergrundfelds:** Verwendet mindestens ein Accessor einer Eigenschaft `field` (oder haben Sie eine automatisch implementierte Eigenschaft ohne Bodies), erzeugt der Compiler ein privates Feld zur Speicherung des Werts. Sie müssen dieses Feld nicht deklarieren. Im obigen `TimePeriod.Hours`-Beispiel würde der Compiler ein Feld zum Speichern des Stundenwerts erzeugen, und sowohl der `get`- als auch der `set`-Accessor arbeiten mit diesem Feld (entweder implizit oder über das `field`-Schlüsselwort).
-   **Implementierung von Getter/Setter:**
    -   Für einen automatisch implementierten Accessor (wie `get;` oder `set;` ohne Body) erzeugt der Compiler automatisch die einfache Logik, um das Hintergrundfeld zurückzugeben oder zu setzen.
    -   Für einen Accessor, in dem Sie einen Body mit `field` angegeben haben, integriert der Compiler Ihre Logik und behandelt `field` im erzeugten Code als Verweis auf das Hintergrundfeld. Beispielsweise wird `set => field = value;` im kompilierten Output zu etwas wie `set { backingField = value; }`, wobei jegliche zusätzliche Logik, die Sie geschrieben haben, drumherum erhalten bleibt.
    -   Sie können automatische und benutzerdefinierte Accessoren mischen. Wenn Sie zum Beispiel einen Body für `set` schreiben (mit `field`) und `get` als `get;` lassen, erzeugt der Compiler den `get` für Sie. Umgekehrt könnten Sie einen benutzerdefinierten `get` schreiben (z. B. `get => ComputeSomething(field)`) und einen automatisch implementierten `set;` haben; in diesem Fall erzeugt der Compiler den Setter so, dass er einfach das Hintergrundfeld zuweist.
-   **Verhalten ist äquivalent zu manuellen Feldern:** Das Kompilat mit `field` ist im Wesentlichen dasselbe, als hätten Sie manuell ein privates Feld geschrieben und es in Ihrer Eigenschaft verwendet. Es gibt keine Performance-Strafe und keine Magie, abgesehen davon, dass Ihnen Boilerplate erspart bleibt. Es ist rein eine Annehmlichkeit zur Kompilierzeit. Beispielsweise kompilieren die beiden `Hours`-Implementierungen oben (mit und ohne `field`) zu sehr ähnlichem IL-Code; beide haben ein privates Feld für den Wert und Eigenschafts-Accessoren, die dieses Feld manipulieren. Der Unterschied: Den Code für eine der beiden hat der C#-14-Compiler für Sie geschrieben.
-   **Eigenschaftsinitialisierer:** Wenn Sie einen Initialisierer auf einer Eigenschaft verwenden, die `field` nutzt (zum Beispiel `public int X { get; set => field = value; } = 42;`), initialisiert der Initialisierer direkt das Hintergrundfeld _bevor_ der Konstruktor läuft, genauso wie bei traditionellen Auto-Properties. Die Setter-Logik wird während der Objektkonstruktion **nicht** aufgerufen. (Das ist wichtig, wenn Ihr Setter Seiteneffekte hat; diese werden für den Initialwert via Initialisierer nicht ausgeführt. Falls Sie wollen, dass die Setter-Logik bei der Initialisierung läuft, weisen Sie die Eigenschaft im Konstruktor zu, anstatt einen Initialisierer zu verwenden.)
-   **Attribute am Hintergrundfeld:** Möchten Sie Attribute auf das erzeugte Hintergrundfeld anwenden, erlaubt C# _feldgerichtete Attribute_ mit der Syntax `[field: ...]`. Das war bereits bei Auto-Properties möglich und funktioniert auch hier. Beispielsweise können Sie `[field: NonSerialized] public int Id { get; set => field = value; }` schreiben, um das automatisch erzeugte Feld als nicht serialisierbar zu markieren. (Das funktioniert nur, wenn tatsächlich ein Hintergrundfeld für die Eigenschaft existiert, also mindestens ein Accessor `field` verwendet oder es eine Auto-Property ist.)

TLDR: Der Compiler erzeugt ein privates Hintergrundfeld und verdrahtet Ihre Eigenschafts-Accessoren so, dass sie es verwenden. Sie erhalten die Funktionalität einer vollständigen Eigenschaft mit nur einem Bruchteil des Codes. Implementierungstechnisch bleibt die Eigenschaft eine echte automatische Eigenschaft; Sie haben nur einen Hook erhalten, um Logik einzuhängen.

## Syntax- und Verwendungsregeln für `field`

Beim Einsatz des `field`-Schlüsselworts beachten Sie folgende Regeln und Einschränkungen:

-   **Nur in Eigenschafts-/Indexer-Accessoren:** `field` kann **nur** im Body eines Eigenschafts- oder Indexer-Accessors verwendet werden (im Codeblock oder Ausdruck für `get`, `set` oder `init`). Es ist ein _kontextuelles_ Schlüsselwort, d. h. außerhalb eines Eigenschafts-Accessors hat `field` keine besondere Bedeutung (es würde einfach als Bezeichner gewertet). Wenn Sie versuchen, `field` in einer normalen Methode oder außerhalb einer Eigenschaft zu verwenden, erhalten Sie einen Kompilierfehler; der Compiler weiß dann nicht, welches Hintergrundfeld gemeint ist.
-   **Kontextuelles Schlüsselwort (nicht vollständig reserviert):** Da `field` kein global reserviertes Schlüsselwort ist, könnten Sie technisch gesehen Variablen oder Mitglieder namens `field` an anderer Stelle haben. Innerhalb eines Eigenschafts-Accessors wird `field` jedoch als Schlüsselwort behandelt und verweist auf das Hintergrundfeld, nicht auf eine Variable namens `field`. Siehe "Namenskonflikte" weiter unten zum Umgang mit diesem Szenario.
-   **Verwendung in get/set/init-Accessoren:** Sie können `field` in einem `get`-, `set`- oder `init`-Accessor verwenden. In einem Setter oder Init-Accessor wird `field` typischerweise zugewiesen (z. B. `field = value;`). In einem Getter könnten Sie `field` zurückgeben oder verändern (z. B. `return field;` oder `field ??= defaultValue;`). Sie können `field` in nur einem Accessor oder in beiden verwenden, je nach Bedarf:
    -   Verwenden Sie `field` **nur in einem Accessor**, können Sie den anderen als automatisch implementiert (`get;` oder `set;` ohne Body) belassen, und der Compiler erzeugt trotzdem das Hintergrundfeld und verdrahtet alles.
    -   Verwenden Sie `field` in **beiden** Accessoren, ist das ebenfalls in Ordnung; Sie schreiben dann effektiv die Logik für Get und Set aus (aber weiterhin ohne das Feld manuell zu deklarieren). Das kann sinnvoll sein, wenn sowohl Lesen als auch Schreiben Sonderbehandlung brauchen. Beispielsweise könnte ein Setter eine Bedingung erzwingen und ein Getter bei einem ersten Zugriff eine Transformation oder Lazy Loading durchführen, beide unter Nutzung desselben `field`.
-   **`field` ist außerhalb des Accessors nicht referenzierbar:** Sie können den `field`-Verweis nicht speichern und woanders verwenden, und Sie können auch nicht direkt außerhalb der Eigenschaft auf das vom Compiler erzeugte Hintergrundfeld zugreifen. Dieses Hintergrundfeld ist in Ihrem Quellcode quasi anonym (auch wenn der Compiler ihm einen internen Namen gibt). Wenn Sie mit dem Wert interagieren müssen, tun Sie das über die Eigenschaft oder innerhalb ihrer Accessoren mit `field`.
-   **Nicht für Events:** Das `field`-Schlüsselwort ist für Eigenschaften (und Indexer) gedacht. Für die add/remove-Accessoren von Events ist es **nicht** verfügbar. (Auch Events in C# können Hintergrundfelder für den Delegate haben, aber das Sprachteam hat sich gegen eine Erweiterung von `field` auf Event-Accessoren entschieden.)
-   **Nicht mit expliziten Felddeklarationen mischen:** Wenn Sie sich entscheiden, ein eigenes Hintergrundfeld für eine Eigenschaft zu deklarieren, sollten Sie `field` nicht in den Accessoren dieser Eigenschaft verwenden. In dem Fall verweisen Sie einfach wie traditionell mit dem Namen auf Ihr explizites Feld. Das `field`-Schlüsselwort soll in solchen Szenarien gerade die Notwendigkeit eines expliziten Felds ersetzen. Anders gesagt: Eine Eigenschaft hat entweder ein implizites, vom Compiler verwaltetes Feld (wenn Sie `field` oder Auto-Accessoren verwenden) oder Sie verwalten es selbst, aber nicht beides.

Kurz gesagt: Verwenden Sie `field` innerhalb Ihrer Eigenschafts-Accessoren, um auf den verborgenen Speicher dieser Eigenschaft zu verweisen, und sonst nirgends. Für alles außerhalb von Eigenschaften gelten die normalen C#-Sichtbarkeitsregeln.

## Umgang mit Namenskonflikten (wenn Sie eine eigene `field`-Variable haben)

Da `field` in älteren C#-Versionen kein reserviertes Wort war, ist es möglich (wenn auch ungewöhnlich), dass etwas Code "field" als Variablen- oder Feldnamen verwendet hat. Mit der Einführung des kontextuellen Schlüsselworts `field` in Accessoren könnte solcher Code mehrdeutig werden oder brechen. Das Sprachdesign berücksichtigt das:

-   **`field` in einem Accessor verdeckt Bezeichner:** Innerhalb der Eigenschafts-Accessoren **verdeckt** das neue Schlüsselwort `field` jeden Bezeichner namens `field`, den Sie in diesem Scope haben könnten. Wenn Sie etwa eine lokale Variable oder einen Parameter namens `field` in einem Setter haben (vielleicht aus altem Code), interpretiert der Compiler `field` jetzt als Schlüsselwort für das Hintergrundfeld, nicht als Ihre Variable. In C# 14 führt das zu einem Kompilierfehler, wenn Sie versuchen, eine Variable namens `field` in einem Accessor zu deklarieren oder zu verwenden, weil `field` jetzt als Schlüsselwort erwartet wird.
-   **Mit `@field` oder `this.field` auf das tatsächliche Feld verweisen:** Wenn Sie _wirklich_ ein Mitgliedsfeld in Ihrer Klasse haben, das wörtlich "field" heißt (nicht empfohlen, aber möglich), oder eine Variable namens "field" im Scope, können Sie sie weiterhin referenzieren, indem Sie den Namen escapen. C# erlaubt, einem Bezeichner ein `@` voranzustellen, um ihn auch dann zu verwenden, wenn er ein Schlüsselwort ist. Hat Ihre Klasse z. B. `private int field;` und Sie müssen es in einem Accessor referenzieren, schreiben Sie `@field`, um es als Bezeichner anzusprechen. Ebenso können Sie `this.field` nutzen, um explizit auf das Mitgliedsfeld zu verweisen. Mit `@` oder einer Qualifizierung umgehen Sie die Interpretation als kontextuelles Schlüsselwort und greifen auf die tatsächliche Variable zu.

```cs
private int field = 10; // a field unfortunately named "field" 
public int Example
{
    get { return @field; } // use @field to return the actual field 
    set { @field = value; } // or this.field = value; either works 
}
```

-   Wenn Sie aber die Möglichkeit haben, ist es besser, das Mitglied umzubenennen, um Verwirrung zu vermeiden. In modernem C# sollte `field` allein in einem Accessor dem Hintergrundfeld des Compilers vorbehalten bleiben. Wenn Sie eine ältere Codebasis auf C# 14 aktualisieren, warnt Sie der Compiler, wenn er Verwendungen von `field` findet, die zuvor auf etwas anderes verwiesen, und weist Sie darauf hin, sie zu disambiguieren.
-   **Den Namen ganz vermeiden:** Als generelle Best Practice sollten Sie `field` nicht als Bezeichner in Ihrem Code verwenden. Da es jetzt (im Kontext) ein Schlüsselwort ist, würde die Behandlung als gewöhnlicher Name Leser verwirren und kann zu Fehlern führen. Wenn Sie bislang `field` als Variablennamen verwendet haben, denken Sie beim Wechsel zu C# 14 ans Umbenennen. Übliche Namenskonventionen (etwa private Felder mit `_` zu präfixieren) verhindern diesen Konflikt in den meisten Fällen ohnehin.

## Referenzen

1.  [`field` – Field backed property declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field#:~:text=The%20,contextual%20keyword)​
2.  ​[C# Feature Proposal Notes – _"`field` keyword in properties"_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/field-keyword#:~:text=Auto%20properties%20only%20allow%20for,accessors%20from%20within%20the%20class)
3.  ​[What's new in C# 14](/2024/12/csharp-14/)
