---
title: "Migrar do EF Core 6 para o EF Core 11: as mudanças incompatíveis que realmente doem"
description: "Um guia de migração com versões fixadas, do EF Core 6.0 ao EF Core 11.0, percorrendo as mudanças incompatíveis do EF7, 8, 9, 10 e 11 que quebram apps reais: Encrypt=True, Contains com OPENJSON, PendingModelChangesWarning, a coluna json nativa e a divisão do SqlClient 7.0."
pubDate: 2026-06-04
updatedDate: 2026-06-04
template: migration
tags:
  - "migration"
  - "ef-core"
  - "ef-core-6"
  - "ef-core-11"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes"
translatedBy: "claude"
translationDate: 2026-06-04
---

Ir do EF Core 6.0 para o EF Core 11.0 são cinco versões maiores em um único salto, e as partes dolorosas quase nunca são as renomeações de API. São as mudanças silenciosas de comportamento: uma cadeia de conexão que funcionou por anos agora lança um erro de SSL, uma consulta `Contains` que de repente estoura o tempo de espera em um SQL Server antigo, e uma implantação que aborta porque o EF decidiu que seu modelo tem mudanças pendentes. Reserve meio dia para um serviço pequeno e de dois a quatro dias para um monólito com um modelo não trivial, conversores de valor personalizados e um fluxo de scaffolding database-first. Nada disso é uma porta de mão única no nível do banco de dados, mas duas mudanças (o valor padrão de `Encrypt` no EF Core 7 e a exceção de `PendingModelChangesWarning` no EF Core 9) vão impedir sua app de iniciar no primeiro dia se você não planejar para elas.

Este guia fixa `Microsoft.EntityFrameworkCore` 6.0 como origem e 11.0 como destino, rodando sobre .NET 11. Como o piso de target framework do EF Core sobe ao longo do caminho (EF Core 7 precisa de .NET 6, EF Core 8 e 9 precisam de .NET 8, EF Core 10 precisa de .NET 10 e EF Core 11 precisa de .NET 11), esta é também uma migração de runtime. Se você ainda não moveu o runtime, faça isso primeiro usando a [lista de verificação de .NET 8 para .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) e volte.

## Por que migrar agora

- O EF Core 6.0 saiu de suporte em novembro de 2024. Você está rodando uma camada de dados sem suporte contra um runtime com suporte, que é o pior dos dois mundos para uma revisão de segurança.
- O EF Core 11 traz ganhos reais de consulta de graça: a tradução de `Contains` baseada em `OPENJSON` (refinada três vezes desde o EF 8), melhores estimativas de cardinalidade com múltiplos parâmetros escalares e o tipo de coluna `json` nativo do SQL Server com indexação de primeira classe.
- `ExecuteUpdate` e `ExecuteDelete`, adicionados no EF Core 7 e melhorados a cada versão desde então, transformam escritas baseadas em conjuntos em uma única instrução SQL. Se você ainda carrega entidades para mutá-las, está deixando uma ou duas ordens de magnitude na mesa. Veja [ExecuteUpdate versus carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) para o benchmark.
- As barreiras de migração que chegaram no EF 9 (detecção de mudanças pendentes do modelo) e no EF 11 (detecção de ausência de migrações) capturam toda uma classe de incidentes de produção do tipo "o banco de dados e o modelo se desalinharam em silêncio".

## O que quebra

Esta é a lista acumulada ao longo das cinco versões. A severidade é o quão provável é quebrar uma app típica, não o quão difícil é a correção.

