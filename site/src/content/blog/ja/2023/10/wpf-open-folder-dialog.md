---
title: "WPF Open / Select Folder Dialog (.NET 8 の OpenFolderDialog)"
description: ".NET 8 で WPF に追加された新しい `OpenFolderDialog` を使って、ユーザーにフォルダーを 1 つまたは複数選択してもらう方法を解説します。WinForms の FolderBrowserDialog を流用していた従来の方法に取って代わるものです。"
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ja"
translationOf: "2023/10/wpf-open-folder-dialog"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 では、Windows Presentation Foundation (WPF) に新しい `OpenFolderDialog` が追加されます。これにより、アプリケーションのユーザーがフォルダーを参照し、1 つまたは複数を選択できるようになります。

使い方はシンプルです。新しい `OpenFolderDialog` を作成し、`Title` と `InitialDirectory` を指定します。複数フォルダーの選択を許可したい場合は、`Multiselect` を `true` にしてください。あとは `ShowDialog()` を呼び出せばダイアログが表示されます。

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

ほかのダイアログと同様、ユーザーが **Select Folder** ボタンをクリックした場合は `ShowDialog()` が `true` を返し、そうでなければ `false` を返します。

Open folder ダイアログは、`OpenFileDialog` と同様に、フォルダーの参照と選択に Windows Explorer を使います。そのため、OS によって見た目が異なります。Windows 11 では、次のような感じになります。

[![WPF open folder dialog on Windows 11.](/wp-content/uploads/2023/10/image-1.png)](/wp-content/uploads/2023/10/image-1.png)

出力としては、ユーザーが選択したフォルダーを取得するためのプロパティがいくつか用意されています。単一選択の場合はこちら。

```cs
dialog.FolderName -> "C:\Users\test\OneDrive\Documents\Fiddler2"
dialog.SafeFolderName -> "Fiddler2"
```

複数選択の場合は、こちらが使えます。

```cs
dialog.FolderNames -> [ "C:\Users\test\OneDrive\Documents\Fiddler2", "C:\Users\mariu\OneDrive\Documents\Graphics" ]
dialog.SafeFolderNames -> [ "Fiddler2", "Graphics" ]
```
