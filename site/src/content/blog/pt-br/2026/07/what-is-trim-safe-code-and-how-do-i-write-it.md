---
title: "O que é código trim-safe e como eu escrevo isso?"
description: "Código trim-safe é código que o trimmer do .NET consegue provar estaticamente que é alcançável, então ele sobrevive quando o código não usado é removido de um app self-contained. Este é o guia prático: ligue o analisador, leve cada aviso IL2xxx a zero, anote a reflexão com DynamicallyAccessedMembers, propague RequiresUnreferencedCode para APIs públicas e substitua padrões não analisáveis por geradores de código-fonte."
pubDate: 2026-07-09
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/what-is-trim-safe-code-and-how-do-i-write-it"
translatedBy: "claude"
translationDate: 2026-07-09
---

Código trim-safe é código que o trimmer do .NET consegue provar estaticamente que é alcançável, de modo que não é deletado quando você publica um app trimmed e self-contained, e código que não quebra silenciosamente o app quando membros não usados ao seu redor são removidos. Concretamente, isso significa que seu projeto compila limpo sob a análise de trimming: zero `IL2026`, `IL3050`, `IL2070` e companhia. Você torna o código trim-safe ligando o analisador e depois trabalhando a lista de avisos até zerar: anote a reflexão que você consegue expressar (`[DynamicallyAccessedMembers]`), coloque em quarentena a reflexão que você não consegue por trás de `[RequiresUnreferencedCode]` e empurre isso para cima até uma API pública, e substitua padrões que resistem a ambos por um gerador de código-fonte. Uma build de análise limpa é o contrato; se você não conseguir chegar a zero, o app não é trim-safe e o trimming vai produzir crashes que só acontecem em produção e que nunca apareceram no `dotnet run`.

Tudo aqui tem como alvo o SDK do .NET 11 (`11.0.100`) e o C# 14, mas os avisos de análise de trimming existem desde o .NET 6, então a mecânica se aplica a partir do `net6.0` em diante. O SDK do .NET 8 ou posterior é o mínimo prático para trabalho de biblioteca, porque é onde o analisador e a história de compatibilidade com AOT se estabilizaram.

## Por que o trimmer precisa que seu código coopere

O trimming funciona por análise de alcançabilidade. O trimmer (internamente `ILLink`) começa no seu ponto de entrada, percorre cada chamada de método, acesso a campo e referência de tipo que consegue ver estaticamente, marca cada coisa que toca como mantida e deleta todo o resto. É assim que um app self-contained encolhe de dezenas de megabytes para uma fração: o framework é enorme, seu app usa uma fatia fina, e o resto vai embora. Desde o .NET 6, a granularidade padrão é no nível de membro (`TrimMode=full`), não o antigo comportamento `copyused` no nível de assembly, então o trimmer remove métodos e tipos individuais não usados, não apenas assemblies inteiros sem referências. Isso é mais agressivo, e mais propenso a remover algo que você de fato alcança de uma forma que a análise não conseguiu enxergar.

A coisa que a análise não consegue enxergar é a reflexão. Quando você escreve `type.GetMethods()` ou `Activator.CreateInstance(someType)`, o trimmer não tem ideia de qual tipo concreto flui em tempo de execução, então ele não consegue saber quais membros manter. Ele tem duas opções ruins: manter tudo que poderia possivelmente fluir para ali (o que anula o trimming) ou não manter nada e deixar você descobrir em tempo de execução com uma `MissingMethodException`. Ele não faz nenhuma das duas. Em vez disso, ele exige que o código reflexivo carregue anotações descrevendo exatamente o que ele toca, e emite um aviso sempre que um valor não anotado flui para uma chamada de reflexão. Código trim-safe é código que satisfaz essas exigências. As mesmas regras governam a [build Native AOT, que torna o trimming obrigatório](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/), então tudo abaixo também é o preço de entrada para o AOT.

## Passo um: ligue o analisador

Você não consegue corrigir avisos que não consegue ver, e por padrão uma build normal não mostra nenhum. Há duas maneiras de trazê-los à tona, e a documentação recomenda usar ambas porque elas pegam coisas diferentes.

Para uma aplicação que você vai publicar com trimming, defina `PublishTrimmed` no arquivo de projeto (não apenas na linha de comando, para que ele também se aplique durante o `dotnet build`):

