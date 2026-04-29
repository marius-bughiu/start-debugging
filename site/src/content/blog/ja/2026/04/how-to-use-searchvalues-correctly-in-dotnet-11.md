---
title: ".NET 11 で SearchValues<T> を正しく使う方法"
description: "SearchValues<T> は IndexOfAny の 5 倍から 250 倍速いですが、ランタイムが期待する使い方をした場合に限ります。static としてキャッシュするルール、StringComparison の落とし穴、使うべきでない場面、そして誰も書いていない IndexOfAnyExcept による反転トリックを解説します。"
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "csharp"
  - "searchvalues"
lang: "ja"
translationOf: "2026/04/how-to-use-searchvalues-correctly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

`SearchValues<T>` は `System.Buffers` にあります。事前計算済みの不変な値の集合で、`ReadOnlySpan<T>` の拡張メソッドである `IndexOfAny`、`IndexOfAnyExcept`、`ContainsAny`、`LastIndexOfAny`、`LastIndexOfAnyExcept` と一緒に使います。利用の 90% で間違えているルールはシンプルです。`SearchValues<T>` のインスタンスを 1 度だけ作り、`static readonly` フィールドに格納して再利用すること。ホットメソッド内で構築すると、すべてのコスト（SIMD 戦略の選択、bitmap のアロケーション、文字列オーバーロードのための Aho-Corasick オートマトン）を負ったまま、利得をすべて失います。もう 1 つのルールは、1 つや 2 つの値の集合に対して `SearchValues<T>` を持ち出さないこと。`IndexOf` は些末なケース向けにすでにベクトル化されており、そちらの方が速いです。

この記事は x64 と ARM64 上の .NET 11 (preview 4) を対象にしています。`SearchValues.Create` の byte と char のオーバーロードは .NET 8 から安定しています。文字列のオーバーロード (`SearchValues<string>`) は .NET 9 から安定しており、.NET 10 と .NET 11 でも変更はありません。以下で説明する挙動は Windows、Linux、macOS で同一です。SIMD コードパスはプラットフォーム間で共有され、AVX2 / AVX-512 / NEON が使えない場所だけスカラーコードにフォールバックします。

## SearchValues が存在する理由

`ReadOnlySpan<char>.IndexOfAny('a', 'b', 'c')` は単発呼び出しです。ランタイムは次の呼び出しが同じ集合を使うか別の集合を使うかを知ることができないので、毎回その場で検索戦略を選ぶしかありません。3 文字なら JIT は手作業で調整したベクトル化パスをインライン化するため、オーバーヘッドは小さいですが、集合が 4 つや 5 つの要素を超えた瞬間、`IndexOfAny` は文字ごとにハッシュセットメンバーシップを判定する汎用ループへフォールバックします。このループは短い入力には問題ありませんが、長い入力では悲惨です。

`SearchValues<T>` は計画ステップを検索ステップから切り離します。`SearchValues.Create(needles)` を呼ぶと、ランタイムは検索対象を 1 度だけ調べます。連続範囲か？ 疎な集合か？ プレフィックスを共有しているか（文字列オーバーロードの場合）？ そして複数の戦略 (`Vector256` シャッフルを使った bitmap、`IndexOfAnyAsciiSearcher`、`ProbabilisticMap`、`Aho-Corasick`、`Teddy`) のうち 1 つを選び、メタデータをインスタンスに焼き付けます。そのインスタンスに対する以後の呼び出しは計画をスキップして、選ばれたカーネルへ直接ディスパッチされます。12 要素の集合では、対応する `IndexOfAny` のオーバーロードと比べて典型的に 5 倍から 50 倍の速度向上が見られます。5 つ以上の検索対象を持つ文字列集合では、手書きの `Contains` ループに対して 50 倍から 250 倍の差が出ます。

この非対称性が要点です。計画は高価で、検索は安価。呼び出しごとに新しい `SearchValues<T>` を構築すると、計画コストを償却せずに払い続けることになります。

## static としてキャッシュするルール

これが正典のパターンです。`static readonly` に注目してください。

```csharp
// .NET 11, C# 14
using System.Buffers;

internal static class CsvScanner
{
    private static readonly SearchValues<char> Delimiters =
        SearchValues.Create(",;\t\r\n\"");

    public static int FindNextDelimiter(ReadOnlySpan<char> input)
    {
        return input.IndexOfAny(Delimiters);
    }
}
```

毎週 PR で見かける誤ったバージョン:

```csharp
// .NET 11 -- BROKEN, do not ship
public static int FindNextDelimiter(ReadOnlySpan<char> input)
{
    var delims = SearchValues.Create(",;\t\r\n\"");
    return input.IndexOfAny(delims);
}
```

