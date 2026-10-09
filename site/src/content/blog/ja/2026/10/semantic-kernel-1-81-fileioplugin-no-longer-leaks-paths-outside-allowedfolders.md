---
title: "Semantic Kernel 1.81 で FileIOPlugin が AllowedFolders 外のファイル情報を漏らさなくなりました"
description: "Semantic Kernel .NET 1.81.0 は FileIOPlugin のオラクル問題を修正しました。これまで WriteAsync は、AllowedFolders 外のファイルが存在すること、読み取り専用であること、その場所をモデルに伝えていました。修正前後の挙動を実測しています。"
pubDate: 2026-10-09
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "ja"
translationOf: "2026/10/semantic-kernel-1-81-fileioplugin-no-longer-leaks-paths-outside-allowedfolders"
translatedBy: "claude"
translationDate: 2026-10-09
---

Semantic Kernel .NET [1.81.0](https://github.com/microsoft/semantic-kernel/releases/tag/dotnet-1.81.0) は 2026-10-06 にリリースされ、同日に `Microsoft.SemanticKernel.Plugins.Core` 1.81.0-preview も NuGet に公開されました。リリースノートでは [PR #14525](https://github.com/microsoft/semantic-kernel/pull/14525) を "Update file handling for FileIOPlugin" と紹介していますが、これは控えめすぎる表現です。1.80.1 までの `FileIOPlugin.WriteAsync` は、`AllowedFolders` を確認する *前に* ファイルが読み取り専用かどうかをチェックしており、スローされる例外には完全な正規化パスが含まれていました。このプラグインをモデルに公開している場合、ディスク全体に対するファイル存在オラクルになっていたということです。

これは [1.80.0 で OpenAPI プラグインがリダイレクトを追跡しなくなった](/ja/2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects/) 件に続く、ファイルとネットワークに関する 2 回連続の堅牢化です。

## 1.80.1 でモデルが知り得た情報

SDK 10.0.302 上で、同じファイルベースのプローブを両バージョンに対して実行しました。許可フォルダーの外に読み取り専用の `secrets.txt` を、その隣に存在しない `nope.txt` を、許可フォルダーの中に読み取り専用の `locked.txt` を用意し、それぞれに対して `WriteAsync` を呼び出します。

```csharp
#:package Microsoft.SemanticKernel.Plugins.Core@1.80.1-preview
#:property PublishAot=false
#:property NoWarn=SKEXP0050
using Microsoft.SemanticKernel.Plugins.Core;

// allowed, readOnlyOutside, missingOutside, readOnlyInside: temp paths set up earlier
var plugin = new FileIOPlugin { AllowedFolders = [allowed], DisableFileOverwrite = false };

foreach (var f in new[] { readOnlyOutside, missingOutside, readOnlyInside })
{
    try { await plugin.WriteAsync(f, "y"); }
    catch (Exception e) { Console.WriteLine($"{Path.GetFileName(f)}: {e.GetType().Name}: {e.Message}"); }
}
```

1.80.1-preview での出力 (一時パスは短縮しています):

```text
secrets.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/outside/secrets.txt
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/allowed/locked.txt
```

問題は最初の 2 行です。サンドボックス外のファイルは、存在しないファイルとは異なる例外になるため、存在の有無が観測できてしまいます。`AllowedFolders` が空のデフォルトの `new FileIOPlugin()`、つまり "フォルダーを一切許可しない" とドキュメントに記載されている構成でも同じことが起こります。

このメッセージは実際にモデルに届きます。自動関数呼び出しを使っている場合、`FunctionCallsProcessor` が例外をキャッチし、ツールの結果として `Error: Exception while invoking function. {e.Message}` を返します。プロンプトインジェクションを受けたエージェントは、`~/.ssh/id_rsa` や `/etc/shadow` のようなパスを探り、その答えを読み取ることができます。

## 1.81.0 での変更点

`TryGetAllowedFilePath` は、フォルダーが 1 つも構成されていない場合に即座に `false` を返すようになりました。また、パスの正規化を `IOException`、`UnauthorizedAccessException`、`InvalidOperationException`、`SecurityException` のキャッチで囲むようになり (シンボリックリンクのループや権限エラーは単なる拒否になります)、読み取り専用チェックはパスが許可フォルダーに一致した後にのみ実行されます。読み取り専用の例外からもパスが取り除かれました。1.81.0-preview で同じプローブを実行した結果は次のとおりです。

```text
secrets.txt: InvalidOperationException: Writing to the provided location is not allowed.
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only.
```

サンドボックスの外では、どのケースも区別がつかなくなりました。サンドボックスの中では、パスを含まない形で引き続き有用なエラーが得られます。同じく 1.81.0 に含まれる [PR #14476](https://github.com/microsoft/semantic-kernel/pull/14476) は、同様の検証の整合を `DocumentPlugin` と `CloudDrivePlugin` にも適用しています。

## 取るべき対応

いずれかのエージェントが `FileIOPlugin` を呼び出せる場合は、`Microsoft.SemanticKernel.Plugins.Core` を `1.81.0-preview` に上げてください。公開 API に変更はないため、バージョンを上げるだけで済みます。独自のファイルツールをラップしている場合は、このパターンを取り入れてください。まずサンドボックスを確認し、すべての拒否で同じメッセージを返し、ツールの結果としてモデルに戻る可能性のある例外には解決済みのパスを決して含めないことです。
