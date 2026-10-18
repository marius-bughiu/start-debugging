---
title: ".NET でインドのラーク/クロール方式の桁区切りで数値をフォーマットする方法 (NumberGroupSizes)"
description: "en-IN カルチャを使うか NumberFormatInfo.NumberGroupSizes を [3, 2] に設定すると、C# で 123,456,789 ではなく 12,34,56,789 と出力できます。.NET 10 と .NET 11 RC1 で検証し、配列の仕組み、CurrencyGroupSizes が別である理由、欧米式の桁区切りが黙って出力されるインバリアントグローバリゼーションの落とし穴、ラーク/クロールの単位表記ヘルパーを解説します。"
pubDate: 2026-10-18
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "globalization"
  - "formatting"
lang: "ja"
translationOf: "2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-18
---

**結論:** `ToString("N2", culture)` に `en-IN` カルチャ (または `hi-IN` などの他のインド系カルチャ) を渡すと、.NET は `123,456,789.50` ではなく `12,34,56,789.50` と出力します。これらのカルチャはすでに `NumberFormatInfo.NumberGroupSizes = [3, 2]` を持っているためです。カルチャのそれ以外の設定は不要で桁区切りだけが必要な場合は、`NumberFormatInfo` を複製して `NumberGroupSizes = [3, 2]` を設定し (`C` や `P` を使うなら `CurrencyGroupSizes` と `PercentGroupSizes` も)、それをフォーマットプロバイダーとして渡します。この配列は"右から数えて最初のグループは 3 桁、それ以降のグループはすべて 2 桁"という意味で、`int`、`long`、`decimal`、`double`、`BigInteger`、カスタムの `#,##0` パターン、`TryFormat` のいずれでも動作します。

以下はすべて、macOS (ICU 使用)、C# 14 上の .NET SDK 10.0.302 (ランタイム 10.0.10) と .NET 11 RC1 (`11.0.100-rc.1.26425.128`) で計測した結果です。出力は両方のランタイムでバイト単位で同一でした。また `NumberGroupSizes` API 自体は .NET Framework 1.1 以降変わっていないため、同じコードは .NET 8 と 9 でも動作します。

## インド式の桁区切りが欧米式と異なる理由

欧米式は 3 桁ごとに区切ります (thousand、million、billion)。インド式の数字表記では、最初の 3 桁 (百の位まで) を区切り、それ以降は 2 桁ごとに区切ります。thousand、lakh (1,00,000)、crore (1,00,00,000) と続きます。たとえば 123,456,789 は、米国では `123,456,789` と書き、インドでは `12,34,56,789` (12 crore、34 lakh、56 thousand、789) と書きます。

.NET はどちらの表記もハードコードしていません。すべての `NumberFormatInfo` は、数値の整数部をグループに分割する方法を表す 3 つの整数配列を持っています。

- `NumberGroupSizes`: `N` 書式と、`,` を含むカスタムパターンで使われます
- `CurrencyGroupSizes`: `C` 書式で使われます
- `PercentGroupSizes`: `P` 書式で使われます

フォーマッターはこれらの配列を小数点から左へ向かって順にたどります。仕組みはこれだけで、1 つの配列で両方の表記を表現できる理由でもあります。

## 最小の再現コード: 同じ数値を 2 つのカルチャで出力する

```csharp
// .NET 11, C# 14 (also .NET 10.0.10)
using System.Globalization;

var us  = CultureInfo.GetCultureInfo("en-US");
var inr = CultureInfo.GetCultureInfo("en-IN");
decimal amount = 123456789.5m;

Console.WriteLine(string.Join(",", us.NumberFormat.NumberGroupSizes));  // 3
Console.WriteLine(string.Join(",", inr.NumberFormat.NumberGroupSizes)); // 3,2

Console.WriteLine(amount.ToString("N2", us));   // 123,456,789.50
Console.WriteLine(amount.ToString("N2", inr));  // 12,34,56,789.50
Console.WriteLine(amount.ToString("C", inr));   // ₹12,34,56,789.50
Console.WriteLine(12345.678.ToString("P1", inr)); // 12,34,567.8%
```

