---
title: "Anthropic SDK アプリにプロンプトキャッシュを追加し、ヒット率を測定する方法"
description: "Python または TypeScript の Anthropic SDK アプリにプロンプトキャッシュを追加し、cache_control のブレークポイントを正しく配置し、cache_read_input_tokens と cache_creation_input_tokens を読んで実際のヒット率を計算します。Claude Sonnet 4.6 と Opus 4.7 の料金計算付きです。"
pubDate: 2026-04-29
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "claude-code"
lang: "ja"
translationOf: "2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate"
translatedBy: "claude"
translationDate: 2026-04-29
---

Anthropic SDK アプリが毎ターン同じ長いシステムプロンプトやツールカタログを送っているなら、モデルが30秒前にすでに見たトークンに対して入力の全額を払っていることになります。プロンプトキャッシュは、その繰り返しトークンを **基本入力料金の10パーセント** にまで下げる代わりに、わずかな一度きりの書き込み追加料金を取ります。10kトークンのシステムプロンプトを伴うマルチターンのエージェントループでは、入力コストが5倍から10倍下がり、キャッシュ済みプレフィックスでレイテンシが約85ms短縮されます。落とし穴は、cache_control のブレークポイントを正しい位置に置き、SDK の usage オブジェクトでヒット率を確認しなければならない点です。配置を間違えると、ブレークポイントは静かに通常料金の呼び出しへと劣化します。

このガイドでは、現行 API (Claude Opus 4.7、Sonnet 4.6、Haiku 4.5) で動く Python または TypeScript の Anthropic SDK アプリにキャッシュを追加し、その後、小さなラッパーで実際のキャッシュヒット率を測定する流れを順に追います。コードは `anthropic` 0.42 (Python) と `@anthropic-ai/sdk` 0.30 (Node) で検証しており、いずれも2026年初頭にリリースされたものです。

## エージェントループでキャッシュが必須である理由

リポジトリを反復して触るコーディングエージェントは、典型的に次のものを送信します:

1. 5kから30kトークンのシステムプロンプト (エージェントの指示、ツールの説明、ファイル規約)。
2. 増えていくメッセージ履歴 (ユーザーのリクエストに加えて過去のツール呼び出しとツール結果)。
3. 次のレスポンスを引き起こす新しいユーザーターンまたはツール結果。

キャッシュなしでは、毎ターン全プレフィックスを再エンコードします。Claude Sonnet 4.6 で入力 $3/MTok の場合、8kトークンのプレフィックスは1ターンあたり $0.024 です。50ターンのセッションは、実際の作業を抜きにして再請求されるプレフィックスだけで $1.20 になります。キャッシュを使えば、同じプレフィックスは初回書き込み後、キャッシュされた1ターンあたり $0.0024 です。同じ回答で、請求の10パーセントです。

仕組みは [公式のプロンプトキャッシュドキュメント](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) に記載されています。コンテンツブロックに `cache_control: {"type": "ephemeral"}` を付けると、API はそのブロック **より前およびそのブロックを含む** すべてをキャッシュキーとして扱います。次のリクエストでプレフィックスがバイト単位で一致すれば、モデルは再エンコードせずキャッシュから読みます。

「バイト単位で一致」が実際に何を意味するかは、Anthropic フォーラムにある「なんでキャッシュされないの」というスレッドすべての発端です。それは後で扱います。

## バージョン、モデル ID、最小トークンの罠

キャッシュは、キャッシュ対象のプレフィックスがモデルごとの最小値を超えたときだけ効きます:

- **Claude Opus 4.7 (`claude-opus-4-7`)**: 最小 4,096 トークン。
- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**: 最小 2,048 トークン。
- **Claude Haiku 4.5 (`claude-haiku-4-5`)**: 最小 4,096 トークン。
- **古い Sonnet 4.5、Opus 4.1、Sonnet 3.7**: 最小 1,024 トークン。

プレフィックスが閾値未満の場合、リクエストは依然として成功しますが、`cache_creation_input_tokens` は 0 として返り、静かに入力の全額を払うことになります。これは開発者が「キャッシュが何もしない」と報告する最も多い理由です。常に対象モデルの閾値を最初に確認してください。

`anthropic` Python SDK は 0.40 でネイティブの `cache_control` サポートを獲得し、0.42 で usage 内訳の型付けを引き締めました。Node SDK は `@anthropic-ai/sdk` 0.27 から対応しています。5分 TTL でも1時間 TTL でも、ベータヘッダーはもう不要です。`cache_control` 内で `ttl` を設定するだけです。

