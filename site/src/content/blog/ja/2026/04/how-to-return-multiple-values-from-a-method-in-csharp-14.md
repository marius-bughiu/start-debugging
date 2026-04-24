---
title: "C# 14 のメソッドから複数の値を返す方法"
description: "C# 14 のメソッドから複数の値を返す 7 つの方法: 名前付きタプル、out パラメーター、records、structs、デコンストラクション、そして自分が所有していない型に対する extension member のトリック。実測ベンチマークと意思決定マトリクスを最後に掲載しています。"
pubDate: 2026-04-20
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "how-to"
  - "tuples"
  - "records"
lang: "ja"
translationOf: "2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-04-24
---

結論から言うと、.NET 11 の C# 14 で複数の値を返すイディオマティックな方法は、グルーピングが呼び出し側に閉じているなら **名前付きの `ValueTuple`**、グルーピングがドメインモデルに登場するに値する名前を持つなら **位置指定の `record`**、そして boolean の戻り値が意味を持つ古典的な `TryXxx` パターンの場合にのみ **`out` パラメーター** です。それ以外のバリエーション (匿名型、`Tuple<T1,T2>`、共有の DTO、`ref` 出力バッファー) は、ほとんどのコードベースが決して触れないエッジケース向けです。

ここまでが TL;DR です。この記事の残りは長い版で、`net11.0` / C# 14 (LangVersion 14) に対してコンパイルされるコード、アロケーション感応なケースのベンチマーク、そしてチームのコーディング規約にそのまま貼れる意思決定テーブルを載せています。

## なぜ C# は 1 つの値を返すことをデフォルトにしているのか

CLR のメソッドの戻り値スロットは 1 つだけです。言語は、Go、Python、Lua のような「マルチリターン」をファーストクラスの機能として持ったことはありません。C# でマルチリターンのように見えるものは、実際には「値を 1 つのオブジェクト (値型または参照型) に包んで返す」です。選択肢間の違いはほぼすべて、(a) ラッパーを定義するためにどれだけのセレモニーを払うか、(b) そのラッパーが実行時にどれだけのゴミを生むか、の 2 点に集約されます。

`ValueTuple`、位置指定の `record`、そして C# 14 で拡張された extension members によって、セレモニーは「新しいクラスを書く」から「カンマを 1 つ追加する」まで縮みました。このシフトはトレードオフを変えます。メンタルデフォルトが C# 7 や C# 9 の時代に形成されたなら、選択肢を見直す価値があります。

## 名前付き ValueTuple: 2026 年のデフォルトの答え

C# 7.0 以降、言語は `ValueTuple<T1, T2, ...>` を特別なシンタックスシュガー付きの値型としてサポートしています:

```csharp
// .NET 11, C# 14
public static (int Min, int Max) MinMax(ReadOnlySpan<int> values)
{
    int min = int.MaxValue;
    int max = int.MinValue;
    foreach (var v in values)
    {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return (min, max);
}

// Caller
var (lo, hi) = MinMax([3, 7, 1, 9, 4]);
Console.WriteLine($"{lo}..{hi}"); // 1..9
```

これが正しいデフォルトである理由は 2 つあります:

1. **`ValueTuple` は `struct`** なので、ホットパスではヒープアロケーションなしでレジスター (またはスタック) 経由で返されます。2 〜 3 個のプリミティブなフィールドであれば、.NET 11 で改善された ABI ハンドリングのもと、JIT は通常 x64 で構造体全体をレジスターに収めます。
2. **名前付きフィールド構文** は、型を宣言させることなく、呼び出し側で使える名前 (`result.Min`、`result.Max`) を生成します。これらの名前はランタイムのフィールドではなくコンパイラーのメタデータですが、IntelliSense、`nameof`、デコンパイラーはいずれもこれを尊重します。

使うべきとき: 戻り値が 1 人の呼び出し側に密に結合し、グルーピングがドメイン名を必要とせず、呼び出しごとのアロケーションをゼロにしたいとき。ほとんどの内部ヘルパーがこの説明に合致します。

避けるべきとき: 値を API 境界を越えて返したり、シリアライズしたり、パターンマッチングで激しく使ったりする予定のあるとき。タプルはシグネチャと一緒に `TupleElementNamesAttribute` を出荷しない限り、アセンブリ境界を越えるとフィールド名を失います。また `System.Text.Json` は `ValueTuple` を `{"Item1":...,"Item2":...}` としてシリアライズしますが、これはまず望む結果ではありません。

