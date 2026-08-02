---
title: "Visual Studio 18.8 は .NET のエージェント skill を標準搭載し、そのすべてをオフにしています"
description: "Visual Studio 2026 18.8 は、専門家が書いた .NET と Azure のエージェント skill をツールピッカーの Built-in カテゴリに配置しますが、既定では無効です。その既定値こそが興味深い点です。"
pubDate: 2026-08-02
tags:
  - "visual-studio"
  - "dotnet"
  - "ai-agents"
  - "agent-skills"
  - "github-copilot"
lang: "ja"
translationOf: "2026/08/visual-studio-18-8-built-in-dotnet-agent-skills-off-by-default"
translatedBy: "claude"
translationDate: 2026-08-02
---

Visual Studio 2026 バージョン 18.8 は、エージェントの専門知識が置かれる場所を静かに変えました。.NET チームと Azure チームが書いた skill は、自分で探して導入して設定するものではなく、IDE に同梱されるようになりました。2026-07-28 に Mark Downie が [Visual Studio July Update, Meet the New Agent](https://devblogs.microsoft.com/visualstudio/visual-studio-july-update-meet-the-new-agent-powered-by-copilot-sdk/) でこの変更をまとめ、GitHub は 2026-07-30 の [Copilot changelog](https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-july-update/) で取り上げました。

skill はツールピッカーの **Built-in** カテゴリに表示されますが、対応するワークロードがインストールされている場合に限られます。Azure ワークロードを入れていなければ、Azure の skill は表示されません。そしてすべての skill は、自分でオンにするまで無効のままです。

## 最初にオンにしたい 2 つの .NET skill

`dotnet-webapi` は、ASP.NET Core の HTTP API エンドポイントの作成と変更を導きます。正しいステータスコード、後付けではなくエンドポイント側に置かれた OpenAPI メタデータ、そしてすべてを 500 に潰さないエラー処理です。

既存のコードベースに対して使いたいのは `analyzing-dotnet-performance` です。非同期、メモリ、文字列、コレクション、LINQ、正規表現、シリアル化、I/O にまたがる約 50 のパフォーマンスアンチパターンを走査し、平坦な一覧を吐き出すのではなく重大度で分類します。狙う対象は、読み下すと自然に見えるためにコードレビューを通過してしまう、まさにこの手のコードです。

```csharp
// Materializes every matching row just to ask a yes/no question
if (db.Orders.Where(o => o.CustomerId == id).ToList().Count > 0)
{
    // ...
}

// One EXISTS query, no allocation, no blocking
if (await db.Orders.AnyAsync(o => o.CustomerId == id, ct))
{
    // ...
}
```

Azure 側には 3 段構成のデプロイチェーンが同梱されます。`azure-prepare` が Bicep または Terraform に加えて `azure.yaml` とマネージド ID の配線を生成し、`azure-validate` が事前チェックを実行し、`azure-deploy` がデプロイを実行します。さらに Azure Data Explorer に対する KQL 用の `azure-kusto` と、モデルのデプロイと評価のための `microsoft-foundry` があります。

## 既定でオフなのは、臆したからではなく文脈のための判断です

すべてを有効にしてエージェントに任せる方が簡単だったはずです。無効の状態で出荷したのは良い判断であり、理由はコンテキストの予算にあります。有効になった skill はどれも、実際のコードと同じウィンドウを奪い合う指示です。.NET の Web API を書いていて、たった 1 回のデプロイ作業のために Azure ワークロードを入れた人が、その後 1 年ずっと 6 つの Azure skill にすべての回答を狭められたいとは思いません。

これは `dotnet-test` プラグインに求められるのと同じ規律です。[先週のユニットテストエージェントの背後にあるもの](/ja/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/)ですが、読み込むべきは仕事に必要な skill であって、カタログ全体ではありません。

## これらに Visual Studio は必須ではありません

.NET の skill は [dotnet/skills](https://github.com/dotnet/skills) に、Azure の skill は [microsoft/azure-skills](https://github.com/microsoft/azure-skills) に公開されています。同じプラグインは Copilot CLI、Claude Code、VS Code、Cursor にもインストールできます。

```bash
/plugin marketplace add dotnet/skills
```

18.8 が実際にもたらすのは発見しやすさです。リポジトリを眺めていて `analyzing-dotnet-performance` にたどり着く人はいなかったでしょう。すでにインストール済みのワークロードの隣、ピッカーの中で見つかるなら話は別です。そうなると既定でオフというトグルだけが残る摩擦であり、これは残しておく価値があります。
