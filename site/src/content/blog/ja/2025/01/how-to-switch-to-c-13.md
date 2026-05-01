---
title: "C# 13 への切り替え方"
description: "'Feature is not available in C# 12.0' を修正し、ターゲットフレームワークを変更するか .csproj ファイルで LangVersion を設定して、プロジェクトを C# 13 に切り替える方法。"
pubDate: 2025-01-01
updatedDate: 2025-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2025/01/how-to-switch-to-c-13"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 13 の機能を試している間、次のようなエラーに遭遇する可能性があります:

> Feature is not available in C# 12.0. Please use language version 13.0 or later.

または

> Error CS8652: The feature ‘<feature name>’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

このエラーを解決する方法は2つあります:

-   プロジェクトのターゲットフレームワークを .NET 9 以上に変更してください。言語バージョンが自動的に更新されるはずです。
-   **.csproj** ファイルを編集し、以下の例のように希望する **<LangVersion>** を指定してください:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## 言語バージョンがグレー表示されて変更できない

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

言語バージョンはプロジェクトの **Properties** ウィンドウからは変更できません。バージョンはプロジェクトのターゲット .NET フレームワークのバージョンに連動しており、それに応じて更新されます。

言語バージョンを上書きする必要がある場合は、上記のように **.csproj** ファイルを編集し、**LangVersion** を指定する必要があります。

各 C# 言語バージョンには最低限サポートされる .NET バージョンがあることを覚えておいてください。C# 13 は .NET 9 以降のバージョンでのみサポートされています。C# 12 は .NET 8 以降のバージョンでのみサポートされています。

## C# LangVersion のオプション

バージョン番号に加えて、プロジェクトの言語バージョンを指定するために使用できる特定のキーワードがあります:

-   **preview** – 最新のプレビューバージョンを指します
-   **latest** – リリース済みの最新バージョン (マイナーバージョンを含む)
-   **latestMajor** または **default** – リリース済みの最新メジャーバージョン

## お探しのものと違いますか?

別のバージョンの C# に切り替えたい場合は、以下を参照してください:

-   [C# 12 への切り替え方](/2023/06/how-to-switch-to-c-12/)
-   [C# 11 への切り替え方](/2023/03/how-to-switch-to-c-11/)
