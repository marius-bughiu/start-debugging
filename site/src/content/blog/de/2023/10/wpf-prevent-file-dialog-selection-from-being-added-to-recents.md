---
title: "WPF Auswahl im Datei-Dialog von den Zuletzt-verwendet-Listen ausschließen"
description: "Verhindern Sie, dass Auswahlen aus WPF-Datei-Dialogen in den 'Zuletzt verwendet' im Windows Explorer und im Startmenü auftauchen, indem Sie in .NET 8 AddToRecent auf false setzen."
pubDate: 2023-10-18
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "de"
translationOf: "2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents"
translatedBy: "claude"
translationDate: 2026-05-01
---
Über die WPF-Datei-Dialoge (`OpenFileDialog`, `SaveFileDialog` oder `OpenFolderDialog`) geöffnete oder gespeicherte Dateien landen standardmäßig in der Liste der zuletzt verwendeten Dateien im Windows Explorer und können in Windows 11 auch im Bereich Empfohlen des Startmenüs auftauchen.

Um dieses Verhalten zu deaktivieren, setzen Sie an Ihrem Dialog vor dem Aufruf von `ShowDialog()` die Eigenschaft `AddToRecent` auf `false`. Hinweis: Diese Eigenschaft wurde mit .NET 8 hinzugefügt; sollten Sie sie nicht haben, stellen Sie sicher, dass Ihr Projekt mindestens .NET 8 anvisiert.

Und ein ganz schnelles Beispiel:

```cs
var dialog = new OpenFileDialog 
{
    AddToRecent = false
};
 
dialog.ShowDialog();
```

Das war's schon. Die vom Nutzer über den `OpenFileDialog` ausgewählten Dateien tauchen damit weder in der Liste der zuletzt verwendeten Dateien noch im Startmenü auf.

Hinweis: `AddToRecent` hat den Standardwert `true`. Solange Sie ihn also nicht ausdrücklich auf `false` setzen, erscheinen über die Dialoge ausgewählte Dateien weiterhin in den Zuletzt-verwendet-Listen.
