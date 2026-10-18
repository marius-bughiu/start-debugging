---
title: "Zahlen mit indischer Lakh/Crore-Ziffern-Gruppierung in .NET formatieren (NumberGroupSizes)"
description: "Verwenden Sie die Kultur en-IN oder setzen Sie NumberFormatInfo.NumberGroupSizes auf [3, 2], um in C# 12,34,56,789 statt 123,456,789 auszugeben. Gemessen auf .NET 10 und .NET 11 RC1: wie das Array funktioniert, warum CurrencyGroupSizes getrennt ist, die Invariant-Globalization-Falle, die stillschweigend westliche Gruppierung ausgibt, und ein Hilfsmittel für Lakh/Crore-Wörter."
pubDate: 2026-10-18
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "globalization"
  - "formatting"
lang: "de"
translationOf: "2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Kurzantwort:** Übergeben Sie die Kultur `en-IN` (oder eine andere indische Kultur wie `hi-IN`) an `ToString("N2", culture)`, und .NET gibt `12,34,56,789.50` statt `123,456,789.50` aus, weil diese Kulturen bereits `NumberFormatInfo.NumberGroupSizes = [3, 2]` mitbringen. Wenn Sie die Gruppierung ohne den Rest der Kultur benötigen, klonen Sie ein `NumberFormatInfo`, setzen `NumberGroupSizes = [3, 2]` (sowie `CurrencyGroupSizes` und `PercentGroupSizes`, wenn Sie `C` oder `P` verwenden) und übergeben es als Format-Provider. Das Array bedeutet: "Die erste Gruppe von rechts hat 3 Ziffern, jede weitere Gruppe hat 2." Es funktioniert gleichermaßen für `int`, `long`, `decimal`, `double`, `BigInteger`, eigene `#,##0`-Muster und `TryFormat`.

Alles Folgende wurde mit dem .NET SDK 10.0.302 (Laufzeit 10.0.10) und mit .NET 11 RC1 (`11.0.100-rc.1.26425.128`) unter macOS mit ICU und C# 14 gemessen. Die Ausgabe war auf beiden Laufzeiten byte-identisch, und die API `NumberGroupSizes` selbst hat sich seit .NET Framework 1.1 nicht geändert, sodass derselbe Code auch unter .NET 8 und 9 funktioniert.

## Warum sich die indische Gruppierung von der westlichen unterscheidet

Die westliche Konvention gruppiert alle drei Ziffern: Tausend, Million, Milliarde. Das indische Zahlensystem gruppiert die ersten drei Ziffern (Hunderter) und danach jeweils zwei Ziffern: Tausend, Lakh (1,00,000), Crore (1,00,00,000) und so weiter. Hundertdreiundzwanzig Millionen vierhundertsechsundfünfzigtausendsiebenhundertneunundachtzig wird in den USA als `123,456,789` und in Indien als `12,34,56,789` geschrieben (12 Crore, 34 Lakh, 56 Tausend, 789).

.NET kodiert keine der beiden Konventionen fest. Jedes `NumberFormatInfo` enthält drei Integer-Arrays, die beschreiben, wie der ganzzahlige Teil einer Zahl in Gruppen aufgeteilt wird:

- `NumberGroupSizes`, verwendet vom Format `N` und von eigenen Mustern mit `,`
- `CurrencyGroupSizes`, verwendet vom Format `C`
- `PercentGroupSizes`, verwendet vom Format `P`

Der Formatierer durchläuft diese Arrays vom Dezimaltrenner nach links. Das ist der gesamte Mechanismus, und der Grund, warum ein einzelnes Array beide Konventionen beschreiben kann.

## Minimales Beispiel: dieselbe Zahl, zwei Kulturen

```csharp
// .NET 11, C# 14 (also .NET 10.0.10)
using System.Globalization;

var us  = CultureInfo.GetCultureInfo("en-US");
var inr = CultureInfo.GetCultureInfo("en-IN");
decimal amount = 123456789.5m;

Console.WriteLine(string.Join(",", us.NumberFormat.NumberGroupSizes));  // 3
Console.WriteLine(string.Join(",", inr.NumberFormat.NumberGroupSizes)); // 3,2

Console.WriteLine(amount.ToString("N2", us));   // 123,456,789.50
Console.WriteLine(amount.ToString("N2", inr));  // 12,34,56,789.50
Console.WriteLine(amount.ToString("C", inr));   // ₹12,34,56,789.50
Console.WriteLine(12345.678.ToString("P1", inr)); // 12,34,567.8%
```