```xml
<!-- .NET 11, C# 14. App project. Turns on the trimmer at publish and
     the trim-compat Roslyn analyzer during every build. -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

Para uma biblioteca, você não a publica, então você habilita a análise com escopo de projeto em vez disso. `<IsTrimmable>true</IsTrimmable>` marca o assembly como compatível com trimming e liga os avisos para aquele projeto:

```xml
<!-- .NET 11, C# 14. Library project. Marks the assembly trimmable and
     emits trim warnings for this project's own code. -->
<PropertyGroup>
  <IsTrimmable>true</IsTrimmable>
</PropertyGroup>
```

Duas nuances importam aqui. Primeiro, se você quiser os avisos sem prometer que o assembly é trim-safe (digamos, enquanto você ainda está trabalhando neles), use `<EnableTrimAnalyzer>true</EnableTrimAnalyzer>` em vez de `IsTrimmable`. Ele emite a mesma análise sem carimbar o assembly como trimmable. Segundo, `IsTrimmable` assume o padrão `true` quando você define `<IsAotCompatible>true</IsAotCompatible>`, então uma biblioteca compatível com AOT está recebendo análise de trimming quer você a tenha pedido separadamente ou não.

O problema com a análise de biblioteca com escopo de projeto é que ela só enxerga seu código mais os reference assemblies das suas dependências, e reference assemblies não carregam informação suficiente para o trimmer julgá-los. Para ver cada aviso, incluindo os que vêm de como sua biblioteca usa suas dependências, construa um pequeno app de teste de trimming: um projeto de console que referencia sua biblioteca, define `<PublishTrimmed>true</PublishTrimmed>` e enraíza sua biblioteca para que a coisa toda seja analisada:

```xml
<!-- .NET 11. Trimming test app. Roots the library so ILLink walks every
     code path in it, not just the ones the console Main reaches. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\MyLibrary\MyLibrary.csproj" />
    <TrimmerRootAssembly Include="MyLibrary" />
  </ItemGroup>
</Project>
```

Então `dotnet publish -c Release -r linux-x64` e leia os avisos. `TrimmerRootAssembly` é o que faz a diferença: sem ele, o trimmer só analisa as chamadas que seu `Main` de fato alcança; com ele, ele trata a biblioteca inteira como uma raiz e percorre cada caminho.

## Lendo os avisos que significam "ainda não é trim-safe"

Quatro famílias de avisos cobrem quase tudo que você vai encontrar. Saber qual é qual diz a você a correção.

`IL2026` (`RequiresUnreferencedCode`) significa que você chamou um método que alguém já declarou incompatível com trimming. `IL3050` (`RequiresDynamicCode`) é o irmão exclusivo do AOT: o método precisa de geração de código em tempo de execução que o JIT forneceria mas o AOT não pode. `IL2070`, `IL2075`, `IL2077` e o resto da faixa `IL207x` são avisos de fluxo de dados: um `Type` não anotado (de um parâmetro, um campo, um valor de retorno) fluiu para uma chamada de reflexão que requer uma promessa `[DynamicallyAccessedMembers]`, e ninguém fez a promessa. Trate cada um destes como um defeito real, não como ruído do analisador. O objetivo todo do analisador é converter uma `MissingMethodException` silenciosa, exclusiva da publicação, às vezes exclusiva de produção, em um aviso de tempo de compilação que aponta para a linha exata.

Uma dica de leitura. No .NET 6+ o trimmer colapsa todos os avisos internos de um assembly de `PackageReference` em um único aviso por assembly, para que você não se afogue no ruído de uma dependência que você não controla. Quando você realmente quiser ver todos eles (você está tentando decidir se uma dependência é corrigível), defina `<TrimmerSingleWarn>false</TrimmerSingleWarn>` para expandi-los.

## Corrigindo IL207x: anote a reflexão que você consegue expressar

Os avisos de fluxo de dados são os que você corrige no seu próprio código, e a correção tem sempre o mesmo formato: declare o requisito no local de onde o `Type` vem, para que a promessa viva no sistema de tipos. Pegue este helper, que emite um aviso porque `GetMethods()` requer que o tipo mantenha seus métodos públicos e o parâmetro não promete nada:

```csharp
// .NET 11, C# 14. Warns IL2070: 'type' has no matching annotation.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

Copie o requisito para o parâmetro:

```csharp
// .NET 11, C# 14. Clean: the parameter now carries the promise.
static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

O requisito não desaparece, ele se move para os chamadores, e continua se propagando para fora até pousar em um `typeof(Customer)` ou um argumento de tipo concreto, onde o trimmer finalmente sabe exatamente o que manter. Peça o mínimo: se tudo que você faz é `Activator.CreateInstance(type)`, solicite `PublicParameterlessConstructor`, não `All`. Cada flag que você adiciona são membros que o trimmer está proibido de deletar, o que é tamanho binário que você paga. O modelo de fluxo completo, incluindo como anotar campos, parâmetros de tipo genérico e valores de retorno, é coberto no [mergulho profundo sobre DynamicallyAccessedMembers](/pt-br/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/); o resumo em uma linha é que o atributo não preserva nada por si só, ele propaga uma obrigação para onde quer que o tipo concreto nasça.

## Corrigindo IL2026: coloque em quarentena a reflexão que você não consegue expressar

Às vezes a reflexão é genuinamente não analisável. Você carrega um tipo por string a partir da configuração, ou você percorre `GetProperties()` sobre um objeto cujo tipo não é conhecido até o tempo de execução. Você não consegue se anotar para sair disso, então você declara o método incompatível com trimming com `[RequiresUnreferencedCode]` e deixa o aviso se propagar:

```csharp
// .NET 11, C# 14. Honest: this method reflects in a way trimming can break.
[RequiresUnreferencedCode("Serializes arbitrary types via reflection over their properties.")]
static string Serialize(object value)
{
    var sb = new StringBuilder();
    foreach (var p in value.GetType().GetProperties())
        sb.Append(p.Name).Append('=').Append(p.GetValue(value)).Append(';');
    return sb.ToString();
}
```

O atributo não corrige nada. Ele move o aviso `IL2026` para cada chamador de `Serialize`, do mesmo jeito que `[DynamicallyAccessedMembers]` move seu requisito, até que ele alcance uma fronteira de API pública onde o autor da biblioteca documenta a limitação e para a propagação. Este é o resultado correto para código que verdadeiramente não é trim-safe: em vez de uma falha silenciosa em tempo de execução, o chamador recebe um aviso de tempo de compilação dizendo que este caminho é inseguro sob trimming, e ele pode decidir se quer evitá-lo. É também por isso que propagar de forma limpa até APIs públicas importa, já que isso suprime o abrangente `IL2104: Assembly produced trim warnings` e dá aos consumidores sinais precisos, por método.

Se o padrão é majoritariamente reflexão, não se anote para contorná-lo chamada por chamada. Esse é o sinal para substituí-lo por geração de código em tempo de compilação. Serializadores e mapeadores baseados em reflexão são o exemplo canônico: em vez de anotar uma varredura de `GetProperties()`, você adota um [gerador de código-fonte](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) que emite o código de acesso em tempo de build, que é exatamente por que o `System.Text.Json` gerado por código-fonte existe e por que ele é o caminho recomendado para AOT.

## As saídas de emergência, e quando elas são uma armadilha

Dois atributos permitem que você silencie avisos sem mudar o código, e ambos são afiados.

`[UnconditionalSuppressMessage]` silencia um aviso específico e, diferentemente do simples `[SuppressMessage]`, é persistido no IL para que a análise de trimming o respeite. Use-o apenas quando o fluxo de dados é real e correto mas o analisador não consegue segui-lo, por exemplo um `Type[]` cujo cada elemento você sabe que mantém seu construtor por construção:

```csharp
// .NET 11, C# 14. Valid only because the setter guarantees the invariant.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only holds types stored through the annotated setter.")]
get => _types[i];
```

A documentação é direta sobre o modo de falha: só é válido suprimir quando os membros sobre os quais se reflete são alvos de reflexão genuínos em outro lugar no programa. Um membro que é usado de forma não reflexiva (uma chamada de método normal) não é um alvo de supressão válido, porque o otimizador é livre para fazer inline dele, renomeá-lo ou movê-lo, e sua reflexão suprimida então quebra sem nenhum aviso para avisar você. Suprimir "a propriedade é usada pelo app então ela tem que estar lá" é exatamente o padrão inválido que a documentação aponta.

`[DynamicDependency]` é o último recurso. Ele mantém membros nomeados mas não informa a análise, então não silencia avisos por si só e é usado junto com uma supressão. Recorra a ele apenas para padrões que nem mesmo `[DynamicallyAccessedMembers]` consegue expressar, como carregar um membro por string a partir de um assembly separado:

```csharp
// .NET 11, C# 14. Last resort. Keeps Helper so the reflection below finds it.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

