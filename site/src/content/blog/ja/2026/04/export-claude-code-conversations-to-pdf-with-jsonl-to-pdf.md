---
title: "jsonl-to-pdf で Claude Code の会話を PDF にエクスポートする"
description: "Claude Code が ~/.claude/projects/ 以下に書き出す JSONL ファイルを、jsonl-to-pdf で共有可能な PDF に変換する実用ガイドです。サブエージェントのネスト、シークレットの墨消し、コンパクトテーマ／ダークテーマ、CI 向けのバッチレシピを扱います。"
pubDate: 2026-04-29
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
  - "pdf"
lang: "ja"
translationOf: "2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf"
translatedBy: "claude"
translationDate: 2026-04-29
---

Claude Code との会話はすべて `.jsonl` ファイルとして `~/.claude/projects/` の奥に保存されます。1 ターンにつき 1 行、フル忠実度、レンダリングなしの形式です。`jsonl-to-pdf` はこれらのファイルを PDF に変換する小さな CLI で、ビューアーで読んだり、プルリクエストに添付したり、Slack スレッドに貼ったり、実際に紙に印刷したりできます。最新セッションで試すいちばん速い方法は `npx jsonl-to-pdf` です。インタラクティブなピッカーが開き、サブエージェントの会話を含めるかどうかを尋ね、タイトル付きの PDF をカレントディレクトリに書き出します。

