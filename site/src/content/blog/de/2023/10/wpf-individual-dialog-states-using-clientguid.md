---
title: "WPF Individuelle Dialogzustände mit ClientGuid"
description: "Verwenden Sie die ClientGuid-Eigenschaft in .NET 8, um individuelle Zustände wie Fenstergröße, Position und zuletzt verwendeten Ordner für jeden WPF-Datei-Dialog zu persistieren."
pubDate: 2023-10-13
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "de"
translationOf: "2023/10/wpf-individual-dialog-states-using-clientguid"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit .NET 8 wurde eine neue Eigenschaft `ClientGuid` eingeführt, mit der Sie Dialoge wie `OpenFileDialog` und `OpenFolderDialog` eindeutig identifizieren können, um Zustände wie Fenstergröße, Position oder zuletzt verwendeten Ordner getrennt pro Dialog zu speichern.

Um dieses Verhalten zu nutzen, setzen Sie das `ClientGuid` Ihres Dialogs vor dem Aufruf von `ShowDialog()` auf einen bekannten Bezeichner.

```cs
static readonly Guid _id = new Guid("32bc5a4c-e28f-408a-8aca-e0b430fbc17c");

var dialog = new OpenFileDialog 
{
    ClientGuid = _id
};

dialog.ShowDialog();
```

Der Dialogzustand bleibt über verschiedene Anwendungsläufe und sogar über verschiedene Apps hinweg erhalten. Wichtig ist nur, dass `ClientGuid` identisch ist.

**Hinweis:** Achten Sie darauf, denselben Bezeichner in unterschiedlichen Instanzen der Anwendung zu verwenden. Erzeugen Sie das `Guid` nicht zur Laufzeit mit `Guid.NewGuid()`, denn das ergibt bei jedem Programmstart ein neues `Guid` und der Dialogzustand wird zurückgesetzt. Speichern Sie das `Guid` stattdessen wie im obigen Beispiel oder legen Sie eine eigene Klasse `KnownDialogs` an, die ausschließlich Dialog-Bezeichner enthält.
