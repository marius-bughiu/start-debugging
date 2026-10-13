---
title: "Correção: conflito de versão NU1608 / NU1107 entre Pomelo.EntityFrameworkCore.MySql e EF Core 10"
description: "O Pomelo 9.0.0 só aceita EF Core Relational 9.0.x e não tem build para EF Core 10. Mantenha todos os pacotes do EF Core em 9.0.x ou troque para Microting.EntityFrameworkCore.MySql 10.0.x. Suprimir o aviso derruba o app na inicialização."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "dotnet-10"
  - "nuget"
  - "mysql"
lang: "pt-br"
translationOf: "2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10"
translatedBy: "claude"
translationDate: 2026-10-13
---

**Resposta curta:** `Pomelo.EntityFrameworkCore.MySql` 9.0.0 ainda é a versão mais recente no nuget.org (outubro de 2026) e declara `Microsoft.EntityFrameworkCore.Relational` como `[9.0.0, 9.0.999]`. Qualquer pacote do EF Core 10 no grafo ou colide com esse intervalo (`NU1107`, um erro de restore) ou prevalece sobre ele (`NU1608`, um aviso). Não existe build do Pomelo para EF Core 10, nem mesmo no feed nightly. Você tem duas opções que funcionam: manter todos os pacotes do EF Core e do Identity em 9.0.x (rodam bem em `net10.0`), ou trocar o Pomelo pelo fork `Microting.EntityFrameworkCore.MySql` 10.0.x. Não use `NoWarn` para o `NU1608`: o app compila e depois morre dentro de `UseMySql` com uma `MissingMethodException`.

Tudo abaixo foi reproduzido no macOS com .NET SDK 10.0.302, EF Core 10.0.13 e 9.0.21, Pomelo 9.0.0, Microting 10.0.12 e o `MySql.EntityFrameworkCore` 10.0.9 da Oracle.

## O erro em contexto

Você recebe uma de duas formas, dependendo de qual pacote do EF Core 10 foi adicionado. Se outra coisa traz o EF Core 10 de forma transitiva, tipicamente `Microsoft.EntityFrameworkCore.Design` ou o ASP.NET Core Identity, o restore falha de vez:

```text
error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 10.0.13 directly to project App to resolve this issue.
error NU1107:  App -> Microsoft.EntityFrameworkCore.Design 10.0.13 -> Microsoft.EntityFrameworkCore.Relational (>= 10.0.13)
error NU1107:  App -> Pomelo.EntityFrameworkCore.MySql 9.0.0 -> Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999).
```

Se você seguir esse conselho e referenciar `Microsoft.EntityFrameworkCore.Relational` 10.0.13 diretamente, o erro vira um aviso, porque uma referência direta sempre vence um intervalo transitivo:

```text
warning NU1608: Detected package version outside of dependency constraint: Pomelo.EntityFrameworkCore.MySql 9.0.0 requires Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999) but version Microsoft.EntityFrameworkCore.Relational 10.0.13 was resolved.
```

E isto é o que esse build "corrigido" faz em tempo de execução, logo na primeira linha que configura o contexto:

```text
Unhandled exception. System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NullButNotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.MySqlDbContextOptionsBuilderExtensions.UseMySql(DbContextOptionsBuilder optionsBuilder, String connectionString, ServerVersion serverVersion, Action`1 mySqlOptionsAction)
```

A mensagem do NuGet literalmente manda você fazer a coisa que produz o crash. É por isso que esse erro continua aparecendo nos issue trackers meses depois do lançamento do .NET 10.

## Por que isso acontece

Os providers do EF Core são compilados contra os internals de uma versão major do EF Core. O Pomelo codifica isso no nuspec com um limite superior:

```xml
<!-- Pomelo.EntityFrameworkCore.MySql 9.0.0 nuspec -->
<group targetFramework="net8.0">
  <dependency id="Microsoft.EntityFrameworkCore.Relational" version="[9.0.0, 9.0.999]" include="All" />
  <dependency id="MySqlConnector" version="2.4.0" exclude="Build,Analyzers" />