`hi-IN`, `bn-IN` und `ta-IN` melden für alle drei Arrays dieselben Größen `[3, 2]`. Sie verwenden in der Ausgabe außerdem ASCII-Ziffern: Die numerische Formatierung von .NET ersetzt nie durch `NativeDigits`, Sie erhalten also `12,34,56,789` und keine Devanagari- oder Bengali-Ziffern, unabhängig davon, welche indische Kultur Sie wählen.

## Die Lösung, Schritt für Schritt

Wenn Ihre App bereits mit einer indischen Kultur als `CurrentCulture` läuft, sind Sie fertig: `$"{amount:N2}"` übernimmt die Gruppierung automatisch. Meistens benötigen Sie die indische Gruppierung jedoch auf einem Server, dessen Kultur `en-US` oder invariant ist, oder für eine einzelne Spalte in einem Bericht. Dieses Vorgehen funktioniert in jedem Fall.

1. Entscheiden Sie, ob Sie die gesamte indische Kultur oder nur deren Ziffern-Gruppierung wollen. `en-IN` bringt auch das Währungssymbol `₹`, Datumsangaben im Stil `dd-MM-yyyy` und indisch-englische Monatsnamen mit. Wenn Sie nur die Kommas wollen, erstellen Sie stattdessen ein eigenes `NumberFormatInfo`.
2. Beginnen Sie mit einer beschreibbaren Kopie. `CultureInfo.GetCultureInfo(...)` und `CultureInfo.InvariantCulture` liefern schreibgeschützte Instanzen, und eine Zuweisung an deren `NumberFormat`-Eigenschaften wirft `InvalidOperationException: Instance is read-only.` Rufen Sie `Clone()` auf dem `NumberFormatInfo` auf oder erstellen Sie eine Kultur mit `new CultureInfo("en-US")`, die beschreibbar ist.
3. Weisen Sie die Gruppengrößen zu. Setzen Sie `NumberGroupSizes = [3, 2]` für `N` und eigene Muster. Setzen Sie auch `CurrencyGroupSizes` und `PercentGroupSizes`, wenn Sie mit `C` oder `P` formatieren; das sind unabhängige Arrays.
4. Frieren Sie das Objekt mit `NumberFormatInfo.ReadOnly(nfi)` ein und halten Sie es in einem `static readonly`-Feld, damit alle Aufrufer einen einzigen unveränderlichen Provider teilen.
5. Übergeben Sie es als `IFormatProvider` an `ToString`, `TryFormat`, `string.Format` oder `string.Create`, oder setzen Sie es als `CurrentCulture`, wenn der gesamte Thread es verwenden soll.

Als Code:

```csharp
// .NET 11, C# 14
using System.Globalization;

public static class IndianNumberFormat
{
    public static readonly NumberFormatInfo Grouping = Create();

    private static NumberFormatInfo Create()
    {
        var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        nfi.NumberGroupSizes   = [3, 2];
        nfi.CurrencyGroupSizes = [3, 2];
        nfi.PercentGroupSizes  = [3, 2];
        nfi.CurrencySymbol     = "₹"; // invariant default is the generic ¤
        return NumberFormatInfo.ReadOnly(nfi);
    }
}

decimal amount = 123456789.5m;
Console.WriteLine(amount.ToString("N2", IndianNumberFormat.Grouping)); // 12,34,56,789.50
Console.WriteLine(amount.ToString("C",  IndianNumberFormat.Grouping)); // ₹12,34,56,789.50
```

Wenn Sie Schritt 3 für die Währung vergessen, erhalten Sie eine verwirrende Halbmigration. Wenn nur `NumberGroupSizes` geändert wurde, gab `amount.ToString("C", nfi)` in meinem Test weiterhin `¤123,456,789.50` aus, weil das Format `C` `CurrencyGroupSizes` liest, das noch `[3]` war.

Um die Gruppierung für eine ganze Anfrage oder einen Thread zu ändern, ohne die Sprache aller anderen Dinge anzutasten, patchen Sie eine beschreibbare Kultur:

```csharp
// .NET 11, C# 14
using System.Globalization;

var culture = new CultureInfo("en-US");          // writable, unlike GetCultureInfo
culture.NumberFormat.NumberGroupSizes = [3, 2];
CultureInfo.CurrentCulture = culture;

Console.WriteLine($"{123456789:N0}");            // 12,34,56,789
Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:N0}", 123456789)); // 123,456,789
```

