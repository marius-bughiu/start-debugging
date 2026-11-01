---
title: "Megabyte einfach in Kilobyte umrechnen"
description: "Megabyte in Kilobyte umrechnen: mit 1.000 multiplizieren. Beispiele zeigen den Unterschied zur binären Umrechnung von MiB in KiB mit dem Faktor 1.024."
pubDate: 2023-11-13
updatedDate: 2026-11-01
tags:
  - "informational"
lang: "de"
translationOf: "2023/11/converting-megabytes-to-kilobytes-made-simple"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um Megabyte in Kilobyte umzurechnen, multiplizieren Sie mit **1.000**: **1 MB = 1.000 kB**. Für die binären Einheiten Mebibyte und Kibibyte gilt dagegen **1 MiB = 1.024 KiB**. Welche Formel Sie benötigen, hängt von den Einheiten ab.

## Megabyte, Kilobyte und binäre Einheiten

Die dezimalen Präfixe Kilo und Mega stehen für Zehnerpotenzen. Die binären Präfixe Kibi und Mebi stehen für Zweierpotenzen. Die [NIST-Referenz zu binären Präfixen](https://physics.nist.gov/cuu/Units/binary.html) erklärt die IEC-Bezeichnungen und vergleicht sie mit den SI-Präfixen.

| Einheit | Symbol | Bytes |
| --- | --- | ---: |
| Kilobyte | kB | 1.000 |
| Megabyte | MB | 1.000.000 |
| Kibibyte | KiB | 1.024 |
| Mebibyte | MiB | 1.048.576 |

In Softwareoberflächen ist „KB“ verbreitet; hier verwenden wir **kB** als dezimales Symbol. Manche Programme beschriften binäre Werte mit KB oder MB. Prüfen Sie deshalb vor der Umrechnung, wie das jeweilige Programm seine Einheiten definiert. Unser Artikel zum [Unterschied zwischen MB und MiB](/de/2020/08/mib-vs-mb/) erklärt diese Verwechslung genauer.

## Die Formel: MB in kB

**Kilobyte = Megabyte × 1.000**

Beispiele:

- 5 MB × 1.000 = **5.000 kB**
- 10 MB × 1.000 = **10.000 kB**
- 0,5 MB × 1.000 = **500 kB**

Für die umgekehrte Umrechnung teilen Sie durch 1.000. Eine Datei mit 2.500 kB hat eine Größe von 2,5 MB.

## Wann Sie mit 1.024 multiplizieren

Verwenden Sie den Faktor 1.024 bei der Umrechnung zwischen den binären Einheiten **MiB und KiB**:

**Kibibyte = Mebibyte × 1.024**

Zum Beispiel entsprechen 5 MiB genau 5.120 KiB. Das ist eine andere Datenmenge als 5 MB. Nur die Einheitenbezeichnung zu ändern, ohne den Wert umzurechnen, ergibt daher ein falsches Ergebnis.

## Zwischen dezimalen und binären Einheiten umrechnen

Beim Wechsel zwischen den beiden Systemen rechnen Sie zunächst in Bytes um:

1. Multiplizieren Sie den Ausgangswert mit der Anzahl der Bytes pro Ausgangseinheit.
2. Teilen Sie das Ergebnis durch die Anzahl der Bytes pro Zieleinheit.

Ein MB entspricht beispielsweise 1.000.000 Bytes. Geteilt durch 1.024 ergibt das **976,5625 KiB**. Umgekehrt entspricht ein MiB 1.048.576 Bytes oder **1.048,576 kB**.

Deshalb kann dieselbe Datei in zwei Programmen unterschiedliche Zahlenwerte für ihre Größe haben, ohne dass Bytes verloren gehen.

## Die passende Umrechnung in der Praxis

Bevor Sie einen Rechner verwenden oder eine Datei mit einem Upload-Limit vergleichen, klären Sie die Einheiten auf beiden Seiten. Ist das Limit in Bytes angegeben, vergleichen Sie die Bytezahlen direkt. Steht in der Dokumentation nur „MB“, prüfen Sie, ob dezimale Einheiten oder eine binäre Konvention gemeint sind.

Geben Sie die Einheiten auch in Tabellenspalten, Berichten und API-Dokumentationen an. Ein Wert wie „5.120“ ist allein mehrdeutig; „5.120 KiB“ macht die gemeinte Datenmenge eindeutig.

Unterscheiden Sie außerdem Bytes und Bits: **1 Byte = 8 Bit**. Eine Übertragungsrate in Megabit pro Sekunde ist keine Dateigröße in Megabyte.

_Korrigiert am 1. November 2026: Eine frühere Fassung verwendete fälschlicherweise den Faktor 1.024 für die Umrechnung von MB in Kilobyte. Dieser Faktor gilt für MiB in KiB; bei der dezimalen Umrechnung von MB in kB gilt der Faktor 1.000._
