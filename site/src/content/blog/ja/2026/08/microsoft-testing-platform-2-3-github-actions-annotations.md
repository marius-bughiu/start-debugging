---
title: "Microsoft.Testing.Platform 2.3: --report-gh がテスト失敗を PR の差分に表示する"
description: "2026-08-06 の .NET ブログの MTP レポート記事から、Microsoft.Testing.Platform 2.3.0 で安定版になった一連の拡張機能を取り上げます。GitHub Actions のアノテーション、クラッシュに強い TRX の逐次書き込み、Azure DevOps の不安定テスト履歴です。"
pubDate: 2026-08-07
tags:
  - "dotnet"
  - "testing"
  - "ci-cd"
  - "github-actions"
  - "msbuild"
lang: "ja"
translationOf: "2026/08/microsoft-testing-platform-2-3-github-actions-annotations"
translatedBy: "claude"
translationDate: 2026-08-07
---

2026-08-06 に .NET ブログが [Test reporting in Microsoft.Testing.Platform: from red build to root cause](https://devblogs.microsoft.com/dotnet/microsoft-testing-platform-reporting/) を公開しました。ニュースは記事そのものではなく、このレポート機能のかなりの部分が Microsoft.Testing.Platform 2.3.0 (2026-07-07、最新パッチは 2026-07-28 の 2.3.3) に静かに着地していて、ほとんどのリポジトリでいまだに既定でオフのままだという点です。

## job が赤くなるたびにログを読み下す必要はない

追加設定なしの場合、GitHub のランナー上で失敗した MTP の実行が返すのは、ゼロ以外の終了コードとコンソールに並ぶ大量のテキストだけです。新しい `Microsoft.Testing.Extensions.GitHubActionsReport` パッケージと `--report-gh` スイッチは、ランナーがそのデータをどう扱うかを変えます。アセンブリ単位のログのグループ化、ソース位置が解決できたときに pull request の **Files changed** の行外に表示される `::error` アノテーション、`GITHUB_STEP_SUMMARY` に追記される Markdown の job サマリー、そして遅いテストに対する `::notice` エントリです。

この拡張機能は環境変数 `GITHUB_ACTIONS` が `true` でない限り何もしないため、ローカルの `dotnet test` には影響しません。各サブ機能は `--report-gh` を指定した時点で既定でオンになり、個別にオフにできます。

```yaml
- name: Test
  run: dotnet test -- --report-gh --report-gh-slow-test-threshold 30s --report-trx
```

しきい値は秒数をそのまま渡すか、`90s`、`2m`、`1.5h` のように接尾辞付きの値を渡せます。既定値は `60s` です。

## 呼び出しごとではなくリポジトリ全体で設定する

workflow のステップごとにフラグを貼り付けずに済む方法が 2 つあります。ひとつは `Directory.Build.props` から Microsoft の拡張機能セット全体を各テストプロジェクトに取り込む方法です。

```xml
<PropertyGroup>
  <TestingExtensionsProfile>AllMicrosoft</TestingExtensionsProfile>
</PropertyGroup>
```

そのうえで、テストプロジェクトの隣に置いた `testconfig.json` でオプションを宣言的に指定します。

```json
{
  "commandLineOptions": {
    "report-trx": true,
    "report-html": true,
    "report-azdo": true,
    "report-azdo-flaky-history": 14
  }
}
```

依存グラフに `Microsoft.Testing.Platform.MSBuild` が入っていれば (MSTest、NUnit、xUnit のランナーが推移的に持ち込みます)、パッケージのインストール時にレポートプロバイダーが自動登録されます。`builder.AddGitHubActionsProvider()` の手動呼び出しが必要なのは、`<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` を設定した場合だけです。

## テストホストが落ちても残る TRX

私が最初に有効化する変更は、実はフラグですらありません。MTP 2.3.0 以降、TRX の結果は実行の進行に合わせてディスクへ逐次書き込まれるため、スイートの途中でテストホストがクラッシュしても、クラッシュ前に収集した内容を含む TRX が残ります。以前のこのシナリオは、空の結果ディレクトリと読むものが何もない CI 失敗を生んでいました。まさに[ビルドのトリアージのために binlog の MCP サーバーに頼る](/ja/2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures/)動機になっている行き止まりです。

TRX の既定のファイル名も 2.3.0 で決定的になりました。`<UserName>_<MachineName>_<timestamp>.trx` ではなく `{asm}_{tfm}_{arch}.trx` です。これだけでも、成果物アップロードの壊れやすい glob パターンの一群が解消します。

## Azure DevOps でリグレッションと不安定テストを切り分ける

Azure DevOps 側では、`--report-azdo-flaky-history 14` が過去 N 日 (1 から 90) のテスト結果履歴を照会し、失敗に不安定さの文脈を付与します。`--report-azdo-demote-known-flaky` と組み合わせると、不安定さのしきい値 (既定で 25%) を超えた失敗はエラーから警告へ降格されるため、ページ上で赤いままなのは本物のリグレッションだけになります。

HTML、JUnit XML、CTRF JSON のレポートも `--report-html`、`--report-junit`、`--report-ctrf` として 2.3.0 で追加されました。3 つとも実験的と明記されているので、必須チェックに組み込む前に MTP のバージョンを固定してください。オプションの完全な一覧は [MTP のテストレポートのドキュメント](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-test-reports)にあります。
