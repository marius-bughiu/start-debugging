---
title: ".NET の正規表現でバランシンググループを使って、ネストした括弧とタグの対応を一致させる方法"
description: "バランシンググループ (?<name>) と (?<-name>) を使うと、.NET の正規表現のキャプチャグループをスタックとして扱えるため、1 つのパターンで任意の深さにネストした括弧や <div> タグに一致させられます。完全なパターン、スタックの仕組み、(?<inner-open>) による内側の内容のキャプチャ、そして .NET 11 RC1 で確認した注意点 (空スタックのチェック、壊滅的なバックトラック、NonBacktracking、複数種類の括弧の混在) を解説します。"
pubDate: 2026-10-10
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "regex"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-match-nested-parentheses-with-balancing-groups-in-dotnet-regex"
translatedBy: "claude"
translationDate: 2026-10-10
---

**結論:** .NET ではすべてのキャプチャグループがキャプチャのスタックを保持しており、バランシンググループを使うと、パターンの内側からそのスタックに対してプッシュとポップを行えます。`(?<depth>)` は開き括弧でプッシュし、`(?<-depth>)` は閉じ括弧でポップし、末尾の条件式 `(?(depth)(?!))` は、スタックに何か残っていればマッチを失敗させます。これらを組み合わせた `\((?>[^()]+|\((?<depth>)|\)(?<-depth>))*(?(depth)(?!))\)` は、任意の深さにネストした括弧の組を 1 つ完全に一致させます。以下の例はすべて .NET 11 RC1 (`11.0.100-rc.1.26425.128`) で実行しましたが、この機能は .NET Framework 1.0 から `System.Text.RegularExpressions` に変更なく存在しているため、.NET 8、9、10 でも同じパターンが動作します。

ほとんどの正規表現エンジンでは、これはそもそも実現できません。古典的な正規表現は正規言語を記述するものであり、"対応のとれた括弧" は正規言語ではない言語の代表例です。カウンターが必要ですが、有限オートマトンにはカウンターがありません。PCRE や Perl は再帰 (`(?R)`) で解決します。.NET は別の道を選び、スタックそのものを直接使えるようにしました。スタックの存在がわかれば、この構文も暗号のようには見えなくなります。

## `\(.*\)` と `\(.*?\)` がどちらも誤った結果になる理由

入力 `f(a(b)c) + g(d)` に対して、誰もが最初に思いつく 2 つのパターンを試してみます。

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var input = "f(a(b)c) + g(d)";

Console.WriteLine(Regex.Match(input, @"\(.*\)").Value);
// (a(b)c) + g(d)    greedy: runs to the LAST ')'

Console.WriteLine(Regex.Match(input, @"\(.*?\)").Value);
// (a(b)             lazy: stops at the FIRST ')'
```

どちらも "対応する `)`" ではありません。貪欲なパターンは 2 つの別々の組を飲み込み、最短一致のパターンはネストした組を途中で切ってしまいます。本当に欲しいのは、"開き括弧の数から閉じ括弧の数を引いた値が 0 に戻る位置の `)`" であり、それには数えることが必要です。バランシンググループが提供するのが、まさにそのカウンターです。

## .NET のキャプチャグループがスタックになる仕組み

名前付きグループが 1 回のマッチの中で複数回参加すると (たとえば `*` のループ内)、.NET は以前のキャプチャを捨てません。`Match.Groups["name"].Captures` にすべてが順番に保持され、エンジンは最新のキャプチャをスタックの先頭として扱います。`\k<name>` のような後方参照が常に最後のキャプチャを参照するのは、このためです。

バランシンググループの構文は、このスタックを操作します。

| 構文 | 効果 |
|---|---|
| `(?<open>...)` | 通常の名前付きキャプチャです。`open` のスタックにキャプチャをプッシュします。本体が空の `(?<open>)` は幅ゼロのキャプチャをプッシュするので、純粋なカウンターのインクリメントとして機能します。 |
| `(?<-open>...)` | `open` のスタックの先頭からキャプチャをポップします。スタックが空の場合、この選択肢は**失敗**し、エンジンはバックトラックします。 |
| `(?<inner-open>...)` | `open` をポップし、ポップしたキャプチャの末尾から現在位置の手前までにわたるキャプチャを `inner` にプッシュします。対応する組の間の内容を取り出すにはこの方法を使います。 |
| `(?(open)yes\|no)` | 条件式です。`open` のスタックに 1 つ以上のキャプチャがあれば `yes` の分岐を取ります。 |
| `(?!)` | 空の否定先読みです。成功することがないため、"ここで失敗させる" という意味になります。 |

シングルクォート形式の `(?'open')`、`(?'-open')`、`(?'inner-open')` も同じ意味です。XML 属性の中で山括弧をエスケープせずにパターンを書けるようにするために用意されています。番号付きグループも使えます。`(?<-1>\))` はグループ 1 をポップします。

解析時のルールが 1 つあります。ポップするグループは、パターンのどこかに存在していなければなりません。`^\)(?<-d>)` だけを書くと、マッチの失敗ではなく、`Regex` コンストラクターから `RegexParseException: Reference to undefined group name 'd'` がスローされます。

## 対応のとれた括弧の組を 1 つ一致させる手順

コメントを付けられるように `RegexOptions.IgnorePatternWhitespace` を使って書いた、標準的なパターンです。

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var balanced = new Regex(@"
    \(                      # the outer opening paren
    (?>
        [^()]+              # a run of anything that is not a paren
      | \( (?<depth>)       # an inner '(' pushes onto 'depth'
      | \) (?<-depth>)      # an inner ')' pops 'depth' (fails if empty)
    )*
    (?(depth)(?!))          # if 'depth' is not empty, fail
    \)                      # the outer closing paren
", RegexOptions.IgnorePatternWhitespace);

foreach (Match m in balanced.Matches("f(a(b)c) + g(d) + h((x)"))
    Console.WriteLine($"{m.Value} @{m.Index}");

// (a(b)c) @1
// (d) @12
// (x) @20
```

