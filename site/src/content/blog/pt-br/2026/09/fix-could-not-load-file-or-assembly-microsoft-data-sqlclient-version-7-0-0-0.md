---
title: "Correção: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' depois de atualizar o EF Core"
description: "O EF Core 11 é compilado contra o Microsoft.Data.SqlClient 7.0.0.0, mas uma cópia 6.x venceu no restore ou na implantação. Remova o pin antigo do SqlClient e reimplante a saída completa."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Resposta curta:** o `Microsoft.EntityFrameworkCore.SqlServer` 11 (verificado no `11.0.0-rc.1.26425.128`, .NET 11 RC 1) é compilado contra `Microsoft.Data.SqlClient, Version=7.0.0.0` e exige o pacote 7.0.2 ou mais recente. A exceção significa que o processo encontrou um SqlClient 6.x, ou nenhum. Apague a referência remanescente ao `Microsoft.Data.SqlClient` 6.x (ou o `PackageVersion` dele no `Directory.Packages.props`), remova qualquer `NoWarn` para `NU1605`, compile de novo e reimplante a pasta de saída inteira, incluindo `runtimes/`.

O restante deste post mostra de onde vem a cópia 6.x, como encontrá-la em menos de um minuto e os dois erros parecidos que levam as pessoas à correção errada. Todos os cenários abaixo foram reproduzidos no macOS com o SDK do .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) e o SDK 10.0.302; nenhum banco de dados é necessário para provocar o erro.

## O erro no contexto

O EF Core não toca no SqlClient quando você registra o contexto. O carregamento acontece na primeira vez que o provider monta seus mapeamentos de tipos, ou seja, na primeira consulta, no `SaveChanges`, no `MigrateAsync` ou no `Database.GetDbConnection()`. Esta é a cadeia de exceções que o meu repro imprimiu, da mais externa para a mais interna:

```text
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerTypeMappingSource' threw an exception.
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerVectorTypeMapping' threw an exception.
System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5'. The system cannot find the file specified.
```

Se os seus logs mostram só a `TypeInitializationException` externa, desembrulhe a `InnerException` duas vezes. A `FileNotFoundException` lá no fundo é o erro real.

