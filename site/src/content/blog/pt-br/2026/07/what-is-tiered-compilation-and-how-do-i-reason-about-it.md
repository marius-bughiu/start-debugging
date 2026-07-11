---
title: "O que é compilação em camadas e como raciocinar sobre ela?"
description: "A compilação em camadas permite que o JIT do .NET compile cada método duas vezes: primeiro rápido e sem otimização para colocar sua aplicação em execução, e depois de novo com otimizações completas quando o runtime sabe que um método é quente. Aqui você verá como o tier 0, o tier 1, a substituição na pilha e o Dynamic PGO se encaixam, e como observá-los e ajustá-los."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it"
translatedBy: "claude"
translationDate: 2026-07-11
---

A compilação em camadas é a estratégia do runtime do .NET de compilar cada método mais de uma vez. Na primeira vez que um método é executado, o compilador JIT (just-in-time) produz código de "tier 0" rapidamente e quase sem otimização, para que sua aplicação inicie rápido. Se mais tarde esse método se revelar quente (chamado pelo menos 30 vezes, ou girando em um loop longo), uma thread em segundo plano o recompila como código "tier 1" totalmente otimizado e o troca sem alarde. Você obtém a velocidade de inicialização e o throughput em regime estacionário do mesmo binário, sem ter que escolher entre eles. Está ativada por padrão desde o .NET Core 3.0, e no .NET 8 e posteriores também alimenta um profiler (Dynamic PGO) que torna o código de tier 1 mais inteligente do que um compilador estático conseguiria. Esta publicação explica as peças móveis e como raciocinar sobre elas quando você faz profiling ou benchmarks.

Tudo aqui tem como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 (`11.0.100`), mas a mecânica tem sido estável desde o .NET 7, quando a substituição na pilha e o jitting rápido de loops passaram a ser o padrão em x64 e arm64. Quando um comportamento depende de uma versão específica, eu o destaco.

## Por que o runtime compila o mesmo método duas vezes

Um compilador JIT enfrenta um dilema toda vez que vê um método pela primeira vez. Ele pode compilar esse método lentamente e produzir código de máquina excelente, o que é ótimo para um método que executa um milhão de vezes mas um desperdício para um método que executa uma única vez durante a inicialização. Ou pode compilar rápido e produzir código medíocre, o que é ótimo para a inicialização mas deixa throughput na mesa nos caminhos quentes.

Compiladores ahead-of-time desviam disso otimizando tudo antecipadamente, e pagam por isso com tempo de build e binários maiores. Um JIT puro que sempre otimiza paga por isso com uma inicialização lenta, porque uma aplicação real compila com JIT milhares de métodos antes de servir sua primeira requisição. A compilação em camadas se recusa a escolher. Ela compila rápido primeiro para que o processo comece a andar, depois observa quais métodos realmente importam e recompila apenas esses com o otimizador caro. A imensa maioria dos métodos em qualquer processo executa um punhado de vezes e nunca chega a merecer o tier 1, então o orçamento do otimizador vai onde compensa.

## Tier 0 e tier 1: o que "rápido" e "otimizado" significam de verdade

O tier 0 é produzido pelo "quick JIT". O compilador pula a maioria das otimizações: sem inlining agressivo, sem desenrolamento de loops, com alocação mínima de registradores. Ele emite código de máquina direto em uma fração do tempo que uma compilação completa levaria. O código resultante é correto e frequentemente várias vezes mais lento que o código otimizado, mas existe quase imediatamente.

O tier 1 é o otimizador completo. Ele faz inlining, elimina verificações de limites onde consegue provar que são redundantes, retira invariantes dos loops e (desde o .NET 8) usa dados de perfil coletados enquanto o tier 0 rodava. A compilação de tier 1 é muito mais lenta de produzir, que é exatamente por isso que o runtime só a gasta em métodos que provaram que valem a pena.

