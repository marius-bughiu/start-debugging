---
title: "Claude Code 2.1.261 の /skill-doctor: コンテキストを消費するだけの skill を見つける"
description: "skill の本体は必要になったときに読み込まれますが、名前と説明は常にプロンプトに入る一覧に置かれ、その一覧はコンテキストウィンドウの 1% に制限されています。Claude Code 2.1.261 は /skill-doctor を追加し、読み込まれているのに使われていない skill とそのコストを示します。実際に使っている skill が予算から追い出される前に整理できます。"
pubDate: 2026-09-05
tags:
  - "claude-code"
  - "agent-skills"
  - "ai-agents"
  - "context-window"
lang: "ja"
translationOf: "2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context"
translatedBy: "claude"
translationDate: 2026-09-05
---

Claude Code 2.1.261 が 9 月 4 日にリリースされ、`~/.claude/skills` がいっぱいの人がこれまで答えられなかった問いに応える小さなコマンドが入りました。`/skill-doctor` は、読み込まれているのに使われていない skill と、それぞれがコンテキストでいくらかかっているかを表示し、整理できるようにします。このコマンドはまだ[コマンドリファレンス](https://code.claude.com/docs/en/commands)に載っていませんが、レポートの対象となる仕組み自体はドキュメント化されており、出力を読む前に理解しておく価値があります。

## 一度も呼び出さない skill は無料ではありません

よくある理解は、skill は遅延読み込みなので安い、というものです。これは半分だけ正しいです。`SKILL.md` の本体は、skill が呼び出されたときにだけ会話に入ります。名前と説明は違います。Claude Code は、モデルが何を使えるか把握できるように、すべての skill の名前と説明の一覧をコンテキストに読み込みます。

この一覧には固定の予算があります。[skill のドキュメント](https://code.claude.com/docs/en/skills)によれば "scales at 1% of the model's context window" であり、各エントリの説明テキストは合計 1,536 文字が上限です。一覧が予算を超えると、Claude Code は呼び出し回数の少ない skill から順に説明を落としていきます。

つまり、使われていない skill は自分のトークン以上のコストになります。あなたが頼っている skill と共通の予算を奪い合い、削られた説明は、モデルがリクエストと結び付けるために必要なキーワードをまさに失います。結果として、その skill は理由を説明するエラーもないまま、静かに発動しなくなります。`/doctor` はすでに一覧全体のコストと主な要因を見積もっていましたが、2.1.261 は skill 単位の使用済みと未使用の内訳を独立したレポートに切り出しました。

## レポートを設定に落とし込む

どのエントリが無駄かわかったら、`.claude/settings.json` の `skillOverrides` で、共有リポジトリの `SKILL.md` に手を入れずに可視性を変えられます。

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "user-invocable-only",
    "old-migration-helper": "off"
  }
}
```

`"name-only"` は skill を一覧に残したまま説明を落とし、予算を空けます。`"user-invocable-only"` はモデルから隠しつつ、`/deploy` を自分で入力する経路は残します。`"off"` は両方から隠します。自分の skill であれば、frontmatter の `disable-model-invocation: true` が同等で、説明をコンテキストから完全に取り除きます。なお、プラグインの skill は `skillOverrides` の対象外です。そちらは `/plugin` で管理します。

どの skill も居場所に値するとレポートが示すなら、削るのではなく上限を上げます。`skillListingBudgetFraction` は割合を取り (2% なら `0.02`)、`SLASH_COMMAND_TOOL_CHAR_BUDGET` は固定の文字数を取り、`skillListingMaxDescChars` はエントリごとの 1,536 文字の上限を動かします。その後は `/context` の Skills 行で確認してください。v2.1.196 以降、この行は全文ではなく予算適用後の一覧サイズを報告します。

同じリリースには、知っておく価値のあるコンテキスト調整がもう 2 つあります。`bashOutputMaxChars` と `taskOutputMaxChars` は、コマンドやバックグラウンドタスクの出力がファイルに退避される前に Claude がインラインで受け取る量を最大 128K 文字まで引き上げます。`--append-subagent-system-prompt-file` は、コマンドラインに渡すには大きすぎるサブエージェントのシステムプロンプトをファイルから読み込みます。リリースの流れに追いついていないなら、その 2 日前の [2.1.259 では managedMcpServers が追加されました](/ja/2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm/)。

詳細は [Claude Code の changelog](https://code.claude.com/docs/en/changelog) にあります。
