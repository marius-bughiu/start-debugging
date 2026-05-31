---
title: "Claude Code の Dynamic Workflows は 1 つのプロンプトを最大 1000 のサブエージェントに展開します"
description: "Anthropic は 2026-05-28 に Opus 4.8 を Dynamic Workflows とともにリリースしました。これは Claude Code 内のリサーチプレビューで、JavaScript のオーケストレーションスクリプトを書き、数十から数百のサブエージェントを並列実行します（1 回の実行あたり最大 1000）。"
pubDate: 2026-05-31
tags:
  - "claude-code"
  - "ai-agents"
  - "opus-4-8"
lang: "ja"
translationOf: "2026/05/claude-code-dynamic-workflows-opus-4-8"
translatedBy: "claude"
translationDate: 2026-05-31
---

Anthropic は 2026-05-28 に Claude Opus 4.8 をリリースしましたが、ターミナルで過ごす人にとっての見出しはベンチマークの向上ではありません。Dynamic Workflows です。これは Claude Code 内のリサーチプレビューで、自然言語による 1 つのリクエストを、数十から数百のサブエージェントを並列にオーケストレーションするスクリプトへと変えます（1 回の実行あたり最大 1000 エージェント）。これは、1 つのエージェントにループでタスクをこなさせるのと、Claude にタスクを分解し、展開し、報告する前に結果を検証するプログラムを書かせるのとの違いです。

## workflow はチャットループではなくスクリプトです

面白いのはその仕組みです。大きなもの（「すべてのコントローラーで認可チェックの欠落を監査して」や「この 20 万行のコードベースを Newtonsoft.Json から移行して」）を依頼すると、Claude は JavaScript のオーケストレーションスクリプトを書き、ランタイムがそれをバックグラウンドで実行します。少しずつ埋まっていく 1 つのコンテキストウィンドウを世話する必要はありません。スクリプトはそれぞれ独自のコンテキストを持つ新しいサブエージェントを生成し、その構造化された出力を収集します。

生成されるスクリプトの形はおおよそ次のとおりです。

```javascript
export const meta = {
  name: 'audit-authz',
  description: 'Find controllers missing [Authorize] and verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Verify' }],
};

// Fan out: one finder per area, then adversarially verify each hit
const findings = await pipeline(
  AREAS,
  area => agent(`Scan ${area} for actions missing authorization`, {
    phase: 'Scan',
    schema: FINDINGS_SCHEMA,
  }),
  review => parallel(review.findings.map(f => () =>
    agent(`Try to refute: ${f.title}. Is this really unprotected?`, {
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    }).then(v => ({ ...f, verdict: v }))
  ))
);

return findings.flat().filter(f => f.verdict?.isReal);
```

Anthropic が依拠するパターンはここに見て取れます。並列の展開、続いて敵対的検証で、別々のエージェントが各検出結果を反証するよう促され、生き残ったものだけが残ります。出力は JSON スキーマに対して検証されるため、オーケストレーターはパースが必要な散文ではなく型付きデータを受け取ります。

## コストと、いつ起動するか

明らかなリスクはコストです。正当に数百のエージェントを起動する実行はトークンを急速に消費します。これこそが、暴走に対する歯止めとして 1000 エージェントの上限が存在する理由です。Claude Code は最初の workflow が起動する前にスクリプトとおおまかな計画を表示し、確認を求めます。

入り方は 2 通りあります。目標を直接記述して workflow が妥当かどうかを Claude に判断させるか、`ultracode` の effort 設定をオンにして、大きなタスクで自動的にオーケストレーションに踏み切らせることができます。Opus 4.8 にはより安価な Fast mode（標準レートの約 2 倍で、速度は約 2.5 倍）も含まれており、多数の小さなエージェントというパターンが以前のリリースよりも痛みの少ないものになっています。

Dynamic Workflows はリサーチプレビューなので、API の表面は不安定なものとして扱い、使用量に目を配ってください。しかし、その根底にあるモデルは堅実です。1 つのエージェントを伸びていくトランスクリプトに対して反復させるのをやめ、短命なエージェントを多数調整するプログラムを書き始めましょう。詳細は [Opus 4.8 の発表](https://www.anthropic.com/news)と [Claude Code の changelog](https://code.claude.com/docs/en/changelog) にあります。