Há uma terceira fonte de código que participa do mesmo sistema: ReadyToRun (R2R). Os assemblies do framework são distribuídos com código R2R pré-compilado, para que o runtime não precise compilar com JIT `string.Substring` a cada inicialização. O código R2R é tratado como um tier pré-assado que ainda pode ser substituído por uma versão de tier 1 ainda melhor, quando o método se revela quente na sua carga de trabalho específica. É por isso que desativar a compilação em camadas pode às vezes tornar uma aplicação mais lenta em vez de mais rápida: você perde a capacidade de reotimizar métodos do framework com o seu perfil.

## O limiar de contagem de chamadas e o atraso de camadas

Um método não salta para o tier 1 no momento em que esquenta. Dois mecanismos controlam a promoção.

Primeiro, um contador de chamadas. Cada método de tier 0 tem um contador, e uma vez que ele foi chamado 30 vezes (o valor padrão de `DOTNET_TC_CallCountThreshold`), é enfileirado para a recompilação para tier 1. Trinta é deliberadamente baixo; o objetivo é capturar qualquer coisa que execute repetidamente sem esperar que rode milhares de vezes em código lento.

Segundo, um atraso de inicialização. O runtime não começa a contar chamadas imediatamente, porque durante a inicialização quase todos os métodos estão sendo chamados pela primeira vez e nenhum está ainda quente em regime estacionário. Há um temporizador de aproximadamente 100 ms que reinicia toda vez que um novo método de tier 0 é compilado com JIT. Só quando esse temporizador transcorre sem novas compilações de tier 0, ou seja, quando a tempestade de JIT da inicialização se acalmou, é que a contagem de chamadas começa para valer. É por isso que a inicialização em si permanece em código de tier 0 barato e o otimizador não se agita sobre métodos que só rodaram durante a inicialização.

A recompilação ocorre em uma thread em segundo plano emprestada do pool de threads, trabalhando em fatias de cerca de 10 ms por vez para que nunca monopolize um worker. Seu método quente continua executando seu código de tier 0 até que a versão otimizada esteja pronta, momento em que o runtime redireciona atomicamente as chamadas futuras para o código de tier 1. Nada bloqueia, e nenhuma chamada em andamento é interrompida.

```csharp
// .NET 11, C# 14.
// Call this in a tight loop and the runtime will promote it to tier 1
// after ~30 calls, once startup has settled. You will not see the
// promotion in the method's behavior, only in its speed.
static long SumOfSquares(int n)
{
    long acc = 0;
    for (int i = 0; i < n; i++)
        acc += (long)i * i;
    return acc;
}
```

## Substituição na pilha: escapar de um loop quente que nunca retorna

O mecanismo de contagem de chamadas tem um buraco evidente. E quanto a um método que é chamado exatamente uma vez mas depois gira em um loop durante toda a vida do processo? Pense em `Main`, ou em um worker que itera sobre uma fila para sempre. Sua contagem de chamadas é 1, então ele ficaria preso em código lento de tier 0 permanentemente.

A substituição na pilha (OSR, on-stack replacement) fecha esse buraco. Quando o quick JIT emite código de tier 0 para um método que contém um loop, ele também insere um pequeno contador na aresta de retorno do loop (o salto de volta ao topo). Se essa aresta de retorno executar vezes suficientes, o runtime compila uma versão otimizada do método e transfere a execução para ela em pleno voo, substituindo o frame de pilha em execução no local. O loop que começou no tier 0 termina no tier 1 sem que o método jamais tenha retornado.

