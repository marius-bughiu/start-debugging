---
title: "C# 14 のアイデア: インターセプターで System.Text.Json のソース生成を自動的に感じられるようにできる"
description: "コミュニティの議論で、C# 14 のインターセプターを使って JsonSerializer の呼び出しを書き換え、生成された JsonSerializerContext を自動で利用させる案が提案されました。AOT に優しいソース生成を保ちつつ、呼び出し側をきれいに保ちます。"
pubDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
  - "system-text-json"
  - "aot"
lang: "ja"
translationOf: "2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics"
translatedBy: "claude"
translationDate: 2026-04-29
---

過去 24 から 48 時間で .NET 関連の興味深い議論のひとつは、シンプルな問いでした。なぜ `System.Text.Json` のソース生成は呼び出し側で今も「手作業」のように感じられるのか。

きっかけは 2026 年 2 月 7 日のスレッドで、非常に C# 14 らしい発想のアプローチが提案されました。それは、`JsonSerializer.Serialize` と `JsonSerializer.Deserialize` の呼び出しを書き換えて、生成された `JsonSerializerContext` を自動で使わせる **インターセプター** です。

## エルゴノミクスのギャップ: コンテキストは動くが、コード全体に広がる

**.NET 10** でトリミングの安全性と予測可能なパフォーマンスを求めるなら、ソース生成は強力な選択肢です。摩擦は、コンテキストをあちこちに通して回ることになる点です。

```csharp
using System.Text.Json;

var foo = JsonSerializer.Deserialize<Foo>(json, FooJsonContext.Default.Foo);
var payload = JsonSerializer.Serialize(foo, FooJsonContext.Default.Foo);
```

明示的で正しいですが、ノイズが多くなります。そのノイズはシリアライズの配線を気にするべきでないアプリ層にまで漏れがちです。

## インターセプターベースの書き換えの姿

考え方としては、呼び出し側をきれいなままにします。

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json);
```

そして (コンパイル時に) インターセプターが、手で書いたであろうコンテキストベースの呼び出しに書き換えます。

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json, GlobalJsonContext.Default.Foo);
```

オプションのプロファイルが複数ある場合、インターセプターは正しいコンテキストインスタンスへの決定的なマッピングを必要とします。「ここが難しい」部分はそこから始まります。

## 成否を分ける制約 (AOT が裁判官)

これが単に良いアイデアにとどまらないためには、ソース生成が最も重要な環境で生き残らなければなりません。

- **NativeAOT とトリミング**: 書き換えがうっかりリフレクションベースのフォールバックを再導入してはなりません。
- **オプションの同一性**: 与えられた `JsonSerializerOptions` に対してコンテキストを選ぶ安定した方法が必要です。実行時に変化するオプションは相性が良くありません。
- **部分コンパイル**: インターセプターはプロジェクト、テストアセンブリ、インクリメンタルビルドをまたいで一貫した挙動をしなければなりません。

これらの制約を満たせば、稀な勝利が得られます。**AOT に優しいパイプラインを維持しつつ**、コードの大部分から「コンテキストの配線」を取り除けます。

今日の実用的な学び: たとえインターセプターが議論されたそのままの形で実現されなくても、これは .NET 開発者がソース生成まわりのエルゴノミクス向上を望んでいるという強いシグナルです。今後のツール、アナライザー、フレームワークパターンはその方向に動くと期待します。

ソース:

- [Reddit のスレッド](https://www.reddit.com/r/csharp/comments/1qyaviv/interceptors_for_systemtextjson_source_generation/)
- [System.Text.Json ソース生成のドキュメント](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation)
