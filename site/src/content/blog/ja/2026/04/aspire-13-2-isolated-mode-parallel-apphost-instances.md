---
title: "Aspire 13.2 --isolated: ポート衝突なしで並列 AppHost インスタンスを走らせる"
description: "Aspire 13.2 は --isolated フラグを出荷し、各 aspire run に独自のランダムポートと secrets store を与えます。マルチ checkout ワーク、エージェント worktree、ライブ AppHost を必要とする統合テストのロックを解除します。"
pubDate: 2026-04-18
tags:
  - "aspire"
  - "dotnet-11"
  - "dotnet"
  - "tooling"
lang: "ja"
translationOf: "2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances"
translatedBy: "claude"
translationDate: 2026-04-24
---

同じ Aspire アプリのコピーを 2 つ同時に走らせることは常に `address already in use` との戦いを意味しました。[今週発表された](https://devblogs.microsoft.com/aspire/aspire-13-2-announcement/) Aspire 13.2 は、その戦いを取り除く小さくても有用なフラグを追加します: `--isolated` です。呼び出しごとに独自のランダムポート、独自の user secrets store、独自の dashboard URL が付くので、2 つの AppHost が手動のポートリマッピングなしで並んで生きられます。

## 衝突はどこから来たか

デフォルトでは `aspire run` は固定ポートにバインドします: dashboard は 18888、OTLP は 4317/4318、各リソースにも予測可能なバインディング。これは単一ブランチの単一開発者には問題ありません。2 つ目の worktree を追加したり、別のインスタンスを立ち上げる coding エージェントを入れたり、ライブ AppHost が必要な統合テストが加わるや、全てが衝突します。チームは `launchSettings.json` 調整やカスタムポートマップでこれをパッチしてきましたが、どれも組み合わせが効きません。

## `--isolated` が実際に変えること

`aspire run` や `aspire start` に付ける `--isolated` は、呼び出しごとに 2 つのことを行います。まず、通常固定番号にバインドされるすべてのポート (dashboard、OTLP、リソースエンドポイント) が代わりにランダムな空きポートにバインドされます。Service discovery が動的な値をピックアップするので、アプリ自体は兄弟が何を選んだか知る必要がありません。次に、user secrets のバッキングストアが run ごとに一意な instance ID でキーされ、connection strings や API key が並列 AppHost 間で漏れません。

典型的な 2 ブランチワークフローは今やこう見えます:

```bash
# Terminal 1 - feature branch worktree
cd ~/src/my-app-feature
aspire run --isolated

# Terminal 2 - bug fix worktree
cd ~/src/my-app-bugfix
aspire run --isolated
```

両方のプロセスが立ち上がり、両方の dashboard が異なる URL で到達可能で、どちらも相手を知らず気にしません。片方をシャットダウンしても、もう片方のポート予約は乱されません。

## 「複数ターミナル」を超えてなぜ重要か

より興味深い消費者は tooling です。[Detached モード](https://devblogs.microsoft.com/aspire/aspire-detached-mode-and-process-management/) は coding エージェントが `--detach` で AppHost を起動してターミナルを取り戻すことを許します。`--isolated` と組み合わせれば、同じエージェントが N 個の git worktree にまたがる N 個の AppHost を並列に立ち上げ、それぞれに対して HTTP probe や統合テストを走らせ、解体することができます。すべて手動のポート会計なしで。それは VS Code のバックグラウンドエージェントが探索作業のために worktree を作るときすでに使っているパターンです。

統合テストスイートも同じ恩恵を受けます。以前は、開発者がアプリをローカルで開いている間に CI で `dotnet test` から AppHost を走らせるには environment override が必要でした。`--isolated` があれば、test fixture はただこうすれば済みます:

```csharp
[Fact]
public async Task ApiReturnsHealthy()
{
    var apphost = await DistributedApplicationTestingBuilder
        .CreateAsync<Projects.MyApp_AppHost>(["--isolated"]);

    await using var app = await apphost.BuildAsync();
    await app.StartAsync();

    var client = app.CreateHttpClient("api");
    var response = await client.GetAsync("/health");

    response.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

静的ポートマップなし、テスト run 間のクリーンアップなし、「アプリ走らせっぱなしにしたっけ?」のサプライズなし。

## --detach と aspire wait との組み合わせ

13.2 の完全なエージェントフレンドリーループは、バックグラウンドで起動する `aspire run --isolated --detach`、リソースが立ち上がるまでブロックする `aspire wait api --status healthy --timeout 120`、グラフ全体を解体せずにピースをサイクルする `aspire resource api restart` のように見えます。`--isolated` はそれらのループを N 部の間でコンポーザブルにするピースです。

13.2 の CLI 追加の完全なリストは [isolated モードのドキュメント](https://devblogs.microsoft.com/aspire/aspire-isolated-mode-parallel-development/) を参照してください。
