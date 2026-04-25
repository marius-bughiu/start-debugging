---
title: "Como fazer profiling de uma app .NET com dotnet-trace e ler a saída"
description: "Guia completo para fazer profiling de apps .NET 11 com dotnet-trace: instalar, escolher o perfil certo, capturar desde o startup e ler o .nettrace no PerfView, Visual Studio, Speedscope ou Perfetto."
pubDate: 2026-04-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "diagnostics"
  - "profiling"
lang: "pt-br"
translationOf: "2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output"
translatedBy: "claude"
translationDate: 2026-04-25
---

Para fazer profiling de uma app .NET com `dotnet-trace`, instale a ferramenta global com `dotnet tool install --global dotnet-trace`, encontre o PID do processo alvo com `dotnet-trace ps` e então execute `dotnet-trace collect --process-id <PID>`. Sem flags, as versões da ferramenta para .NET 10/11 usam por padrão os perfis `dotnet-common` e `dotnet-sampled-thread-time`, que juntos cobrem o mesmo terreno do antigo perfil `cpu-sampling`. Pressione Enter para parar a captura e o `dotnet-trace` grava um arquivo `.nettrace`. Para ler, abra no Visual Studio ou no PerfView no Windows, ou converta para um arquivo Speedscope ou Chromium com `dotnet-trace convert` e visualize em [speedscope.app](https://www.speedscope.app/) ou `chrome://tracing` / Perfetto. Este artigo usa dotnet-trace 9.0.661903 contra .NET 11 (preview 3), mas o fluxo é estável desde o .NET 5.

## O que o dotnet-trace realmente captura

`dotnet-trace` é um profiler exclusivamente gerenciado que conversa com um processo .NET pela [diagnostic port](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port) e pede ao runtime para transmitir eventos via [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe). Nenhum profiler nativo é anexado, nenhum processo é reiniciado e privilégios de administrador não são necessários (a exceção é o verbo `collect-linux`, mais sobre isso depois). A saída é um arquivo `.nettrace`: um stream binário de eventos mais informações de rundown (nomes de tipos, mapas de IL para nativo do JIT) emitidas no fim da sessão.

Esse contrato exclusivamente gerenciado é o motivo principal pelo qual times escolhem `dotnet-trace` em vez de PerfView, ETW ou `perf record`. Você obtém pilhas de chamadas gerenciadas resolvidas pelo JIT, eventos de GC, amostras de alocação, comandos ADO.NET e eventos personalizados baseados em `EventSource` a partir de uma única ferramenta que roda identicamente em Windows, Linux e macOS. O que você não obtém do verbo multiplataforma `collect` são frames nativos, pilhas do kernel ou eventos de processos não-.NET.

## Instale e capture seu primeiro trace

Instale uma vez por máquina:

```bash
# Verified against dotnet-trace 9.0.661903, .NET 11 preview 3
dotnet tool install --global dotnet-trace
```

A ferramenta usa o runtime .NET mais alto disponível na máquina. Se você só tem .NET 6 instalado, ainda funciona, mas você não verá os nomes de perfil de .NET 10/11 introduzidos em 2025. Execute `dotnet-trace --version` para confirmar o que você tem.

Agora encontre um PID. O verbo `ps` da própria ferramenta é a opção mais segura porque imprime apenas processos gerenciados que expõem um endpoint de diagnóstico:

```bash
dotnet-trace ps
# 21932 dotnet  C:\Program Files\dotnet\dotnet.exe   run --configuration Release
# 36656 dotnet  C:\Program Files\dotnet\dotnet.exe
```

Capture por 30 segundos contra o primeiro PID:

```bash
dotnet-trace collect --process-id 21932 --duration 00:00:00:30
```

O console imprime quais providers foram habilitados, o nome do arquivo de saída (padrão: `<appname>_<yyyyMMdd>_<HHmmss>.nettrace`) e um contador de KB ao vivo. Pressione Enter antes do tempo se quiser parar antes da duração terminar. Parar não é instantâneo: o runtime precisa fazer flush das informações de rundown para cada método compilado pelo JIT que apareceu no trace, o que em uma app grande pode levar dezenas de segundos. Resista à tentação de pressionar Ctrl+C duas vezes.

## Escolha o perfil certo

Toda a razão de o `dotnet-trace` parecer confuso na primeira vez é que "quais eventos eu deveria capturar?" tem muitas respostas certas. A ferramenta vem com perfis nomeados para que você não precise memorizar bitmasks de keywords. A partir do dotnet-trace 9.0.661903, o verbo `collect` suporta:

- `dotnet-common`: diagnósticos leves do runtime. Eventos de GC, AssemblyLoader, Loader, JIT, Exceptions, Threading, JittedMethodILToNativeMap e Compilation no nível `Informational`. Equivalente a `Microsoft-Windows-DotNETRuntime:0x100003801D:4`.
- `dotnet-sampled-thread-time`: amostra pilhas de threads gerenciadas a cerca de 100 Hz para identificar hotspots ao longo do tempo. Usa o sample profiler do runtime com pilhas gerenciadas.
- `gc-verbose`: coletas de GC mais amostragem de alocações de objetos. Mais pesado que `dotnet-common`, mas a única forma de encontrar hotspots de alocação sem um profiler de memória.
- `gc-collect`: apenas coletas de GC, overhead muito baixo. Bom para "o GC está me pausando?" sem afetar o throughput em estado estável.
- `database`: eventos de comandos ADO.NET e Entity Framework. Útil para pegar consultas N+1.

Quando você executa `dotnet-trace collect` sem flags, a ferramenta agora escolhe `dotnet-common` mais `dotnet-sampled-thread-time` por padrão. Essa combinação substitui o antigo perfil `cpu-sampling`, que amostrava todas as threads independentemente do uso de CPU e levava as pessoas a interpretar threads ociosas como quentes. Se você precisa do comportamento antigo exato por compatibilidade com traces mais antigos, use `--profile dotnet-sampled-thread-time --providers "Microsoft-Windows-DotNETRuntime:0x14C14FCCBD:4"`.

Você pode empilhar perfis com vírgulas:

```bash
dotnet-trace collect -p 21932 --profile dotnet-common,gc-verbose,database --duration 00:00:01:00
```

Para qualquer coisa mais sob medida, use `--providers`. O formato é `Provider[,Provider]`, onde cada provider é `Name[:Flags[:Level[:KeyValueArgs]]]`. Por exemplo, para capturar apenas eventos de contenção em nível verbose:

```bash
dotnet-trace collect -p 21932 --providers "Microsoft-Windows-DotNETRuntime:0x4000:5"
```

Se você quer uma sintaxe mais amigável para keywords do runtime, `--clrevents gc+contention --clreventlevel informational` é equivalente a `--providers Microsoft-Windows-DotNETRuntime:0x4001:4` e é muito mais fácil de ler em scripts.

## Capture desde o startup

Metade dos problemas interessantes de desempenho acontecem nos primeiros 200 ms, antes de você sequer copiar um PID. O .NET 5 adicionou duas formas de anexar `dotnet-trace` antes de o runtime começar a atender requisições.

A mais simples é deixar o `dotnet-trace` lançar o processo filho:

```bash
dotnet-trace collect --profile dotnet-common,dotnet-sampled-thread-time -- dotnet exec ./bin/Debug/net11.0/MyApp.dll arg1 arg2
```

Por padrão, stdin/stdout do filho são redirecionados. Passe `--show-child-io` se você precisa interagir com a app no console. Use `dotnet exec <app.dll>` ou um binário publicado self-contained em vez de `dotnet run`: o último gera processos de build/launcher que podem se conectar à ferramenta primeiro e deixar sua app real suspensa no runtime.

A opção mais flexível é a diagnostic port. Em um shell:

```bash
dotnet-trace collect --diagnostic-port myport.sock
# Waiting for connection on myport.sock
# Start an application with the following environment variable:
# DOTNET_DiagnosticPorts=/home/user/myport.sock
```

Em outro shell, defina a variável de ambiente e lance normalmente:

```bash
export DOTNET_DiagnosticPorts=/home/user/myport.sock
./MyApp arg1 arg2
```

O runtime fica suspenso até a ferramenta estar pronta, então inicia normalmente. Esse padrão se compõe com containers (monte o socket dentro do container), com serviços que você não consegue facilmente envolver e com cenários multi-processo onde você só quer tracejar um filho específico.

## Pare em um evento específico

Traces longos são barulhentos. Se você só se importa com a fatia entre "JIT começou a compilar X" e "requisição terminou", o `dotnet-trace` pode parar no momento em que um evento específico dispara:

```bash
dotnet-trace collect -p 21932 \
  --stopping-event-provider-name Microsoft-Windows-DotNETRuntime \
  --stopping-event-event-name Method/JittingStarted \
  --stopping-event-payload-filter MethodNamespace:MyApp.HotPath,MethodName:Render
```

O stream de eventos é parseado de forma assíncrona, então alguns eventos extras vazam após o match antes de a sessão realmente fechar. Isso normalmente não é um problema quando você está procurando hotspots.

## Leia a saída .nettrace

Um arquivo `.nettrace` é o formato canônico. Três visualizadores lidam com ele diretamente, e mais dois ficam disponíveis após uma conversão de uma linha.

### PerfView (Windows, gratuito)

[PerfView](https://github.com/microsoft/perfview) é a ferramenta original que o time do runtime do .NET usa. Abra o arquivo `.nettrace`, dê duplo clique em "CPU Stacks" se você capturou `dotnet-sampled-thread-time`, ou em "GC Heap Net Mem" / "GC Stats" se capturou `gc-verbose` ou `gc-collect`. A coluna "Exclusive %" diz onde as threads gerenciadas gastaram seu tempo; "Inclusive %" diz qual pilha de chamadas alcançou o frame quente.

PerfView é denso. Os dois cliques que vale memorizar são: clique direito num frame e selecione "Set As Root" para se aprofundar, e use a caixa de texto "Fold %" para colapsar frames pequenos para que o caminho quente seja legível. Se o trace foi truncado por uma exceção não tratada, lance o PerfView com a flag `/ContinueOnError` e você ainda pode inspecionar o que aconteceu até o crash.

### Visual Studio Performance Profiler

Visual Studio 2022/2026 abre arquivos `.nettrace` diretamente via File > Open. A view CPU Usage é a UI mais amigável para alguém que nunca usou PerfView, com flame graph, painel "Hot Path" e atribuição por linha de código-fonte se seus PDBs estiverem por perto. A desvantagem é que o Visual Studio tem menos tipos de view que o PerfView, então profiling de alocações e análise de GC normalmente são mais claros no PerfView.

### Speedscope (multiplataforma, navegador)

A forma mais rápida de olhar um trace no Linux ou macOS é convertê-lo para Speedscope e abrir o resultado no navegador. Você pode pedir ao `dotnet-trace` para escrever Speedscope diretamente:

```bash
dotnet-trace collect -p 21932 --format Speedscope --duration 00:00:00:30
```

Ou converter um `.nettrace` existente:

```bash
dotnet-trace convert myapp_20260425_120000.nettrace --format Speedscope -o myapp.speedscope.json
```

Arraste o `.speedscope.json` resultante para [speedscope.app](https://www.speedscope.app/). A view "Sandwich" é o recurso matador: ordena métodos por tempo total e permite clicar em qualquer um para ver chamadores e chamados inline. É o mais perto de PerfView que você consegue num Mac. Note que a conversão é com perda: metadados de rundown, eventos de GC e eventos de exceção são descartados. Mantenha o `.nettrace` original ao lado caso queira olhar alocações depois.

### Perfetto / chrome://tracing

`--format Chromium` produz um arquivo JSON que você pode soltar em `chrome://tracing` ou [ui.perfetto.dev](https://ui.perfetto.dev/). Essa view brilha para perguntas de concorrência: picos de thread pool, cascatas async e sintomas de contenção de locks se leem mais naturalmente em uma timeline do que em um flame graph. O artigo da comunidade [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/) percorre um loop completo, e nós cobrimos [um fluxo prático de Perfetto + dotnet-trace](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/) com mais detalhes no início deste ano.

### dotnet-trace report (CLI)

Se você está em um servidor headless ou só quer uma checagem rápida, a própria ferramenta pode resumir um trace:

```bash
dotnet-trace report myapp_20260425_120000.nettrace topN -n 20
```

Isso imprime os top 20 métodos por tempo de CPU exclusivo. Adicione `--inclusive` para mudar para tempo inclusivo e `-v` para imprimir assinaturas completas de parâmetros. Não é um substituto para um visualizador, mas é o suficiente para responder "o deploy regrediu algo óbvio?" sem sair do SSH.

## Detalhes que mordem novatos

Um punhado de casos de borda explica a maioria dos relatos de "por que meu trace está vazio?".

- O buffer é de 256 MB por padrão. Cenários com alta taxa de eventos (todo método em um loop apertado, amostragem de alocação numa carga de streaming) estouram esse buffer e descartam eventos silenciosamente. Aumente com `--buffersize 1024`, ou estreite os providers.
- No Linux e macOS, `--name` e `--process-id` exigem que a app alvo e o `dotnet-trace` compartilhem a mesma variável de ambiente `TMPDIR`. Se elas não casarem, a conexão expira sem erro útil. Containers e invocações com `sudo` são os culpados habituais.
- O trace fica incompleto se a app alvo crashar no meio da captura. O runtime trunca o arquivo para evitar corrupção. Abra no PerfView com `/ContinueOnError` e leia o que estiver lá: normalmente é o suficiente para encontrar a causa.
- `dotnet run` gera processos auxiliares que se conectam a um listener `--diagnostic-port` antes da sua app real. Use `dotnet exec MyApp.dll` ou um binário publicado self-contained quando estiver tracejando desde o startup.
- O padrão `--resume-runtime true` deixa a app começar assim que a sessão estiver pronta. Se você quer que a app fique suspensa (raro, principalmente para depuradores), passe `--resume-runtime:false`.
- Para .NET 10 no Linux com kernel 6.4+, o novo verbo `collect-linux` captura eventos do kernel, frames nativos e amostras de toda a máquina, mas exige root e escreve um `.nettrace` em formato preview que nem todo visualizador suporta ainda. Use quando você genuinamente precisa de frames nativos; use `collect` por padrão para todo o resto.

## Para onde ir depois

`dotnet-trace` é a ferramenta certa para "o que minha app está fazendo agora?". Para métricas contínuas (RPS, tamanho do heap do GC, comprimento da fila do thread pool) sem produzir um arquivo, recorra ao `dotnet-counters`. Para caça a vazamentos de memória que precisam de um dump real do heap, recorra ao `dotnet-gcdump`. As três ferramentas compartilham o encanamento da diagnostic port, então a memória muscular de install / `ps` / `collect` se transfere.

Se você escreve código que roda em produção, também quer um modelo mental da linguagem amigável a tracing. Nossas notas sobre [cancelar tarefas de longa duração sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), [transmitir arquivos de endpoints ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) e [ler arquivos CSV grandes em .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) mostram padrões que se parecem muito diferentes em um flame graph do `dotnet-trace` das versões ingênuas, e isso é uma coisa boa.

O formato `.nettrace` é aberto: se você quer automatizar a análise, [Microsoft.Diagnostics.Tracing.TraceEvent](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent) lê os mesmos arquivos programaticamente. É assim que o próprio PerfView funciona por baixo dos panos, e é assim que você constrói um relatório pontual quando nenhum visualizador existente faz a pergunta que você tem.

## Fontes

- [Referência da ferramenta de diagnóstico dotnet-trace](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace) (MS Learn, atualizado pela última vez em 2026-03-19)
- [Documentação do EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [Documentação da diagnostic port](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)
- [Providers de eventos conhecidos no .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/well-known-event-providers)
- [PerfView no GitHub](https://github.com/microsoft/perfview)
- [Speedscope](https://www.speedscope.app/)
- [Perfetto UI](https://ui.perfetto.dev/)
