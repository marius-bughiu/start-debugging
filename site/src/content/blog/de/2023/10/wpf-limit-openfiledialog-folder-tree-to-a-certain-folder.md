---
title: "WPF OpenFileDialog-Ordnerbaum auf einen bestimmten Ordner begrenzen"
description: "Erfahren Sie, wie Sie den Ordnerbaum des WPF-OpenFileDialogs in .NET 8 mit der RootDirectory-Eigenschaft auf einen bestimmten Wurzelordner einschränken."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "de"
translationOf: "2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 lässt sich der Ordnerbaum des `OpenFileDialog` und des `OpenFolderDialog` auf einen bestimmten Wurzelordner einschränken. Setzen Sie dazu die Eigenschaft `RootDirectory` am Dialog, bevor Sie `ShowDialog()` aufrufen.

Wichtig zu wissen: Das schränkt die Auswahl und die Navigation über die Adressleiste in keiner Weise ein. Nutzer können weiterhin in Ordner außerhalb des angegebenen `RootDirectory` navigieren. Gleiches gilt für die Eigenschaft `InitialDirectory`, die Sie auf einen beliebigen Ordner außerhalb von `RootDirectory` setzen können.

Sehen wir uns ein Beispiel an:

```cs
var dialog = new OpenFileDialog
{
    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    RootDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
};

dialog.ShowDialog();
```

Damit öffnet sich ein Dialog mit Fokus auf den Ordner `MyDocuments`, während der Ordnerbaum auf der linken Seite auf das angegebene Wurzelverzeichnis beschränkt ist, in diesem Fall `MyPictures`.

[![OpenFileDialog with a constrained folder tree using RootDirectory.](/wp-content/uploads/2023/10/image.png)](/wp-content/uploads/2023/10/image.png)