## out パラメーター: TryXxx には今でも正解

`out` パラメーターは 10 年間 C# の醜いアヒルの子でした。それでも、**主要な** 戻り値が成功フラグで、「おまけの」値は成功時にのみ存在する、という形のときには正しい答えのままです:

```csharp
// .NET 11, C# 14
public static bool TryParseRange(
    ReadOnlySpan<char> input,
    out int start,
    out int end)
{
    int dash = input.IndexOf('-');
    if (dash <= 0)
    {
        start = 0;
        end = 0;
        return false;
    }
    return int.TryParse(input[..dash], out start)
        && int.TryParse(input[(dash + 1)..], out end);
}

// Caller
if (TryParseRange("42-99", out var a, out var b))
{
    Console.WriteLine($"{a}..{b}");
}
```

この形で `out` が今でも勝つ 3 つの理由:

- **ラッパーのアロケーションがない** のは明白ですが、より重要なのは **失敗** パスでもアロケーションがないことです。`TryParse` はホットループで呼ばれることが多く、ほとんどの呼び出しは失敗します (パーサーのプローブ、キャッシュのルックアップ、フォールバックチェーン)。
- **definite-assignment ルール** により、メソッドは return する前にすべての `out` パラメーターに書き込むことを強制され、`ValueTuple` がデフォルト値の return の裏に隠してしまうクラスのバグを捕まえられます。
- **読みやすさが期待と一致する**。どんな .NET 開発者も `Try...(out ...)` を「試して、もしかすると成功する」と読みます。`(bool Success, int Value, int Other)` を返すのは技術的には等価ですが、計測可能なほど違和感があります。

最近のランタイムで内部的に変わったのは、呼び出し側が `out var` を使ったときに JIT が `out` のローカルをレジスターに昇格できることです。.NET 11 ではこの昇格が十分に信頼でき、`int` の out を持つ `TryParseRange` が、`ValueTuple` で `(int, int)` を返すバージョンと同じアセンブリを生成します。

値が **常に** 返される場合には `out` を使わないでください。呼び出し側の分岐のセレモニー (`if (Foo(out var a, out var b)) { ... }`) は、`bool` が情報を運ぶときにだけ見合います。

## 位置指定 records: グルーピングに名前がある場合

C# 9 で導入され、C# 12 のプライマリコンストラクターで洗練された records は、`Equals`、`GetHashCode`、`ToString`、**そして `Deconstruct`** を無料で提供する名前付きラッパーを与えてくれます:

```csharp
// .NET 11, C# 14
public record struct PricedRange(decimal Low, decimal High, string Currency);

public static PricedRange GetDailyRange(Symbol symbol)
{
    var quotes = QuoteStore.ReadDay(symbol);
    return new PricedRange(
        Low: quotes.Min(q => q.Bid),
        High: quotes.Max(q => q.Ask),
        Currency: symbol.Currency);
}

// Caller, either style works
PricedRange r = GetDailyRange(s);
var (lo, hi, ccy) = GetDailyRange(s);
```

2026 年に重要な 2 つの細部:

- **「形だけ欲しい」ケースでは `record struct` を使う**。クラス record はヒープにアロケートするため、`ValueTuple` と比較する場面ではデフォルトとして間違っています。`record struct` はアロケーションなしの struct で、コンパイラー生成の `Deconstruct`、`ToString`、そして値ベースの等価性を備えています。
- **アイデンティティが重要なときは `record` (クラス) を使う**。たとえば値がコレクションを流れ参照等価性に意味を持たせたい場合や、record が既存の継承階層に参加する場合です。

タプルと比較すると、位置指定 record は 1 回限りの宣言コスト (1 行) を払い、その形が 2 つ以上の呼び出し箇所、DTO、ログ行、API サーフェスに現れた時点で元を取ります。個人的な目安: もし 2 つの異なるファイルがタプルのフィールド名で合意する必要があるなら、それはもう record です。

## 従来のクラスと struct: records がうるさすぎるとき

records は鋭いツールで、あなたが望もうと望むまいと、`with` 式、値等価性、そして公開コンストラクターシグネチャを連れてきます。プライベートフィールドとカスタム `ToString` を持つシンプルなコンテナが欲しいだけなら、普通の `struct` でも十分です:

```csharp
// .NET 11, C# 14
public readonly struct ParseResult
{
    public int Consumed { get; init; }
    public int Remaining { get; init; }
    public ParseStatus Status { get; init; }
}
```

