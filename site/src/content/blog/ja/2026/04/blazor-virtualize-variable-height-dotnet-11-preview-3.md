---
title: "Blazor Virtualize が .NET 11 でついに可変高さアイテムを扱う"
description: ".NET 11 Preview 3 の ASP.NET Core は Virtualize コンポーネントにランタイムでアイテムを測ることを教え、一様高さ仮定が引き起こしていた spacing とスクロールのジッターを修正します。"
pubDate: 2026-04-16
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "virtualize"
lang: "ja"
translationOf: "2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

チャットログ、カードのフィード、通知パネルで [`Virtualize<TItem>`](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/virtualization) を使ったことがある人なら、同じバグを見たはずです: アイテムがスクロール時にジッターし、スクロールバーの thumb が跳ね回り、ぎこちないギャップや重なりが出ます。根本原因はいつも同じでした。`Virtualize` は各行が同じ高さであると仮定し、その単一の数値を使ってスクロールウィンドウを計算していました。[.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md) がついにそれを修正します: コンポーネントはランタイムでアイテムを測り、実際に DOM に着地した高さに仮想ビューポートを調整します。

## なぜ古い挙動が実際の UI を壊したか

元の API は `ItemSize` でスカラー値を選ぶことを強制しました。アイテムが 48px の高さなら 48 をセットしました。Blazor はアイテム数 × 48 でスクロール可能領域のサイズを決め、計算された top 位置がビューポートと交差する行だけをレンダリングしました。行が可変長 body、折り返す引用、レスポンシブ画像を含んだ瞬間、数学は現実と合わなくなり、ブラウザと Blazor は配置をめぐって戦いました。

```razor
<Virtualize Items="messages" Context="message">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

このスニペットはまさに、以前動作が悪かったシナリオです。短い 1 行と 5 段落の返信が同じ行スロットを共有するので、リストを移動するにつれてスクロールオフセットがずれます。

## レンダリングされた DOM を測る

.NET 11 Preview 3 では、`Virtualize` が測定されたアイテム寸法をランタイムで追跡し、それを spacer 計算にフィードバックします。もはや最悪ケースに合う値に `ItemSize` を設定する必要はなく、子に固定 box を強制するために `overflow: hidden` を設定する必要もありません。コンポーネントは初期サイズヒントをまだ受け入れますが、絶対真実ではなく開始見積もりとして扱います。

2 つ目の変更は `OverscanCount` のデフォルトです。`Virtualize` は以前、ビューポートの上下に 3 つのアイテムをレンダリングしていました。Preview 3 ではそのデフォルトが 15 に跳ね上がり、ユーザーが未測定の領域にスクロールする前に高さ見積もりを安定化させるのに十分な測定済みアイテムが揃うようになります。

```razor
<Virtualize Items="messages" Context="message" OverscanCount="30">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

`OverscanCount` をさらに上げることは、アイテム高さが激しく異なるフィードのための正当なチューニングノブとなりました。コストは画面外 DOM をより多くレンダリングすることですが、引き換えに滑らかなスクロールと安定したスクロールバーが得られます。

## QuickGrid は古いデフォルトを保つ

`QuickGrid` を使っているなら何も変わりません。コンポーネントは自身の `OverscanCount` を 3 に固定します。グリッド行は意図的に均一で、スクロールティックごとに 30 の隠し行をレンダリングすることは何百列もあるテーブルのパフォーマンスを焼くからです。これは意図的です: 新しいデフォルトは古い仮定が本当に間違っていたコンポーネントを狙います。

## 既存アプリで何を変えるか

可変高さを取り繕うためだけに `ItemSize` の値を設定していたならドロップしてください。測定されたパスがそこでは厳密に優れているからです。子を固定 box に強制するために追加した CSS をすべて監査してください。そして `OverscanCount` をさらに上げる前にスクロールをプロファイルしてください。15 はすでに 3 からの大きな跳躍だからです。

実装は [dotnet/aspnetcore#64964](https://github.com/dotnet/aspnetcore/pull/64964) に住んでいます。[.NET 11 Preview 3](https://dotnet.microsoft.com/download/dotnet/11.0) を手に入れ、次に誰かがチャットログがおかしくスクロールする理由を尋ねたとき、説明すべき回避策が 1 つ減っています。
