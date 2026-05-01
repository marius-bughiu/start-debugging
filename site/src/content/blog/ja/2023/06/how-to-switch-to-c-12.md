---
title: "C# 12 への切り替え方法"
description: "ターゲットフレームワークを .NET 8 に更新するか、.csproj ファイルで LangVersion を設定して、C# 12 の言語バージョンエラーを解決します。"
pubDate: 2023-06-10
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/06/how-to-switch-to-c-12"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 12 の機能を試していると、次のようなエラーに遭遇することがあります。

> Feature is not available in C# 11.0. Please use language version 12.0 or later.

または

> Error CS8652: The feature '<feature name>' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

このエラーを解消する方法は 2 つあります。

-   プロジェクトのターゲットフレームワークを .NET 8 以降に変更します。言語バージョンは自動的に更新されるはずです。
-   **.csproj** ファイルを編集し、以下の例のように希望する **<LangVersion>** を指定します。

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## 言語バージョンがグレーアウトされて変更できない

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

言語バージョンは、プロジェクトの **プロパティ** ウィンドウからは変更できません。バージョンはプロジェクトのターゲット .NET framework バージョンに連動しており、それに応じて更新されます。

言語バージョンを上書きする必要がある場合は、上記のように **.csproj** ファイルを変更し、**LangVersion** を指定して行います。

各 C# 言語バージョンには、サポートされる最小の .NET バージョンがあることに注意してください。C# 12 は .NET 8 以降でのみサポートされます。C# 11 は .NET 7 以降でのみサポートされます。C# 10 は .NET 6 以降でのみサポートされます。以降も同様です。

## C# LangVersion のオプション

バージョン番号のほかに、プロジェクトの言語バージョンを指定するために使えるキーワードがいくつかあります。

-   **preview** -- 最新のプレビューバージョンを指します
-   **latest** -- リリースされた最新バージョン (マイナーバージョンを含む)
-   **latestMajor** または **default** -- リリースされた最新のメジャーバージョン
