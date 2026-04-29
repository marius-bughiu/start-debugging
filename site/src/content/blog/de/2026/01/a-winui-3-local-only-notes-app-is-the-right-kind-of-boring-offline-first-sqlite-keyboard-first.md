---
title: "Eine WinUI 3-App mit \"Nur lokal\"-Notizen ist die richtige Art langweilig: offline-first, SQLite, tastaturzentriert"
description: "Miyanyedi Quick Note ist eine WinUI 3 + SQLite-Notiz-App, die offline-first und datenschutzfreundlich ist. Warum \"nur lokal\" ein Feature ist, plus ein minimales SQLite-Snippet für .NET 8-Desktop-Apps."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "winui-3"
lang: "de"
translationOf: "2026/01/a-winui-3-local-only-notes-app-is-the-right-kind-of-boring-offline-first-sqlite-keyboard-first"
translatedBy: "claude"
translationDate: 2026-04-29
---
Auf r/csharp tauchte heute eine weitere nette "klein aber echt"-Desktop-App auf: **Miyanyedi Quick Note**, ein leichtgewichtiges Notizen-Tool, gebaut mit **WinUI 3** und **SQLite**, ausdrücklich offline-first und datenschutzfreundlich entworfen.

Quelle: der ursprüngliche Beitrag und der Microsoft Store-Eintrag: [r/csharp-Thread](https://www.reddit.com/r/csharp/comments/1qg30jf/dev_miyanyedi_quick_note_a_fast_localonly_notepad/) und [Microsoft Store-App-Seite](https://apps.microsoft.com/store/detail/9PGB6SQSK601?cid=DevShareMWAPCS).

## "Nur lokal" ist ein Feature, keine fehlende Checkbox

Die meisten Notiz-Apps driften in ein Account-System ab, weil Sync ein Wachstumshebel ist. Der Tradeoff ist offensichtlich: mehr Angriffsfläche, mehr Ausfälle, mehr "wo sind meine Daten hin".

Für ein Windows-Desktop-Werkzeug kann "kein Cloud" das Produkt sein:

-   **Sofortiger Start**: kein Sign-in, keine Netzwerkaufrufe.
-   **Vorhersehbarer Datenschutz**: Ihre Notizen bleiben auf Ihrer Maschine.
-   **Einfache Backup-Geschichte**: Ordner kopieren, Datei exportieren, fertig.

Wenn Sie internes Tooling auf **.NET 8** (oder sogar .NET 9) bauen, ist diese "offline-first by default"-Haltung eine gute Grundlinie.

## SQLite passt zu WinUI 3-Apps, weil es die Domäne klein hält

SQLite ist keine "Datenbankwahl", sondern eine Scope-Wahl. Sie sagen damit:

-   ein Benutzer
-   eine Maschine
-   eine Datei
-   einfache Abfragen

Das passt gut zu den UI-Anforderungen von WinUI 3: Sie können CRUD vom UI-Thread fernhalten, die Liste schnell aktualisieren und nie einen Server berühren.

Hier ist ein minimales "Notiz einfügen, dann neueste auflisten"-Snippet mit `Microsoft.Data.Sqlite`, das in jeder .NET 8-Desktop-App funktioniert:

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

Der Rest ist UI: eine Liste binden, Enter zum Speichern und Esc für den Fokus behandeln und die Interaktionen flott halten.

Wenn Sie ein Beispiel suchen, um Ihre eigenen Windows App SDK-UI-Entscheidungen auf Plausibilität zu prüfen, sind Apps wie diese nützlicher als riesige Sample-Repos. Sie sind klein genug zum Kopieren und echt genug, um die kniffligen Stellen offenzulegen.