## cache_control を使った最小限の Python の例

下のパターンは長いシステムプロンプトをキャッシュします。最も単純で最も一般的なユースケースです。

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

LONG_SYSTEM_PROMPT = open("prompts/system.md").read()  # ~8k tokens

def ask(user_message: str) -> anthropic.types.Message:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": LONG_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

first = ask("List the public methods on OrderService.")
second = ask("Now list the private ones.")

print(first.usage)
print(second.usage)
```

`cache_control` を付けるとき、`system` パラメータは **コンテンツブロックの配列** でなければなりません。素のシリアル文字列を渡す (簡略形) とキャッシュは効きません。SDK にキャッシュフラグを置く場所がないからです。最初は誰もがここで引っかかります。

最初の呼び出しはプレフィックスをキャッシュへ書き込みます。2回目の呼び出しはそれを読みます。usage オブジェクトでこれが見えます:

```
# first.usage
{ "cache_creation_input_tokens": 8137, "cache_read_input_tokens": 0,  "input_tokens": 18,  "output_tokens": 124 }
# second.usage
{ "cache_creation_input_tokens": 0,    "cache_read_input_tokens": 8137, "input_tokens": 22, "output_tokens": 156 }
```

注目するフィールドは:

- `cache_creation_input_tokens`: このリクエストでキャッシュへ書き込まれたトークン。5分 TTL は基本料金の 1.25倍、1時間 TTL は 2.0倍で課金されます。
- `cache_read_input_tokens`: キャッシュから読んだトークン。基本料金の 0.10倍で課金されます。
- `input_tokens`: **最後のキャッシュブレークポイントより後** にあり、キャッシュ対象にならなかったトークン。これがあなたが変え続けるメッセージのお尻の部分です。

## TypeScript での同じ例

Node SDK は同じ形をしています。`system` 配列のエントリはクラスラッパーではなく素のオブジェクトリテラルで書く点に注意してください。

```typescript
// Node 22, @anthropic-ai/sdk 0.30
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const SYSTEM = readFileSync("prompts/system.md", "utf8");

async function ask(userMessage: string) {
  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
}

const first = await ask("List the public methods on OrderService.");
const second = await ask("Now list the private ones.");
console.log(first.usage);
console.log(second.usage);
```

usage の内訳も料金も同じです。ヘッダーの曲芸はありません。

## エージェントループでブレークポイントを置く場所

コーディングエージェントが持つのは長いシステムプロンプトだけではありません。長くて **増え続ける** メッセージ履歴と静的なツールカタログもあります。最適解はたいてい、最も安定した側から最も揮発的な側へ並べた3〜4個のブレークポイントです。

リクエストごとに **明示的なキャッシュブレークポイントを最大4個** 持てます。API は各マーク済みブロックの前およびそのブロックを含むすべてをキャッシュするので、ブレークポイントごとに層状のプレフィックスができあがります。

```python
# Python 3.11, anthropic 0.42
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    tools=[
        # ... tool schemas ...
        {
            "name": "search_repo",
            "description": "...",
            "input_schema": {"type": "object", "properties": {...}},
            "cache_control": {"type": "ephemeral"},  # breakpoint 1: tools
        },
    ],
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},  # breakpoint 2: system
        }
    ],
    messages=[
        # All prior turns...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": stable_repo_summary,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 3: repo state
                }
            ],
        },
        # ... older messages ...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": current_user_turn,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 4: most recent stable point
                }
            ],
        },
    ],
)
```

ルールは「外側を安定に、内側を揮発に」です。機能フラグの切り替えでツールカタログが変わるなら、その変化はその後ろにある他のすべての層を無効化します。システムプロンプトに今日の日付が埋め込まれているなら、すべてのキャッシュ書き込みが UTC の真夜中に期限切れになります。動的なものはキャッシュ対象ブロックから外に出してください。

## ヒット率の測定

ベンダーのダッシュボードは月次の請求書を見るには適しています。エージェントをリアルタイムにチューニングするのには向きません。SDK をラップして、usage フィールドを自分で集計してください。

```python
# Python 3.11, anthropic 0.42
from dataclasses import dataclass, field
import anthropic

