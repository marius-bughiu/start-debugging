---
title: ".NET 11 Runtime Async がステートマシンを置き換え、よりクリーンなスタックトレースを実現"
description: ".NET 11 の Runtime Async は async/await の処理をコンパイラ生成のステートマシンからランタイム自体に移し、読みやすいスタックトレース、正しいブレークポイント、ヒープ割り当ての削減を実現します。"
pubDate: 2026-04-06
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
  - "debugging"
lang: "ja"
translationOf: "2026/04/dotnet-11-runtime-async-cleaner-stack-traces"
translatedBy: "claude"
translationDate: 2026-04-25
---

.NET の async スタックトレースを見つめて実際にどのメソッドがスローしたかを把握しようとしたことがあるなら、その痛みをご存知でしょう。コンパイラ生成のステートマシンインフラストラクチャは、シンプルな 3 メソッドの呼び出しチェーンを `AsyncMethodBuilderCore`、`MoveNext`、マングルされたジェネリック名の壁に変えます。.NET 11 Preview 2 は、これを最も深いレベルで修正する Runtime Async という preview 機能を出荷しました。CLR 自体が C# コンパイラの代わりに async の中断と再開を管理するようになりました。

## 以前はどう動いていたか: ステートマシンが至るところに

.NET 10 以前では、メソッドを `async` とマークすると、C# コンパイラはそれを `IAsyncStateMachine` を実装する struct またはクラスに書き換えるよう指示されます。すべてのローカル変数はその生成された型のフィールドになり、すべての `await` は `MoveNext()` 内の状態遷移になります。結果は正しいですが、コストがあります。

```csharp
async Task<string> FetchDataAsync(HttpClient client, string url)
{
    var response = await client.GetAsync(url);
    response.EnsureSuccessStatusCode();
    return await response.Content.ReadAsStringAsync();
}
```

`FetchDataAsync` 内で例外が発生すると、スタックトレースには `AsyncMethodBuilderCore.Start`、生成された `<FetchDataAsync>d__0.MoveNext()`、ジェネリックな `TaskAwaiter` 配管のフレームが含まれます。3 つの async 呼び出しのチェーンでは、意味のある情報を持つフレームが 3 つしかないのに、15 以上のフレームを簡単に見ることになります。

## Runtime Async が変えるもの

Runtime Async が有効になると、コンパイラはもう完全なステートマシンを発行しません。代わりに、CLR にネイティブで中断を処理するよう指示するメタデータでメソッドをマークします。ランタイムはローカル変数をスタックに保持し、実行が同期的に完了できない `await` の境界を実際にまたいだ場合にのみそれらをヒープにスピルします。実用的な結果: 割り当てが少なくなり、スタックトレースが劇的に短くなります。

`OuterAsync -> MiddleAsync -> InnerAsync` のような 3 メソッドの async チェーンは、ソースに直接マッピングされるスタックトレースを生成します。

```
at Program.InnerAsync() in Program.cs:line 24
at Program.MiddleAsync() in Program.cs:line 14
at Program.OuterAsync() in Program.cs:line 8
```

合成された `MoveNext` なし、`AsyncMethodBuilderCore` なし、型がマングルされたジェネリックなし。ただメソッドと行番号だけです。

## デバッグが本当に動作するようになりました

Preview 2 は重要な修正を追加しました。ブレークポイントが runtime-async メソッド内で正しくバインドされるようになりました。Preview 1 では、デバッガーが `await` の境界をステップする際にブレークポイントをスキップしたり、予期しない行に着地したりすることがありました。Preview 2 では、`await` の後の行にブレークポイントを設定し、それを打ち、ローカルを通常通り検査できます。`await` をステップオーバーすると、ランタイムインフラストラクチャの内部ではなく、次のステートメントに着地します。

これはプロファイリングツールと診断ロギングにも利益をもたらします。ランタイムで `new StackTrace()` を呼び出したり `Environment.StackTrace` を読み取ったりするものはすべて、本当の呼び出しチェーンを見るようになり、構造化ロギングとカスタム例外ハンドラが余分なフィルタリングなしでより有用になります。

## Runtime Async を有効にする

これはまだ preview 機能です。`.csproj` に 2 つのプロパティを追加してオプトインします。

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

CLR 側のサポートは .NET 11 でデフォルトで有効になっているので、`DOTNET_RuntimeAsync` 環境変数を設定する必要はもうありません。コンパイラフラグが唯一のスイッチです。

## 注意点

Runtime Async はまだ本番コードのデフォルトではありません。.NET チームは末尾呼び出し、特定のジェネリック制約、既存の診断ツールとの相互作用に関するエッジケースに依然として取り組んでいます。すでに .NET 11 preview にいてテストプロジェクトで試したい場合、上記の 2 行の MSBuild がすべてです。

完全な Runtime Async の詳細は [.NET 11 Preview 2 リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/runtime.md) と Microsoft Learn の [What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) ページにあります。
