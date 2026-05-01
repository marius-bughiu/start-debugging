---
title: "WPF Open / Select Folder Dialog (OpenFolderDialog in .NET 8)"
description: "Lassen Sie Anwender mit dem neuen `OpenFolderDialog` aus .NET 8 in WPF Ordner durchsuchen und einzeln oder mehrfach auswählen. Ersetzt den alten Umweg über den FolderBrowserDialog aus WinForms."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "de"
translationOf: "2023/10/wpf-open-folder-dialog"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 bringt einen neuen `OpenFolderDialog` in Windows Presentation Foundation (WPF). Damit können Anwender einer Anwendung Ordner durchsuchen und einen oder mehrere auswählen.

Die Verwendung ist einfach: Erzeugen Sie einen neuen `OpenFolderDialog`, setzen Sie `Title` und `InitialDirectory`. Falls Sie Mehrfachauswahl erlauben möchten, setzen Sie `Multiselect` auf `true`. Anschließend zeigt ein einfaches `ShowDialog()` den Dialog an.

```cs
var dialog = new OpenFolderDialog()
{
    Title = "Foo",
    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Personal),
    Multiselect = true
};

string folderName = "";
if (dialog.ShowDialog() == true)
{
    folderName = dialog.FolderName;
}
```

Wie bei jedem Dialog gibt `ShowDialog()` `true` zurück, wenn der Nutzer auf **Select Folder** klickt; andernfalls liefert er `false`.

Der Open-Folder-Dialog nutzt für das Browsen und Auswählen der Ordner den Windows Explorer, genau wie der `OpenFileDialog`. Deshalb sieht der Dialog je nach Betriebssystem unterschiedlich aus. Unter Windows 11 sieht er etwa so aus:

[![WPF open folder dialog on Windows 11.](/wp-content/uploads/2023/10/image-1.png)](/wp-content/uploads/2023/10/image-1.png)

Für die Ausgabe stehen Ihnen mehrere Eigenschaften zur Verfügung, um die vom Nutzer gewählten Ordner zu erhalten. Bei Einzelauswahl:

```cs
dialog.FolderName -> "C:\Users\test\OneDrive\Documents\Fiddler2"
dialog.SafeFolderName -> "Fiddler2"
```

Bei Mehrfachauswahl können Sie nutzen:

```cs
dialog.FolderNames -> [ "C:\Users\test\OneDrive\Documents\Fiddler2", "C:\Users\mariu\OneDrive\Documents\Graphics" ]
dialog.SafeFolderNames -> [ "Fiddler2", "Graphics" ]
```