`hi-IN`、`bn-IN`、`ta-IN` も、3 つの配列すべてで同じ `[3, 2]` を返します。出力は ASCII の数字になります。.NET の数値フォーマットは `NativeDigits` を決して置換しないため、どのインド系カルチャを選んでも、デーヴァナーガリー数字やベンガル数字ではなく `12,34,56,789` と出力されます。

## 修正手順

アプリがすでにインド系カルチャを `CurrentCulture` として実行されているなら、何もする必要はありません。`$"{amount:N2}"` が自動的にその桁区切りを使います。しかし多くの場合、カルチャが `en-US` やインバリアントのサーバー上でインド式の桁区切りが必要だったり、レポートの 1 列だけに必要だったりします。どのケースでも使える手順は次のとおりです。

1. インドのカルチャ全体が必要なのか、桁区切りだけが必要なのかを決めます。`en-IN` は `₹` 通貨記号、`dd-MM-yyyy` 形式の日付、インド英語の月名も一緒に持ち込みます。カンマだけが欲しいなら、代わりにカスタムの `NumberFormatInfo` を作成します。
2. 書き込み可能なコピーから始めます。`CultureInfo.GetCultureInfo(...)` と `CultureInfo.InvariantCulture` は読み取り専用のインスタンスを返し、その `NumberFormat` のプロパティに代入すると `InvalidOperationException: Instance is read-only.` がスローされます。`NumberFormatInfo` の `Clone()` を呼ぶか、書き込み可能な `new CultureInfo("en-US")` でカルチャを作成します。
3. グループサイズを代入します。`N` とカスタムパターン用に `NumberGroupSizes = [3, 2]` を設定します。`C` や `P` で書式化するなら `CurrencyGroupSizes` と `PercentGroupSizes` も設定します。これらは独立した配列です。
4. `NumberFormatInfo.ReadOnly(nfi)` で固定し、`static readonly` フィールドに保持して、すべての呼び出し元が 1 つの不変なプロバイダーを共有するようにします。
5. `ToString`、`TryFormat`、`string.Format`、`string.Create` に `IFormatProvider` として渡します。スレッド全体で使いたい場合は `CurrentCulture` に設定します。

コードにすると次のとおりです。

```csharp
// .NET 11, C# 14
using System.Globalization;

public static class IndianNumberFormat
{
    public static readonly NumberFormatInfo Grouping = Create();

    private static NumberFormatInfo Create()
    {
        var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        nfi.NumberGroupSizes   = [3, 2];
        nfi.CurrencyGroupSizes = [3, 2];
        nfi.PercentGroupSizes  = [3, 2];
        nfi.CurrencySymbol     = "₹"; // invariant default is the generic ¤
        return NumberFormatInfo.ReadOnly(nfi);
    }
}

decimal amount = 123456789.5m;
Console.WriteLine(amount.ToString("N2", IndianNumberFormat.Grouping)); // 12,34,56,789.50
Console.WriteLine(amount.ToString("C",  IndianNumberFormat.Grouping)); // ₹12,34,56,789.50
```

通貨についてステップ 3 を忘れると、中途半端な移行になって混乱します。`NumberGroupSizes` だけを変更した場合、私のテストでは `amount.ToString("C", nfi)` は依然として `¤123,456,789.50` と出力されました。`C` 書式は `CurrencyGroupSizes` を読み取り、それが `[3]` のままだったためです。

他のすべての言語設定には触れずに、リクエスト全体またはスレッド全体の桁区切りだけを変更するには、書き込み可能なカルチャにパッチを当てます。

```csharp
// .NET 11, C# 14
using System.Globalization;

var culture = new CultureInfo("en-US");          // writable, unlike GetCultureInfo
culture.NumberFormat.NumberGroupSizes = [3, 2];
CultureInfo.CurrentCulture = culture;

Console.WriteLine($"{123456789:N0}");            // 12,34,56,789
Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:N0}", 123456789)); // 123,456,789
```

2 行目は、明示的なプロバイダーが常に `CurrentCulture` より優先されることを思い出させてくれます。

