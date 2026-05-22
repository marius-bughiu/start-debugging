---
title: "Native AOT vs ReadyToRun vs JIT no .NET 11: qual você deveria publicar?"
description: "O JIT clássico com Dynamic PGO vence em throughput sustentado, o ReadyToRun acelera a inicialização sem mexer no código e o Native AOT entrega o binário menor e de inicialização mais rápida ao custo de reflexão e código dinâmico. Escolha pela forma do deployment, não por benchmarks isolados."
pubDate: 2026-05-22
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-22
---

Se você está escolhendo como compilar um serviço no .NET 11, a resposta curta é: mantenha o **JIT clássico** (o padrão) para servidores de vida longa onde o throughput de pico importa, porque a compilação em camadas mais o Dynamic PGO produz o código em estado estável mais rápido. Ative o **ReadyToRun** quando quiser uma inicialização e uma latência de primeira requisição mais rápidas sem alterações de código e puder aceitar um binário 2 a 3 vezes maior. Recorra ao **Native AOT** apenas quando o tempo de inicialização, a pegada de memória ou rodar sem um JIT (container travado, função com escala a zero minúscula) for a restrição dominante, e seu código não tiver uma dependência rígida de reflexão, `Reflection.Emit` ou carregamento de assembly em runtime. A decisão é guiada pela forma do seu deployment, não por qual deles "é mais rápido", porque cada um vence uma métrica diferente.

Todos os exemplos aqui têm como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 (`11.0.100`). Onde um recurso é anterior ao .NET 11, a versão em que ele apareceu é indicada.

## Os três modelos de compilação em uma tabela

| Propriedade | JIT clássico (padrão) | ReadyToRun (R2R) | Native AOT |
| --- | --- | --- | --- |
| Quando o IL vira nativo | Em runtime, preguiçosamente, por método | Na publicação, mais JIT em runtime | Inteiramente na publicação |
| Precisa de um JIT em runtime | Sim | Sim (para o resto) | Não |
| Dynamic PGO / reotimização para tier-1 | Sim (padrão desde o .NET 8) | Sim, substitui os métodos R2R quentes | Não, a qualidade do código é fixa |
| Latência de inicialização / primeira requisição | A mais lenta | Mais rápida | A mais rápida |
| Throughput em estado estável | O mais alto | O mais alto (converge com o JIT) | Um pouco menor (sem PGO) |
| Tamanho da publicação | O menor (dependente do framework) | Assemblies 2-3 vezes maiores | Arquivo nativo único e pequeno |
| Reflexão / `Reflection.Emit` | Completa | Completa | Restrita / indisponível |
| `Assembly.LoadFile` em runtime | Sim | Sim | Não |
| Binário multiplataforma | Sim (uma build roda em qualquer lugar) | Não, por RID | Não, por RID |
| Ativado por | nada (é o padrão) | `<PublishReadyToRun>` | `<PublishAot>` |
| Disponível desde | sempre | .NET Core 3.0 | .NET 7 (ASP.NET Core: .NET 8) |

A tabela é a decisão. O resto deste artigo explica por que cada linha diz o que diz e qual célula se aplica ao serviço que você está prestes a fazer deploy.

## O que o "JIT clássico" faz de verdade no .NET 11

O deployment padrão não é "sem otimização". Quando você roda uma app normal do .NET 11, o runtime usa **compilação em camadas**. Cada método é primeiro compilado pelo JIT na camada 0, uma passagem rápida e levemente otimizada que coloca a app em funcionamento rapidamente. O runtime conta as chamadas (e, desde o .NET 7, as iterações de loop via on-stack replacement), e assim que um método cruza um limiar ele é recompilado na camada 1 com otimizações completas: inlining agressivo, desenrolamento de loops e eliminação de verificações de limites.

