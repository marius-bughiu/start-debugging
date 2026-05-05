---
title: "Correção: System.InvalidOperationException: No connection string named 'DefaultConnection' could be found"
description: "Se GetConnectionString retorna null no .NET 11, o seu appsettings.json não tem a chave, não está sendo copiado para a saída do build, ou o arquivo de ambiente errado está sendo selecionado. Três checagens resolvem 95% dos casos."
pubDate: 2026-05-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "ef-core"
  - "configuration"
lang: "pt-br"
translationOf: "2026/05/fix-no-connection-string-named-defaultconnection"
translatedBy: "claude"
translationDate: 2026-05-05
---

A correção: `IConfiguration.GetConnectionString("DefaultConnection")` retorna `null`, e o EF Core lança a exceção porque esperava uma string. Ou o seu `appsettings.json` não contém uma entrada `ConnectionStrings:DefaultConnection`, ou o arquivo não está sendo copiado para a saída do build, ou o ambiente errado está selecionado e a chave só existe num arquivo irmão. Verifique o JSON, configure `Copy to Output Directory = Copy if newer` e confirme que `ASPNETCORE_ENVIRONMENT` corresponde ao arquivo onde você escreveu a string.

```text
Unhandled exception. System.InvalidOperationException: No connection string named 'DefaultConnection' could be found in the application configuration.
   at Microsoft.EntityFrameworkCore.SqlServerDbContextOptionsExtensions.UseSqlServer(DbContextOptionsBuilder optionsBuilder, String connectionString, Action`1 sqlServerOptionsAction)
   at Program.<Main>$(String[] args) in C:\src\Api\Program.cs:line 14
   at Program.<Main>(String[] args)
```

O erro é levantado pelo `UseSqlServer(string)` do EF Core (e equivalentes em Npgsql, MySQL, SQLite) quando o parâmetro string é `null`. O texto da exceção vem da validação de parâmetros do EF Core, mas a causa raiz está sempre a montante, em `Microsoft.Extensions.Configuration`. Este guia foi escrito contra .NET 11 preview 4, EF Core 11.0.0-preview.4 e `Microsoft.AspNetCore.App` 11.0.0-preview.4. O mesmo conselho vale até o .NET Core 3.1.

## Por que GetConnectionString retorna null

`IConfiguration.GetConnectionString("X")` é açúcar sintático para `configuration["ConnectionStrings:X"]`. O sistema de configuração percorre cada provedor registrado em ordem (arquivos JSON, user secrets, variáveis de ambiente, argumentos de linha de comando) e retorna o primeiro match. `null` significa que **nenhum** dos provedores tinha aquela chave. Existem seis razões comuns:

1. A chave está faltando em `appsettings.json`.
2. A chave está presente, mas o arquivo não é copiado para o diretório de saída, então o binário em execução nunca a vê.
3. A chave está em `appsettings.Production.json`, mas o app está rodando em `Development`, onde só `appsettings.Development.json` é carregado.
4. As ferramentas de tempo de design do EF Core (`dotnet ef migrations add`) são invocadas a partir de uma pasta que não contém o arquivo JSON.
5. A chave mora em User Secrets, mas o `.csproj` do projeto está sem `<UserSecretsId>`.
6. A connection string está como variável de ambiente, mas o nome usa um underscore simples (`ConnectionStrings_DefaultConnection`) em vez do underscore duplo obrigatório (`ConnectionStrings__DefaultConnection`).

Os casos 2 e 6 são os assassinos silenciosos, porque o código parece correto à inspeção.

## Um repro mínimo

Uma Web API limpa criada com `dotnet new webapi -n Api` e uma ligação de EF Core. É o menor setup que reproduz o erro de forma confiável.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();

public class AppDb : DbContext
{
    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

```json
// appsettings.json -- this file is what you THINK is being read
{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "AllowedHosts": "*"
}
```

`builder.Configuration.GetConnectionString("DefaultConnection")` retorna `null`, o EF Core lança em `UseSqlServer(null)` e o host falha ao ser construído. A mensagem da exceção nomeia `DefaultConnection`, o que é enganoso: nada no EF Core obriga esse nome. Qualquer string que você passar para `GetConnectionString(...)` aparecerá lá.

## A correção em três checagens

Execute na ordem. Cada uma já me pegou pelo menos uma vez.

### 1. Verifique se o JSON tem a chave

Abra o `appsettings.json` no projeto que hospeda o `Program.cs` (não o projeto que define o `DbContext`, se forem diferentes) e adicione a seção:

```json
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=(localdb)\\mssqllocaldb;Database=AppDb;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