`(a(b)c)` を順にたどります。

1. リテラルの `\(` が外側の `(` を消費します。`depth` スタックは空です。
2. `[^()]+` が `a` を消費します。
3. 内側の `(` は 2 番目の選択肢に当たり、`(?<depth>)` がキャプチャをプッシュします。深さは 1 になります。
4. `[^()]+` が `b` を消費します。
5. `)` は 3 番目の選択肢に当たり、`(?<-depth>)` がポップします。深さは 0 になります。
6. `[^()]+` が `c` を消費します。
7. 最後の `)` も 3 番目の選択肢でポップされそうになりますが、スタックが空なので `(?<-depth>)` は失敗します。ループが終了し、その `)` は返されます。
8. `(?(depth)(?!))` は空のスタックを確認し、どちらの分岐も取らないので成功します。
9. リテラルの `\)` が外側の `)` を消費します。マッチ成功です。

7 番目の手順が微妙な点です。空のスタックに対するポップが失敗することで、ループが外側の閉じ括弧を食べてしまうことが防がれ、パターンは自然に正しい `)` で止まります。

最後の入力 `h((x)` に注目してください。最初の `(` は閉じられないため、そこからはマッチを開始できません。エンジンは先に進み、2 番目の `(` から開始して、正しく対応のとれた `(x)` をインデックス 20 で返します。テキストの中から完全な組を探す場合には、通常これが望ましい動作です。

## `(?(depth)(?!))` のチェックが必須である理由

外側の `\(...\)` が全体を括っているように見えるため、条件式を省きたくなります。しかし、それでは足りません。`((a)` に対する 2 つのパターンを比較します。

```csharp
// .NET 11, C# 14
var noCheck   = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*\)");
var withCheck = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)");

Console.WriteLine(noCheck.Match("((a)").Value);    // ((a)   unbalanced!
Console.WriteLine(withCheck.Match("((a)").Value);  // (a)
```

チェックがない場合、外側の `\(` が最初の `(` を取り、ループが 2 番目の `(` をプッシュし、`a` を消費し、`)` でポップします。この時点で末尾の `\)` が一致できる対象がなくなるため、エンジンはバックトラックします。ループが最後の反復を返し (ポップが取り消されます)、末尾の `\)` がその `)` を取ります。`(` が 1 つスタックに残ったままマッチが成功してしまいます。スタックが強制するのは "開いた数より多く閉じない" ことだけです。"開いたものをすべて閉じる" ことを強制するのは、条件式の役割です。

## 文字列全体が対応しているかを検証する

"この文字列は対応がとれているか" を判定したい場合 (文字列の中から対応のとれた組を探すのではなく) は、両端をアンカーで固定し、外側のリテラルの括弧を取り除きます。

```csharp
// .NET 11, C# 14
var valid = new Regex(@"^(?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))$");

foreach (var s in new[] { "a(b(c)d)e", "a(b(c)d", "a)b(c", "", "())(" })
    Console.WriteLine($"'{s}': {valid.IsMatch(s)}");

// 'a(b(c)d)e': True
// 'a(b(c)d': False    one '(' left on the stack
// 'a)b(c': False      ')' with an empty stack
// '': True
// '())(': False
```

## 対応する組の間の内容をキャプチャする

2 つの名前を使う形式 `(?<inner-open>\))` は、`open` をポップし、ポップした `(` から現在の `)` までのテキストを `inner` のキャプチャとして記録します。ネストした各レベルの内容が、最も内側のものから順に取得できます。