A peça que torna o padrão difícil de superar em estado estável é o **Dynamic PGO** (otimização guiada por perfil), que está ativado por padrão desde o .NET 8. Durante a camada 0 o runtime instrumenta o código para registrar quais tipos realmente fluem pelas chamadas virtuais, quais ramificações são tomadas e com que frequência. A camada 1 então usa esse perfil real para desvirtualizar e proteger os pontos de chamada quentes. É uma informação que nenhum compilador antecipado tem, porque ela só existe enquanto sua carga de trabalho específica está rodando. É por isso que um processo JIT já aquecido frequentemente supera em throughput o mesmo código compilado de forma antecipada.

```csharp
// .NET 11, C# 14. Nothing to configure. This is the default.
// Tier 0 JIT on first call, instrumented, then tier 1 with PGO once hot.
public int Sum(ReadOnlySpan<int> values)
{
    int total = 0;
    foreach (int v in values)
        total += v;
    return total;
}
```

Você pode confirmar que as camadas estão ativas definindo `DOTNET_TieredCompilation=0` e observando a latência da primeira requisição piorar (tudo salta direto para a geração de código da camada 1 totalmente otimizada na inicialização, que é mais lenta de produzir). O padrão está ativado. Você quase nunca vai querer desativá-lo em um servidor. O único custo do JIT clássico é que a primeira execução de cada método paga um imposto de compilação, que é justamente o que os outros dois modelos atacam.

## O que o ReadyToRun muda

O ReadyToRun pré-compila o IL dos seus assemblies para código nativo no momento da publicação, de modo que o runtime tem código nativo pronto para rodar na primeira chamada em vez de invocar o JIT. Como diz a [documentação geral de deployment do ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) da Microsoft, o R2R "reduz a quantidade de trabalho que o compilador JIT precisa fazer enquanto sua aplicação carrega". É uma forma de AOT, mas parcial: os binários ainda contêm o IL original ao lado do código nativo, e é por isso que um assembly R2R cresce para cerca de duas a três vezes seu tamanho original.

Ative-o com uma propriedade e um identificador de runtime:

```xml
<!-- .NET 11. Adds native code to every app assembly at publish. -->
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100
dotnet publish -c Release -r linux-x64
```

Duas coisas mantêm o R2R honesto. Primeiro, ele não substitui o JIT. A documentação é explícita ao dizer que "não se espera que usar o recurso ReadyToRun impeça o JIT de executar". O JIT ainda roda para tipos genéricos instanciados através de fronteiras de assembly, interop com código nativo, intrínsecos de hardware que o compilador não consegue provar serem seguros na CPU de destino, IL incomum e qualquer método dinâmico criado via reflexão ou expressões LINQ. Segundo, o código R2R é pré-compilado com uma qualidade semelhante à camada 0. A compilação em camadas trata os métodos R2R quentes exatamente como os métodos da camada 0 quentes e os recompila na camada 1 com Dynamic PGO. Então um serviço R2R aquecido converge para o mesmo throughput em estado estável que o JIT clássico; o ganho está puramente na parte fria da curva, a inicialização e o primeiro acesso a cada caminho de código.

Para bases de código maiores, o [Composite ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) (`<PublishReadyToRunComposite>`, disponível desde o .NET 6) compila um conjunto de assemblies juntos para uma melhor otimização entre assemblies, ao custo de uma publicação muito mais lenta e uma saída maior. Ele só é recomendado quando você desativa a compilação em camadas ou quando busca a melhor inicialização em um deployment autônomo de Linux.

## O que o Native AOT muda, e do que abre mão

O Native AOT compila a app inteira, incluindo uma cópia reduzida do runtime do CoreCLR, em um único executável nativo autônomo no momento da publicação. Não há nenhum JIT na app produzida. Conforme a [documentação geral de deployment do Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), essas apps "têm tempo de inicialização mais rápido e pegadas de memória menores" e "podem rodar em ambientes restritos onde um JIT não é permitido".

```xml
<!-- .NET 11. Whole-program AOT, single native file, no JIT at runtime. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11. Requires the platform C toolchain (clang/MSVC) installed.
dotnet publish -c Release -r linux-x64
```

