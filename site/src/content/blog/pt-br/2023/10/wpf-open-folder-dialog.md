---
title: "WPF Open / Select Folder Dialog (OpenFolderDialog do .NET 8)"
description: "Use o novo `OpenFolderDialog` do .NET 8 no WPF para deixar os usuários abrirem e selecionarem uma ou várias pastas. Substitui o antigo workaround com FolderBrowserDialog do WinForms."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "pt-br"
translationOf: "2023/10/wpf-open-folder-dialog"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 8 traz um novo `OpenFolderDialog` para o Windows Presentation Foundation (WPF). Com isso, os usuários da aplicação podem navegar e selecionar uma ou várias pastas.

O uso é simples: crie um novo `OpenFolderDialog`, informe um `Title` e um `InitialDirectory`. Se quiser permitir que seus usuários selecionem várias pastas, defina `Multiselect` como `true`. Em seguida, uma simples chamada a `ShowDialog()` exibe o dialog.

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

Como em qualquer dialog, se o usuário clicar no botão **Select Folder**, `ShowDialog()` retorna `true`; caso contrário, retorna `false`.

O dialog de abrir pasta usa o Windows Explorer para navegar e selecionar as pastas, assim como o `OpenFileDialog`. Por isso, o dialog tem uma aparência diferente dependendo do seu sistema operacional. No Windows 11, fica parecido com isto:

[![WPF open folder dialog on Windows 11.](/wp-content/uploads/2023/10/image-1.png)](/wp-content/uploads/2023/10/image-1.png)

Em termos de saída, você tem várias propriedades para obter as pastas selecionadas pelo usuário. Para seleção única:

```cs
dialog.FolderName -> "C:\Users\test\OneDrive\Documents\Fiddler2"
dialog.SafeFolderName -> "Fiddler2"
```

No caso de seleção múltipla, dá para usar:

```cs
dialog.FolderNames -> [ "C:\Users\test\OneDrive\Documents\Fiddler2", "C:\Users\mariu\OneDrive\Documents\Graphics" ]
dialog.SafeFolderNames -> [ "Fiddler2", "Graphics" ]
```