@dataclass
class CacheStats:
    requests: int = 0
    base_input: int = 0          # uncached
    cache_writes_5m: int = 0
    cache_writes_1h: int = 0
    cache_reads: int = 0
    output: int = 0

    def record(self, usage):
        self.requests += 1
        self.base_input += usage.input_tokens
        self.cache_reads += usage.cache_read_input_tokens or 0
        creation = getattr(usage, "cache_creation", None)
        if creation:
            self.cache_writes_5m += creation.ephemeral_5m_input_tokens or 0
            self.cache_writes_1h += creation.ephemeral_1h_input_tokens or 0
        else:
            self.cache_writes_5m += usage.cache_creation_input_tokens or 0
        self.output += usage.output_tokens

    @property
    def hit_rate(self) -> float:
        cacheable = self.cache_reads + self.cache_writes_5m + self.cache_writes_1h
        return self.cache_reads / cacheable if cacheable else 0.0

    def cost_usd(self, base_input_per_mtok: float, output_per_mtok: float) -> float:
        # Sonnet 4.6: base_input=3.00, output=15.00
        # Opus 4.7:   base_input=15.00, output=75.00
        write_5m = self.cache_writes_5m * base_input_per_mtok * 1.25
        write_1h = self.cache_writes_1h * base_input_per_mtok * 2.0
        reads    = self.cache_reads     * base_input_per_mtok * 0.10
        base     = self.base_input      * base_input_per_mtok
        out      = self.output          * output_per_mtok
        return (write_5m + write_1h + reads + base + out) / 1_000_000

stats = CacheStats()

def cached_call(client, **kwargs):
    response = client.messages.create(**kwargs)
    stats.record(response.usage)
    return response