```csharp
// .NET 11, C# 14
var inner = new Regex(@"(?>[^()]+|(?<open>\()|(?<inner-open>\)))*(?(open)(?!))");

Match m = inner.Match("x(a(b)c)(d)");
foreach (Capture c in m.Groups["inner"].Captures)
    Console.WriteLine($"{c.Value} @{c.Index}");

// b @4
// a(b)c @2
// d @9
```

順序は組が**閉じた**順なので、`b` が `a(b)c` より先に来ます。最も外側の組だけが必要な場合は、他のキャプチャの範囲にこのキャプチャが含まれていないかを確認して絞り込むか、前のセクションの単一グループのパターンに戻って `Matches` を使ってください。

## ネストした `<div>` タグに一致させる

同じ構造は、複数文字の区切りを含め、あらゆる区切りの組に使えます。変更点は "それ以外" の分岐だけです。文字クラスの代わりに `(?!</?div\b).` を使い、1 文字ずつ消費しつつ、`div` の開始タグや終了タグの先頭は決して消費しないようにします。

```csharp
// .NET 11, C# 14
var divs = new Regex(@"
    <div\b[^>]*>
    (?>
        <div\b[^>]*>  (?<depth>)
      | </div>        (?<-depth>)
      | (?!</?div\b) .
    )*
    (?(depth)(?!))
    </div>",
    RegexOptions.IgnorePatternWhitespace | RegexOptions.Singleline | RegexOptions.IgnoreCase);

var html = "<p>x</p><div class=\"a\">1<div>2</div>3</div><div>4</div>";
foreach (Match m in divs.Matches(html))
    Console.WriteLine(m.Value);

// <div class="a">1<div>2</div>3</div>
// <div>4</div>
```

ここでは `RegexOptions.Singleline` が重要です。これがないと `.` は `\n` に一致せず、複数行にまたがる `div` ではパターンが何も言わずに失敗します。

これは、テンプレート化されたスニペット、ログ出力、自分で生成したマークアップには問題なく使えます。ただし HTML パーサーではありません。`<div>` を含むコメント、`>` を含む属性、CDATA、閉じられていない void 要素などには簡単に騙されます。実際の HTML には AngleSharp や HtmlAgilityPack を使ってください。

## 遭遇しがちな注意点

### アトミックグループを忘れると壊滅的なバックトラックが起きる

選択肢を囲む `(?>...)` は飾りではありません。`(?:...)` を使い、`[^()]+` の代わりに `[^()]*` を書くと、マッチが失敗したときにエンジンが通常の文字の連なりを指数的な数の方法で分割でき、あきらめる前にそのすべてを試します。.NET 11 RC1 で、マッチのタイムアウトを 2 秒にして、29 文字の入力で計測しました。

```csharp
// .NET 11, C# 14
var input = "(" + new string('a', 25) + "(((";
var timeout = TimeSpan.FromSeconds(2);

var bad  = new Regex(@"^\((?:[^()]*|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);
var good = new Regex(@"^\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);

// bad.IsMatch(input)  -> RegexMatchTimeoutException after 2000 ms
// good.IsMatch(input) -> False in 0 ms
```

修正は 2 つあり、両方を使ってください。選択肢を `(?>...)` で囲み、各反復が消費した内容を確定させること、そしてループ内では `*` ではなく `+` を使い、反復が空にマッチしないようにすることです。信頼できない入力に対してパターンを実行する場合は、マッチのタイムアウトを渡すか、アプリケーションドメインに `REGEX_DEFAULT_MATCH_TIMEOUT` を設定してください。

### `RegexOptions.NonBacktracking` はバランシンググループを拒否する

.NET 7 で追加された線形時間エンジンにはスタックがないため、これらのパターンはコンストラクターで拒否されます。

```text
System.NotSupportedException: RegexOptions.NonBacktracking is not supported in
conjunction with expressions containing: 'balancing group (?<name1-name2>subexpression)
or (?'name1-name2' subexpression)'.
```

アトミックグループ `(?>...)` とキャプチャグループの条件式 `(?(name)...)` も同じ例外で拒否されるため、書き換えで回避することはできません。敵対的な入力に対して線形時間を保証する必要がある場合は、後述する 15 行ほどのスタックループを代わりに書いてください。OpenTelemetry チームもこのエンジンに関連する落とし穴に遭遇しており、[OpenTelemetry .NET 1.19.1 のワイルドカード NotSupportedException に関する解説](/ja/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/)で取り上げています。

### `[GeneratedRegex]` は問題なく動作する

ソースジェネレーターはバランシンググループ、アトミックグループ、条件式をサポートしているため、これらのパターンを変更せずにコンパイル時へ移行できます。

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