この記事では、JSONL ファイルがどこから来るのか、PDF に実際に何が含まれるのか（インラインでネストされたサブエージェント、思考ブロック、ツール呼び出しと結果、画像添付）、外部に共有するときに知っておくべきフラグ（`--compact`、`--redact`、`--no-thinking`、`--subagents-mode appendix`、`--dark`）、それに CI と自動化のレシピをいくつか扱います。対象バージョンは Claude Code 2.1.x に対する `jsonl-to-pdf` 0.1.0 です。リポジトリは [GitHub](https://github.com/marius-bughiu/jsonl-to-pdf)、パッケージは [npm](https://www.npmjs.com/package/jsonl-to-pdf) にあります。

## Claude Code が会話を保存している場所

Claude Code は 1 セッションにつき 1 つの JSONL ファイルを `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` に書き出します。`<encoded-cwd>` の部分は、そのセッションが実行された作業ディレクトリで、パス区切り文字を `-` に置き換えたものです。たとえば Windows の `C:\S\my-app` は `C--S-my-app` に、macOS や Linux の `/Users/marius/work` は `-Users-marius-work` になります。各行は JSON オブジェクトで、ユーザーターン、アシスタントターン、ツール呼び出し、ツール結果、思考ブロック、あるいは `cwd`、`gitBranch`、`aiTitle`、`permissionMode` などのセッションメタデータが入ります。

サブエージェントの会話（メインエージェントが `Task`/`Agent` ツール経由で起動したセッション）は、隣のディレクトリに置かれます。`<session-id>/subagents/<sub-session-id>.jsonl` です。これら自体も独立した完全なセッションで、各々の JSONL ストリームを持ち、メインファイル内のツール呼び出しに ID で紐づいています。このネストは実際には再帰的で、自身のサブエージェントを起動するサブエージェントは、2 つ目の隣に 3 つ目のファイルを残します。

このレイアウトが重要なのは、Claude Code の UI ではこれが直接表示されないからです。会話が閉じたあとにセッションに対して何かしたい場合（アーカイブ、共有、監査など）、まずディスク上で見つけることになります。CLI は `jsonl-to-pdf list` で代わりに探してくれますが、特定のセッションを手動で grep するときに備えてパスのエンコード方式は知っておく価値があります。最近の [Claude Code 2.1.119 の PR-from-URL の変更](/ja/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) によって、これらのファイルにはセッションのメタデータがどんどん追加されており、JSONL がエージェント実行が実際に行ったことの正本ログになりつつあります。

## クイックスタート: npx jsonl-to-pdf

インストール不要のパスは、`package.json` に触れずに `jsonl-to-pdf` を npm から直接実行します。

```bash
# Node
npx jsonl-to-pdf

# Bun
bunx jsonl-to-pdf

# pnpm
pnpm dlx jsonl-to-pdf
```

これでインタラクティブなピッカーに入ります。ピッカーはローカルの Claude Code プロジェクトディレクトリを走査し、各セッションをタイトル、経過時間、サイズ付きで新しい順に並べ、サブエージェントの会話を含めるかどうかを尋ねます。セッションを選び、質問に答えると、CLI はセッションタイトルから取った名前で PDF を現在の作業ディレクトリに書き出します。

```
$ jsonl-to-pdf
◆ Project   C:\S\my-app
◆ Session   Refactor the billing module to use Stripe webhooks  · 2h ago · 412KB
◆ Include sub-agent conversations? › Yes

✓ Wrote refactor-the-billing-module-to-use-stripe-webhooks.pdf
```

ファイルパスがすでにわかっている場合は、`convert` がそれを位置引数として受け取り、ピッカーをスキップします。

```bash
jsonl-to-pdf convert ~/.claude/projects/C--S-my-app/abc-123.jsonl
```

どちらの形式でも同じフラグが使えます。インタラクティブなピッカーは、その場限りのセッションを変換するときに向いた入り口です。`convert` の形式は、既知のファイルに対してスクリプトを書くとき（CI のアーティファクトアップロード、自動化フック、アーカイブ用の一括処理）に向いた入り口です。

代わりにグローバルにインストールしたい場合は、`npm i -g jsonl-to-pdf` または `bun i -g jsonl-to-pdf` で `jsonl-to-pdf` と短いエイリアスの `j2pdf` の両方が `PATH` に入ります。Node 18 以降が必要です。

## PDF に何が入るか

デフォルトで、PDF はセッションの **完全な忠実度** を保ちます。見えていたチャットだけではありません。

- すべてのユーザープロンプトとアシスタントの応答を、順番どおりに。
- *思考* ブロック（Extended Thinking が有効な場合のモデル内部の推論）。エージェントが何をするか決めた経緯を振り返るときに役立ちます。
- すべてのツール呼び出しと、その完全な入力。`Bash` 呼び出しはコマンドを、`Edit` 呼び出しは差分を、MCP 呼び出しは引数を表示します。
- すべてのツール結果。bash の stdout/stderr のフルログを含みます。長い出力は折り返され、切り詰められません。
- 画像添付は、添付された会話の地点にインラインで埋め込まれます。
- **サブエージェント** は適切な位置にネストして描画されます。メインエージェントが `Task` または `Agent` を起動した場合、そのサブ会話全体が、起動元のツール呼び出しの位置にインデント付きで現れます。サブエージェントが起動するサブエージェントも、再帰的に同じように描画されます。

コードブロックは等幅フォントで、構文を意識した行折り返しで描画され、トークンの途中で改ページしないロジックを備えています。各セクションには軽いナビゲーション要素（ページ番号、ヘッダーのセッションタイトル）が入りますが、デザインのためのデザインには寄せていません。デフォルトテーマはライトです。`--dark` を付けるとダークテーマに切り替わり、画面では見栄えが良く、紙では悪くなります。

その忠実度こそがポイントです。エージェントセッションの PDF は、モデルが実際に見たもの、実行したもの、返ってきたものを読み手が正確に確認できるとき、もっとも価値があります。要約されたエクスポートはポストモーテムのように読めますが、フルエクスポートはトランスクリプトのように読めます。

## サブエージェントをインラインに、または巻末付録に

デフォルトの描画は **インライン** です。各サブエージェントの会話は、それを起動したツール呼び出しの位置にインデントされ、視覚的にグルーピングされて現れます。親側の流れを追いやすいので、文脈の中で寄り道を見たいデバッグのときの正しいデフォルトです。

`--subagents-mode appendix` は別のレイアウトに切り替えます。メインの会話は途切れずに上から下へ読め、サブエージェントの会話はドキュメントの末尾に移動し、各々を起動したツール呼び出しに戻るアンカーが付きます。親会話が物語の本筋で、サブエージェントのスレッドが裏付けの証拠になる、コードレビュー的な読み方に向いたモードです。

```bash
# inline (default)
jsonl-to-pdf convert session.jsonl

# appendix
jsonl-to-pdf convert session.jsonl --subagents-mode appendix

# omit sub-agents entirely
jsonl-to-pdf convert session.jsonl --no-subagents
```

3 つ目の `--no-subagents` は、サブエージェントの会話がノイズになる場合（よくあるのは、最終的な変更に影響しない長い Explore 系の検索）に使います。この場合、PDF にはメインエージェントの流れだけが入ります。

## compact と redact: セッションを安全に共有する

「これを外部に共有したい」というケースは、2 つのフラグでカバーできます。

`--compact` はセッションを本質まで削ぎ落とします。思考ブロックは隠され、約 30 行を超えるツール I/O は `[N lines omitted]` という明確なマーカーで切り詰められます。結果は、深いトレースなしのチャットそのものに近い形で読めます。結果だけが気になるチームメイトに会話を渡したいときに便利です。

`--no-thinking` はもう少し細かいカットです。アシスタントの思考ブロックだけを隠し、ツール呼び出しと結果はそのまま残します。トレースは大事だけれど、内部の推論が長すぎて印刷したくないときに役立ちます。

`--redact` は、ドキュメント内のすべての文字列に対して、よくあるシークレット形式にマッチする正規表現群を走らせます。AWS のアクセスキーとシークレットキー、GitHub Personal Access Token（クラシックと fine-grained 両方）、Anthropic と OpenAI の API キー、`Bearer` ヘッダー、Slack トークン、PEM エンコードされた秘密鍵が対象です。マッチした各箇所は `[redacted:<kind>]` に置換され、読み手は値を見ずにどの種類のシークレットだったかだけを把握できます。パターンの完全なリストはプロジェクトの GitHub の [src/utils/redact.ts](https://github.com/marius-bughiu/jsonl-to-pdf/blob/main/src/utils/redact.ts) にあります。

```bash
# safe to email
jsonl-to-pdf convert session.jsonl --compact --redact

# safe to share, full fidelity
jsonl-to-pdf convert session.jsonl --redact
```

送信先が信頼境界の外側にあるときは、いつでも `--redact` を使ってください。セッションがキーに触れなかったと確信していても、フラグのコストはほぼゼロで、間違えたときのコストは本番資格情報のローテーション 1 件です。

## レシピ

よく出てくるパターンをいくつか。

**直近 1 週間を一括変換する。** ある日付より新しいすべてのセッションを、1 つにつき 1 つの PDF に、コマンドを実行した場所と同じ場所に書き出します。

```bash
jsonl-to-pdf list --json |
  jq -r '.[] | select(.modifiedAt > "2026-04-22") | .filePath' |
  while read f; do jsonl-to-pdf convert "$f"; done
```

`jsonl-to-pdf list --json` はセッションごとに 1 件のレコードを `sessionId`、`projectPath`、`filePath`、`sizeBytes`、`modifiedAt` 付きで出力するので、`jq` で表現できるどんなフィルターも使えます。

**実行中のセッションを CI のアーティファクトとして添付する。** Claude Code の実行が変更を生んだパイプラインで、ビルド出力と一緒に会話もアーカイブしたいときに便利です。

```yaml
- run: npx -y jsonl-to-pdf convert "$CLAUDE_SESSION_FILE" -o session.pdf --redact
- uses: actions/upload-artifact@v4
  with:
    name: claude-session
    path: session.pdf
```

**プリンターや PDF ビューアーにパイプする。** `-o -` の形式は PDF を stdout に書き出すので、`lp`、`lpr`、あるいはお使いのプラットフォームの印刷バイナリにそのままパイプしたり、ディスクにファイルを残さずに使い捨ての PDF ビューアーに渡したりできます。

```bash
jsonl-to-pdf convert session.jsonl -o - | lp
```

**CLI が見えるすべてのセッションを一覧表示する。** PDF なし、インデックスだけです。

```bash
jsonl-to-pdf list
```

出力はデフォルトで人間に読みやすく、`--json` で機械可読になります。エージェントツーリングまわりのスクリプティングのスイートスポットです。[Claude Code を定期的に GitHub Issue のトリアージに使うスケジュール記事](/ja/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) には、同じパターンのもう少し長い例（`list --json` を消費するスケジュールジョブ）があります。

## Node のツールチェーンを置きたくないときのスタンドアロンバイナリ

GitHub Releases ページでは、`bun build --compile` でビルドされた単一ファイルのバイナリを、OS とアーキテクチャごとに 1 つずつ配布しています。Node ランタイムは不要です。Node のツールチェーンのインストールが許可されていないビルドエージェントや、グローバル npm インストールがブロックされたロックダウンされた開発者ワークステーションで便利です。

```bash
# macOS / Linux
curl -fsSL https://github.com/marius-bughiu/jsonl-to-pdf/releases/latest/download/install.sh | sh
```

Windows では、最新リリースから `jsonl-to-pdf-win-x64.exe` をダウンロードして `PATH` に置いてください。バイナリは npm でインストールしたものと同じフラグを受け取ります。`convert`、`list`、`--compact`、`--redact`、`--dark` など、すべてです。

## なぜ「ブラウザで開く」ではなく PDF なのか

ロードマップにある HTML ビューに対して、PDF というフォーマットが立場を勝ち取れる理由がいくつかあります。

- **アーカイブ。** ローカルの Claude Code セッションファイルはローテートされたり、ガベージコレクトされたり、単に忘れ去られたりします。PDF は凍結された自己完結的なスナップショットで、プロジェクトフォルダ、Issue、バックアップに置いておけます。
- **共有。** たいていのコードレビューツールやチャットツールは PDF 添付をきれいに受け付けます。Slack のスレッドに 400KB の JSONL を貼るのは、PDF を 1 つドロップするよりも体験が悪くなります。
- **レビュー。** エージェントの仕事をコードレビューのように読むこと（机で、飛行機の中で、紙の上で）は、チャットをスクロールするのとは異なる注意の使い方です。PDF はその切り替えに耐えます。
- **監査。** 署名された決定的なエクスポートは、実際に何が言われ、何が実行されたかの記録になります。社内のコンプライアンスチームは PDF にマークアップできますが、JSONL にはできません。
- **オンボーディング。** ジュニアにとって、汎用的なチュートリアルよりも実物のセッションのほうがはるかに良い学習素材です。PDF があれば、その引き渡しは添付ファイル 1 つで済みます。

## ロードマップ、簡単に

0.1.0 のリリースは Claude Code のみを対象にしています。プロジェクトの GitHub にあるロードマップでは、Aider、OpenAI Codex CLI、Cursor Compose、Gemini CLI 向けのアダプター追加を約束しています。これらはすべて、何らかの形の JSONL あるいは JSON-Lines のトランスクリプトを書き出します。フォーマットのカバレッジ以外には次のような項目があります。

- インラインの Web 共有用の HTML 出力と、小さな静的ビューアー。
- Shiki トークンによるコードブロックの構文ハイライト。
- ページ番号付きの目次（現在のビルドでは PDF のアウトライン／ブックマークを使用）。
- 全文トランスクリプトが多すぎる場合のためのフィルタリングフラグ: `--turns 5..15`、`--only assistant`、`--exclude-tool Bash`。

CLAUDE.md と hook を書いてセッションを軌道に乗せている場合（[CLAUDE.md プレイブック](/ja/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) で扱っています）、`jsonl-to-pdf` はそれと組になる成果物になります。セッションから離れるときに、指し示せる持続的な何かを手元に残す手段です。リポジトリは [github.com/marius-bughiu/jsonl-to-pdf](https://github.com/marius-bughiu/jsonl-to-pdf) にあります。
