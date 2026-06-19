---
title: "O que é um gerador de código-fonte e quando eu preciso de um?"
description: "Um guia em linguagem clara sobre geradores de código-fonte em C#: o que eles realmente fazem, como funciona o pipeline do IIncrementalGenerator, quando eles superam a reflexão ou o T4, e os casos em que você não deve recorrer a um. Com exemplos executáveis em .NET 11 e C# 14."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "roslyn"
lang: "pt-br"
translationOf: "2026/06/what-is-a-source-generator-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-06-19
---

Um gerador de código-fonte é um trecho de código que o compilador de C# executa enquanto compila o seu projeto, e que pode ler o seu código e adicionar novos arquivos C# à mesma compilação. Ele roda em tempo de compilação, produz código-fonte comum que o compilador então compila como se você o tivesse digitado, e não adiciona nenhum custo em runtime além do código que emite. Você precisa de um quando, de outra forma, pagaria por reflexão em runtime, escreveria à mão código repetitivo, ou rodaria um passo de geração de código separado e fora de banda, e quer que o código gerado tenha tipos fortes, seja depurável, compatível com o trimming e adequado para Native AOT. Se você não tem algum desses problemas, quase com certeza não precisa escrever um gerador. Este guia cobre .NET 11 (preview 5) e C# 14, mas a mecânica se aplica a qualquer projeto em .NET 6 ou posterior.

## O que "rodar dentro do compilador" realmente significa

A maior parte do código que você escreve roda depois da build, quando o aplicativo inicia. Um gerador de código-fonte é diferente: ele é um componente do Roslyn que o compilador carrega como analisador e invoca durante a compilação. Ele obtém uma visão somente leitura de tudo o que o Roslyn sabe do seu projeto até então (árvores de sintaxe, símbolos semânticos, referências, arquivos adicionais) e a sua única saída é mais código-fonte. Ele não pode reescrever os seus arquivos existentes, apagar código ou mudar o que você já escreveu. Ele só pode adicionar.

Essa restrição de "só adicionar" é todo o design. O código gerado entra na compilação como arquivos extras, e o padrão dominante é o membro `partial`: você escreve metade de uma classe à mão, marca como `partial`, e o gerador emite a outra metade. As duas metades são compiladas juntas em um único tipo. Como a saída é C# real que vira IL real, tudo a jusante o trata como código que você escreveu: o IntelliSense o enxerga, o depurador entra nele, o linker pode fazer trimming nele, e o Native AOT pode compilá-lo de forma antecipada. Não há reflexão em runtime, nem `Reflection.Emit`, nem proxy dinâmico.

Este é o modelo mental essencial. Um gerador de código-fonte não é um sistema de macros nem um script pós-build. É uma função em tempo de compilação que vai de "o seu código" para "mais código seu".

## Por que ele supera as alternativas que substitui

Antes dos geradores de código-fonte (introduzidos no .NET 5, Roslyn 3.8), as três formas de evitar escrever código repetitivo à mão eram a reflexão, a emissão de IL e os geradores de código externos como os templates T4. Cada um tem um custo real que um gerador de código-fonte elimina.

A reflexão em runtime (pense em serializadores JSON clássicos, contêineres de injeção de dependência, mappers de objetos) inspeciona os tipos na inicialização e ou os interpreta a cada chamada, ou constrói um método dinâmico uma vez e o coloca em cache. Funciona, mas paga um imposto de inicialização, é invisível para o trimmer (então infla as builds com trimming e AOT, ou as quebra de vez), e o custo recai sobre os seus usuários, não sobre a sua build. Uma `System.InvalidOperationException` ou uma `System.PlatformNotSupportedException` da reflexão só aparece em runtime, muitas vezes em produção. Cobrimos exatamente esse modo de falha em [por que código cheio de reflexão quebra sob Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/).

T4 e outros geradores externos rodam como um passo separado, normalmente ligado à build com o seu próprio tooling. Eles não conseguem ver o modelo semântico (fazem parse de texto, não de símbolos), os arquivos gerados ficam em disco e saem de sincronia, e são desajeitados em CI. Os geradores de código-fonte rodam dentro da mesma compilação, enxergam símbolos totalmente resolvidos e nunca escrevem um arquivo desatualizado no seu repositório.

Um gerador de código-fonte move todo esse trabalho para o tempo de compilação e emite C# simples e compilado de forma estática. O serializador não reflete sobre o seu tipo na inicialização; ele já tem o código exato para lê-lo e escrevê-lo. É por isso que o gerador de código-fonte embutido do `System.Text.Json` é o único caminho de JSON que funciona sob Native AOT, um ponto que destacamos em [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## Os geradores que você já usa

Você não precisa escrever um para se beneficiar do conceito. O .NET moderno traz vários, e reconhecê-los diz para que tipo de problema os geradores são bons:

