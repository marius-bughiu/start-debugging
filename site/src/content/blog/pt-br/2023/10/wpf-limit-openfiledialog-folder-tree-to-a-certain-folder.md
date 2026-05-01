---
title: "WPF Limitar a árvore de pastas do OpenFileDialog a uma pasta específica"
description: "Aprenda a limitar a árvore de pastas do OpenFileDialog do WPF a uma pasta raiz específica usando a propriedade RootDirectory no .NET 8."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "pt-br"
translationOf: "2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, dá para limitar a árvore de pastas do `OpenFileDialog` e do `OpenFolderDialog` a uma pasta raiz específica. Basta definir a propriedade `RootDirectory` no dialog antes de chamar `ShowDialog()`.

Importante destacar: isso não limita a seleção nem a navegação pela barra de endereços. O usuário ainda consegue navegar para pastas fora do `RootDirectory` informado. O mesmo vale para a propriedade `InitialDirectory`, que você pode apontar para qualquer pasta, inclusive fora do `RootDirectory`.

Vamos a um exemplo:

```cs
var dialog = new OpenFileDialog
{
    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    RootDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
};

dialog.ShowDialog();
```

Isso abre um dialog de abrir arquivo focado na pasta `MyDocuments`, enquanto a árvore de pastas à esquerda fica limitada ao diretório raiz informado, no caso `MyPictures`.

[![OpenFileDialog with a constrained folder tree using RootDirectory.](/wp-content/uploads/2023/10/image.png)](/wp-content/uploads/2023/10/image.png)
