---
title: "Migrar do AutoMapper para mapeamento gerado por codigo-fonte com Mapperly"
description: "Um checklist passo a passo para substituir os Profiles, IMapper, ForMember e ProjectTo do AutoMapper 15 por mappers gerados por codigo-fonte com Riok.Mapperly 4.3 no .NET 11."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/migrate-from-automapper-to-source-generated-mapping"
translatedBy: "claude"
translationDate: 2026-05-30
---

Substituir o AutoMapper por um gerador de código-fonte é uma refatoração mecânica, arquivo por arquivo, não uma reescrita. Para um serviço típico com 30-80 mapeamentos espalhados por algumas classes `Profile`, reserve de meio dia a um dia: cada `CreateMap<Source, Dest>()` vira um método `partial` em uma classe `[Mapper]`, as chamadas a `IMapper.Map<T>` viram chamadas diretas a métodos, e `ProjectTo<T>()` vira uma extensão `IQueryable` gerada. O que quebra é tudo que dependia da flexibilidade em runtime do AutoMapper: as chamadas dinâmicas `Map(object)`, os `IValueResolver` com serviços injetados, e o registro por varredura de assemblies. Vale a pena fazer se você está acima do limite de receita de US$ 5.000.000 do AutoMapper e não quer comprar uma licença, se você quer que Native AOT e trimming funcionem, ou se você quer que propriedades não mapeadas falhem a compilação em vez de serem descartadas silenciosamente em runtime.

Versões referenciadas: este guia cobre sair do AutoMapper 14.x (a última versão MIT) e 15.0 (a primeira versão com licença dupla Reciprocal Public License 1.5 / comercial da Lucky Penny Software). A substituição tem como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11, C# 14 e Riok.Mapperly 4.3.1 (lançada em 2025-12-22). Se você ainda está decidindo se vai sair, é a mesma história de fornecedor do MediatR, então leia [migrar do MediatR para injeção de dependência simples](/pt-br/2026/05/migrate-from-mediatr-to-plain-dependency-injection/) para o caso paralelo; este artigo assume que a decisão já foi tomada.

## Por que as equipes estão saindo do AutoMapper justamente agora

- **A licença força uma decisão acima de US$ 5 milhões.** O AutoMapper 15.0 é lançado sob a licença copyleft recíproca RPL-1.5 mais um nível comercial pago. O uso gratuito cobre empresas abaixo de US$ 5.000.000 de receita bruta anual e ambientes que não são de produção. Acima desse limite, software comercial de código fechado não pode usar a versão RPL, então é comprar ou sair. Tudo publicado sob MIT (14.x e anteriores) continua utilizável sob MIT para sempre, mas você deixa de receber correções.
- **Os erros de mapeamento passam de runtime para tempo de compilação.** O AutoMapper valida a configuração apenas quando você chama `AssertConfigurationIsValid()` ou atinge o mapeamento em runtime. O Mapperly reporta uma propriedade não mapeada como um diagnóstico `RMG` em tempo de compilação, então um campo esquecido é um aviso de compilação, não uma `NullReferenceException` em produção.
- **A inicialização fica mais barata e o AOT fica mais fácil.** O AutoMapper constrói e compila expressões de mapeamento no primeiro uso via reflexão. O Mapperly emite C# puro em tempo de compilação, então não há custo de inicialização nem reflexão brigando com o trimmer, o que importa ao [reduzir o tempo de inicialização a frio de uma AWS Lambda no .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) ou ao enviar [Native AOT](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Você consegue ler o código gerado.** O Mapperly escreve um corpo de método parcial legível, no qual você pode entrar com o depurador, em vez de uma árvore de expressão compilada e opaca.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| Injeção de `IMapper` | Substituída pela classe mapper gerada concreta, injetada diretamente | alta |
| `Profile` + `CreateMap<,>()` | Colapsam em uma classe parcial `[Mapper]` com um método `partial` por direção | alta |
| `ForMember(... MapFrom ...)` | Substituído por `[MapProperty]` ou um método de mapeamento privado | alta |
| `ReverseMap()` | Não há reverso automático; você declara o método da direção de retorno explicitamente | média |
| `IValueResolver` / `ITypeConverter` com DI | Substituídos por um construtor no mapper mais um método privado | média |
| `ProjectTo<T>(config)` | Substituído por uma extensão de projeção `IQueryable<T>` gerada | média |
| Varredura `AddAutoMapper(assembly)` | Substituída por registro explícito `AddSingleton<TMapper>()` | média |
| `mapper.Map(object, type)` (dinâmico) | Não há ponto de entrada sem tipo em runtime; cada mapeamento é um método tipado | alta |
| Teste `AssertConfigurationIsValid()` | Redundante; a compilação é a asserção | baixa |

