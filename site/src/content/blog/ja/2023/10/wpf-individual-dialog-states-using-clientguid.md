---
title: "WPF ClientGuid を使ってダイアログごとの状態を保持する"
description: ".NET 8 の ClientGuid プロパティを使って、WPF のファイルダイアログごとに、ウィンドウサイズや位置、最後に使ったフォルダーといった状態を個別に保持する方法を解説します。"
pubDate: 2023-10-13
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ja"
translationOf: "2023/10/wpf-individual-dialog-states-using-clientguid"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 で導入された新しい `ClientGuid` プロパティを使うと、`OpenFileDialog` や `OpenFolderDialog` のようなダイアログを一意に識別できるようになり、ウィンドウサイズや位置、最後に使ったフォルダーといった状態を、ダイアログごとに別々に保存できます。

この挙動を活用するには、`ShowDialog()` メソッドを呼び出す前に、ダイアログの `ClientGuid` を既知の識別子に設定します。

```cs
static readonly Guid _id = new Guid("32bc5a4c-e28f-408a-8aca-e0b430fbc17c");

var dialog = new OpenFileDialog 
{
    ClientGuid = _id
};

dialog.ShowDialog();
```

ダイアログの状態は、アプリケーションの起動をまたいで保持され、別のアプリケーション間でも保たれます。重要なのは `ClientGuid` が同じであることだけです。

**注:** 異なるアプリケーションインスタンス間でも、必ず同じ識別子を使ってください。実行時に `Guid.NewGuid()` で生成しないでください。実行のたびに新しい `Guid` が生まれてしまい、ダイアログの状態がリセットされてしまいます。代わりに、上の例のように `Guid` を保持しておくか、ダイアログ識別子だけを保持するための `KnownDialogs` クラスを作るとよいでしょう。
