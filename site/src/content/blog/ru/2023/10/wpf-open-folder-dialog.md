---
title: "WPF Open / Select Folder Dialog (OpenFolderDialog в .NET 8)"
description: "Используйте новый `OpenFolderDialog` из .NET 8 в WPF, чтобы пользователи могли открывать и выбирать одну или несколько папок. Заменяет старый костыль с FolderBrowserDialog из WinForms."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ru"
translationOf: "2023/10/wpf-open-folder-dialog"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 добавляет в Windows Presentation Foundation (WPF) новый `OpenFolderDialog`. Это позволяет пользователям приложения просматривать и выбирать одну или несколько папок.

Использовать его просто: создайте новый `OpenFolderDialog`, задайте `Title` и `InitialDirectory`. Если нужно разрешить выбор нескольких папок, выставьте `Multiselect` в `true`. После этого обычный вызов `ShowDialog()` покажет ваш диалог.

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

Как и в любом диалоге, если пользователь нажмёт кнопку **Select Folder**, `ShowDialog()` вернёт `true`; в противном случае — `false`.

Диалог открытия папки использует для навигации и выбора папок Проводник Windows, как и `OpenFileDialog`. Поэтому в зависимости от ОС диалог будет выглядеть по-разному. В Windows 11 он будет выглядеть примерно так:

[![WPF open folder dialog on Windows 11.](/wp-content/uploads/2023/10/image-1.png)](/wp-content/uploads/2023/10/image-1.png)

Для получения результата у вас есть несколько свойств. При одиночном выборе:

```cs
dialog.FolderName -> "C:\Users\test\OneDrive\Documents\Fiddler2"
dialog.SafeFolderName -> "Fiddler2"
```

При множественном выборе можно использовать:

```cs
dialog.FolderNames -> [ "C:\Users\test\OneDrive\Documents\Fiddler2", "C:\Users\mariu\OneDrive\Documents\Graphics" ]
dialog.SafeFolderNames -> [ "Fiddler2", "Graphics" ]
```