</group>
```

O NuGet resolve uma versão de cada pacote por projeto. Quando dois caminhos no grafo discordam:

- **Ambos transitivos, intervalos que não se sobrepõem** (`Design 10 -> Relational >= 10.0.13` contra `Pomelo -> Relational <= 9.0.999`): o NuGet não consegue escolher e falha com `NU1107`.
- **Uma referência direta vence** (você mesmo referencia Relational 10.0.13, ou o Central Package Management o fixa): o NuGet respeita a versão direta e avisa com `NU1608` que a restrição do Pomelo foi violada.

O limite superior não é paranoia. O Pomelo 9.0.0 chama helpers como `Check.NullButNotEmpty`, que no EF Core 9 encaminham para `AbstractionsStrings.ArgumentIsEmpty(object)`. O EF Core 10 mudou esses métodos internos de recursos, então o IL do assembly do Pomelo aponta para um método que não existe mais. O JIT só descobre isso na primeira vez que o método é chamado, e é por isso que o build fica verde e o crash acontece na inicialização.

O motivo de isso ainda ser um problema em outubro de 2026, quase um ano depois do EF Core 10 chegar ao GA: a [issue de acompanhamento do EF Core 10 no Pomelo, #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007), está aberta com mais de 120 reações, o último comentário de um mantenedor (outubro de 2025) prometeu um release "em breve", e vários PRs da comunidade para o EF Core 10 continuam sem merge. Conferi tanto a listagem do nuget.org quanto o feed nightly do Azure DevOps do Pomelo: o build mais novo em qualquer um deles é um pacote de CI `9.0.1-servicing` de agosto de 2025. Não há nada 10.x para atualizar.

## Repro mínimo

Três projetos `net10.0`, cada um com Pomelo 9.0.0 mais um pacote do EF Core 10:

```xml
<!-- .NET SDK 10.0.302. Swap the second reference to get each outcome. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
    <!-- NU1107: -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13" />
    <!-- NU1107 too: Microsoft.AspNetCore.Identity.EntityFrameworkCore 10.0.13 -->
    <!-- NU1608 + crash: Microsoft.EntityFrameworkCore.Relational 10.0.13 -->
    <!-- No warning at all + crash: Microsoft.EntityFrameworkCore 10.0.13 -->
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 9.0.x or 10.0.x depending on the graph above
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<Shop>()
    .UseMySql("Server=localhost;Database=shop;User=root;Password=x",
              new MySqlServerVersion(new Version(8, 4, 0)))
    .Options;

using var db = new Shop(options);
Console.WriteLine(db.Orders.Where(o => o.Total > 10m).ToQueryString());

public class Order { public int Id { get; set; } public decimal Total { get; set; } }
public class Shop(DbContextOptions<Shop> o) : DbContext(o)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

A última variante dessa lista merece um alerta próprio. Se você adicionar `Microsoft.EntityFrameworkCore` 10.0.13 (não o Relational), o restore é silencioso. `Microsoft.EntityFrameworkCore.Relational` 9.0.0 só diz `Microsoft.EntityFrameworkCore >= 9.0.0`, sem limite superior, então o NuGet resolve alegremente o EF Core 10.0.13 ao lado do Relational 9.0.0. O `dotnet nuget why` mostra isso:

```text
[net10.0]
 └── Pomelo.EntityFrameworkCore.MySql (v9.0.0)
     └── Microsoft.EntityFrameworkCore.Relational (v9.0.0)
```

Sem `NU1608`, sem `NU1107`, e exatamente a mesma `MissingMethodException` em tempo de execução. Se você está vendo essa exceção sem nenhum aviso do NuGet, é por isso.

## Correção, em detalhe

### 1. Encontre todos os pacotes que trazem o EF Core 10

