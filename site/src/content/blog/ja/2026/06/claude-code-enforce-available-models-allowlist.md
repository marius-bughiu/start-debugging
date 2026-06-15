---
title: "Claude Code 2.1.175 が enforceAvailableModels で availableModels の抜け穴をふさぐ"
description: "数か月のあいだ availableModels はモデルピッカーを制限していましたが、Default オプションは野放しのままでした。Claude Code 2.1.175 は enforceAvailableModels を追加し、管理者がついに厳格なモデル許可リストを固定できるようにします。"
pubDate: 2026-06-15
tags:
  - "claude-code"
  - "ai-agents"
  - "governance"
lang: "ja"
translationOf: "2026/06/claude-code-enforce-available-models-allowlist"
translatedBy: "claude"
translationDate: 2026-06-15
---

組織として `availableModels` を標準化し、開発者が実行できる Claude モデルを制御していた場合、その柵にはずっと静かな穴が開いていました。この許可リストは `/model`、`--model` フラグ、`ANTHROPIC_MODEL`、サブエージェント、アドバイザーのオーバーライドを管理していましたが、すべてのピッカーが表示する 1 つのオプションには一切触れていませんでした。Default です。開発者は Default を選ぶだけで、自分のティアのシステムデフォルトが何であれそこに着地でき、丁寧に作り込んだリストをそのまま素通りできたのです。2026-06-12 に出荷された Claude Code 2.1.175 は、新しい管理対象設定である `enforceAvailableModels` によって、ついにそのギャップをふさぎます。

## なぜ Default が漏れ道だったのか

`availableModels` は常に、*名前付き* モデルのための許可リストでした。Default エントリは特別です。これはモデルのエイリアスではなく、アカウントティアのランタイムデフォルトに解決されます (Anthropic API では Max と従量課金で Opus 4.8、サブスクリプションシートでは Sonnet 4.6、といった具合です)。Default は名前付きリストを回避するため、次のように設定した管理者でも、

```json
{
  "availableModels": ["claude-sonnet-4-5", "haiku"]
}
```

ユーザーが Default を選択して最新ティアのモデルを使うのを止めることはできませんでした。コストやコンプライアンス上の理由で特定のバージョンに固定しているチームにとって、これは理論上ではなく実際のバイパスでした。

## enforceAvailableModels が実際に行うこと

空でない `availableModels` リストとあわせて、管理対象設定またはポリシー設定で `true` に設定します。ティアデフォルトが許可リストに含まれていない場合、Default はティアデフォルトの代わりに最初の許可エントリへ解決されるようになります。

```json
{
  "model": "claude-sonnet-4-5",
  "availableModels": ["claude-sonnet-4-5", "haiku"],
  "enforceAvailableModels": true,
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5"
  }
}
```

この 2 つの設定は異なるスコープをカバーします。`enforceAvailableModels` は Default に許可リストへ従わせ、一方で `env` ブロックは `sonnet` のような許可されたエイリアスがどのバージョンに解決されるかを固定します。覚えておく価値のある注意点が 1 つあります。空の `availableModels: []` は決して強制を有効にしないため、`enforceAvailableModels` が何を言おうとユーザーは自分のティア Default を保持します。

## 2.1.176 での堅牢化パス

その翌日、2.1.176 が隣接する 2 つのエッジをふさぎました。エイリアスのモデル選択は `ANTHROPIC_DEFAULT_*_MODEL` 環境変数を通じてブロック済みモデルへリダイレクトできなくなり、`/fast` は切り替え先が許可リスト外のモデルになる場合にトグルを拒否するようになりました。

同じくらい重要なのがマージの挙動です。`availableModels` が管理対象設定またはポリシー設定で設定されている場合、その値はマージ結果を完全に置き換えます。ユーザー設定やプロジェクト設定で追加されたエントリでそれを広げることはできず、`enforceAvailableModels` も同じように置き換えられます。2.1.175 時点では、これが厳格な許可リストを強制する唯一の方法です。それ以前のバージョンでは管理対象リストが優先度の低いエントリとマージされていたため、開発者がこっそりそこに追記できてしまいました。

チームをまたいで Claude Code を運用しており、実際にどのモデルが実行されるかを気にかけているなら、2.1.175 以降にアップグレードし、`availableModels` と `enforceAvailableModels` を組み合わせてください。完全な優先順位ルールは [モデル設定のドキュメント](https://code.claude.com/docs/en/model-config) にあります。
