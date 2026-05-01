---
title: "Was ist der Unterschied zwischen einem MegaByte (MB) und einem MebiByte (MiB)?"
description: "Lernen Sie den Unterschied zwischen Megabytes (MB) und Mebibytes (MiB), warum 1 MB gleich 1000 KB ist (nicht 1024) und wie verschiedene Betriebssysteme mit diesen Einheiten umgehen."
pubDate: 2020-08-07
updatedDate: 2023-10-28
tags:
  - "technology"
lang: "de"
translationOf: "2020/08/mib-vs-mb"
translatedBy: "claude"
translationDate: 2026-05-01
---
Wenn Ihnen beigebracht wurde, dass 1 MB = 1024 KB sind, dann wurde es Ihnen falsch beigebracht. 1 MB entspricht tatsächlich 1000 KB, während 1 MiB = 1024 KiB sind. Das Präfix "mebi" in MebiByte (MiB) steht für _mega_ und _binär_ und weist darauf hin, dass es eine Zweierpotenz ist; daher Werte wie 32, 64, 128, 256, 512, 1024, 2048 und so weiter.

Das Megabyte (MB) hingegen ist immer eine Zehnerpotenz: 1 KB = 1000 Bytes, 1 MB = 1000 KB und 1 GB = 1000 MB.

## Unterschiede zwischen Betriebssystemen

Fast jedes Betriebssystem geht anders mit diesen Einheiten um, und unter ihnen ist Windows das ungewöhnlichste. Es rechnet alles in Mebibytes und hängt am Ende ein KB/MB/GB an, sagt also im Grunde, es sei ein Megabyte. Eine 1024-Byte-Datei wird so als 1.00 KB angezeigt, obwohl es in Wirklichkeit 1.00 KiB bzw. 1.024 KB sind.

Sie können das selbst testen, indem Sie eine TXT-Datei mit 1000 Zeichen erstellen (1 Zeichen = 1 Byte) und sich die Dateieigenschaften ansehen.

![MegaByte vs. MebiByte - Windows zeigt 1024 Bytes als 1 KB statt als 1 KiB oder 1.024 KB](/wp-content/uploads/2020/08/image-2.png)

Windows zeigt 1024 Bytes als 1 KB statt als 1 KiB oder 1.024 KB

Diese Art der Darstellung führt zu allerlei Verwirrung; Nutzer fühlen sich oft betrogen, wenn sie eine 256-GB-Festplatte kaufen und Windows ihnen 238 GB anzeigt (dabei sind eigentlich 238 GiB gemeint, was 256 GB entspricht).

Andere Betriebssysteme, die diese Definition mit Zehnerpotenzen verwenden, sind macOS, iOS, Ubuntu und Debian. Diese Art, Speicher zu messen, ist auch konsistent mit den anderen Verwendungen der SI-Präfixe in der Informatik, etwa CPU-Taktfrequenzen oder Performance-Maßen.

Hinweis: macOS hat Speicher vor Mac OS X 10.6 Snow Leopard in Einheiten von Zweierpotenzen gemessen, dann hat Apple auf Einheiten basierend auf Zehnerpotenzen umgestellt. Dasselbe gilt ab iOS 11.

## Mit widersprüchlichen Definitionen umgehen

Das Mebibyte wurde entworfen, um das Megabyte zu ersetzen, weil es mit der Definition des Präfixes "mega" im Internationalen Einheitensystem (SI) kollidierte. Trotz seiner Festlegung durch die International Electrotechnical Commission (IEC) im Jahr 1998 und der Akzeptanz durch alle großen Normungsorganisationen ist es in Industrie und Medien bisher nicht weit verbreitet.

Die IEC-Präfixe sind Teil des Internationalen Größensystems, und die IEC hat zudem festgelegt, dass das Kilobyte ausschließlich für 1000 Bytes verwendet werden soll. Das ist die aktuelle moderne Standarddefinition für das Kilobyte.

## Vergleich von dezimalen und binären Einheiten

Zum Schluss überlasse ich Ihnen eine Tabelle mit allen verschiedenen Bezeichnungen der Einheiten, die Vielfache von Bytes sind. Bemerkenswert ist: Die Präfixe ronna- und quetta- wurden erst kürzlich -- 2022 -- vom International Bureau of Weights and Measures (BIPM) angenommen, allerdings nur für die Einheiten zur Basis 10. Die binären Gegenstücke wurden in einem Konsultationspapier vorgeschlagen, sind aber bislang weder von IEC noch von ISO übernommen worden.

| Dezimaler Wert | Metrisch | Binärer Wert | IEC | Speicher |
| --- | --- | --- | --- | --- |
| 1 | B byte | 1 | B byte | B byte |
| 1000 | kB kilobyte | 1024 | KiB kibibyte | kB kilobyte |
| 1000^2 | MB megabyte | 1024^2 | MiB mebibyte | MB megabyte |
| 1000^3 | GB gigabyte | 1024^3 | GiB gibibyte | GB gigabyte |
| 1000^4 | TB terabyte | 1024^4 | TiB tebibyte | TB terabyte |
| 1000^5 | PB petabyte | 1024^5 | PiB pebibyte | |
| 1000^6 | EB exabyte | 1024^6 | EiB exbibyte | |
| 1000^7 | ZB zettabyte | 1024^7 | ZiB zebibyte | |
| 1000^8 | YB yottabyte | 1024^8 | YiB yobibyte | |
| 1000^9 | RB ronnabyte | | | |
| 1000^10 | QB quettabyte | | | |

*Vielfache von Bytes in dezimaler und binärer Form*
