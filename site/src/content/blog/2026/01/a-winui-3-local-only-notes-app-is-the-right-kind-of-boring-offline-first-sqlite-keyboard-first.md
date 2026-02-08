---
title: "A WinUI 3 “local-only notes” app is the right kind of boring: offline-first, SQLite, keyboard-first"
description: "Miyanyedi Quick Note is a WinUI 3 + SQLite note-taking app that is offline-first and privacy-friendly. Here is why local-only is a feature, plus a minimal SQLite snippet for .NET 8 desktop apps."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "winui-3"
---
Another nice “small but real” desktop app showed up on r/csharp today: **Miyanyedi Quick Note**, a lightweight note-taking tool built with **WinUI 3** and **SQLite**, explicitly designed to be offline-first and privacy-friendly.

Source: the original post and the Microsoft Store listing: [r/csharp thread](https://www.reddit.com/r/csharp/comments/1qg30jf/dev_miyanyedi_quick_note_a_fast_localonly_notepad/) and [Microsoft Store app page](https://apps.microsoft.com/store/detail/9PGB6SQSK601?cid=DevShareMWAPCS).

## “Local-only” is a feature, not a missing checkbox

Most note apps drift into an account system because sync is a growth lever. The tradeoff is obvious: more surface area, more outages, more “where did my data go”.

For a Windows desktop utility, “no cloud” can be the product:

-   **Instant startup**: no sign-in, no network calls.
-   **Predictable privacy**: your notes stay on your machine.
-   **Simple backup story**: copy a folder, export a file, done.

If you are building internal tooling on **.NET 8** (or even .NET 9), this “offline-first by default” mindset is a good baseline.

## SQLite fits WinUI 3 apps because it keeps the domain small

SQLite is not “a database choice”, it is a scope choice. You are saying:

-   one user
-   one machine
-   one file
-   simple queries

That pairs well with WinUI 3 UI requirements: you can keep CRUD off the UI thread, update the list quickly, and never touch a server.

Here is a minimal “insert note then list latest” snippet using `Microsoft.Data.Sqlite` that works in any .NET 8 desktop app:

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

The rest is UI: bind a list, handle Enter to save, Esc to focus, and keep interactions snappy.

If you want an example to sanity-check your own Windows App SDK UI decisions, apps like this are more useful than giant sample repos. They are small enough to copy, and real enough to reveal the tricky parts.
