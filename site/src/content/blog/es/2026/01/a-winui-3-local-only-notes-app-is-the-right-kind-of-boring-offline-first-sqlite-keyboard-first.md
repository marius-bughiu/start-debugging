---
title: "Una app de notas \"solo local\" en WinUI 3 es el tipo correcto de aburrida: offline-first, SQLite, primero el teclado"
description: "Miyanyedi Quick Note es una app de notas en WinUI 3 + SQLite que es offline-first y respetuosa con la privacidad. Aquí va por qué solo local es una característica, más un snippet mínimo de SQLite para apps de escritorio en .NET 8."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "winui-3"
lang: "es"
translationOf: "2026/01/a-winui-3-local-only-notes-app-is-the-right-kind-of-boring-offline-first-sqlite-keyboard-first"
translatedBy: "claude"
translationDate: 2026-04-29
---
Otra app de escritorio "pequeña pero real" apareció hoy en r/csharp: **Miyanyedi Quick Note**, una herramienta ligera de notas construida con **WinUI 3** y **SQLite**, diseñada explícitamente para ser offline-first y respetuosa con la privacidad.

Fuente: el post original y la ficha en Microsoft Store: [hilo en r/csharp](https://www.reddit.com/r/csharp/comments/1qg30jf/dev_miyanyedi_quick_note_a_fast_localonly_notepad/) y [página de la app en Microsoft Store](https://apps.microsoft.com/store/detail/9PGB6SQSK601?cid=DevShareMWAPCS).

## "Solo local" es una característica, no un checkbox que falta

La mayoría de las apps de notas terminan en un sistema de cuentas porque la sincronización es palanca de crecimiento. El compromiso es obvio: más superficie, más caídas, más "¿dónde están mis datos?".

Para una utilidad de escritorio Windows, "sin cloud" puede ser el producto:

-   **Arranque instantáneo**: sin sign-in, sin llamadas de red.
-   **Privacidad predecible**: tus notas se quedan en tu máquina.
-   **Historia simple de backup**: copiar una carpeta, exportar un archivo, listo.

Si construyes herramientas internas sobre **.NET 8** (o incluso .NET 9), esta mentalidad de "offline-first por defecto" es una buena base.

## SQLite encaja con apps WinUI 3 porque mantiene el dominio pequeño

SQLite no es "una elección de base de datos", es una elección de alcance. Estás diciendo:

-   un usuario
-   una máquina
-   un archivo
-   consultas simples

Eso encaja bien con los requisitos de UI de WinUI 3: puedes mantener el CRUD fuera del hilo de UI, actualizar la lista rápido y no tocar nunca un servidor.

Aquí va un snippet mínimo de "insertar nota y listar las últimas" usando `Microsoft.Data.Sqlite` que funciona en cualquier app de escritorio en .NET 8:

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

El resto es UI: enlazar una lista, manejar Enter para guardar, Esc para enfocar y mantener las interacciones rápidas.

Si quieres un ejemplo para revisar la cordura de tus propias decisiones de UI con Windows App SDK, apps como esta son más útiles que repos de muestra gigantes. Son lo suficientemente pequeñas para copiar y lo suficientemente reales para revelar las partes complicadas.
