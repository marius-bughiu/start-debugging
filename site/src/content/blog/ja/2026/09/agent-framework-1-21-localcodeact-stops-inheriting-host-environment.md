---
title: "Agent Framework 1.21: LocalCodeAct がモデル生成の Python にホストの環境変数を渡さなくなりました"
description: "Microsoft Agent Framework .NET 1.21.0 に含まれる Microsoft.Agents.AI.LocalCodeAct 1.21.0-preview.260911.1 では、Environment が null のときに CodeAct の Python サブプロセスが親プロセスの環境を継承しなくなりました。1.20 では、生成されたコードが API キーを含むホストのすべての変数を読み取れました。"
pubDate: 2026-09-13
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "codeact"
  - "security"
lang: "ja"
translationOf: "2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment"
translatedBy: "claude"
translationDate: 2026-09-13
---

Microsoft Agent Framework [dotnet-1.21.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.21.0) は 2026 年 9 月 11 日にリリースされました。その変更履歴のうち 1 行は、実際に集まるであろう注目よりも多くの注目に値します。"[BREAKING] .NET: Isolate LocalCodeAct subprocess environment" ([PR #8159](https://github.com/microsoft/agent-framework/pull/8159)) です。`Microsoft.Agents.AI.LocalCodeAct` を使っていて `LocalCodeActProviderOptions.Environment` を一度も設定していない場合、このリリースまでは、モデルが書いた Python がホストプロセスのすべての環境変数を読み取れる状態でした。

## 2 つのドキュメント、1 つの動作

`LocalCodeAct` は Hyperlight CodeAct プロバイダーのサンドボックスなし版です。モデルが Python を書き、パッケージが AST 検証を通したうえでそれをホスト上の子 `python` プロセスで実行します。パッケージの README はすでに、サブプロセスは "does NOT inherit the host environment by default" (既定ではホスト環境を継承しない) と約束していました。一方、`Environment` の XML ドキュメントは逆のことを述べていました。`null` は継承を意味し、環境を空にしたければ空のディクショナリを渡す、というものです。コードは XML ドキュメントのほうに従っていました。`ProcessBridge.ConfigureEnvironment` はディクショナリが `null` のときに早期リターンしていたため、`ProcessStartInfo` は親の環境をすべて保持したままでした。

これが問題になるのは、バリデーターが意図的に `os.environ` への読み取り専用アクセスを許可しているからです。そのため、1.20 では次のコードが検証を通過しました。

```csharp
Environment.SetEnvironmentVariable("FAKE_OPENAI_API_KEY", "sk-leaked-from-host");

var fn = new LocalExecuteCodeFunction("/opt/homebrew/bin/python3.14");
var result = await fn.InvokeAsync(new AIFunctionArguments
{
    ["code"] = "import os\nprint(os.environ.get('FAKE_OPENAI_API_KEY', 'NOT_FOUND'))\nprint(len(os.environ))",
});
```

このプローブをそのまま .NET 10 のファイルベースアプリ (SDK 10.0.302、macOS、Python 3.14) として、両方のパッケージバージョンに対して実行しました。

```text
1.20.0-preview.260831.1  default options   -> sk-leaked-from-host, 63 variables
1.21.0-preview.260911.1  default options   -> NOT_FOUND, 2 variables
both versions            Environment set   -> NOT_FOUND, 3 variables
```

`execute_code` が出力したものは、そのままモデルのコンテキストに戻ります。プロンプトインジェクションで "環境変数を出力して" と指示するだけで、OpenAI のキー、ストレージの接続文字列、あるいは `AZURE_CLIENT_SECRET` がトランスクリプトに入り込み、そこからエージェントが呼び出せるあらゆるホストツールへと渡り得ました。

## 1.21 での現在の動作

`ConfigureEnvironment` は常に `startInfo.Environment.Clear()` を呼び出し、そのうえで `Environment` に入れたものだけをコピーするようになりました。`null` と空のディクショナリは同じ動作になります。Windows では、`SYSTEMROOT`、`SYSTEMDRIVE`、`COMSPEC`、`PATHEXT`、`TEMP`、`TMP` を設定していない場合、親から補完されます。これらがないと Python は標準ライブラリを読み込めないためです。

裏を返せば、生成されたコードが暗黙的に頼っていたものはすべてなくなります。Linux と macOS の `PATH` や `HOME` も含まれます。マウントしたスクリプトや許可したモジュールが変数を必要とする場合は、明示的に渡してください。

```csharp
using Microsoft.Agents.AI.LocalCodeAct;

using var provider = new LocalCodeActProvider("/usr/bin/python3", new LocalCodeActProviderOptions
{
    Environment = new Dictionary<string, string>
    {
        ["LOG_LEVEL"] = "INFO",
        ["TZ"] = "UTC",
    },
});
```

このディクショナリにシークレットを入れないでください。生成されたコードが認証付きの呼び出しを必要とする場合は、資格情報を保持するホストツールを登録し、Python からは `await call_tool(...)` を通じてそのツールにアクセスさせてください。

## 同じリリースに含まれる LocalCodeAct 関連の 2 つの変更

[PR #8239](https://github.com/microsoft/agent-framework/pull/8239) はバリデーターを強化し、OS 由来のエイリアス、リフレクションによるアクセス、環境の変更が一貫して拒否されるようにしました。[PR #8289](https://github.com/microsoft/agent-framework/pull/8289) は承認の扱いを Hyperlight に揃えました。登録されたツールのいずれかが `ApprovalRequiredAIFunction` であれば `execute_code` 自体も承認が必要になり、`LocalCodeActApprovalMode.AlwaysRequire` を指定するとすべての実行で承認が必須になります。

これらのどれも `LocalCodeAct` をサンドボックスにするものではなく、README も警告ボックスで引き続きそう明記しています。コンテナー、VM、または Foundry のホステッドエージェントの中で動かすべきものです。モデルが書いたコードにそこまでの準備をする価値があるかどうかをまだ検討中なら、[CodeAct と従来のツール呼び出しループの比較](/2026/07/codeact-vs-tool-calling-loop-for-agents/) でトレードオフを比較しています。すでに運用しているなら、`1.21.0-preview.260911.1` に更新し、`Environment` に渡している内容を監査してください。
