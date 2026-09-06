---
title: "Como escrever um value converter do EF Core 11 que mapeia um null do banco de dados para um valor não nulo no código"
description: "Por padrão, o EF Core nunca passa null para um value converter. Aqui está o construtor interno convertsNulls que muda isso, a chamada IsRequired(false) da qual ele depende, por que não funciona com enums e outros tipos de valor, a armadilha WHERE col = NULL que ele cria, e os dois padrões que resolvem o problema sem usar uma API interna."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "nullability"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-06
---

Resposta curta: o EF Core deliberadamente nunca entrega `null` a um value converter, então `HasConversion(v => ..., v => v ?? "Unknown")` silenciosamente não faz nada com uma coluna NULL. A única forma de mudar isso é o construtor de quatro argumentos de `ValueConverter<TModel, TProvider>` com `convertsNulls: true`, que é marcado como `[EntityFrameworkInternal]` e produz o aviso `EF1001`. Funciona, mas apenas para propriedades cujo tipo CLR é um tipo de referência, apenas se você também chamar `.IsRequired(false)`, e ao custo de quebrar toda consulta LINQ que filtre pelo valor sentinela. Para um `enum`, `int`, `DateTime` ou qualquer outro tipo de valor não anulável, não há como fazer funcionar. Nesses casos, mapeie uma propriedade anulável e exponha uma fachada não anulável.

Este artigo cobre o que o EF realmente faz com uma coluna NULL, a configuração exata que faz `convertsNulls` funcionar, as quatro formas de consulta que ele quebra (com o SQL que o EF emite para cada uma), o muro que você encontra com tipos de valor, e os dois padrões suportados que você deve usar no lugar.

Uma observação sobre versões. O EF Core 11 está em versão prévia em setembro de 2026 e será lançado junto com o .NET 11 em novembro de 2026, conforme a [página de versões e planejamento do EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). O EF11 exige o runtime do .NET 11, e o único SDK nesta máquina é o .NET 10.0.302, então tudo abaixo foi medido com `Microsoft.EntityFrameworkCore.Sqlite` 10.0.10 em um banco de dados SQLite em memória. Nada disso mudou no EF11: a página [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) não lista nenhuma mudança em value conversions nem no tratamento de nulos, e `convertsNulls` é interno desde o EF Core 6.0.

## Por que seu converter nunca roda para uma coluna NULL

A [documentação de value conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) enuncia a regra diretamente: um valor null nunca é passado a um value converter, e um null em uma coluna do banco de dados é sempre um null na instância da entidade. Isso não é um descuido. É o que permite compartilhar um mesmo converter entre uma chave primária não anulável e as chaves estrangeiras anuláveis que apontam para ela, sem escrever o tratamento de nulos duas vezes.

A consequência é que o código óbvio não faz nada:

```csharp
// .NET 11, C# 14 - this ?? is dead code
modelBuilder.Entity<Order>()
    .Property(o => o.Notes)
    .HasConversion(v => v, v => v ?? "");
```

O ramo `v ?? ""` nunca é alcançado, porque o EF interrompe a conversão antes de entrar nele.

O que acontece em seguida depende do tipo CLR. Considere uma tabela legada em que a coluna é anulável e NULL carrega significado:

```sql
CREATE TABLE Orders (
    Id     INTEGER PRIMARY KEY AUTOINCREMENT,
    Notes  TEXT NULL,   -- NULL means "no notes"
    Status TEXT NULL    -- NULL means "status unknown"
);
INSERT INTO Orders (Notes, Status) VALUES (NULL, NULL);
INSERT INTO Orders (Notes, Status) VALUES ('hi', 'Shipped');
```

mapeada para uma entidade que promete não-nulo:

```csharp
// .NET 11, C# 14
public enum ShippingStatus { Unknown, Pending, Shipped }

public class Order
{
    public int Id { get; set; }
    public string Notes { get; set; } = "";      // never null, we hope
    public ShippingStatus Status { get; set; }   // Unknown, we hope
}
```