## NumberGroupSizes 配列の解釈のされ方

信じ込むのではなくランタイムで確認したルールは次のとおりです。

- 要素 0 は、小数点に最も近いグループのサイズです。要素 1 はその左隣のグループ、以降も同様です。
- **最後の要素は繰り返されます**。残りのすべてのグループに適用されます。`[3, 2]` が延々と 2 桁のグループを作り続けるのはこのためです。
- 最後の要素が `0` の場合、残りの桁は**まったくグループ化されません**。
- すべての要素は 1 から 9 の間でなければなりません。ただし最後の要素だけは 0 でもかまいません。それ以外は `ArgumentException` がスローされ、メッセージは "Every element in the value array should be between one and nine, except for the last element, which can be zero." です。

異なる配列が `1234567890` に与える影響は次のとおりです。

```csharp
// .NET 11, C# 14
using System.Globalization;

var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
long n = 1234567890;

nfi.NumberGroupSizes = [3];       Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,890
nfi.NumberGroupSizes = [3, 2];    Console.WriteLine(n.ToString("N0", nfi)); // 1,23,45,67,890
nfi.NumberGroupSizes = [3, 0];    Console.WriteLine(n.ToString("N0", nfi)); // 1234567,890
nfi.NumberGroupSizes = [3, 2, 0]; Console.WriteLine(n.ToString("N0", nfi)); // 12345,67,890
nfi.NumberGroupSizes = [4];       Console.WriteLine(n.ToString("N0", nfi)); // 12,3456,7890
nfi.NumberGroupSizes = [1, 2, 3]; Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,89,0
nfi.NumberGroupSizes = [0];       Console.WriteLine(n.ToString("N0", nfi)); // 1234567890
nfi.NumberGroupSizes = [];        Console.WriteLine(n.ToString("N0", nfi)); // 1234567890

nfi.NumberGroupSizes = [3, 0, 2]; // ArgumentException: 0 is only allowed last
nfi.NumberGroupSizes = [10];      // ArgumentException: max is 9
```

`[4]` は、デザイン上必要な場合の東アジアの万単位の区切り (wan/man) に使う形です。.NET の組み込みカルチャで、これを既定で使うものはありません。`[3, 0]` は、仕様に"千の位だけ区切る"とある場合に便利です。

ゲッターは配列のコピーを返します。`nfi.NumberGroupSizes[0] = 9` と書いてもコンパイルされ実行されますが、何も変わりません。私のテストでは出力は `12,34,56,789.50` のままでした。必ず新しい配列を代入してください。

## 桁区切りが反映される書式と反映されない書式

一般的な経路をすべて `en-IN` で実行しました。

| 呼び出し | 出力 |
|---|---|
| `1234567890123L.ToString("N0", inr)` | `12,34,56,78,90,123` |
| `amount.ToString("#,##0.00", inr)` | `12,34,56,789.50` |
| `BigInteger.Parse("123456789012345").ToString("N0", inr)` | `12,34,56,78,90,12,345` |
| `12345678f.ToString("N0", inr)` | `1,23,45,678` |
| `int.MinValue.ToString("N0", inr)` | `-2,14,74,83,648` |
| `123456789.TryFormat(span, out _, "N0", inr)` | `12,34,56,789` |
| `1234567.ToString("D", inr)` / `"G"` / `"F2"` | `1234567` / `1234567` / `1234567.89` |

つまり `N`、`C`、`P`、そして `,` を含むカスタムパターンはすべて配列に従い、アロケーションのない `TryFormat` の経路でも同様です。`D`、`G`、`F`、`E` と引数なしの `ToString()` は、どのカルチャでも桁区切りを行いません。

カスタム書式には、つまずきやすい点が 1 つあります。カスタムパターン内のカンマの位置は関係ありません。`123456789.ToString("#,##,##0", enUS)` は `12,34,56,789` ではなく `123,456,789` を出力します。数字プレースホルダーの間にあるカンマは桁区切りを有効にするだけで、サイズは常に `NumberGroupSizes` から決まります。"正しい"パターンを書いてもインド式の桁区切りは得られません。プロバイダーを変更する必要があります。小数点の直前 (または末尾) のカンマはまったく別の機能で、カンマ 1 つにつき 1,000 で割ります。したがって `"0,,"` は `123456789` を `123` に変えます。

