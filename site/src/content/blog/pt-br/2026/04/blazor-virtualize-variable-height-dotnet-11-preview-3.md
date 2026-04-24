---
title: "Blazor Virtualize finalmente lida com items de altura variável no .NET 11"
description: "ASP.NET Core no .NET 11 Preview 3 ensina ao componente Virtualize a medir items em runtime, consertando o jitter de spacing e scroll que as assunções de altura uniforme causavam."
pubDate: 2026-04-16
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "virtualize"
lang: "pt-br"
translationOf: "2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Qualquer um que tenha usado [`Virtualize<TItem>`](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/virtualization) num chat log, num feed de cards, ou num painel de notificações viu o mesmo bug: os items tremem no scroll, o thumb da scrollbar pula em volta, e você acaba com gaps ou overlaps esquisitos. A causa raiz sempre foi a mesma. `Virtualize` assumia que toda row tinha a mesma altura e usava esse único número pra computar a janela de scroll. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md) finalmente conserta: o componente agora mede items em runtime e ajusta o viewport virtual pras alturas que de fato aterrissam no DOM.

## Por que o comportamento antigo quebrava UIs reais

A API original te forçava a escolher um escalar via `ItemSize`. Se seus items eram 48px de altura, você setava 48. O Blazor então multiplicava item count por 48 pra dimensionar a área scrollável e renderizava só as rows cuja posição top computada interceptava a viewport. No momento em que suas rows continham um body de comprimento variável, uma quote que quebrava linha, ou uma imagem responsive, a matemática parava de bater com a realidade e o browser e o Blazor brigavam pelo placement.

```razor
<Virtualize Items="messages" Context="message">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

Esse snippet é exatamente o cenário que costumava dar problema. Um one-liner curto e uma resposta de cinco parágrafos dividem o mesmo slot de row, então os offsets de scroll derivam conforme você se move pela lista.

## Medindo o DOM renderizado

No .NET 11 Preview 3, `Virtualize` agora rastreia dimensões de items medidas em runtime e as alimenta de volta em seus cálculos de spacer. Você não precisa mais setar `ItemSize` num valor que bate com o pior caso, e não precisa mais setar `overflow: hidden` em filhos pra forçá-los a um box fixo. O componente ainda aceita um hint inicial de tamanho, mas trata como uma estimativa de partida em vez de verdade absoluta.

A segunda mudança é o default de `OverscanCount`. `Virtualize` costumava renderizar três items acima e abaixo do viewport. No Preview 3 esse default salta pra 15 pra haver items medidos o suficiente pra estabilizar a estimativa de altura antes do usuário scrollar pra território não medido.

```razor
<Virtualize Items="messages" Context="message" OverscanCount="30">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

Subir `OverscanCount` mais alto agora é um botão de tuning legítimo pra feeds com alturas de items selvagemente diferentes. O custo é renderizar mais DOM off-screen, mas em troca você ganha scrolling mais suave e uma scrollbar estável.

## QuickGrid mantém o default antigo

Se você está usando `QuickGrid`, nada muda. O componente pina seu próprio `OverscanCount` em 3 porque rows de grid são intencionalmente uniformes e renderizar 30 rows escondidas por tick de scroll queimaria performance pra tabelas com centenas de colunas. Isso é deliberado: os novos defaults miram os componentes onde a assunção antiga era genuinamente errada.

## O que mudar em apps existentes

Derrube o valor de `ItemSize` se você setava só pra disfarçar alturas variáveis, já que o caminho medido é estritamente melhor ali. Audite qualquer CSS que você adicionou pra forçar filhos num box fixo. E faça profile do scrolling antes de subir `OverscanCount`, porque 15 já é um salto grande desde 3.

A implementação vive em [dotnet/aspnetcore#64964](https://github.com/dotnet/aspnetcore/pull/64964). Pegue [.NET 11 Preview 3](https://dotnet.microsoft.com/download/dotnet/11.0) e na próxima vez que alguém perguntar por que o chat log scrolla estranho, você vai ter um workaround a menos pra explicar.