Uma coisa para saber antes de começar: `Version=7.0.0.0` é uma versão de **assembly**, não uma versão de pacote. O SqlClient fixa o `AssemblyVersion` em `Major.0.0.0` para todas as versões de uma mesma linha major, então o pacote 7.0.3 entrega uma DLL cuja versão de assembly é `7.0.0.0` (versão de arquivo `7.0.3.26253`). Os mantenedores confirmaram que isso é intencional em [dotnet/SqlClient#4310](https://github.com/dotnet/SqlClient/issues/4310). Qualquer pacote 7.x satisfaz a referência. Você não precisa caçar "exatamente a 7.0.0".

## Por que isso acontece

O runtime faz o binding pela versão do assembly, e ele só avança (roll forward), nunca volta. Quando o EF Core 11 pede `7.0.0.0` e a única `Microsoft.Data.SqlClient.dll` no caminho de probing é um build 6.x (versão de assembly `6.0.0.0`), o carregamento falha. E falha com a mensagem enganosa "cannot find the file specified" mesmo quando um arquivo 6.x está exatamente no caminho para o qual o `.deps.json` aponta. Testei isso explicitamente: colocar a DLL 6.1.6 por cima da 7.0.2 na saída produz a mesma mensagem.

Isto é o que cada pacote usa como referência de compilação, lido direto dos metadados de assembly nos pacotes NuGet:

| Pacote | Dependência do pacote SqlClient | Referência de assembly na DLL |
| --- | --- | --- |
| `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10, 10.0.11, 10.0.12 | `>= 6.1.x` (10.0.12: `>= 6.1.6`) | `Microsoft.Data.SqlClient 6.0.0.0` |
| `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 | `>= 7.0.2` | `Microsoft.Data.SqlClient 7.0.0.0` |

Então, no EF Core 10, o próprio provider nunca pede a 7.0.0.0. No EF Core 11, ele sempre pede. Em ordem de frequência com que eu os vejo, os caminhos pelos quais uma cópia 6.x vence mesmo assim são:

1. **Uma referência direta remanescente ao `Microsoft.Data.SqlClient` 6.x, com o aviso de downgrade silenciado.** Muitos projetos do EF Core 8 a 10 adicionaram uma referência explícita ao SqlClient para pegar uma correção ou o suporte a Entra ID. Depois da atualização do EF, esse pin vira um downgrade. O NuGet reporta isso como `NU1605`, que o SDK trata como erro, a menos que o projeto tenha `<NoWarn>NU1605</NoWarn>` herdado de algum conflito anterior.
2. **A implantação descarta ou substitui a DLL.** O SqlClient não tem implementação portável. Os assemblies reais ficam em `runtimes/unix/lib/net9.0/` e `runtimes/win/lib/net9.0/`. Um Dockerfile ou script de cópia que só pega os `*.dll` da raiz de `bin/`, ou que descompacta um build novo por cima de uma pasta antiga, deixa o app sem um SqlClient 7.x.
3. **Um host de plug-ins carrega a sua camada de dados dinamicamente.** O processo host não tem entrada no `.deps.json` para o SqlClient, então o contexto de carregamento padrão dele não consegue resolver as dependências do plug-in.

## Repro mínimo

Um app de console que estava no EF Core 10 com um pin do SqlClient, atualizado para o EF Core 11 RC 1. O `NoWarn` é a linha que transforma um erro de build em um crash em tempo de execução:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>$(NoWarn);NU1605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="6.1.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<ShopDb>()
    .UseSqlServer("Server=localhost;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True")
    .Options;

using var db = new ShopDb(options);
// Throws the FileNotFoundException above; no server connection is attempted.
Console.WriteLine(db.Database.GetDbConnection().GetType().Assembly.GetName());

class ShopDb(DbContextOptions<ShopDb> options) : DbContext(options);
```

Remova a linha do `NoWarn` e o build passa a parar no restore, que é o que você quer:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to 6.1.6. Reference the package directly from the project to select a different version.
error NU1605:  app -> Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128 -> Microsoft.Data.SqlClient (>= 7.0.2)
error NU1605:  app -> Microsoft.Data.SqlClient (>= 6.1.6)
```

Sem o pin, o mesmo programa imprime `Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5`.

## A correção, em detalhes

### 1. Descubra quem entrega a cópia 6.x

Não chute. Peça ao NuGet o grafo de dependências do projeto de inicialização, não o da biblioteca de classes:

```bash
# .NET SDK 10.0.302 or .NET 11 RC 1 SDK
dotnet nuget why src/Shop.Api/Shop.Api.csproj Microsoft.Data.SqlClient
dotnet list src/Shop.Api/Shop.Api.csproj package --include-transitive
```

O `dotnet nuget why` imprime uma árvore por target framework, então uma referência direta à 6.x, ou um pacote que puxa uma, fica visível de imediato. Depois confira o que de fato foi gravado para o runtime, já que é isso que o host lê:

```bash
# .NET 11 RC 1 SDK
grep -A3 '"Microsoft.Data.SqlClient/' src/Shop.Api/bin/Release/net11.0/Shop.Api.deps.json
```

Se o `.deps.json` diz `7.0.x` e o app ainda falha, o problema é a implantação (passo 4), não o restore.

### 2. Remova ou suba o pin do SqlClient

Se nada no seu código precisa de uma versão específica do SqlClient, apague a referência direta e deixe o EF Core trazer a versão contra a qual ele foi compilado. Se você quer mantê-la explícita, suba para a 7.x atual:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <!-- Was 6.1.6. Any 7.x works; 7.0.3 is the latest stable at the time of writing. -->
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

Com [Central Package Management](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) e pinning transitivo, o pin fica no `Directory.Packages.props`, e o erro de restore tem outro código:

```text
error NU1109: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to centrally defined 6.1.6. Update the centrally managed package version to a higher version.
```

Atualize a própria entrada `PackageVersion`:

```xml
<!-- .NET 11 RC 1, Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

### 3. Pare de suprimir o NU1605

Procure `NU1605` dentro de `NoWarn` na solução inteira, incluindo o `Directory.Build.props`. Essa supressão é o único motivo pelo qual isso chega ao runtime a partir de um build normal. Sem ela, a próxima pessoa que reintroduzir um downgrade recebe um erro de restore com o caminho exato do pacote em vez de um crash em produção.

### 4. Reimplante a saída inteira, incluindo `runtimes/`

Em um build dependente de framework sem RID, a implementação real do SqlClient fica em `runtimes/<os>/lib/net9.0/`, e o `.deps.json` aponta para lá. Apaguei esse único arquivo de um build que funcionava e recebi a mesma `FileNotFoundException`, e apagar a pasta `runtimes/` inteira dá no mesmo. Se o seu Dockerfile ou pipeline copia arquivos seletivamente, passe a copiar a pasta de publish completa:

```dockerfile
# .NET 11 RC 1 images
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -r linux-x64 --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

Publicar com um RID (`-r linux-x64`) achata o SqlClient específico da plataforma na raiz, ao lado de `Microsoft.Data.SqlClient.Extensions.Abstractions.dll` e `Microsoft.Data.SqlClient.Internal.Logging.dll`, o que torna o layout muito mais difícil de quebrar. Para IIS, zip deploy no Azure App Service ou implantações por xcopy, implante em uma pasta limpa, para que uma DLL 6.x da versão anterior não sobreviva ao lado do novo `.deps.json`. Se você não tem certeza se deveria entregar a saída do `dotnet build` ou do `dotnet publish`, [a diferença entre os dois](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) importa aqui.

### 5. Adicione a extensão do Azure se você usa Entra ID

A mudança para o SqlClient 7.0 aparece como uma alteração de impacto médio nas [breaking changes do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes). A autenticação do Entra ID (`Active Directory Default`, identidade gerenciada, service principal) saiu do pacote principal. Depois que o erro de carregamento é corrigido, uma connection string que usa esse tipo de autenticação precisa de mais uma referência:

```xml
<!-- .NET 11 RC 1, Microsoft.Data.SqlClient 7.x -->
<PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.3" />
```

Mantenha este pacote na mesma versão do `Microsoft.Data.SqlClient`. A partir da 7.0.2, o SqlClient, o `Extensions.Azure` e o `Extensions.Abstractions` são lançados juntos, e o SqlClient 7.0.2 exige o `Extensions.Abstractions` no intervalo `[7.0.2, 8.0.0)`. O NuGet não tem uma 7.0.0 do pacote do Azure: as versões dele vão 1.0.0, 7.0.2, 7.0.3, então um `Version="7.0.0"` que você copiou de um trecho de documentação não resolve para essa versão exata. Sem o pacote, a 7.0 lança um erro acionável que cita o nome dele, então você não vai ficar tentando adivinhar. O [guia de migração do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre isso junto com as outras mudanças motivadas pelo SqlClient.

### 6. Hosts de plug-ins: carregue por meio de um `AssemblyLoadContext`

Se um host sem referência ao EF Core carrega a sua camada de dados com `Assembly.LoadFrom`, o contexto padrão do host não tem entrada no `.deps.json` para o SqlClient. A resposta dos mantenedores em [#4310](https://github.com/dotnet/SqlClient/issues/4310) é o padrão clássico de plug-ins. Compile o plug-in com `<EnableDynamicLoading>true</EnableDynamicLoading>` e carregue-o por meio de um contexto que lê o `.deps.json` do próprio plug-in:

```csharp
// .NET 11 RC 1
using System.Reflection;
using System.Runtime.Loader;

sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(isCollectible: false)
{
    private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        var path = _resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

// var asm = new PluginLoadContext(pluginPath).LoadFromAssemblyPath(pluginPath);
```

No meu teste, o mesmo plug-in falhou com `Assembly.LoadFrom` e carregou `Microsoft.Data.SqlClient, Version=7.0.0.0` sem problemas por meio desse contexto. O resolver é importante especialmente para o SqlClient. Ele mapeia a requisição para o arquivo correto em `runtimes/<os>/` em vez do assembly placeholder da raiz.

## Pegadinhas e erros parecidos

**"Mas eu ainda estou no EF Core 10."** Então não é o EF que está pedindo a 7.0.0.0. As DLLs do provider da 10.0.10 até a 10.0.12 referenciam todas a `6.0.0.0`. É por isso que o [dotnet/efcore#38845](https://github.com/dotnet/efcore/issues/38845), que reportou este erro depois de passar da 10.0.10 para a 10.0.11, foi fechado sem um repro. Outra coisa no grafo é compilada contra a 7.x. O Aspire é uma fonte comum. O `Aspire.Microsoft.EntityFrameworkCore.SqlServer` 13.5.3 depende do `Microsoft.Data.SqlClient >= 7.0.1` e do EF Core 10.0.11 ao mesmo tempo, então o `dotnet nuget why` em um serviço do Aspire mostra o SqlClient resolvido para 7.0.1 em um app com EF Core 10. Essa combinação funciona: no meu teste, o EF Core 10.0.12 inicializou seus mapeamentos de tipos e criou uma `SqlConnection` tanto com o SqlClient 7.0.0 quanto com o 7.0.3. Só quebra quando um pin 6.x ou uma implantação desatualizada vence, o que traz você de volta aos passos 1 a 4.

**`Could not load type 'Microsoft.Data.SqlClient.SqlAuthenticationMethod' from assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'`.** Esta é uma falha diferente com a mesma string de versão. O arquivo carregou normalmente, mas uma biblioteca compilada contra a 6.x (o SQL Server Management Objects 181.x era o caso comum) procurou um tipo que a 7.0.0 moveu para `Microsoft.Data.SqlClient.Extensions.Abstractions`. O SqlClient 7.0.1 adicionou type forwards para `SqlAuthenticationMethod`, `SqlAuthenticationProvider` e mais três tipos relacionados ([#4117](https://github.com/dotnet/SqlClient/pull/4117)), então atualizar o SqlClient para a 7.0.1 ou posterior resolve.

**`PlatformNotSupportedException: Microsoft.Data.SqlClient is not supported on this platform.`** O arquivo foi encontrado, mas era o errado. O assembly na raiz de `lib/` do pacote é um placeholder, e a implementação que funciona fica em `runtimes/`. O meu host de plug-ins bateu exatamente nisso com `Assembly.LoadFrom`, porque a pasta raiz do plug-in continha o placeholder. A correção é o mesmo `AssemblyLoadContext` do passo 6, ou uma implantação completa com os assets específicos do RID.

**Um nome de assembly diferente na mensagem.** Se o erro cita a sua própria biblioteca ou outro pacote, os detalhes do SqlClient acima não se aplicam. O roteiro geral para [um erro "Could not load file or assembly" em um app publicado](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cobre tracing do host e trimming. Para a versão desse descompasso nas ferramentas do EF, em que quem falha é o `dotnet ef` e não o seu app, veja [a MissingMethodException depois de atualizar o EF Core Tools](/pt-br/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Relacionados

- [Migrar uma solução .NET para Central Package Management com Directory.Packages.props](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)
- [Migrar do EF Core 6 para o EF Core 11: as breaking changes que realmente doem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Corrigir FileNotFoundException "Could not load file or assembly" em um app publicado](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [A coluna json nativa vs nvarchar(max) no SQL Server com EF Core 11](/pt-br/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/), que mostra o `SqlDbType.Json` do SqlClient 7 em ação
- [Qual é a diferença entre dotnet build e dotnet publish](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)

## Fontes

- [Breaking changes no EF Core 11: o Microsoft.Data.SqlClient foi atualizado para a 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Notas de versão do Microsoft.Data.SqlClient 7.0.0](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md) e [notas de versão da 7.0.1](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.1.md)
- [dotnet/SqlClient#4310: a versão de assembly continua 7.0.0.0 em toda a 7.x, orientações para carregar plug-ins](https://github.com/dotnet/SqlClient/issues/4310)
- [dotnet/efcore#38845: o relato do EF Core 10.0.11](https://github.com/dotnet/efcore/issues/38845)
- [dotnet/SqlClient#4064](https://github.com/dotnet/SqlClient/issues/4064) e [#4117](https://github.com/dotnet/SqlClient/pull/4117): os type forwards de `SqlAuthenticationMethod`
- [Aviso NU1605 do NuGet](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605) e [erro NU1109](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1109)
- [Criar um aplicativo .NET com plug-ins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) e [Probing padrão](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/default-probing)