O nome do provedor em `UseSqlServer` é independente do formato da connection string; SQL Server, PostgreSQL, MySQL e SQLite leem o mesmo formato `ConnectionStrings:Name`. Se o seu JSON tem a chave mas dentro de um objeto `Settings` aninhado, `GetConnectionString` não a encontrará. O caminho exato deve ser `ConnectionStrings.<Name>`.

### 2. Confirme que o arquivo está na saída do build

Isso pega bibliotecas de classes e worker services em que o template do projeto não inclui `appsettings.json` por padrão. Depois de `dotnet build`, verifique se o arquivo está junto da sua DLL:

```bash
dotnet build
ls bin/Debug/net11.0/appsettings.json
```

Se estiver faltando, adicione isso ao `.csproj`:

```xml
<!-- .NET 11 SDK-style csproj -->
<ItemGroup>
  <None Update="appsettings.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </None>
  <None Update="appsettings.*.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    <DependentUpon>appsettings.json</DependentUpon>
  </None>
</ItemGroup>
```

O `Microsoft.NET.Sdk.Web` inclui isso implicitamente, então um projeto criado com `dotnet new webapi` não precisa. Projetos worker (`Microsoft.NET.Sdk.Worker`) também incluem. O `Microsoft.NET.Sdk` puro não, e é onde a maioria desses bugs vive: um host de console reaproveitado para `dotnet ef`, ou uma biblioteca de classes que ganhou um `Program.cs` depois.

### 3. Faça o ambiente bater com o arquivo onde você escreveu

`WebApplication.CreateBuilder` carrega `appsettings.json` primeiro, depois `appsettings.{Environment}.json`, com o segundo sobrescrevendo o primeiro. O ambiente é lido de `ASPNETCORE_ENVIRONMENT` (Web) ou `DOTNET_ENVIRONMENT` (host genérico), com `Production` por padrão se nenhum estiver definido. Um modo de falha comum: você coloca a connection string só em `appsettings.Development.json` e depois roda o app em produção, onde só `appsettings.json` e `appsettings.Production.json` são carregados.

```bash
# powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"

# bash
export ASPNETCORE_ENVIRONMENT=Development

dotnet run
```

Imprima o valor resolvido uma vez no startup para enxergá-lo nos logs:

```csharp
// .NET 11, C# 14
var cs = builder.Configuration.GetConnectionString("DefaultConnection");
Console.WriteLine($"DefaultConnection length: {cs?.Length ?? 0}");
```

Nunca logue a connection string completa em produção, porque senhas costumam morar lá. Logar o tamanho é suficiente para distinguir `null` de "carregada mas vazia" de "carregada com conteúdo".

## Variantes que afetam diferentes audiências

### `dotnet ef migrations add` a partir de uma biblioteca de classes

As ferramentas de tempo de design do EF Core resolvem o `DbContext` chamando o seu `Program.Main` ou encontrando um `IDesignTimeDbContextFactory<T>`. Se o `DbContext` mora numa biblioteca de classes, `dotnet ef` invoca o **projeto de inicialização** (a Web API) e lê a configuração dele. Rode da pasta certa:

```bash
# Bad: connection string is in Api/appsettings.json,
# but you ran this in Data/, where there is no JSON.
cd Data
dotnet ef migrations add Init

# Good: point at the startup project explicitly.
cd Data
dotnet ef migrations add Init --startup-project ../Api/Api.csproj
```