| Área | Mudança | Versão | Severidade |
| ---- | ------- | ------ | ---------- |
| Conexões ao SQL Server | `Encrypt` agora vale `true` por padrão; certificados não confiáveis lançam exceção | EF 7 | alta |
| SaveChanges com triggers | O caminho com cláusula OUTPUT quebra em tabelas com triggers ou certas colunas calculadas | EF 7 | alta |
| Relacionamentos opcionais | Dependentes órfãos não são mais excluídos automaticamente ao cortar o relacionamento | EF 7 | média |
| `Contains` sobre uma lista | Traduzido via `OPENJSON`; falha abaixo do SQL Server 2016 / nível de compatibilidade 130 | EF 8 | alta |
| Desempenho de `Contains` | O plano de `OPENJSON` pode regredir muito em algumas cargas de trabalho | EF 8 | alta |
| Enums em colunas JSON | Armazenados como `int` por padrão em vez de `string` | EF 8 | alta |
| Chaves de string no SQL Server | Comparadas sem diferenciar maiúsculas no rastreador de mudanças | EF 8 | média |
| Aplicar migrações | `PendingModelChangesWarning` agora lança exceção em `Migrate()` | EF 9 | alta |
| Migrações em uma transação | Uma transação externa em torno de `Migrate()` agora lança exceção | EF 9 | alta |
| `EF.Constant` / `EF.Parameter` | Lançam `InvalidCastException` dentro de consultas compiladas | EF 9 | baixa |
| Ferramentas do EF, projetos multi-target | `--framework` agora é obrigatório | EF 10 | média |
| Coleções parametrizadas | A tradução padrão agora são múltiplos parâmetros escalares | EF 10 | baixa |
| Armazenamento JSON no SQL Server | O JSON em `nvarchar(max)` migra para o `json` nativo no nível de compatibilidade 170 / Azure SQL | EF 10 | baixa |
| Migrate sem migrações | Lança exceção por padrão em vez de registrar | EF 11 | baixa |
| `Microsoft.Data.SqlClient` 7.0 | As dependências de autenticação Entra ID são separadas em outro pacote | EF 11 | média |

As listas autoritativas por versão estão linkadas no final. Leia as páginas do [EF 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes), [EF 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes) e [EF 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) antes de começar; essas três concentram as mudanças de severidade alta.

## Lista de verificação prévia

1. Mova o runtime para .NET 11 e confirme um `dotnet test` limpo com os pacotes antigos do EF Core 6 primeiro. Você quer que apenas uma variável mude por vez, para que o primeiro vermelho após subir o EF seja inequívoco.
2. Faça o inventário do seu provedor. SQL Server, SQLite, PostgreSQL (Npgsql) e Cosmos têm cada um suas próprias mudanças incompatíveis. Este guia foca em SQL Server e aponta SQLite onde difere.
3. Verifique a versão e o nível de compatibilidade do seu SQL Server. A mudança de `Contains` do EF 8 precisa de nível de compatibilidade 130 ou superior:
   ```sql
   -- run against your target database
   SELECT name, compatibility_level FROM sys.databases;
   ```
4. Procure por `Database.Migrate(` e `MigrateAsync(`. Cada ponto de chamada é candidato à exceção de mudanças pendentes do EF 9 e à exceção de transação explícita do EF 9.
5. Procure por `.HasConversion<string>()` em enums e qualquer propriedade enum mapeada dentro de tipos owned mapeados para JSON. Esses são a mudança de enums em JSON do EF 8.
6. Anote se você usa autenticação Entra ID (Azure AD) em alguma cadeia de conexão (`Authentication=Active Directory Default`, identidade gerenciada, entidade de serviço). Essa é a divisão do SqlClient do EF 11.
7. Crie uma branch para a migração e faça backup do banco de dados. Migrações que alteram o esquema (comprimento máximo do discriminador, `json` nativo) são geradas automaticamente e devem ser revisadas antes de rodar contra produção.

## Passos da migração

1. **Suba todos os pacotes do EF Core para 11.0 de uma vez só.** Não suba uma versão por vez; as mudanças incompatíveis são acumulativas e documentadas por versão, então um único salto com a documentação aberta é mais rápido que cinco compilações intermediárias. Atualize `Microsoft.EntityFrameworkCore`, o provedor (`Microsoft.EntityFrameworkCore.SqlServer`) e `Microsoft.EntityFrameworkCore.Design`. Verifique com `dotnet restore` e `dotnet build`, e trate os primeiros erros de compilação como o escopo real.
   ```xml
   <!-- src/MyApp.csproj, EF Core 11 on .NET 11 -->
   <ItemGroup>
     <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0" PrivateAssets="all" />
   </ItemGroup>
   ```

2. **Atualize a ferramenta `dotnet ef` para uma versão maior correspondente.** A ferramenta 6.x não consegue ler um modelo 11.0. Verifique com `dotnet ef --version` e confirme `11.0.x`.
   ```bash
   dotnet tool update --global dotnet-ef --version 11.*
   ```

3. **Corrija o valor padrão `Encrypt=True` antes de qualquer coisa.** Esta é a mudança do EF Core 7 que vive no `Microsoft.Data.SqlClient`, não no EF, então não há interruptor do lado do EF. Em uma máquina de desenvolvimento sem um certificado de servidor confiável, sua primeira conexão lança um erro de SSL. Para desenvolvimento local, adicione `TrustServerCertificate=True`; em produção, instale um certificado válido. Verifique abrindo uma conexão: `dotnet ef dbcontext info` deve conectar sem um erro de provedor SSL.
   ```text
   Server=localhost;Database=App;Trusted_Connection=True;TrustServerCertificate=True
   ```

