---
title: "WPF Open / Select Folder Dialog (OpenFolderDialog de .NET 8)"
description: "Usa el nuevo `OpenFolderDialog` de .NET 8 en WPF para que los usuarios puedan abrir y seleccionar una o varias carpetas. Sustituye al antiguo apaño con FolderBrowserDialog de WinForms."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "es"
translationOf: "2023/10/wpf-open-folder-dialog"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 incorpora un nuevo `OpenFolderDialog` a Windows Presentation Foundation (WPF). Esto permite a los usuarios de la aplicación examinar y seleccionar una o varias carpetas.

Su uso es sencillo: crea un nuevo `OpenFolderDialog`, proporciona un `Title` y un `InitialDirectory`. Y si quieres permitir a tus usuarios seleccionar varias carpetas, establece `Multiselect` a `true`. Luego, una simple llamada a `ShowDialog()` mostrará tu cuadro de diálogo.

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

Como con cualquier diálogo, si el usuario hace clic en el botón **Select Folder**, `ShowDialog()` devolverá `true`; de lo contrario, devolverá `false`.

El cuadro de diálogo de apertura de carpeta usa el Explorador de Windows para navegar y seleccionar las carpetas, igual que `OpenFileDialog`. Como resultado, el diálogo se verá diferente según tu sistema operativo. En Windows 11 tendrá un aspecto similar a este:

[![WPF open folder dialog on Windows 11.](/wp-content/uploads/2023/10/image-1.png)](/wp-content/uploads/2023/10/image-1.png)

En cuanto a la salida, tienes varias propiedades que puedes usar para obtener las carpetas seleccionadas por el usuario. Para una sola selección:

```cs
dialog.FolderName -> "C:\Users\test\OneDrive\Documents\Fiddler2"
dialog.SafeFolderName -> "Fiddler2"
```

En caso de selección múltiple, puedes usar:

```cs
dialog.FolderNames -> [ "C:\Users\test\OneDrive\Documents\Fiddler2", "C:\Users\mariu\OneDrive\Documents\Graphics" ]
dialog.SafeFolderNames -> [ "Fiddler2", "Graphics" ]
```
