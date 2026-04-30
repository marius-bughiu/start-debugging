---
title: "Como escrever um gerador de código-fonte para INotifyPropertyChanged"
description: "Um guia completo para construir seu próprio gerador de código-fonte incremental para INotifyPropertyChanged em C# 14 e .NET 11: a pipeline IIncrementalGenerator, atributos marcadores, saída de partial class, o padrão SetProperty e como manter compatibilidade com AOT."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "mvvm"
lang: "pt-br"
translationOf: "2026/04/how-to-write-a-source-generator-for-inotifypropertychanged"
translatedBy: "claude"
translationDate: 2026-04-30
---

Para gerar `INotifyPropertyChanged` (INPC) por conta própria, escreva um `IIncrementalGenerator` que encontre classes marcadas com um atributo personalizado, leia seus campos anotados com `[ObservableProperty]` e emita uma `partial class` que implemente a interface, exponha propriedades wrapper e dispare `PropertyChanged` por meio de um helper `SetProperty`. O gerador roda em tempo de compilação, contribui com zero custo em runtime além do encanamento padrão de INPC e remove cada linha de boilerplate manual de campo de apoio e setter. Este guia constrói o gerador de ponta a ponta sobre .NET 11 (preview 3) e C# 14, mas o mesmo código funciona contra qualquer consumidor que mire `netstandard2.0` para o analisador, já que esse continua sendo o contrato que o Roslyn exige para geradores de código-fonte.

## Por que escrever o seu quando o CommunityToolkit.Mvvm existe

A resposta conhecida é o `CommunityToolkit.Mvvm`, que entrega `[ObservableObject]`, `[ObservableProperty]`, `[NotifyPropertyChangedFor]` e uma pequena montanha de geradores bem testados. Para a maioria dos aplicativos, use isso. Este guia é para os casos em que você não pode:

- Você precisa de um gerador que emita uma interface diferente, como `IObservableObject` de um framework interno, ou um contrato de notificação específico de fornecedor.
- Você quer combinar INPC com comportamento extra que o toolkit não cobre (registro de auditoria, rastreamento de sujeira, coerção via uma regra de domínio).
- Você está construindo um artefato de aprendizado, um framework interno da casa ou um gerador que precisa conviver com `CommunityToolkit.Mvvm` sem colidir em nomes de atributos.
- Você quer entender o toolkit antes de confiar nele.

Geradores de código-fonte também são um dos lugares mais limpos para tocar APIs do Roslyn em primeira mão, e INPC é o alvo canônico de "pequeno, bem definido, alta alavancagem". Se você nunca escreveu um, este é um ponto de partida melhor do que tentar gerar código de registro de injeção de dependência ou configuração de EF Core.

## As peças que você precisa entregar

Um gerador INPC completo tem três partes, cada uma em seu próprio projeto ou injeção `<None>`:

1. Um **atributo marcador** que os consumidores aplicam a uma `partial class`. Convenção: `[Observable]` ou `[GenerateInpc]`.
2. Um **atributo em nível de campo** que marca o estado subjacente que o gerador deve expor como uma propriedade. Convenção: `[ObservableProperty]`.
3. O **gerador incremental** em si, empacotado para que o MSBuild o carregue como um analisador.

O atributo marcador é entregue mais facilmente via `RegisterPostInitializationOutput`, que permite ao gerador injetar o código-fonte do atributo na compilação do consumidor. Dessa forma, os consumidores adicionam um `<ProjectReference>` (ou um `<PackageReference>` com `OutputItemType="Analyzer"`) e imediatamente têm os atributos disponíveis, sem necessidade de uma DLL de runtime separada.

## Layout do projeto

O projeto do analisador deve mirar `netstandard2.0`, porque esse é o único TFM que o Roslyn carrega no IDE e no MSBuild de .NET Framework que instalações antigas do Visual Studio usam:

```xml
<!-- src/Inpc.SourceGenerator/Inpc.SourceGenerator.csproj -->
<!-- .NET 11 SDK, generator targets netstandard2.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <IsRoslynComponent>true</IsRoslynComponent>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp"
                      Version="4.13.0"
                      PrivateAssets="all" />
  </ItemGroup>
</Project>
```

`IsRoslynComponent` faz o Visual Studio tratá-lo como um gerador para carregamento em tempo de design. `EnforceExtendedAnalyzerRules` é o conjunto de regras estilo analisador que sinaliza erros como `string.Format` com problemas de cultura dentro de geradores, onde reprodutibilidade importa.

O projeto consumidor o referencia como um analisador:

```xml
<!-- consumer .csproj -->
<ItemGroup>
  <ProjectReference Include="..\Inpc.SourceGenerator\Inpc.SourceGenerator.csproj"
                    OutputItemType="Analyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

`ReferenceOutputAssembly="false"` é crítico: você **não** quer a DLL do analisador no caminho de runtime do consumidor. Se você esquecer disso, o consumidor envia o Roslyn em runtime, o que são vários megabytes de peso morto e quebra Native AOT.

## O atributo marcador, injetado em post-init

Dentro do gerador, registre a fonte do atributo antes de qualquer análise rodar. Isso garante que os consumidores possam usar os atributos sem um pacote separado:

```csharp
// .NET 11, C# 14, generator-side code (netstandard2.0)
using Microsoft.CodeAnalysis;

[Generator]
public sealed class InpcGenerator : IIncrementalGenerator
{
    private const string AttributeSource = """
        // <auto-generated/>
        #nullable enable
        namespace Inpc;

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Class, Inherited = false)]
        internal sealed class ObservableAttribute : global::System.Attribute { }

        [global::System.AttributeUsage(
            global::System.AttributeTargets.Field, Inherited = false)]
        internal sealed class ObservablePropertyAttribute : global::System.Attribute
        {
            public string? PropertyName { get; init; }
        }
        """;

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(ctx =>
            ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

        // pipeline registration follows in the next section
    }
}
```

Algumas escolhas não óbvias:

- Os atributos são `internal`. Cada assembly consumidor recebe sua própria cópia via post-init. Isso significa que dois assemblies podem usar `[Observable]` sem jogos de `TypeForwardedTo` ou conflitos de versão. O custo é que os atributos não sobrevivem entre fronteiras de assembly, o que está bom porque o gerador só precisa deles em tempo de compilação.
- Cada referência de tipo usa o prefixo `global::`. O código gerado pousa em namespaces arbitrários, incluindo aqueles chamados `System` ou `Inpc`. Sem `global::`, a resolução de nomes pode escolher o tipo errado e o arquivo gerado não compilará.
- O comentário de cabeçalho `// <auto-generated/>` suprime avisos do analisador de regras de `EditorConfig` e StyleCop.

## A pipeline incremental

Agora conecte a análise real. A API de gerador incremental do Roslyn tem duas metades: um `SyntaxProvider` que faz filtragem sintática barata a cada toque de tecla, e uma transformação que faz o trabalho semântico caro apenas quando o snapshot sintático muda:

```csharp
// .NET 11, C# 14, generator-side
public void Initialize(IncrementalGeneratorInitializationContext context)
{
    context.RegisterPostInitializationOutput(ctx =>
        ctx.AddSource("Inpc.Attributes.g.cs", AttributeSource));

    var classes = context.SyntaxProvider
        .ForAttributeWithMetadataName(
            "Inpc.ObservableAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax c
                && c.Modifiers.Any(SyntaxKind.PartialKeyword),
            transform: static (ctx, ct) => Extract(ctx, ct))
        .Where(static x => x is not null)
        .Select(static (x, _) => x!.Value);

    context.RegisterSourceOutput(classes,
        static (spc, model) => Emit(spc, model));
}
```

