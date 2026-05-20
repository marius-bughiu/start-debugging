---
title: "record vs class vs struct em C#: uma matriz de decisão"
description: "C# 14 oferece quatro formas de tipo de dados -- class, record class, struct e record struct. Esta é a matriz de decisão: quando cada uma é correta, o que cada uma custa, e as regras que decidem por você."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "csharp"
  - "records"
  - "structs"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix"
translatedBy: "claude"
translationDate: 2026-05-20
---

Se você está escolhendo entre `class`, `record` e `struct` para um novo tipo em C# 14 / .NET 10, o padrão é `class`. Recorra a `record class` (o `record` padrão) quando o tipo for dados imutáveis e a igualdade por valor for o contrato. Recorra a `readonly record struct` quando o tipo for pequeno (16 bytes ou menos), imutável, e copiado através de caminhos quentes onde uma alocação no heap por instância doeria. Use uma `struct` simples apenas para interoperabilidade não gerenciada ou quando você genuinamente precisa mutar um tipo de valor de tamanho fixo no local. Use um `record` simples (que é `record class`) quando quer imutabilidade e igualdade por valor sem brigar com o GC.

Este post é a versão longa. Todos os exemplos visam `<TargetFramework>net10.0</TargetFramework>` com `<LangVersion>14.0</LangVersion>`.

## As quatro formas que você realmente tem

C# tem dois tipos de armazenamento (tipo de referência, tipo de valor) e um modificador `record` ortogonal que adiciona igualdade por valor, um construtor primário, suporte a expressão `with`, e um `ToString` gerado pelo compilador. Isso dá quatro formas:

- `class`: tipo de referência, igualdade por referência por padrão.
- `record class` (a palavra-chave simples `record`): tipo de referência, igualdade por valor.
- `struct`: tipo de valor, igualdade por valor campo a campo (via `ValueType.Equals` com reflexão) -- lento a menos que você sobrescreva.
- `record struct`: tipo de valor, igualdade por valor (gerada pelo compilador, sem reflexão).

`readonly record struct` é a forma de struct mais comum que você realmente escreverá. Marca cada campo como `readonly` e torna a instância inteira imutável, que é o que você quer 90 por cento das vezes que recorre a uma struct.

## Matriz de recursos

| Recurso                                     | `class`             | `record class`         | `struct`             | `record struct`           |
| ------------------------------------------ | ------------------- | ---------------------- | -------------------- | ------------------------- |
| Armazenamento                               | heap                | heap                   | inline / pilha       | inline / pilha            |
| Igualdade padrão                            | referência          | valor (gerada pelo compilador) | valor (reflexão) | valor (gerada pelo compilador) |
| Expressão `with`                            | não                 | sim                    | não                  | sim                       |
| `ToString` gerado pelo compilador           | não                 | sim                    | não                  | sim                       |
| Herança                                     | sim                 | sim (somente entre records) | não             | não                       |
| Mutabilidade padrão                         | mutável             | init-only (imutável)   | mutável              | mutável; `readonly record struct` é imutável |
| Faz boxing ao converter para `object` / interface | não           | não                    | sim                  | sim                       |
| Custo de cópia                              | cópia de ponteiro   | cópia de ponteiro      | cópia bit a bit completa | cópia bit a bit completa |
| `null` permitido (NRT desativado)           | sim                 | sim                    | não (use `T?`)       | não (use `T?`)            |
| Aloca no heap                               | cada instância      | cada instância         | só quando há boxing  | só quando há boxing       |
| Boa como chave de dicionário                | só se você implementar `Equals`/`GetHashCode` | sim, de fábrica | não -- igualdade por reflexão é lenta | sim, de fábrica |
| Boa como entidade do EF Core                | sim                 | sim (com cuidado)      | não                  | não                       |

A tabela é o post. Tudo abaixo é o porquê.

## Por que `class` é o padrão

Uma `class` é alocada no heap gerenciado, acessada por referência, e igual a outra instância apenas quando ambas referências apontam para o mesmo objeto. A semântica de referência é o ajuste natural para coisas que têm uma identidade: um `User`, um `Customer`, um `HttpClient`. Dois objetos `User` com o mesmo nome e e-mail não são o mesmo usuário; são dois registros que por acaso compartilham dados. A igualdade por referência combina com esse modelo mental.

`class` também é a única forma que suporta herança com tipos derivados arbitrários. `record` também suporta herança, mas apenas entre outros records. `struct` e `record struct` não suportam nenhuma.

Escolha `class` quando:

- O tipo tem identidade ("este é *o* cliente, não um valor com forma de cliente").
- O tipo é mutável por design.
- O tipo participa de uma hierarquia de classes com classes base que não são records.
- O tipo é uma entidade do EF Core que precisa de rastreamento de mudanças. EF Core 11 suporta records como entidades, mas o caminho de menor resistência ainda é uma `class` com propriedades init-only e um construtor de binding. Veja [como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/) para a decisão assento por assento.

```csharp
// .NET 10, C# 14
public class Customer
{
    public Guid Id { get; init; }
    public string Email { get; set; } = "";
    public DateTimeOffset CreatedAt { get; init; }
}
```

Este é o assento que possui uma linha no banco de dados e tem permissão para mudar ao longo do tempo.

## Quando recorrer a `record class`

Um `record` (que é `record class` -- a palavra-chave `class` está implícita) é a resposta certa para portadores de dados imutáveis onde duas instâncias com os mesmos valores de campo devem ser tratadas como iguais. O compilador gera um `Equals`, `GetHashCode`, `ToString` baseados em valor, e um método virtual `EqualityContract` que faz a herança funcionar. A sintaxe posicional `public record Address(string City, string Zip);` adiciona um construtor primário e uma propriedade init-only por parâmetro.

Escolha `record class` quando:

- O tipo é um DTO, uma forma de requisição/resposta, um evento de domínio, ou um snapshot de configuração.
- Você usará o tipo como chave de dicionário ou em um `HashSet<T>` e a igualdade por valor é o contrato.
- Você produzirá frequentemente uma cópia modificada: `var newer = original with { Status = "shipped" };`.
- Você quer que o compilador escreva `ToString` por você para que logs estruturados mostrem cada campo por padrão.

Uma record class ainda é alocada no heap e acessada por referência, então toda a intuição de "isto é barato de passar" sobre `class` ainda se aplica. Você paga uma alocação por instância, mas não paga uma cópia bit a bit cada vez que a passa para um método.

```csharp
// .NET 10, C# 14
public sealed record OrderPlaced(Guid OrderId, decimal Total, DateTimeOffset At);

var evt = new OrderPlaced(orderId, 42.50m, DateTimeOffset.UtcNow);
var corrected = evt with { Total = 42.95m };

// evt != corrected
// Console.WriteLine(evt) prints OrderPlaced { OrderId = ..., Total = 42.50, At = ... }
```

Dois avisos. Primeiro, declare records como `sealed` a menos que você realmente precise de uma hierarquia de records. O compilador emite uma indireção `EqualityContract` em cada record para que records derivados possam participar da igualdade por valor, e `sealed` permite ao JIT desvirtualizar as chamadas. Segundo, não coloque propriedades de coleção mutáveis em um record. A igualdade por valor de `record` compara referências para essas propriedades, não conteúdo, o que leva a surpresas do tipo "por que esses dois records não são iguais". Use `ImmutableArray<T>` ou `IReadOnlyList<T>` inicializado uma vez.

## Quando recorrer a `struct` (e especialmente `readonly record struct`)

Uma `struct` é um tipo de valor. Seus campos vivem inline em qualquer coisa que a contenha: na pilha para variáveis locais, dentro do objeto contêiner no heap para campos, empacotados de ponta a ponta em arrays. Cada atribuição é uma cópia bit a bit da struct inteira. A igualdade, quando você fornece, pode ser uma única comparação de CPU em vez de uma chamada virtual.

Isso é fantástico quando os dados são pequenos e você tem muitos. Uma struct de dois campos `int` pode ser mantida em um par de registradores, comparada com um branch, e armazenada em um array como 8 bytes por elemento sem cabeçalho por elemento. O mesmo payload como uma `class` seria um cabeçalho de objeto de 24 bytes mais uma referência de 8 bytes por slot, o que destrói a localidade de cache assim que o array é maior que a linha L1.

A orientação da Microsoft [choose between class and struct](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct) lista quatro condições para uma struct: representa logicamente um único valor, tem um tamanho de instância abaixo de 16 bytes, é imutável, e não sofre boxing com frequência. Todas as quatro juntas, não três de quatro.

Escolha `readonly record struct` (ou `readonly struct` se você não precisa de igualdade por valor) quando:

- O tipo é um valor pequeno e imutável: uma coordenada, um valor monetário, um ID fortemente tipado, um timestamp de precisão fixa.
- Você manterá muitos em um array ou `Span<T>` e iterará quente.
- Você não fará boxing neles. Converter para `object` ou para uma interface não-readonly faz boxing; converter para uma interface `ref struct` em C# 13+ não (quando o JIT consegue provar).
- Você não precisa de herança.

