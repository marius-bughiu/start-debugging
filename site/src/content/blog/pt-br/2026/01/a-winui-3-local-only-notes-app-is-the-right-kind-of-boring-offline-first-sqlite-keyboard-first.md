---
title: "Um app de notas \"apenas local\" em WinUI 3 é o tipo certo de entediante: offline-first, SQLite, teclado em primeiro lugar"
description: "Miyanyedi Quick Note é um app de notas em WinUI 3 + SQLite, offline-first e amigável à privacidade. Eis por que apenas local é um recurso, além de um snippet mínimo de SQLite para apps desktop em .NET 8."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "winui-3"
lang: "pt-br"
translationOf: "2026/01/a-winui-3-local-only-notes-app-is-the-right-kind-of-boring-offline-first-sqlite-keyboard-first"
translatedBy: "claude"
translationDate: 2026-04-29
---
Outro app desktop "pequeno mas real" apareceu hoje no r/csharp: **Miyanyedi Quick Note**, uma ferramenta leve de notas construída com **WinUI 3** e **SQLite**, explicitamente projetada para ser offline-first e amigável à privacidade.

Fonte: o post original e a listagem na Microsoft Store: [thread em r/csharp](https://www.reddit.com/r/csharp/comments/1qg30jf/dev_miyanyedi_quick_note_a_fast_localonly_notepad/) e [página do app na Microsoft Store](https://apps.microsoft.com/store/detail/9PGB6SQSK601?cid=DevShareMWAPCS).

## "Apenas local" é um recurso, não um checkbox faltando

A maioria dos apps de notas acaba caindo num sistema de contas porque sync é alavanca de crescimento. O trade-off é óbvio: mais superfície, mais quedas, mais "para onde foram meus dados".

Para um utilitário desktop no Windows, "sem nuvem" pode ser o produto:

-   **Inicialização instantânea**: sem sign-in, sem chamadas de rede.
-   **Privacidade previsível**: suas notas ficam na sua máquina.
-   **História simples de backup**: copia uma pasta, exporta um arquivo, pronto.

Se você está construindo ferramentas internas em **.NET 8** (ou mesmo .NET 9), essa mentalidade "offline-first por padrão" é uma boa base.

## SQLite combina com apps WinUI 3 porque mantém o domínio pequeno

SQLite não é "uma escolha de banco de dados", é uma escolha de escopo. Você está dizendo:

-   um usuário
-   uma máquina
-   um arquivo
-   consultas simples

Isso casa bem com os requisitos de UI do WinUI 3: dá para manter o CRUD fora da thread de UI, atualizar a lista rápido e nunca encostar num servidor.

Aqui está um snippet mínimo de "inserir nota e listar as mais recentes" usando `Microsoft.Data.Sqlite` que funciona em qualquer app desktop em .NET 8:

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

O resto é UI: vincular uma lista, tratar Enter para salvar, Esc para focar e manter as interações ágeis.

Se quer um exemplo para checar a sanidade das suas próprias decisões de UI com o Windows App SDK, apps como este são mais úteis do que repositórios gigantes de exemplo. São pequenos o bastante para copiar e reais o bastante para revelar as partes complicadas.