- A geração de código-fonte do `System.Text.Json` (`[JsonSerializable]` + um `JsonSerializerContext`) emite código de serialização para que o STJ nunca faça reflexão em runtime.
- A geração de código-fonte do `LoggerMessage` (`[LoggerMessage]`) transforma um método parcial em uma chamada de log com tipos fortes e sem alocação.
- `GeneratedRegex` (`[GeneratedRegex]`) compila o seu padrão de expressão regular para C# em tempo de compilação em vez de construir uma máquina de estados no primeiro uso.
- `System.Text.Json`, `Microsoft.Extensions.Configuration` e o binder de opções têm geradores que substituem o binding baseado em reflexão.
- `CommunityToolkit.Mvvm` gera o encanamento do `INotifyPropertyChanged` a partir de `[ObservableProperty]`.
- `Mapperly` gera o mapeamento de objeto para objeto em tempo de compilação, a base da nossa [migração de AutoMapper para mapeamento gerado por código-fonte](/pt-br/2026/05/migrate-from-automapper-to-source-generated-mapping/).

A forma compartilhada: pegar um marcador declarativo (um atributo, um método parcial, uma classe parcial) e emitir o código tedioso, propenso a erros e com cara de reflexão que de outra forma seria escrito à mão ou descoberto em runtime.

## Como um gerador é construído: o pipeline incremental

Há duas interfaces de gerador, e apenas uma é a atual. A original `ISourceGenerator` (um par `Initialize`/`Execute` que recebia toda a compilação e rodava a cada tecla) está obsoleta. O código-fonte do Roslyn diz isso explicitamente: "ISourceGenerator is deprecated and should not be implemented. Please implement IIncrementalGenerator instead." (veja a [nota de obsolescência do ISourceGenerator em dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)). Para qualquer coisa nova, use `IIncrementalGenerator`.

A razão é o desempenho no IDE. Um gerador incremental não recalcula tudo do zero a cada execução. Você declara um pipeline, um grafo de passos de transformação, e o Roslyn coloca em cache a saída de cada passo. Se as entradas de um passo não mudaram desde a última tecla, o Roslyn pula esse passo e reutiliza o resultado em cache. É isso que torna seguro reexecutar um gerador centenas de vezes por minuto enquanto você digita.

Aqui está um gerador mínimo mas completo. Ele encontra as classes marcadas com `[AutoToString]` e emite um override de `ToString()` que lista as propriedades públicas.

```csharp
// Generator project: netstandard2.0, references Microsoft.CodeAnalysis.CSharp
// .NET 11 preview 5, Roslyn 4.x, C# 14
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

[Generator]
public sealed class AutoToStringGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        // 1. Cheap syntactic filter, then a semantic transform into a small,
        //    value-equatable model. Returning a record (not a symbol) is what
        //    lets Roslyn cache this step and skip work when nothing changed.
        var classes = context.SyntaxProvider.ForAttributeWithMetadataName(
            "AutoToStringAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax,
            transform: static (ctx, _) =>
            {
                var symbol = (INamedTypeSymbol)ctx.TargetSymbol;
                var props = symbol.GetMembers()
                    .OfType<IPropertySymbol>()
                    .Where(p => p.DeclaredAccessibility == Accessibility.Public)
                    .Select(p => p.Name)
                    .ToImmutableArray();
                return new Model(symbol.ContainingNamespace.ToDisplayString(),
                                 symbol.Name, props);
            });

        // 2. Emit one source file per matched class.
        context.RegisterSourceOutput(classes, static (spc, model) =>
        {
            var sb = new StringBuilder();
            sb.AppendLine($"namespace {model.Namespace};");
            sb.AppendLine($"partial class {model.Name}");
            sb.AppendLine("{");
            sb.AppendLine("    public override string ToString() =>");
            var body = string.Join(" + \", \" + ",
                model.Properties.Select(p => $"\"{p}=\" + {p}"));
            sb.AppendLine($"        {body};");
            sb.AppendLine("}");
            spc.AddSource($"{model.Name}.AutoToString.g.cs", sb.ToString());
        });
    }

    private record Model(string Namespace, string Name,
                         ImmutableArray<string> Properties);
}
```

O lado do consumidor é só um atributo e uma `partial class`:

```csharp
// Consumer project, C# 14
[AutoToString]
public partial class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
}

// Elsewhere: new Order { Id = 7, Customer = "Acme" }.ToString()
// => "Id=7, Customer=Acme"   (the ToString override is generated)
```

Dois detalhes carregam quase todo o peso. Primeiro, `ForAttributeWithMetadataName` é o ponto de entrada rápido adicionado no Roslyn 4.3: ele permite que o Roslyn pré-filtre para os nós que de fato carregam o seu atributo em vez de percorrer cada nó de sintaxe, o que é a maior alavanca de desempenho em um gerador real. Segundo, o `transform` retorna um `record` pequeno (`Model`), não o `INamedTypeSymbol`. Isso importa mais do que parece: a incrementalidade depende da igualdade por valor. Como diz o cookbook do Roslyn, você quer que tipos comparáveis por valor como `record`, `struct`, tuplas e `ImmutableArray<T>` fluam pelo pipeline, porque no momento em que um passo retorna um valor igual à sua saída anterior, o Roslyn para e reutiliza o resultado em cache a jusante. Passe um `Symbol` ou um `Compilation` pelo pipeline e você derrota o cache por completo, porque esses tipos são grandes, comparáveis por referência e mudam a cada tecla.