Se você precisa rodar migrations a partir do projeto de dados de forma autônoma (por exemplo, num pipeline de release), adicione um `IDesignTimeDbContextFactory<AppDb>`:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbFactory : IDesignTimeDbContextFactory<AppDb>
{
    public AppDb CreateDbContext(string[] args)
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: false)
            .AddEnvironmentVariables()
            .Build();

        var options = new DbContextOptionsBuilder<AppDb>()
            .UseSqlServer(config.GetConnectionString("DefaultConnection"))
            .Options;

        return new AppDb(options);
    }
}
```

Essa factory é apenas de tempo de design; ela não é registrada na DI nem roda em runtime.

### Variáveis de ambiente em contêineres

Em Docker e Kubernetes, a convenção é achatar caminhos de configuração com underscore duplo. `ConnectionStrings:DefaultConnection` vira `ConnectionStrings__DefaultConnection`. Um underscore simples é apenas um nome comum, e o sistema de configuração não vai reconhecê-lo.

```yaml
# docker-compose, .NET 11
services:
  api:
    image: api:11.0
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ConnectionStrings__DefaultConnection: "Server=db;Database=App;User Id=sa;Password=..."
```

```bash
# Kubernetes secret reference
- name: ConnectionStrings__DefaultConnection
  valueFrom:
    secretKeyRef:
      name: db
      key: connection
```

Se a variável está correta mas continua sumida, confirme que `AddEnvironmentVariables()` está no pipeline de configuração. O `WebApplication.CreateBuilder` chama isso para você. Um `ConfigurationBuilder` customizado num projeto de console não chama, a não ser que você adicione explicitamente.

### User Secrets em desenvolvimento

`dotnet user-secrets set "ConnectionStrings:DefaultConnection" "..."` só funciona quando o `.csproj` do projeto tem um elemento `<UserSecretsId>`:

```xml
<!-- .NET 11 SDK-style csproj -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <UserSecretsId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</UserSecretsId>
</PropertyGroup>
```

`dotnet user-secrets init` adiciona isso para você. User secrets só são carregados quando `IHostEnvironment.IsDevelopment()` é `true`, o que é mais uma razão para a checagem 3 (a do ambiente) importar.

### Azure Key Vault e outros provedores

Se você usa `builder.Configuration.AddAzureKeyVault(...)`, o nome do secret precisa bater com o caminho de configuração, com `--` como separador. Um secret do vault chamado `ConnectionStrings--DefaultConnection` aparece como `ConnectionStrings:DefaultConnection`. Um secret chamado `DefaultConnection` não.

### O erro menciona um nome que você não reconhece

Se a mensagem diz `No connection string named 'X'` e `X` não é o nome que você digitou, provavelmente você está chamando `UseSqlServer(connectionStringName: "X")` numa sobrecarga antiga do EF Core que resolve nomes contra a tabela de connection strings da aplicação. O EF Core 11 ainda suporta isso por compatibilidade. A correção é a mesma: adicione uma entrada `ConnectionStrings:X` ou passe a connection string literal em vez de um nome.

### Native AOT e trimming

Se você publica com Native AOT, o binding de configuração ainda funciona para `GetConnectionString`, que é uma busca de string simples. O erro que você está olhando não é um aviso de trim do AOT. Se você também ver `IL3050`, esse é o aviso de binding para o binding via reflexão do `Configure<T>`, não para connection strings.

## Relacionado

Para o contexto mais amplo de EF Core que costuma cercar esse erro, veja o resumo sobre [detecção de queries N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) e o guia de [queries compiladas em hot paths](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Para amarrar testes contra a mesma connection string, o [tutorial de Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) mostra como subir um SQL Server real por fixture sem commitar credenciais. Para diagnosticar esse tipo de falha de startup num app rodando, o [setup de Serilog e Seq](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) deixa a configuração resolvida legível nos logs de produção.

## Fontes

- [`IConfiguration.GetConnectionString` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.configuration.configurationextensions.getconnectionstring), Microsoft Learn.
- [Configuration in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/), Microsoft Learn.
- [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation), EF Core docs.
- [Safe storage of app secrets in development](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets), Microsoft Learn.
- [Environment variables configuration provider](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/#environment-variables), Microsoft Learn, sobre o separador `__`.
