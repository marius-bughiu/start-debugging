---
title: "dotnet script のインストール方法"
description: "dotnet script を使うと、.NET CLI から C# スクリプト (.CSX) を実行できます。要件は .NET 6 以降がインストールされていることだけです。dotnet-script をグローバルにインストールするには、次のコマンドを使います。スクリプトファイルを実行するには、下の例のように dotnet script <file_path> を呼び出します。新しい..."
pubDate: 2023-08-29
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
  - "dotnet"
lang: "ja"
translationOf: "2023/08/how-to-install-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
`dotnet script` を使うと、.NET CLI から C# スクリプト (`.CSX`) を実行できます。要件は .NET 6 以降がマシンにインストールされていることだけです。

dotnet-script をグローバルにインストールするには、次のコマンドを使います。

```bash
dotnet tool install -g dotnet-script
```

スクリプトファイルを実行するには、下の例のように `dotnet script <file_path>` を呼び出します。

```bash
dotnet script startdebugging.csx
```

## 新しい dotnet script を初期化する方法

これから始める方で新しい dotnet script ファイルを作りたい場合は、`init` コマンドを使ってスクリプトプロジェクトの雛形を作れます。

```bash
dotnet script init startdebugging.csx
```

これにより、スクリプトファイルと、VS Code でスクリプトをデバッグするのに必要な launch 設定が作成されます。ファイル名は任意で、指定しなかった場合は `main.csx` がデフォルトになります。

```plaintext
. 
├── .vscode 
│   └── launch.json 
├── startdebugging.csx 
└── omnisharp.json
```

## 暗黙の using

dotnet script には、.NET SDK プロジェクトの implicit usings に似た形で、いくつかの名前空間がデフォルトで取り込まれています。dotnet-script で暗黙的に利用できる名前空間の一覧は次のとおりです。

```cs
System
System.IO
System.Collections.Generic
System.Console
System.Diagnostics
System.Dynamic
System.Linq
System.Linq.Expressions
System.Text
System.Threading.Tasks
```
