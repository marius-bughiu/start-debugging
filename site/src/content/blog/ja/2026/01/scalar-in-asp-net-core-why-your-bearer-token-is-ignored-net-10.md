---
title: "ASP.NET Core の Scalar: Bearer トークンが無視される理由 (.NET 10)"
description: "Postman では動く Bearer トークンが Scalar では動かない場合、原因はだいたい OpenAPI ドキュメントです。.NET 10 で適切な security スキームを宣言する方法を紹介します。"
pubDate: 2026-01-23
tags:
  - "aspnet"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Scalar は ASP.NET Core の OpenAPI ドキュメント用のすっきりした代替 UI として、ますます見かけるようになっています。最新の r/dotnet の質問が、よくある罠を浮かび上がらせています。Scalar の auth UI にトークンを貼り付け、Postman は動くのに、Scalar からの呼び出しは依然として `Authorization: Bearer ...` なしで API に届く、というものです: [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/)。

問題は「JWT 認証が壊れている」ことであることはまれです。たいていは、OpenAPI ドキュメントが適切な HTTP Bearer の security スキームを宣言しておらず、UI が確実に適用すべきものを持っていないだけです。

## Scalar はあなたのミドルウェアではなく OpenAPI 契約に従う

.NET 10 では、パイプラインで認証を完全に設定したまま、auth について何も語らない OpenAPI ドキュメントを出荷することがあり得ます。そうなると、ツールの挙動は一貫しなくなります:

-   Postman はヘッダーを手で追加するから動きます。
-   Scalar (やその他の UI) は OpenAPI ドキュメントが宣言していない限り、security 要件を推測できません。

Scalar 自身の ASP.NET Core 統合ドキュメントが、ここでの最良のアンカーです: [https://scalar.com/products/api-references/integrations/aspnetcore/integration](https://scalar.com/products/api-references/integrations/aspnetcore/integration)。

## OpenAPI ドキュメントで Bearer security を宣言する

組み込みの OpenAPI サポートを使っているなら、修正は `http` `bearer` スキームを注入し、それを (グローバルに、または選択的に) 操作へ適用する transformer を追加することです。

必要な形は次のとおりです (要点に絞ったもの):

```cs
using Microsoft.OpenApi.Models;

// Program.cs (.NET 10)
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer((document, context, ct) =>
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, OpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT"
        };

        // Apply globally (or attach per operation if you prefer)
        document.SecurityRequirements ??= new List<OpenApiSecurityRequirement>();
        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme { Reference = new OpenApiReference
                { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }] = Array.Empty<string>()
        });

        return ValueTask.CompletedTask;
    });
});
```

ドキュメントが security スキームを表現していれば、Scalar は入力したトークンを予測可能な形でリクエストに適用できます。

## Scalar が同じ OpenAPI エンドポイントにマップされていることを確認する

第2の落とし穴は配線です。Scalar は今修正した OpenAPI ドキュメント (たとえば `"/openapi/v1.json"`) を指していなければなりません。OpenAPI のセットアップの隣にマッピングを置いておくことで、うっかり古いドキュメントに対して Scalar を提供してしまうのを防げます。

Scalar には UI のマッピング層で HTTP Bearer 認証を設定するオプションもあります。それを使う場合は、便宜上の機能として扱い、信頼できる単一の情報源として扱わないでください。OpenAPI 契約は依然として Bearer スキームを宣言すべきです。

## 数分でできる現実チェック

根本原因を数分で確認したいなら:

-   生成された OpenAPI JSON を開き、`"securitySchemes"` と `"bearer"` を検索してください。
-   見つからなければ、Scalar は「あなたのトークンを無視している」のではありません。ただ、あなたが渡した契約に従っているだけです。

きっかけになった元のスレッド (スクリーンショット付き): [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/)。