Se você se encontrar espalhando qualquer um dos atributos por muitos pontos de chamada, isso não é uma correção de trim-safety, é um cheiro de design dizendo a você que a API é fundamentalmente moldada por reflexão e deveria ser regenerada em tempo de build em vez disso.

## Feature switches do framework: fazendo trimming de código que você nunca chama

Nem toda trim-safety é sobre sua reflexão. Um pedaço do framework é distribuído com diretivas de trimmer por trás de feature switches, para que você possa dizer ao trimmer para remover áreas inteiras de recursos que você não usa. Elas funcionam tanto como configuração de runtime quanto como instruções de trimming. Algumas que vale conhecer: `<EventSourceSupport>false</EventSourceSupport>` remove o encanamento de EventSource, `<UseSystemResourceKeys>true</UseSystemResourceKeys>` retira o texto completo das mensagens de exceção dos assemblies `System.*` reduzindo-o a IDs de recurso, `<InvariantGlobalization>true</InvariantGlobalization>` remove os dados de globalização, e `<StackTraceSupport>false</StackTraceSupport>` (.NET 8+) remove a geração de stack trace em tempo de execução. O .NET 10 adicionou `<UseSizeOptimizedLinq>true</UseSizeOptimizedLinq>`, que troca algum throughput de LINQ por saída menor e é o padrão sob `PublishAot`. Elas não são sobre tornar seu código analisável; são sobre não pagar, em tamanho binário, por recursos do framework que você nunca toca. Habilite-as deliberadamente, porque cada uma remove comportamento real.

## O fluxo de trabalho que de fato leva você ao trim-safe

O modelo mental que faz tudo isso se encaixar: trim-safety não é um interruptor, é um estado de build que você defende. Ligue o analisador (`PublishTrimmed` para apps, `IsTrimmable` mais um app de teste enraizado para bibliotecas). Leia os avisos e ordene-os: `IL207x` você corrige anotando a origem do `Type` com o mínimo de flags `DynamicallyAccessedMembers`; `IL2026`/`IL3050` você ou anota com `[RequiresUnreferencedCode]` e propaga até uma API pública, ou substitui a reflexão por um gerador de código-fonte; as duas saídas de emergência você usa apenas quando uma invariante é real e o analisador genuinamente não consegue enxergá-la. Leve a contagem a zero, e depois a mantenha lá, porque introduzir um novo aviso de trimming é uma mudança que quebra compatibilidade para qualquer um que publique sua biblioteca com trimming, e um bump de dependência pode reintroduzir um sem nenhuma mudança de API do seu lado. Quando uma chamada insegura escapa do analisador e só falha em tempo de execução, você está de volta a depurar uma [PlatformNotSupportedException no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/), que é precisamente a falha que a build livre de avisos existe para prevenir. E se o alvo é um serviço web real, [o passo a passo de API mínima com Native AOT](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) mostra a receita de build limpa de ponta a ponta. Código trim-safe não é um dialeto especial de C#; é C# comum que mantém a análise de alcançabilidade do trimmer honesta, e o analisador é a ferramenta que diz a você, em tempo de build, se você conseguiu.

## Relacionados

- [O que é Native AOT e o que ele custa a você?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) explica por que o trimming é obrigatório sob AOT e o que mais você abre mão.
- [O que é o atributo DynamicallyAccessedMembers?](/pt-br/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/) é o mergulho profundo sobre a anotação que corrige os avisos de fluxo de dados IL207x.
- [O que é um gerador de código-fonte e quando eu preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) cobre a geração de código em tempo de compilação que substitui a reflexão que você não consegue anotar.
- [Como usar Native AOT com APIs mínimas do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) é o passo a passo de build limpa onde esses avisos aparecem em um app real.
- [Correção: PlatformNotSupportedException no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) é a falha em tempo de execução que uma build de trimming livre de avisos previne.

## Fontes

- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (IsTrimmable, EnableTrimAnalyzer, the test-app pattern, RequiresUnreferencedCode, DynamicallyAccessedMembers, UnconditionalSuppressMessage, DynamicDependency).
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options), MS Learn (PublishTrimmed, TrimmerSingleWarn, ILLinkTreatWarningsAsErrors, the feature-switch table).
- [Trim self-contained deployments and executables](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained), MS Learn (TrimMode granularity and how reachability trimming works).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (the IL2026/IL3050/IL207x warning catalog and the data-flow model).