```csharp
// .NET 10, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0m, currency);
    public Money Plus(Money other) =>
        other.Currency == Currency
            ? new(Amount + other.Amount, Currency)
            : throw new InvalidOperationException("currency mismatch");
}
```

Isso compila para um tipo de valor com igualdade por valor integrada, um deconstructor, uma sobrescrita de `ToString`, e semântica imutável. É a substituição moderna para "vou escrever uma `struct` e lembrar de não torná-la mutável".

A regra dos 16 bytes é uma heurística, não um limite rígido. O JIT passará felizmente uma struct de 24 bytes em registradores em AMD64 se ela couber na convenção de chamada. A razão para manter structs pequenas são as cópias bit a bit. Cada atribuição, cada passagem de parâmetro sem `in`, cada passo do `LINQ` copia tudo. Uma struct de 64 bytes passada por valor através de cinco frames de método são 320 bytes de cópia.

## Quando `record struct` (mutável) é a escolha certa

`record struct` simples (sem `readonly`) é raro mas legítimo. Dá igualdade por valor, um construtor primário e um `ToString`, enquanto ainda permite que campos sejam reatribuídos. Dois cenários fazem sentido:

- Acumuladores de loop quente onde você quer igualdade e `ToString` gerados pelo compilador mas também quer mutar campos no local para evitar agitação de cópia: `state.Count++; state.Total += x;` em uma `record struct State` que vive em uma única local.
- Formas de interoperabilidade onde você quer semântica de valor e a capacidade de preencher a struct campo a campo após a construção.

Para tudo o mais, prefira `readonly record struct`. Uma struct mutável é uma famosa armadilha: atribuí-la a uma propriedade cria uma cópia, mutando a cópia, e silenciosamente não fazendo nada ao original.

## A matriz de decisão que você pode colar na parede

Três perguntas, em ordem. Pare na primeira que apontar para algum lugar.

1. **Este tipo tem identidade, ou possui estado mutável ao longo do tempo?** Sim -> `class`. Exemplos: `User`, `Order`, `HttpClient`, entidades EF Core, qualquer coisa em um contêiner de serviços com um tempo de vida.

2. **Este tipo é dados imutáveis que devem ser iguais por valor e pequenos (16 bytes ou menos, sem referências a objetos grandes)?** Sim -> `readonly record struct`. Exemplos: `Money`, `Point`, IDs fortemente tipados como `UserId(Guid Value)`, células `(int Row, int Column)`. O limite de 16 bytes importa mais quando você os mantém em arrays, span, ou os passa através de loops quentes.

3. **Caso contrário: o tipo é dados imutáveis com igualdade por valor?** Sim -> `record` (`record class`). Exemplos: DTOs, modelos de requisição/resposta, eventos de domínio, snapshots de configuração, tipos de mensagem em uma fila. Este é o padrão para "classes de dados" no C# moderno.

Se nenhuma das opções acima apontou para algum lugar, você quase certamente quer `class`. O caso restante é "preciso de um tipo de valor mas ele tem mais de 16 bytes", o que geralmente significa reestruturar o tipo, não inclinar-se mais para `struct`.

## O benchmark: quando as cópias de struct realmente doem

Uma afirmação comum é "structs são mais rápidas". Às vezes são, às vezes o custo de cópia domina. Aqui está uma medição rápida para um payload de 24 bytes passado através de cinco frames de método.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<CopyCost>();

public readonly record struct PayloadStruct(long A, long B, long C); // 24 bytes
public sealed record PayloadClass(long A, long B, long C);           // pointer + 24 bytes on heap

[MemoryDiagnoser]
public class CopyCost
{
    private readonly PayloadStruct _s = new(1, 2, 3);
    private readonly PayloadClass _c = new(1, 2, 3);

    [Benchmark(Baseline = true)]
    public long Struct_ByVal()  => Sum1(_s);
    [Benchmark]
    public long Struct_ByIn()   => Sum2(in _s);
    [Benchmark]
    public long Class_ByRef()   => Sum3(_c);

