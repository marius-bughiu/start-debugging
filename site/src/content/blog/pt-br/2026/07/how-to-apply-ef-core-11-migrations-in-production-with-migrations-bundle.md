---
title: "Como aplicar migrações do EF Core 11 em produção com dotnet ef migrations bundle"
description: "Um guia completo para implantar mudanças de esquema do EF Core 11 com bundles de migração: compilar o efbundle no CI, a armadilha do appsettings.json com strings de conexão nomeadas, bundles self-contained e o RID musl do Alpine, o bloqueio de migração desde o EF Core 9, reverter com uma migração alvo e por que transações por migração não salvam você no MySQL."
pubDate: 2026-07-28
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
  - "devops"
lang: "pt-br"
translationOf: "2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle"
translatedBy: "claude"
translationDate: 2026-07-28
---

Para aplicar migrações do EF Core 11 em um banco de dados de produção, compile um bundle de migração no CI com `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle`, publique esse único executável como artefato de build e execute-o como uma etapa própria de implantação com `./efbundle --connection "$CONNECTION_STRING"`. O bundle carrega suas migrações compiladas e o runtime do EF Core dentro de um único arquivo. A máquina que o executa não precisa do SDK do .NET, nem da ferramenta `dotnet-ef`, nem de acesso ao seu código-fonte, e sua aplicação nunca precisa de permissão para alterar o esquema no banco de dados. Este artigo tem como alvo o EF Core 11 e o .NET 11 (preview 6 no momento em que escrevo, GA em novembro de 2026) com C# 14. Bundles existem desde o EF Core 6, então tudo aqui funciona do EF Core 6 ao 11, e eu sinalizo os pisos de versão em que o comportamento difere.

## O que realmente está errado nas outras três estratégias

Todo time .NET acaba escolhendo uma de quatro formas de levar mudanças de esquema para produção, e três delas têm um modo de falha que só aparece sob carga ou sob pressão.

**Chamar `Database.Migrate()` na inicialização** é a que mais dói. A própria orientação da Microsoft a classifica como inadequada para produção, e as razões se acumulam: seu processo de aplicação precisa de `db_ddladmin` ou equivalente para sempre, não só durante implantações; a migração roda sem nenhum humano olhando o SQL; e reverter significa publicar um build novo. Desde o EF Core 9 o risco de concorrência pelo menos foi tratado, porque `Migrate()` e `MigrateAsync()` adquirem um bloqueio no nível do banco de dados antes de aplicar qualquer coisa, então dez réplicas subindo ao mesmo tempo se serializam em vez de corromperem umas às outras. Isso resolveu o pior sintoma, mas nenhum dos problemas estruturais.

**Rodar `dotnet ef database update` no agente de implantação** significa instalar o SDK do .NET e a ferramenta `dotnet-ef` nesse agente, baixar o código-fonte e compilar o projeto só para aplicar um `CREATE INDEX`. Se esse agente é sua máquina de produção, você acabou de colocar um compilador nela.

**Gerar um script SQL** com `dotnet ef migrations script --idempotent` é a estratégia que a Microsoft ainda recomenda primeiro, e ela tem uma vantagem real: um DBA pode lê-lo antes de rodar. O custo é que agora você precisa de uma ferramenta para executá-lo e, como o time do EF coloca na documentação, o tratamento de transações e o comportamento de continuar-após-erro dessas ferramentas é inconsistente e às vezes inesperado. O `sqlcmd` vai alegremente seguir em frente depois que a instrução 40 de 120 falhar, deixando seu esquema em algum ponto entre duas migrações sem registro de onde.

Bundles eliminam essa classe de problema: o executável aplica as migrações pelo mesmo caminho de código do EF Core que o `dotnet ef database update`, com a mesma semântica transacional, e ou reporta sucesso ou retorna um código de saída diferente de zero.

## O pipeline de quatro etapas

Este é o formato completo da implantação, e o resto do artigo detalha cada etapa.

1. **Verifique se o modelo e as migrações concordam.** Rode `dotnet ef migrations has-pending-model-changes` no CI. Ele sai com código diferente de zero se alguém mudou uma entidade e esqueceu de rodar `migrations add`.
2. **Compile o bundle uma única vez**, no CI, a partir do mesmo commit que produziu os binários da sua aplicação: `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle --force`.
3. **Publique o `efbundle` como artefato de build**, junto com qualquer `appsettings.json` de que ele precise.
4. **Execute-o como uma etapa de implantação separada**, antes de a nova versão da aplicação começar a atender: `./efbundle --connection "$CONNECTION_STRING"`.

## Compilando o bundle