## Quando você deve recorrer a um

Escreva ou adote um gerador de código-fonte quando tudo isto for verdade:

1. O código é mecânico e derivável de algo que já está no fonte (o formato de um tipo, um atributo, a assinatura de um método). Se um humano que o escrevesse estivesse apenas transcrevendo, um gerador pode fazê-lo.
2. Você atualmente paga por isso com reflexão em runtime, e esse custo é real: latência de inicialização, alocações em um caminho quente, ou uma incompatibilidade com trimming/AOT.
3. Você quer que o resultado seja depurável e com tipos estáticos, não um método dinâmico no qual você não consegue entrar para depurar.

As vitórias mais claras: serialização, mapeamento de DTO, registro de injeção de dependência, `INotifyPropertyChanged`, binding de configuração com tipos fortes, geração de clientes a partir de um contrato, e a substituição de qualquer caminho quente com `Activator.CreateInstance` ou `Expression.Compile`. Se você mira Native AOT, o cálculo pende ainda mais para os geradores, já que as abordagens baseadas em reflexão são justamente o que quebra ali. Percorremos essa restrição em [usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## Quando você não precisa de um (e não deve escrever um)

Geradores não são de graça para construir nem para manter. Pule escrever o seu próprio quando:

- Já existe um gerador bem testado. Não reimplemente o `CommunityToolkit.Mvvm`, o Mapperly ou o gerador de contexto do STJ por diversão. Use-os. O [passo a passo do gerador de INotifyPropertyChanged](/pt-br/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) existe para ensinar a API do Roslyn, não para argumentar que você deveria publicar o seu próprio toolkit de MVVM.
- A repetição é pequena ou pontual. Um punhado de classes parecidas não é motivo para assumir um projeto de analisador em `netstandard2.0`, um harness de testes separado e uma história de depuração que envolve anexar um segundo compilador.
- Você na verdade precisa transformar ou reescrever código existente. Geradores só podem adicionar. Se você quer injetar comportamento em métodos que não escreveu, isso são interceptors (um recurso separado do C# 14) ou um weaver de IL pós-compilação como o Fody, não um gerador de código-fonte.
- O formato é genuinamente dinâmico, decidido em runtime a partir de dados que o compilador não consegue ver (um arquivo de configuração lido na inicialização, um plugin carregado do disco). O compilador não sabe nada do estado em runtime, então um gerador não pode ajudar.
- Um genérico `T` simples, uma classe base ou um método auxiliar comum resolveriam. Recorra primeiro à linguagem. Geradores são para os casos em que a linguagem não consegue expressar a abstração sem código repetitivo por tipo.

O padrão honesto para a maioria dos times é: consuma geradores com liberalidade, escreva os seus próprios raramente.

## As armadilhas que mordem primeiro

Algumas coisas fazem todo mundo tropeçar na primeira vez:

- O projeto do gerador deve mirar `netstandard2.0`. Esse continua sendo o contrato que o Roslyn exige para analisadores, independentemente do que o seu aplicativo mira. Você vai escrever o gerador em uma superfície de linguagem mais antiga do que o código que ele emite.
- Referencie-o como analisador, não como dependência normal: `<ProjectReference Include="..\Gen.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" />`. Se você errar isso, ou o gerador não roda, ou ele vaza para a sua saída de runtime.
- O código gerado é aditivo e você não consegue vê-lo por padrão. Defina `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` no projeto consumidor para despejar os arquivos `.g.cs` em `obj/` e assim conseguir ler o que de fato foi emitido. Isso é a primeira coisa a fazer quando a saída parece errada.
- Não coloque `Compilation`, `ISymbol` ou `SyntaxNode` no modelo de dados do pipeline. Eles não são comparáveis por valor e matam a incrementalidade, o que transforma o seu gerador de volta no comportamento lento do `ISourceGenerator` que você tentava evitar. Projete-os para records cedo.
- Nunca lance uma exceção a partir de um gerador. Uma exceção vira um aviso de build (`CS8785`) e o seu código silenciosamente não é gerado. Trate o caso de "atributo presente mas tipo malformado" emitindo um diagnóstico, não travando.
- Um gerador roda em cada build do projeto consumidor, inclusive no IDE a cada edição. Um gerador lento ou não incremental faz o editor inteiro parecer travado. Isso não é teórico; é o motivo pelo qual a API incremental existe.

O atalho mental que te mantém fora de encrenca: um gerador de código-fonte é uma função pura e em cache que vai de entradas imutáveis para texto-fonte. Mantenha as entradas pequenas e comparáveis por valor, mantenha a função rápida, nunca deixe que ela lance exceção, e só escreva um quando a reflexão ou o código repetitivo à mão estiver lhe custando algo que você consiga medir.

## Fontes e leituras adicionais

- [Geradores incrementais, docs do dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- [Cookbook de geradores incrementais, dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.cookbook.md)
- [Nota de obsolescência do ISourceGenerator, fonte do dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)
- [Visão geral de geradores de código-fonte, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
