---
title: "WPF estados individuales de diálogos usando ClientGuid"
description: "Usa la propiedad ClientGuid en .NET 8 para persistir estados individuales de los diálogos, como tamaño de ventana, posición y última carpeta usada, en los diálogos de archivos de WPF."
pubDate: 2023-10-13
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "es"
translationOf: "2023/10/wpf-individual-dialog-states-using-clientguid"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una nueva propiedad `ClientGuid`, introducida con .NET 8, te permite identificar de forma única diálogos como `OpenFileDialog` y `OpenFolderDialog`, con el objetivo de almacenar estado, como tamaño de la ventana, posición y última carpeta usada, por separado para cada diálogo.

Para beneficiarte de este comportamiento, configura el `ClientGuid` de tu diálogo con un identificador conocido antes de llamar al método `ShowDialog()`.

```cs
static readonly Guid _id = new Guid("32bc5a4c-e28f-408a-8aca-e0b430fbc17c");

var dialog = new OpenFileDialog 
{
    ClientGuid = _id
};

dialog.ShowDialog();
```

El estado del diálogo se persiste entre diferentes ejecuciones de la aplicación e incluso entre aplicaciones distintas. Lo único que importa es que el `ClientGuid` sea el mismo.

**Nota:** asegúrate de usar el mismo identificador entre distintas instancias de la aplicación. No generes el `Guid` en tiempo de ejecución usando `Guid.NewGuid()`, ya que eso producirá un `Guid` nuevo cada vez que ejecutes la aplicación y el estado del diálogo se reiniciará. En su lugar, almacena el `Guid` como en el ejemplo anterior, o crea una clase `KnownDialogs` específicamente para guardar los identificadores de los diálogos.
