---
title: "Приложение заметок \"только локально\" на WinUI 3 - правильная скучность: offline-first, SQLite, упор на клавиатуру"
description: "Miyanyedi Quick Note - это приложение заметок на WinUI 3 + SQLite, offline-first и дружественное к приватности. Почему \"только локально\" - это фича, плюс минимальный SQLite-сниппет для десктопных приложений на .NET 8."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "winui-3"
lang: "ru"
translationOf: "2026/01/a-winui-3-local-only-notes-app-is-the-right-kind-of-boring-offline-first-sqlite-keyboard-first"
translatedBy: "claude"
translationDate: 2026-04-29
---
Сегодня на r/csharp всплыло ещё одно симпатичное "маленькое, но реальное" десктоп-приложение: **Miyanyedi Quick Note** - лёгкий инструмент для заметок, построенный на **WinUI 3** и **SQLite**, явно спроектированный как offline-first и дружественный к приватности.

Источник: оригинальный пост и страница в Microsoft Store: [тред r/csharp](https://www.reddit.com/r/csharp/comments/1qg30jf/dev_miyanyedi_quick_note_a_fast_localonly_notepad/) и [страница приложения в Microsoft Store](https://apps.microsoft.com/store/detail/9PGB6SQSK601?cid=DevShareMWAPCS).

## "Только локально" - это фича, а не недостающая галочка

Большинство приложений для заметок сползают в систему аккаунтов, потому что синхронизация - рычаг роста. Компромисс очевиден: больше поверхности, больше сбоев, больше "куда делись мои данные".

Для десктоп-утилиты под Windows "без облака" может быть продуктом:

-   **Мгновенный запуск**: ни логина, ни сетевых вызовов.
-   **Предсказуемая приватность**: заметки остаются на вашей машине.
-   **Простая история бэкапа**: скопировал папку, экспортировал файл - всё.

Если вы строите внутренний тулинг на **.NET 8** (или даже .NET 9), эта установка "offline-first по умолчанию" - хорошая базовая линия.

## SQLite подходит к WinUI 3-приложениям, потому что держит область узкой

SQLite - это не "выбор базы данных", это выбор охвата. Вы говорите:

-   один пользователь
-   одна машина
-   один файл
-   простые запросы

Это хорошо ложится на требования к UI WinUI 3: можно держать CRUD вне UI-потока, быстро обновлять список и никогда не обращаться к серверу.

Вот минимальный сниппет "вставить заметку, затем перечислить последние" с использованием `Microsoft.Data.Sqlite`, который работает в любом десктоп-приложении .NET 8:

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

Остальное - UI: привязать список, обработать Enter для сохранения, Esc для фокуса и держать взаимодействия отзывчивыми.

Если вам нужен пример, чтобы свериться по собственным решениям UI на Windows App SDK, такие приложения полезнее, чем гигантские репозитории-семплы. Они достаточно малы, чтобы их скопировать, и достаточно реальны, чтобы вскрыть тонкие места.
