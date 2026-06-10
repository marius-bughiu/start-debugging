---
title: ".NET 11 Preview 5 で System.Text.Json がついに JSON Lines を書き出せるようになりました"
description: ".NET 11 Preview 5 は topLevelValues: true 付きの JsonSerializer.SerializeAsyncEnumerable を追加し、System.Text.Json が JSONL を読むだけでなくストリームで書き出せるようになりました。"
pubDate: 2026-06-10
tags:
  - "dotnet-11"
  - "csharp"
  - "system-text-json"
  - "serialization"
lang: "ja"
translationOf: "2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-10
---

[.NET 11 Preview 5 のライブラリノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md)は、.NET 9 以来開いたままだった隙間を埋めます。`System.Text.Json` が JSON Lines をデシリアライズするだけでなく、シリアライズできるようになりました。読み込み側は 2 バージョン前に登場しましたが書き込み側が欠けており、JSONL をエクスポートする人は 1 行につき 1 つのドキュメントを書き出すループを手作業で書く必要がありました。Preview 5 はそれを 1 回の呼び出しにします。

## JSON Lines とは実際には何か

JSON Lines (JSONL) は JSON 配列ではありません。1 行につき 1 つの独立した JSON 値であり、`\n` で区切られ、囲む角括弧もレコード間のカンマもありません。

```
{"Device":"kitchen","Celsius":21.4}
{"Device":"garage","Celsius":8.1}
```

この形式は、データをストリームし始めた途端にあらゆる場所で見られます。構造化されたログファイル、大規模なデータベースのエクスポート、そして LLM の学習・評価パイプラインで使われるバッチの入出力形式などです。利点は、ファイルを書き直さずにレコードを追記でき、全体を一度もメモリに保持することなく 1 行ずつファイルを処理できる点です。トップレベルの JSON 配列ではこれらは一切得られません。パーサーは閉じる `]` を見るまで、その配列が有効だと判断できないからです。

## 欠けていた書き込み側

`System.Text.Json` は .NET 9 で、`DeserializeAsyncEnumerable` が `topLevelValues` パラメーターを得たときに、複数のトップレベル値を*読む*ことを学びました。Preview 5 はシリアライザー側に対称的なオーバーロードを追加します。

```csharp
record SensorReading(string Device, double Celsius, DateTimeOffset At);

async IAsyncEnumerable<SensorReading> GetReadings()
{
    yield return new("kitchen", 21.4, DateTimeOffset.UtcNow);
    yield return new("garage", 8.1, DateTimeOffset.UtcNow);
}

await using var stream = File.Create("readings.jsonl");
await JsonSerializer.SerializeAsyncEnumerable(
    stream,
    GetReadings(),
    topLevelValues: true);
```

`topLevelValues: true` を指定すると JSONL が得られ、各項目が独自のルートドキュメントとして独自の行に書き出されます。既定値の `false` のままにすると、従来どおりの単一の JSON 配列になります。新しいオーバーロードは `Stream` と `PipeWriter` の両方を受け付け、AOT に優しくリフレクションを使わないシリアライズのために `JsonSerializerOptions` またはソース生成された `JsonTypeInfo<TValue>` のいずれかを受け取ります。

## きれいなラウンドトリップ

読み込み側はすでに存在するため、両方の半分がいま噛み合います。

```csharp
await using var input = File.OpenRead("readings.jsonl");

await foreach (var reading in JsonSerializer.DeserializeAsyncEnumerable<SensorReading>(
    input,
    topLevelValues: true))
{
    Console.WriteLine($"{reading.Device}: {reading.Celsius} C");
}
```

`GetReadings` が `IAsyncEnumerable<T>` であることに注目してください。シリアライザーは書き出しながらレコードを引き出します。`List<T>` を先に実体化することなく、データベースのカーソルや HTTP レスポンスから直接 JSONL ファイルへストリームできます。これこそが狙いです。何件のレコードを流しても、メモリ使用量は一定に保たれます。

これはまだプレビューなので、正確なシグネチャは 11 月のリリースまでに変わる可能性があります。しかし API の形は読み込み側を十分に反映しているため、これを前提に設計を始めても安全です。JSONL を出力するために `Utf8JsonWriter` と手書きの改行をつなぎ合わせてきたのであれば、これがそのすべてを置き換える呼び出しです。
