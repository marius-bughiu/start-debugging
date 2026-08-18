---
title: ".NET 11 Preview 7 で MSBuild サーバーがデフォルトで有効になりました"
description: "Preview 7 で MSBuild サーバーがオプトインからデフォルト有効に変わり、連続する dotnet build や dotnet test が温まったワーカープロセスを再利用するようになりました。何が変わったのか、無効化する方法、そしてサーバーが実際に使われたかを確認する方法を説明します。"
pubDate: 2026-08-18
tags:
  - "dotnet-11"
  - "msbuild"
  - "dotnet-sdk"
  - "build-performance"
lang: "ja"
translationOf: "2026/08/msbuild-server-on-by-default-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-18
---

.NET 11 Preview 7 は 2026-08-11 にリリースされましたが、SDK のセクションには、実行するすべてのビルドに影響するデフォルト値の変更が埋もれています。MSBuild サーバーが、明示的に無効化しない限り有効になりました ([dotnet/sdk#55231](https://github.com/dotnet/sdk/pull/55231))。

MSBuild サーバーは、CLI の呼び出しと呼び出しの間、温まった MSBuild ワーカープロセスを生かしておきます。サーバーがない場合、`dotnet build`、`dotnet test`、`dotnet run` のたびに MSBuild プロセスの起動、JIT のウォームアップ、SDK の解決をゼロから支払うことになります。サーバーがあれば、2 回目以降の呼び出しはそれを省略できます。この機能は数リリースにわたって `MSBUILDUSESERVER` の背後に存在していましたが、Preview 7 は有効をデフォルトにすることで仕上げをしました。

## 無効化する方法と、実際に優先される変数

サーバーを無効にする環境変数は 2 つあり、両者は同等ではありません。

```bash
# Either of these keeps the classic single-shot MSBuild behavior
export DOTNET_CLI_USE_MSBUILD_SERVER=false
export MSBUILDUSESERVER=0
```

現在は `DOTNET_CLI_USE_MSBUILD_SERVER=false` が優先されます。この変数は `MSBUILDUSESERVER=0` を下位まで伝播させるため、応答ファイルや `MSBUILDFORCEMULTITHREADED=1`、あるいは `/mt` の指定によってサーバーが黙って再有効化されることはありません ([dotnet/sdk#55393](https://github.com/dotnet/sdk/pull/55393))。ビルドごとに確実にコールドなプロセスを必要とする CI ステージがあるなら、設定すべきはこちらの変数です。`MSBUILDUSESERVER=0` だけを設定すると、下位の何かが再び有効化する余地が残ります。

## なぜ今デフォルトが変わったのか

デフォルトがひとりでに変わったわけではありません。実験的なマルチスレッドビルドモード (`-mt`) がサーバーを前提条件として扱うため、Preview 7 ではサーバーを強化し、同じリリースで長年の粗さがいくつか修正されました。

- `-nr:false` を指定していても Server GC が利用できるようになりました。Server GC を得る手段は MSBuild サーバーだけなので、`-mt` はビルド直後に自身を終了する短命なサーバーを使い、再利用しないという意図を尊重します ([dotnet/msbuild#14248](https://github.com/dotnet/msbuild/pull/14248))。
- 入れ子になった MSBuild プロセスでデッドロックが起きなくなりました。MSBuild を呼び出すタスクから起動されたビルドが、外側のコーディネーターを待たずに進行できます ([dotnet/msbuild#14224](https://github.com/dotnet/msbuild/pull/14224))。
- 接続の初回ハンドシェイク中の予期しない例外は、クライアントを異常終了させる代わりに捕捉され、きれいに報告されます ([dotnet/msbuild#14292](https://github.com/dotnet/msbuild/pull/14292))。

効果が最もはっきり表れるのは `-mt` ビルドで、JIT と SDK 解決の状態のために温まったサーバーに依存しています。MSBuild のパフォーマンスダッシュボードによると、OrchardCore のソリューションをゼロから `-t:Rebuild` した場合、`-mt` により Windows では平均で 26% 短縮 (146.2 秒から 107.8 秒)、Linux では 23% 短縮 (118.8 秒から 91.5 秒) しました。

## サーバーが使われたことを確認する

静かなコールドスタートは、温まった起動と見た目が同じで、ただ遅いだけです。Preview 7 は構造化されたビルドイベント `MSBuildServerLifecycleEventArgs` を追加し、サーバーが起動されたのか、短命として起動されたのか、再利用されたのか、まったく使われなかったのかを、サーバーのプロセス ID とともに報告します ([dotnet/msbuild#14156](https://github.com/dotnet/msbuild/pull/14156))。重要度は低に設定されているため、通常のコンソール出力を変えることなく、バイナリログや診断レベルの詳細度に現れます。

```bash
dotnet build -v:diag
# or capture it for later
dotnet build -bl
```

新しい SDK をインストールした後や、温まったプロセスがキャッシュしたグローバルな MSBuild プロパティを変更した後など、まっさらな状態から始めたいときは、プロセスを探し回るのではなく、明示的にサーバーを終了してください。

```bash
dotnet build-server shutdown --msbuild
```

このコマンド自体は新しくありませんが、温まったサーバーがデフォルトになった今、その重要性はぐっと増しています。ビルドの挙動が怪しくなったときに思い浮かべる「obj と bin を削除する」の隣に置いておくべきコマンドです。

詳細は [.NET 11 Preview 7 の SDK リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/sdk.md) にあります。Preview 7 の他の変更も追いかけているなら、[パスワード保護された ZIP アーカイブのサポート](/ja/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) が読む価値のあるもう一つの変更です。
