---
title: "Como salvar um enum como string no EF Core 11 com um value converter"
description: "Salve enums de C# como strings legíveis em vez de ints no EF Core 11: HasConversion, configuração em massa para todos os enums, a armadilha do nvarchar(max), o problema da ordenação e como migrar uma coluna int existente."
pubDate: 2026-08-03
updatedDate: 2026-11-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "enums"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter"
translatedBy: "claude"
translationDate: 2026-08-03
---

Use `.HasConversion<string>()` para armazenar nomes de enum com EF Core. Escolha um comprimento que comporte os nomes válidos e confira o DDL gerado. Filtros de igualdade usam o valor convertido. Comparações e ordenação de texto seguem a collation do banco, que pode diferir da ordem numérica do fluxo.

**Correção, 2 de novembro de 2026.** A versão anterior dizia que o conversor integrado não lia strings numéricas e que 900 bytes era o limite universal de chaves de índice do SQL Server. As duas afirmações estavam incorretas. A migração agora diferencia materializar um valor de encontrá-lo em um filtro.

O teste usou SDK 10.0.302 e EF Core 10.0.10. Foram executadas leituras e consultas no SQLite e gerados DDL e SQL de consultas do provedor SQL Server sem conexão ao servidor. Otimizações do EF Core 11 estão nas [notas da versão](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew). [Converter nulos do banco](/pt-br/2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value/) tem regras próprias.

## Por que o mapeamento int padrão é um passivo

Por padrão o EF Core usa o tipo numérico subjacente. Com valores implícitos, inserir ou reordenar membros pode mudar os números dos seguintes. Use valores explícitos estáveis se esses números fizerem parte do contrato persistido.

```csharp
// Implicit numeric values follow declaration order.
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Seis meses depois alguém insere `Refunded` entre `Paid` e `Shipped` porque lê melhor. O enum continua compilando, todos os testes continuam passando, e toda linha do banco que dizia `Shipped` agora significa `Refunded`. Não há erro de compilação nem erro em tempo de execução. É um bug de corrupção silenciosa de dados que só aparece quando uma pessoa lê um relatório.

Nomes evitam depender da ordem da declaração. Renomear um membro ainda altera o contrato armazenado e requer migração ou mapeamento explícito. Considere legibilidade, armazenamento, índices e ordenação.

## As três formas de configurar a conversão

A forma mais curta usa a sobrecarga genérica de `HasConversion`. O EF Core inspeciona o tipo do modelo (um enum) e o tipo de provedor solicitado (`string`) e seleciona o converter embutido automaticamente:

```csharp
// EF Core 11, OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Status)
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

A segunda forma escreve as duas lambdas explicitamente. Você quase nunca precisa dela para um enum simples, mas é o que a [documentação de conversões de valores](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) mostra primeiro, então vale reconhecer:

```csharp
// Explicit converter: Enum.Parse here is case-sensitive.
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion(
        v => v.ToString(),
        v => (OrderStatus)Enum.Parse(typeof(OrderStatus), v));
```

Essas duas *não* são idênticas, e a diferença importa. O `EnumToStringConverter<TEnum>` embutido faz o parse sem diferenciar maiúsculas de minúsculas; o `Enum.Parse` escrito à mão acima diferencia e lança exceção em uma linha que guarda `"pending"` em vez de `"Pending"`. Prefira a sobrecarga genérica.

A terceira forma pula a fluent API por completo e apenas declara o tipo da coluna. O EF Core vê uma coluna string sob uma propriedade enum e infere a conversão:

```csharp
// EF Core 11 - conversion inferred from the store type
public class Order
{
    public int Id { get; set; }

    [Column(TypeName = "varchar(20)")]
    public OrderStatus Status { get; set; }
}
```

### Configurar todos os enums do modelo de uma vez

Repetir `HasConversion<string>()` em quarenta propriedades é o jeito de acabar com uma esquecida. A configuração de modelo anterior às convenções faz match pelo tipo CLR, e a documentação observa que o tipo "pode ser um tipo base", o que significa que `System.Enum` faz match com todos os enums do modelo:

```csharp
// EF Core 11 - applies to every enum property in the model
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    configurationBuilder
        .Properties<Enum>()
        .HaveConversion<string>()
        .HaveMaxLength(32);
}
```