`ForAttributeWithMetadataName` é o ponto de entrada certo para qualquer gerador dirigido por atributo desde o Roslyn 4.3. Ele usa o índice de atributos do compilador, então o `predicate` roda apenas em sintaxe que já tem o nome de atributo correspondente. Isso é dramaticamente mais barato do que o padrão antigo `CreateSyntaxProvider` mais `Where`, e é o maior ganho individual de desempenho disponível.

O `predicate` impõe `partial` no nível de sintaxe, antes de qualquer modelo semântico existir. Isso pega o erro mais comum do consumidor (esquecer de `partial`) com a verificação mais barata possível.

## Extraindo um modelo estável

A transformação deve retornar um valor que seja estruturalmente comparável. A camada de cache do Roslyn compara valores de modelo entre execuções para pular a reemissão quando nada mudou. Se você retornar símbolos (`INamedTypeSymbol`, `IFieldSymbol`), cada toque de tecla invalida o cache, porque os símbolos são iguais por referência apenas dentro de uma única compilação.

Use um `record` (ou `readonly record struct`) de strings simples:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct ClassModel(
    string Namespace,
    string ClassName,
    EquatableArray<PropertyModel> Properties);

internal readonly record struct PropertyModel(
    string FieldName,
    string PropertyName,
    string TypeName);