    static long Sum1(PayloadStruct p)     => p.A + p.B + p.C;
    static long Sum2(in PayloadStruct p)  => p.A + p.B + p.C;
    static long Sum3(PayloadClass p)      => p.A + p.B + p.C;
}
```

Metodologia: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X. Números de uma única execução; rode novamente em seu próprio hardware antes de apostar neles.

| Método        | Média      | Alocado   |
| ------------- | ---------- | --------- |
| Struct_ByVal  | 0,31 ns    | 0 B       |
| Struct_ByIn   | 0,28 ns    | 0 B       |
| Class_ByRef   | 0,34 ns    | 0 B       |

A struct passada por valor é ligeiramente mais rápida do que a classe acessada por referência, e `in` economiza um fio a mais. Mas a diferença é sub-nanossegundo. A struct vence decisivamente apenas quando você aloca a classe milhões de vezes -- o custo de alocação é o que difere, não o custo de acesso. Escolha struct pela pressão de alocação, não por "acesso mais rápido".

Quando a struct cresce, o padrão se inverte. Uma struct mutável de 64 bytes passada por valor através de três frames é uma regressão mensurável versus uma referência de `class`. A regra dos 16 bytes existe porque é aproximadamente onde a cópia bit a bit deixa de ser grátis em AMD64.

## As armadilhas que decidem por você

Algumas coisas forçam a decisão independentemente da preferência.

- **Igualdade com coleções no payload.** Se seu record contém um `List<int>`, dois records com listas estruturalmente iguais serão comparados como desiguais porque a igualdade por valor de `record` usa `EqualityComparer<T>.Default`, que recorre à igualdade por referência para `List<T>`. Use `ImmutableArray<T>` (que tem igualdade estrutural) ou sobrescreva `Equals` manualmente.

- **Entidades EF Core e `record`.** EF Core 11 pode rastrear records como entidades, mas a expressão `with` produz uma nova instância que o rastreador de mudanças nunca viu. Se um handler de requisição faz `customer = customer with { Email = "..." }`, o rastreador de mudanças ainda mantém a referência antiga, resultando em nenhum `UPDATE` sendo emitido. Fique com `class` para entidades rastreadas.

- **Default(struct) é um valor real.** Uma `struct` não pode ser `null`. `default(Money)` é uma instância `Money` com valor zero e moeda de string vazia que o sistema de tipos considera válida. Se um valor zero não tem sentido para seu tipo, ou adicione uma propriedade `IsValid` ou use uma `record class` para que `null` seja seu sinal de "sem valor".

- **Interfaces fazem boxing em tipos de valor.** Converter `Money` para `IEquatable<Money>` faz boxing da struct no heap, alocando um novo cabeçalho de objeto e copiando o payload. Se você pretende acessar uma struct através de uma interface em um loop apertado, ou você escolheu a forma errada ou precisa de uma restrição genérica (`where T : struct, IEquatable<T>`) para que o JIT possa especializar sem boxing.

- **Códigos hash para structs rastreadas.** Colocar uma struct mutável em um `Dictionary` ou `HashSet` é um bug. A coleção pega o código hash na inserção e o armazena; se você mutar um campo, o hash do valor muda e a coleção não consegue mais encontrá-lo. `readonly record struct` torna isso impossível por construção.

## A recomendação opinativa, reformulada

Por padrão, `class`. Escolha `record` (`record class`) para dados imutáveis com igualdade por valor. Escolha `readonly record struct` para valores pequenos imutáveis que você mantém em massa ou passa através de loops quentes. Escolha uma `struct` simples apenas quando interoperabilidade ou mutação no local em uma única local fazem valer a armadilha, e escolha uma `class` não-`record` para entidades e tipos portadores de identidade.

Dois corolários que vale a pena comprometer à memória muscular:

- Um `record` com um construtor primário e `sealed` é a "classe de dados" moderna. Se você se pega escrevendo uma classe com apenas propriedades init-only e sobrescrevendo `Equals` e `GetHashCode`, o compilador já escreveu isso para você.
- Um `readonly record struct` torna "tornar estados ilegais não representáveis" prático para valores pequenos. IDs fortemente tipados (`public readonly record struct UserId(Guid Value);`) são essencialmente grátis em tempo de execução e eliminam uma categoria de bugs do tipo "passei o ID do pedido onde o ID do usuário era esperado" em tempo de compilação.

## Relacionados

- [Como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [Como retornar múltiplos valores de um método em C# 14](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/)
- [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Como usar o novo tipo System.Threading.Lock em .NET 11](/pt-br/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)
- [Como usar SearchValues corretamente em .NET 11](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)

## Fontes

- [Records (referência de C#) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [Tipos struct (referência de C#) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct)
- [Escolher entre class e struct -- diretrizes de design do .NET](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct)
- [Tipos struct `readonly` -- referência de C#](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct#readonly-struct)
- [Proposta de record structs -- notas de design da linguagem C#](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/record-structs.md)