Die zweite Zeile erinnert daran, dass ein ausdrücklich angegebener Provider immer Vorrang vor `CurrentCulture` hat.

## Wie das Array NumberGroupSizes interpretiert wird

Die Regeln, gegen die Laufzeit geprüft und nicht einfach geglaubt:

- Element 0 ist die Größe der Gruppe, die dem Dezimaltrenner am nächsten liegt. Element 1 ist die nächste Gruppe weiter links, und so weiter.
- Das **letzte Element wiederholt sich** für alle verbleibenden Gruppen. Deshalb erzeugt `[3, 2]` endlos Zweiergruppen.
- Ist das letzte Element `0`, werden die restlichen Ziffern **überhaupt nicht gruppiert**.
- Jedes Element muss zwischen 1 und 9 liegen, mit Ausnahme des letzten, das 0 sein darf. Alles andere wirft `ArgumentException` mit der Meldung "Every element in the value array should be between one and nine, except for the last element, which can be zero."

So wirken sich verschiedene Arrays auf `1234567890` aus:

```csharp
// .NET 11, C# 14
using System.Globalization;

var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
long n = 1234567890;

nfi.NumberGroupSizes = [3];       Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,890
nfi.NumberGroupSizes = [3, 2];    Console.WriteLine(n.ToString("N0", nfi)); // 1,23,45,67,890
nfi.NumberGroupSizes = [3, 0];    Console.WriteLine(n.ToString("N0", nfi)); // 1234567,890
nfi.NumberGroupSizes = [3, 2, 0]; Console.WriteLine(n.ToString("N0", nfi)); // 12345,67,890
nfi.NumberGroupSizes = [4];       Console.WriteLine(n.ToString("N0", nfi)); // 12,3456,7890
nfi.NumberGroupSizes = [1, 2, 3]; Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,89,0
nfi.NumberGroupSizes = [0];       Console.WriteLine(n.ToString("N0", nfi)); // 1234567890
nfi.NumberGroupSizes = [];        Console.WriteLine(n.ToString("N0", nfi)); // 1234567890

nfi.NumberGroupSizes = [3, 0, 2]; // ArgumentException: 0 is only allowed last
nfi.NumberGroupSizes = [10];      // ArgumentException: max is 9
```

`[4]` ist die Form, die Sie für die ostasiatische Gruppierung nach Zehntausend (wan/man) brauchen, falls ein Design sie verlangt; keine eingebaute .NET-Kultur verwendet sie standardmäßig. `[3, 0]` ist praktisch, wenn eine Spezifikation sagt: "nur Tausender trennen".

Der Getter liefert eine Kopie des Arrays. Die Zuweisung `nfi.NumberGroupSizes[0] = 9` lässt sich kompilieren und ausführen, ändert aber nichts: In meinem Test blieb die Ausgabe `12,34,56,789.50`. Weisen Sie immer ein neues Array zu.

## Welche Formate die Gruppierung berücksichtigen und welche nicht

Ich habe alle gängigen Pfade mit `en-IN` ausgeführt:

| Aufruf | Ausgabe |
|---|---|
| `1234567890123L.ToString("N0", inr)` | `12,34,56,78,90,123` |
| `amount.ToString("#,##0.00", inr)` | `12,34,56,789.50` |
| `BigInteger.Parse("123456789012345").ToString("N0", inr)` | `12,34,56,78,90,12,345` |
| `12345678f.ToString("N0", inr)` | `1,23,45,678` |
| `int.MinValue.ToString("N0", inr)` | `-2,14,74,83,648` |
| `123456789.TryFormat(span, out _, "N0", inr)` | `12,34,56,789` |
| `1234567.ToString("D", inr)` / `"G"` / `"F2"` | `1234567` / `1234567` / `1234567.89` |

`N`, `C`, `P` und eigene Muster mit `,` folgen also alle den Arrays, auch auf dem allokationsfreien `TryFormat`-Pfad. `D`, `G`, `F`, `E` und das parameterlose `ToString()` gruppieren in keiner Kultur.