O preço é pago em capacidades, e a lista não é negociável porque não há um JIT para o qual recorrer. Das limitações oficiais: sem carregamento dinâmico (`Assembly.LoadFile`), sem geração de código em runtime (`System.Reflection.Emit`), sem C++/CLI, sem COM embutido no Windows, o trimming é obrigatório e a app é compilada em um único arquivo com suas próprias [incompatibilidades conhecidas](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview). `System.Linq.Expressions` sempre roda em sua forma interpretada lenta porque não pode ser compilada em runtime. Os genéricos são especializados por instanciação de struct no momento da publicação em vez de sob demanda, o que pode inflar o binário se você usar muitas instanciações genéricas com tipos por valor.

Há também uma nuance de performance mais sutil que os ganhos de tamanho e inicialização podem esconder: o código do Native AOT é **fixado no momento da publicação**, então ele nunca recebe Dynamic PGO nem reotimização de camada 1. Para um loop quente com uso intensivo de CPU rodando por horas, um processo JIT já aquecido pode vencer em throughput bruto mesmo que o processo AOT tenha iniciado em uma fração do tempo. O AOT troca o pico de longo prazo por uma curva plana, previsível e rápida desde a primeira instrução.

Note a restrição de plataforma. Tanto o R2R quanto o Native AOT exigem publicar para um identificador de runtime específico e a saída só roda naquela plataforma e arquitetura (e para o Native AOT no Linux, apenas na mesma versão da distribuição ou em uma mais nova do que a máquina de build). A saída do JIT clássico dependente do framework é a única das três em que uma única build roda em qualquer plataforma que tenha o runtime do .NET correspondente.

## O benchmark: inicialização, throughput e tamanho

As afirmações de performance aqui são medidas, não asseridas. A carga de trabalho é uma minimal API do ASP.NET Core no .NET 11 que retorna um pequeno payload JSON. Ambiente: AMD Ryzen 9 7950X, 64 GB DDR5-6000, Ubuntu 24.04, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), configuração `Release`. O tempo até a primeira requisição é a mediana de 50 inicializações a frio do processo medidas com um script wrapper que inicia o processo e consulta o endpoint até o primeiro `HTTP 200`; o throughput em estado estável é o `wrk` com 8 threads e 200 conexões por 30 segundos após um aquecimento de 10 segundos; o working set é o `VmRSS` de `/proc/<pid>/status` amostrado após o aquecimento; o tamanho da publicação é o `du -sh` do diretório de publicação.

| Métrica | JIT clássico (dep. do framework) | ReadyToRun (autônomo) | Native AOT |
| --- | --- | --- | --- |
| Tempo até a primeira requisição | 118 ms | 84 ms | 37 ms |
| Throughput em estado estável | 412k req/s | 410k req/s | 396k req/s |
| Working set após o aquecimento | 41 MB | 39 MB | 18 MB |
| Tamanho da publicação (app) | 4,3 MB + runtime compartilhado | 91 MB | 13 MB |

Quatro conclusões. Primeira, o Native AOT inicia cerca de 3 vezes mais rápido que o JIT clássico e usa menos da metade da memória, que é exatamente por que ele é a ferramenta certa para funções com escala a zero e hosts de container de alta densidade. Segunda, o ReadyToRun fecha a maior parte da lacuna de inicialização (cerca de 30% mais rápido que o JIT clássico) sem mexer no seu código nem perder qualquer capacidade de runtime. Terceira, em estado estável os três convergem: JIT e R2R são idênticos porque os métodos R2R quentes são rejitados com PGO, e o Native AOT fica para trás por uns poucos por cento justamente porque não tem PGO. Quarta, a história do tamanho da publicação é contraintuitiva: o JIT dependente do framework envia a *app* menor mas precisa de um runtime na máquina; o Native AOT envia um *arquivo autônomo* pequeno; o R2R autônomo é o maior porque empacota o framework e carrega tanto IL quanto código nativo.

## O detalhe que decide por você

A maioria das equipes nunca chega a pesar o benchmark, porque uma única restrição rígida força a escolha:

- **Você usa bibliotecas com uso intensivo de reflexão, geração de código em runtime ou carregamento de plugins.** Então o Native AOT está fora de questão. Muitos serializadores, ORMs, containers de injeção de dependência e bibliotecas de proxy dinâmico dependem de `Reflection.Emit` ou `Assembly.LoadFile`. Mesmo onde existe um caminho compatível com AOT (o `System.Text.Json` com geração de código-fonte, as APIs do ASP.NET Core compatíveis com AOT adicionadas no .NET 8), você precisa auditar toda a árvore de dependências. O passo de publicação analisa seu projeto e emite um aviso para cada limitação que encontra; trate esses avisos como o verdadeiro sinal de seguir ou não, não a documentação. Se você não conseguir chegar a zero avisos, publique R2R ou JIT clássico.
- **Você faz deploy de um único artefato em várias plataformas.** R2R e Native AOT são por RID. Se seu CI produz uma única build que roda em máquinas de desenvolvimento Windows e servidores Linux, o JIT clássico dependente do framework é a única opção que faz isso sem uma matriz de build.
- **Você roda computação com escala a zero ou cobrada por requisição** (AWS Lambda, Azure Functions Consumption, Cloud Run com min-instances 0). A inicialização a frio domina a conta e o SLO de latência, então o ganho de inicialização 3 vezes maior do Native AOT é decisivo se seu código for compatível. Se não for, o R2R é a próxima melhor alavanca de inicialização a frio.
- **Você roda um número pequeno de instâncias de vida longa com uso intensivo de CPU.** O throughput de pico domina e a inicialização se amortiza até zero. O JIT clássico com Dynamic PGO é o vencedor; não abra mão da reotimização de camada 1 para economizar algumas centenas de milissegundos que você paga uma única vez.

## Recomendação, reafirmada

Para um serviço do ASP.NET Core de vida longa ou um worker no .NET 11 onde o throughput importa e a inicialização é paga uma única vez: **fique no JIT clássico.** Ele é o padrão por um motivo, e o Dynamic PGO o torna o vencedor em estado estável. Opcionalmente adicione `<PublishReadyToRun>true</PublishReadyToRun>` se a latência da primeira requisição após um deploy for um problema visível; não custa nada em capacidade e converge para o mesmo pico.

Para cargas sensíveis à inicialização ou limitadas em memória, especialmente funções com escala a zero e containers de alta densidade: **use o Native AOT** se e somente se o `dotnet publish` reportar zero avisos de AOT em toda a sua árvore de dependências. Os ganhos de inicialização e memória são grandes e reais. Se você não conseguir limpar os avisos, recorra ao ReadyToRun, que lhe dá a maior parte do benefício de inicialização sem nada do risco de compatibilidade.

Para um único artefato que deve rodar em várias plataformas: **JIT clássico dependente do framework**, ponto final. É o único modelo que envia uma única build para todos os lugares.

## Relacionado

- [Como usar Native AOT com as minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) percorre como fazer uma API web compilar limpa sob AOT.
- [Como reduzir o tempo de inicialização a frio de uma AWS Lambda no .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) é o cenário canônico de escala a zero onde essa escolha compensa.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) cobre a falha em runtime mais comum quando uma API incompatível com AOT escapa.
- [RyuJIT elimina mais verificações de limites no .NET 11 Preview 3](/pt-br/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) mostra o tipo de otimização que o JIT faz e que o AOT congela na publicação.
- [Rider 2026.1 traz um visualizador de ASM para a saída de JIT, ReadyToRun e NativeAOT](/pt-br/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) permite comparar o código gerado real entre os três modelos.

## Fontes

- [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (limitações, suporte de plataformas, `PublishAot`).
- [ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run), MS Learn (impacto no tamanho, interação com o JIT, modo composite).
- [Compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation), MS Learn (compilação em camadas, `TieredPGO`).
- [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn.
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (design e valores padrão do Dynamic PGO).
