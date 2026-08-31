---
title: "AutoMapper vs Mapperly vs mapeamento escrito à mão em 2026"
description: "Mapperly é o padrão para código .NET novo: iguala a velocidade do mapeamento escrito à mão, sobrevive ao Native AOT e detecta membros não mapeados em tempo de compilação. AutoMapper ainda vence no ProjectTo. Com benchmarks e limites de licença."
pubDate: 2026-08-31
template: vs
tags:
  - "comparison"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet"
  - "performance"
lang: "pt-br"
translationOf: "2026/08/automapper-vs-mapperly-vs-hand-written-mapping-in-2026"
translatedBy: "claude"
translationDate: 2026-08-31
---

Para código .NET novo em 2026, use **Mapperly**. Ele gera C# puro em tempo de compilação, roda dentro de 3% do mapeamento escrito à mão, publica limpo sob Native AOT e transforma uma propriedade esquecida em um diagnóstico do compilador em vez de uma string vazia silenciosa. Escreva o mapeamento **à mão** quando um projeto tem menos de cerca de vinte mapas ou quando os formatos de origem e destino realmente divergem. Fique com o **AutoMapper** apenas quando `ProjectTo` for essencial em uma base de código grande com EF Core e você se qualificar para o nível Community gratuito, porque acima de 5.000.000 USD de receita anual a licença transforma a decisão em uma ordem de compra.

Todos os números abaixo foram medidos em um Apple M4 (10 núcleos) com .NET SDK 10.0.302 mirando `net10.0`, usando AutoMapper 16.2.0 (lançado em 2026-07-02), Riok.Mapperly 4.3.1 (lançado em 2025-12-22) e BenchmarkDotNet 0.15.8.

## A matriz

| | AutoMapper 16.2.0 | Mapperly 4.3.1 | Escrito à mão |
| --- | --- | --- | --- |
| Licença | copyleft RPL-1.5 ou comercial paga | Apache 2.0 | nenhuma |
| Custo acima de 5.000.000 USD de receita | de 799 a 6.399 USD por ano | grátis | grátis |
| Como o mapeamento é produzido | reflexão mais árvores de expressão compiladas no primeiro uso | gerador de código-fonte do Roslyn em tempo de compilação | você |
| Membro de destino não mapeado | silencioso, só `AssertConfigurationIsValid()` detecta | aviso `RMG012`, escalável para erro | o compilador também não diz nada |
| Membro de origem não mapeado | não é reportado | aviso `RMG020` | não é reportado |
| Publicação com Native AOT | `IL2104` mais `IL3053`, quebra na inicialização | zero avisos, funciona | zero avisos, funciona |
| Custo a frio do primeiro mapeamento | ~33 ms para 3 mapas | ~1 ms | 0 |
| Mapeamento de um objeto | 105.79 ns | 60.44 ns | 58.48 ns |
| Projeção com EF Core | `ProjectTo` com expansão explícita, parâmetros e profundidade de recursão | projeção `IQueryable` gerada, vários recursos não suportados | escreva o `Select` |
| `Map(object, type)` em runtime | sim | não | não |
| Saída depurável | árvore de expressão compilada | `.g.cs` legível no qual você pode entrar passo a passo | seu próprio código |

## A licença é o eixo do qual tudo o mais depende

Em 2025-07-02 Jimmy Bogard transferiu AutoMapper e MediatR para a Lucky Penny Software e relicenciou ambos. AutoMapper 15.0.0 e posteriores são distribuídos sob um modelo duplo: a [Reciprocal Public License 1.5](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) para uso open source, ou uma licença comercial paga. A versão 14.x e anteriores permanecem sob MIT para sempre.