```

`EquatableArray<T>` é um wrapper fino em torno de `ImmutableArray<T>` que implementa `Equals` estrutural. O Roslyn não entrega um, mas cada projeto de gerador copia as mesmas seis linhas do toolkit:

```csharp
// .NET 11, C# 14, generator-side
internal readonly record struct EquatableArray<T>(ImmutableArray<T> Items)
    : IEnumerable<T> where T : IEquatable<T>
{
    public bool Equals(EquatableArray<T> other) =>
        Items.AsSpan().SequenceEqual(other.Items.AsSpan());

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var item in Items) hash.Add(item);
        return hash.ToHashCode();
    }

    public IEnumerator<T> GetEnumerator() =>
        ((IEnumerable<T>)Items).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() =>
        ((IEnumerable)Items).GetEnumerator();
}
```

Esquecer disso e retornar um `ImmutableArray<T>` puro é o segundo bug de desempenho mais comum em geradores depois de usar `CreateSyntaxProvider` errado. `ImmutableArray<T>.Equals` é baseado em referência, então cada snapshot parece novo.

A função `Extract` real puxa campos do símbolo:

```csharp
// .NET 11, C# 14, generator-side
private static ClassModel? Extract(
    GeneratorAttributeSyntaxContext ctx,
    CancellationToken ct)
{
    if (ctx.TargetSymbol is not INamedTypeSymbol type) return null;

    var properties = ImmutableArray.CreateBuilder<PropertyModel>();
    foreach (var member in type.GetMembers())
    {
        ct.ThrowIfCancellationRequested();
        if (member is not IFieldSymbol field) continue;

        var attr = field.GetAttributes().FirstOrDefault(a =>
            a.AttributeClass?.ToDisplayString() == "Inpc.ObservablePropertyAttribute");
        if (attr is null) continue;

        string property = attr.NamedArguments
            .FirstOrDefault(kv => kv.Key == "PropertyName")
            .Value.Value as string
            ?? Capitalize(field.Name.TrimStart('_'));

        properties.Add(new PropertyModel(
            FieldName: field.Name,
            PropertyName: property,
            TypeName: field.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
    }

    return new ClassModel(
        Namespace: type.ContainingNamespace.IsGlobalNamespace
            ? string.Empty
            : type.ContainingNamespace.ToDisplayString(),
        ClassName: type.Name,
        Properties: new EquatableArray<PropertyModel>(properties.ToImmutable()));
}

private static string Capitalize(string name) =>
    name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];
```

`SymbolDisplayFormat.FullyQualifiedFormat` produz nomes no estilo `global::System.Collections.Generic.List<global::Foo.Bar>`, o que contorna todo problema de resolução de namespace que o arquivo emitido poderia bater.

`ct.ThrowIfCancellationRequested()` dentro do loop importa mais do que você esperaria. O IDE cancela execuções do gerador agressivamente conforme o usuário digita; um gerador que ignora o token bloqueia o IntelliSense.

## Emitindo a partial class

O passo de emissão é uma única caminhada de `StringBuilder`. Geradores tendem a crescer construtores baseados em `Roslyn.SyntaxFactory` que parecem bonitos e rodam devagar; um template de string está bom para código tão regular e é muito mais fácil de depurar:

```csharp
// .NET 11, C# 14, generator-side
private static void Emit(SourceProductionContext ctx, ClassModel model)
{
    var sb = new StringBuilder(1024);
    sb.AppendLine("// <auto-generated/>");
    sb.AppendLine("#nullable enable");
    if (model.Namespace.Length > 0)
    {
        sb.Append("namespace ").Append(model.Namespace).AppendLine(";");
        sb.AppendLine();
    }

    sb.Append("partial class ").Append(model.ClassName)
      .AppendLine(" : global::System.ComponentModel.INotifyPropertyChanged");
    sb.AppendLine("{");
    sb.AppendLine("    public event global::System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;");
    sb.AppendLine();
    sb.AppendLine("    private bool SetProperty<T>(ref T storage, T value, string propertyName)");
    sb.AppendLine("    {");
    sb.AppendLine("        if (global::System.Collections.Generic.EqualityComparer<T>.Default.Equals(storage, value))");
    sb.AppendLine("            return false;");
    sb.AppendLine("        storage = value;");
    sb.AppendLine("        PropertyChanged?.Invoke(this,");
    sb.AppendLine("            new global::System.ComponentModel.PropertyChangedEventArgs(propertyName));");
    sb.AppendLine("        return true;");
    sb.AppendLine("    }");
    sb.AppendLine();

    foreach (var p in model.Properties)
    {
        sb.Append("    public ").Append(p.TypeName).Append(' ').Append(p.PropertyName)
          .AppendLine();
        sb.AppendLine("    {");
        sb.Append("        get => this.").Append(p.FieldName).AppendLine(";");
        sb.Append("        set => SetProperty(ref this.").Append(p.FieldName)
          .Append(", value, nameof(").Append(p.PropertyName).AppendLine("));");
        sb.AppendLine("    }");
        sb.AppendLine();
    }

    sb.AppendLine("}");

    string hint = string.IsNullOrEmpty(model.Namespace)
        ? $"{model.ClassName}.Inpc.g.cs"
        : $"{model.Namespace}.{model.ClassName}.Inpc.g.cs";
    ctx.AddSource(hint, sb.ToString());
}
```

Coisas que vale a pena notar:

- `SetProperty` aloca um novo `PropertyChangedEventArgs` por mudança. Isso é aceitável para cargas típicas de UI. Se você vincular um fluxo de alta frequência (estado de jogo, dados de sensor) ao INPC, faça cache de um `PropertyChangedEventArgs` por propriedade em um campo estático; o `[ObservableProperty]` do toolkit faz isso quando você opta.
- O nome de hint (primeiro argumento de `AddSource`) deve ser único dentro da compilação. Incluir o namespace previne colisões quando duas classes em namespaces diferentes compartilham um nome.
- `EqualityComparer<T>.Default` lida com `null` corretamente para tipos de referência e é o comparador certo também para propriedades de tipo de valor. Usar `==` curto-circuitaria a igualdade definida pelo usuário.

## Código do consumidor

O propósito do exercício inteiro:

```csharp
// .NET 11, C# 14, consumer code
using Inpc;

[Observable]
public partial class PersonViewModel
{
    [ObservableProperty]
    private string _firstName = "";

    [ObservableProperty]
    private string _lastName = "";

    [ObservableProperty(PropertyName = "Age")]
    private int _ageYears;
}
```

O gerador emite as propriedades públicas `FirstName`, `LastName` e `Age`, o evento `PropertyChanged` e o helper `SetProperty`. O arquivo do consumidor permanece exatamente como você vê acima, sem encanamento de `OnPropertyChanged` e sem campos de apoio em lockstep.

## Native AOT e trimming

Geradores rodam em tempo de build, então não pagam nada em runtime. A pergunta interessante é o que o código *gerado* custa em um app AOT ou trimado:

- `INotifyPropertyChanged` é reconhecido pelo trimmer como parte do contrato de data binding. A interface e o evento `PropertyChanged` não serão removidos pelo trim de tipos observáveis.
- `EqualityComparer<T>.Default` é totalmente seguro para trim e seguro para AOT; sem reflexão.
- O construtor de `PropertyChangedEventArgs` não é removido pelo trim porque a assinatura do evento o enraíza.

A coisa para ficar de olho é o binding XAML. WPF e Avalonia usam reflexão para descobrir propriedades INPC, então as configurações de trim para esses frameworks já optam por excluir tipos de view-model observáveis do trim via descritores. Os bindings compilados do MAUI removem essa necessidade inteiramente, e um gerador como este se compõe naturalmente com codegen estilo `[BindableProperty]` se você quiser os dois mundos.

## Pegadinhas, em ordem de frequência

- **Esquecer `partial` na classe**: o `predicate` filtra fora e nada é gerado. O consumidor vê um erro de "definição não encontrada" ou de interface não implementada e assume que o gerador está quebrado. Adicione um diagnóstico no caminho do predicate que exponha uma mensagem amigável via `RegisterSourceOutput` em uma ramificação `Where(x => x is null)`.
- **Retornar símbolos da transformação**: mata a incrementalidade. Cada toque de tecla retransforma e reemite. O gerador parece "rápido o suficiente" em uma reprodução de uma classe, depois engatinha em uma solução real.
- **Esquecer `global::` em nomes de tipo emitidos**: um namespace de consumidor chamado `System.Foo` sombreia `System` e o arquivo gerado falha em compilar nesse único projeto, sem erro no projeto do gerador em si. Sempre qualifique completamente.
- **Emitir atributos em uma DLL de runtime separada**: dá para fazer, mas a injeção em post-init é mais simples e evita qualquer risco de desvio de versão de NuGet entre o analisador e o contrato de runtime.
- **Não tratar a convenção de prefixo `_`**: `string _firstName` deveria produzir `FirstName`, não `_FirstName`. O passo `Capitalize(name.TrimStart('_'))` lida com a convenção padrão; documente qualquer convenção que escolher.
- **Gerar nomes de hint duplicados**: `AddSource("Class.g.cs", ...)` de dois namespaces colide. Sempre inclua o namespace no hint.

Um gerador construído assim tem cerca de 200 linhas de código, roda em microssegundos por mudança e substitui centenas de linhas de boilerplate manual por consumidor. Uma vez que você enviou um, o próximo (comandos, registro de injeção de dependência, máquinas de estado) é uma cópia do mesmo esqueleto.

## Relacionado

- [Como escrever um JsonConverter personalizado em System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- outro ponto de extensão pequeno adjacente ao Roslyn com pegadinhas similares.
- [Como usar Channels em vez de BlockingCollection em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- padrões assíncronos que se compõem com view-models.
- [Como usar Native AOT com ASP.NET Core minimal APIs](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- como trim e AOT veem seu código gerado.
- [Como adicionar um filtro global de exceção no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- outro padrão frequentemente combinado com boilerplate gerado.

## Fontes

- MS Learn: [Source generators overview](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)
- Roslyn cookbook: [Incremental generators](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- Roslyn API: [`IIncrementalGenerator`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.iincrementalgenerator), [`ForAttributeWithMetadataName`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.csharpgeneratorextensions.forattributewithmetadataname)
- CommunityToolkit.Mvvm reference implementation: [CommunityToolkit/dotnet on GitHub](https://github.com/CommunityToolkit/dotnet)