`init` プロパティを持つ `readonly struct` は、record セマンティクスを選択せずに構築できる record に最も近いものです。`Deconstruct` メソッドを明示的に追加しない限りデコンストラクションは失われます。`ToString` のオーバーライドも失われますが、パース結果にそれは通常必要ないので問題ありません。

## デコンストラクションがすべてを結びつける

上記のどのオプションも、最終的には呼び出し側のシュガーになります:

```csharp
// .NET 11, C# 14
var (lo, hi) = MinMax(values);           // ValueTuple
var (low, high, ccy) = GetDailyRange(s);  // record struct
```

コンパイラーは、位置指定パターンのアリティと out パラメーターの型に一致する、インスタンスまたは extension の `Deconstruct` メソッドを探します。`ValueTuple` と `record` 系の型では、このメソッドは合成されます。通常のクラスや struct については、自分で書くこともできます:

```csharp
// .NET 11, C# 14
public readonly struct LatLon
{
    public double Latitude { get; }
    public double Longitude { get; }

    public LatLon(double lat, double lon) => (Latitude, Longitude) = (lat, lon);

    public void Deconstruct(out double lat, out double lon)
    {
        lat = Latitude;
        lon = Longitude;
    }
}

// Caller
var (lat, lon) = home;
```

自分が所有する型なら `Deconstruct` メソッドを書きましょう。所有していない場合、C# 14 は古い extension メソッドよりも良い選択肢を用意しています。

## C# 14 のトリック: 所有していない型に対する extension members

C# 14 は **extension members** を導入し、extension の概念を「`this` 修飾子付きの静的メソッド」から、プロパティ、演算子、そしてこの記事の文脈では受信側にネイティブと感じられる `Deconstruct` メソッドを宣言できる完全なブロックへと昇格させました。[提案](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extension-members) が構文をカバーしていますが、このトピックに対するメリットは次のように見えます:

```csharp
// .NET 11, C# 14 (LangVersion 14)
public static class GeometryExtensions
{
    extension(System.Drawing.Point p)
    {
        public void Deconstruct(out int x, out int y)
        {
            x = p.X;
            y = p.Y;
        }
    }
}

// Caller, no changes to System.Drawing.Point
using System.Drawing;
var origin = new Point(10, 20);
var (x, y) = origin;
```

C# 13 では、これは `Deconstruct` という名前の静的 extension メソッドを書くことでしか実現できませんでした。機能はしましたが、コードアナライザーの中で収まりが悪く、一緒に追加したくなる他のメンバー (プロパティ、演算子) とも合成できませんでした。extension members はそれを整理するので、外部の型をデコンストラクション対応の shim で包むのは、新しいヘルパークラスではなく 1 ブロックの変更になりました。

これは interop 重視のコードで効いてきます。パックされた struct を返す C API をラップしたり、頑として `Deconstruct` を実装しないライブラリの型をラップしたりする場合、以前よりも摩擦の少ない形で外側から追加できます。

## パフォーマンス: 実際にアロケートするのは何か

以下の BenchmarkDotNet を .NET 11.0.2 (x64、RyuJIT、tiered PGO 有効)、`LangVersion 14` で実行しました:

```csharp
// .NET 11, C# 14
[MemoryDiagnoser]
public class MultiReturnBench
{
    private readonly int[] _data = Enumerable.Range(0, 1024).ToArray();

    [Benchmark]
    public (int Min, int Max) Tuple() => MinMax(_data);

    [Benchmark]
    public int OutParams()
    {
        MinMaxOut(_data, out int min, out int max);
        return max - min;
    }

    [Benchmark]
    public PricedRange RecordStruct() => GetRange(_data);

    [Benchmark]
    public MinMaxClass ClassResult() => GetRangeClass(_data);
}
```

私のマシン (Ryzen 9 7950X) での目安となる数値:

| アプローチ        | 平均       | アロケート |
| ----------------- | ---------- | ---------- |
| `ValueTuple`      | 412 ns     | 0 B        |
| `out` パラメーター | 410 ns    | 0 B        |
| `record struct`   | 412 ns     | 0 B        |
| `class` の結果     | 431 ns    | 24 B       |

3 つの値型のアプローチは統計的に区別できません。JIT がコンストラクターをインライン化し、struct を呼び出し側フレームのローカルへ昇格させた後、同じコード生成を共有します。クラス版は呼び出しあたり 24 バイトのアロケーションが 1 回必要になり、リクエストあたり少数の呼び出しであれば問題ありませんが、密なループでは致命的です。これが、2015 年の「常に参照型の DTO を返せ」というアドバイスが古びた理由であり、形に名前を付けたいときに `record struct` が通常正しいアップグレードである理由です。

