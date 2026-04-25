---
title: "ReSharper が VS Code と Cursor に登場、非商用利用は無料"
description: "JetBrains は ReSharper を VS Code 拡張機能として、完全な C# 解析、リファクタリング、ユニットテストと共に出荷しました。Cursor や Google Antigravity でも動作し、OSS と学習には無料です。"
pubDate: 2026-04-12
tags:
  - "resharper"
  - "vs-code"
  - "csharp"
  - "tooling"
lang: "ja"
translationOf: "2026/04/resharper-for-vscode-cursor-free-for-oss"
translatedBy: "claude"
translationDate: 2026-04-25
---

何年もの間、ReSharper は 1 つのことを意味していました。Visual Studio 拡張機能です。Visual Studio の外で JetBrains 級の C# 解析が欲しいなら、Rider が答えでした。それが 2026 年 3 月 5 日に変わりました。JetBrains が [ReSharper を Visual Studio Code](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/)、Cursor、そして Google Antigravity 向けにリリースしたのです。3 月 30 日の [2026.1 リリース](https://blog.jetbrains.com/dotnet/2026/03/30/resharper-2026-1-released/) はパフォーマンスモニタリングとより緊密な統合で続きました。

## 何が手に入るか

この拡張機能は、VS Code 拡張機能 API を話すあらゆるエディタに ReSharper の中核体験をもたらします。

- **コード解析**: C#、XAML、Razor、Blazor 向け、Visual Studio で ReSharper が使うのと同じ検査データベース付き
- **ソリューション全体のリファクタリング**: 名前変更、メソッド抽出、型の移動、変数のインライン化、その他カタログ全体
- **ナビゲーション**: 逆コンパイルされたソースコードへの定義へのジャンプを含む
- **Solution Explorer**: プロジェクト、NuGet パッケージ、ソースジェネレーターを処理
- **ユニットテスト**: NUnit、xUnit.net、MSTest 向け、インラインの実行/デバッグコントロール付き

拡張機能をインストールしてフォルダを開いた後、ReSharper は `.sln`、`.slnx`、`.slnf`、またはスタンドアロンの `.csproj` ファイルを自動的に検出します。手動の設定は不要です。

## ライセンスの観点

JetBrains はこれを非商用利用で無料にしました。これはオープンソース貢献、学習、コンテンツ制作、ホビープロジェクトをカバーします。商用チームは ReSharper または dotUltimate ライセンスが必要で、Visual Studio 拡張機能をカバーするのと同じものです。

## クイックテストドライブ

VS Code マーケットプレイスからインストールし、任意の C# ソリューションを開きます。

```bash
code my-project/
```

ReSharper はソリューションをインデックスし、すぐに検査を浮上させ始めます。コマンドパレット (`Ctrl+Shift+P`) を試して "ReSharper" と入力すると利用可能なアクションが表示されます。または任意のシンボルを右クリックしてリファクタリングメニューを開きます。

動作していることを確認する素早い方法:

```csharp
// ReSharper will flag this with "Use collection expression" in C# 12+
var items = new List<string> { "a", "b", "c" };
```

`["a", "b", "c"]` への変換の提案が見えれば、解析エンジンが動いています。

## これは誰のためか

C# を書く Cursor ユーザーは、AI ネイティブなエディタを離れずにファーストクラスの解析を得られるようになりました。コストや好みで Rider を避けてきた VS Code ユーザーは、ReSharper が 20 年間 Visual Studio ユーザーに提供してきたのと同じ深さの検査を手に入れます。そして OSS メンテナーはすべてを無料で手に入れます。

[完全なアナウンス投稿](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/) にはインストールの詳細と既知の制限事項が記載されています。
