---
title: "GPT-5.3-Codex が Copilot Business と Enterprise の基本モデルになる"
description: "2026 年 5 月 17 日、GitHub は Business および Enterprise プランの Copilot 既定モデルを GPT-4.1 から GPT-5.3-Codex に切り替えました。GPT-4.1 は 6 月 1 日まで無料で利用でき、その後は従量課金の対象になります。リポジトリと CI で固定したモデルに何が起きるかを説明します。"
pubDate: 2026-05-18
tags:
  - "github-copilot"
  - "ai-agents"
  - "openai"
lang: "ja"
translationOf: "2026/05/copilot-business-gpt-5-3-codex-base-model"
translatedBy: "claude"
translationDate: 2026-05-18
---

GitHub は [2026 年 5 月 17 日に Copilot Business と Enterprise プランの新しい基本モデルとして GPT-5.3-Codex の展開を開始しました](https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/)。プラン全体の既定モデルとして GPT-4.1 を置き換え、Copilot における GitHub と OpenAI 初の長期サポート (LTS) モデルとなります。LTS ウィンドウは、このモデルが 2027-02-04 まで選択可能であることを保証します。

個人プラン (Copilot Pro、Pro+、Free) には影響しません。今回の変更は Business と Enterprise の既定モデルのみを切り替えるものです。

## "基本モデル" が実際に制御するもの

基本モデルとは、リクエストが特定のモデルを固定していないときに Copilot が使うモデルです。Copilot の設定ファイルで `model: gpt-4.1` と書いた場所は、当面そのままです。Copilot に選択を任せている場所では、応答が GPT-4.1 から GPT-5.3-Codex に切り替わったところです。

GPT-5.3-Codex の premium request 倍率は 1x で、GPT-4.1 と同じです。そのため Business と Enterprise SKU でのリクエスト単価はこの入れ替えで動きません。インライン補完、モデルを固定しない Chat、cloud agent の `auto` 選択は同時に切り替わります。

## 旧既定モデルを固定したリポジトリでの変更点

2026-06-01 までに走査すべき場所は 2 か所です。この日以降、依然として `gpt-4.1` に固定されたリクエストは、含まれる代わりに従量課金メーターで課金され始めます。

```bash
# 1. Workflow files that pin a Copilot model
grep -RE "model:\s*gpt-4\.1" .github/ 2>/dev/null

# 2. Copilot agent and Chat custom instructions
grep -R "gpt-4.1" .copilot/ .github/copilot-instructions.md 2>/dev/null
```

プロジェクトの CI が固定済みの GPT-4.1 に対して Copilot CLI や cloud agent のタスクを実行している場合、選択肢は 2 つあります。pin を `gpt-5.3-codex` に上げるか、6 月 1 日以降の追加項目の課金を受け入れるかです。新しい既定の YAML pin は同じ形になります。

```yaml
# .github/workflows/copilot-review.yml
- uses: github/copilot-action@v1
  with:
    model: gpt-5.3-codex
    effort: high
```

## GitHub が LTS スロットに Codex バリアントを選んだ理由

GPT-5.3-Codex は GPT-5.3 ファミリーのコード調整済み兄弟モデルです。ロールアウト記事で GitHub が示した指標はコード生存率で、受け入れられた提案がその後の編集と PR マージを経てもファイル内に残っている割合を指します。changelog では、ロールアウトコホートの Business と Enterprise の顧客で GPT-4.1 と比べて有意に高い生存率が報告されており、これが汎用の GPT-5.3 ではなく Codex を LTS の基本モデルに指定した根拠です。

LTS の指定はモデルの入れ替えそのものよりも重い意味を持ちます。GitHub はモデルを継続的に、かつ短い予告でしか deprecate していません。[Claude Sonnet 4 は 11 日前にすべての Copilot サーフェスから削除されました](/ja/2026/05/copilot-deprecates-claude-sonnet-4-may-2026/)が、changelog はわずか 2 段落で移行期間もありませんでした。Codex の LTS コミットメントは、Copilot モデルに対する GitHub 初の日付付き提供保証であり、他のラインナップにはこの保証はありません。

GPT-4.1 へのアクセスは 2026-06-01 まで追加料金なしで継続します。その後、メーターが動き始めます。