無害そうに見えます。しかし呼び出しごとにアロケートし、呼び出しごとにプランナーが走ります。`BenchmarkDotNet` を使って .NET 11 preview 4 で計測したベンチマーク:

```
| Method                     | Mean       | Allocated |
|--------------------------- |-----------:|----------:|
| StaticSearchValues_1KB     |    71.4 ns |       0 B |
| RebuiltSearchValues_1KB    |   312.0 ns |     208 B |
| LoopWithIfChain_1KB        |   846.0 ns |       0 B |
```

アロケーションの方がより危険な半分です。ホットパス上に置かれた誤った `Create` は、LOH 近傍のごみを継続的に生み出す流れになります。秒間 10 万リクエストのサービスでは、再利用すべき値のために GC を圧迫する分が 1 分あたり数ギガバイトに達します。

検索対象が起動時のユーザー入力で `static readonly` を使えない場合は、初期化時に 1 度だけインスタンスを構築し、シングルトンサービスに保持してください。

```csharp
// .NET 11, C# 14
public sealed class TokenScanner
{
    private readonly SearchValues<string> _tokens;

    public TokenScanner(IEnumerable<string> tokens)
    {
        _tokens = SearchValues.Create(tokens.ToArray(), StringComparison.Ordinal);
    }

    public bool ContainsAny(ReadOnlySpan<char> input) => input.ContainsAny(_tokens);
}
```

DI ではシングルトンとして登録してください。トランジェントとして登録してはいけません。トランジェントは、呼び出しごとに再構築するのと同じ罠を、余計な手順を加えてもう一度仕掛けます。

## StringComparison の落とし穴

`SearchValues<string>` (.NET 9 で追加された複数文字列オーバーロード) は `StringComparison` 引数を取ります。

```csharp
private static readonly SearchValues<string> Forbidden =
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);
```

サポートされる値は 4 つだけです。`Ordinal`、`OrdinalIgnoreCase`、`InvariantCulture`、`InvariantCultureIgnoreCase`。`CurrentCulture` または `CurrentCultureIgnoreCase` を渡すと、コンストラクターは起動時に `ArgumentException` をスローします。これは正しい挙動です。カルチャに敏感な複数文字列検索は、現在のスレッドのカルチャを尊重するために呼び出しごとにアロケートする必要があり、それでは事前計算の意味がなくなります。

帰結は 2 つ:

- ASCII データに対しては常に `Ordinal` または `OrdinalIgnoreCase` を使ってください。Invariant 系のバリアントより 5 倍から 10 倍速く、ランタイムは生バイトを処理する Teddy カーネルにディスパッチします。Invariant 系は ASCII のみの入力に対しても Unicode のケース畳み込みのコストを払います。
- ロケール正しい大文字小文字非依存（トルコ語のドット付き I、ギリシャ語のシグマ）が必要なら、`SearchValues<string>` はあなたのツールではありません。`string.Contains(needle, StringComparison.CurrentCultureIgnoreCase)` をループで呼んでコストを受け入れてください。ロケール依存の文字列マッチングは本質的にベクトル化できません。

`char` と `byte` のオーバーロードには `StringComparison` パラメーターはありません。完全一致でマッチします。`SearchValues<char>` で大文字小文字を区別しない ASCII マッチングが欲しいなら、両方のケースを集合に含めてください。

```csharp
// case-insensitive ASCII vowels in .NET 11, C# 14
private static readonly SearchValues<char> Vowels =
    SearchValues.Create("aeiouAEIOU");
```

入力に対して先に `ToLowerInvariant` を呼ぶより安価です。

## 集合メンバーシップ: SearchValues.Contains はあなたが思っているものではない

`SearchValues<T>` は `Contains(T)` メソッドを公開しています。

```csharp
SearchValues<char> set = SearchValues.Create("abc");
bool isInSet = set.Contains('b'); // true
```

注意して読んでください。これは単一の値が集合に含まれるかをチェックします。`HashSet<T>.Contains` の等価物であって、部分文字列検索ではありません。`string.Contains` の意味論を期待してこれに手を出し、「文字 'h' が禁止トークン集合に含まれるか」を聞くコードを「入力に禁止トークンのいずれかが含まれるか」のつもりで出荷してしまう人がいます。このタイプのバグは型チェックを通り、実行されます。

「入力にこれらのいずれかが含まれるか」を問う正しい呼び出し:

- char 集合に対しては `ReadOnlySpan<char>.ContainsAny(SearchValues<char>)`。
- string 集合に対しては `ReadOnlySpan<char>.ContainsAny(SearchValues<string>)`。
- byte 集合に対しては `ReadOnlySpan<byte>.ContainsAny(SearchValues<byte>)`。

`SearchValues<T>.Contains(value)` は、本当に単一の値があって集合参照が欲しいときだけ使ってください。たとえば独自トークナイザーの内側で、現在の文字が区切り文字かどうかを判定する場合などです。

