---
title: ".NET 11 で new Regex(...) を [GeneratedRegex] ソースジェネレーターに置き換える方法"
description: ".NET 11 で new Regex(pattern, RegexOptions.Compiled) を [GeneratedRegex] に変換する完全ガイドです。機械的な書き換え、部分メソッドと部分プロパティの違い、実測した起動時間とスループット、SYSLIB1040-1045 の診断、そしてジェネレーターが黙ってキャッシュ済み Regex にフォールバックする 2 つのパターンを扱います。"
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "source-generators"
  - "performance"
  - "native-aot"
lang: "ja"
translationOf: "2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

パターンがコンパイル時定数であれば、`new Regex(pattern, RegexOptions.Compiled)` を削除して、`Regex` を返す部分メソッドまたは部分プロパティに `[GeneratedRegex(pattern)]` を付けてください。ソースジェネレーターはビルド時に `Regex` 派生型を出力するため、ランタイムでの解析、最適化、reflection-emit のコストはゼロになり、コードはトリム可能で Native AOT にも適合し、デバッガーでマッチング処理の中に入っていけます。.NET 10.0.201 での私の計測では、生成されたマッチング処理は定常状態で `RegexOptions.Compiled` よりわずかに高速で (`IsMatch` 1 回あたり 35 ns 対 37 ns)、最初のマッチに到達するまでの時間はおよそ半分でした (コールドプロセスで 5.8 ms 対 12.2 ms)。

以下の内容は .NET 11 (執筆時点では Preview 6、SDK `11.0.100-preview.6`) と C# 14 を対象にしていますが、この属性とジェネレーターは .NET 7 以降安定しています。本記事の数値は SDK .NET 10.0.201 で計測しました。完全なランタイムを持っている最新の SDK がそれだからです。両者の間で API の形は変わっていません。

## 変換の手順、最初から最後まで

1. パターンがコンパイル時定数であることを確認します。ユーザー入力や設定から組み立てられている場合はここで終わりです。ジェネレーターは助けになりません。
2. その部分を含む型を `partial` にします。入れ子になっている外側のすべての型も同様です。
3. `static readonly Regex` フィールドを `static partial Regex` メソッド (または .NET 9 以降では get のみの `static partial Regex` プロパティ) に置き換えます。
4. パターン、オプション、タイムアウトがあればそれらを、そのメンバーに付けた `[GeneratedRegex]` 属性に移します。
5. オプションから `RegexOptions.Compiled` を外します。ジェネレーターはこれを無視します。
6. 呼び出し箇所を `s_myRegex.IsMatch(text)` から `MyRegex().IsMatch(text)` に書き換えます。
7. 生成されたファイルを開き、出力されたクラスの XML コメントを確認します。"Caches a `Regex` instance" と書かれていれば、ジェネレーターは諦めており、何も得られていません。

手順 7 は誰もが飛ばすところですが、この作業全体に意味があったかどうかを決めるのはここです。

## インタープリターと RegexOptions.Compiled のどちらにもコストがある理由

`new Regex("somepattern")` と書くと、パターンは解析されてツリーになり、ツリーが最適化され、その結果が正規表現インタープリター向けのオペコードとして書き出されます。マッチのたびにそのオペコードをたどることになります。どこでも動作し、構築も安価ですが、オペコードのディスパッチ 1 つ 1 つが CPU にとって予測すべき分岐になります。

`RegexOptions.Compiled` は、そのディスパッチをなくすために、はるかに大きな構築コストを払います。インタープリターと同じことをすべて行ったうえで、できあがったノードツリーを `System.Reflection.Emit` ベースのコンパイラーに通し、いくつかの `DynamicMethod` オブジェクトに IL を書き込みます。その IL は初回使用時になお JIT コンパイルが必要です。[Microsoft のドキュメント](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators)の表現を借りれば、`RegexOptions.Compiled` は「初回使用時のオーバーヘッドと、それ以降すべての使用時のオーバーヘッドとの間にある根本的なトレードオフ」を体現しています。さらに悪いことに、これはランタイムでのコード生成に依存します。そのため動的生成コードを禁止するプラットフォームや Native AOT のもとでは、`Compiled` は静かに何もしない指定になり、何の警告もないままインタープリターに戻ってしまいます。

