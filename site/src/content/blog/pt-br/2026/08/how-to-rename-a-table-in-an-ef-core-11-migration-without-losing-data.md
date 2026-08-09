---
title: "Como renomear uma tabela em uma migração do EF Core 11 sem perder dados"
description: "O EF Core gera RenameTable quando você muda o nome da tabela, mas DropTable mais CreateTable quando você renomeia a classe de entidade. Veja como distinguir os dois casos, o truque do ToTable que torna a renomeação de uma classe gratuita, e o bug de renomeação de colunas que troca seus dados em silêncio."
pubDate: 2026-08-09
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data"
translatedBy: "claude"
translationDate: 2026-08-09
---

Resposta curta: se você mudar apenas o *nome da tabela* com `ToTable("Clients")` e deixar a classe de entidade intacta, o EF Core gera um `migrationBuilder.RenameTable(...)` correto e nenhum dado é perdido. Se você renomear a *classe de entidade* de `Customer` para `Client`, o EF Core gera `DropTable("Customers")` mais `CreateTable("Clients")`, e aplicar essa migração apaga todas as linhas. A solução é nunca fazer as duas coisas ao mesmo tempo: fixe o nome antigo da tabela com `ToTable("Customers")` no mesmo commit que renomeia a classe, o que produz zero mudanças no modelo, e depois mude o nome da tabela em uma migração separada.

Este artigo cobre a saída exata do scaffolding para os dois casos, o T-SQL que cada um gera, a reconstrução da chave primária que o EF Core enfia dentro de uma renomeação de tabela, e três detalhes que mordem depois que a migração é aplicada sem erros.

Tudo abaixo foi medido no EF Core 10.0.10 com o SDK do .NET 10.0.201, gerando o scaffolding contra o gerador de DDL do provedor do SQL Server. O EF Core 11 exige o runtime do .NET 11, que eu não tenho nesta máquina, então não pude executá-lo lá. O comportamento do `MigrationsModelDiffer` e a API `RenameTable` não mudam entre EF Core 8, 9, 10 e 11; o único item específico do EF Core 11, o comando `dotnet ef database update --add`, é destacado abaixo e vem da documentação, não de uma medição.

## As duas renomeações que o EF Core trata de forma completamente diferente

Comece de um modelo com um `Customer`, um `Order` que aponta para ele, e um índice único:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public List<Order> Orders { get; set; } = new();
}

protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<Customer>().Property(c => c.Name).HasMaxLength(200);
    b.Entity<Customer>().HasIndex(c => c.Email).IsUnique();
}
```

Agora renomeie a classe para `Client`, renomeie a propriedade `DbSet<Customer> Customers` para `Clients`, e deixe a IDE ajustar `Order.CustomerId` para `Order.ClientId`. Rode `dotnet ef migrations add RenameCustomerToClient` e você recebe isto:

```csharp
// scaffolded by EF Core 10.0.10 after renaming the entity class
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");

migrationBuilder.DropTable(name: "Customers");   // <- every row, gone

migrationBuilder.RenameColumn(name: "CustomerId", table: "Orders", newName: "ClientId");
migrationBuilder.RenameIndex(name: "IX_Orders_CustomerId", table: "Orders", newName: "IX_Orders_ClientId");

migrationBuilder.CreateTable(
    name: "Clients",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false)
            .Annotation("SqlServer:Identity", "1, 1"),
        Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
        Email = table.Column<string>(type: "nvarchar(450)", nullable: false)
    },
    constraints: table => { table.PrimaryKey("PK_Clients", x => x.Id); });
```

Repare na assimetria, porque ela é a história inteira. A tabela `Orders` manteve o nome, então o comparador a associou à sua versão anterior e emitiu corretamente `RenameColumn` para a coluna de chave estrangeira. A tabela `Customers` *não* manteve o nome, então o comparador viu uma tabela desaparecer e outra sem relação aparecer, e emitiu um drop seguido de um create.

O EF Core avisa aqui. A CLI imprime uma linha fácil de passar batido:

```
An operation was scaffolded that may result in the loss of data. Please review the migration for accuracy.
```

Agora faça a outra renomeação. Mantenha a classe chamada `Customer` e mude apenas o nome da tabela:

```csharp
// EF Core 11, OnModelCreating
b.Entity<Customer>().ToTable("Clients");
```

Gere o scaffolding disso e você recebe uma migração que preserva todas as linhas, sem nenhum aviso impresso:

```csharp
// scaffolded by EF Core 10.0.10 after ToTable("Clients")
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");
migrationBuilder.DropPrimaryKey(name: "PK_Customers", table: "Customers");

migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");

