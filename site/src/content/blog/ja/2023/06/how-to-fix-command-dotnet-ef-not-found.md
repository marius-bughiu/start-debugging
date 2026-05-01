---
title: "対処方法: dotnet ef not found (dotnet-ef does not exist)"
description: "EF Core CLI をグローバルまたはローカルの .NET ツールとしてインストールして、'dotnet-ef does not exist' / 'dotnet ef command not found' エラーを解消します。"
pubDate: 2023-06-11
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "entity-framework"
lang: "ja"
translationOf: "2023/06/how-to-fix-command-dotnet-ef-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Could not execute because the specified command or file was not found.  
> Possible reasons for this include:  
> -- You misspelled a built-in dotnet command.  
> -- You intended to execute a .NET Core program, but dotnet-ef does not exist.  
> -- You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.

このエラーメッセージの最も可能性の高い原因は、**dotnet ef** ツールがインストールされていないことです。

ASP.NET Core 3 以降、**dotnet ef** コマンドツールは .NET Core SDK の一部ではなくなりました。この変更により、開発チームは dotnet ef を通常の .NET CLI ツールとして提供できるようになり、グローバルまたはローカルツールとしてインストールできます。これは、Windows 上の Visual Studio で作業している場合でも、Mac や Ubuntu Linux で `dotnet` を使用している場合でも、すべてのディストリビューションに当てはまります。

例えば、マイグレーションの管理や **DbContext** のスキャフォールドを行うには、次のコマンドで **dotnet ef** をグローバルツールとしてインストールします。

```shell
dotnet tool install --global dotnet-ef
```

特定のバージョンをインストールしたい場合は、**--version** パラメーターを指定できます。例えば次のとおりです。

```shell
dotnet tool install --global dotnet-ef --version 3.*
dotnet tool install --global dotnet-ef --version 5.*
dotnet tool install --global dotnet-ef --version 6.*
dotnet tool install --global dotnet-ef --version 7.*
dotnet tool install --global dotnet-ef --version 8.*
```

## dotnet-ef のアンインストール

ツールが不要になり `dotnet-ef` をアンインストールしたい場合は、`dotnet tool uninstall` コマンドで行えます。

```shell
dotnet tool uninstall dotnet-ef --global
```