## IndexOfAnyExcept による反転トリック

`IndexOfAnyExcept(SearchValues<T>)` は、集合に**含まれない**最初の要素のインデックスを返します。先頭の空白、パディング、ノイズの後の意味のある内容の開始位置を、1 回の SIMD パスで見つける方法です。

```csharp
// .NET 11, C# 14
private static readonly SearchValues<char> WhitespaceAndQuotes =
    SearchValues.Create(" \t\r\n\"'");

public static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> input)
{
    int firstReal = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    return firstReal < 0 ? ReadOnlySpan<char>.Empty : input[firstReal..];
}
```

これは長い先頭ランを持つ入力で `string.TrimStart(' ', '\t', '\r', '\n', '"', '\'')` に勝ちます。`TrimStart` は集合が 4 つを超えると文字単位のループにフォールバックするからです。「64 個のインデント空白を取り除く」という典型ケースで 4 倍から 8 倍の速度向上を期待できます。

`LastIndexOfAnyExcept` は右側の対応物です。両方を組み合わせるとベクトル化された `Trim` が手に入ります。

```csharp
public static ReadOnlySpan<char> TrimBoth(ReadOnlySpan<char> input)
{
    int start = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    if (start < 0) return ReadOnlySpan<char>.Empty;

    int end = input.LastIndexOfAnyExcept(WhitespaceAndQuotes);
    return input[start..(end + 1)];
}
```

スライス 2 回、SIMD スキャン 2 回、アロケーションはゼロです。素朴な `string.Trim(charsToTrim)` オーバーロードは、入力にトリムが不要な場合でも .NET 11 では内部的に一時配列をアロケートします。

## char より byte を使うべきとき

プロトコル解析 (HTTP、JSON、ASCII CSV、ログ行) では入力はしばしば `ReadOnlySpan<byte>` であって `ReadOnlySpan<char>` ではありません。ASCII バイト値から `SearchValues<byte>` を構築する方が、最初に UTF-16 へデコードするよりも顕著に高速です。

```csharp
// .NET 11, C# 14 -- HTTP header value sanitiser
private static readonly SearchValues<byte> InvalidHeaderBytes =
    SearchValues.Create([(byte)'\0', (byte)'\r', (byte)'\n', (byte)'\t']);

public static bool IsValidHeaderValue(ReadOnlySpan<byte> value)
{
    return value.IndexOfAny(InvalidHeaderBytes) < 0;
}
```

byte パスは AVX2 サイクルあたり 32 バイトを引き込みます。char では 16 文字です。AVX-512 対応ハードウェアでは 64 バイト対 32 文字。ASCII データなら UTF-16 への迂回をスキップしてスループットを倍増できます。

127 を超える `char` コードポイントを誤って使ってしまった場合、コンパイラーは警告しません。ですが SearchValues プランナーは、char 集合が混在 bidi プロパティを持つ BMP-ASCII 範囲を超えるとき、意図的に低速パスを発行します。ベンチマークが「期待よりも遅くなった」と示すなら、ASCII 専用のはずだった集合に非 ASCII 文字を入れていないか確認してください。

## SearchValues を使うべきでないとき

正解が「気にしないで」になるケースの短いリスト:

- **検索対象が 1 つ**。`span.IndexOf('x')` はすでにベクトル化されています。`SearchValues.Create("x")` はオーバーヘッドを追加するだけです。
- **char の検索対象が 2 つか 3 つで、呼び出しが稀**。`span.IndexOfAny('a', 'b', 'c')` で問題ありません。損益分岐点は char で約 4 つ、string で約 2 つです。
- **入力が 16 要素未満**。SIMD カーネルにはセットアップコストがあります。8 文字のスパンならスカラー比較が勝ちます。
- **検索対象が呼び出しごとに変わる**。`SearchValues` の意味全体が償却にあります。集合が呼び出しごとのユーザー入力なら、`IndexOfAny` のオーバーロードか `RegexOptions.Compiled` 付きの `Regex` のままにしてください。
- **グループキャプチャや後方参照が必要**。`SearchValues` はリテラルマッチングだけを行います。regex の代替ではなく、より高速な `Contains` です。

## アロケーションのない静的初期化