O OSR é o que torna seguro compilar com quick JIT métodos com loops em primeiro lugar. Antes de o OSR chegar, o runtime se recusava a aplicar quick JIT a qualquer método que contivesse um loop (o antigo valor padrão `false` de `TieredCompilationQuickJitForLoops`), porque um loop longo preso em código sem otimização era um verdadeiro precipício de desempenho. O [PR #65675 no dotnet/runtime](https://github.com/dotnet/runtime/pull/65675) ativou por padrão tanto `DOTNET_TC_QuickJitForLoops` quanto `DOTNET_TC_OnStackReplacement` para x64 e arm64 no .NET 7, então hoje quase todos os métodos começam no tier 0 e o runtime confia no OSR para resgatar qualquer coisa presa em um loop longo. O resultado foi uma melhora de inicialização de aproximadamente 25% em aplicações com muito JIT, e de 10 a 30% melhor tempo até a primeira requisição nos benchmarks do TechEmpower, conforme o [relatório de desempenho do .NET 7](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/).

## Dynamic PGO: a passada de tier 0 também faz profiling

Aqui está a parte que surpreende as pessoas. No .NET 8 e posteriores, o Dynamic PGO (profile-guided optimization) está ativado por padrão, e é o que torna todo o design de duas passadas mais do que um simples "compilar duas vezes".

Quando o Dynamic PGO está ativo, o código de tier 0 não está apenas sem otimização, mas também está instrumentado. Ele registra fatos baratos sobre como o método realmente se comporta: quais tipos concretos aparecem em um local de chamada virtual, qual ramo de um `if` é tomado com mais frequência, quantas vezes um loop itera. Quando o método é promovido para tier 1, o otimizador lê esse perfil e especializa o código para o que realmente aconteceu em tempo de execução. Uma chamada virtual cujo destino foi `List<int>` em 99% das vezes recebe esse caminho com inlining, protegido por uma verificação de tipo (devirtualização protegida). Um ramo que quase nunca é tomado é retirado do caminho quente.

Essa é uma otimização que um compilador estático não consegue fazer, porque depende de dados que só existem enquanto sua carga de trabalho específica roda. É também por isso que a compilação em camadas mais Dynamic PGO pode superar uma configuração totalmente otimizada desde o início em throughput real, não apenas na inicialização. Você pode desativá-lo para comparar:

```xml
<!-- .NET 11, C# 14. Disables Dynamic PGO. Default is enabled since .NET 8. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

O compromisso é que o código de tier 0 instrumentado é ligeiramente mais lento e ligeiramente maior que o tier 0 simples, e o resultado de tier 1 é melhor. Para um servidor que roda durante horas, essa é uma vitória fácil. Para uma função de vida curta que termina antes de qualquer coisa chegar ao tier 1, a instrumentação é puro custo sem recompensa, que é uma das razões pelas quais cargas de trabalho sensíveis à inicialização a frio às vezes desativam isso. Há um tratamento mais completo desse cenário no guia sobre [reduzir o tempo de inicialização a frio de um AWS Lambda com .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Como ver a atribuição de camadas acontecendo

Raciocinar sobre a compilação em camadas é muito mais fácil quando você consegue vê-la. O runtime emite eventos ETW/EventPipe para cada compilação JIT, marcados com o tier, então o `dotnet-trace` pode mostrar as transições:

```bash
# .NET 11 SDK 11.0.100. Capture JIT and tiering events for a running process.
dotnet-trace collect --process-id 1234 \
  --providers Microsoft-Windows-DotNETRuntime:0x1000:5
```

Os eventos `MethodJittingStarted` e `MethodLoadVerbose` carregam um campo de nível de otimização, então um método que aparece duas vezes, primeiro como tier 0 e depois como tier 1, é a promoção que você está procurando. Para um passo a passo de como ler esses rastreamentos, veja a publicação sobre [fazer profiling de uma aplicação .NET com dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/).

Se você quer ver o código de máquina que o JIT produziu em cada camada, `DOTNET_JitDisasmSummary=1` imprime uma linha por método com seu tier, e atribuir a `DOTNET_JitDisasm` um nome de método despeja o assembly real. Ferramentas como o [visualizador de disassembly do Rider 2026.1](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) expõem a mesma saída sem lutar com variáveis de ambiente. Comparar o disassembly de tier 0 e tier 1 do mesmo método é a forma mais rápida de construir intuição sobre o que "otimizado" compra.

## A armadilha de benchmark em que todo mundo cai

O erro mais comum com a compilação em camadas é medir código de tier 0 por acidente. Se você escreve um loop com cronômetro que executa seu método alguns milhares de vezes e faz a média do resultado, as primeiras iterações rodam em tier 0 lento, a promoção acontece no meio do caminho e sua média é uma mistura sem sentido de duas peças de código distintas.

A correção é aquecer. Execute o método vezes suficientes para disparar a promoção, espere a compilação em segundo plano terminar, e só então comece a medir. É exatamente isso que o [BenchmarkDotNet](https://benchmarkdotnet.org/) faz por você: executa uma fase de aquecimento, detecta quando os tempos estabilizam e mede o código de tier 1 em regime estacionário. Não faça na mão um microbenchmark com `Stopwatch` e confie no número; você quase certamente está medindo o tier errado. Se precisar, você pode forçar a questão atribuindo `DOTNET_TieredCompilation=0` para que tudo compile diretamente para código otimizado, mas isso muda o comportamento de inicialização e também não é como sua aplicação roda em produção.

## Os botões, e quando você deveria de fato mexer neles

Os padrões são bons. A equipe do .NET os ajusta contra uma enorme bateria de aplicações reais, e a resposta honesta para a maioria dos projetos é deixar cada ajuste em paz. Dito isso, as alavancas existem por uma razão:

- `TieredCompilation` (env `DOTNET_TieredCompilation`, ativado por padrão): desative-o apenas para forçar código totalmente otimizado em toda parte, ao custo de uma inicialização muito mais lenta. Ocasionalmente útil para um serviço crítico em latência que pode se dar ao luxo de um aquecimento longo e quer zero jitter de tier 0, mas meça antes de se comprometer.
- `TieredCompilationQuickJit` (env `DOTNET_TC_QuickJit`, ativado por padrão): desativar isso faz o tier 0 usar o otimizador completo, o que em grande parte derrota o propósito.
- `TieredCompilationQuickJitForLoops` (env `DOTNET_TC_QuickJitForLoops`, ativado por padrão desde o .NET 7 em x64/arm64): junto com o OSR, raramente vale a pena mudar.
- `TieredPGO` (env `DOTNET_TieredPGO`, ativado por padrão desde o .NET 8): o que você poderia legitimamente desativar para processos ultracurtos, ou ativar para uma aplicação .NET 6/7 anterior à mudança de padrão.

Todos esses correspondem a propriedades do MSBuild no `.csproj` e a chaves `System.Runtime.*` no `runtimeconfig.json`, documentadas na referência de [ajustes de configuração de compilação](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation) da Microsoft. Se você está pesando o JIT em camadas contra abrir mão do JIT por completo, os compromissos estão em [Native AOT vs ReadyToRun vs JIT simples](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) e na análise mais profunda de [o que o Native AOT custa a você](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), já que o código de AOT nunca recebe a reotimização do Dynamic PGO.

O modelo mental que convém reter: seu processo inicia em código de tier 0 barato e rápido de produzir que vai tomando notas sem alarde; um pequeno número de métodos prova que são quentes; uma thread em segundo plano reescreve exatamente esses métodos com o otimizador completo informado pelas notas; e o OSR captura qualquer coisa presa em um loop que a contagem de chamadas perderia. Uma vez que você consiga ver isso acontecendo em um rastreamento, a compilação em camadas deixa de ser uma caixa-preta e passa a ser uma ferramenta sobre a qual você pode raciocinar.

## Relacionados

- [Native AOT vs ReadyToRun vs JIT simples no .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [O que é Native AOT e o que ele custa a você?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Como fazer profiling de uma aplicação .NET com dotnet-trace e ler a saída](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Como reduzir o tempo de inicialização a frio de um AWS Lambda com .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [O visualizador de ASM do Rider 2026.1 para disassembly de JIT e Native AOT](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)

## Fontes

- [Ajustes de configuração de compilação, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Documento de design da compilação em camadas, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/tiered-compilation.md)
- [Documento de design da substituição na pilha, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/OnStackReplacement.md)
- [Enable QJFL and OSR by default for x64 and arm64, PR #65675](https://github.com/dotnet/runtime/pull/65675)
- [Performance Improvements in .NET 7, .NET Blog](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/)
- [Documento de design do Dynamic PGO, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
