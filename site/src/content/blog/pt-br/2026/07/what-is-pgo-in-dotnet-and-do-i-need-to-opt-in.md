---
title: "O que é PGO no .NET e preciso ativar?"
description: "PGO (otimização guiada por perfil) permite que o JIT do .NET especialize o código quente para os tipos e ramos que sua carga de trabalho realmente executa. O Dynamic PGO está ligado por padrão desde o .NET 8, então no .NET 8 e versões posteriores você não precisa ativar. Aqui está o que ele faz, como ver o efeito e os casos raros em que você mexe no ajuste."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in"
translatedBy: "claude"
translationDate: 2026-07-11
---

PGO significa otimização guiada por perfil: o compilador coleta um perfil de como seu código realmente roda e depois usa esse perfil para gerar código de máquina mais rápido para os caminhos que importam. No .NET o JIT faz isso em tempo de execução, um modo chamado Dynamic PGO, e a resposta curta para "preciso ativar?" é não, não mais. O Dynamic PGO está habilitado por padrão desde o .NET 8, então no .NET 8, .NET 9, .NET 10 e .NET 11 você já o tem. Você só recorre à chave se estiver no .NET 6 ou 7 (onde estava desligado por padrão), ou se tiver uma carga de trabalho incomum e de vida muito curta na qual queira desligá-lo. Este artigo explica o que o perfil traz, como confirmar que ele está rodando e os poucos casos em que vale a pena mexer no ajuste.

Tudo aqui tem como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 (`11.0.100`), mas o comportamento ligado por padrão se mantém desde o .NET 8, e o mecanismo subjacente é estável desde que o .NET 7 o reforçou. Quando um comportamento depender de uma versão específica, eu aponto.

## O que "guiado por perfil" realmente significa

Um compilador otimizador tradicional precisa adivinhar. Quando vê uma chamada a um método virtual, não tem como saber qual tipo concreto aparecerá em tempo de execução, então emite uma chamada indireta genérica. Quando vê um `if`, não sabe qual ramo é quente, então dispõe os dois como se fossem igualmente prováveis. Quando vê um laço, não sabe se ele roda duas vezes ou dois milhões de vezes. Esses palpites geralmente estão certos e ocasionalmente deixam muito desempenho na mesa.

A otimização guiada por perfil elimina os palpites. Ela roda o programa, registra o que realmente aconteceu em cada um desses pontos de decisão e devolve esses dados ao otimizador. Agora o compilador sabe que um ponto de chamada específico foi `List<int>` em 98% das vezes, que um ramo específico é tomado uma vez a cada mil iterações, que um laço específico é genuinamente quente. Ele pode especializar o código para a realidade em vez de se resguardar para todas as possibilidades.

O PGO clássico antecipado faz isso em duas compilações separadas: uma build instrumentada que você roda contra uma carga de trabalho representativa para produzir um perfil, e depois uma segunda build que consome o perfil. É assim que as cadeias de ferramentas de C e C++ fazem há décadas, e é poderoso mas trabalhoso, porque você precisa capturar uma carga de trabalho parecida com produção e recompilar. O Dynamic PGO do .NET funde ambas as fases em um único processo em execução, que é o que o torna algo que você simplesmente pode deixar ligado.

## Como o Dynamic PGO se apoia na compilação em camadas

O Dynamic PGO não é uma passagem separada parafusada no runtime. Ele pega carona no maquinário que o JIT já usa para compilar os métodos quentes duas vezes. Se você ainda não internalizou esse modelo de duas passagens, o artigo sobre [o que é a compilação em camadas e como raciocinar sobre ela](/pt-br/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) é o pré-requisito; a versão bem curta é que os métodos primeiro compilam como código "tier 0" rápido e sem otimização, e apenas os quentes são recompilados como código "tier 1" totalmente otimizado em segundo plano.

O Dynamic PGO explora essa primeira passagem. Quando está ativo, o código tier 0 que o JIT emite não é meramente sem otimização, ele é instrumentado. O compilador insere sondas baratas que contam com que frequência cada bloco básico executa e, nos pontos de chamada virtuais e de interface, constroem um pequeno histograma de quais tipos concretos realmente chegam. Enquanto sua aplicação esquenta, esse código tier 0 coleta silenciosamente um perfil da sua carga de trabalho específica. Quando um método é promovido depois para tier 1, o otimizador lê o perfil que coletou e especializa o código tier 1 conforme isso.

Esse timing é todo o truque. O perfil é coletado da carga de trabalho real, na máquina real, momentos antes de o código otimizado ser produzido, então não há uma build instrumentada separada nem um problema de carga de trabalho representativa. O custo é que o código tier 0 instrumentado é ligeiramente mais lento e ligeiramente maior do que o tier 0 comum, o que só importa durante a breve janela antes da promoção.