Leia a linha 1 de volta e `Notes` é `null`, apesar do inicializador e apesar da declaração não anulável, porque o EF atribui o valor da coluna diretamente à propriedade. `Status` é pior: o data reader do provedor lança antes que o EF tenha chance de fazer qualquer coisa, o que no SQLite aparece assim:

```
System.InvalidOperationException: The data is NULL at ordinal 2. This method can't be
called on NULL values. Check using IsDBNull before calling.
```

Essa exceção é a maneira mais comum de descobrir o problema. O tipo exato varia por provedor, mas a causa é sempre a mesma: o EF só emite uma verificação `IsDBNull` para uma coluna que ele acredita ser anulável, e aqui ele não acredita nisso. Essa falha é diferente de [a propriedade não pôde ser mapeada porque não é um tipo primitivo suportado](/pt-br/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/), que dispara na construção do modelo e não na materialização.

## O converter que de fato converte nulos

`ValueConverter<TModel, TProvider>` tem um segundo construtor, adicionado no EF Core 6.0, que recebe uma flag `convertsNulls`:

```csharp
[Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkInternal]
public ValueConverter(
    Expression<Func<TModel, TProvider>> convertToProviderExpression,
    Expression<Func<TProvider, TModel>> convertFromProviderExpression,
    bool convertsNulls,
    ConverterMappingHints? mappingHints = default);
```

Não existe uma sobrecarga de `HasConversion` para ele, então você precisa criar uma subclasse. O procedimento tem três passos:

1. Escreva uma classe converter cujo tipo de provedor seja explicitamente anulável, e passe `convertsNulls: true` ao construtor base.
2. Suprima `EF1001` em volta da classe, já que o construtor é interno.
3. Chame `.IsRequired(false)` na propriedade para que o EF trate a coluna como anulável e emita a verificação `IsDBNull` de que o caminho de leitura precisa.

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToEmptyString : ValueConverter<string, string?>
{
    public NullToEmptyString()
        : base(
            v => v.Length == 0 ? null : v,   // model -> provider
            v => v ?? "",                    // provider -> model
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Notes)
        .HasConversion(new NullToEmptyString())
        .IsRequired(false);
}
```

Sem o `#pragma`, a compilação emite:

```
warning EF1001: Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<string, string?>
is an internal API that supports the Entity Framework Core infrastructure and not subject to the same
compatibility standards as public APIs. It may be changed or removed without notice in any release.
```

Isso é um aviso, não um erro, mas vira erro sob `TreatWarningsAsErrors`, que é a razão habitual pela qual as pessoas encontram essa API.

Com essa configuração, ambas as direções funcionam. A linha 1 é materializada com `Notes` igual a `""` em vez de `null`, e salvar uma nova entidade cujo `Notes` é `""` grava um `NULL` real na coluna, confirmado ao ler a tabela crua depois.

O passo 3 não é opcional e é o passo que quase todo mundo pula. Remova o `.IsRequired(false)` e `Notes` continua não anulável no modelo (`IsNullable = False`), o EF omite a verificação de nulo, e a leitura lança a mesma exceção `The data is NULL at ordinal 1` de antes. O converter está configurado corretamente e nunca é chamado. Se você não sabe em qual estado está, `context.Model.FindEntityType(typeof(Order))!.FindProperty("Notes")!.IsNullable` responde em uma linha.

## A armadilha das consultas: WHERE col = NULL

Aqui está a parte sobre a qual a [documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) avisa sem mostrar, e é a razão de a API ser interna. O EF aplica a metade modelo-para-provedor do seu converter também às constantes da consulta. Seu sentinela converte para `null`, e o EF planta esse `null` no SQL como um operando de comparação comum.

Quatro formas de perguntar "quais pedidos não têm notas", o SQL que o EF Core 10.0.10 emite para cada uma, e as linhas retornadas contra uma tabela que contém uma linha NULL e uma linha `'hi'`:

| LINQ | Predicado SQL gerado | Linhas |
| --- | --- | --- |
| `o.Notes == ""` | `"o"."Notes" = NULL` | 0 |
| `o.Notes == null!` | `"o"."Notes" IS NULL` | 1 |
| `string.IsNullOrEmpty(o.Notes)` | `"o"."Notes" IS NULL OR "o"."Notes" = NULL` | 1 |
| `o.Notes.Length == 0` | `length("o"."Notes") = 0` | 0 |

A consulta natural, comparando com o sentinela que você inventou, não retorna nada. `= NULL` nunca é verdadeiro sob a lógica de três valores do SQL, então a linha é silenciosamente descartada. Sem exceção, sem aviso: apenas um filtro que silenciosamente não casa com nenhuma linha em produção.

A consulta que funciona é `o.Notes == null`, uma comparação que o analisador de tipos de referência anuláveis marca como sempre falsa, sobre uma propriedade que genuinamente nunca contém null depois de materializada. Você está escrevendo código que o compilador considera morto para produzir o SQL de que precisa. `string.IsNullOrEmpty` só sobrevive por acaso, porque o EF o expande em dois predicados e a metade `IS NULL` sustenta o resultado. `Length == 0` falha pela razão de sempre: NULL se propaga através de `length()`.