## Checklist de pré-voo

1. **Instale o SDK do .NET 11** e confirme que `dotnet --version` reporta `11.0.x`.
2. **Inventarie seus mapeamentos.** Rode um grep de `CreateMap<` para contar as configurações e de `\.Map<` e `ProjectTo<` para contar os pontos de chamada. Esse é o escopo da sua migração.
3. **Encontre os mapeamentos dinâmicos.** Faça grep das chamadas `Map(` que passam um argumento `Type` ou uma origem `object`. Essas não têm equivalente direto no Mapperly e precisam de um método tipado ou um switch manual; trate delas primeiro.
4. **Encontre os resolvers.** Faça grep de `IValueResolver`, `ITypeConverter` e `IMappingAction`. Cada um precisa de um método privado no mapper.
5. **Não precisa de backup especial, crie a branch normalmente.** Esta mudança é reversível arquivo por arquivo (veja Plano de rollback), então uma branch de funcionalidade basta.

## Passos da migração

### 1. Adicione o Mapperly junto ao AutoMapper

Instale os dois pacotes para poder migrar um profile por vez:

```bash
# .NET 11 SDK, run from the project directory
dotnet add package Riok.Mapperly --version 4.3.1
```

O Mapperly entrega apenas um analisador e os atributos de `Riok.Mapperly.Abstractions`, então não adiciona nenhuma dependência em runtime. Verifique que a compilação continua funcionando: `dotnet build` sem erros novos. Deixe o pacote do AutoMapper referenciado até o último profile desaparecer.

### 2. Converta um profile simples para uma classe `[Mapper]`

Pegue o profile menor primeiro. O antes:

```csharp
// AutoMapper 15.0
public class CarProfile : Profile
{
    public CarProfile()
    {
        CreateMap<Car, CarDto>();
    }
}
```

O depois é uma classe parcial com um método parcial. O Mapperly preenche o corpo:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
using Riok.Mapperly.Abstractions;

[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
}
```

Verifique: compile o projeto e abra o arquivo gerado (ele aparece na saída do analisador, ou defina `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` no `.csproj` para gravá-lo em disco). Confirme que cada propriedade de `CarDto` é atribuída. Se alguma não for, o Mapperly emite um diagnóstico como `RMG020` para um membro de destino não mapeado; isso é o recurso, não uma falha.

### 3. Traduza `ForMember` para `[MapProperty]`

A personalização por membro do AutoMapper mapeia para atributos do Mapperly. Um renome:

```csharp
// AutoMapper 15.0
CreateMap<Car, CarDto>()
    .ForMember(d => d.ModelName, o => o.MapFrom(s => s.Model));
```

vira um atributo `[MapProperty]` que nomeia os membros de origem e destino:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[MapProperty(nameof(Car.Model), nameof(CarDto.ModelName))]
public partial CarDto ToDto(Car car);
```

Para um valor calculado, a lambda `MapFrom` em linha do AutoMapper vira um método de mapeamento privado referenciado por `Use`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => price.ToString("C");
}
```

Para descartar uma propriedade deliberadamente, substitua o `Ignore()` do AutoMapper por `[MapperIgnoreTarget(nameof(CarDto.Internal))]` ou `[MapperIgnoreSource(nameof(Car.Secret))]`. Verifique cada conversão checando que o corpo gerado atribui exatamente os membros que você espera.

### 4. Substitua `ReverseMap()` por um método explícito

O `ReverseMap()` do AutoMapper é uma única chamada. O Mapperly não tem reverso automático, então declare a direção de retorno como seu próprio método no mesmo mapper:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
    public partial Car ToEntity(CarDto dto);
}
```

