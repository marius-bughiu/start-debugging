---
title: "WPF Evitar que la selección del cuadro de diálogo se añada a recientes"
description: "Evita que las selecciones del cuadro de diálogo de archivos en WPF aparezcan en los recientes del Explorador de Windows y en el menú Inicio estableciendo AddToRecent en false en .NET 8."
pubDate: 2023-10-18
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "es"
translationOf: "2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los archivos abiertos o guardados a través de los cuadros de diálogo de archivos de WPF (`OpenFileDialog`, `SaveFileDialog` u `OpenFolderDialog`) se añaden por defecto a la lista de archivos recientes del Explorador de Windows y también pueden afectar a la sección Recomendado del menú Inicio en Windows 11.

Para desactivar este comportamiento, puedes establecer `AddToRecent` en `false` en tu cuadro de diálogo antes de llamar al método `ShowDialog()`. Nota: esta propiedad se añadió como parte de .NET 8, así que si no la tienes disponible, asegúrate de que tu proyecto apunta a .NET 8 o más reciente.

Y un ejemplo rápido:

```cs
var dialog = new OpenFileDialog 
{
    AddToRecent = false
};
 
dialog.ShowDialog();
```

Eso es todo. Ahora los archivos que el usuario seleccione usando `OpenFileDialog` ya no aparecerán en la lista de archivos recientes ni en el menú Inicio.

Nota: `AddToRecent` tiene `true` como valor por defecto. Así que, a menos que lo establezcas explícitamente en `false`, los archivos seleccionados con los cuadros de diálogo aparecerán en los recientes.
