---
title: "モデルの挙動を実際に変える CLAUDE.md の書き方"
description: "Claude Code が実際に従う CLAUDE.md ファイルのための 2026 年版プレイブック。200 行という目標、.claude/rules/ にパススコープ付き規則を置く判断、@import の階層と 5 ホップ上限、ユーザーメッセージとシステムプロンプトの差、CLAUDE.md と自動メモリの境界線、そして諦めて hook を書くべきタイミングを扱います。Claude Code 2.1.x を基準とし、公式メモリドキュメントに照らして検証しています。"
pubDate: 2026-04-28
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "developer-workflow"
lang: "ja"
translationOf: "2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour"
translatedBy: "claude"
translationDate: 2026-04-29
---

「効かない」CLAUDE.md は、ほぼ常に次の三つのいずれかを意味します。長すぎて重要なルールが埋もれている、曖昧すぎて検証できない、または CLAUDE.md は設計上アドバイザリーなので本来 hook で書くべき指示になっている、のどれかです。**Claude Code 2.1.x** 時点で、このファイルはシステムプロンプトの後にユーザーメッセージとして context にロードされ、システムプロンプト自体には組み込まれません。これは見落としやすい仕様で、今月 `r/ClaudeAI` や `r/cursor` でよく見る「Claude が私のルールを無視する」系の不満の多くを説明します。良い CLAUDE.md でモデルの挙動は確かに変わりますが、それは Anthropic 自身の[メモリドキュメント](https://code.claude.com/docs/en/memory)が示す通り、ファイルを設定ではなく context として扱った場合に限られます。

要点は次の通りです。200 行未満を目指し、検証可能な具体的指示を書き、トピック別ルールは `paths:` フロントマター付きで `.claude/rules/` に追い出し、再利用可能なワークフローは skill に追い出し、絶対に実行されなければならないものは hook を使ってください。`@imports` は整理のために使えますが、トークンを節約するわけではありません。そして、同じ間違いを 2 回直しても、それを CLAUDE.md の奥に埋めてはいけません。すでに他のルールに負けています。

本記事では Claude Code 2.1.59+(自動メモリを搭載したバージョン)と、基盤モデルとして `claude-sonnet-4-6` または `claude-opus-4-7` を前提とします。パターンは両方で同じように機能しますが、Sonnet は context が埋まるにつれて遵守度が早く落ちるため、肥大化した CLAUDE.md に対してより敏感です。

## 「言った」だけでは足りない理由

公式の[メモリドキュメント](https://code.claude.com/docs/en/memory#claude-isn-t-following-my-claude-md)で最も役立つ一文はこれです。「CLAUDE.md の内容はシステムプロンプトの後にユーザーメッセージとして配信され、システムプロンプト自体の一部としては配信されない。Claude はそれを読み、従おうとはするが、厳密な遵守は保証されない。」これで、「`NEVER use console.log` と書いたのに、それでもやった」というスレッドのすべてに説明がつきます。モデルは CLAUDE.md を、プロンプトの他の部分と同じく、上書き不可の指令ではなく、重み付けされる指示として見ています。

ここから具体的に三つの帰結が出てきます。

1. **テキストが多いほど遵守度は下がります。** ファイルが長いほど、個々のルールは薄まります。公式ドキュメントは「CLAUDE.md ファイル 1 つあたり 200 行未満を目指す。長いファイルは context を多く消費し遵守度を下げる」と推奨しています。
2. **曖昧なルールは丸められます。** 「コードを適切にフォーマットしてください」は、あなたがそう言われた場合と同じくモデルに解釈されます。「合理的な何か」をやるだけです。「2 スペースインデントを使い、import の後を除いて末尾セミコロンを付けない」は、モデルが実際に従える検証可能な指示です。
3. **競合するルールは恣意的に解決されます。** ルートの CLAUDE.md が「常にテストを書け」と言い、サブフォルダの入れ子が「プロトタイプではテストを省略」と言うと、モデルはどちらかを選び、どちらを選んだかは教えません。

本当に上書き不可の指示が必要であれば、選択肢は 2 つあります。1 つは `--append-system-prompt` で、これはテキストをシステムプロンプト自体に入れます。[CLI リファレンス](https://code.claude.com/docs/en/cli-reference#system-prompt-flags)によれば毎回の起動で渡す必要があり、スクリプトや CI には向きますが、対話的な利用には不向きです。2 つ目、そしてほぼ常により良い選択肢は hook で、これは後ほど扱います。

## CLAUDE.md に入れるべきもの、入れないもの

Anthropic 自身の[ベストプラクティスガイド](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md)には、コンパクトな include/exclude 一覧があり、私はこれを自分が触るすべてのプロジェクトにコピーしています。書き直して凝縮すると次のようになります。

**含める**: `package.json` や `Cargo.toml` から Claude が推測できない bash コマンド、言語の既定とは異なるコードスタイル規則、実際に使ってほしい test runner、ブランチや PR の規約、コードを読んでも明らかでないアーキテクチャ上の決定、そして「postgres のテストコンテナは `POSTGRES_HOST_AUTH_METHOD=trust` がないとマイグレーションがハングする」のような落とし穴。

**含めない**: `tsconfig.json` から Claude が読み取れる事項、すべての開発者が知っている framework の慣習、コードベースのファイル単位の説明、コードが現状に至った経緯、そして「クリーンなコードを書く」のような自明な原則。ベストプラクティス文書はストレートです。「肥大化した CLAUDE.md ファイルは、Claude にあなたの実際の指示を無視させる。」追加する 1 行ごとに、残りに対する S/N 比が下がります。

このフィルターを生き延びた、Next.js + Postgres バックエンド向けの CLAUDE.md は次のように見えます。

```markdown
# Project: invoice-api
# Claude Code 2.1.x, Node 22, Next.js 15

## Build and test
- Use `pnpm`, never `npm` or `yarn`. The lockfile is committed.
- Run `pnpm test --filter @app/api` for backend tests, NOT the full workspace.
- Migrations: `pnpm db:migrate` only inside the `apps/api` workspace.

## Code style
- Use ESM (`import`/`export`). Default export is forbidden except in
  Next.js page/route files where the framework requires it.
- Zod schemas for every external input. No `any`, no `as unknown as T`.

## Architecture
- Database access goes through `apps/api/src/db/repositories/`.
  Do not call `db.query` from route handlers.
- All money is `bigint` cents. Never `number`, never decimals.

## Workflow
- After a code change, run `pnpm typecheck` and `pnpm test --filter @app/api`.
- Commit messages: imperative, no scope prefix, max 72 chars on the title.
```

これで 17 行、PR テンプレートに残されていた繰り返しの指摘をすべて押さえています。書かれていないものに注目してください。「常にクリーンなコードを書く」もなく、「セキュリティに気を付ける」もなく、「TypeScript の strict mode を使う」もありません(`tsconfig.json` にあり、モデルが見られます)。各行は「これを取り除けば測定可能な間違いが起きるか?」に「はい」と答えます。

## 200 行の上限と `.claude/rules/`

200 行を超えたら、公式メモリドキュメントはトピック固有の指示を `.claude/rules/` 配下に分割し、各ファイルを glob にスコープする YAML フロントマターを付けることを推奨します。

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.tsx"
---

# API endpoint conventions

- Every route under `src/api/` exports a `POST`, `GET`, `PUT`, or `DELETE`
  function. Never a default export.
- Validate the body with the matching Zod schema in `src/api/schemas/`
  before doing anything else. If no schema exists, write one first.
- Return errors with `Response.json({ error }, { status })`. Do not throw.
```

`paths:` 付きルールは、Claude がいずれかの glob にマッチするファイルを読んだときに限り context にロードされます。100 行のルールファイルを 10 個持つコストは、1000 行の CLAUDE.md 1 個よりずっと小さくなります。任意のタスクで 9 個は context に入らないからです。`paths:` のないルールは `.claude/CLAUDE.md` と同じ優先度で毎セッションロードされるので、すべてのファイルに本当に当てはまる場合を除き、習慣的にそこに置かないでください。

ここはまた「CLAUDE.md へのスコープクリープ」が死ぬ場所でもあります。チームメイトが、ある obscure なマイグレーションツールについて 12 行追加することを提案したら、答えは「それは `paths: ['db/migrations/**/*.sql']` 付きで `.claude/rules/migrations.md` に行くべきだ」であり、「あとで削ろう」ではありません。あとで削ることはありません。

## Imports、階層、5 ホップ上限

`@path/to/file` の import 構文は整理のためであり、トークン節約のためではありません。[ドキュメント](https://code.claude.com/docs/en/memory#import-additional-files)から: 「import されたファイルは、参照元の CLAUDE.md と一緒に起動時に展開され context にロードされる。」600 行の CLAUDE.md を 50 行のルートと 550 行の `@docs/conventions.md` に分割しても、モデルは 600 行を見ています。

import が役立つのは特定の三つのケースです。

1. **2 つのリポジトリで同じ指示を再利用する**コピペなしの方法。`~/shared/team-conventions.md` から共有ファイルを symlink するか import します。
2. **コミットすべきでない開発者ごとの上書き**。`@~/.claude/my-project-instructions.md` を使えば、個人設定をホームディレクトリに保ちつつ、全員が git からチームの CLAUDE.md を受け取れます。
3. **`AGENTS.md` への橋渡し**。リポジトリに他のコーディングエージェント用のものがすでにある場合です。ドキュメントは `@AGENTS.md` の後に Claude 固有の上書きを置くことを明示的に推奨しています。

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

import は再帰的に**最大 5 ホップの深さ**まで解決されます。それを超えると import は黙って捨てられます。CLAUDE.md がファイルを import し、そのファイルがファイルを import し、それがさらに 4 回続くと、脆いものを作っています。フラットにしてください。

階層自体は加算的で上書きではありません。プロジェクト CLAUDE.md、ユーザー CLAUDE.md(`~/.claude/CLAUDE.md`)、作業ディレクトリからディレクトリツリーを上っていく途中の任意の CLAUDE.md がすべて連結されます。`CLAUDE.local.md`(gitignore 済み)は同階層の `CLAUDE.md` の後にロードされるので、競合時はあなたの個人メモが勝ちます。モノレポで隣接チームの CLAUDE.md を context に含めたくない場合、[`claudeMdExcludes` 設定](https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files)は glob パターンのリストを取ります。

```json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/marius/monorepo/other-team/.claude/rules/**"
  ]
}
```

これを `.claude/settings.local.json` に置けば、除外設定はチームではなくあなたのものになります。

## CLAUDE.md は「あなたの要件」、自動メモリは「Claude が気付いたこと」

Claude Code 2.1.59 は自動メモリを追加しました。あなたの修正に基づいて Claude が自分自身について書いたメモです。これは `~/.claude/projects/<project>/memory/MEMORY.md` にあり、CLAUDE.md と同じ仕組みでロードされますが、セッション開始時に `MEMORY.md` の最初の 200 行または 25KB のみが取り込まれる点が違います。ディレクトリの残りはオンデマンドで読まれます。

この区別を整理する最もきれいな方法は次の通りです。

- **CLAUDE.md** は初日から強制したいルールを保持します。「フルスイートではなく `pnpm test --filter @app/api` を実行する」など。あなたが書き、コミットし、チームが見ます。
- **自動メモリ** は Claude が気付いたパターンを保持します。「ユーザーは `jest` より `vitest` を好み、`jest.config.js` を生成したときに修正された」など。Claude が書き、マシン単位で、git にはありません。

この区別から二つの実用ルールが出てきます。第一に、自動メモリの項目を「念のため」CLAUDE.md に複製しないでください。自動メモリも毎セッションロードされます。第二に、自動メモリにチーム全員が知るべきパターンが蓄積したら昇格させてください。`MEMORY.md` を開き、その項目を CLAUDE.md にコピーすると、`/memory` で元を削除できます。昇格は「Claude が私についてそう観測した」が「私たちはチームとしてそう決めた」に変わる瞬間です。

この分割について詳しくは、[Claude Code ルーチンを定期実行する方法](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)の記事で、ループに人間がいない自律実行で何が生き残るかを扱っており、CLAUDE.md が実際に自己完結しているかの有用なストレステストになります。

## 遵守度の調整

ファイルが短く具体的になったら、ドキュメントとフィールドレポートが収束する三つのテクニックでさらに遵守を引き出せます。

1. **強調は控えめに使う。** 公式ガイダンスは「指示を強調(`IMPORTANT` や `YOU MUST` など)で調整して遵守度を上げる」です。控えめに、が要点です。すべてが `IMPORTANT` なら、何も `IMPORTANT` ではありません。違反すれば実際にビルドを壊す、あるいは on-call を起こすルールにのみ強調を取っておきます。
2. **動詞を先頭、その後に制約。** 「`src/` のコードを変更したら毎回 `pnpm typecheck` を実行する」は「型チェックは定期的に実施されるべきである」よりも信頼性高く守られます。前者は行動、後者は雰囲気です。
3. **ルールを失敗モードと同じ場所に置く。** 「route handler から `db.query` を呼ばない。コネクションプールはリクエストごとで、route handler はリークする。代わりに `repositories/` を使う。」失敗モードがルールをセッションをまたいで粘着させる材料です。

同じ間違いを 2 回直しても、すでに CLAUDE.md にルールがある場合、追加するのは正解ではありません。なぜ既存のルールが勝てていないかを問うのが正解です。原因はだいたい、ファイルが長すぎる、2 つのルールが矛盾している、あるいは指示が hook を必要とする種類のもの、のいずれかです。

## CLAUDE.md を諦めて hook を書くべきとき

CLAUDE.md はアドバイザリーです。hook は決定論的です。[hook ガイド](https://code.claude.com/docs/en/hooks-guide)から、hook は「Claude のワークフロー上の特定のポイントで自動的に実行されるスクリプト」であり、「アクションが必ず起きることを保証する」ものです。あなたのルールが「絶対に例外なく実行されなければならない」カテゴリにあるなら、それは CLAUDE.md には属しません。

`PostToolUse` hook で各ファイル編集の後に Prettier を走らせる方が、CLAUDE.md に「編集後は常に Prettier を実行する」と書くよりも信頼できます。「`migrations/` への書き込みをブロック」も同様で、こちらは deny パターンを持つ `PreToolUse` hook になります。同じパターンが、より広い [Visual Studio 2026 のエージェントスキル](/ja/2026/04/visual-studio-2026-copilot-agent-skills/)の話を実用化させます。skill が柔らかい指示で、hook が硬いガードレールです。

ここは CLAUDE.md と skill の境界線について考える適切な瞬間でもあります。CLAUDE.md の指示はセッションごとにロードされ、広く適用されます。`.claude/skills/SKILL.md` の skill は、モデルがタスクを関連あると判断したときにオンデマンドでロードされるので、副作用を伴う深いワークフロー知識(PR を開く「fix-issue」ワークフローなど)はそこに属します。同じロジックは、巨大だがコードベースの一部にしか関係しない指示にも当てはまります。それらはパススコープ付きルールを欲しがり、CLAUDE.md ではありません。

## 実際にロードされているものを診断する

モデルが間違ったことをしている場合、最初の手は実際に何を見ているかを確認することです。Claude Code セッション内で `/memory` を実行してください。現在ロードされているすべての CLAUDE.md、CLAUDE.local.md、ルールファイルとそのパスが表示されます。期待していたファイルがリストにない場合、会話の残りは関係ありません。Claude には見えないからです。

パススコープ付きルールや、サブディレクトリで遅延ロードされる CLAUDE.md ファイルについては、[`InstructionsLoaded` hook](https://code.claude.com/docs/en/hooks#instructionsloaded) が Claude が指示を取り込むたびに発火します。ロガーに繋ぎ、`paths:` の glob が実際にマッチしたかを確認したり、なぜ入れ子の CLAUDE.md が `/compact` 後に再ロードされないかをデバッグしたりしてください。`/compact` のケースは既知の鋭いエッジで、プロジェクトルートの CLAUDE.md は `/compact` 後に再注入されますが、入れ子のものはそのサブディレクトリで次にファイル読み込みが起きたときにのみ再ロードされます。入れ子の CLAUDE.md に依存していて、セッションの途中で指示が失われたように見えるなら理由はそれです。

もう一つ知っておく価値のある診断: HTML ブロックコメント(`<!-- like this -->`)は注入前に CLAUDE.md から取り除かれます。トークンコストを払わずに人間専用のメモ(`<!-- last reviewed 2026-04 -->` のような行)に使えます。

## 関連

- [GitHub issues のトリアージを行う Claude Code の定期タスクを設定する方法](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) は、自律実行のために CLAUDE.md に必要なものを扱います。
- [Claude Code 2.1.119: GitLab と Bitbucket での PR から起動](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) は「クラウドセッションで指示はどこに住むのか」という関連する問いを扱います。
- [Visual Studio 2026 Copilot エージェントスキル](/ja/2026/04/visual-studio-2026-copilot-agent-skills/) は Microsoft 側で最も近い類似物です。skill ファイル対永続的 context。
- [TypeScript で MCP サーバーを作る](/ja/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) は「CLAUDE.md にルールを増やす」よりも「ツールをエージェントに公開する」方が良い回答であるケース向けです。

## 出典

- 公式: [Claude がプロジェクトをどう記憶するか](https://code.claude.com/docs/en/memory)(Claude Code のメモリと CLAUDE.md ドキュメント)。
- 公式: [Claude Code のベストプラクティス](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md)。
- 公式: [hook リファレンス](https://code.claude.com/docs/en/hooks-guide) と [`InstructionsLoaded` hook](https://code.claude.com/docs/en/hooks#instructionsloaded)。
- フィールドノート: [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)(HumanLayer)。