ソースジェネレーターは、トレードオフの中で位置を動かすのではなく、トレードオフそのものを取り除きます。同じ解析と最適化の処理は行われますが、それが行われる場所はビルドマシンであり、アセンブリに入るのはコンパイラーが通常の IL に変換する通常の C# です。

## 書き換え

ほぼどのコードベースにもある形はこれです。

```csharp
// .NET 11, C# 14 - the pattern you are replacing
private static readonly Regex s_email = new(
    @"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$",
    RegexOptions.Compiled);

public static bool IsEmail(string s) => s_email.IsMatch(s);
```

そしてソース生成版の同等コードです。

```csharp
// .NET 11, C# 14
internal static partial class EmailRules
{
    [GeneratedRegex(@"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$")]
    private static partial Regex Email();

    public static bool IsEmail(string s) => Email().IsMatch(s);
}
```

注目すべき点が 3 つあります。クラスが `partial` になりました。`RegexOptions.Compiled` は消えました。ジェネレーターがこれを無視するため、残しておいても次に読む人を誤解させるだけだからです。そしてメソッドには本体がありません。宣言するのはあなた、実装するのはジェネレーターです。

自分でキャッシュする必要はありません。生成された実装は `static readonly` のシングルトンを返します。出力されたソースコードで自分の目で確認できます。

### メソッド呼び出しが不自然に読める場合の部分プロパティ

.NET 9 と C# 13 以降、`[GeneratedRegex]` は get のみの部分プロパティにも適用できます。正規表現が概念的に操作ではなく値である場合は、こちらのほうが自然に読めます。

```csharp
// .NET 11, C# 14 - requires C# 13 or later for partial properties
internal static partial class PhoneRules
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

プロパティは get のみである必要があります。セッターを付けるとジェネレーターに拒否されます。2 つの形式に動作上の違いはありません。どちらかを選んで一貫させてください。

### オプション、カルチャー、タイムアウト

この属性にはコンストラクターのオーバーロードが 5 つあり、オプション、カルチャー名、ミリ秒単位のマッチタイムアウトが順に重ねられます。

```csharp
// .NET 11, C# 14
[GeneratedRegex(
    pattern: "abc|def",
    options: RegexOptions.IgnoreCase | RegexOptions.Multiline,
    cultureName: "en-US",
    matchTimeoutMilliseconds: 1000)]
