---
title: "PC が 1 trillion まで数えるのにどれくらいかかるか"
description: "PC が 1 trillion、さらにそれ以上まで数えるのにどれくらい時間がかかるかのベンチマーク。2023 年版の更新結果を含みます。"
pubDate: 2013-10-13
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2013/10/counting-up-to-one-trillion"
translatedBy: "claude"
translationDate: 2026-05-01
---
これは、20 trillion dollars 以上の評価額がある会社について同僚と話していて出た疑問です -- そんな額の現金がどのように見えるのか、私たちにはまったく想像できませんでした。雰囲気をつかむために、地球を一周するのに 100 ドル札が何枚必要かを計算しました。確か答えは約 240,000,000 枚で、合計でおよそ 24 billion US dollars でした。とんでもない金額です。一人の人がそれだけのお金を数えるとしたらどれくらいかかるでしょうか。確かなことは誰にも言えませんが、何万年単位でしょう。

そうは言っても、コンピューターが 1 trillion まで数えるのにどれくらいかかるかなら、かなり良い感覚をつかめます。ただ繰り返すだけで、間に他のアクションは挟みません。そのために、1 billion まで数えるのにかかる時間を測定し、それを基に簡単な計算でいろいろな値まで数えるのに必要な時間を見やすく表示する小さなコードを書きました。

結果は興味深いもので、答えは「マシンによる」です。同じマシンでも、負荷によって違う結果になります。ともあれ、私のマシンでの結果を少し見てみましょう。

**2023 年 10 月の更新結果** -- 今回は水冷の i9-11900k で計測しています。

```plaintext
9 minutes, 38 seconds         for 1 trillion (12 zeros)
6 days, 16 hours              for 1 quadrillion (15 zeros)
18 years, 130 days            for 1 quintillion (18 zeros)
18356 years, 60 days          for 1 sextillion (21 zeros)
```

10 年前にこの記事を書いた当時の結果と比べるととても興味深いです。時間は数時間から 10 分未満まで縮みました。もちろん、元のベンチマークは廉価なノート PC の CPU で動かしていて、更新後の数値はアンロックされたデスクトップ CPU + 水冷で動かしているので、ある意味リンゴと nashi を比べているような話ではあります。それでも、時間の経過でどう変わるかを見られるのは興味深いです。

> 2013 年当時のオリジナルの結果 (ノート PC で実行) は次のとおりです。
> 
> -   one billion (9 zeros) はすぐに到達 -- 15 秒
> -   ですが one trillion (12 zeros) に到達するまでとなると、その差は驚くほどで -- 4 時間 10 分。基本的に 1000 倍です。
> -   さらに quadrillions (15 zeros) になると 173 日、quintillions (18 zeros) では 475 年と差はもっと顕著になります
> -   私が計算した最後の値は one sextillion (21 zeros) で、覚悟してください -- 私のノート PC でその値までイテレーションするのにちょうど 475473 年、292 日、6 時間、43 分、52 秒かかります。

繰り返しですが、これらの値はマシンに大きく依存します。ぜひ自分でも試して、結果を共有してください。コードは下のとおりです。

```cs
using System.Diagnostics;

var sw = new Stopwatch();
sw.Start();

// 10 billion iterations (10 zeros)
for (long i = 1; i <= 10000000000; i++) ;

sw.Stop();

Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100)} for 1 trillion (12 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000)} for 1 quadrillion (15 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000)} for 1 quintillion (18 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000000)} for 1 sextillion (21 zeros)");

Console.ReadKey();

string FormatString(long elapsed, long multiplier)
{
    var span = new TimeSpan(elapsed * multiplier).Duration();

    return string.Format("{0}{1}{2}{3}{4}",
        span.Days > 364 ? $"{span.Days / 365} years, " : "",
        span.Days > 0        ? $"{span.Days % 365} days, "  : "",
        span.Hours > 0       ? $"{span.Hours} hours, "      : "",
        span.Minutes > 0     ? $"{span.Minutes} minutes, "  : "",
        span.Seconds > 0     ? $"{span.Seconds} seconds"    : "");
}
```

## では、すべての GUID を回したら？

そして、エンジニアらしく、私はもう 1 つ別の話題に移りました -- (私の中では) 完全に関係ある話で、GUID の一意性についてです。GUID が実際にどれくらい一意かは前から気になっていて、当時もある程度の答えを得たのですが、いまは以前よりも明確だと感じます。

まず、GUID は通常 32 桁の 16 進数で表現されます。なので、最大の 32 桁 16 進数 (`ffffffffffffffffffffffffffffffff`) を 10 進に変換すると次のようになります: 340,282,366,920,938,463,463,374,607,431,768,211,455 -- これは 39 桁、平易な英語で丸めると 340 undecillions です。

私の計算が合っていれば、sextillion の時間 (18365 年) を取り、1,000,000,000,000,000 (undecillion と sextillion の間の 15 桁) を掛け、さらに 340 を掛けます -- 340 undecillions の話なので。

それは約 6,244,100,000,000,000,000,000 年 -- つまり 6,244,100,000,000 百万千年紀。私のコンピューターが GUID のすべての可能な値をイテレーションするのにかかる時間です。さて、これでどれだけ一意なのでしょうか。