Verifiquei isso no EF Core 10.0.10. Despejar o modelo depois mostra a conversão aplicada tanto a uma propriedade enum não anulável quanto a uma anulável, incluindo o comprimento máximo:

```text
Id:         clr=Int32       provider=(none)  maxlen=
Perms:      clr=Perms       provider=String  maxlen=32
PrevStatus: clr=Nullable`1  provider=String  maxlen=32
Status:     clr=OrderStatus provider=String  maxlen=32
```

Repare que `IProperty.GetValueConverter()` devolve `null` aqui mesmo com a conversão ativa. Quando a conversão vem do tipo de provedor e não de uma instância explícita de converter, ela mora no type mapping. Se você estiver inspecionando um modelo no depurador, olhe `property.GetTypeMapping().Converter`, que reporta uma instância de `EnumToStringConverter<TEnum>`.

A configuração anterior às convenções sobrescreve as convenções *e* as data annotations, então se você precisa de um enum salvo como int, configure esse explicitamente em `OnModelCreating` depois.

## A armadilha do nvarchar(max)

Defina um comprimento adequado e confira a migração. SQL Server diferencia colunas comuns, chaves de índice e colunas incluídas que não são chave.

Configure a conversão sem comprimento e o provedor do SQL Server não faz ideia de quão longas são as strings, então escolhe a coisa mais larga que tem. Este é o DDL que o EF Core gerou para um modelo com três propriedades enum convertidas, das quais só duas definem um comprimento:

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(max) NOT NULL,
    [PrevStatus] varchar(20) NULL,
    [Perms] nvarchar(64) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Neste exemplo `Status` sem facetas é `nvarchar(max)`. Não pode ser uma chave de índice comum, mas pode ser incluída como coluna não chave em índice não clusterizado. `PrevStatus` com `.HasMaxLength(20).IsUnicode(false)` vira `varchar(20)`.

Há uma ressalva que vale conhecer: se você declarar um índice sobre a propriedade, o provedor do SQL Server do EF Core recorre ao padrão de coluna de chave em vez de `max`:

```csharp
// EF Core 11
modelBuilder.Entity<Order>().Property(o => o.Status).HasConversion<string>();
modelBuilder.Entity<Order>().HasIndex(o => o.Status);
```

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(450) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
GO

CREATE INDEX [IX_Orders_Status] ON [Orders] ([Status]);
```

O provedor SQL Server gerou `nvarchar(450)` para a propriedade indexada no teste com EF Core 10.0.10. Isso admite até 900 bytes de dados de caracteres. A partir de SQL Server 2016, chaves de índice clusterizado admitem até 900 bytes e as não clusterizadas até 1.700. O máximo declarado não é o espaço real de um valor curto. Escolha comprimento suficiente para todos os nomes ou códigos.

Se você quiser que o comprimento viaje junto com o converter em vez de repeti-lo em cada propriedade, passe `ConverterMappingHints`:

```csharp
// EF Core 11 - the size travels with the converter
var converter = new ValueConverter<OrderStatus, string>(
    v => v.ToString(),
    v => Enum.Parse<OrderStatus>(v, ignoreCase: true),
    new ConverterMappingHints(size: 20, unicode: false));
```

Qualquer faceta definida explicitamente na propriedade sobrescreve essas dicas.

## Em que suas consultas LINQ realmente compilam

A igualdade é traduzida exatamente como você esperaria. O enum é convertido na entrada do parâmetro, não na saída da coluna, então a coluna continua aproveitável pelo índice:

```csharp
var pending = await context.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ToListAsync();
```

```sql
SELECT "o"."Id", "o"."Perms", "o"."PrevStatus", "o"."Status"
FROM "Orders" AS "o"
WHERE "o"."Status" = 'Pending'
```

`Contains` sobre um array de valores enum vira um `IN` parametrizado, com cada valor convertido:

```sql
-- Parameters: @wanted1='Pending', @wanted2='Paid'
WHERE "o"."Status" IN (@wanted1, @wanted2)
```

`ExecuteUpdate` também lida com enums convertidos, enviando a string como parâmetro:

```csharp
await context.Orders
    .Where(o => o.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Paid));
```

Isso cobre os casos normais. Agora os que não se comportam.

### Comparação relacional e OrderBy passam para ordem alfabética

Este é o custo real de guardar strings, e o EF Core não avisa. Uma comparação `>` sobre um enum é C# perfeitamente legal e é traduzida para uma comparação de strings de SQL perfeitamente legal, que não é a mesma coisa:

```csharp
// Intent: "everything after Paid in the workflow"
var later = await context.Orders
    .Where(o => o.Status > OrderStatus.Paid)
    .ToListAsync();
```

```sql
WHERE "o"."Status" > 'Paid'
```

Com três linhas contendo `Pending`, `Delivered` e `Cancelled`, o LINQ em memória devolve as linhas `Delivered` e `Cancelled`. O banco devolve a linha `Pending`, porque `'Pending' > 'Paid'` alfabeticamente e `'Cancelled'` e `'Delivered'` não. `OrderBy(o => o.Status)` tem o mesmo problema: volta como `Cancelled, Delivered, Pending` em vez da ordem de declaração.

A correção não é uma opção do converter. Ou você mantém um int para tudo que ordena ou compara por faixa, ou adiciona uma coluna explícita `int SortOrder`, ou substitui a consulta de faixa por um conjunto explícito: `Where(o => finished.Contains(o.Status))`. Se você já tem código em produção que compara enums por faixa, procure com grep antes de virar o mapeamento.

### Conferir o SQL de ToString()

Projetar ou filtrar sobre `Status.ToString()` parece inofensivo quando a coluna já é uma string, mas o EF Core 10 ainda emite o cast implicado pela chamada CLR:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

O provedor SQL Server do EF Core 10.0.10 gerou o `CAST` acima. O uso de índice depende do plano real. EF Core 11 documenta uma otimização de casts redundantes, mas confira `ToQueryString()` no seu provedor e versão. Para um status exato, compare os enums. `EF.Functions.Like` espera uma expressão de string, não a propriedade enum diretamente. Veja [logging de SQL em desenvolvimento](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Lendo os valores de volta: nomes desconhecidos e caixa

Os value converters rodam na materialização, e uma coluna string aceita qualquer coisa. Uma linha contendo um nome que seu enum não tem falha na leitura, não na consulta:

```text
InvalidOperationException: Cannot convert string value 'Refunded' from the database
to any value in the mapped 'OrderStatus' enum.
```

A exceção aparece quando a linha é materializada, então uma consulta que devolve 10.000 linhas morre na linha que por acaso estiver ruim. Proteja a coluna com uma constraint `CHECK` se o banco for compartilhado com qualquer coisa que escreva nele diretamente.

A caixa, por outro lado, é perdoada pelo converter embutido: uma linha que guarda `"pending"` é materializada como `OrderStatus.Pending`. Isso é o `EnumToStringConverter<TEnum>` fazendo parse sem diferenciar caixa. Troque por um `Enum.Parse(typeof(OrderStatus), v)` escrito à mão e essa mesma linha lança exceção, porque o padrão da BCL diferencia caixa. Se você escrever o seu, escreva `Enum.Parse<OrderStatus>(v, ignoreCase: true)`.

### Enums `[Flags]` vão e voltam, mas não são consultáveis

Um enum `[Flags]` é convertido via `ToString()` como qualquer outro, o que produz uma lista separada por vírgulas:

```text
row 1 | Read
row 2 | Read, Write
row 3 | None
```

A ida e volta funciona. Consultar não: `Where(o => o.Perms.HasFlag(Perms.Write))` não pode ser traduzido para um predicado de string, e `LIKE '%Write%'` não acha nada útil e varre tudo. Mantenha enums `[Flags]` como ints, ou modele as permissões como linhas.

### Passar o valor do provedor em SQL direto

Um argumento interpolado de SQL direto não usa automaticamente o conversor da propriedade. Informe a representação armazenada. Para o mapeamento integrado por nome:

```csharp
var providerValue = OrderStatus.Pending.ToString();
var rows = await context.Orders
    .FromSql($"SELECT * FROM Orders WHERE Status = {providerValue}")
    .ToListAsync();
```

A interpolação fornece um parâmetro. Com mapeamento personalizado para `PND`, passe esse código para `Pending`. Um inteiro pode retornar linhas diferentes ou causar erro de conversão conforme o provedor. A consulta de entidade precisa também das colunas para materialização. Isso difere de [falha na tradução LINQ](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

## Salvando códigos curtos em vez de nomes

Se você quer `"PND"` em vez de `"Pending"` (códigos de largura fixa são comuns em esquemas compartilhados com um data warehouse), herde de `ValueConverter<TModel, TProvider>` para que o mapeamento seja explícito e revisável:

```csharp
// EF Core 11
public class StatusCodeConverter : ValueConverter<OrderStatus, string>
{
    public StatusCodeConverter() : base(v => ToCode(v), v => FromCode(v)) { }

    private static string ToCode(OrderStatus s) => s switch
    {
        OrderStatus.Pending => "PND",
        OrderStatus.Paid => "PAI",
        OrderStatus.Shipped => "SHP",
        OrderStatus.Delivered => "DLV",
        OrderStatus.Cancelled => "CAN",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null)
    };

    private static OrderStatus FromCode(string c) => c switch
    {
        "PND" => OrderStatus.Pending,
        "PAI" => OrderStatus.Paid,
        "SHP" => OrderStatus.Shipped,
        "DLV" => OrderStatus.Delivered,
        "CAN" => OrderStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown status code '{c}'.")
    };
}
```

```csharp
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<StatusCodeConverter>()
    .HasMaxLength(3)
    .IsUnicode(false);
```

Os predicados são traduzidos através do converter, então `Where(o => o.Status == OrderStatus.Pending)` vira `WHERE "o"."Status" = 'PND'`. Como os braços do switch são exaustivos sobre os códigos conhecidos, um valor inesperado devolve a *sua* mensagem em vez da do EF, o que é muito mais fácil de diagnosticar. Converters não têm estado e podem ser compartilhados entre todas as propriedades que os usam.

## Migrando uma coluna que já guarda ints

Uma conversão simples de coluna pode armazenar `2` como texto `"2"` em vez de `"Shipped"`. No SQLite, o conversor integrado de EF Core 10.0.10 leu ambas as strings como `Shipped`. O filtro de igualdade encontrou apenas a linha com o nome, pois seu valor no provedor era `"Shipped"`. Até `"99"` foi materializado como valor sem nome, enquanto `"Bogus"` lançou exceção. Texto numérico altera o contrato mesmo quando a leitura funciona.

Em uma migração coordenada, preencha explicitamente os nomes pretendidos. Faça backup, teste em uma cópia e considere gravadores que ainda usem a coluna antiga durante a implantação.

1. Adicione o converter ao modelo e então gere a migração com `dotnet ef migrations add StoreStatusAsString`.
2. Abra a migração gerada e substitua o `AlterColumn` por um `AddColumn` para uma coluna temporária, por exemplo `StatusText nvarchar(20) NULL`.
3. Adicione um preenchimento com `migrationBuilder.Sql(...)` entre o add e o drop, mapeando cada int para o nome dele explicitamente: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Escreva o CASE à mão contra a declaração do enum tal como ela existe neste commit, não contra o que ela vier a ser depois.
4. Remova a coluna antiga, renomeie `StatusText` para `Status` e torne-a `NOT NULL`. Escreva a lógica espelhada no `Down` para que a migração seja reversível.

Antes de remover colunas, verifique contagens, inteiros sem mapeamento, nulabilidade e cada valor. Recrie índices e chaves estrangeiras afetados e teste atualização e reversão quando suportadas. Revise `dotnet ef migrations script` e ensaie a implantação real, incluindo o [bundle de migração](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) se utilizado.

Um último conselho sobre o modelo em si: value converters são para uma única coluna. No momento em que você se pegar serializando vários campos em uma string para contornar isso, o que você quer é um [tipo complexo mapeado para JSON](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), que o EF Core 11 consegue indexar e atualizar no lugar. E se o EF Core se recusar a mapear a propriedade, esse é outro problema com outra solução, coberto em [o erro de propriedade que não pôde ser mapeada](/pt-br/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Fontes

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) no Microsoft Learn, incluindo a lista de converters embutidos e as limitações documentadas.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) para a configuração anterior às convenções e o match por tipo base.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) para a remoção dos CAST inócuos.
- Referência da API de [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), a issue de acompanhamento para consultar dentro de propriedades com conversão de valor.
- [SQL Server index key limits](https://learn.microsoft.com/en-us/sql/sql-server/maximum-capacity-specifications-for-sql-server?view=sql-server-ver17)
- [EF Core 10.0.10 enum converter source](https://github.com/dotnet/efcore/blob/v10.0.10/src/EFCore/Storage/ValueConversion/Internal/StringEnumConverter.cs)