É mais código, mas é honesto: o mapeamento inverso não é mais implícito, então uma propriedade assimétrica (um campo de destino sem origem) aparece como seu próprio diagnóstico em vez de ser ignorada silenciosamente. Verifique os dois corpos gerados.

### 5. Mova os resolvers com dependências para o construtor do mapper

Um `IValueResolver` do AutoMapper que precisa de um serviço injetado:

```csharp
// AutoMapper 15.0
public class PriceResolver : IValueResolver<Car, CarDto, string>
{
    private readonly ICurrencyService _currency;
    public PriceResolver(ICurrencyService currency) => _currency = currency;
    public string Resolve(Car s, CarDto d, string m, ResolutionContext ctx)
        => _currency.Format(s.Price);
}
```

vira um construtor no mapper mais um método privado. O Mapperly gera um construtor que repassa os parâmetros que você declara, então o mapper participa da injeção de construtor normal:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    private readonly ICurrencyService _currency;
    public CarMapper(ICurrencyService currency) => _currency = currency;

    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => _currency.Format(price);
}
```

Verifique resolvendo o mapper a partir do contêiner em um teste e checando o preço formatado.

### 6. Converta `ProjectTo<T>` para uma projeção gerada

O `ProjectTo<T>()` do AutoMapper constrói uma árvore de `Expression` para que o EF Core possa traduzir o mapeamento em SQL. O Mapperly gera o mesmo tipo de extensão `IQueryable` quando você declara um método que recebe e retorna `IQueryable<T>`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public static partial class CarQueryMapper
{
    public static partial IQueryable<CarDto> ProjectToDto(this IQueryable<Car> q);
}
```

O ponto de chamada muda de `.ProjectTo<CarDto>(_config)` para `.ProjectToDto()`:

```csharp
// .NET 11, EF Core 11
var dtos = await db.Cars
    .Where(c => c.NumberOfSeats > 4)
    .ProjectToDto()
    .ToListAsync();
```

Verifique capturando o SQL gerado (`db.Cars...ToQueryString()` ou o logging do EF Core) e confirmando que a projeção roda no banco de dados, não em memória. Note que o caminho de projeção do Mapperly não executa object factories nem métodos personalizados de criação de objetos, porque ele precisa produzir uma árvore de expressão traduzível.

### 7. Substitua o registro de DI

Apague o registro do AutoMapper e a varredura de assemblies:

```csharp
// AutoMapper 15.0 - remove this
builder.Services.AddAutoMapper(typeof(CarProfile).Assembly);
```

Registre cada mapper explicitamente. Um mapper sem dependências injetadas não tem estado e é seguro para threads, então registre-o como singleton; um com uma dependência scoped precisa coincidir com esse ciclo de vida:

```csharp
// .NET 11
builder.Services.AddSingleton<CarMapper>();        // no dependencies
builder.Services.AddScoped<InvoiceMapper>();       // depends on a scoped service
```

Depois mude os consumidores de `IMapper` para o mapper concreto. `_mapper.Map<CarDto>(car)` vira `_carMapper.ToDto(car)`. Mappers estáticos não precisam de registro algum; chame `CarQueryMapper.ProjectToDto(query)` diretamente. Verifique que a aplicação inicializa: um registro faltante é agora uma `InvalidOperationException` de inicialização, que é exatamente a falha precoce que você quer.

### 8. Remova o AutoMapper

Quando o grep de `using AutoMapper` e `CreateMap<` não retornar nada, remova o pacote:

```bash
dotnet remove package AutoMapper
```

Verifique com um `dotnet build` limpo e uma execução completa de `dotnet test`.

## Verificação

Rode este checklist depois que o último profile desaparecer:

- `dotnet build` produz zero erros e você revisou cada diagnóstico `RMG`, tratando os avisos de membro não mapeado como intencionais ou corrigindo-os.
- `dotnet test` passa com zero falhas, incluindo qualquer teste que antes chamava `AssertConfigurationIsValid()` (apague-os; a compilação é agora a asserção).
- As consultas de projeção continuam sendo traduzidas para SQL: confirme com `ToQueryString()` que nenhum `ProjectToDto()` cai em avaliação do lado do cliente.
- Para uma compilação AOT ou com trimming, `dotnet publish -c Release` não produz avisos de trim `IL2xxx` que antes vinham da reflexão do AutoMapper.
- Uma carga de trabalho sensível à inicialização a frio inicializa de forma mensuravelmente mais rápida; o primeiro mapeamento não paga mais o custo de compilação de expressões.

## Plano de rollback

Esta migração é reversível arquivo por arquivo, o que é sua principal propriedade de segurança. Como você manteve o AutoMapper referenciado durante o passo 7, qualquer mapper individual que se comporte mal pode ser revertido restaurando seu `Profile` e reapontando aquele único consumidor de volta para `IMapper`; os dois sistemas coexistem sem conflito. O único momento sem volta é o passo 8, remover o pacote. Não apague o AutoMapper até que cada consumidor esteja convertido e toda a suíte de testes esteja verde. Se você está nervoso, envie as conversões de mappers em uma versão e a remoção do pacote na seguinte.

## Tropeços que tivemos

- **`RMG020` em propriedades que você de fato queria descartar.** O Mapperly avisa quando um membro de origem não mapeia para nada. Silencie-o deliberadamente com `[MapperIgnoreSource(...)]` em vez de suprimir o diagnóstico globalmente, para que o próximo descarte não intencional continue avisando.
- **O achatamento não é automático como você espera.** O AutoMapper achata `Order.Customer.Name` em `OrderDto.CustomerName` por convenção de nomes. O Mapperly suporta o achatamento de membros aninhados, mas se o nome do seu DTO não coincide com o caminho de origem com pontos, você precisa soletrá-lo com `[MapProperty([nameof(Order.Customer), nameof(Customer.Name)], nameof(OrderDto.CustomerName))]`.
- **Não há `Map(object, Type)` sem tipo.** Se você tinha um pipeline genérico que mapeava `object` para um `Type` em runtime, não há equivalente gerado por código-fonte. Substitua-o por um método tipado por par, ou mantenha um pequeno switch escrito à mão. Este é o único lugar onde uma troca limpa é impossível.
- **Destinos `record` com `init` e construtor primário.** O Mapperly mapeia através do construtor quando um destino é um `record` ou só tem setters `init`, que costuma ser o que você quer; se ele escolher o construtor errado, desambigue com `[MapperConstructor]`. O comportamento do AutoMapper aqui era mais frouxo, então um mapeamento que antes funcionava pode revelar uma ambiguidade real. Para conhecer as formas de destino, veja [record vs class vs struct em C#](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).
- **O mapeamento de enums é mais rígido por nome.** O Mapperly mapeia enums por valor por padrão e pode avisar sobre membros de enum não mapeados, onde o AutoMapper passava o inteiro silenciosamente. Decida explicitamente entre por valor e por nome com a estratégia `[MapEnum]`.

Se você quer entender como o gerador faz isso em tempo de compilação antes de confiar nele em produção, a mecânica é a mesma coberta em [como escrever um gerador de código-fonte para INotifyPropertyChanged](/pt-br/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/).

## Fontes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/), Jimmy Bogard
- [AutoMapper and MediatR Licensing Update](https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/), Jimmy Bogard
- [Documentação do Mapperly: configuração e projeções queryable](https://mapperly.riok.app/docs/configuration/mapper/)
- [riok/mapperly no GitHub](https://github.com/riok/mapperly) e [Riok.Mapperly 4.3.1 no NuGet](https://www.nuget.org/packages/Riok.Mapperly)
