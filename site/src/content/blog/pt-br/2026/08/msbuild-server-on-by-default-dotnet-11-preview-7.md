---
title: "O servidor do MSBuild vem ligado por padrão no .NET 11 Preview 7"
description: "O Preview 7 muda o servidor do MSBuild de opcional para ligado por padrão, então chamadas seguidas de dotnet build e dotnet test reaproveitam um processo de trabalho já aquecido. Veja o que mudou, como desativar e como comprovar que o servidor realmente entrou em ação."
pubDate: 2026-08-18
tags:
  - "dotnet-11"
  - "msbuild"
  - "dotnet-sdk"
  - "build-performance"
lang: "pt-br"
translationOf: "2026/08/msbuild-server-on-by-default-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-18
---

O .NET 11 Preview 7 saiu em 2026-08-11 e, escondida na seção do SDK, há uma mudança de padrão que afeta cada build que você executa: o servidor do MSBuild agora fica ligado, a menos que você o desative explicitamente ([dotnet/sdk#55231](https://github.com/dotnet/sdk/pull/55231)).

O servidor do MSBuild mantém vivo um processo de trabalho do MSBuild já aquecido entre invocações da CLI. Sem ele, cada `dotnet build`, `dotnet test` e `dotnet run` paga a inicialização do processo do MSBuild, o aquecimento do JIT e a resolução do SDK do zero. Com ele, a segunda invocação e todas as seguintes pulam esse custo. O recurso existia atrás de `MSBUILDUSESERVER` havia várias versões, e o Preview 7 conclui o trabalho tornando "ligado" o padrão.

## Como desativar, e qual variável realmente manda

Duas variáveis de ambiente desligam o servidor, e elas não são equivalentes:

```bash
# Either of these keeps the classic single-shot MSBuild behavior
export DOTNET_CLI_USE_MSBUILD_SERVER=false
export MSBUILDUSESERVER=0
```

`DOTNET_CLI_USE_MSBUILD_SERVER=false` agora é a autoritativa. Ela propaga `MSBUILDUSESERVER=0` pela pilha, de modo que o servidor não pode ser reativado silenciosamente por um arquivo de resposta, por `MSBUILDFORCEMULTITHREADED=1` ou ao passar `/mt` ([dotnet/sdk#55393](https://github.com/dotnet/sdk/pull/55393)). Se você tem uma etapa de CI que precisa garantir um processo frio por build, essa é a variável a definir. Definir apenas `MSBUILDUSESERVER=0` deixa a porta aberta para que algo mais abaixo o reative.

## Por que o padrão mudou agora

O padrão não mudou sozinho. O Preview 7 reforçou o servidor porque o modo experimental de build multithread (`-mt`) o trata como pré-requisito, e várias arestas antigas foram corrigidas na mesma versão:

- O Server GC agora está disponível mesmo com `-nr:false`. Como o servidor do MSBuild é a única forma de obter o Server GC, o `-mt` passa a usar um servidor de vida curta que se encerra logo após o build, respeitando a intenção de não reaproveitar processos ([dotnet/msbuild#14248](https://github.com/dotnet/msbuild/pull/14248)).
- Processos aninhados do MSBuild não causam mais deadlock. Um build disparado por uma tarefa que por sua vez invoca o MSBuild pode prosseguir sem esperar pelo coordenador externo ([dotnet/msbuild#14224](https://github.com/dotnet/msbuild/pull/14224)).
- Exceções inesperadas durante o handshake inicial de conexão são capturadas e reportadas de forma limpa, em vez de abortar o cliente ([dotnet/msbuild#14292](https://github.com/dotnet/msbuild/pull/14292)).

O ganho aparece com mais clareza nos builds com `-mt`, que dependem do servidor aquecido para o estado do JIT e da resolução do SDK. No painel de desempenho do MSBuild, um `-t:Rebuild` do zero da solução do OrchardCore teve, em média, 26% menos tempo de relógio com `-mt` no Windows (de 146,2 s para 107,8 s) e 23% menos no Linux (de 118,8 s para 91,5 s).

## Como comprovar que o servidor entrou em ação

Uma inicialização fria silenciosa parece idêntica a uma aquecida, só que mais lenta. O Preview 7 adiciona um evento de build estruturado, `MSBuildServerLifecycleEventArgs`, que informa se o servidor foi criado, criado com vida curta, reaproveitado ou não usado, junto com o ID do processo do servidor ([dotnet/msbuild#14156](https://github.com/dotnet/msbuild/pull/14156)). Ele é registrado com importância baixa, então aparece nos logs binários e na verbosidade de diagnóstico sem alterar a saída normal do console:

```bash
dotnet build -v:diag
# or capture it for later
dotnet build -bl
```

Quando você precisar começar do zero, por exemplo depois de instalar um SDK novo ou de mudar uma propriedade global do MSBuild que o processo aquecido guardou em cache, encerre o servidor explicitamente em vez de caçar o processo:

```bash
dotnet build-server shutdown --msbuild
```

O comando não é novo, mas fica muito mais relevante agora que um servidor aquecido é o padrão. Ele merece um lugar na sua lista mental ao lado de "apagar obj e bin" quando um build começa a se comportar de forma estranha.

Os detalhes completos estão nas [notas de versão do SDK do .NET 11 Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/sdk.md). Se você está percorrendo o restante do Preview 7, o [suporte a arquivos ZIP protegidos por senha](/pt-br/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) é a outra mudança que vale a leitura.