Antes de mudar qualquer coisa, descubra quem pediu o 10.x. Em um projeto que faz restore (o caso do `NU1608`), o `dotnet nuget why` mostra o caminho:

```bash
dotnet nuget why src/App/App.csproj Microsoft.EntityFrameworkCore.Relational
```

Em um projeto preso no `NU1107`, o próprio erro lista os dois caminhos. Os suspeitos de sempre em um app `net10.0`:

- `Microsoft.EntityFrameworkCore.Design` e `Microsoft.EntityFrameworkCore.Tools`, atualizados pelo Dependabot ou pelo Renovate.
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore`, porque o template do Identity usa a versão do framework (10.0.x).
- `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`, `Microsoft.EntityFrameworkCore.InMemory` ou `.Sqlite` em um projeto de testes que referencia o app.
- Uma biblioteca de terceiros que já migrou para o EF Core 10 (extensões de bulk, auditoria, multi-tenancy).
- Um `Directory.Packages.props` que fixa todos os pacotes `Microsoft.EntityFrameworkCore.*` em uma única propriedade de versão compartilhada.

Esse último é a armadilha do Central Package Management: um único `$(EfCoreVersion)` atualizado para 10.0.x transforma silenciosamente um Relational transitivo em um fixado, então você recebe `NU1608` em vez de `NU1107` e perde a parada forçada.

### 2. Opção A: ficar no EF Core 9.0.x no .NET 10

O EF Core 9 tem como alvo `net8.0`, então roda no runtime do .NET 10 sem reclamar. Fixe todos os pacotes do EF Core, mais o Identity se você o usa, no mesmo patch 9.0.x:

```xml
<!-- .NET 10 app, EF Core 9.0.21, Pomelo 9.0.0 -->
<ItemGroup>
  <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.21">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
  <PackageReference Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="9.0.21" />
</ItemGroup>
```

Com o Central Package Management, separe a propriedade para que o mundo do provider fique explícito:

```xml
<!-- Directory.Packages.props, .NET 10 solution with Pomelo 9.0.0 -->
<PropertyGroup>
  <!-- Pomelo 9.0.0 caps Relational at 9.0.999. Do not bump until the provider moves. -->
  <EfCoreVersion>9.0.21</EfCoreVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
</ItemGroup>
```

Executei o programa do repro com esse grafo em `net10.0`: o EF Core e o Relational reportam `9.0.21.0`, a construção do modelo, `ToQueryString()` e `GenerateCreateScript()` funcionam, e o projeto com Identity 9.0.21 faz restore e roda sem problemas. Diga ao Dependabot para deixar a linha 9.x em paz (uma regra `ignore` para `Microsoft.EntityFrameworkCore*` com `update-types: ["version-update:semver-major"]`), ou ele vai reabrir o mesmo PR toda semana.

O problema é o calendário. O EF Core 9 acompanha a janela de suporte STS do .NET 9, que termina em [10 de novembro de 2026](https://dotnet.microsoft.com/platform/support/policy/dotnet-core). Depois dessa data não há patches de segurança para os pacotes do EF Core 9 (o EF Core 8 LTS termina no mesmo dia). A Opção A é uma ponte, não um destino.

### 3. Opção B: trocar para Microting.EntityFrameworkCore.MySql 10.0.x

O [Microting.EntityFrameworkCore.MySql](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql) é um fork do Pomelo que publica builds para EF Core 10 desde fevereiro de 2026 e também tem um `11.0.0-preview.1`. O nuspec da 10.0.12 tem como alvo `net10.0` com `Microsoft.EntityFrameworkCore.Relational [10.0.12, 10.0.999]` e `MySqlConnector 2.6.2`. É a opção para a qual a maioria das pessoas na issue de acompanhamento do Pomelo migrou.

```xml
<!-- .NET 10, EF Core 10.0.13, Microting 10.0.12 -->
<ItemGroup>
  <PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

