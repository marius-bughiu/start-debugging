---
title: "O que é Native AOT e quanto ele custa para você?"
description: "Native AOT compila sua app .NET em um único binário nativo autônomo sem JIT, comprando inicialização rápida e baixo consumo de memória. O preço é uma cadeia de ferramentas C em tempo de compilação, builds mais lentos, builds por RID, sem reflexão nem Reflection.Emit, trimming obrigatório e sem Dynamic PGO. Aqui está o balanço completo."
pubDate: 2026-06-19
tags:
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/what-is-native-aot-and-what-does-it-cost-you"
translatedBy: "claude"
translationDate: 2026-06-19
---

Native AOT é um modelo de publicação do .NET que compila toda a sua app, mais uma cópia reduzida do runtime, em um único executável nativo autônomo de forma antecipada. A app resultante não tem compilador JIT, então inicia rápido e usa menos memória, e roda em máquinas que não têm o runtime do .NET instalado. O custo é pago em três moedas: atrito em tempo de compilação (você precisa de uma cadeia de ferramentas C, as publicações são mais lentas e cada build mira um único sistema operacional mais arquitetura), perda de capacidade em tempo de execução (sem código que dependa de reflexão, sem `System.Reflection.Emit`, sem carregamento dinâmico de assemblies, trimming obrigatório) e um pequeno impacto no throughput, muitas vezes invisível, porque o código AOT nunca recebe reotimização guiada por perfil. Se essa troca vale a pena depende inteiramente do formato da sua implantação, não de um número de benchmark. Este post é o balanço completo para você decidir antes de ativar.

