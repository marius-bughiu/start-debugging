---
title: ".NET 11 Preview 7 で C# 15 にラベル付き break と continue が追加されました"
description: "ラベル付き break と continue が .NET 11 Preview 7 の C# セクションに入りました。ループにラベルを付けて直接ジャンプできるようになり、入れ子のループで使っていた bool フラグや goto の回避策が不要になります。"
pubDate: 2026-08-12
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "language-features"
lang: "ja"
translationOf: "2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-12
---

.NET 11 Preview 7 が 2026-08-11 にリリースされ、その C# セクションには、コミュニティがかなり長いあいだ要望してきた機能が含まれています。`break` と `continue` が、外側のループや `switch` に付けたラベルを指定できるようになりました。チャンピオン提案は [dotnet/csharplang#9875](https://github.com/dotnet/csharplang/issues/9875) で、そこに添えられた議論リストは、何年も前にさかのぼる 9 本のコミュニティスレッドにリンクしています。

## 構文の見た目

ラベルはループに直接付け、ジャンプ文がそのラベルを指定します。

```csharp
outer: for (int row = 0; row < grid.Height; row++)
{
    for (int column = 0; column < grid.Width; column++)
    {
        if (grid[row, column].IsBlocked)
        {
            continue outer;
        }

        if (grid[row, column].IsGoal)
        {
            break outer;
        }
    }
}
```

1 つのラベルで両方のジャンプをまかなえます。ラベルを付けなければ `break` と `continue` はこれまでどおりの動作で、最も内側の該当する文を対象にします。つまり純粋な追加機能です。

## 置き換えられる 2 つの回避策

bool フラグを使う書き方では、脱出を外側へ伝えるためだけに状態が必要になり、各レベルでその状態をチェックしなければなりません。

```csharp
bool found = false;
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (i * j > 20)
        {
            found = true;
            break;
        }
    }

    if (found)
        break;
}
```

`goto` を使う書き方は continue のケースでさらに厄介です。インクリメントと条件評価を実行させるために、ラベルをループ本体の末尾に置く必要があるからです。

```csharp
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (j == 5)
            goto next;
    }

    next: ; // The empty statement is required.
}
```

これは壊れやすい書き方です。ラベルと閉じ波かっこの間にうっかり文を挿入すると、ジャンプの意味が黙って変わってしまいます。ラベルをループ構文そのものに結び付けることで、この失敗パターンがなくなります。

## リファクタリング前に知っておきたい 2 つのルール

ラベルが付くのは、ラベル付き文の**直下**に入れ子になった文だけです。`a: b: while (...) ...` の場合、ループにラベルを付けるのは `b` だけです。`a` は内側のラベル付き文にラベルを付けますが、その文自体はループではないため、その本体の中の `break a;` は `while` へのジャンプではなくコンパイルエラーになります。仕様は入れ子のラベルを明示的に却下しています。

また、`break` は外側の `switch` を対象にできますが、`continue` はできません。`continue` は常に反復文へ解決されます。これは 2 つのジャンプそれぞれの意味から導かれる帰結です。

## 既存の該当箇所を見つけてくれるアナライザー

対象となるコードを自分で探す必要はありません。[IDE0410](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0410)（"Use labeled jump statement"）が 3 つのパターンすべてを報告します。入れ子のループを飛び越える `goto`、末尾の空ラベルへの `goto`、そして bool フラグによる伝播チェーンです。`csharp_style_prefer_labeled_jump_statements = true` によって既定で有効で、C# 15 以降に適用されます。プロジェクト単位で無効化するには次のようにします。

```ini
[*.cs]
dotnet_diagnostic.IDE0410.severity = none
```

試すには .NET 11 のプレビュー SDK が必要で、これは [Preview 6 で入った拡張インデクサー](/ja/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/)と同じです。詳細は[機能仕様](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/labeled-break-continue)と [Preview 7 のアナウンス](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/)にあります。
