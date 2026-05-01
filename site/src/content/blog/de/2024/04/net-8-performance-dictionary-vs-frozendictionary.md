---
title: ".NET 8 ToFrozenDictionary: Dictionary vs FrozenDictionary"
description: "Konvertieren Sie ein Dictionary mit `ToFrozenDictionary()` in .NET 8 in ein FrozenDictionary für schnellere Lesezugriffe. Benchmark, Anwendungsfälle und der Trade-off zur Build-Zeit."
pubDate: 2024-04-27
updatedDate: 2025-03-27
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2024/04/net-8-performance-dictionary-vs-frozendictionary"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit .NET 8 wird ein neuer Dictionary-Typ eingeführt, der die Leistung von Lesevorgängen verbessert. Der Haken: Sie dürfen keine Änderungen an Schlüsseln und Werten vornehmen, sobald die Sammlung erstellt wurde. Dieser Typ ist besonders nützlich für Sammlungen, die bei der ersten Verwendung befüllt und dann für die gesamte Laufzeit eines langlebigen Dienstes vorgehalten werden.

Schauen wir uns an, was das in Zahlen bedeutet. Mich interessieren zwei Dinge:

-   die Erstellungsleistung des Dictionarys, da die Arbeit für die Lese-Optimierung wahrscheinlich Auswirkungen darauf hat
-   die Leseleistung für einen zufälligen Schlüssel in der Liste

## Auswirkung auf die Leistung bei der Erstellung

Für diesen Test nehmen wir 10.000 vorinstanziierte `KeyValuePair<string, string>` und erstellen drei verschiedene Arten von Dictionarys:

-   ein normales Dictionary: `new Dictionary(source)`
-   ein eingefrorenes Dictionary: `source.ToFrozenDictionary(optimizeForReading: false)`
-   und ein eingefrorenes Dictionary, das für das Lesen optimiert ist: `source.ToFrozenDictionary(optimizeForReading: true)`

Und wir messen mit BenchmarkDotNet, wie lange jede dieser Operationen dauert. Dies sind die Ergebnisse:

```plaintext
|                              Method |       Mean |    Error |   StdDev |
|------------------------------------ |-----------:|---------:|---------:|
|                          Dictionary |   284.2 us |  1.26 us |  1.05 us |
|        FrozenDictionaryNotOptimized |   486.0 us |  4.71 us |  4.41 us |
| FrozenDictionaryOptimizedForReading | 4,583.7 us | 13.98 us | 12.39 us |
```

Bereits ohne Optimierung sehen wir, dass das Erstellen des `FrozenDictionary` etwa doppelt so lange dauert wie das Erstellen eines normalen Dictionary. Aber der eigentliche Effekt zeigt sich, wenn die Daten für das Lesen optimiert werden. In diesem Szenario haben wir einen Anstieg um `16x`. Lohnt sich das? Wie schnell ist der Lesezugriff?

## Leseleistung des eingefrorenen Dictionarys

In diesem ersten Szenario, in dem wir das Abrufen eines einzelnen Schlüssels aus der 'Mitte' des Dictionarys testen, erhalten wir die folgenden Ergebnisse:

```plaintext
|                              Method |      Mean |     Error |    StdDev |
|------------------------------------ |----------:|----------:|----------:|
|                          Dictionary | 11.609 ns | 0.0170 ns | 0.0142 ns |
|        FrozenDictionaryNotOptimized | 10.203 ns | 0.0218 ns | 0.0193 ns |
| FrozenDictionaryOptimizedForReading |  4.789 ns | 0.0121 ns | 0.0113 ns |
```

Im Wesentlichen scheint das `FrozenDictionary` `2,4x` schneller zu sein als das normale `Dictionary`. Eine deutliche Verbesserung!

Wichtig ist, hier auf die unterschiedlichen Maßeinheiten zu achten. Bei der Erstellung liegen die Zeiten im Mikrosekunden-Bereich, und insgesamt verlieren wir etwa 4299 us (Mikrosekunden). Umgerechnet in ns (Nanosekunden) sind das 4.299.000 ns. Das heißt, um einen Leistungsvorteil durch die Verwendung des `FrozenDictionary` zu erzielen, müssten wir mindestens 630.351 Leseoperationen darauf ausführen. Das sind viele Lesevorgänge.

Sehen wir uns noch ein paar weitere Testszenarien an und welche Auswirkungen sie auf die Leistung haben.

### Szenario 2: kleines Dictionary (100 Einträge)