O comando é de tempo de design, então ele precisa que o projeto de inicialização referencie `Microsoft.EntityFrameworkCore.Design` e de uma instalação funcional do `dotnet ef`:

```bash
# EF Core 11, .NET 11
dotnet tool install --global dotnet-ef
dotnet ef migrations bundle
```

```output
Build started...
Build succeeded.
Building bundle...
Done. Migrations Bundle: /src/App.Api/efbundle
```

Por padrão a saída fica ao lado do projeto de inicialização e se chama `efbundle` (`efbundle.exe` no Windows), compilada para o RID da máquina que está compilando. As opções são poucas o bastante para listar por completo:

| Opção | Curta | O que faz |
| --- | --- | --- |
| `--output <FILE>` | `-o` | Caminho do executável a criar. |
| `--force` | `-f` | Sobrescreve um bundle existente. |
| `--self-contained` | | Empacota também o runtime do .NET, para a máquina de destino não precisar tê-lo instalado. |
| `--target-runtime <RID>` | `-r` | O identificador de runtime para o qual compilar. |

Mais as opções habituais de tempo de design: `--project`, `--startup-project`, `--context`, `--configuration`, `--framework`, `--no-build`.

Em uma solução real o contexto vive em uma biblioteca de classes e o host fica em outro lugar, então o CI roda algo mais parecido com isto:

```bash
# EF Core 11, .NET 11 - context in a class library, host in the API project
dotnet ef migrations bundle \
  --project src/App.Infrastructure \
  --startup-project src/App.Api \
  --context AppDbContext \
  --configuration Release \
  --self-contained -r linux-x64 \
  -o ./artifacts/efbundle \
  --force
```

O EF Core 11 permite parar de repetir quase tudo isso. Coloque um arquivo `.config/dotnet-ef.json` na raiz do repositório e o `dotnet ef` sobe pela árvore de diretórios a partir do diretório de trabalho até encontrá-lo:

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "context": "AppDbContext",
  "configuration": "Release"
}
```

Opções explícitas de linha de comando continuam vencendo o arquivo, então um desenvolvedor pode sobrescrever qualquer uma delas localmente. Isso é novo no EF Core 11 e é a melhor razão isolada para atualizar a ferramenta nos seus agentes de build.

## O que o bundle faz em tempo de execução

Execute o binário e ele aplica toda migração do assembly que ainda não esteja registrada em `__EFMigrationsHistory`:

```bash
./efbundle --connection "Server=prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true"
```

```output
Applying migration '20260721104512_AddOrderIndexes'.
Applying migration '20260726091133_AddCustomerTier'.
Done.
```

Execute uma segunda vez e ele não faz nada, que é exatamente o que você quer de uma etapa de implantação que pode ser repetida:

```output
No migrations were applied. The database is already up to date.
Done.
```

Toda a superfície dele é um argumento e quatro opções. O argumento é a migração alvo: passe um nome ou ID de migração para subir ou **descer** até aquele ponto, e passe `0` para reverter todas as migrações. As opções são `--connection`, `--verbose` (`-v`), `--no-color` e `--prefix-output`. É só isso. Não existe opção `--timeout`, e é por isso que a criação demorada de um índice em uma tabela grande precisa de `Command Timeout=600` dentro da própria string de conexão; cobri esse modo de falha em detalhe ao escrever sobre [o timeout que mata as migrações do EF Core no meio da implantação](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

Vale a pena ligar `--prefix-output` no CI: ele marca cada linha com a severidade, o que dá ao seu agregador de log algo para filtrar.

## A armadilha do appsettings.json

Esta é a falha que custa uma tarde aos times, e não é óbvia na documentação.

Se seu `DbContext` está configurado com uma string de conexão **nomeada**, por exemplo `optionsBuilder.UseSqlServer("name=ConnectionStrings:DefaultConnection")`, o bundle ainda precisa de um `appsettings.json` no diretório de trabalho contendo essa chave. Mesmo quando você passa `--connection` na linha de comando. Sem ele você recebe:

```output
A named connection string was used, but the name 'ConnectionStrings:DefaultConnection'
was not found in the application's configuration. Note that named connection strings
are only supported when using 'IConfiguration' and a service provider, such as in a
typical ASP.NET Core application.
```

O valor nesse arquivo é irrelevante, porque `--connection` o sobrescreve; a *chave* só precisa existir para o binding de configuração funcionar. Isso foi reportado como [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) e fechado como não planejado, então planeje em torno disso em vez de esperar uma correção. Duas saídas:

- Envie um `appsettings.json` de fachada junto ao bundle no seu artefato, com um valor de placeholder sob a chave esperada.
- Ou pare de usar uma string de conexão nomeada no caminho de tempo de design, para o bundle não ter nada a resolver.

A documentação do EF Core também é direta sobre o caso geral: não esqueça de copiar o `appsettings.json` junto ao seu bundle, porque o bundle depende da presença dele no diretório de execução. Se sua configuração é separada por ambiente, defina `ASPNETCORE_ENVIRONMENT` (ou `DOTNET_ENVIRONMENT` para um host que não seja web) antes de executar o bundle e copie também o `appsettings.Production.json` correspondente. O bundle não tem uma opção `--environment` própria.

Minha preferência é contornar a configuração por completo: passe a string de conexão inteira com `--connection`, vinda do seu cofre de segredos no momento da implantação, e mantenha um `appsettings.json` de fachada só para satisfazer o binder. Isso torna o bundle uma função pura dos seus argumentos, que é o que você quer quando o mesmo artefato é promovido de staging para produção.

## Bundles self-contained e a pegadinha do Alpine

`--self-contained -r linux-x64` produz um executável que carrega o runtime do .NET consigo. Esse é o padrão certo para implantações em contêiner, porque significa que sua etapa de migração pode rodar em uma imagem mínima sem nenhum .NET instalado.

O RID precisa combinar com a libc do destino, não apenas com a arquitetura. Um bundle self-contained `linux-x64` tem glibc como alvo e não vai rodar no Alpine nem em nenhuma outra imagem baseada em musl; ali você quer `linux-musl-x64`. A falha é um confuso "not found" ou um erro do loader em vez de uma mensagem clara, então fixe o RID deliberadamente:

```bash
# EF Core 11, .NET 11 - for an Alpine-based runner
dotnet ef migrations bundle --self-contained -r linux-musl-x64 -o ./artifacts/efbundle --force
```

Globalização é a segunda pedra no caminho do Alpine. Um bundle self-contained espera ICU, e imagens Alpine precisam do `icu-libs` instalado. Adicionar `apk add --no-cache icu-libs` à imagem de migração sai mais barato do que depurar `Couldn't find a valid ICU package installed on the system` dentro de uma janela de implantação.

