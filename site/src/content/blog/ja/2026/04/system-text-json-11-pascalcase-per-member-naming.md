---
title: ".NET 11 Preview 3 の System.Text.Json が PascalCase とメンバー単位のネーミングポリシーを追加"
description: ".NET 11 Preview 3 は System.Text.Json のネーミングポリシーの話を完成させます: JsonNamingPolicy.PascalCase、メンバーレベルの [JsonNamingPolicy] 属性、そしてクリーンな DTO のための型レベルの [JsonIgnore] デフォルト。"
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "system-text-json"
  - "csharp"
  - "serialization"
lang: "ja"
translationOf: "2026/04/system-text-json-11-pascalcase-per-member-naming"
translatedBy: "claude"
translationDate: 2026-04-24
---

[.NET 8 は](https://startdebugging.net/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/) `System.Text.Json` のための組み込みネーミングポリシーの最初のバッチ (camel、snake、kebab の両ケーシング) を導入しました。.NET 11 の Preview 3 は最後の明白なギャップを埋め、ほとんどの DTO 形状に対して手書きの `JsonConverter` を不要にする 2 つのノブをさらに追加します。作業は [dotnet/runtime #124644](https://github.com/dotnet/runtime/pull/124644)、[#124645](https://github.com/dotnet/runtime/pull/124645)、[#124646](https://github.com/dotnet/runtime/pull/124646) を通じて出荷されました。

## PascalCase が組み込みポリシーに加わる

`JsonNamingPolicy.PascalCase` は Preview 3 で新しく、既存の `CamelCase`、`SnakeCaseLower`、`SnakeCaseUpper`、`KebabCaseLower`、`KebabCaseUpper` の隣に座ります。.NET 側が既に PascalCase プロパティを使用し、JSON コントラクトも PascalCase であるときに欲しいポリシーで、Azure 管理 API、古い SOAP から REST へのゲートウェイ、一部の Microsoft Graph の形状でよくあります:

```csharp
using System.Text.Json;

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.PascalCase
};

var json = JsonSerializer.Serialize(
    new { firstName = "Ada", age = 37 },
    options);
// {"FirstName":"Ada","Age":37}
```

Preview 3 以前は、デフォルト (ポリシーなし) のままにするか、1 行のカスタム `JsonNamingPolicy` サブクラスを書くかのどちらかでした。今は他のプリセットと肩を並べ、既存の `JsonKnownNamingPolicy` enum とクリーンにラウンドトリップします。

## 単一メンバーでネーミングを上書きする

より興味深い変更は、`[JsonNamingPolicy]` がメンバーレベルの属性になったことです。以前はポリシーは `JsonSerializerOptions` 上に住みグラフ全体に適用されていたので、その他は camelCase のコントラクトに 1 つだけ PascalCase の例外があると、厄介なプロパティすべてに `[JsonPropertyName]` のオーバーライドを書くか、完全にカスタムなポリシーを用意するしかありませんでした。.NET 11 Preview 3 では、同じ型の中でポリシーを混在させられます:

```csharp
using System.Text.Json.Serialization;

public sealed class Webhook
{
    public string Url { get; set; } = "";

    [JsonNamingPolicy(JsonKnownNamingPolicy.KebabCaseLower)]
    public string RetryStrategy { get; set; } = "exponential";

    [JsonNamingPolicy(JsonKnownNamingPolicy.SnakeCaseLower)]
    public int MaxAttempts { get; set; } = 5;
}
```

`PropertyNamingPolicy = JsonNamingPolicy.CamelCase` で、`Url` は `url` に、`RetryStrategy` は `retry-strategy` に、`MaxAttempts` は `max_attempts` にシリアライズされます。これは、外部システムが一貫していないときのプロパティごとの `[JsonPropertyName]` のノイズをたくさん取り除きます。

## 型レベルの [JsonIgnore] デフォルト

伴う変更は、`[JsonIgnore(Condition = ...)]` がプロパティだけでなく、型そのものにも合法になったことです ([dotnet/runtime #124646](https://github.com/dotnet/runtime/pull/124646))。クラスに付けると、その条件が型内のすべてのプロパティのデフォルトになります:

```csharp
using System.Text.Json.Serialization;

[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
public sealed class PatchRequest
{
    public string? Name { get; set; }
    public string? Email { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public bool? IsActive { get; set; }
}
```

`PatchRequest` のすべての nullable プロパティは、null のとき payload から落ちます - これは JSON Merge Patch リクエスト形状が望むところそのものです。`IsActive` のオーバーライドは、明示的な `false` がそこで意味を持つので、再び入ります。同じパターンは以前、個々のプロパティに `JsonIgnoreCondition.WhenWritingNull` をつけるか、シリアライザーオプションに `DefaultIgnoreCondition` を付ける必要があり、それが他のすべての DTO を同じルールに従わせていました。

## 小さな面が重要な理由

属性レベルの制御は、チームがカスタムコンバーターをストックの `System.Text.Json` に置き換えることを可能にするものです。PascalCase は「自分でポリシーを書け」の最後の理由を取り除き、メンバー単位のネーミングは `[JsonPropertyName]` のボイラープレートの 1 クラスを削除し、型レベルの `[JsonIgnore]` は PATCH やイベント DTO が 1 箇所でデフォルトを設定することを可能にします。3 つの変更はすべて source generator とも動くので、Native AOT アプリは追加の設定なしにこれらを得ます。[Preview 3 のライブラリノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/libraries.md) が今月出荷される `System.Text.Json` の残りの更新を追跡しています。