Die Verhältnisse bleiben offenbar gleich, wenn man mit einem kleineren Dictionary arbeitet. In Bezug auf das Kosten-Nutzen-Verhältnis profitieren wir etwas früher, nach etwa 4800 Leseoperationen.

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|                          Dictionary_Create |  1.477 us | 0.0033 us | 0.0028 us |
| FrozenDictionaryOptimizedForReading_Create | 31.922 us | 0.1346 us | 0.1259 us |
|                            Dictionary_Read | 10.788 ns | 0.0156 ns | 0.0122 ns |
|   FrozenDictionaryOptimizedForReading_Read |  4.444 ns | 0.0155 ns | 0.0129 ns |
```

### Szenario 3: Schlüssel an verschiedenen Positionen lesen

In diesem Szenario testen wir, ob die Leistung in irgendeiner Weise vom abgerufenen Schlüssel beeinflusst wird (also davon, wo er in der internen Datenstruktur liegt). Den Ergebnissen nach hat das keinerlei Einfluss auf die Leseleistung.

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|  FrozenDictionaryOptimizedForReading_First |  4.314 ns | 0.0102 ns | 0.0085 ns |
| FrozenDictionaryOptimizedForReading_Middle |  4.311 ns | 0.0079 ns | 0.0066 ns |
|   FrozenDictionaryOptimizedForReading_Last |  4.314 ns | 0.0180 ns | 0.0159 ns |
```

### Szenario 4: großes Dictionary (10 Millionen Einträge)

Bei großen Dictionarys bleibt die Leseleistung nahezu gleich. Wir sehen einen Anstieg der Lesezeit um 18 %, trotz einer `1000x` Vergrößerung des Dictionarys. Allerdings steigt die Anzahl der Lesevorgänge, die für einen Netto-Leistungsgewinn nötig wären, deutlich auf 2.135.735.439, also über 2 Milliarden Lesezugriffe.

```plaintext
|                                     Method |        Mean |     Error |    StdDev |
|------------------------------------------- |------------:|----------:|----------:|
|                          Dictionary_Create |    905.1 ms |   2.56 ms |   2.27 ms |
| FrozenDictionaryOptimizedForReading_Create | 13,886.4 ms | 276.22 ms | 483.77 ms |
|                            Dictionary_Read |   11.203 ns | 0.2601 ns | 0.3472 ns |
|   FrozenDictionaryOptimizedForReading_Read |    5.125 ns | 0.0295 ns | 0.0230 ns |
```

### Szenario 5: komplexer Schlüssel

Hier sind die Ergebnisse sehr interessant. Unser Schlüssel sieht so aus:

```cs
public class MyKey
{
    public string K1 { get; set; }

    public string K2 { get; set; }
}
```

Und wie wir sehen können, gibt es in diesem Fall kaum Leistungsverbesserungen beim Lesen im Vergleich zum normalen `Dictionary`, während die Erstellung des Dictionarys etwa 4-mal langsamer ist.

```plaintext
|                                     Method |     Mean |     Error |    StdDev |
|------------------------------------------- |---------:|----------:|----------:|
|                          Dictionary_Create | 247.7 us |   3.27 us |   3.05 us |
| FrozenDictionaryOptimizedForReading_Create | 991.2 us |   8.75 us |   8.18 us |
|                            Dictionary_Read | 6.344 ns | 0.0602 ns | 0.0533 ns |
|   FrozenDictionaryOptimizedForReading_Read | 6.041 ns | 0.0954 ns | 0.0845 ns |
```

### Szenario 6: mit Records

Aber was, wenn wir einen `record` statt einer `class` verwenden würden? Das sollte mehr Leistung bringen, oder? Anscheinend nicht. Es ist sogar noch seltsamer, da die Lesezeiten von `6 ns` auf `44 ns` springen.

```plaintext
|                                     Method |       Mean |    Error |   StdDev |
|------------------------------------------- |-----------:|---------:|---------:|
|                          Dictionary_Create |   654.1 us |  2.29 us |  2.14 us |
| FrozenDictionaryOptimizedForReading_Create | 1,761.4 us |  8.67 us |  8.11 us |
|                            Dictionary_Read |   45.37 ns | 0.088 ns | 0.082 ns |
|   FrozenDictionaryOptimizedForReading_Read |   44.44 ns | 0.120 ns | 0.107 ns |
```

## Fazit

Basierend auf den getesteten Szenarien war die einzige Verbesserung, die wir gesehen haben, die Verwendung von `string`-Schlüsseln. Alles andere, was wir bisher ausprobiert haben, führte zur gleichen Leseleistung wie das normale `Dictionary`, mit zusätzlichem Overhead bei der Erstellung.

Selbst wenn Sie `string`s als Schlüssel für Ihr `FrozenDictionary` verwenden, sollten Sie überlegen, wie viele Lesezugriffe Sie über die Lebensdauer dieses Dictionarys hinweg machen werden, da es einen Overhead bei der Erstellung gibt. Im Test mit 10.000 Einträgen lag dieser Overhead bei etwa 4.299.000 ns. Die Leseleistung verbesserte sich um `2,4x`, mit einem Rückgang von `11,6 ns` auf `4,8 ns`, doch das bedeutet weiterhin, dass Sie etwa 630.351 Leseoperationen auf dem Dictionary benötigen, bevor sich ein Netto-Leistungsgewinn ergibt.