Ein Detail bei eigenen Formaten sorgt oft für Verwirrung: Die Position des Kommas in einem eigenen Muster spielt keine Rolle. `123456789.ToString("#,##,##0", enUS)` gibt `123,456,789` aus, nicht `12,34,56,789`. Ein Komma zwischen Ziffernplatzhaltern schaltet die Gruppierung lediglich ein; die Größen stammen immer aus `NumberGroupSizes`. Indische Gruppierung erhalten Sie nicht, indem Sie das "richtige" Muster schreiben. Sie müssen den Provider ändern. Ein Komma unmittelbar vor dem Dezimaltrenner (oder am Ende) ist eine ganz andere Funktion: Es teilt pro Komma durch 1.000, sodass `"0,,"` aus `123456789` die Zahl `123` macht.

## Fallstricke

### Invariant Globalization gibt stillschweigend westliche Gruppierung aus

Dieser Fall landet in der Produktion. Viele Container-Images und Native-AOT-Apps setzen `<InvariantGlobalization>true</InvariantGlobalization>` (oder `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`), um die ICU-Abhängigkeit loszuwerden. In diesem Modus wirft `CultureInfo.GetCultureInfo("en-IN")` die Ausnahme `CultureNotFoundException: Only the invariant culture is supported in globalization-invariant mode.` Das ist wenigstens laut.

Die stille Variante tritt auf, wenn jemand zusätzlich `PredefinedCulturesOnly` auf `false` setzt (`DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=0`), damit die Ausnahme verschwindet. Dann gelingt `new CultureInfo("en-IN")`, aber die Kultur trägt invariante Daten. Ich habe `sizes=3`, `123,456,789` aus `N0` und `¤` als Währungssymbol gemessen, ohne Ausnahme und ohne Warnung. Ihre indischen Nutzer erhalten amerikanische Kommas.

Wenn Sie das `NumberFormatInfo` wie in der Klasse `IndianNumberFormat` oben selbst aus `InvariantCulture` aufbauen, funktioniert die Gruppierung auch im Invariant-Modus, weil nichts von ICU-Daten abhängt. Das ist die robusteste Option für Container. Wenn Sie die vollständige Kultur `en-IN` benötigen, behalten Sie ICU im Image; die [Lösung für ICU im Container](/de/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) beschreibt die Pakete, und der [Vergleich der Container-Bereitstellung](/de/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) behandelt, welche Image-Typen den Invariant-Modus einschalten.

### Die Standardgenauigkeit von "N" ist nicht portabel

Auf diesem Mac meldete ICU für `en-IN`, `hi-IN`, `en-US` und `en-GB` gleichermaßen `NumberDecimalDigits = 3`, sodass `amount.ToString("N", inr)` mit drei Nachkommastellen `12,34,56,789.500` ausgab, während `CurrencyDecimalDigits` bei 2 blieb. Im Invariant-Modus gab derselbe Aufruf zwei Nachkommastellen aus. Die Kulturdaten stammen aus dem ICU des Betriebssystems (oder aus NLS bei älteren Windows-Setups), der Standardwert kann sich also zwischen Ihrem Laptop und Ihrem Server unterscheiden. Geben Sie immer eine explizite Genauigkeit an: `N0`, `N2`, niemals nur `N`, für alles, was ein Benutzer oder ein Test vergleicht.

### Das Parsen ignoriert Gruppenpositionen

`decimal.Parse("1,23,45,678.90", NumberStyles.Number, enUS)` liefert `12345678.90`, und `decimal.Parse("12,345,678", NumberStyles.Number, inr)` ebenso. Mit `NumberStyles.AllowThousands` akzeptiert .NET Gruppentrenner an beliebiger Stelle im ganzzahligen Teil und prüft sie nicht gegen `NumberGroupSizes`. Das ist praktisch, um beide Eingabestile zu akzeptieren, bedeutet aber, dass das Parsen kein Validator ist. Wenn Sie `12,345,678` für ein Feld im indischen Format ablehnen müssen, prüfen Sie die Form vor dem Parsen mit einem regulären Ausdruck wie `^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$`.

### Ein anderer Trenner

Indische Styleguides verlangen manchmal ein schmales Leerzeichen statt eines Kommas. Setzen Sie `NumberGroupSeparator` (und `CurrencyGroupSeparator` für `C`) auf demselben geklonten `NumberFormatInfo`; ich habe `"\u202F"` (schmales geschütztes Leerzeichen) getestet und `12 34 56 789` bei unveränderten Größen erhalten. Verwenden Sie ein geschütztes Leerzeichen, damit die Zahl nie über Zeilen hinweg umbricht.

## "12.35 lakh" und "2.5 crore" ausgeben