private static partial Regex AbcOrDef();
```

`cultureName` が意味を持つのは大文字小文字を区別しないマッチングのときだけです。`RegexOptions.CultureInvariant` を渡す場合はカルチャー名を一緒に渡してはいけません。そこでの失敗の出方は本当に紛らわしいので、後述の落とし穴を参照してください。

## 実際の数値

これは言い伝えを繰り返すのではなく、自分で計測しました。環境は .NET 10.0.201 上のコンソールアプリ、Windows 11 x64、Release ビルドで、上のアンカー付きメールパターンを 1,000 個の文字列と照合します。うち 3 分の 1 はマッチしません。エンジンは 3 種類、インタープリター、`RegexOptions.Compiled`、`[GeneratedRegex]` です。

定常状態のスループット、1 ラウンドあたり 200,000 回の `IsMatch` 呼び出し、全エンジンのウォームアップを 3 ラウンド完了させたあとの 10 ラウンド中のベストです。

| エンジン | 時間 | 1 回あたり |
| --- | --- | --- |
| インタープリター | 22.1 ms | 111 ns |
| `RegexOptions.Compiled` | 7.4 ms | 37 ns |
| `[GeneratedRegex]` | 7.0 ms | 35 ns |

コールドプロセスでの初回マッチです。何も事前に温まっていない状態にするため、各エンジンを別々のプロセスで計測しました。4 回の実行です。

| エンジン | 構築と初回 `IsMatch` の合計 |
| --- | --- |
| インタープリター | 3.7 から 4.0 ms |
| `RegexOptions.Compiled` | 12.0 から 12.7 ms |
| `[GeneratedRegex]` | 5.7 から 6.1 ms |

この 2 つの表は合わせて読んでください。`Compiled` と比べると、ジェネレーターはスループットで小さく、起動で大きく勝ちます。定常状態は同じで、そこに到達するまでの時間は半分未満です。インタープリターと比べると、スループットは 3.2 倍で、コールドプロセスでの追加起動コストが約 2 ms です。その大半は出力されたマッチング処理の JIT 時間であり、Native AOT のもとでは支払うべき JIT がなくなるため完全に消えます。

自分で計測する場合の注意点です。私の最初の試行ではインタープリターが `Compiled` の 2 倍速く見えましたが、これはあり得ません。原因は 3 つのエンジンが 1 つの計測メソッドを共有していたことで、最初に走ったエンジンが計測基盤自体の階層型 JIT のコストを吸収してしまっていました。どれか 1 つを計測する前に、すべてのエンジンをその計測基盤を通してウォームアップしてください。

## アナライザーはすでに知っている

これらの呼び出し箇所を手で探す必要はありません。.NET SDK には `SYSLIB1045` が入っています。ソース生成に変換可能な `Regex` の使用箇所を指摘する情報レベルのアナライザーで、変換を実行するコード修正も付いています。情報レベルということは IDE の電球にしか出ないということなので、レベルを上げてください。

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.SYSLIB1045.severity = warning
```

これで `dotnet build` が残りの呼び出し箇所をすべて列挙し、`dotnet format analyzers` で修正を一括適用できます。コードベースがきれいになったら重大度を `error` にして、新しい箇所が増えないようにしましょう。

## ジェネレーターが黙って諦めるとき

ここが痛い部分です。エラーでも警告でもないからです。2 つの構文はジェネレーターにカスタムのマッチング処理の出力を諦めさせ、どちらの場合もキャッシュされた素の `Regex` インスタンスの出力にフォールバックします。コードはコンパイルが通り、テストも通り、それでいて利点は何一つ得られていません。

1 つ目は `RegexOptions.NonBacktracking` で、これはソースジェネレーターも `RegexCompiler` もサポートしていません。2 つ目は大文字小文字を区別しない後方参照です。`IgnoreCase` の後方参照のマッチングには `System.Text.RegularExpressions.dll` の内部にある大文字小文字変換テーブルが必要で、これは生成コードからはアクセスできません。これは `RegexCompiler` が扱えてソースジェネレーターが扱えない唯一の構文です。

どちらも直接確認できます。プロジェクトファイルにこれを追加してください。

```xml
<PropertyGroup>
  <EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
  <CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>
</PropertyGroup>
```

そのうえで次の 3 つのメンバーをコンパイルし、`generated/System.Text.RegularExpressions.Generator/.../RegexGenerator.g.cs` を読んでください。

```csharp
// .NET 11, C# 14
internal static partial class NonBt
{
    [GeneratedRegex(@"\d+", RegexOptions.NonBacktracking)]
    internal static partial Regex Digits();
}

internal static partial class IgnoreCaseBackref
{
    [GeneratedRegex(@"(\w)\1", RegexOptions.IgnoreCase)]
    internal static partial Regex Doubled();
}

internal static partial class Fine
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

出力されたファイルは、3 つのうちどれが成功したかを明確に示します。

```csharp
/// <summary>Caches a <see cref="Regex"/> instance for the Digits method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because RegexOptions.NonBacktracking isn't supported.</remarks>
file sealed class Digits_0 : Regex
{
    internal static readonly Regex Instance = new("\\d+", RegexOptions.NonBacktracking);
}

/// <summary>Caches a <see cref="Regex"/> instance for the Doubled method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because the expression contains case-insensitive backreferences which are not supported by the source generator.</remarks>
file sealed class Doubled_1 : Regex
{
    internal static readonly Regex Instance = new("(\\w)\\1", RegexOptions.IgnoreCase);
}

