---
title: "WPF Limitar el árbol de carpetas del OpenFileDialog a una carpeta concreta"
description: "Aprende a limitar el árbol de carpetas del OpenFileDialog de WPF a una carpeta raíz concreta usando la propiedad RootDirectory en .NET 8."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "es"
translationOf: "2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8 puedes limitar el árbol de carpetas del `OpenFileDialog` y del `OpenFolderDialog` a una carpeta raíz concreta. Para hacerlo, establece la propiedad `RootDirectory` del diálogo antes de llamar a `ShowDialog()`.

Es muy importante señalar que esto no limita la selección ni la navegación por la barra de direcciones de ninguna forma. El usuario seguirá pudiendo navegar a carpetas fuera del `RootDirectory` especificado. Lo mismo aplica a la propiedad `InitialDirectory`, que puedes establecer en cualquier carpeta que quieras fuera del `RootDirectory`.

Veamos un ejemplo:

```cs
var dialog = new OpenFileDialog
{
    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    RootDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
};

dialog.ShowDialog();
```

Esto mostrará un cuadro de diálogo de apertura de archivo enfocado en la carpeta `MyDocuments`, mientras que su árbol de carpetas a la izquierda quedará limitado al directorio raíz indicado, en este caso `MyPictures`.

[![OpenFileDialog with a constrained folder tree using RootDirectory.](/wp-content/uploads/2023/10/image.png)](/wp-content/uploads/2023/10/image.png)
