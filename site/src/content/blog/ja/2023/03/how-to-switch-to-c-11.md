---
title: "C# 11 への切り替え方法"
description: "ターゲットフレームワークを変更するか、.csproj ファイルで LangVersion を設定して C# 11 に切り替え、'Feature is not available in C# 10.0' エラーを解消します。"
pubDate: 2023-03-14
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/03/how-to-switch-to-c-11"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Feature is not available in C# 10.0. Please use language version 11.0 or later.

これに対処する方法は 2 つあります。

-   プロジェクトのターゲットフレームワークを .NET 7 以降に変更します。言語バージョンは自動的に更新されるはずです。
-   **.csproj** ファイルを編集し、以下の例のように希望する **<LangVersion>** を指定します。

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net7.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>11.0</LangVersion>
  </PropertyGroup>
</Project>
```

## 言語バージョンがグレーアウトされて変更できない

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

言語バージョンは、プロジェクトの **プロパティ** ウィンドウからは変更できません。バージョンはプロジェクトのターゲット .NET framework バージョンに連動しており、それに応じて更新されます。

言語バージョンを上書きする必要がある場合は、上記のように **.csproj** ファイルを変更し、**LangVersion** を指定して行います。

各 C# 言語バージョンには、サポートされる最小の .NET バージョンがあることに注意してください。C# 11 は .NET 7 以降でのみサポートされます。C# 10 は .NET 6 以降でのみサポートされます。C# 9 は .NET 5 以降でのみサポートされます。

## C# LangVersion のオプション

バージョン番号のほかに、プロジェクトの言語バージョンを指定するために使えるキーワードがいくつかあります。

-   **preview** -- 最新のプレビューバージョンを指します
-   **latest** -- リリースされた最新バージョン (マイナーバージョンを含む)
-   **latestMajor** または **default** -- リリースされた最新のメジャーバージョン
