---
title: "WPF ファイルダイアログでの選択を最近使った項目に追加しない"
description: ".NET 8 で AddToRecent を false に設定して、WPF のファイルダイアログでの選択が Windows エクスプローラーの最近使った項目やスタートメニューに表示されるのを防ぐ方法を解説します。"
pubDate: 2023-10-18
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ja"
translationOf: "2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents"
translatedBy: "claude"
translationDate: 2026-05-01
---
WPF のファイルダイアログ (`OpenFileDialog`、`SaveFileDialog`、`OpenFolderDialog`) で開いたり保存したりしたファイルは、デフォルトで Windows エクスプローラーの最近使ったファイルの一覧に追加され、Windows 11 のスタートメニューの「おすすめ」セクションにも影響を与えることがあります。

この挙動を無効にするには、`ShowDialog()` メソッドを呼び出す前に、ダイアログの `AddToRecent` プロパティを `false` に設定します。なお、このプロパティは .NET 8 で追加されたものなので、利用できない場合は、プロジェクトのターゲットを .NET 8 以降にしてください。

ごく簡単な例です。

```cs
var dialog = new OpenFileDialog 
{
    AddToRecent = false
};
 
dialog.ShowDialog();
```

これで完了です。これ以降、ユーザーが `OpenFileDialog` を使って選択したファイルは、最近使ったファイルの一覧やスタートメニューに表示されなくなります。

注: `AddToRecent` のデフォルト値は `true` です。そのため、明示的に `false` に設定しない限り、ダイアログで選択されたファイルは引き続き最近使った項目に表示されます。