Isso não é um bug a ser corrigido depois. É o que o [issue #26230](https://github.com/dotnet/efcore/issues/26230) quer dizer com "value conversion to null in the store generates bad queries", e é por isso que o time do EF marcou o construtor como interno na 6.0 em vez de publicá-lo: a falha é invisível e não é fácil de detectar. Se você seguir por esse caminho, a mitigação é verificar o predicado em vez de confiar nele, seja com `ToQueryString()` em um teste ou [registrando o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Por que não funciona com um enum, int ou DateTime

Para um tipo de valor não anulável, `convertsNulls` leva você até a metade do caminho e para. Escreva o converter:

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToUnknown : ValueConverter<ShippingStatus, string?>
{
    public NullToUnknown()
        : base(
            v => v == ShippingStatus.Unknown ? null : v.ToString(),
            v => v == null ? ShippingStatus.Unknown : Enum.Parse<ShippingStatus>(v),
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001
```

A escrita funciona: salvar `ShippingStatus.Unknown` grava `NULL`. A leitura não, e o passo 3 acima explica por quê. `.IsRequired(false)` lança na construção do modelo:

```
System.InvalidOperationException: The property 'Order.Status' cannot be marked as
nullable/optional because the type of the property is 'ShippingStatus' which is not a
nullable type. Any property can be marked as non-nullable/required, but only properties
of nullable types can be marked as nullable/optional.
```

A verificação de nulidade do EF olha para o tipo CLR, não para o converter, então nenhuma combinação de configurações leva você lá. Omita a chamada e o modelo mantém `IsNullable = False`, o EF pula a verificação `IsDBNull`, e toda leitura de uma linha NULL lança. Não existe uma terceira opção. `convertsNulls` sobre um tipo de valor não anulável é um recurso somente de escrita, o que é pior do que inútil: ele vai alegremente persistir NULLs que o mesmo modelo não consegue ler de volta.

## Os dois padrões que realmente funcionam

### Mapeie uma propriedade anulável e exponha uma fachada não anulável

A propriedade mapeada carrega honestamente a nulidade do banco de dados. A propriedade de domínio faz o coalescing em C# puro, onde nenhum tradutor de consultas está envolvido:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    public ShippingStatus? StatusRaw { get; set; }

    [NotMapped]
    public ShippingStatus Status
    {
        get => StatusRaw ?? ShippingStatus.Unknown;
        set => StatusRaw = value == ShippingStatus.Unknown ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.StatusRaw)
        .HasColumnName("Status")
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

Sem API interna, sem `EF1001`, e as consultas são corretas por construção: `Where(o => o.StatusRaw == null)` emite `WHERE "o"."Status" IS NULL` e casa com a linha NULL, enquanto `Where(o => o.StatusRaw == ShippingStatus.Shipped)` emite `WHERE "o"."Status" = 'Shipped'`. A metade enum-para-string é a conversão embutida de sempre, coberta em [como salvar um enum como string com um value converter](/pt-br/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), incluindo o `HasMaxLength` que impede o SQL Server de te entregar um `nvarchar(max)` não indexável.

O custo é que o LINQ precisa nomear `StatusRaw`, não `Status`. Referenciar `Status` em um `Where` resulta em [a expressão LINQ não pôde ser traduzida](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), porque membros `[NotMapped]` não têm contrapartida em SQL. É uma troca justa: o tradutor recusa em tempo de compilação e execução em vez de emitir `= NULL` silenciosamente.

### Mapeie um campo de apoio privado

Se você prefere não ampliar a superfície pública com um `StatusRaw`, mapeie um campo e mantenha uma única propriedade pública:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    private string? _notes;

    public string Notes
    {
        get => _notes ?? "";
        set => _notes = value.Length == 0 ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>(e =>
    {
        e.Ignore(o => o.Notes);
        e.Property<string?>("_notes")
            .HasColumnName("Notes")
            .UsePropertyAccessMode(PropertyAccessMode.Field);
    });
}
```

Leituras e escritas se comportam de forma idêntica à versão com fachada, e `Where(o => EF.Property<string>(o, "_notes") == null)` traduz para `WHERE "o"."Notes" IS NULL`. A desvantagem é que toda consulta que toca a coluna passa pelo `EF.Property<T>` baseado em strings, que nenhum refactor de renomeação vai acompanhar. Prefira a fachada, a menos que a propriedade pública extra seja realmente inaceitável.

### Ou mude os dados

Vale dizer claramente, porque muitas vezes é a resposta certa: se NULL e o seu sentinela significam exatamente a mesma coisa, o esquema está carregando uma distinção que o domínio não tem. Um `UPDATE Orders SET Status = 'Unknown' WHERE Status IS NULL`, um `ALTER COLUMN ... NOT NULL` e um `HasDefaultValue("Unknown")` eliminam o problema em vez de contorná-lo. Isso é uma migração de dados, não um truque de mapeamento, e [como renomear uma tabela em uma migração sem perder dados](/pt-br/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) cobre a forma geral de editar uma migração à mão para levar mudanças de dados junto com mudanças de esquema.

## Em que pé está o recurso

O [issue #13850](https://github.com/dotnet/efcore/issues/13850), "Allow HasConversion/ValueConverters to convert nulls", continua aberto e no milestone Backlog, sem data. Um pedido de 2026 por uma sobrecarga pública de `HasConversion` recebendo `convertsNulls`, o [issue #36365](https://github.com/dotnet/efcore/issues/36365), foi fechado como duplicado dele. Então o construtor de quatro argumentos é onde isso fica para o EF Core 11, aviso e tudo.

Use-o quando a propriedade do modelo for um tipo de referência, o sentinela nunca for usado como filtro, e você tiver um teste verificando `ToQueryString()` para toda consulta que toca a coluna. Em qualquer outro caso, e sempre para tipos de valor, mapeie a propriedade anulável e faça o coalescing em C#.

### Leia a seguir

- [Como salvar um enum como string no EF Core 11 com um value converter](/pt-br/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)
- [Solução: "The LINQ expression could not be translated" no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Solução: "The property could not be mapped, because it is not a supported primitive type or a valid entity type" no EF Core 11](/pt-br/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)
- [Como registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Solução: CS8618 "Non-nullable property must contain a non-null value when exiting constructor" em C#](/pt-br/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)

### Fontes

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), documentação do EF Core
- [Construtores de ValueConverter&lt;TModel,TProvider&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.valueconverter-2.-ctor), referência de API do .NET
- [Issue #26230: Problems with value converters that convert nulls](https://github.com/dotnet/efcore/issues/26230), dotnet/efcore
- [Issue #13850: Allow HasConversion/ValueConverters to convert nulls](https://github.com/dotnet/efcore/issues/13850), dotnet/efcore
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), documentação do EF Core