migrationBuilder.AddPrimaryKey(name: "PK_Clients", table: "Clients", column: "Id");
migrationBuilder.AddForeignKey(
    name: "FK_Orders_Clients_CustomerId", table: "Orders", column: "CustomerId",
    principalTable: "Clients", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
```

Essa é a migração que você quer. A lição é que o EF Core não está adivinhando nada sobre renomeações de tabelas: ele baseia todo o diff no nome da tabela. Mude o nome da tabela e você recebe uma renomeação. Mude a identidade do tipo de entidade e você recebe um drop.

## O procedimento que torna a renomeação de uma classe gratuita

O truque é desacoplar a refatoração de C# da mudança de esquema, para que nenhum dos passos seja ambíguo.

1. **Fixe o nome atual da tabela antes de tocar na classe.** Adicione `ToTable` com o nome que o banco de dados já usa, e não gere nada:

   ```csharp
   // EF Core 11 - this is a no-op against the existing schema
   b.Entity<Customer>().ToTable("Customers");
   ```

2. **Renomeie a classe, o `DbSet` e as propriedades de navegação.** Deixe a IDE fazer isso na solução inteira. A configuração fluente vira `b.Entity<Client>().ToTable("Customers")`.

3. **Confirme que não há nada para migrar.** Este é o passo que prova que a refatoração foi neutra em relação ao esquema:

   ```bash
   dotnet ef migrations has-pending-model-changes
   ```

   No EF Core 10.0.10 isso imprime `No changes have been made to the model since the last migration.` A classe agora se chama `Client`, o `DbSet` é `Clients`, e o banco de dados não percebeu nada. Publique esse commit sozinho.

4. **Mude o nome da tabela em uma migração separada.** Atualize a fixação para `b.Entity<Client>().ToTable("Clients")` e gere o scaffolding. Como desta vez a identidade do tipo de entidade é estável, você recebe o `RenameTable` limpo mostrado acima.

5. **Leia a migração gerada antes de aplicá-la.** Toda vez. Confirme que não há nenhum `DropTable` nem `DropColumn` no método `Up`, e confirme que o método `Down` reverte a renomeação em vez de recriar a tabela.

O motivo de manter a fixação permanentemente, em vez de apagá-la depois que a renomeação entra, é que o nome da tabela é derivado por convenção do nome da propriedade `DbSet`. Deixe implícito e a próxima pessoa que renomear uma propriedade por legibilidade vai mover sua tabela de novo.

## O que a renomeação realmente executa contra o SQL Server

`dotnet ef migrations script` sobre a migração com `RenameTable` produz isto:

```sql
-- EF Core 10.0.10, SQL Server provider
ALTER TABLE [Orders] DROP CONSTRAINT [FK_Orders_Customers_CustomerId];
ALTER TABLE [Customers] DROP CONSTRAINT [PK_Customers];
EXEC sp_rename N'[Customers]', N'Clients', 'OBJECT';
EXEC sp_rename N'[Clients].[IX_Customers_Email]', N'IX_Clients_Email', 'INDEX';
ALTER TABLE [Clients] ADD CONSTRAINT [PK_Clients] PRIMARY KEY ([Id]);
ALTER TABLE [Orders] ADD CONSTRAINT [FK_Orders_Clients_CustomerId]
    FOREIGN KEY ([CustomerId]) REFERENCES [Clients] ([Id]) ON DELETE CASCADE;
```

A renomeação da tabela em si é só metadados e é praticamente instantânea, independentemente do número de linhas. A parte cara é a movimentação de constraints em volta dela. O EF Core remove a chave primária e a adiciona de volta apenas para mudar o *nome* da constraint de `PK_Customers` para `PK_Clients`. No SQL Server a chave primária é clustered por padrão, então `ADD CONSTRAINT ... PRIMARY KEY` reconstrói o índice clustered inteiro. Em uma tabela com dezenas de milhões de linhas isso é uma operação longa e pesada em log dentro da transação da migração, para renomear cosmeticamente uma constraint.

O `sp_rename` consegue renomear constraints diretamente, então você pode editar a migração à mão para pular a reconstrução:

```csharp
// EF Core 11 - replace DropPrimaryKey/AddPrimaryKey on a large SQL Server table
migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Customers]', N'PK_Clients', 'OBJECT';");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Orders_Customers_CustomerId]', N'FK_Orders_Clients_CustomerId', 'OBJECT';");
```

O `sp_rename` precisa do nome qualificado pelo esquema quando o alvo é uma constraint, daí o prefixo `[dbo].`. Isso é específico do provedor e diverge do que o snapshot do modelo espera que o EF Core tenha feito, então recorra a isso apenas quando a reconstrução for de fato um problema. Se seguir esse caminho, aplique através de um script revisado em vez de na inicialização da aplicação; o [fluxo de trabalho com migration bundles](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) tem o formato certo para isso.

## Renomear uma coluna é onde o EF Core realmente adivinha

A documentação da Microsoft ainda diz que renomear uma propriedade gera `DropColumn` mais `AddColumn`. Isso deixou de ser verdade faz tempo. No EF Core 10.0.10, renomear `Customer.Name` para `Customer.FullName` gera exatamente o que você quer:

```csharp
migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");
```

A melhoria é real, mas vem de uma heurística que emparelha colunas removidas com colunas adicionadas, e essa heurística pode emparelhá-las errado. Pegue uma entidade com duas propriedades string de configuração idêntica, `Alpha` e `Bravo`, e renomeie as duas em uma única migração para `Zulu` e `Yankee` respectivamente. O EF Core 10.0.10 gera isto:

```csharp
// WRONG: Alpha should become Zulu, Bravo should become Yankee
migrationBuilder.RenameColumn(name: "Bravo", table: "Customers", newName: "Zulu");
migrationBuilder.RenameColumn(name: "Alpha", table: "Customers", newName: "Yankee");
```

O emparelhamento está cruzado. Aplique isso e os dados das duas colunas são trocados em silêncio em todas as linhas da tabela. Nada é removido, então nenhum aviso de perda de dados é impresso, a migração é aplicada sem erros, e a corrupção só aparece quando uma pessoa olha para a tela. Reproduzi isso em uma tabela de duas colunas sem nenhuma outra mudança no modelo.

A regra prática: renomeie uma coluna por migração quando as colunas compartilham o tipo, ou leia os pares `RenameColumn` gerados e corrija-os à mão. Esse é o mesmo tipo de problema de corrupção silenciosa que [guardar um enum pelo seu valor inteiro](/pt-br/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), em que o esquema continua válido enquanto o significado dos dados muda por baixo.

## Três coisas que ainda quebram depois de uma migração bem-sucedida

**Views, stored procedures e triggers mantêm o nome antigo.** O `sp_rename` do SQL Server não persegue referências. A documentação é direta: "Changing any part of an object name can break scripts and stored procedures." Uma view que seleciona de `Customers` não vai falhar na hora da renomeação; ela falha na próxima vez que alguém a consultar. Antes de gerar o scaffolding, liste o que depende da tabela:

```sql
SELECT OBJECT_NAME(referencing_id) AS referencing_object
FROM sys.sql_expression_dependencies
WHERE referenced_entity_name = 'Customers';
```

Depois adicione operações `migrationBuilder.Sql("ALTER VIEW ...")` à mesma migração para que a renomeação e seus dependentes se movam juntos.

**`dotnet ef database update --add` aplica a migração antes que você consiga lê-la.** O EF Core 11 adicionou um comando de passo único que gera uma migração, compila com Roslyn e aplica imediatamente. Isso é genuinamente útil para fluxos com containers e Aspire, e é exatamente a ferramenta errada para uma renomeação, porque todo o procedimento de segurança acima depende de ler o arquivo gerado primeiro. Para qualquer migração que toque na identidade de uma tabela existente, gere e aplique em dois comandos. O [recurso de migração em passo único](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) vale a pena em todos os outros casos.

**Uma renomeação não é retrocompatível, então ela quebra implantações progressivas.** Durante uma implantação progressiva a versão antiga continua rodando e continua emitindo `SELECT ... FROM Customers` enquanto a nova espera `Clients`. Uma única migração que renomeia a tabela derruba as instâncias antigas. Se você precisa de zero downtime, a renomeação vira uma sequência de várias implantações: crie uma view chamada `Customers` sobre `Clients` na mesma migração da renomeação, implante a versão nova, e remova a view em uma migração posterior quando nenhuma instância referenciar mais o nome antigo.

Um último detalhe que vale conferir antes do commit: o método `Down`. O EF Core gera um inverso correto para `RenameTable`, mas se você editou `Up` à mão para usar `sp_rename` nas constraints, o `Down` continua contendo o `DropPrimaryKey` e o `AddPrimaryKey` gerados, e seu rollback não será simétrico. Se o snapshot do modelo e o banco de dados divergirem depois disso, você vai encontrar [a exceção de mudanças pendentes no modelo](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) na próxima inicialização, e [registrar o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) é a forma mais rápida de ver qual nome o runtime acha que está consultando.

## Relacionado

- [Como aplicar migrações do EF Core 11 em produção com dotnet ef migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [O EF Core 11 deixa você criar e aplicar uma migração em um único comando](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Fix: o modelo do contexto 'X' tem mudanças pendentes no EF Core 11](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Migrar do EF Core 6 para o EF Core 11: os breaking changes que realmente doem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Como registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Fontes

- [Managing migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) no Microsoft Learn, incluindo o comando `dotnet ef database update --add` adicionado no EF Core 11
- Referência da API [MigrationBuilder.RenameTable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.migrations.migrationbuilder.renametable) para os parâmetros `schema` e `newSchema`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) para a renomeação de constraints e as ressalvas sobre dependências
- [sys.sql_expression_dependencies](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql) para encontrar os objetos que referenciam uma tabela antes de renomeá-la