## 落とし穴

### インバリアントグローバリゼーションモードは欧米式の桁区切りを黙って出力する

本番環境に紛れ込むのはこの問題です。多くのコンテナーイメージや Native AOT アプリは、ICU への依存を取り除くために `<InvariantGlobalization>true</InvariantGlobalization>` (または `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`) を設定しています。このモードでは `CultureInfo.GetCultureInfo("en-IN")` は `CultureNotFoundException: Only the invariant culture is supported in globalization-invariant mode.` をスローします。少なくともこれは気づけます。

気づけないケースは、その例外を消すために誰かが `PredefinedCulturesOnly` を `false` (`DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=0`) にも設定したときに起こります。すると `new CultureInfo("en-IN")` は成功しますが、そのカルチャはインバリアントのデータを持っています。私の計測では `sizes=3`、`N0` の出力は `123,456,789`、通貨記号は `¤` で、例外も警告もありませんでした。インドのユーザーにはアメリカ式のカンマが表示されます。

上の `IndianNumberFormat` クラスのように、`InvariantCulture` から自分で `NumberFormatInfo` を構築すれば、ICU のデータに依存しないため、インバリアントモードでも桁区切りは機能します。コンテナーでは最も堅牢な選択肢です。完全な `en-IN` カルチャが必要なら、イメージに ICU を含めてください。[ICU のコンテナー修正](/ja/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)でパッケージを説明しており、[コンテナーデプロイの比較](/ja/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)では、どのイメージ種別がインバリアントモードを有効にするかを扱っています。

### "N" の既定の精度は移植性がない

この Mac では、ICU は `en-IN`、`hi-IN`、`en-US`、`en-GB` のいずれでも `NumberDecimalDigits = 3` を報告したため、`amount.ToString("N", inr)` は小数 3 桁の `12,34,56,789.500` を出力し、`CurrencyDecimalDigits` は 2 のままでした。インバリアントモードでは、同じ呼び出しが小数 2 桁で出力されました。カルチャのデータは OS の ICU (または古い Windows 環境では NLS) から来るため、既定値はノート PC とサーバーで異なる場合があります。ユーザーが目にするものやテストで比較するものには、必ず精度を明示してください。裸の `N` ではなく、`N0` や `N2` を使います。

### パースは区切りの位置を無視する

`decimal.Parse("1,23,45,678.90", NumberStyles.Number, enUS)` は `12345678.90` を返し、`decimal.Parse("12,345,678", NumberStyles.Number, inr)` も同じです。`NumberStyles.AllowThousands` では、.NET は整数部のどこにあるグループ区切りも受け付け、`NumberGroupSizes` に照らした検証は行いません。両方の形式の入力を受け付けるには便利ですが、パースは検証にはならないということです。インド式のフィールドで `12,345,678` を拒否する必要があるなら、パースの前に `^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$` のような正規表現で形を確認してください。

### 別の区切り文字

インドのスタイルガイドでは、カンマの代わりに細いスペースを求められることがあります。同じ複製した `NumberFormatInfo` に `NumberGroupSeparator` (`C` には `CurrencyGroupSeparator`) を設定します。`"\u202F"` (狭いノーブレークスペース) でテストしたところ、サイズは変わらず `12 34 56 789` となりました。数値が行をまたいで折り返されないよう、ノーブレークスペースを使ってください。

## "12.35 lakh" や "2.5 crore" と出力する

`NumberGroupSizes` が制御するのは区切り文字であり、単位の語ではありません。.NET には "lakh" や "crore" を生成する組み込みのコンパクトフォーマッターがありません (`CompactDecimalFormat` の概念は ICU に存在しますが、`ToString` からは公開されていません)。UI でよくある要件には、小さなヘルパーで対応できます。

