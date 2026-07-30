---
title: "Visual Studio 18.9 でモデルごとに思考の労力を設定できるようになりました"
description: "Visual Studio 18.9 Insiders 2 では、Low から Max までのレベルを持つモデルごとの思考労力コントロールが追加され、モデル API が受け取るのと同じパラメーターが表に出ました。"
pubDate: 2026-07-30
tags:
  - "visual-studio"
  - "ai-agents"
  - "dotnet"
  - "copilot"
lang: "ja"
translationOf: "2026/07/visual-studio-18-9-thinking-effort-control-per-model"
translatedBy: "claude"
translationDate: 2026-07-30
---

2026-07-29 に Rachel Kang が [Tell your model when to think harder](https://devblogs.microsoft.com/visualstudio/tell-your-model-when-to-think-harder/) を公開しました。そこで説明されている機能は、タイトルから想像するよりも興味深いものです。**Visual Studio 18.9 Insiders 2** 以降、対応モデルには思考労力のコントロールが用意され、リクエスト単位ではなくモデル単位で設定します。

## モデルの選択と推論の深さの選択が別の判断になりました

これまで Visual Studio でモデルを選ぶことは、2 つのことを同時に選ぶことでした。どの重みが質問に答えるか、そして答えが返るまでにどれだけ推論が行われるかです。深く推論するモデルを選べば、「この変数の名前を変更して」というプロンプトでもその分のコストを払っていました。

この 2 つを切り離せるということは、セッション全体で同じモデルを使い続けたまま、代わりにダイヤルを動かせるということです。レベルは次のとおりです。

- **Low**：「Quick responses with minimal reasoning」で、消費する AI クレジットも少なくなります。
- **Medium**：「Balanced reasoning and speed, and usually the default.」
- **High**：やっかいなアルゴリズム、アーキテクチャの判断、原因を絞り込めないバグ向けの、より深い推論です。
- **Extra High** と **Max**：「The most reasoning some models offer, for the gnarliest problems.」

思考コントロールを持たないモデルはダッシュを表示し、これまでとまったく同じように動作します。つまりこのコントロールは追加されるものであり、全体の挙動を変えるものではありません。

## 設定の場所

モデルピッカーを開き、**Manage models** をクリックして拡張されたモデル管理ウィンドウを表示し、そこでモデルごとの思考レベルを調整します。Tools > Options の奥に埋まっているわけではなく、プロンプトごとのトグルでもありません。

## このはしごは Visual Studio ではなくプロバイダー側のものです

Low、Medium、High、Extra High、Max は、Microsoft がスライダーのために考え出した 5 つの名前ではありません。モデル API がすでに受け取っている推論労力のパラメーターが、IDE 上に出てきたものです。Anthropic の API では、労力は `output_config` の中にあり、受け付ける値は `low`、`medium`、`high`、`xhigh`、`max` のちょうど 5 つです。

```csharp
using Anthropic;
using Anthropic.Models.Messages;

AnthropicClient client = new();

var response = await client.Messages.Create(new MessageCreateParams
{
    Model = "claude-opus-5",
    MaxTokens = 16000,
    Thinking = new ThinkingConfigAdaptive(),
    OutputConfig = new OutputConfig { Effort = Effort.High },
    Messages = [new() { Role = Role.User, Content = "Why does this query deadlock?" }],
});
```

ワイヤー上では `"output_config": { "effort": "high" }` となり、`xhigh` は `high` と `max` の間に位置します。`Effort` は `OutputConfig` の下にネストされており、トップレベルのプロパティではない点に注意してください。同じコントロールを自前のツールに組み込むなら、これが避けるべき間違いです。

IDE の設定が実際に何をしているのかを考えるうえで、2 つの点が重要です。労力は推論の深さとトークン消費全体の上限であり、固定の予算ではありません。現行の Claude モデルでは適応的な思考がリクエストごとにどれだけ推論するかを決め、労力がそれを制限します。そして推論トークンの厳密な予算を指定する以前の方式は、これらのモデルではなくなりました。だからこそ、名前の付いた 5 段のはしごが IDE に提示できるものになっているのです。

## 請求に現れる部分

「Higher thinking levels do more reasoning, which consumes more credits. Lower levels use fewer.」つまりこのコントロールは、品質のレバーであると同時にコストのレバーでもあり、[Copilot CLI と SDK の AI クレジットのセッション上限](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/)と組み合わせて機能します。一方が上限を抑え、もう一方がリクエストごとの消費レートを決めます。

18.9 Insiders を使っているなら、いつものモデルを選んだまま Low に落とし、1 日ふつうの編集をしてみて、どれだけ物足りなさを感じないかを見るのが最短の調整方法です。
