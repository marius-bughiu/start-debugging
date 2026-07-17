---
title: "ASP.NET Core 11 Preview 6 ativa a proteção CSRF automática"
description: "O Preview 6 rejeita por padrão as requisições entre origens não seguras do navegador, lendo o cabeçalho Sec-Fetch-Site em vez de um token antiforgery. Veja o que ele bloqueia e como excluir endpoints."
pubDate: 2026-07-17
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "security"
  - "csrf"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6"
translatedBy: "claude"
translationDate: 2026-07-17
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) chegou em 2026-07-15, e a mudança do ASP.NET Core que tem mais chance de afetar sua app é uma para a qual você não precisa escrever nenhum código: a proteção contra cross-site request forgery (CSRF) agora vem ativada por padrão, sem configuração, em Minimal APIs, MVC, Razor Pages e Blazor. Ela não depende do token antiforgery clássico. Em vez disso, lê o cabeçalho `Sec-Fetch-Site` do navegador.

## Por que valia a pena substituir a dança do token

O modelo antigo colocava o peso sobre você. Você emitia um token antiforgery em cada formulário, validava no POST e compartilhava as chaves de Data Protection entre as instâncias para que o token ainda descriptografasse após um salto do balanceador de carga. Se esquecesse qualquer uma dessas etapas, você tinha ou uma falha de segurança ou um erro em runtime (veja [quando o token antiforgery não pôde ser descriptografado](/pt-br/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)). Para APIs que não tinham nenhum formulário renderizado no servidor onde pendurar um token, a orientação era ainda mais nebulosa.

O Fetch Metadata contorna tudo isso. Navegadores modernos anexam `Sec-Fetch-Site` a cada requisição, e o valor não pode ser forjado por script. O Preview 6 o inspeciona (recorrendo ao cabeçalho `Origin`) e registra um veredicto de confiança antes de o seu endpoint executar.

## O que é permitido e o que é rejeitado

A regra é estreita de propósito. Requisições de mesma origem, navegações iniciadas pelo usuário (digitar uma URL, clicar em um link) e clientes que não são navegadores (um app móvel, `HttpClient`, curl) são todos permitidos. O que é rejeitado é o formato real de um CSRF: uma requisição de navegador entre origens que tenta consumir um dos seus endpoints. Como é automático, os templates do Blazor Web App não chamam mais `app.UseAntiforgery()`.

Você ainda mantém as exclusões onde precisa delas. Um webhook público que recebe POST de um serviço externo é um cliente que não é navegador, então ele passa, mas se você quiser ser explícito:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Protected automatically: a cross-origin page cannot POST here from a browser.
app.MapPost("/transfer", (TransferRequest req) => Results.Ok());

// Opt a single endpoint out.
app.MapPost("/webhook", (Payload p) => Results.Ok())
   .DisableAntiforgery();

app.Run();
```

No MVC, a saída de emergência por ação não muda:

```csharp
[HttpPost]
[IgnoreAntiforgeryToken]
public IActionResult Receive(Payload p) => Ok();
```

Para desativar o recurso na app inteira, defina a chave de configuração `DisableCsrfProtection`:

```json
{
  "DisableCsrfProtection": true
}
```

Se a lógica de veredicto integrada não se encaixar na sua topologia, registre uma implementação personalizada de `ICsrfProtection` para substituir por completo a decisão de confiança.

## Antes de trocar o runtime

Essa API apareceu pela primeira vez no Preview 4 e foi remodelada no Preview 6 para seguir as convenções padrão de options, então, se você a testou antes, verifique novamente sua configuração. E trate-a como defesa em profundidade, não como substituta da autenticação: ela barra o vetor do navegador entre origens, não um token bearer roubado. Os detalhes completos estão nas [notas de versão do ASP.NET Core Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Instale o SDK do .NET 11 Preview 6, use como alvo `net11.0` e audite qualquer endpoint que legitimamente espere POST entre origens do navegador antes de publicar.