4. **Trate as barreiras de migração em cada chamada a `Migrate()`.** O EF Core 9 lança `PendingModelChangesWarning` se o modelo difere da última migração, e o EF Core 11 lança `MigrationsNotFound` se não há migração alguma. Se você gerencia o esquema com migrações, a correção é adicionar a migração faltante. Se você gerencia o esquema de outra forma (Dapper, DACPAC, SQL escrito à mão) e só chama `Migrate()` por hábito, remova a chamada ou suprima as advertências. Verifique rodando `dotnet ef migrations has-pending-model-changes` e obtendo um resultado limpo.
   ```csharp
   // EF Core 11. Only suppress if you intentionally manage schema elsewhere.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.ConfigureWarnings(w =>
       {
           w.Ignore(RelationalEventId.PendingModelChangesWarning);
           w.Ignore(RelationalEventId.MigrationsNotFound);
       });
   ```

5. **Remova qualquer transação explícita que envolva o `Migrate()`.** O padrão comum de "migração resiliente" (iniciar transação, migrar, confirmar, dentro de uma estratégia de execução) lança `MigrationsUserTransactionWarning` no EF Core 9 porque o EF agora gerencia a transação e o bloqueio do banco de dados por conta própria. Apague o invólucro e chame `MigrateAsync` diretamente. Verifique que a app inicia e aplica as migrações uma vez.
   ```csharp
   // EF Core 9+. EF manages the transaction and execution strategy.
   await dbContext.Database.MigrateAsync(cancellationToken);
   ```

6. **Confirme o nível de compatibilidade do SQL Server para a mudança de `Contains`.** Se `sys.databases` reportar um nível abaixo de 130, a tradução `OPENJSON` do EF Core 8 falhará em tempo de execução. Suba o nível se puder, ou fixe o modo de tradução. Verifique rodando uma consulta que usa `.Where(x => list.Contains(x.Id))` e confirmando um SQL válido.
   ```csharp
   // EF Core 10+: pick the translation strategy explicitly.
   // Constant = pre-EF8 inlining, Parameter = OPENJSON, MultipleParameters = EF10 default.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.UseSqlServer(connectionString,
           o => o.UseParameterizedCollectionMode(ParameterTranslationMode.MultipleParameters));
   ```

7. **Fixe o armazenamento de enums em JSON se você depende dos valores de string.** O EF Core 8 mudou os enums dentro de tipos owned mapeados para JSON de strings para inteiros. Documentos existentes escritos pelo EF 6 contêm strings; após a atualização o EF os lê como inteiros e falha. Force a conversão para string para manter os dados antigos legíveis. Verifique fazendo um round-trip de uma entidade com uma propriedade enum em uma coluna JSON.
   ```csharp
   protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
       => configurationBuilder.Properties<OrderStatus>().HaveConversion<string>();
   ```

8. **Adicione uma migração para as mudanças de esquema que o EF agora quer.** O EF Core 8 dá às colunas de discriminador de TPH um comprimento máximo limitado, e o EF Core 10 mapeia as colunas JSON para o tipo `json` nativo no Azure SQL ou no nível de compatibilidade 170. Gere a migração, leia-a e só então aplique-a. Verifique com uma revisão das operações `AlterColumn` geradas.
   ```bash
   dotnet ef migrations add UpgradeToEfCore11
   dotnet ef migrations script --idempotent --output migrate.sql
   ```

9. **Separe a autenticação Entra ID se você a usa.** O EF Core 11 passa para o `Microsoft.Data.SqlClient` 7.0, que remove as dependências de autenticação do Azure do pacote principal. Se uma cadeia de conexão usa autenticação `Active Directory`, adicione o pacote de extensões. Verifique conectando com a identidade gerenciada em um ambiente implantado, não apenas localmente.
   ```xml
   <PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.0" />
   ```

## Verificação

Rode este teste de fumaça após a migração, em ordem:

1. `dotnet build` está limpo, incluindo a resolução da referência a `Microsoft.EntityFrameworkCore.Design` (as ferramentas do EF 11 não a trazem mais transitivamente).
2. `dotnet ef migrations has-pending-model-changes` reporta que não há mudanças pendentes.
3. A app inicia e `Migrate()` (se você o chama) é aplicado de forma limpa, sem `PendingModelChangesWarning` nem `MigrationsNotFound`.
4. `dotnet test` está verde. Preste atenção aos testes que afirmam sobre strings de SQL geradas; as traduções de `Contains` e de coleções parametrizadas mudaram, então as asserções de snapshot precisarão ser atualizadas.
5. Rode uma consulta que filtra por um `Contains` sobre uma lista e confirme que ela executa, não apenas que compila.
6. Verifique pontualmente uma entidade mapeada para JSON com um enum, e uma entidade com chave de string usada em um relacionamento, para confirmar valores corretos.