/// <summary>Custom <see cref="Regex"/>-derived type for the Phone method.</summary>
file sealed class Phone_2 : Regex
{
    internal static readonly Phone_2 Instance = new();
    // ... RunnerFactory, Runner, TryMatchAtCurrentPosition, and so on
}
```

"Caches a `Regex` instance" はフォールバックです。"Custom `Regex`-derived type" が本物です。ジェネレーターはフォールバックのケースについて `SYSLIB1044` も報告しますが、その重大度は **Info** なので、通常のビルドログには現れず CI も失敗しません。気にするなら `.editorconfig` で引き上げてください。

```ini
dotnet_diagnostic.SYSLIB1044.severity = warning
```

フォールバックが無価値というわけではありません。キャッシュと説明的な XML コメントは引き続き得られます。ただしホットパスを高速化するつもりで変換したのなら、高速化されていないことを知る必要があります。

## 診断とその実際のメッセージ

以下は .NET 10 SDK が実際に出力する文字列そのもので、言い換えではありません。

| ID | 重大度 | メッセージ |
| --- | --- | --- |
| `SYSLIB1040` | Error | Invalid `GeneratedRegexAttribute` usage. |
| `SYSLIB1041` | Error | Multiple `GeneratedRegexAttribute` attributes were applied to the same method, but only one is allowed. |
| `SYSLIB1042` | Error | The specified regex is invalid. |
| `SYSLIB1043` | Error | `GeneratedRegexAttribute` method or property must be partial, parameterless, non-generic, non-abstract, and return `Regex`. If a property, it must also be get-only. |
| `SYSLIB1044` | Info | The regex generator couldn't generate a complete source implementation for the specified regular expression due to an internal limitation. |
| `SYSLIB1045` | Info | Use `GeneratedRegexAttribute` to generate the regular expression implementation at compile time. |

## 実際に時間を奪う落とし穴

**含んでいる型が partial でなくても SYSLIB のエラーは出ません。** ジェネレーターは自分の側の部分型を構わず出力し、文句を言うのは C# コンパイラーのほうで、`CS0260: Missing partial modifier on declaration of type 'NotPartial'; another partial declaration of this type exists` が出ます。3 階層の入れ子になっているなら、3 つすべてに `partial` が必要です。

**`CultureInvariant` と明示的なカルチャー名の組み合わせは誤解を招くメッセージを出します。** この組み合わせは:

```csharp
[GeneratedRegex(@"abc", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, "en-US")]
internal static partial Regex Abc();
```

`error SYSLIB1042: The specified regex is invalid. 'cultureName'` で失敗します。パターン `abc` は明らかに問題ありません。実際の問題は `CultureInvariant` と名前付きカルチャーが排他だということで、この診断は不正パターン用のメッセージを流用し、問題のある引数名をそのペイロードとして入れています。カルチャー名を外すか、`CultureInvariant` を外してください。

**`LangVersion` を固定していると、壊れるのは自分のファイルではなく生成ファイルのビルドです。** ジェネレーターは C# 11 の機能である `file` スコープの型を出力します。`LangVersion` を 10 に強制すると `CS8936: Feature 'file types' is not available in C# 10.0. Please use language version 11.0 or greater` が `RegexGenerator.g.cs` を指して出ます。部分プロパティを使うと下限は C# 13 に上がり、`CS8703: The modifier 'partial' is not valid for this item in C# 10.0. Please use language version '13.0' or greater` になります。最近の SDK は `LangVersion` をターゲットフレームワークに合わせて既定設定するので、これが刺さるのは明示的に固定しているコードベースだけです。

**大文字小文字を区別しないマッチングはビルド時に凍結されます。** 大文字小文字を区別しない正規表現では、エンジンは内部の Unicode 大文字小文字変換テーブルを使ってパターンを展開し、`abc` は `[Aa][Bb][Cc]` に相当する形になります。他のエンジンはこの展開をランタイムで行い、実行中のランタイムのテーブルを使います。ソースジェネレーターはコンパイル時に行い、コンパイル対象としたターゲットフレームワークのテーブルを使います。将来の Unicode の改訂で等価性が変わった場合、ソース生成された正規表現は再ビルドするまで古い挙動を保ちます。これは [`GeneratedRegexAttribute` の注釈](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute)に記載されており、ほぼ問題になりませんが、「ほぼない」は「ない」ではありません。

