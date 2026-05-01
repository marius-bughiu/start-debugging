---
title: "Wie lange braucht ein PC, um bis eine Billion zu zählen"
description: "Benchmark, wie lange ein PC braucht, um bis eine Billion und darüber hinaus zu zählen, mit aktualisierten Ergebnissen aus 2023."
pubDate: 2013-10-13
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2013/10/counting-up-to-one-trillion"
translatedBy: "claude"
translationDate: 2026-05-01
---
Diese Frage kam in einem Gespräch mit einem Kollegen über ein Unternehmen mit über 20 trillion dollars Wert auf -- und wir konnten uns einfach nicht vorstellen, wie so viel Geld in bar aussehen würde. Um eine Vorstellung zu bekommen, haben wir berechnet, wie viele Hundert-Dollar-Scheine es bräuchte, um die Erde einmal zu umrunden -- die Antwort waren, glaube ich, etwa 240.000.000, also rund 24 billion US dollars. Das ist eine Menge Geld. Wie lange würde ein Mensch brauchen, um so viel Geld zu zählen? Genau weiß das niemand, aber wir reden hier von Zehntausenden Jahren.

Davon ausgehend können wir aber recht gut abschätzen, wie lange ein Computer brauchen würde, um bis zu einer trillion zu zählen. Einfach iterieren, ohne weitere Aktion dazwischen. Dafür habe ich ein kleines Stück Code geschrieben, das misst, wie lange das Hochzählen bis zu einer billion dauert, und dann mit ein wenig Mathematik abschätzt, wie lange das Zählen bis zu unterschiedlichen Werten dauern würde, und die Ergebnisse freundlich darstellt.

Die Ergebnisse sind interessant. Und die Antwort ist: es kommt auf Ihre Maschine an. Selbst auf derselben Maschine bekommen Sie je nach Last unterschiedliche Werte. Aber schauen wir uns meine kurz an:

**Aktualisierte Ergebnisse vom Oktober 2023** -- diesmal auf einem wassergekühlten i9-11900k.

```plaintext
9 minutes, 38 seconds         for 1 trillion (12 zeros)
6 days, 16 hours              for 1 quadrillion (15 zeros)
18 years, 130 days            for 1 quintillion (18 zeros)
18356 years, 60 days          for 1 sextillion (21 zeros)
```

Es ist ziemlich interessant, diese Ergebnisse mit denen von vor 10 Jahren zu vergleichen, als ich diesen Beitrag ursprünglich verfasst habe. Die Zeit ist von mehreren Stunden auf unter 10 Minuten gefallen. Natürlich vergleichen wir hier ein Stück weit Äpfel mit Birnen, da der ursprüngliche Benchmark auf einer Budget-Notebook-CPU lief, während die aktualisierten Zahlen von einer entsperrten Desktop-CPU mit Wasserkühlung stammen. Aber dennoch ist es spannend zu sehen, wie sich das im Lauf der Zeit entwickelt.

> Die Original-Ergebnisse von 2013, ausgeführt auf einem Notebook, lauten:
> 
> -   one billion (9 zeros) wird schnell erreicht -- 15 Sekunden
> -   aber bis zu one trillion (12 zeros) -- der Unterschied ist erstaunlich -- 4 Stunden und 10 Minuten. Im Grunde 1000 Mal so lange.
> -   die Unterschiede werden bei quadrillions (15 zeros) noch beeindruckender: 173 Tage; und bei quintillions (18 zeros): 475 Jahre
> -   das letzte, für das ich gerechnet habe, ist one sextillion (21 zeros), und halten Sie sich fest: mein Notebook würde exakt 475473 Jahre, 292 Tage, 6 Stunden, 43 Minuten und 52 Sekunden brauchen, um bis zu diesem Wert zu iterieren.

Wie gesagt -- diese Werte hängen stark von der Maschine ab. Probieren Sie es also selbst aus und teilen Sie gegebenenfalls die Ergebnisse. Code unten:

```cs
using System.Diagnostics;

var sw = new Stopwatch();
sw.Start();

// 10 billion iterations (10 zeros)
for (long i = 1; i <= 10000000000; i++) ;

sw.Stop();

Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100)} for 1 trillion (12 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000)} for 1 quadrillion (15 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000)} for 1 quintillion (18 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000000)} for 1 sextillion (21 zeros)");

Console.ReadKey();

string FormatString(long elapsed, long multiplier)
{
    var span = new TimeSpan(elapsed * multiplier).Duration();

    return string.Format("{0}{1}{2}{3}{4}",
        span.Days > 364 ? $"{span.Days / 365} years, " : "",
        span.Days > 0        ? $"{span.Days % 365} days, "  : "",
        span.Hours > 0       ? $"{span.Hours} hours, "      : "",
        span.Minutes > 0     ? $"{span.Minutes} minutes, "  : "",
        span.Seconds > 0     ? $"{span.Seconds} seconds"    : "");
}
```

## Wie wäre es mit dem Iterieren aller GUIDs?

Dann bin ich -- ganz im Stil eines Ingenieurs -- auf ein anderes Thema gekommen, das (für mich) völlig dazugehört: die Eindeutigkeit von GUIDs. Ich hatte mich schon zuvor gefragt, wie eindeutig ein GUID tatsächlich ist. Ich hatte damals eine Art Antwort, aber jetzt finde ich sie noch klarer.

Zunächst werden GUIDs in der Regel als 32 hexadezimale Stellen dargestellt -- wir können also die größte 32-stellige Hex-Zahl (`ffffffffffffffffffffffffffffffff`) nehmen und in Dezimal umrechnen und erhalten: 340.282.366.920.938.463.463.374.607.431.768.211.455 -- das sind 39 Stellen, in gerundetem Klartext: 340 undecillions.

Wenn meine Mathematik stimmt, nehmen wir die Zeit für sextillion (18365 Jahre) -- multiplizieren mit 1.000.000.000.000.000 (die zusätzlichen 15 Stellen zwischen undecillion und sextillion), dann mit 340 -- da wir von 340 undecillions sprechen.

Das ergibt etwa 6.244.100.000.000.000.000.000 Jahre -- also 6.244.100.000.000 Millionen Jahrtausende. So lange würde mein Computer brauchen, um alle möglichen GUID-Werte durchzuiterieren. Wie eindeutig ist das jetzt?
