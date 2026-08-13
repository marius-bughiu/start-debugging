---
title: "Os circuitos do Blazor Server agora se pausam sozinhos quando a aba fica ociosa"
description: "O .NET 11 Preview 7 adiciona um pacote opcional que pausa os circuitos interativos de Server quando a aba do navegador está oculta, liberando memória e conexões SignalR presas a usuários que não estão realmente ali."
pubDate: 2026-08-13
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "signalr"
lang: "pt-br"
translationOf: "2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-13
---

O .NET 11 Preview 7 saiu em 2026-08-11 e, escondida na seção de ASP.NET Core, está a correção para um dos problemas de capacidade mais antigos do Blazor Server: um circuito que ninguém está olhando custa exatamente o mesmo que um circuito que alguém está usando. As [notas de versão do ASP.NET Core Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/aspnetcore.md) apresentam a pausa automática, motivada pela issue [dotnet/aspnetcore#64886](https://github.com/dotnet/aspnetcore/issues/64886).

## Aba oculta não é aba desconectada

O Blazor Server mantém o estado de cada usuário em um circuito no servidor, e esse circuito vive enquanto a conexão SignalR existir. Quando o usuário troca para outra aba e esquece a sua, o WebSocket não fecha. Navegadores de desktop seguram essa conexão aberta por horas sem reclamar. O circuito mantém sua árvore de componentes, seu escopo de injeção de dependência, sua fila de renderização e sua vaga no seu orçamento de concorrência, tudo isso para um usuário que saiu na hora do almoço.

A pausa automática, em vez disso, se conecta ao sinal de visibilidade do navegador. Quando a aba fica oculta por um intervalo configurável, o cliente pede ao servidor para pausar o circuito, o que o libera. Quando o usuário volta, o circuito é retomado.

## Como ligar

É opcional e vive em um pacote próprio:

```xml
<PackageReference Include="Microsoft.AspNetCore.Components.Server.AutoPause" />
```

A configuração fica pendurada no registro do modo de renderização:

```csharp
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .WithBrowserOptions(options =>
    {
        options.AddAutoPause(pause =>
        {
            pause.Enabled = true; // default
            pause.HiddenDelay = TimeSpan.FromSeconds(30); // default is 2 minutes
        });
    });
```

O padrão de `HiddenDelay` é dois minutos. Baixar para 30 segundos recupera memória mais rápido, ao custo de mais idas e vindas de retomada para usuários que alternam entre abas o tempo todo.

## Os casos em que ele se recusa a pausar

A engenharia interessante está no que a pausa automática se recusa a fazer. Ela adia a pausa quando um campo de texto ou um elemento `contenteditable` está com o foco, quando há áudio ou vídeo sem mudo tocando, quando existe uma janela de Picture-in-Picture aberta, quando um Web Lock está retido e enquanto ainda há atividade do circuito em andamento, como uma chamada de `IJSRuntime` ou uma transferência de stream. Ou seja: uma aba oculta que ainda está fazendo algo em nome do usuário não é puxada do chão dele.

Você pode acrescentar sua própria lógica de adiamento a partir de um inicializador JavaScript:

```javascript
// wwwroot/{ASSEMBLY NAME}.lib.module.js
export function beforeWebStart(options) {
  options.circuit ??= {};
  options.circuit.circuitHandlers ??= [];

  options.circuit.circuitHandlers.push({
    onCircuitPausing: async (signal) => {
      await savePendingWork(signal);
    },
  });
}
```

O `signal` é abortado se a pausa for cancelada, por exemplo porque a aba voltou a ficar visível enquanto seu handler ainda salvava. No lado do servidor, `Circuit.RequestCircuitPauseAsync` agora retorna `Task<bool>` e aceita um token de cancelamento opcional, então o trabalho de adiamento pode ser cancelado quando a conexão cai.

## O que verificar antes de habilitar

A pausa automática se apoia na infraestrutura de pausar e retomar introduzida no .NET 10, o que significa que a retomada reconstrói o circuito a partir do estado persistido dos componentes. Tudo o que um componente guarda em um campo comum, e nunca declara como persistente, some depois de uma pausa. Audite seus componentes com estado antes de ligar isso em produção e acompanhe sua telemetria de reconexão: o modo de falha aqui se parece muito com [um circuito que se desconectou sozinho](/pt-br/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/).

O Preview 7 é uma versão cheia. O lado de C# ganhou [break e continue com rótulo](/pt-br/2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7/) na mesma entrega.
