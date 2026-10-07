---
title: "C# Dev Kit 11.0 は 6 つのプロセスを 1 つの Native AOT バイナリに統合しました"
description: "C# Dev Kit 11.0 のプレリリースでは、6 つのマネージドプロセスが単一の Native AOT 製 CSDevKit プロセスと永続的なプロジェクトキャッシュに置き換わりました。407 プロジェクトの Aspire ソリューションが、84.1 秒ではなく 3.0 秒で使えるようになり、メモリ使用量も 2,072 MB から 316 MB に減りました。"
pubDate: 2026-10-07
tags:
  - "vscode"
  - "csharp"
  - "dotnet-11"
  - "native-aot"
  - "tooling"
lang: "ja"
translationOf: "2026/10/csharp-dev-kit-11-native-aot-opens-solutions-in-a-second"
translatedBy: "claude"
translationDate: 2026-10-07
---

2026 年 10 月 6 日、Drew Noakes が .NET Blog で [A faster, lighter C# Dev Kit](https://devblogs.microsoft.com/dotnet/faster-lighter-csharp-dev-kit/) を公開しました。C# Dev Kit のバージョンは 3.3 から 11.0 に一気に上がり、番号が .NET 11 に合わせられています。この新しい番号は、拡張機能が VS Code でソリューションを読み込む仕組みを作り直したことを示しています。"Loading projects..." のスピナーがいつまでも終わらず、大きな C# ソリューションでの VS Code 利用を諦めたことがあるなら、もう一度試してみてください。

## 6 つのマネージドプロセスが 1 つの Native AOT バイナリに

C# Dev Kit 3.x は、6 つの別々のマネージドプロセスを実行していました。それぞれがランタイムを起動し、作業を始める前に自身の起動コードを JIT コンパイルする必要がありました。バージョン 11.0 ではこれらを Native AOT でコンパイルした単一の `CSDevKit` プロセスに統合したため、起動経路でランタイムの読み込みも JIT の実行も不要になりました。

C# 言語サービス (Roslyn) は引き続き独自のプロセスで動作するため、以下のメモリ使用量は Dev Kit 側だけの数値です。それでも減少幅は大きいです。

| ソリューション | プロジェクト数 | C# ファイル数 | 3.3 | 11.0 |
|----------|----------|----------|-----|------|
| Orleans | 155 | 4,010 | 1,307 MB | 208 MB |
| Roslyn | 398 | 18,153 | 2,000 MB | 379 MB |
| Aspire | 407 | 4,686 | 2,072 MB | 316 MB |

3 つのリポジトリすべてで、メモリ使用量はおよそ 81 から 85% 減っています。

## コミットできるプロジェクトキャッシュ

高速化のもう半分は、永続的なプロジェクトキャッシュです。最初の読み込みでプロジェクトを評価して結果を保存します。2 回目以降はキャッシュから読み込み、デザイン時の完全な評価を省略します。Aspire リポジトリでは、アクティブなファイルが 84.1 秒ではなく 0.47 秒で使えるようになり、ソリューション全体も 3.0 秒で準備できます。Orleans では、アクティブなファイルが 0.53 秒、ソリューション全体が 2.3 秒で、従来の 50.3 秒から短縮されています。

ブログ記事によると、キャッシュファイルをバージョン管理にコミットすれば、新しいクローンや新しい git worktree でもすぐに高速なツールが使えるそうです。これは、たとえば並列のコーディングエージェント用に複数の git worktree を並べて使う場合に役立ちます。現状では、worktree を新しく作るたびに、またコールドなプロジェクト読み込みのコストがかかります。ただし、発表ではキャッシュファイルの名前やキャッシュが無効になる条件が示されていません。`.gitignore` を変更する前に、拡張機能がリポジトリに何を書き込むのかを確認してください。

インクリメンタルビルドも速くなりました。Aspire ソリューションの何も変更しないビルドは 34.4 秒から 0.88 秒に、1 つのファイルを変更した後のビルドは 36.1 秒から 2.1 秒になりました。

## MSBuild ファイルに本格的な IntelliSense

バージョン 11.0 では、`.csproj`、`.props`、`.targets` ファイルの言語サポートも追加されました。補完、診断、定義へ移動、クイックフィックス、セマンティックハイライトが使えます。パッケージ名とバージョンは入力中に補完され、既知の脆弱性があるパッケージの上には CodeLens が警告を表示します。

```xml
<ItemGroup>
  <!-- package id and version now complete; vulnerable versions get a CodeLens warning -->
  <PackageReference Include="MessagePack" Version="3.1.11" />
</ItemGroup>
```

新しい "C# Doctor" ビューは、SDK、ランタイム、ターゲットフレームワーク、リストア、脆弱性のチェックを 1 か所にまとめます。プロジェクトが読み込まれなかった理由を探して、出力チャネルを掘り下げる必要はもうありません。

## プレリリース版を試す

バージョン 11.0 はまだプレリリースです。拡張機能ビューで C# Dev Kit を開き、**Switch to Pre-Release Version** を選択してください。ターミナルから実行することもできます。

```bash
code --install-extension ms-dotnettools.csdevkit --pre-release
```

自分のソリューションでメモリ使用量を確認するには、ソリューションの読み込み後に、統合されたプロセスを調べます。

```bash
# macOS / Linux: resident memory in KB
ps -A -o rss,comm | grep -i csdevkit
```

不具合は [microsoft/vscode-dotnettools](https://github.com/microsoft/vscode-dotnettools) に報告してください。これほど大規模な書き直しでは、一部のプロジェクト構成で粗い部分が出るはずで、チームは安定版のリリース前にそうした報告を集めています。