## A otimização que paga por todo o resto: devirtualização guiada

A coisa mais valiosa que o Dynamic PGO habilita é a devirtualização guiada (GDV). Chamadas virtuais e de interface são caras não porque o salto indireto em si seja lento, mas porque o JIT não consegue fazer inlining através delas, e o inlining é de onde a maioria das outras otimizações tira sua vantagem. Se o compilador não consegue enxergar dentro de uma chamada, não consegue dobrar constantes através dela, içar trabalho para fora dela nem eliminar verificações redundantes ao redor dela.

Com um perfil de tipos em mãos, o JIT pode inserir um caminho rápido. Ele emite uma verificação explícita do tipo que dominou o perfil e, se a verificação passa, roda uma cópia inlined e totalmente otimizada do corpo daquele método; se falha, recorre à chamada virtual normal. Considere um laço sobre um `IEnumerable<int>` que na verdade é sempre um `List<int>`:

```csharp
// .NET 11, C# 14.
// Dynamic PGO learns that `items` is a List<int> at this call site
// and inlines the enumerator's MoveNext/Current behind a type guard.
static long Sum(IEnumerable<int> items)
{
    long total = 0;
    foreach (int x in items) // virtual GetEnumerator/MoveNext without PGO
        total += x;
    return total;
}
```

Sem PGO o `foreach` passa por despacho de interface em cada elemento. Com PGO o JIT adivinha `List<int>`, protege o palpite com uma verificação de tipo e faz inlining do enumerador, de modo que o corpo do laço vira aritmética de inteiros enxuta e sem alocação. A partir do .NET 8 o JIT pode até emitir mais de uma guarda em um ponto que vê dois tipos dominantes, embora a GDV múltipla esteja desligada por padrão e protegida atrás de um ajuste de configuração. A equipe do .NET mediu métodos do framework onde a GDV sozinha cortou o tempo de execução em cerca de 40%, e relatou ganhos reais em produção: [a migração do Bing para o .NET 8](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/) atribuiu uma queda de 13% nos ciclos de CPU por consulta, uma redução de 20% nas consultas afetadas por GC de gen0/gen1 e algumas latências internas caindo mais de 25%, em grande parte ao Dynamic PGO estar ligado por padrão.

## Preciso ativar? A resposta versão por versão

Aqui está a parte que a consulta de busca realmente pergunta.

- **.NET 8, 9, 10 e 11**: não. O Dynamic PGO está ligado por padrão. Você não faz nada. Se você tem `<TieredCompilation>` no valor padrão (habilitado), você já tem PGO.
- **.NET 7**: existe e funciona bem, mas está desligado por padrão. Ative com o ajuste abaixo se você quiser.
- **.NET 6**: foi introduzido aqui como experimento, desligado por padrão e menos maduro. Você pode ativar, mas trate como qualidade de versão prévia.
- **.NET 5 e anteriores**: o Dynamic PGO não existe.

Para ligá-lo onde não é o padrão, defina a propriedade de MSBuild no seu arquivo de projeto:

```xml
<!-- .NET 7 (or .NET 6). Opts into Dynamic PGO, which is off by default there. -->
<!-- Unnecessary on .NET 8+, where it is already enabled. -->
<PropertyGroup>
  <TieredPGO>true</TieredPGO>
</PropertyGroup>
```

Ou defina a variável de ambiente, que é prática para testes A/B sem recompilar:

```bash
# Enable Dynamic PGO for a single run (any supported .NET version).
DOTNET_TieredPGO=1 ./myapp
```

A propriedade de MSBuild, a chave do `runtimeconfig.json` (`System.Runtime.TieredPGO`) e a variável de ambiente `DOTNET_TieredPGO` controlam todas a mesma chave, documentada na referência de [ajustes de configuração de compilação](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation) da Microsoft. Como o Dynamic PGO depende da compilação em camadas, desligar a compilação em camadas (`DOTNET_TieredCompilation=0`) também desliga o Dynamic PGO como efeito colateral; não há passagem de perfil se não há tier 0.

## Quando você pode legitimamente desligá-lo

Deixar o PGO ligado é a decisão certa para quase toda aplicação, mas há uma exceção honesta: um processo que termina antes de seus métodos quentes chegarem ao tier 1. Uma CLI de vida curta, uma função serverless que atende uma requisição e morre, um AWS Lambda com um timeout agressivo. Nessas cargas de trabalho o código tier 0 instrumentado roda, paga o pequeno imposto de perfilamento, e o processo encerra antes de qualquer recompilação para tier 1 acontecer, então você pagou por um perfil que nunca gastou.