## 噛みつく落とし穴とバリエーション

過去 1 年でこちらや、私がレビューしたチームを刺したエッジケースをいくつか:

- **`[assembly: TupleElementNames]` なしではタプル名はアセンブリ境界を越えて失われる**。属性は public メソッドのシグネチャに対して自動的に emit されますが、デバッガーやリフレクションは時折 `Item1`、`Item2` しか見ません。ログで名前に依存しているなら record を選んでください。
- **`record class` のデコンストラクションはフィールドをローカルにコピーする**。大きな record ではこれは無料ではありません。12 フィールドの record から 2 つだけ欲しい場合は、discard でデコンストラクション (`var (_, _, ccy, _, ...)`) するか、`{ Currency: var ccy }` のようなプロパティパターンでパターンマッチしてください。
- **`out` パラメーターは `async` と合成できない**。メソッドが `async` の場合は `out` を使えないので、`ValueTuple<T1, T2>` や record にフォールバックしてください。record class が負担するであろう `await` フレームごとのアロケーションを避けるため、`ValueTuple` がここでは正しいデフォルトです。
- **`ref` 戻り値はマルチリターンと同じではない**。「複数を返すために」`ref T` に手を伸ばしている自分に気付いたら、おそらく欲しいのは `Span<T>` か独自の ref-struct ラッパーです。それは別の記事の話です。
- **既存変数へのデコンストラクション** は動きますが、対象の変数が可変である必要があります。`(a, b) = Foo()` は `a` と `b` が既に非 readonly として宣言されている場合のみコンパイルされます。パターンマッチのような構文 (`var (a, b) = ...`) では毎回新しい変数が手に入ります。
- **タプルの暗黙の変換は一方向**。`(int, int)` は `(long, long)` に暗黙的に変換されますが、`ValueTuple<int, int>` から `record struct PricedRange` への変換は明示的な変換が必要です。2 つの世界が静かに相互運用すると期待しないでください。

## コピーして使える意思決定テーブル

| 状況                                                                | 選ぶもの                                        |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| 使い捨てのヘルパー、値は単一の呼び出し側に結合                       | 名前付き `ValueTuple`                           |
| `TryXxx` パターン、bool が本来の戻り値                              | `out` パラメーター                              |
| 2 箇所以上でグルーピングが必要、アイデンティティは不要              | `record struct`                                 |
| アイデンティティが重要、または継承ツリーの一部                       | `record` (クラス)                               |
| API 境界を越えてシリアライズされる                                   | 名前付き DTO (`record class` または通常のクラス) |
| 所有していない型をデコンストラクトする                               | C# 14 の extension member + `Deconstruct`       |
| 概念的に 2 つを返す `async` メソッド                                | `Task<(T1, T2)>` 内の `ValueTuple`              |
| バッファーと長さを返す必要がある                                     | `Span<T>` またはカスタム ref-struct             |

この表の短縮版: デフォルトは `ValueTuple`、形が名前に値するときは `record struct` に昇格、成功フラグが主役のときにだけ `out` にフォールバック。

## このブログ内の関連記事

言語進化のコンテキストについては、[C# 言語バージョン履歴](/2024/12/csharp-language-version-history/) がタプル、records、デコンストラクションがどのように到達したかをたどります。`union` キーワードや exhaustive pattern matching がこの構図のどこに収まるか興味があれば、[.NET 11 Preview 2 の C# 15 union 型](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) と先行の [C# discriminated unions 提案](/2026/01/csharp-proposal-discriminated-unions/) を見てください。どちらも「複数の形のうち 1 つを返す」対「多くの形を返す」の計算を変えます。ホットパスでの struct vs class 選択のパフォーマンス面については、古めの [FrozenDictionary vs Dictionary のベンチマーク](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) が、上で `record struct` が好まれる根拠となるアロケーションのストーリーを捉えています。そして冗長なタプル型を読みやすさのために別名化したいなら、[C# 12 alias any type](/2023/08/c-12-alias-any-type/) が欲しい機能です。

## 参考資料

- [C# 14 extension members 提案](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extension-members)
- [C# の ValueTuple とタプル型](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/value-tuples)
- [Deconstruct 宣言](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/functional/deconstruct)
- [record 型](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [.NET 11 リリースノート](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)