## Plano de reversão

As mudanças de pacotes e de código são reversíveis: reverta a branch, restaure os pacotes do EF Core 6.0 e baixe a ferramenta `dotnet-ef`. O risco é a migração de esquema do passo 8. As alterações de comprimento máximo do discriminador e de `json` nativo mudam o banco de dados, e o EF Core 6.0 não conhecerá uma migração carimbada pelo EF Core 11. Se você precisa poder reverter o runtime depois de aplicar essa migração, gere primeiro um script de reversão (`dotnet ef migrations script UpgradeToEfCore11 PreviousMigration`) e guarde-o com o release. Sem esse script, a mudança de esquema é efetivamente de mão única para um binário do EF 6.

## Tropeços que tivemos

**O timeout de `Contains` é o mais traiçoeiro.** A consulta compila, retorna resultados corretos e passa em todos os testes com um conjunto de dados pequeno. Depois uma tabela de produção com milhões de linhas bate no plano de `OPENJSON` e a consulta estoura o tempo de espera. A equipe do EF refinou isso três vezes: o EF 8 introduziu `OPENJSON`, o EF 9 adicionou `TranslateParameterizedCollectionsToConstants` e o EF 10 mudou o padrão para múltiplos parâmetros escalares. Se você vê uma regressão, a válvula de escape por consulta é `EF.Constant(list).Contains(...)` para embutir os valores naquela única consulta, deixando o padrão global intacto. O [guia de detecção de N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) e o [guia de divisão de consultas](/pt-br/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) cobrem as armadilhas de forma de consulta adjacentes que vale a pena revisar na mesma passada.

**Chaves de string sem diferenciação de maiúsculas mudam a correspondência em silêncio.** O EF Core 8 fez o provedor do SQL Server comparar os valores de chaves de string sem diferenciar maiúsculas no rastreador de mudanças, para corresponder a como o SQL Server compara chaves estrangeiras. Se seu código dependia de `"ABC"` e `"abc"` serem chaves distintas na memória, o rastreador de mudanças agora as trata como a mesma entidade. A correção é um `ValueComparer` personalizado que diferencie maiúsculas nessas chaves, mas primeiro confirme que você realmente depende disso; a maioria das apps quer o novo comportamento.

**A exceção de mudanças pendentes dispara com dados de seed dinâmicos.** Um modelo que faz seed com `HasData` usando `DateTime.UtcNow` ou `Guid.NewGuid()` parece "modificado" para o EF a cada compilação, então o EF 9 lança `PendingModelChangesWarning` mesmo que você não tenha mudado nada. Substitua os valores dinâmicos por constantes estáticas no seed, ou passe para o padrão de seeding do EF 9. Este é fácil de diagnosticar errado como um bug de migração real.

**A saída do scaffolding database-first muda de forma.** Se você refaz o scaffolding a partir do banco de dados, o EF 8 agora gera `DateOnly` e `TimeOnly` para colunas `date` e `time`, remove o invólucro anulável em colunas booleanas com um valor padrão e nomeia as navegações de forma diferente para chaves estrangeiras compostas. Nenhuma dessas quebra uma app em execução, mas produzem um diff grande e ruidoso que é fácil confundir com um erro. Refaça o scaffolding em seu próprio commit para que o diff seja revisável.

Cinco versões maiores soa mais pesado do que é. Duas mudanças vão parar sua app no ato na primeira execução (o valor padrão de `Encrypt` e a exceção de migração), e uma é uma armadilha latente de desempenho (a tradução de `Contains`). Planeje para essas três, gere e leia a única migração de esquema, e o resto são subidas de pacotes e uma passada de testes em verde. Para o lado mais amplo do runtime da mesma atualização, a [lista de verificação de .NET 8 para .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) cobre as mudanças de framework, ASP.NET Core e C# 14 que viajam junto a esta.

## Fontes

- [Breaking changes in EF Core 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes)
- [Breaking changes in EF Core 8.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes)
- [Breaking changes in EF Core 9.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [Breaking changes in EF Core 10.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Breaking changes in EF Core 11.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md)
