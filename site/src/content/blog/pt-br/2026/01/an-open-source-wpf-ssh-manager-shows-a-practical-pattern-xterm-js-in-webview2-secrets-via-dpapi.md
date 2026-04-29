---
title: "Um gerenciador SSH WPF open-source mostra um padrão prático: xterm.js no WebView2, segredos via DPAPI"
description: "SshManager é um gerenciador SSH WPF open-source construído em .NET 8. Mostra um padrão prático: xterm.js dentro do WebView2 para renderização de terminal, EF Core + SQLite para persistência e DPAPI para proteção de credenciais locais."
pubDate: 2026-01-18
tags:
  - "dotnet"
  - "dotnet-8"
  - "webview2"
  - "wpf"
lang: "pt-br"
translationOf: "2026/01/an-open-source-wpf-ssh-manager-shows-a-practical-pattern-xterm-js-in-webview2-secrets-via-dpapi"
translatedBy: "claude"
translationDate: 2026-04-29
---
Hoje apareceu um projeto interessante de desktop para Windows no r/csharp: **SshManager**, um gerenciador SSH e serial open-source construído com **.NET 8** e **WPF**.

Fonte: o post original no Reddit e o repositório: [thread em r/csharp](https://www.reddit.com/r/csharp/comments/1qgf6e1/i_built_an_opensource_ssh_manager_for_windows/) e [tomertec/sshmanager](https://github.com/tomertec/sshmanager).

## A parte interessante não é "SSH em C#"

SSH em si está resolvido. O que vale a pena estudar é como este app costura três peças bem pragmáticas:

-   **Uma UI de terminal real**: xterm.js renderizado dentro do **WebView2**, então você obtém uma UX de terminal (copiar, seleção, renderização monoespaçada) sem tentar reinventar um controle de terminal em WPF.
-   **Persistência local**: EF Core + SQLite para perfis de conexão, tags e metadados de sessão.
-   **Proteção de segredos nativa do Windows**: senhas criptografadas com **Windows DPAPI**, que é exatamente o que você quer para uma ferramenta de desktop apenas local.

É um padrão de que gosto porque mantém o "problema difícil de UX" (renderização de terminal) dentro de um componente web comprovado, enquanto o resto continua .NET 8 idiomático.

## DPAPI é um bom default para credenciais apenas locais

DPAPI não é criptografia entre máquinas. Está atrelado ao perfil de usuário atual do Windows (ou à máquina, dependendo do escopo). Isso é uma vantagem para um app desktop de usuário único.

Aqui está um helper mínimo de "proteger/desproteger" que você pode levar para um app WPF em .NET 8:

```cs
using System.Security.Cryptography;
using System.Text;

static class Dpapi
{
    public static string ProtectToBase64(string plaintext)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var protectedBytes = ProtectedData.Protect(
            bytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    public static string UnprotectFromBase64(string base64)
    {
        var protectedBytes = Convert.FromBase64String(base64);
        var bytes = ProtectedData.Unprotect(
            protectedBytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }
}
```

Se depois você adicionar "sincronizar configurações entre dispositivos", DPAPI vira a ferramenta errada e você precisa de outra estratégia de chaves. Para um gerenciador Windows-first apenas local, DPAPI é exatamente o nível certo de entediante.

## WebView2 + xterm.js é a opção "pare de brigar com o WPF" para terminais

Se você está construindo ferramentas internas em .NET 8 e a UI precisa se comportar como um terminal real (vim, tmux, htop), embutir xterm.js dentro do WebView2 é uma fronteira surpreendentemente limpa:

-   O WPF é dono da janela e do ciclo de vida do app.
-   O lado web é dono da renderização do terminal e do comportamento do teclado.
-   Sua ponte é só mensagens: escrever bytes no PTY, ler a saída, devolvê-la.

Se quer um exemplo que não seja uma demo de brinquedo, este repo merece uma olhada. Comece pelo modelo de conexão e como a view do terminal é conectada, e depois decida se essa abordagem híbrida cabe na sua própria ferramenta.
