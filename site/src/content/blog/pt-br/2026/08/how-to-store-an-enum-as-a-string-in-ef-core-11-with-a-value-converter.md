---
title: "Como salvar um enum como string no EF Core 11 com um value converter"
description: "Salve enums de C# como strings legíveis em vez de ints no EF Core 11: HasConversion, configuração em massa para todos os enums, a armadilha do nvarchar(max), o problema da ordenação e como migrar uma coluna int existente."
pubDate: 2026-08-03
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

Resposta curta: no EF Core 11 (rodando sobre .NET 11 com C# 14), adicione `.HasConversion<string>()` à propriedade e o EF Core escolhe para você o converter embutido `EnumToStringConverter<TEnum>`. Adicione `.HasMaxLength(...)` junto, porque sem isso o SQL Server entrega uma coluna `nvarchar(max)` que nenhum índice vai tocar. Faça isso uma vez para todos os enums do modelo com `configurationBuilder.Properties<Enum>().HaveConversion<string>()` em `ConfigureConventions`. Igualdade e `Contains` continuam sendo traduzidos corretamente para SQL; comparações relacionais como `>` e `OrderBy` passam silenciosamente para ordem alfabética, e é isso que realmente quebra.

Este post cobre as três formas de configurar a conversão, como o DDL e o SQL gerados realmente ficam, os cinco problemas que mordem em produção e o procedimento de migração para uma coluna que já guarda ints.

Todo o SQL e o comportamento abaixo foram medidos com EF Core 10.0.10 contra SQLite e contra o gerador de DDL do provedor do SQL Server, usando o SDK .NET 10.0.201. O EF Core 11 exige o runtime do .NET 11, então não consegui executá-lo nesta máquina; as diferenças do EF Core 11 apontadas abaixo vêm das [notas de versão do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) e estão marcadas como tal. A API de conversão de valores em si não mudou entre o EF Core 8 e o 11.

## Por que o mapeamento int padrão é um passivo

Por padrão o EF Core mapeia um enum para o tipo numérico subjacente. `OrderStatus.Shipped` vira `2`. Isso é compacto e ordena do jeito que o enum declara, mas acopla seu banco de dados à *ordem de declaração* de um tipo de C#.

```csharp
// .NET 11, C# 14
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Seis meses depois alguém insere `Refunded` entre `Paid` e `Shipped` porque lê melhor. O enum continua compilando, todos os testes continuam passando, e toda linha do banco que dizia `Shipped` agora significa `Refunded`. Não há erro de compilação nem erro em tempo de execução. É um bug de corrupção silenciosa de dados que só aparece quando uma pessoa lê um relatório.

Strings não têm esse modo de falha. `"Shipped"` significa `Shipped` independentemente do que você faça com a ordem de declaração, e a coluna é legível para qualquer pessoa rodando SQL ad-hoc, uma ferramenta de BI ou uma consulta de suporte. Você paga por isso em armazenamento, em largura de índice e no aviso sobre ordenação mais abaixo.

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
// EF Core 11 - equivalent to HasConversion<string>(), just more typing
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

Este é o erro mais comum de todos, e é invisível até uma consulta ficar lenta.

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

`Status` não tinha facetas, então ficou `nvarchar(max)`. No SQL Server você não consegue colocar um índice comum sobre uma coluna `nvarchar(max)` de jeito nenhum, e colunas de status são exatamente o tipo de coluna pela qual você filtra o tempo todo. `PrevStatus` usou `.HasMaxLength(20).IsUnicode(false)` e ficou um `varchar(20)` bem comportado.

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

`nvarchar(450)` são 900 bytes, o limite de tamanho de chave de índice do SQL Server. Funciona, mas uma chave de 900 bytes para uma coluna que guarda `"Pending"` é desperdício em cada página do índice. Defina o comprimento você mesmo. Nomes de enum são curtos; 32 ou 64 caracteres não Unicode quase sempre é o certo.

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

### ToString() em uma consulta emite um CAST, e o EF Core 11 o remove

Projetar ou filtrar sobre `Status.ToString()` parece inofensivo quando a coluna já é uma string, mas o EF Core 10 ainda emite o cast implicado pela chamada CLR:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

Esse cast é semanticamente inócuo e um desastre para o planejador de consultas: envolver a coluna em uma função impede o SQL Server de usar qualquer índice sobre ela. O EF Core 11 detecta e remove casts redundantes durante o pós-processamento do SQL, e as notas de versão apontam as propriedades com conversão de valor como a fonte mais comum. No EF Core 11 a mesma consulta produz um `WHERE [o].[Status] LIKE N'P%'` limpo. Se você está no EF Core 10 ou anterior, remova o `.ToString()` e use `EF.Functions.Like` sobre a propriedade, ou espere a atualização. Verificar isso é um bom motivo para manter [o log de SQL ligado em desenvolvimento](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

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

### Parâmetros de SQL bruto ignoram o converter em silêncio

A documentação de conversão de valores lista isso como uma limitação conhecida, e vale ver como fica, porque não lança exceção:

```csharp
var rows = await context.Orders
    .FromSql($"SELECT Id, Status FROM Orders WHERE Status = {OrderStatus.Pending}")
    .ToListAsync();
```

O parâmetro chega ao banco como `DbType = Int32` com valor `0`. A consulta roda, não casa com nada e devolve uma lista vazia. Passe `OrderStatus.Pending.ToString()` explicitamente no SQL bruto, ou fique no LINQ. Essa é uma falha distinta das que estão por trás de [a expressão LINQ não pôde ser traduzida](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/): aqui não há exceção nenhuma.

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

Não deixe o EF Core gerar essa migração para você. A que ele produz é um único `AlterColumn`, que no SQL Server executa uma conversão implícita de `int` para `nvarchar`: o valor `2` vira a string `"2"`, não `"Shipped"`. Depois disso nenhuma linha pode ser parseada e a próxima leitura lança exceção.

O procedimento seguro tem quatro passos:

1. Adicione o converter ao modelo e então gere a migração com `dotnet ef migrations add StoreStatusAsString`.
2. Abra a migração gerada e substitua o `AlterColumn` por um `AddColumn` para uma coluna temporária, por exemplo `StatusText nvarchar(20) NULL`.
3. Adicione um preenchimento com `migrationBuilder.Sql(...)` entre o add e o drop, mapeando cada int para o nome dele explicitamente: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Escreva o CASE à mão contra a declaração do enum tal como ela existe neste commit, não contra o que ela vier a ser depois.
4. Remova a coluna antiga, renomeie `StatusText` para `Status` e torne-a `NOT NULL`. Escreva a lógica espelhada no `Down` para que a migração seja reversível.

Verifique o SQL antes que ele rode em qualquer lugar real. `dotnet ef migrations script` o imprime, e esse mesmo script é o que um [migration bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) vai executar na máquina de destino. Se o enum é usado como chave estrangeira ou dentro de um índice filtrado, remova e recrie o índice na mesma migração.

Um último conselho sobre o modelo em si: value converters são para uma única coluna. No momento em que você se pegar serializando vários campos em uma string para contornar isso, o que você quer é um [tipo complexo mapeado para JSON](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), que o EF Core 11 consegue indexar e atualizar no lugar. E se o EF Core se recusar a mapear a propriedade, esse é outro problema com outra solução, coberto em [o erro de propriedade que não pôde ser mapeada](/pt-br/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Fontes

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) no Microsoft Learn, incluindo a lista de converters embutidos e as limitações documentadas.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) para a configuração anterior às convenções e o match por tipo base.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) para a remoção dos CAST inócuos.
- Referência da API de [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), a issue de acompanhamento para consultar dentro de propriedades com conversão de valor.