Se sua máquina de produção já tem o runtime do .NET correspondente, tire o `--self-contained` e ganhe um artefato bem menor. Em um init container do Kubernetes ou em um Job que roda antes do rollout, a versão self-contained normalmente vence de qualquer forma, porque desacopla a etapa de migração da versão de runtime da imagem da sua aplicação. O mesmo raciocínio vale quando você está [construindo a imagem da aplicação com `dotnet publish /t:PublishContainer`](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/): mantenha a etapa de esquema e a etapa de aplicação como artefatos separados.

## O bloqueio de migração e o que ele não cobre

Desde o EF Core 9, aplicar migrações adquire primeiro um bloqueio no nível do banco de dados. Isso vale para `dotnet ef database update`, para `Update-Database`, para `Migrate()` e `MigrateAsync()`, e para bundles de migração. O bloqueio é mantido durante toda a operação, incluindo qualquer código de seed que rode como parte dela, então se você faz seed com [`UseSeeding` e `UseAsyncSeeding`](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) esse trabalho também fica coberto.

O que o bloqueio **não** cobre são scripts SQL, porque eles executam totalmente fora do EF Core. Se metade do seu pipeline roda um bundle e a outra metade um script gerado, você não tem exclusão mútua entre os dois. Escolha um.

O mecanismo de bloqueio é específico do provedor e tem arestas. No SQLite ele é implementado com uma tabela de bloqueio que pode ficar abandonada se o processo morrer no meio da migração, o que depois bloqueia toda migração seguinte até você limpar na mão. Isso importa se você roda testes de integração contra SQLite e mata o host de testes.

Há mais uma limitação que vale conhecer antes de desenhar em torno disso: você não pode envolver `MigrateAsync` em uma transação explícita. Desde o EF Core 9 isso lança exceção.

## Transações são por migração, não por bundle

Uma leitura errada comum é que um bundle aplica todas as migrações pendentes atomicamente. Não aplica. O EF Core envolve **cada migração** na própria transação. Três migrações pendentes significam três transações. Se a segunda falhar, a primeira fica aplicada e registrada em `__EFMigrationsHistory`, e a terceira nunca roda.

Esse geralmente é o comportamento que você quer, já que reexecutar o bundle retoma exatamente de onde parou. Mas significa que "a implantação falhou, reverta o banco" não é uma operação única, e você deveria raciocinar sobre os estados intermediários que seu esquema pode ocupar.

Duas ressalvas específicas de provedor deixam isso mais nítido:

