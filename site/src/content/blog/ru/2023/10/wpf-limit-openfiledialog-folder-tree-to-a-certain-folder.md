---
title: "WPF Ограничиваем дерево папок OpenFileDialog одной папкой"
description: "Узнайте, как ограничить дерево папок WPF-диалога OpenFileDialog заданной корневой папкой с помощью свойства RootDirectory в .NET 8."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ru"
translationOf: "2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8, дерево папок в `OpenFileDialog` и `OpenFolderDialog` можно ограничить заданной корневой папкой. Для этого выставьте свойство `RootDirectory` у диалога до вызова `ShowDialog()`.

Очень важно помнить: это никак не ограничивает выбор и навигацию через адресную строку. Пользователь по-прежнему может перейти в папки за пределами указанного `RootDirectory`. То же самое относится и к свойству `InitialDirectory`, которое можно выставить на любую папку, в том числе вне `RootDirectory`.

Рассмотрим пример:

```cs
var dialog = new OpenFileDialog
{
    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    RootDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
};

dialog.ShowDialog();
```

Это покажет диалог открытия файла, сфокусированный на папке `MyDocuments`, а дерево папок слева будет ограничено указанным корневым каталогом — в данном случае `MyPictures`.

[![OpenFileDialog with a constrained folder tree using RootDirectory.](/wp-content/uploads/2023/10/image.png)](/wp-content/uploads/2023/10/image.png)
