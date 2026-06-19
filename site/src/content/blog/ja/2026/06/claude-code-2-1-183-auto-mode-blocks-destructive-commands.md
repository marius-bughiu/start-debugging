---
title: "Claude Code 2.1.183 は自動モードによる破壊的な Git および IaC コマンドの実行を阻止します"
description: "Claude Code v2.1.183 (2026-06-19) は、あなたが要求しない限り自動モードでの git reset --hard、git clean -fd、terraform/pulumi/cdk destroy をブロックし、1 回の悪いターンが未コミットの作業を消し去るエージェント的な抜け穴をふさぎます。"
pubDate: 2026-06-19
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "ja"
translationOf: "2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands"
translatedBy: "claude"
translationDate: 2026-06-19
---

Claude Code v2.1.183 は 2026-06-19 にリリースされ、その目玉は、自動モードが登場したその日に存在すべきだったガードレールです。エージェントは、いくつかの取り消し不能なコマンドを自分の判断では実行できなくなりました。あなたが明示的に `git reset --hard` を要求していなければ、モデルはタスクの途中でそれが必要だと判断することを許されません。

## これがふさぐ失敗パターン

自動モード (以前の YOLO 風の「とにかくやれ」の経路) では、エージェントがコマンドごとの承認プロンプトなしでシェルコマンドを実行できます。これは `dotnet build`、`dotnet test`、編集のループにはまさに望ましい挙動です。しかし、混乱したリファクタリングのあとにモデルが「クリーンな状態に戻ろう」として `git reset --hard` に手を伸ばし、1 時間分の未コミットの作業を消してしまったり、間違ったスタックに対して `terraform destroy` を実行してしまったりするのは、まさに望ましくない挙動です。

新しいリリースは一線を引きます。破壊的で元に戻しにくいコマンドは、それらを引き起こしたリクエストがそのアクションを明示的に指定していない限り、自動モードでブロックされます。2.1.183 でブロックされる対象は次のとおりです。

```bash
# Blocked in auto mode unless you asked for them
git reset --hard
git checkout -- .
git clean -fd
git stash drop

# Blocked for commits the agent did not make this session
git commit --amend

# Blocked unless a specific stack is named
terraform destroy
pulumi destroy
cdk destroy
```

この区別は意図に基づくものであり、一律の禁止ではありません。あなたのプロンプトが「`git reset --hard` で作業ツリーをリセットして」と言えば、エージェントはそれを実行します。エージェントが独自にリセットが最善だと結論づけた場合は、代わりに停止してあなたに知らせます。インフラストラクチャでも同様です。あなたが指定した特定のスタックを対象とする `terraform destroy` は許可されますが、引数のない `destroy` は許可されません。

## なぜ amend が特別扱いされるのか

`git commit --amend` のルールは微妙なものです。エージェント自身がそのセッションで先に作成したコミットを修正するのは問題ありません。これは自分の作業を反復する通常の挙動です。エージェントが作成していないコミットを修正することは、自分のものではない履歴を書き換えることになり、チームメイトのコミットやセッション以前のあなたの作業を静かに上書きしてしまう恐れがあります。分類器は、これを許可する前にセッション内での作成者を確認するようになりました。

これは以前のセキュリティ作業と自然に組み合わさります。[v2.1.169 の `--safe-mode`](/ja/2026/06/claude-code-2-1-169-safe-mode-and-cd/) はデバッグの基準となるクリーンなベースラインを与え、そして今や自動モード自体が、あなたのデータを失う原因になることを拒むようになりました。エージェントにこれらのいずれかを要求なしで実行させる必要が本当にあるなら、プロンプトでそう述べるか、そのステップだけ自動モードを抜けて手動で承認するのが正しい進め方です。

## リリースのその他の内容

2.1.183 では、置き換えられたモデルを要求したときに非推奨の警告が表示される機能 (print モードでは stderr に、エージェントの frontmatter に表示) も追加されました。さらに、claude.ai のセッションリンクをコミットや PR に含めないようにする新しい `attribution.sessionUrl` 設定や、短縮キーの一覧を表示する `/config --help` も加わっています。バグ修正は、サブエージェントで WebSearch が空を返す問題、Windows Terminal でのフルスクリーン TUI の破損、そして思考ブロックのみが生成されたときにターンが静かに完了してしまう問題などをカバーしています。

完全なノートは [v2.1.183 の changelog](https://code.claude.com/docs/en/changelog) にあります。