`NumberGroupSizes` steuert Trenner, keine Wörter. .NET hat keinen eingebauten kompakten Formatierer, der "lakh" oder "crore" erzeugt (das Konzept `CompactDecimalFormat` existiert in ICU, wird aber nicht über `ToString` bereitgestellt). Ein kleines Hilfsmittel deckt den üblichen UI-Bedarf ab:

```csharp
// .NET 11, C# 14
using System.Globalization;

static string ToLakhCrore(decimal value, int decimals = 2)
{
    var inr = CultureInfo.GetCultureInfo("en-IN");
    const decimal Lakh = 1_00_000m, Crore = 1_00_00_000m;
    decimal abs = Math.Abs(value);
    string sign = value < 0 ? "-" : "";
    string fmt = "#,##0." + new string('#', decimals);

    // Round in the target unit first, then promote if rounding crossed the boundary.
    decimal inLakh = Math.Round(abs / Lakh, decimals, MidpointRounding.AwayFromZero);
    if (abs >= Crore || inLakh >= 100m)
        return sign + Math.Round(abs / Crore, decimals, MidpointRounding.AwayFromZero).ToString(fmt, inr) + " crore";
    if (abs >= Lakh || inLakh >= 1m)
        return sign + inLakh.ToString(fmt, inr) + " lakh";
    return sign + abs.ToString(fmt, inr);
}

Console.WriteLine(ToLakhCrore(45_000m));         // 45,000
Console.WriteLine(ToLakhCrore(1_25_000m));       // 1.25 lakh
Console.WriteLine(ToLakhCrore(12_34_567m));      // 12.35 lakh
Console.WriteLine(ToLakhCrore(99_99_999m));      // 1 crore
Console.WriteLine(ToLakhCrore(2_50_00_000m));    // 2.5 crore
Console.WriteLine(ToLakhCrore(1234_56_78_901m)); // 1,234.57 crore
Console.WriteLine(ToLakhCrore(-3_50_000m));      // -3.5 lakh
```

Der Schritt "erst runden, dann hochstufen" ist wichtig. Eine naive Version, die `abs >= Crore` vor dem Runden prüft, gibt für `99,99,999` den Wert `100 lakh` aus, was kein indischer Leser so schreiben würde. Beachten Sie die Zifferntrenner in den C#-Literalen (`1_00_000m`): Der Compiler akzeptiert `_` an beliebiger Stelle zwischen Ziffern, sodass Sie die indische Gruppierung zur besseren Lesbarkeit im Quellcode nachbilden können.

Wenn das Hilfsmittel in einem Container mit Invariant Globalization läuft, ersetzen Sie `CultureInfo.GetCultureInfo("en-IN")` durch den Provider `IndianNumberFormat.Grouping` von oben, aus den Gründen im obigen Fallstrick.

## Hinweise zur Leistung

Die Gruppengrößen werden pro Formatierungsaufruf einmal aus Arrays gelesen, die bereits im `NumberFormatInfo` liegen, sodass `[3, 2]` genauso viel kostet wie `[3]`. Der teure Fehler ist, pro Aufruf ein neues `CultureInfo` zu erzeugen oder ein `NumberFormatInfo` zu klonen. Halten Sie den Provider wie gezeigt in einem `static readonly`-Feld und verwenden Sie `TryFormat` in einen Stack-Puffer, wenn Sie in einer heißen Schleife formatieren; der [Vergleich von StringBuilder und String-Interpolation](/de/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/) zeigt, wie viel der allokationsfreie Pfad spart, wenn Sie größere Zeichenfolgen aus vielen Zahlen aufbauen.

## Verwandte Artikel

- [Fix: Couldn't find a valid ICU package installed on the system in a .NET container](/de/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/), falls `en-IN` in Docker eine Ausnahme wirft.
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/de/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/), dazu, wo Invariant Globalization eingeschaltet wird.
- [How to use Native AOT with ASP.NET Core minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), das standardmäßig den Invariant-Modus verwendet.
- [.NET 11 can round-trip a double as hex, bit for bit](/de/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/) zu einer weiteren Ecke der numerischen Formatierung und von `NumberStyles`.

## Quellen

- [NumberFormatInfo.NumberGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.numbergroupsizes) auf Microsoft Learn.
- [NumberFormatInfo.CurrencyGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.currencygroupsizes) auf Microsoft Learn.
- [Standard numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) und [custom numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings), einschließlich Gruppentrenner und Skalierungsangabe.
- [Globalization and ICU in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu).
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode), die Änderung in .NET 6, die `PredefinedCulturesOnly` einführte.