`Create` のオーバーロードは `ReadOnlySpan<T>` を受け取ります。文字列リテラル (.NET 7 以降、C# コンパイラーは `RuntimeHelpers.CreateSpan` を介して文字列リテラルを `ReadOnlySpan<char>` に変換します)、配列、コレクション式のいずれも渡せます。3 つとも同じ `SearchValues<T>` インスタンスを生成し、文字列リテラル形式に対してコンパイラーは中間配列を生成しません。

```csharp
// .NET 11, C# 14 -- all three are equivalent in cost at runtime
private static readonly SearchValues<char> A = SearchValues.Create("abc");
private static readonly SearchValues<char> B = SearchValues.Create(['a', 'b', 'c']);
private static readonly SearchValues<char> C = SearchValues.Create(new[] { 'a', 'b', 'c' });
```

文字列オーバーロードでは、入力は配列 (`string[]`) または配列を狙うコレクション式である必要があります。

```csharp
private static readonly SearchValues<string> Tokens =
    SearchValues.Create(["select", "insert", "update"], StringComparison.OrdinalIgnoreCase);
```

コンストラクターは検索対象を内部状態にコピーするので、ソース配列は保持されません。構築後にソース配列を変更しても `SearchValues<string>` インスタンスには何の影響もありません。これはキャッシュ済みパターンを持つ `Regex` とは反対で、後者ではソース文字列が保持されます。

## ソースジェネレーターと相性の良いパターン

`partial` クラスとコードジェネレーター（自前または `System.Text.RegularExpressions.GeneratedRegex`）がある場合、生成出力の一部として `static readonly SearchValues<char>` フィールドを生成するのは綺麗なパターンです。トリム安全、AOT 安全、リフレクションなし、呼び出しごとのヒープアロケーションもありません。

```csharp
// .NET 11, C# 14 -- hand-rolled equivalent of what a generator would emit
internal static partial class IdentifierScanner
{
    private static readonly SearchValues<char> NonIdentifierChars =
        SearchValues.Create(GetNonIdentifierAscii());

    private static ReadOnlySpan<char> GetNonIdentifierAscii()
    {
        // Build a 96-element set of non-[A-Za-z0-9_] ASCII chars at type init.
        Span<char> buffer = stackalloc char[96];
        int i = 0;
        for (int c = ' '; c <= '~'; c++)
        {
            if (!(char.IsAsciiLetterOrDigit((char)c) || c == '_'))
                buffer[i++] = (char)c;
        }
        return buffer[..i].ToArray();
    }
}
```

`stackalloc` は 1 度だけ実行されます。`static readonly` はランタイムの型初期化子によりちょうど 1 回初期化されるからです。`.ToArray()` は型の生存期間における唯一のアロケーションです。それ以降は、すべての検索がアロケーションフリーになります。

## Native AOT とトリム警告

`SearchValues<T>` は Native AOT と完全に互換です。内部にリフレクションはなく、ランタイムでの動的コード生成もありません。AOT で発行されたバイナリには JIT 版と同じ SIMD カーネルが含まれ、指定した対象 ISA に基づいて AOT コンパイル時に選択されます (`-r linux-x64` ではデフォルトでベースライン x64 と SSE2 + AVX2 パスが含まれます。`-p:TargetIsa=AVX-512` で AVX-512 まで拡張されます)。トリム警告はなく、`[DynamicallyAccessedMembers]` 属性も不要です。

`linux-arm64` 向けに発行すると、NEON カーネルが自動的に選択されます。同じソースが両方のターゲットへ条件付きコードなしでコンパイルされます。

## 関連する読み物

- [Span<T> と ReadOnlySpan<T> の使い分け](/2026/01/net-10-performance-searchvalues/) は、.NET 10 の時代の `SearchValues` の早期スナップショットを扱っています。SIMD の背景については参照してください。
- [BlockingCollection の代わりに Channels を使う](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は、ワーカーで入力をスキャンする際の正しい転送手段です。
- [.NET 11 で大きな CSV をメモリ不足にせず読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) はパーサーで区切り文字スキャンに `SearchValues<char>` を使っています。
- [.NET でファイルへの書き込み完了を検知する方法](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) は、上記の CSV スキャナーと組み合わせて inbox ファイルを消費する場面に自然にフィットします。

## 出典

- [`SearchValues<T>` リファレンス、MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues-1) -- `Create` の byte / char / string オーバーロードを含む正典の API 表面。
- [`SearchValues.Create(ReadOnlySpan<string>, StringComparison)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues.create) -- サポートされる 4 つの `StringComparison` 値と、それ以外でスローされる `ArgumentException` を文書化しています。
- [.NET runtime PR 90395 -- 初出の `SearchValues<T>`](https://github.com/dotnet/runtime/pull/90395) -- .NET 8 における byte と char オーバーロードの導入と SIMD 戦略テーブル。
- [.NET runtime PR 96570 -- `SearchValues<string>`](https://github.com/dotnet/runtime/pull/96570) -- .NET 9 における複数文字列の Aho-Corasick / Teddy カーネルの追加。
- [Boosting string search performance in .NET 8.0 with SearchValues, endjin](https://endjin.com/blog/2024/01/dotnet-8-searchvalues-string-search-performance-boost) -- char パスに関する最もきれいな外部ベンチマーク記事。
