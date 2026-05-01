---
title: "Xamarin-Fehler beheben: Csc.exe exited with code -1073741790. (MSB6006)"
description: "Beheben Sie den Xamarin-Fehler MSB6006 von Csc.exe, indem Sie als Administrator ausführen oder die bin- und obj-Ordner der Solution bereinigen."
pubDate: 2015-08-28
updatedDate: 2023-11-05
tags:
  - "xamarin"
lang: "de"
translationOf: "2015/08/fix-xamarin-error-csc-exe-exited-with-code-1073741790-msb6006"
translatedBy: "claude"
translationDate: 2026-05-01
---
Führen Sie Xamarin Studio einfach als Administrator aus.

Der Fehler bedeutet üblicherweise, dass der Prozess auf eine bestimmte Ressource nicht zugreifen kann. In meinem Fall waren es fehlende Rechte; es kann aber auch bedeuten, dass eine Datei bereits in Verwendung ist. In diesem Fall: Solution säubern und neu bauen, und wenn auch das nicht hilft, säubern Sie manuell, indem Sie die Ordner "bin" und "obj" für jedes Projekt der Solution löschen.