A extensão `UseMySql(...)` e `MySqlServerVersion`/`ServerVersion.AutoDetect` ficam no namespace `Microsoft.EntityFrameworkCore` nos dois pacotes, então o `Program.cs` do meu repro compilou sem alterações após a troca e imprimiu o mesmo SQL do MySQL que o Pomelo 9.0.0 com EF Core 9:

```text
SELECT `o`.`Id`, `o`.`Customer`, `o`.`Total`
FROM `Orders` AS `o`
WHERE (`o`.`Total` > 10.0) AND (`o`.`Customer` LIKE 'A%')
ORDER BY `o`.`Id`
LIMIT 5
```

O que você precisa mudar:

1. Renomeie todo `using Pomelo.EntityFrameworkCore.MySql.*;` para `using Microting.EntityFrameworkCore.MySql.*;`. O fork renomeou tanto o assembly quanto os namespaces (por exemplo, `Pomelo.EntityFrameworkCore.MySql.Infrastructure` vira `Microting.EntityFrameworkCore.MySql.Infrastructure`).
2. Troque também os pacotes de plugin: `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` vira `Microting.EntityFrameworkCore.MySql.Json.Microsoft`, e o mesmo vale para `.Json.Newtonsoft` e `.NetTopologySuite`. Deixar um plugin do Pomelo para trás traz de volta o Pomelo 9.0.0 e o `NU1107`.
3. Atualize o nome do provider nos comandos de scaffolding: `dotnet ef dbcontext scaffold "<conn>" Microting.EntityFrameworkCore.MySql`.
4. Atualize a ferramenta `dotnet-ef` para 10.0.x, para que ela corresponda à versão do EF Core em tempo de execução.
5. Execute `dotnet ef migrations add ProviderSwapCheck` contra as suas migrações existentes. Se a migração gerada estiver vazia, o snapshot do modelo é compatível; apague-a com `dotnet ef migrations remove`. Se não estiver vazia, leia-a antes de publicar qualquer coisa: esse diff é exatamente o que rodaria em produção.

Seja honesto consigo mesmo sobre o que isso é: um fork da comunidade mantido por uma empresa, não um provider oficial. Fixe a versão exata, leia as notas de release antes de atualizar e acompanhe os dois repositórios. Se o Pomelo lançar a 10.0.0 depois, voltar é o mesmo renomear ao contrário.

### 4. Opção C: MySql.EntityFrameworkCore da Oracle