**タイムアウトのチェックは全体単位でコンパイルに含まれるか外れるかのどちらかです。** 生成コードは環境の既定値を一度だけ読み取ります。

```csharp
internal static readonly TimeSpan s_defaultTimeout =
    AppContext.GetData("REGEX_DEFAULT_MATCH_TIMEOUT") is TimeSpan timeout
        ? timeout
        : Regex.InfiniteMatchTimeout;

internal static readonly bool s_hasTimeout = s_defaultTimeout != Regex.InfiniteMatchTimeout;
```

そしてバックトラッキングのループ内にある `base.CheckTimeout()` の呼び出しはすべて `s_hasTimeout` の背後に置かれます。既定の経路ではスループットに有利ですが、これは `REGEX_DEFAULT_MATCH_TIMEOUT` を設定せず `matchTimeoutMilliseconds` も渡さなければ、破滅的バックトラッキングを起こすパターンが敵対的な入力に対してリクエストパイプラインの熱的死まで走り続けることを意味します。信頼できない入力に触れるパターンでは、属性に `matchTimeoutMilliseconds` を設定するか、そのパターンだけ `RegexOptions.NonBacktracking` に切り替えてフォールバックを受け入れてください。

**コードサイズは増えます。** ジェネレーターはパターンごとに実際の C# を出力し、大きなパターンは大量のコードを生みます。正規表現が数百あってホットなのがひと握りなら、すべてを変換するのは、観測できないスループットのためにバイナリサイズを差し出す取引です。起動時に 2 回走るだけのパターンには、インタープリターが正解です。

## これが最も効くところ: トリミングと Native AOT

ジェネレーターを推す最も強い理由は 1 回あたり 2 ns ではありません。`RegexOptions.Compiled` が `System.Reflection.Emit` に依存していることです。これはまさに[トリムセーフなコード](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)が避ける種類の依存であり、[Native AOT](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/) が丸ごと取り除くものです。AOT のもとでは `Compiled` は黙って何もしない指定になり、丹念に最適化したホットパスがインタープリターの上で走ることになります。

ソース生成はこれを反転させます。マッチング処理がリンカーから見える素の C# であるため、トリマーは `RegexCompiler` を、場合によっては reflection-emit 自体も発行物から取り除けますし、生成されたマッチング処理は他のすべてと一緒に事前コンパイルされます。AOT で発行しているなら、定数パターンをすべて変換するのは最適化ではなく、コードが黙って置いている前提に対する修正です。

## 関連記事

- [ソースジェネレーターとは何か、いつ必要になるのか?](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [RegexOptions.AnyNewLine が .NET 11 Preview 3 に着陸](/ja/2026/04/regex-anynewline-dotnet-11-preview-3/)
- [.NET 11 で SearchValues を正しく使う方法](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)
- [Native AOT とは何か、そして何を犠牲にするのか?](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [トリムセーフなコードとは何か、どう書けばよいのか?](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)

## ソース

- Microsoft Learn の [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators)
- [`GeneratedRegexAttribute` の API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute)、コンパイル時の大文字小文字変換テーブルに関する注釈を含みます
- [正規表現のソース生成に関する SYSLIB 診断](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib1040-1049)
- .NET ブログの [Regular Expression Improvements in .NET 7](https://devblogs.microsoft.com/dotnet/regular-expression-improvements-in-dotnet-7/)
- dotnet/runtime の [`DiagnosticDescriptors.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.RegularExpressions/gen/DiagnosticDescriptors.cs)、各診断の重大度について

本記事のベンチマーク値と診断のテキストは、SDK .NET 10.0.201、Windows 11 x64、Release 構成でローカルに取得したものです。
