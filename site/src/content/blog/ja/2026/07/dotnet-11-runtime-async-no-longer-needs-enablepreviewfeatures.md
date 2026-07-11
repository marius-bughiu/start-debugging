---
title: ".NET 11 の Runtime Async が EnablePreviewFeatures フラグを不要に"
description: ".NET 11 のプレビュー版が 11 月のリリースへ向けて進むにつれ、Runtime Async は成熟しました。net11.0 プロジェクトは 1 つの MSBuild プロパティで有効化でき、ランタイムライブラリ自体もそれでコンパイルされるようになりました。"
pubDate: 2026-07-11
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
lang: "ja"
translationOf: "2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures"
translatedBy: "claude"
translationDate: 2026-07-11
---

Runtime Async が .NET 11 Preview 2 で初めて登場したとき、それを有効にするには 2 つの MSBuild プロパティと、自分が最先端で作業しているという明示的な了解が必要でした。プレビュー版が 2026 年 11 月のリリースへ向けて進む中で (Preview 6 は 7 月 10 日に公開されました)、その障壁は静かに取り払われました。Runtime Async は依然としてプレビュー機能ですが、`net11.0` プロジェクトはそれを使うために `<EnablePreviewFeatures>true</EnablePreviewFeatures>` を必要としなくなり、.NET のランタイムライブラリ自体もそれでコンパイルされるようになりました。

## 2 つではなく 1 つのプロパティ

[Runtime Async に関する最初の記事](/ja/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)に従っていた場合、あなたの `.csproj` は次のようになっていました。

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

現在の有効化はコンパイラーのフラグだけです。

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
</PropertyGroup>
```

`EnablePreviewFeatures` は `System.Runtime.Experimental` のアナライザー全体を取り込み、プロジェクトを SDK のすべてのプレビュー API に参加するものとしてマークしていました。これを外すということは、アセンブリ全体で無関係な実験的機能を誤って有効にすることなく、ランタイムネイティブな async を試せるということです。

## BCL が自らこれを使用

より大きなシグナルは、.NET のランタイムライブラリが `runtime-async=on` でコンパイルされていることです。それらにはもはやコンパイラーが生成するステートマシンが含まれておらず、完全にランタイムが提供する async に依存しています。`System.Net.Http`、`System.IO`、`System.Text.Json` に向けて行うすべての `await` は、すでに新しいモデル上で動作しています。これにより、この機能はデフォルトになる前に広範な機能面とパフォーマンス面の検証を得られ、非同期の依存関係がフレームワークライブラリだけであるアプリは、実質的にすでに移行済みであることを意味します。

## 気づかないうちに変わったスイッチ

古い環境変数を操作するスクリプトや起動プロファイルを持っていた場合、それらは失われています。かつて動作を切り替えていた `DOTNET_RuntimeAsync` と `UNSUPPORTED_RuntimeAsync` の変数は削除されました。特定のプロジェクトを除外するには、代わりにプロジェクトプロパティを設定します。

```xml
<PropertyGroup>
  <UseRuntimeAsync>false</UseRuntimeAsync>
</PropertyGroup>
```

## より広いコンパイルの対象範囲

2 つの修正が、Runtime Async が実際に適用される範囲を広げます。`Task` から `Task<T>` への共変オーバーライドが機能するようになりました。派生クラスが `Task` として型付けされた基底メソッドに対して `Task<T>` を返すとき、ランタイムは呼び出し規約の違いを橋渡しする void を返すサンクを生成するため、仮想ディスパッチは NativeAOT を含む両方の形式で機能します。また、ReadyToRun (crossgen2) コンパイル中に runtime-async メソッドのインライン化を妨げていた制限が取り除かれたので、await のない async メソッドの同期的な高速パスは端から端までインライン化できます。

これらのいずれも、Runtime Async をまだ本番のデフォルトにするものではありません。しかし、実際の .NET 11 コードベースでそれを試すための手間は、いまや MSBuild のたった 1 行であり、標準ライブラリはそれが通用することをすでに証明しています。有効化の詳細はすべて [.NET 11 ランタイムの新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) のページにあります。