O provider da Oracle, [MySql.EntityFrameworkCore](https://www.nuget.org/packages/MySql.EntityFrameworkCore), tem builds para EF Core 10 desde a 10.0.0-rc e está na 10.0.9. O nuspec dele usa apenas limites inferiores simples (`Microsoft.EntityFrameworkCore.Relational >= 10.0.9`), então nunca dispara esse conflito. É um provider diferente, não um fork, e a API é diferente:

```csharp
// .NET 10, EF Core 10.0.13, MySql.EntityFrameworkCore 10.0.9
options.UseMySQL(connectionString); // capital SQL, no ServerVersion argument
```

Ele também traduz as consultas de forma diferente. O mesmo filtro `Customer.StartsWith("A")` do repro vira um `LIKE CONCAT('A', '%')` mais uma comparação `LEFT(...) = CONVERT(... USING utf8mb4) COLLATE utf8mb4_bin`, enquanto o Pomelo e o Microting emitem `LIKE 'A%'`. Os mapeamentos de tipos e as anotações de migração também diferem, então espere um diff de migração não vazio e planeje uma revisão de migração de verdade. Escolha esta se você quer um provider mantido pelo fornecedor e pode arcar com essa revisão; caso contrário, a Opção B é a mudança menor.

### 5. O que não fazer

- **Não adicione `<NoWarn>NU1608</NoWarn>`.** O repro mostra o resultado: um build limpo e uma `MissingMethodException` na primeira chamada de `UseMySql`. Se foi o `TreatWarningsAsErrors` que fez o `NU1608` aparecer, ele cumpriu o papel dele.
- **Não referencie `Microsoft.EntityFrameworkCore.Relational` 10.x diretamente** só porque a mensagem do `NU1107` sugere. Isso converte o erro no crash.
- **Não misture majors dentro de uma solução.** Um projeto de testes com EF Core 10 InMemory que referencia um app em EF Core 9 puxa os dois para o grafo do teste, e você recebe `NU1107` (ou o descompasso silencioso) apenas no projeto de testes.

## Pegadinhas e erros parecidos

- **`MissingMethodException` sem aviso do NuGet**: o grafo `Microsoft.EntityFrameworkCore` 10 + Relational 9.0.0 do repro. Execute `dotnet nuget why <project> Microsoft.EntityFrameworkCore.Relational` e procure um Relational 9.x ao lado de um EF Core 10.x.
- **`NU1107` ou `NU1608` citando `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft`**: os pacotes de plugin repetem a mesma restrição `Microsoft.EntityFrameworkCore.Relational [9.0.0, 9.0.999]` e dependem eles mesmos do Pomelo 9.0.0. Mova-os em sincronia com o pacote principal.
- **`NU1605` (downgrade de pacote detectado)**: um problema diferente. Algo no grafo quer uma versão mais nova do que a que você fixou diretamente. Costuma aparecer logo depois de aplicar a Opção A, quando um pacote transitivo ainda quer o EF Core 10. Resolva encontrando e fixando esse pacote, não fazendo mais downgrade.
- **`dotnet ef` avisa que a versão da ferramenta é mais nova que o runtime**: inofensivo por si só, mas depois da Opção A mantenha a ferramenta `dotnet-ef` na mesma major dos pacotes do EF Core do app, para que o comportamento em tempo de design corresponda ao que roda em produção.
- **Pacotes Npgsql ou SQL Server em 10.x na mesma solução**: tudo bem, desde que estejam em projetos diferentes que nunca compartilham um grafo. Um projeto, uma major do EF Core.

## Relacionados

- Se o `NU1608` só apareceu porque avisos quebram o seu build, veja [TreatWarningsAsErrors sem sabotar os builds de desenvolvimento](/pt-br/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) para manter isso rigoroso sem esconder problemas reais.
- Para o padrão de propriedade de versão compartilhada usado na Opção A, veja [migrando uma solução .NET para o Central Package Management](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).
- O .NET 10 também mudou quais pacotes transitivos aparecem no seu grafo: [a poda de pacotes do NuGet vem ativada por padrão no .NET 10](/pt-br/2026/05/nuget-package-pruning-default-net-10/).
- Quando a ferramenta `dotnet-ef` e o SDK discordam, leia [a correção do DotnetToolSettings.xml](/pt-br/2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package/).
- Planejando o salto além do EF Core 9: [Migrar do EF Core 6 para o EF Core 11: breaking changes que realmente pesam](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Fontes

- [Issue de acompanhamento do suporte ao EF Core 10 no Pomelo #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007)
- [README do Pomelo.EntityFrameworkCore.MySql: tabela de compatibilidade e feeds nightly](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql)
- [Pomelo.EntityFrameworkCore.MySql 9.0.0 no NuGet](https://www.nuget.org/packages/Pomelo.EntityFrameworkCore.MySql/9.0.0)
- [Microting.EntityFrameworkCore.MySql no NuGet](https://www.nuget.org/packages/Microting.EntityFrameworkCore.MySql) e [o README dele sobre a renomeação de namespace](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql)
- [MySql.EntityFrameworkCore no NuGet](https://www.nuget.org/packages/MySql.EntityFrameworkCore)
- [Aviso NU1608 do NuGet](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1608) e [erro NU1107 do NuGet](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1107)
- [Política de suporte do .NET e do .NET Core](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)
