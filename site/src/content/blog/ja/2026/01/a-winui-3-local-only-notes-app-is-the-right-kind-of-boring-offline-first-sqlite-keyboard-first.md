---
title: "WinUI 3 の \"ローカル専用ノート\" アプリは正しい意味で退屈: オフラインファースト、SQLite、キーボード優先"
description: "Miyanyedi Quick Note は WinUI 3 + SQLite のメモアプリで、オフラインファーストかつプライバシー重視です。「ローカル専用」が機能である理由と、.NET 8 のデスクトップアプリ向け最小 SQLite スニペットを紹介します。"
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "winui-3"
lang: "ja"
translationOf: "2026/01/a-winui-3-local-only-notes-app-is-the-right-kind-of-boring-offline-first-sqlite-keyboard-first"
translatedBy: "claude"
translationDate: 2026-04-29
---
今日 r/csharp に、また「小さいが本物の」デスクトップアプリが登場しました: **Miyanyedi Quick Note**。**WinUI 3** と **SQLite** で作られた軽量なメモツールで、オフラインファーストとプライバシー重視を明確に意図して設計されています。

ソース: 元の投稿と Microsoft Store のリスティング: [r/csharp スレッド](https://www.reddit.com/r/csharp/comments/1qg30jf/dev_miyanyedi_quick_note_a_fast_localonly_notepad/) と [Microsoft Store のアプリページ](https://apps.microsoft.com/store/detail/9PGB6SQSK601?cid=DevShareMWAPCS)。

## 「ローカル専用」は機能であり、欠けたチェックボックスではない

ほとんどのメモアプリは、同期が成長レバーであるためアカウントシステムへ流れていきます。トレードオフは明白です: 攻撃面の増加、ダウンタイムの増加、「データはどこへ消えた」案件の増加。

Windows デスクトップユーティリティにとって、「クラウドなし」が製品そのものになり得ます:

-   **即起動**: サインインなし、ネットワーク呼び出しなし。
-   **予測可能なプライバシー**: メモはあなたのマシンに留まります。
-   **シンプルなバックアップ物語**: フォルダーをコピーしファイルをエクスポートすれば終わり。

**.NET 8** (または .NET 9) で社内ツーリングを構築しているなら、この「オフラインファーストをデフォルトに」という考え方はよいベースラインです。

## SQLite が WinUI 3 アプリと相性が良いのは、ドメインを小さく保つから

SQLite は「データベースの選択」ではなく、スコープの選択です。あなたはこう言っています:

-   ユーザーは 1 人
-   マシンは 1 台
-   ファイルは 1 つ
-   クエリはシンプル

これは WinUI 3 の UI 要件とよく合います: CRUD を UI スレッドの外に出し、リストを素早く更新し、サーバーには一切触れずに済みます。

`Microsoft.Data.Sqlite` を使った「メモを挿入し、最新を一覧する」最小スニペットは次のとおりで、任意の .NET 8 デスクトップアプリで動きます:

```cs
using Microsoft.Data.Sqlite;

static async Task AddNoteAsync(string dbPath, string text, CancellationToken ct)
{
    await using var conn = new SqliteConnection($"Data Source={dbPath}");
    await conn.OpenAsync(ct);

    var cmd = conn.CreateCommand();
    cmd.CommandText = """
        INSERT INTO notes(text, created_utc)
        VALUES ($text, $createdUtc);
        """;
    cmd.Parameters.AddWithValue("$text", text);
    cmd.Parameters.AddWithValue("$createdUtc", DateTimeOffset.UtcNow.ToString("O"));
    await cmd.ExecuteNonQueryAsync(ct);
}

static async Task<List<string>> ListLatestAsync(string dbPath, int take, CancellationToken ct)
{
    await using var conn = new SqliteConnection($"Data Source={dbPath}");
    await conn.OpenAsync(ct);

    var cmd = conn.CreateCommand();
    cmd.CommandText = """
        SELECT text
        FROM notes
        ORDER BY created_utc DESC
        LIMIT $take;
        """;
    cmd.Parameters.AddWithValue("$take", take);

    var results = new List<string>();
    await using var reader = await cmd.ExecuteReaderAsync(ct);
    while (await reader.ReadAsync(ct))
        results.Add(reader.GetString(0));

    return results;
}
```

残りは UI です: リストをバインドし、Enter で保存、Esc でフォーカスを処理し、操作感をきびきび保ちます。

自分の Windows App SDK の UI 設計の妥当性を確かめる例が欲しいなら、こうしたアプリは巨大なサンプルリポジトリより役に立ちます。コピーできる程度には小さく、難所をあらわにする程度には現実的です。