```xml
<!-- .NET 11, C# 14. Turns Dynamic PGO OFF. -->
<!-- Only sensible for ultra-short-lived processes that never reach tier 1. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

Mesmo aqui, não presuma; meça. Muitas cargas de trabalho sensíveis a arranque a frio ganham mais com uma estratégia completamente diferente, como imagens ReadyToRun ou Native AOT, do que com alternar o PGO. As compensações para o arranque a frio especificamente são trabalhadas no guia sobre [reduzir o tempo de arranque a frio de um AWS Lambda com .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/). E se você está considerando abrir mão do JIT por completo, note que o código do [Native AOT](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) nunca recebe a reotimização em tempo de execução do Dynamic PGO, porque não há passagem de perfilamento tier 0 em um binário antecipado.

## Static PGO: o perfil que o framework traz

O Dynamic PGO não é o único PGO no .NET. As próprias imagens ReadyToRun pré-compiladas do framework são construídas com static PGO: a Microsoft coleta um perfil offline, o armazena como um arquivo `.mibc` e o entrega ao compilador `crossgen2` de modo que até o código antecipado do framework seja disposto conforme um perfil representativo. É por isso que `string`, `List<T>` e o resto da biblioteca de classes base chegam já ajustados antes de sua aplicação rodar uma única linha.

Você pode fazer o mesmo para suas próprias builds AOT ou ReadyToRun: capture um perfil com as ferramentas, produza um `.mibc` e o entregue ao `crossgen2`. Este é um fluxo de trabalho de nicho e avançado, relevante sobretudo se você publica Native AOT e quer uma disposição informada por perfil sem um JIT em tempo de execução. Para a grande maioria das aplicações de servidor e desktop que mantêm o JIT, o Dynamic PGO dá a você a mesma classe de benefício automaticamente e se adapta à carga de trabalho real em vez de a um perfil enlatado, o que é estritamente melhor do que um perfil estático assado em tempo de compilação. A escolha entre JIT-com-PGO e os modelos AOT é o tema de [Native AOT vs ReadyToRun vs JIT puro no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

## Como confirmar que o PGO realmente faz algo

Como o PGO é silencioso por design, a pergunta natural é como você sabe que ele está funcionando. Duas abordagens.

A primeira é olhar o código de máquina. Definir `DOTNET_JitDisasm` com o nome de um método despeja o assembly tier 1, e um método que passou pela GDV mostra uma forma reveladora: uma comparação de tipo, um caminho rápido inlined e uma chamada de fallback. Se você desligar o PGO e despejar de novo, a guarda e o corpo inlined desaparecem e sobra uma chamada virtual pura. Esse antes e depois é a prova mais clara de que o perfil mudou a saída.

```bash
# .NET 11 SDK 11.0.100. Dump the JIT's assembly for a specific method,
# then compare with DOTNET_TieredPGO=0 to see the guarded fast path vanish.
DOTNET_JitDisasm=Sum DOTNET_TieredPGO=1 ./myapp
```

A segunda abordagem é medir o throughput corretamente, o que significa medir o código tier 1 em estado estacionário e não o aquecimento tier 0 que o precede. Não faça na mão um laço com `Stopwatch`; use o [BenchmarkDotNet](https://benchmarkdotnet.org/), que aquece até os tempos estabilizarem e pode rodar o mesmo benchmark com PGO ligado e desligado para você comparar o comparável. Se você quiser ver os eventos de camadas e JIT passarem em um processo real, o artigo sobre [perfilar uma aplicação .NET com dotnet-trace](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) percorre a captura do provedor do runtime que relata a camada de otimização de cada método.

O modelo mental a guardar: o PGO é a razão pela qual o design do .NET de "compilar os métodos quentes duas vezes" produz código que um compilador estático não consegue igualar, porque a segunda compilação é informada por um perfil da sua carga de trabalho real. No .NET 8 e posteriores ele já está ligado, já se adaptando e já se pagando. Você não precisa ativar. Você só precisa saber que ele está ali, para que, quando fizer benchmark, meça a camada otimizada e credite ao perfil a velocidade que ele conquistou.

## Related

- [O que é a compilação em camadas e como raciocino sobre ela?](/pt-br/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [O que é Native AOT e quanto ele custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT puro no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Como perfilar uma aplicação .NET com dotnet-trace e ler a saída](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Como reduzir o tempo de arranque a frio de um AWS Lambda com .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Sources

- [Ajustes de configuração de compilação, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Documento de design do Dynamic PGO, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
- [Performance Improvements in .NET 8, .NET Blog](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/)
- [Bing on .NET 8: The Impact of Dynamic PGO, .NET Blog](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/)