```csharp
// .NET 11, C# 14
using System.Globalization;

static string ToLakhCrore(decimal value, int decimals = 2)
{
    var inr = CultureInfo.GetCultureInfo("en-IN");
    const decimal Lakh = 1_00_000m, Crore = 1_00_00_000m;
    decimal abs = Math.Abs(value);
    string sign = value < 0 ? "-" : "";
    string fmt = "#,##0." + new string('#', decimals);

    // Round in the target unit first, then promote if rounding crossed the boundary.
    decimal inLakh = Math.Round(abs / Lakh, decimals, MidpointRounding.AwayFromZero);
    if (abs >= Crore || inLakh >= 100m)
        return sign + Math.Round(abs / Crore, decimals, MidpointRounding.AwayFromZero).ToString(fmt, inr) + " crore";
    if (abs >= Lakh || inLakh >= 1m)
        return sign + inLakh.ToString(fmt, inr) + " lakh";
    return sign + abs.ToString(fmt, inr);
}

Console.WriteLine(ToLakhCrore(45_000m));         // 45,000
Console.WriteLine(ToLakhCrore(1_25_000m));       // 1.25 lakh
Console.WriteLine(ToLakhCrore(12_34_567m));      // 12.35 lakh
Console.WriteLine(ToLakhCrore(99_99_999m));      // 1 crore
Console.WriteLine(ToLakhCrore(2_50_00_000m));    // 2.5 crore
Console.WriteLine(ToLakhCrore(1234_56_78_901m)); // 1,234.57 crore
Console.WriteLine(ToLakhCrore(-3_50_000m));      // -3.5 lakh
```

"先に丸め、その後で単位を繰り上げる"手順が重要です。丸める前に `abs >= Crore` を確認する単純な実装では、`99,99,999` に対して `100 lakh` と出力されますが、インドの読者はそのようには書きません。C# のリテラルの桁区切り (`1_00_000m`) にも注目してください。コンパイラーは数字の間のどこにでも `_` を受け付けるので、可読性のためにソースコード内でインド式の桁区切りをそのまま書けます。

ヘルパーをインバリアントグローバリゼーションのコンテナーで実行する場合は、上記の落とし穴で述べた理由から、`CultureInfo.GetCultureInfo("en-IN")` を先ほどの `IndianNumberFormat.Grouping` プロバイダーに置き換えてください。

## パフォーマンスに関する注意

グループサイズは、書式化の呼び出しごとに `NumberFormatInfo` にすでにある配列から 1 回読み取られるだけなので、`[3, 2]` のコストは `[3]` と同じです。高コストになる間違いは、呼び出しごとに新しい `CultureInfo` を作成したり `NumberFormatInfo` を複製したりすることです。上で示したようにプロバイダーを `static readonly` フィールドにキャッシュし、ホットループで書式化するときはスタックバッファーへの `TryFormat` を使ってください。多数の数値から大きな文字列を組み立てる場合に、アロケーションのない経路がどれだけ節約になるかは、[StringBuilder と文字列補間の比較](/ja/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/)で確認できます。

## 関連記事

- [修正: .NET コンテナーで Couldn't find a valid ICU package installed on the system が出る場合](/ja/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/): Docker で `en-IN` が例外をスローする場合に参照してください。
- [.NET 11 コンテナーイメージにおけるフレームワーク依存、自己完結型、Native AOT の比較](/ja/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/): インバリアントグローバリゼーションがどこで有効になるかを扱っています。
- [ASP.NET Core の minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/): 既定でインバリアントモードになります。
- [.NET 11 は double を 16 進数でビット単位に往復変換できる](/ja/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/): 数値フォーマットと `NumberStyles` のもう 1 つの側面を扱っています。

## 出典

- [NumberFormatInfo.NumberGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.numbergroupsizes) (Microsoft Learn)
- [NumberFormatInfo.CurrencyGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.currencygroupsizes) (Microsoft Learn)
- [Standard numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) と [custom numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings): グループ区切り文字と数値スケーリング指定子を含みます。
- [Globalization and ICU in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu)
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode): `PredefinedCulturesOnly` を導入した .NET 6 の変更です。