Tudo aqui mira `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 (`11.0.100`). O Native AOT em si chegou no .NET 7, e o suporte do ASP.NET Core aterrissou no .NET 8, então a mecânica abaixo se aplica do .NET 8 em diante, salvo quando uma versão é citada.

## O que "antecipado" realmente significa aqui

Uma app .NET normal é distribuída como IL (linguagem intermediária). Em tempo de execução, o compilador JIT (just-in-time) transforma esse IL em código de máquina nativo de forma preguiçosa, um método de cada vez, na primeira vez que cada método roda. É por isso que um processo .NET recém-iniciado é um pouco lento nas primeiras requisições: ele está compilando a si mesmo enquanto avança. O runtime, o GC e o JIT precisam estar presentes na máquina para que isso funcione.

Native AOT remove o JIT da equação por completo. Quando você executa `dotnet publish` com `<PublishAot>true</PublishAot>`, o SDK executa o ILC, o compilador AOT, que compila todo o seu IL, todo o IL das suas dependências e uma versão reduzida do runtime CoreCLR em um único binário nativo. Como diz a [visão geral da implantação do Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) da Microsoft, essas apps "têm tempo de inicialização mais rápido e pegadas de memória menores" e "podem rodar em ambientes restritos onde um JIT não é permitido".

A ativação mínima é uma única propriedade do MSBuild e um identificador de runtime:

```xml
<!-- .NET 11, C# 14. Enables ILC at publish and turns on AOT analysis while editing. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. The -r RID is mandatory: AOT output is platform-specific.
dotnet publish -c Release -r linux-x64
```

A saída no diretório de publicação é um único executável que contém tudo de que precisa para rodar, "incluindo uma versão reduzida do runtime coreclr". Não há um runtime separado para instalar, e não há JIT dentro do binário. Essa frase é o recurso inteiro, e também o custo inteiro. Cada limitação abaixo decorre de "não há JIT em tempo de execução".

## A conta em tempo de compilação

Antes de escrever uma linha de código, o Native AOT muda o que a sua máquina de compilação e a sua CI precisam.

**Você precisa de uma cadeia de ferramentas nativa C.** O ILC produz código objeto que precisa ser ligado em um executável real do sistema operacional por um linker da plataforma, então os [pré-requisitos](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) não são negociáveis por sistema operacional. No Windows você precisa do Visual Studio 2022 ou posterior com a carga de trabalho "Desenvolvimento para desktop com C++". No Linux você instala o clang e os headers de desenvolvimento do zlib (`sudo apt-get install clang zlib1g-dev` no Ubuntu, `sudo dnf install clang zlib-devel` no Fedora e RHEL, `sudo apk add clang build-base zlib-dev` no Alpine). No macOS você precisa das Command Line Tools do Xcode. Uma imagem simples do SDK do `dotnet` já não basta para seus agentes de build; você precisa embutir a cadeia de ferramentas na imagem de CI também.

**As publicações são mais lentas.** A compilação do programa inteiro, mais o trimming, mais a ligação nativa, é muito mais trabalho do que emitir IL. Uma publicação que leva alguns segundos para uma app dependente do framework pode levar minutos sob AOT, e escala com o tamanho do seu grafo de dependências. Esse é um imposto por publicação, não por execução, mas é real o suficiente para que normalmente você não execute AOT em cada build do ciclo interno, apenas ao publicar.

**Cada build é por RID.** A saída do AOT roda apenas no sistema operacional e na arquitetura de CPU para os quais você compilou. Um binário compilado para `win-x64` não roda em `linux-arm64`, ponto final. Pior no Linux especificamente: um binário compilado em uma dada versão de distribuição roda apenas nessa versão ou mais novas. A documentação é explícita ao dizer que "um binário Native AOT produzido no Ubuntu 20.04 vai rodar no Ubuntu 20.04 e posteriores, mas não vai rodar no Ubuntu 18.04". Se você distribui para várias plataformas, precisa de uma matriz de build, uma publicação por RID. O .NET 9 ampliou os alvos suportados para incluir Windows/Linux x86 e Arm de 32 bits além do x64 e Arm64 que o .NET 8 suportava.

Compare isso com uma app JIT dependente do framework, onde um único build roda em qualquer máquina que tenha o runtime do .NET correspondente. Essa portabilidade é uma das coisas das quais você está abrindo mão.

## As capacidades de runtime das quais você abre mão

Esta é a parte que decide a maioria dos projetos, porque as perdas não são "mais lento", são "não funciona, e o passo de publicação vai te avisar". Como não há JIT, qualquer coisa que dependa de gerar ou descobrir código em tempo de execução fica de fora. Direto das [limitações oficiais](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/):

- **Sem carregamento dinâmico**, por exemplo `Assembly.LoadFile`. Arquiteturas de plugin que escaneiam uma pasta em busca de DLLs e as carregam em tempo de execução não podem funcionar, porque o código nunca foi compilado no binário.
- **Sem geração de código em tempo de execução**, por exemplo `System.Reflection.Emit`. Isso silenciosamente derruba uma quantidade surpreendente do ecossistema: bibliotecas de proxy dinâmico (Castle DynamicProxy), alguns frameworks de mocking e qualquer serializador ou mapeador que emita IL por velocidade.
- **Sem C++/CLI** e, no Windows, **sem COM embutido**.
- **O trimming é obrigatório.** O trimmer remove qualquer código que não consiga provar que é alcançável. A reflexão sem limites (`Type.GetType("SomeName")` a partir de uma string, percursos com `GetProperties()`, `Activator.CreateInstance(someType)`) frustra essa análise, então o código que depende muito de reflexão ou precisa de anotações ou precisa ser substituído por um gerador de código-fonte.
- **O empacotamento em arquivo único está implícito**, o que traz suas próprias [incompatibilidades conhecidas](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) (APIs que assumem um `.dll` em disco, `Assembly.Location` retornando vazio, e assim por diante).
- **`System.Linq.Expressions` sempre roda interpretado.** Não pode ser compilado em tempo de execução porque isso precisa do JIT, então o código que depende muito de árvores de expressão continua funcionando, mas roda mais lento do que em um host com JIT.

A regra prática mais importante: **o compilador te avisa.** "O processo de publicação analisa o projeto inteiro e suas dependências em busca de possíveis limitações. Avisos são emitidos para cada limitação que a app publicada poderia encontrar em tempo de execução." Esses avisos são IL2026 (requer código não referenciado, um problema de trimming) e IL3050 (requer código dinâmico, um problema de AOT). Trate um `dotnet publish` limpo com zero avisos IL2026/IL3050 como seu sinal de seguir ou não, não a documentação. Se você não consegue chegar a zero, não publique com AOT.

A forma de chegar a zero é quase sempre substituir a reflexão por geração de código em tempo de compilação. O `System.Text.Json` com código gerado é o exemplo canônico: em vez de refletir sobre seu DTO em tempo de execução, um gerador emite o código de serialização em tempo de compilação. Se o termo é novo para você, [o que é um gerador de código-fonte e quando você precisa de um](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) é o primeiro passo certo, porque sob AOT eles deixam de ser algo desejável e se tornam a única forma de algumas bibliotecas funcionarem.

## O custo de throughput que ninguém menciona

Há um custo que as manchetes de inicialização e tamanho escondem. Um processo JIT não compila seu código apenas uma vez. Desde o .NET 8, o **Dynamic PGO** (otimização guiada por perfil) está ativado por padrão: enquanto sua app roda, o runtime registra quais tipos realmente fluem pelas chamadas virtuais e quais ramos são quentes, depois recompila esses métodos no nível 1 usando esse perfil real. Essa é uma informação que nenhum compilador antecipado pode ter, porque ela só existe enquanto a sua carga de trabalho específica está rodando.

O código do Native AOT fica fixo em tempo de publicação. Ele nunca recebe reotimização de nível 1 e nunca recebe PGO. Para um laço quente com uso intensivo de CPU rodando por horas, um processo JIT bem aquecido pode superar o throughput do mesmo código compilado com AOT, mesmo que o processo AOT tenha iniciado em uma fração do tempo. O AOT troca o pico da cauda longa por uma curva plana, previsível e rápida desde a primeira instrução. A diferença medida é pequena (uma pequena porcentagem em um benchmark de API JSON), mas é real e vai na direção oposta a tudo o mais que o AOT te dá. Os números completos estão na [comparação de Native AOT vs ReadyToRun vs JIT](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), que mede inicialização, throughput e tamanho frente a frente.

Mais uma nuance de tamanho: os generics. "Parâmetros genéricos substituídos por argumentos de tipo struct têm código especializado gerado para cada instanciação." Um JIT as gera sob demanda; o AOT as pré-gera todas. Se você instancia muitos generics de tipo por valor, o binário cresce. Os binários do AOT são pequenos no caso comum (uma API mínima fica em torno de 10-13 MB), mas uma biblioteca cheia de generics pode inflá-lo mais do que você espera.

## O que o custo compra para você

Os benefícios são genuínos e, para a carga de trabalho certa, decisivos. A inicialização é a manchete: uma API mínima com Native AOT inicia cerca de três vezes mais rápido que a mesma app em JIT puro, porque não há aquecimento do JIT nem carregamento de assemblies. A pegada de memória cai mais da metade, porque o processo não carrega um JIT, nem o IL, nem os metadados necessários para compilá-lo. E como a saída é autônoma, a unidade de implantação é um único binário pequeno sem runtime para instalar, e é por isso que equipes reduzem substancialmente o tamanho das imagens de contêiner ao mudar.

O outro benefício é categórico em vez de quantitativo: apps AOT "podem rodar em ambientes restritos onde um JIT não é permitido". Alguns runtimes de contêiner travados e políticas de segurança proíbem as páginas de memória graváveis-executáveis de que um JIT precisa. O AOT é o único modelo de implantação do .NET que roda ali.

É por isso que o ponto ideal é a computação de escala a zero e alta densidade. Em uma função cobrada por requisição (AWS Lambda, Azure Functions Consumption, Cloud Run escalado a zero), a inicialização a frio domina tanto o SLO de latência quanto a conta, então uma melhora de 3x na inicialização vale muita dor em tempo de compilação. O [manual de inicialização a frio para AWS Lambda no .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) percorre o caminho exato do AOT no Lambda. Em um serviço de vida longa com uso intensivo de CPU e um punhado de instâncias, a inicialização se amortiza até sumir e você estaria abrindo mão do Dynamic PGO por um benefício que paga uma única vez, então o JIT puro costuma vencer.

## Como decidir sem adivinhar

Execute a análise antes de se comprometer com qualquer coisa. O teste mais barato é colocar `<PublishAot>true</PublishAot>` e executar uma publicação contra o seu grafo de dependências real:

```bash
# .NET 11. Surfaces every IL2026 / IL3050 across your whole dependency tree.
dotnet publish -c Release -r linux-x64 -o ./publish
```

Se isso voltar com avisos que você não consegue anotar para eliminar, o AOT ainda não é viável para esta base de código, e você tem sua resposta pelo custo de uma publicação. O ASP.NET Core afina o ponto: controladores MVC (`AddControllers`), Razor Pages e hubs do SignalR do lado do servidor não são compatíveis com AOT no .NET 11, enquanto APIs mínimas e gRPC são. Se você quer a receita completa de build limpo (o host `CreateSlimBuilder`, JSON com código gerado, os problemas dos projetos de biblioteca), [como usar Native AOT com APIs mínimas do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) é o passo a passo. E quando uma API incompatível com AOT passa pelo analisador e só estoura em tempo de execução, [resolver a PlatformNotSupportedException resultante](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) cobre a falha mais comum.

Uma regra de decisão curta: recorra ao Native AOT quando o tempo de inicialização, a pegada de memória, o tamanho da implantação ou rodar sem um JIT for a restrição dominante, **e** o `dotnet publish` reportar zero avisos de AOT em todo o seu grafo de dependências. Fique no JIT puro quando o throughput de pico em estado estável importar mais que a inicialização, quando você distribuir um único artefato para várias plataformas, ou quando alguma dependência crucial precisar de reflexão ou `Reflection.Emit` que você não consegue substituir. Native AOT não é um `dotnet publish` mais rápido; é um contrato de implantação diferente, e os custos acima são os termos desse contrato. Leia-os antes de assinar.

## Relacionado

- [Native AOT vs ReadyToRun vs JIT no .NET 11: qual você deve distribuir?](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) coloca números de benchmark concretos por trás das trocas de inicialização, throughput e tamanho.
- [Como usar Native AOT com APIs mínimas do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) é o passo a passo de build limpo depois que você decidiu distribuí-lo.
- [O que é um gerador de código-fonte e quando preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explica a geração de código em tempo de compilação que substitui a reflexão que o AOT proíbe.
- [Como reduzir o tempo de inicialização a frio de uma AWS Lambda no .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) é o cenário de escala a zero onde a melhora de inicialização do AOT se paga sozinha.
- [Correção: PlatformNotSupportedException no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) cobre a falha em tempo de execução quando uma API incompatível com AOT passa por um build limpo.

## Fontes

- [Visão geral da implantação do Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (pré-requisitos, limitações, restrições por RID e plataforma, comportamento de arquivo único e generics).
- [Suporte do ASP.NET Core para Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn (recursos web suportados e não suportados).
- [Incompatibilidades de trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities), MS Learn (por que o trimming é obrigatório e o que ele quebra).
- [Conversa sobre PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (design do Dynamic PGO e por que o AOT prescinde dele).