Console.WriteLine(Patterns.Call().Match("call(foo(1, bar(2)), 3);").Value);
// call(foo(1, bar(2)), 3)

static partial class Patterns
{
    [GeneratedRegex(@"\w+\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)")]
    public static partial Regex Call();
}
```

まだ移行していない場合は、[new Regex(...) を [GeneratedRegex] に置き換えるガイド](/ja/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/)で、それを自動で行うアナライザーとコード修正を紹介しています。

### 別々のスタックでは括弧の順序を強制できない

`()`、`[]`、`{}` への自然な拡張は、括弧の種類ごとに 1 つのスタックを使う方法です。

```csharp
// .NET 11, C# 14
var multi = new Regex(@"^(?>
      [^()\[\]{}]+
    | (?<p>\() | (?<-p>\))
    | (?<b>\[) | (?<-b>\])
    | (?<c>\{) | (?<-c>\})
  )*(?(p)(?!))(?(b)(?!))(?(c)(?!))$", RegexOptions.IgnorePatternWhitespace);

Console.WriteLine(multi.IsMatch("{[()]}"));  // True
Console.WriteLine(multi.IsMatch("(]"));      // False
Console.WriteLine(multi.IsMatch("{[(])}"));  // True   <- wrong
```

各スタックは自分の種類を正しく数えますが、それらを結びつけるものがないため、`{[(])}` が通ってしまいます。直前の開き括弧が `(` であっても、`]` が `b` スタックをポップするからです。正しい入れ子の順序を強制するには、共有された 1 つのスタックの先頭がどの種類かを知る必要があり、そこが正規表現が適切な道具ではなくなる境界です。通常の `Stack<char>` なら 1 回の走査で済み、誰でも読めます。

```csharp
// .NET 11, C# 14
static bool IsBalanced(ReadOnlySpan<char> s)
{
    var stack = new Stack<char>();
    foreach (char ch in s)
    {
        switch (ch)
        {
            case '(' or '[' or '{': stack.Push(ch); break;
            case ')': if (!stack.TryPop(out var a) || a != '(') return false; break;
            case ']': if (!stack.TryPop(out var b) || b != '[') return false; break;
            case '}': if (!stack.TryPop(out var c) || c != '{') return false; break;
        }
    }
    return stack.Count == 0;
}

// IsBalanced("{[()]}") -> True
// IsBalanced("{[(])}") -> False
```

ホットパスで長い文字列の中から次の括弧を見つけるだけでよい場合は、[SearchValues<char> と IndexOfAny](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)を使うと、括弧の間にある通常のテキストの連なりを高速に読み飛ばせます。

### 括弧の内側の引用符とエスケープ

`f("(", x)` には、文字列リテラルの中に対応しない `(` が含まれています。引用符で囲まれた文字列を読み飛ばすには、他の選択肢より前に、文字列全体を消費する選択肢 (たとえば `"(?:[^"\\]|\\.)*"`) を追加し、"それ以外" のクラスから `"` を除外します (`[^()"]+`)。字句規則 (コメント、文字リテラル、逐語的文字列) が増えるたびに選択肢が 1 つ増えるので、2、3 個を超えたら、手書きのトークナイザーのほうが保守しやすくなります。

### 行ベースのアンカー

`^...$` と `RegexOptions.Multiline` で複数行の入力を検証する場合、`$` はデフォルトでは `\n` しか認識しないことに注意してください。[.NET 11 の RegexOptions.AnyNewLine](/ja/2026/04/regex-anynewline-dotnet-11-preview-3/)は、`\r?` のような回避策なしで、`\r\n` と Unicode の行区切り文字の問題を解決します。

## バランシンググループを使うべき場面

バランシンググループが適切な道具になるのは、すでに正規表現向きの問題に取り組んでいるときです。たとえば、ソースファイルに対する検索と置換、ログのフィルター、検証属性、.NET のパターンを受け付けるエディターの検索ダイアログなどです。そうでなければパーサーを使うしかなかったネストの処理を、1 つの式で扱えます。複数種類の括弧にまたがる順序、エスケープの処理、エラー位置 ("14 列目に予期しない `)` があります") が必要になったら、ループを書いてください。正規表現の中でシミュレートしていたスタックは、C# では 1 行で書けます。

## 参考資料

- [Grouping constructs: balancing group definitions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/grouping-constructs-in-regular-expressions#balancing-group-definitions), MS Learn
- [Alternation constructs: conditional matching with a named group](https://learn.microsoft.com/en-us/dotnet/standard/base-types/alternation-constructs-in-regular-expressions), MS Learn
- [Regular expression options: NonBacktracking mode](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-options#nonbacktracking-mode), MS Learn
- [Backtracking in regular expressions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/backtracking-in-regular-expressions), MS Learn
- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), MS Learn
