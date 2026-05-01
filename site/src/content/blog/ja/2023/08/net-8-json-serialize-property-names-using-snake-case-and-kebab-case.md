---
title: ".NET 8 JsonNamingPolicy: SnakeCaseLower と KebabCaseLower (System.Text.Json)"
description: ".NET 8 で追加された `JsonNamingPolicy.SnakeCaseLower` (および SnakeCaseUpper、KebabCaseLower、KebabCaseUpper) を使い、System.Text.Json で snake_case / kebab-case の JSON をカスタムコンバーターなしでシリアライズする方法を解説します。"
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 では、`System.Text.Json` シリアライザーで使える新しい命名ポリシーがいくつか追加されました。一覧はこちらです。

-   SnakeCaseLower
-   SnakeCaseUpper
-   KebabCaseLower
-   KebabCaseUpper

それぞれシリアライズ結果を見ていきましょう。次のような `Car` クラスを使います。

```cs
class Car
{
    public string Make { get; set; }
    public string ModelID { get; set; }
    public int LaunchYear { get; set; }
}
```

そして、次のオブジェクトをシリアライズします。

```cs
var car = new Car
{
    Make = "Mazda",
    ModelID = "MX-5",
    LaunchYear = 1989
};
```

## 小文字の snake\_case

snake\_case の小文字でシリアライズするには、シリアライザーの `JsonSerializerOptions` の中の `PropertyNamingPolicy` に `JsonNamingPolicy.SnakeCaseLower` を指定します。次のとおりです。

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
JsonSerializer.Serialize(car, options);
```

出力はこうなります。

```json
{"make":"Mazda","model_id":"MX-5","launch_year":1989}
```

## 大文字の SNAKE\_CASE

上と同じ要領で、プロパティ命名ポリシーに `JsonNamingPolicy.SnakeCaseUpper` を使います。出力はこうなります。

```json
{"MAKE":"Mazda","MODEL_ID":"MX-5","LAUNCH_YEAR":1989}
```

## 小文字の kebab-case

kebab-case の小文字でシリアライズするには、シリアライザーの `JsonSerializerOptions` の `PropertyNamingPolicy` に `JsonNamingPolicy.KebabCaseLower` を指定します。次のとおりです。

```cs
var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.KebabCaseLower };
JsonSerializer.Serialize(car, options);
```

これで次のような JSON が出力されます。

```json
{"make":"Mazda","model-id":"MX-5","launch-year":1989}
```

## 大文字の KEBAB-CASE

直前の例と同じく、プロパティ命名ポリシーに `JsonNamingPolicy.KebabCaseUpper` を使います。次のような出力が得られます。

```json
{"MAKE":"Mazda","MODEL-ID":"MX-5","LAUNCH-YEAR":1989}
```
