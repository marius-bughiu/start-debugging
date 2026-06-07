---
title: "EF Core 11 Preview 4: .config/dotnet-ef.json で --project と --startup-project の打ち直しをやめる"
description: "EF Core 11 Preview 4 では dotnet ef ツールが .config/dotnet-ef.json ファイルからオプションの既定値を読み込めるようになり、分割されたソリューションでもすべてのコマンドで --project と --startup-project を渡す必要がなくなります。"
pubDate: 2026-06-01
tags:
  - "ef-core"
  - "dotnet-11"
  - "dotnet-cli"
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2026/06/efcore-11-dotnet-ef-json-config-file"
translatedBy: "claude"
translationDate: 2026-06-01
---

レイヤー化されたソリューションで EF Core のマイグレーションを実行する人なら、この儀式をご存じでしょう。`DbContext` はインフラストラクチャプロジェクトにあり、接続文字列と DI の配線は API プロジェクトにあるため、`dotnet ef` コマンドはどれも一段落になってしまいます。`dotnet ef migrations add AddOrders --project src/App.Infrastructure --startup-project src/App.Api --context AppDbContext`。暗記するか、エイリアスにするか、メモファイルから貼り付けるかのいずれかです。2026 年 5 月 12 日に [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/) の一部としてリリースされた [EF Core 11 Preview 4](/ja/2026/05/ef-core-11-temporal-tables-clr-period-properties/) では、ついにそれらの既定値を一度だけ書き留められるようになりました。

## ツールがツリーをさかのぼって見つける構成ファイル

コマンドラインツール `dotnet ef` は、`.config/dotnet-ef.json` ファイルからオプションの既定値を読み込むようになりました。検索は `.editorconfig` や `global.json` と同じように動作します。ツールは現在の作業ディレクトリからディレクトリツリーをさかのぼり、最初に見つかったファイルを使用します。ソリューションのルートに 1 つ置けば、ツリー内のどこから実行されたコマンドでもそれを継承します。

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "framework": "net11.0",
  "configuration": "Debug",
  "context": "AppDbContext",
  "runtime": "win-x64",
  "verbose": true,
  "noColor": false,
  "prefixOutput": false
}
```

このファイルがあれば、一段落だったものが本来あるべき姿に戻ります。

```console
dotnet ef migrations add AddOrders
dotnet ef database update
```

サポートされるキーは、おなじみのフラグに直接対応します。`project`、`startupProject`、`framework`、`configuration`、`context`、`runtime`、`verbose`、`noColor`、`prefixOutput` です。正しく押さえておきたい点が 1 つあります。`project` と `startupProject` のパス値は、コマンドを実行する場所を基準とするのではなく、ファイルを含む `.config` ディレクトリの親を基準として解決されます。ファイルをリポジトリのルートの `.config/` に置けば、パスはルートから書いたかのように読み取れます。

## 明示的なフラグは依然として優先される

これは既定値のファイルであり、ロックファイルではありません。コマンドラインで渡したオプションはどれも JSON の値を上書きするため、`AppDbContext` を既定のままにしつつ、2 つ目のコンテキストに対して単発で実行できます。

```console
dotnet ef migrations add AddAudit --context AuditDbContext
```

この優先順位こそが、これをコミットしても安全な理由です。`.config/dotnet-ef.json` をソース管理に追加すれば、共有スクリプトを誰も編集することなく、すべての開発者と CI が同じ既定値を得られます。このパターンは `dotnet tool` がすでに `.config/dotnet-tools.json` を使っている方法を反映しているため、ローカルツールマニフェストを使う人には馴染みのある場所でしょう。

同じプレビューには、スクリプティングと相性のよい小さな補完的変更もあります。EF ツールはすべてのログとステータスのメッセージを標準エラー出力に書き込むようになり、標準出力はコマンドの実際の結果のためだけに予約されます。そのため `dotnet ef migrations script > schema.sql` は、バナーのノイズが混ざらないクリーンな SQL を返します。

これは、[EF Core 11 Preview 4: テンポラルテーブルの期間列がついに本物のプロパティになれる](/2026/05/ef-core-11-temporal-tables-clr-period-properties/) で扱ったテンポラルテーブルのエルゴノミクス改善と同時に登場します。全体の概要については、[dotnet ef ドキュメントの「構成ファイル」セクション](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#configuration-file)と [EF Core 11 の新機能ページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)を参照してください。