- Em bancos sem DDL transacional, notavelmente o MySQL, uma migração que falha pode deixar mudanças de esquema parciais sem rollback nenhum. Cada instrução DDL faz commit implícito. No MySQL, trate toda migração como se fosse não transacional e mantenha as migrações pequenas o bastante para raciocinar sobre elas na mão.
- Algumas operações não podem rodar dentro de uma transação nem no SQL Server nem no PostgreSQL, por exemplo criar um índice de forma concorrente. Para essas, passe `suppressTransaction: true` para `migrationBuilder.Sql(...)` e aceite que a instrução não fica coberta.

```csharp
// EF Core 11, C# 14 - a statement that must not run inside the migration transaction
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql(
        "CREATE INDEX CONCURRENTLY IX_Orders_CustomerId ON \"Orders\" (\"CustomerId\");",
        suppressTransaction: true);
}
```

## Revertendo

O bundle recebe uma migração alvo como argumento posicional, e migrar "para baixo" é o mesmo comando com um alvo anterior:

```bash
# EF Core 11 - revert to the state right after AddOrderIndexes
./efbundle 20260721104512_AddOrderIndexes

# EF Core 11 - revert everything. Read that twice before running it.
./efbundle 0
```

Para isso funcionar, o bundle que você executa precisa *conter* as migrações para as quais você está revertendo, o que é um argumento a favor de guardar todo artefato de bundle já implantado e não apenas o último. Os métodos `Down` também precisam estar corretos, e eles são o código menos testado na maioria dos repositórios. Um `Down` que remove uma coluna não é um rollback; é perda de dados com etapas extras. Essa é exatamente a revisão que gerar um script compra para você, e nada impede de produzir os dois artefatos no CI: rode o bundle no pipeline e anexe `dotnet ef migrations script --idempotent -o schema.sql` ao mesmo build para o DBA ler.

## Pegando o descompasso antes da implantação

Desde o EF Core 9, `Migrate()` lança exceção quando o modelo tem mudanças pendentes em relação à última migração (`RelationalEventId.PendingModelChangesWarning`). Você não quer descobrir isso durante uma implantação. Coloque a verificação no CI:

```bash
# EF Core 11 - fails the build if an entity changed without a migration
dotnet ef migrations has-pending-model-changes \
  --project src/App.Infrastructure \
  --startup-project src/App.Api
```

O comando foi adicionado no EF Core 8 e sai com código diferente de zero quando o modelo e as migrações divergiram. Combine com a compilação do bundle no mesmo job, para que o artefato e a verificação venham de um único commit.

Enquanto você endurece o pipeline, dois modos de falha relacionados valem ser antecipados: o `dotnet ef` precisando de uma fábrica de tempo de design quando [ele não consegue criar seu DbContext](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), e as mudanças de comportamento que mordem ao [atualizar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Onde `database update --add` se encaixa e onde não

O EF Core 11 adicionou `dotnet ef database update <NAME> --add`, que gera uma migração e a aplica em um único comando, usando Roslyn para compilar a migração em tempo de execução. É uma ferramenta de ciclo interno genuinamente boa, e escrevi sobre [o fluxo de migração em uma etapa](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) quando ele chegou. Também é exatamente o oposto do que você quer em produção: gera e aplica mudanças de esquema sem artefato e sem etapa de revisão no meio. Use enquanto prototipa e guarde o bundle para qualquer coisa com dados reais por trás. O mesmo vale para as outras adições de ferramenta do EF Core 11, `--connection` em `database drop` e `migrations remove` e `--offline` em `migrations remove`: conveniências do ciclo de desenvolvimento, não ferramentas de implantação.

Se um bundle aplica migrações e algo parece errado depois, reproduza localmente com o log aumentado, o que é questão de [fazer o EF Core 11 registrar o SQL que ele gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) contra uma cópia descartável do esquema.

## Relacionados

- [Fix: SqlException Timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add falha com "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Migrar do EF Core 6 para o EF Core 11: as mudanças incompatíveis que realmente mordem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [O EF Core 11 deixa você criar e aplicar uma migração em um único comando](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Como publicar um app .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Fontes

- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) cobre as quatro estratégias de implantação, as tabelas de argumento e opções do `efbundle` e o bloqueio de migração.
- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) é a autoridade sobre as opções do `dotnet ef migrations bundle` e o novo arquivo de configuração `.config/dotnet-ef.json` do EF Core 11.
- [Introducing DevOps-friendly EF Core Migration Bundles](https://devblogs.microsoft.com/dotnet/introducing-devops-friendly-ef-core-migration-bundles/) é o anúncio original e explica a intenção do design.
- [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) documenta a exigência de `appsettings.json` para strings de conexão nomeadas, fechado como não planejado.
- [Managing Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) descreve as transações por migração e `suppressTransaction`.
- [SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations) cobre os bloqueios de migração abandonados.