RPL-1.5 não é MIT com passos extras. É um copyleft recíproco forte que alcança software implantado, não apenas software distribuído, então produtos comerciais de código fechado não podem realmente ser publicados sobre o build RPL. Isso deixa o acordo comercial, cujo nível Community gratuito cobre organizações com menos de 5.000.000 USD de receita bruta anual que também tenham recebido menos de 10.000.000 USD de capital externo, e que não sejam entidades governamentais, quase governamentais ou de ensino superior. Acima dessa linha, os [níveis publicados](https://automapper.io/) são Standard a 799 USD por ano para 1 a 10 desenvolvedores, Professional a 1.499 USD por ano para 11 a 50, e Enterprise a 6.399 USD por ano para desenvolvedores ilimitados. Contam apenas os desenvolvedores que escrevem ou mantêm ativamente código que chama a biblioteca, o que exclui QA, design e trabalho de front-end.

A aplicação da licença é deliberadamente branda. Não há servidor de licenças, nem chamada de rede, nem bloqueio de recursos. Uma chave ausente ou expirada produz uma mensagem de log e nada mais, e desde a 16.2.0 a chave também pode vir das variáveis de ambiente `AUTOMAPPER_LICENSE_KEY` ou `LUCKYPENNY_LICENSE_KEY` em vez de `cfg.LicenseKey`. Mas aplicação branda não é o mesmo que permissão, e "não notamos um aviso nos logs" não é uma posição de licenciamento que alguém queira defender em uma revisão de compras.

É a mesma bifurcação das bibliotecas de mediator, e o raciocínio se transfere diretamente: veja [MediatR vs classes de serviço simples em 2026](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/) para o detalhamento completo do nível Community e das obrigações da RPL-1.5.

## Quando escolher Mapperly

- **Qualquer coisa que seja publicada com trimming ou Native AOT.** Isso não é preferência, é uma barreira rígida. Veja a seção de AOT abaixo.
- **Serverless e processos de vida curta.** Mapperly não custa nada na inicialização porque não há um objeto de configuração a construir.
- **Bases de código onde o desvio dos DTOs é um risco real.** Uma coluna nova na entidade que ninguém adicionou ao DTO produz `RMG020` em tempo de compilação. O AutoMapper não vai mencionar isso de jeito nenhum.
- **Times que querem ler o mapeamento.** Mapperly escreve um arquivo `.g.cs` que você pode abrir, comparar e percorrer no depurador.

## Quando escolher o mapeamento escrito à mão

- **Superfície pequena.** Abaixo de cerca de vinte mapas, um método estático `ToDto` por tipo é menos maquinaria do que um gerador mais o vocabulário de atributos dele, e nunca surpreende ninguém.
- **Formatos que realmente diferem.** Quando a maioria dos membros precisa de `MapFrom`, `IValueResolver` ou lógica condicional, as duas bibliotecas degeneram em uma forma pior de escrever o método que você ia escrever de qualquer jeito.
- **Contratos de API pública.** DTOs que são um formato de rede versionado merecem um mapeamento explícito e revisável em que cada atribuição de campo aparece no diff.
- **Qualquer camada em que você queira zero dependências de compilação.** Mapperly é um gerador de código-fonte, então participa do seu build; um método estático não.

## Quando ficar com o AutoMapper

- **Uma base de código grande com EF Core construída sobre `ProjectTo`.** As extensões queryable do AutoMapper suportam expansão explícita, parametrização em runtime via objetos anônimos, `RecursiveQueriesMaxDepth` para modelos autorreferenciais e mapeamento polimórfico. As projeções do Mapperly cobrem o caso comum, mas explicitamente não suportam object factories, estratégias de enum `ByName`, tratamento de referências nem clonagem profunda, e vão reportar `RMG068` quando não conseguirem fazer inline de um método definido pelo usuário.
- **Você está abaixo do limite Community e os mapas já funcionam.** Reescrever 200 mapas que funcionam para economizar 45 ns por chamada não é um caso de negócio.
- **Mapeamento dinâmico e sem tipos.** `mapper.Map(source, sourceType, destType)` não tem equivalente gerado em tempo de compilação. Se você tem um sistema de plugins que descobre tipos em runtime, o AutoMapper está fazendo algo que o Mapperly estruturalmente não consegue.

Se você decidir sair, a mecânica está coberta passo a passo em [migrar do AutoMapper para mapeamento gerado com Mapperly](/pt-br/2026/05/migrate-from-automapper-to-source-generated-mapping/).

## O benchmark

O modelo é um `Order` com cinco membros escalares, um `Customer` aninhado, cinco filhos `OrderLine` e um enum mapeado para o nome em texto. `[MemoryDiagnoser]`, job padrão, e a compilação de expressões do AutoMapper aquecida no `[GlobalSetup]` para que a medição seja vazão em estado estável e não o custo da primeira chamada.

```csharp
// .NET SDK 10.0.302, net10.0, C# 14
// AutoMapper 16.2.0, Riok.Mapperly 4.3.1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
public class MappingBenchmarks
{
    private Order _order = null!;
    private List<Order> _orders = null!;
    private IMapper _autoMapper = null!;
    private OrderMapper _mapperly = null!;

    [GlobalSetup]
    public void Setup()
    {
        _order = MakeOrder(1);
        _orders = Enumerable.Range(1, 1000).Select(MakeOrder).ToList();

        var config = new MapperConfiguration(
            cfg => cfg.AddProfile<OrderProfile>(),
            NullLoggerFactory.Instance);
        _autoMapper = config.CreateMapper();
        _mapperly = new OrderMapper();

        _autoMapper.Map<OrderDto>(_order); // warm the expression compilation
    }

    [Benchmark(Baseline = true)]
    public OrderDto HandWritten_Single() => HandMapper.ToDto(_order);

    [Benchmark]
    public OrderDto Mapperly_Single() => _mapperly.ToDto(_order);

    [Benchmark]
    public OrderDto AutoMapper_Single() => _autoMapper.Map<OrderDto>(_order);
}
```

Resultados em um Apple M4, 10 núcleos físicos, .NET 10.0.10 Arm64 RyuJIT:

| Método | Média | Ratio | Alocado | Ratio de alocação |
| --- | ---: | ---: | ---: | ---: |
| HandWritten_Single | 58.48 ns | 1.00 | 624 B | 1.00 |
| Mapperly_Single | 60.44 ns | 1.03 | 624 B | 1.00 |
| AutoMapper_Single | 105.79 ns | 1.81 | 704 B | 1.13 |
| HandWritten_1000 | 72,696 ns | 1.00 | 632,091 B | 1.00 |
| Mapperly_1000 | 77,334 ns | 1.06 | 672,093 B | 1.06 |
| AutoMapper_1000 | 103,376 ns | 1.42 | 720,640 B | 1.14 |

Leia isso com honestidade: 45 nanossegundos por objeto não é o motivo pelo qual você deveria mudar. Em uma requisição que mapeia 1.000 pedidos toda a diferença são 31 microssegundos, que não vão aparecer ao lado de uma única ida ao banco de dados. O argumento de desempenho só pesa de verdade com contagens de objetos muito altas, e é o mais fraco dos três motivos para preferir Mapperly.

A diferença de 40.000 bytes entre Mapperly e o mapeamento escrito à mão no caso de 1.000 objetos é um artefato real que vale a pena entender. O Mapperly alarga o parâmetro de um mapeador de coleção aninhada gerado para `IReadOnlyCollection<T>`:

```csharp
// Riok.Mapperly 4.3.1 generated output, trimmed
private List<OrderLineDto> MapToListOfOrderLineDto(IReadOnlyCollection<OrderLine> source)
{
    var target = new List<OrderLineDto>(source.Count);
    foreach (var item in source)
        target.Add(MapToOrderLineDto(item));
    return target;
}
```

Enumerar uma `List<T>` através de uma interface faz boxing do enumerador struct: 40 bytes por pedido, 40.000 bytes no lote inteiro. Declarar você mesmo o mapeador da coleção aninhada com um parâmetro concreto `List<OrderLine>` elimina isso. Esse é exatamente o tipo de coisa que você consegue encontrar e corrigir porque o código gerado está em disco, que é a diferença prática entre um gerador de código-fonte e uma árvore de expressão compilada.

## O detalhe que decide por você: Native AOT

Publique uma aplicação de console que chama o AutoMapper 16.2.0 com `<PublishAot>true</PublishAot>` em `net10.0` e o build avisa:

```text
AutoMapper.dll : warning IL2104: Assembly 'AutoMapper' produced trim warnings.
AutoMapper.dll : warning IL3053: Assembly 'AutoMapper' produced AOT analysis warnings.
```

Avisos são fáceis de ignorar. O binário resultante não é:

```text
Unhandled exception. System.TypeInitializationException: A type initializer threw an exception.
 ---> System.ArgumentNullException: Value cannot be null. (Parameter 'method')
   at System.Linq.Expressions.Expression.Call(MethodInfo, Expression)
   at AutoMapper.Execution.ExpressionBuilder..cctor()
   at AutoMapper.MapperConfiguration..ctor(MapperConfigurationExpression, ILoggerFactory)
```

O trimmer removeu um método que o `ExpressionBuilder` procura por reflexão, então o construtor estático morre antes do seu primeiro mapeamento. A aplicação equivalente com Mapperly publicada com as mesmas configurações emite zero avisos IL, produz um binário nativo de 1.1 MB e funciona. Isso não é um problema de ajuste que você resolva com atributos `DynamicDependency` no ponto da chamada; é uma propriedade de construir mapas a partir de árvores de expressão em runtime, que é a mesma armadilha descrita em [o que é código trim-safe e como escrevê-lo](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/). Se Native AOT está no seu roteiro, a decisão já está tomada.

A versão mais branda do mesmo efeito é a inicialização a frio. Construir a configuração e executar o primeiro mapeamento para três tipos levou 33 milissegundos nesta máquina, contra 1 milissegundo para `new OrderMapper()` mais a primeira chamada. Em uma aplicação web de vida longa isso é invisível. Em uma Lambda é uma fatia mensurável de uma invocação a frio, que é por isso que aparece em [reduzir o tempo de inicialização a frio de uma Lambda AWS com .NET](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Onde a diferença de segurança realmente aparece

Adicione uma propriedade `Slug` a um DTO e esqueça de mapeá-la. O AutoMapper 16.2.0 mapeia o objeto mesmo assim:

```text
map ok: Id=1 Name=n Slug=''
```

`AssertConfigurationIsValid()` detecta sim, lançando `AutoMapperConfigurationException` com "Unmapped members were found", mas só se você lembrou de chamá-lo, e só para membros de *destino* não mapeados. Uma propriedade de origem que não chega mais a nenhum DTO não é reportada de jeito nenhum.

O Mapperly reporta as duas direções em tempo de compilação, com o texto real da mensagem:

```text
warning RMG020: The member InternalNote on the mapping source type Diag.Source
                is not mapped to any member on the mapping target type Diag.Target
warning RMG012: The member Slug on the mapping target type Diag.Target
                was not found on the mapping source type Diag.Source
```

Por padrão são avisos, o que significa que vão se afogar em um build barulhento. Escale-os no `.editorconfig` e o build falha de vez:

```ini
[*.cs]
dotnet_diagnostic.RMG012.severity = error
dotnet_diagnostic.RMG020.severity = error
```

Essa é a configuração que transforma o Mapperly de "um AutoMapper mais rápido" em uma categoria diferente de ferramenta: bugs de mapeamento deixam de ser incidentes em produção e viram falhas de build. É também a ilustração mais clara de por que os [geradores de código-fonte](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) valem a dependência em tempo de compilação.

O mapeamento escrito à mão, que fique registrado, não oferece essa verificação. Uma atribuição esquecida em um método `ToDto` é exatamente tão silenciosa quanto no AutoMapper. A segurança dele vem de ser visível na revisão de código, não de ferramentas.

## A decisão

Use Mapperly por padrão em código novo, e escale `RMG012` e `RMG020` para erros no primeiro dia para de fato colher o benefício. Escreva o mapeamento à mão quando o projeto é pequeno ou os formatos são irregulares, e aceite que você está trocando verificações de ferramentas por revisabilidade. Fique com o AutoMapper quando uma base de código madura e carregada de `ProjectTo` já funciona, você está abaixo do limite Community e Native AOT não está no roteiro; e se qualquer uma dessas três coisas deixar de ser verdade, comece a migração em vez de orçar a licença. A tabela de desempenho é a parte menos interessante desta comparação. Segurança sob trimming e diagnósticos em tempo de compilação são o que realmente muda como uma base de código se comporta.

## Relacionado

- [Migrar do AutoMapper para mapeamento gerado com Mapperly](/pt-br/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [Solução: 'MapperConfiguration' não contém um construtor que aceite 1 argumentos](/pt-br/2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments/)
- [MediatR vs classes de serviço simples em 2026](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [O que é um gerador de código-fonte e quando eu preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [O que é Native AOT e quanto ele custa para você?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)

## Fontes

- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - o limite na 15.0.0, os limiares Community de 5.000.000 USD de receita e 10.000.000 USD de capital, e como os desenvolvedores são contados.
- [AutoMapper LICENSE.md](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) - o texto da licença dupla RPL-1.5 ou comercial.
- [Documentação de configuração de licença do AutoMapper](https://docs.automapper.io/en/latest/License-configuration.html) - a descoberta de `AUTOMAPPER_LICENSE_KEY` e `LUCKYPENNY_LICENSE_KEY`, e o modelo de aplicação somente por logs.
- [AutoMapper Queryable Extensions](https://docs.automapper.io/en/latest/Queryable-Extensions.html) - expansão explícita do `ProjectTo`, parametrização e a restrição de "precisa ser a última chamada da cadeia".
- [Projeções queryable do Mapperly](https://mapperly.riok.app/docs/configuration/queryable-projections/) - a lista de recursos não suportados e o diagnóstico de inlining `RMG068`.
- [Diagnósticos do analisador do Mapperly](https://mapperly.riok.app/docs/configuration/analyzer-diagnostics/) - `RMG012`, `RMG020` e a escalada de severidade no `.editorconfig`.
- [Riok.Mapperly no NuGet](https://www.nuget.org/packages/Riok.Mapperly) - data de lançamento da 4.3.1 e licença Apache 2.0.
- [AutoMapper no NuGet](https://www.nuget.org/packages/AutoMapper) - data de lançamento da 16.2.0 e histórico de versões.
