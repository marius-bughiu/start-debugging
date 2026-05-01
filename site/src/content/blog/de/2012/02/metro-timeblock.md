---
title: "Metro TimeBlock"
description: "Metro TimeBlock ist ein anpassbares Zeitanzeigecontrol für Windows Phone, mit dem Sie Farbe, Hintergrund und Größe frei wählen können."
pubDate: 2012-02-08
updatedDate: 2023-11-05
tags:
  - "metro"
  - "windows-phone"
lang: "de"
translationOf: "2012/02/metro-timeblock"
translatedBy: "claude"
translationDate: 2026-05-01
---
Metro TimeBlock ist ein Zeitanzeigecontrol, das ich erstellt habe und mit dem Sie die Uhrzeit in jeder beliebigen Farbe und mit beliebigem Hintergrund anzeigen können. Auch die Größe ist einstellbar, und Sie können wählen, ob die aktuelle Uhrzeit oder eine eigene angezeigt werden soll.

[![Metro TimeBlock](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)

Eigenschaften des Controls:

**Time** -- nimmt ein beliebiges DateTime-Objekt entgegen. Das Control zeigt die Time aus diesem DateTime an. Lassen Sie es leer, um die aktuelle Zeit anzuzeigen.

**Spacer** -- der String, der zwischen Stunden und Minuten sowie zwischen Minuten und Sekunden angezeigt wird. Verwenden Sie Trenner wie ":" oder " ".

**Size** -- Sie können wählen zwischen **Small, Normal, Medium, MediumLarge, Large, ExtraLarge, ExtraExtraLarge** und **Huge**. Ich habe das so gestaltet statt FontSize zu erlauben, weil ich so auch das Aussehen der Hintergrundblöcke steuern kann.

**Foreground** -- gibt dem Control vor, welche Farbe für die Zeit verwendet werden soll.

**Fill** -- legt die Hintergrundfarbe des Controls (die quadratähnlichen Blöcke) fest.

Das war's. Wenn Sie Probleme haben oder Hilfe brauchen, hinterlassen Sie unten einen Kommentar. Den Code können Sie über [diesen Link](https://www.dropbox.com/s/mjiba8cugtj8fdz/StartDebugging.zip?dl=0) herunterladen; er enthält sowohl das Control als auch ein paar Beispiele.