```

エージェントを最初から最後まで実行し、その後ヒット率を出力します。

```python
print(f"requests:    {stats.requests}")
print(f"hit rate:    {stats.hit_rate:.1%}")
print(f"cache reads: {stats.cache_reads:,}")
print(f"5m writes:   {stats.cache_writes_5m:,}")
print(f"1h writes:   {stats.cache_writes_1h:,}")
print(f"uncached in: {stats.base_input:,}")
print(f"USD:         ${stats.cost_usd(3.00, 15.00):.4f}")  # Sonnet 4.6 prices
```

8k のシステムプロンプトを持つ50ターンの健全なコーディングエージェントを Sonnet 4.6 で動かすと、典型的に次の数値に収まります:

- システムプロンプトブロックでヒット率 95-98%。
- メッセージブロックでヒット率 70-90% (どれくらい積極的に再プロンプトするかで変わります)。
- 同じエージェントでキャッシュなしの場合と比べて、総支出は 1.5倍から4倍少なくなります。

ヒット率が 0% に張りついている場合、原因はほぼ常に次の3つです: プレフィックスが最小トークン閾値未満、キャッシュ対象テキストに非決定的な値 (タイムスタンプ、ランダム ID、辞書の順序) が埋め込まれている、またはターンの間でメッセージが並べ替えられている。

## 1時間 TTL: 元が取れる場面

デフォルトの TTL は5分です。チャット型エージェントならそれで問題ありません。各ターンがキャッシュをリフレッシュし、わずかな書き込み追加料金は多くの読み込みで償却されます。

1時間 TTL は書き込み時に **基本入力の2倍** かかりますが、寿命は12倍になります。計算上は、1時間のうち5分ごとに少なくとも1回読み込みが期待できるなら、5分キャッシュで十分です。トラフィックがバースト的 (誰かが20分おきにエージェントを実行) なら、5分キャッシュはターンの合間に期限切れになり、書き込みコストを何度も払い続けることになります。1時間 TTL は、1時間のアイドル期間中にキャッシュ読み込みが2回起きた瞬間に元が取れます。

```python
# Python 3.11, anthropic 0.42 -- mixing TTLs
system=[
    {
        "type": "text",
        "text": STABLE_INSTRUCTIONS,             # the bedrock part
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    },
    {
        "type": "text",
        "text": SESSION_SCOPED_CONTEXT,          # changes per user session
        "cache_control": {"type": "ephemeral", "ttl": "5m"},
    },
],
```

TTL を混在させるとき、より長い TTL のエントリは、より短い TTL のエントリの **前** に来なければなりません。逆にすると API はリクエストを拒否します。

ベータヘッダーは不要です。古い `anthropic-beta: prompt-caching-2024-07-31` と後の `extended-cache-ttl-2025-04-11` は廃止されましたが、SDK は後方互換のために no-op として今も受け付けます。

## ヒット率を台無しにする5つの落とし穴

**1. 非決定的な内容を埋め込む。** システムプロンプト内の `datetime.now()` は秒ごとにキャッシュを無効にします。よくある犯人は、タイムスタンプ、リクエスト ID、多様性のために注入されるランダムサンプルデータ、キーの順序を固定しない JSON シリアライズです。バイトが変われば、キャッシュは外れます。

**2. ツールやメッセージの並べ替え。** API はバイトを順番にハッシュします。呼び出しごとにツール配列を違うソートにすると、違うハッシュが出ます。決定的な順序を保ち、できれば設定ファイル通りの順序にしてください。

**3. system を文字列から配列へ切り替え忘れる。** `system="..."` (素の文字列) は `cache_control` を受け付けません。`system=[{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]` を使う必要があります。SDK はキャッシュを期待した文字列を渡しても警告してくれません。

**4. 20ブロックのルックバック窓を超える。** ブレークポイントが見られるのは前方の20コンテンツブロックまでです。tool_result ブロックが多い長い tool-use ループでは、会話の先頭に近いブレークポイントは最終的に範囲外に落ちます。そうなる前に、現在のターンに近い場所に2つ目のブレークポイントを追加してください。

**5. 異なる組織やワークスペースから同じキャッシュにヒットしようとする。** キャッシュは組織ごとに分離されており、2026年2月以降は Anthropic API と Azure ではワークスペースごとにも分離されています。dev を片方のワークスペース、prod をもう片方で動かしている場合、キャッシュ済みプレフィックスは共有されません。

.NET 側で Anthropic SDK をラップしている層について深掘りするには、[Microsoft Agent Framework 1.0 で C# の AI エージェントを構築する](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) と [VS Code の GitHub Copilot による Anthropic プロバイダーの BYOK 対応](/ja/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/) を参照してください。

## 「自動キャッシュ」が何をするか、そしてなぜそれだけでは足りないか

最近の SDK リリースで `messages.create` のトップレベルに `cache_control` パラメータが追加されました。これを設定すると、API はヒューリスティックに基づいて自動的にキャッシュを適用します。動きはしますが、ブレークポイントは1つだけ選ばれ、どこになるかは制御できません。長いシステムプロンプト1つだけならそれで十分です。ツールカタログ、要約、メッセージ履歴があるエージェントループでは、明示的なブレークポイントが欲しくなります。自動モードはスモークテスト扱いが最適です。あなたのセットアップでキャッシュが動くことを確認するために一度オンにし、その後は明示的な `cache_control` ブロックへ移行しましょう。

同じエージェントにツールを公開する MCP サーバーも構築している場合、レイアウトの原則は同じです。サーバー側については [.NET 11 上の C# でカスタム MCP サーバーを構築する方法](/ja/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/)、[CLI をラップする TypeScript の MCP サーバーを構築する方法](/ja/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)、[公式 SDK で Python のカスタム MCP サーバーを構築する方法](/ja/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) を参照してください。ここでのブレークポイント配置ガイドは、それらを呼び出すクライアントに当てはまります。

## キャッシュの元が取れる場面のスプレッドシート風ビュー

封筒の裏で計算するには、プレフィックスサイズをトークン数 (`P`)、書き込みあたり期待できる読み込み回数 (`R`)、キャッシュ TTL の倍率 (`m`、5分は `m=1.25`、1時間は `m=2.0`) と置きます。1つのキャッシュ済みプレフィックスがキャッシュなしのベースラインに対して損益分岐となる読み込み回数は次の通りです:

```
R_breakeven = (m - 1) / (1 - 0.1)
            = (m - 1) / 0.9
```

これは5分 TTL では **0.28回の読み込み**、1時間 TTL では **1.11回の読み込み** です。言い換えると、5分キャッシュは現実的なシナリオなら1回の読み込みで元が取れ、1時間キャッシュは2回目の読み込みで元が取れます。実質的に、エージェントループでキャッシュが間違った選択になるシナリオはありません。問題はどちらの TTL を選ぶかだけです。

キャッシュの恩恵を受けるエージェントループのパターンについては、[CLAUDE.md でモデルの挙動を実際に変えるための書き方](/ja/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) と [GitHub の issue をトリアージする Claude Code の定期タスクをスケジュールする方法](/ja/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) を参照してください。

## 参考リンク

- [プロンプトキャッシュのドキュメント](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [PyPI の Anthropic Python SDK](https://pypi.org/project/anthropic/)
- [npm の Anthropic TypeScript SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Anthropic API の料金](https://docs.claude.com/en/docs/about-claude/pricing)
