---
title: ".NET Core で Embedded Resource の Stream を取得する"
description: "リソース名の構成を理解し、GetManifestResourceStream を使って .NET Core で埋め込みリソースのストリームを取得する方法を学びます。"
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2020/11/get-embedded-resource-stream-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Core で埋め込みリソースを取得するには、まずリソース名がどのように構成されているかを理解する必要があります。すべてピリオド (`.`) で連結された 3 つの要素から成ります。

-   ルート名前空間
-   拡張 (フォルダー) 名前空間
-   ファイル名

具体的な例を見てみましょう。ルート名前空間が `MyApp.Core` のプロジェクト (アセンブリ) があるとします。プロジェクト内には `Assets` > `Images` のようなフォルダーとサブフォルダーがあり、その中に `logo.png` という埋め込みリソースがあります。この場合は次のようになります。

-   ルート名前空間: `MyApp.Core`
-   拡張名前空間: `Assets.Images`
-   ファイル名: `logo.png`

これらを `.` で連結すると `MyApp.Core.Assets.Images.logo.png` になります。

リソースの識別子がわかれば、あとは実際のリソースを含むアセンブリへの参照があれば十分です。これはそのアセンブリ内に定義された任意のクラスから簡単に取得できます。`MyClass` というクラスがあると仮定します。

```cs
typeof(MyClass).Assembly.GetManifestResourceStream("MyApp.Core.Assets.Images.logo.png")
```

## アセンブリ内のすべての埋め込みリソースの一覧を取得する

リソースが見つからない場合、原因はたいてい次のいずれかです。

-   識別子が間違っている
-   ファイルを Embedded Resource としてマークしていない
-   別のアセンブリを見ている

調査の助けとして、アセンブリ内のすべての埋め込みリソースを一覧表示し、そこから進めることができます。次のようにします。

```cs
typeof(MyClass).Assembly.GetManifestResourceNames()
```

これは単純な `string[]` を返すので、`Immediate Window` でデバッグ目的に手軽に使えます。
