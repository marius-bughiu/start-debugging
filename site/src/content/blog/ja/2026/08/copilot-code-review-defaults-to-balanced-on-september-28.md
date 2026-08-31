---
title: "Copilot Code Review は 9 月 28 日に既定で Balanced になります"
description: "2026-08-27 と 2026-08-28 の GitHub changelog は、レビューの 20,000 行上限を撤廃し、ボットが作成した PR のレビューを開始し、9 月 28 日に既定の労力レベルを Lite から Balanced へ切り替えます。3 つとも同じ月に AI クレジットの消費を押し上げます。"
pubDate: 2026-08-31
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "ja"
translationOf: "2026/08/copilot-code-review-defaults-to-balanced-on-september-28"
translatedBy: "claude"
translationDate: 2026-08-31
---

GitHub は 2 日続けて changelog を公開しました。あわせて読むと、Copilot code review が何を見るのかと、いくらかかるのかの両方が変わります。2026-08-27 にレビューのサイズ上限が撤廃され、ボットが作成した pull request がレビュー対象になりました。2026-08-28 には、**2026-09-28** に既定の労力レベルが Lite から Balanced へ切り替わることが告知されました。どちらもオプトインではありません。

## 同じ月に 3 つの乗数が重なります

2026-08-27 のエントリ [Copilot code review: resolution reasons and expanded capabilities](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/) は、これまでレビューを 300 ファイルまたは 20,000 行で打ち切っていた上限を撤廃しました。Copilot が黙って飛ばしていた大規模なリファクタリングや生成コードの PR も、全体がレビューされます。同じエントリで、ボットが作成した pull request が自動レビューの対象になりました。Copilot cloud agent も明示的に含まれるため、エージェントが開いた PR は人間のキューに直行せず、レビュアーを通るようになります。

続く[ポリシーと課金に関するエントリ](https://github.blog/changelog/2026-08-28-upcoming-changes-to-github-copilot-policies-and-billing/)が既定の労力レベルを変更します。GitHub 自身のドキュメントはトレードオフを率直に書いています。Lite は "standard review" であり、Balanced は "deeper analysis of complex logic, security-sensitive code, and cross-service changes" を行い、Balanced のレビューは "use more AI credits, and may consume marginally more GitHub Actions minutes." とされています。

レビューされる PR が増え、1 回あたりの diff が大きくなり、その一つひとつでモデルの処理が深くなります。7 月の請求書をもとに AI クレジットを見積もっていたなら、9 月は同じ数字になりません。

## 現在の挙動を保ちたい場合は 9 月 28 日までに Lite を固定してください

労力レベルは組織スコープとリポジトリスコープの両方にあり、リポジトリ側が優先されます。Settings、次に Copilot、次に Code review、"Code, planning, and automation" の下です。2026-09-28 より前に明示的に Lite を選べば現在の挙動が保たれ、触らずに放置すると Balanced になります。

同時に確認しておきたいのが、ruleset の `review_on_push` フラグです。push のたびに再レビューが走るため、深くなった既定値に対して加算ではなく乗算で効いてきます。ルールの型は `copilot_code_review` なので、すべてのリポジトリを画面で開かなくても確認できます。

```bash
gh api /repos/OWNER/REPO/rulesets --jq '.[].id' \
  | xargs -I{} gh api /repos/OWNER/REPO/rulesets/{} \
      --jq '.rules[] | select(.type=="copilot_code_review")'
```

push のたびに発火するルールは次のようになります。

```json
{
  "type": "copilot_code_review",
  "parameters": {
    "review_on_push": true,
    "review_draft_pull_requests": true
  }
}
```

レビュー依頼の前に 6 回 push するブランチでは、`review_on_push` と `review_draft_pull_requests` の組み合わせは、まだ誰も見ていない diff に対する 6 回分の Balanced レビューになります。

## resolution reasons でコメントがようやく測定可能になります

明確に良い変更が 1 つあります。Copilot のレビューコメントを解決するとき、"Resolve conversation" の隣のドロップダウンから理由を選ぶようになりました。選択肢は **Addressed**、**Won't fix**、**Incorrect** です。重要なのは 3 つ目です。自動レビューの誤検知率が、シニアエンジニアの感覚ではなく、取り出せる数値になるのはこれが初めてだからです。すべてのリポジトリで Balanced を解き放つ前に、Lite のまま 1 スプリント理由を記録して、実際の比率を確かめてください。

同じエントリにある残り 2 つの日付です。Business と Enterprise の新規シート割り当ては 2026-09-01 からアクセス前の支払いが必要になり、既存顧客は 2026-10-01 からシート料金が前払いになります。そして 2026-09-28 に登場する統合 Copilot 体験は、チャットデータの保持期間を 28 日からアカウントの存続期間へ延長します。最後の項目は既定で有効で、オプトアウトすると github.com とモバイルの Copilot Chat を完全に失うため、好みの設定ではなくコンプライアンス上の判断になります。

同じ製品のレビューコンテキスト側については [Copilot code review が .github/skills フォルダーを読むようになりました](/ja/2026/07/copilot-code-review-agent-skills-and-mcp-ga/) を参照してください。
