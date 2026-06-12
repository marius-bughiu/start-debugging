---
title: "Solução: The antiforgery token could not be decrypted no ASP.NET Core"
description: "O erro significa que o Data Protection perdeu a chave que assinou o token. Persista as chaves em um armazenamento compartilhado e durável e chame SetApplicationName para que cada instância leia o mesmo conjunto de chaves."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-12
---

The antiforgery token could not be decrypted porque a chave do Data Protection que o assinou não está mais no conjunto de chaves que sua aplicação está lendo. Por padrão, o ASP.NET Core grava essas chaves em uma pasta por máquina e por usuário que não sobrevive ao reinício de um contêiner e não é compartilhada entre instâncias. Persista as chaves em um armazenamento durável que toda instância possa ler (compartilhamento de arquivos, banco de dados, Azure Blob, Redis) e fixe `SetApplicationName` com o mesmo valor em todos os lugares. Essa é a solução completa. O resto deste artigo explica por que isso acontece e o código exato para cada armazenamento.

Isto se aplica ao ASP.NET Core 11 (`.NET 11`), mas o mesmo stack do Data Protection e a mesma solução remontam ao ASP.NET Core 2.x.

## O erro em contexto

Você verá um destes, geralmente em um POST logo após um deploy, um escalonamento horizontal ou o reinício de um contêiner:

```
Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException: The antiforgery token could not be decrypted.
 ---> System.Security.Cryptography.CryptographicException: The key {0cf0e637-...} was not found in the key ring.
   at Microsoft.AspNetCore.DataProtection.KeyManagement.KeyRingBasedDataProtector.UnprotectCore(...)
   at Microsoft.AspNetCore.Antiforgery.DefaultAntiforgeryTokenSerializer.Deserialize(String serializedToken)
```

A exceção interna é a pista. `The key {guid} was not found in the key ring` significa que o token referencia uma chave que esta instância nunca viu. Uma mensagem interna diferente, `The payload was invalid`, aponta para uma chave que existe mas não consegue descriptografar este token específico, o que geralmente significa que duas aplicações compartilham um conjunto de chaves sem um nome de aplicação correspondente (mais sobre isso abaixo).

No Blazor e no Razor Pages a mesma causa raiz se manifesta como um HTTP 400 com `Bad Request - antiforgery token validation failed`, e no MVC como um loop de redirecionamento no login porque o cookie de antiforgery nunca pode ser validado.

## Por que isso acontece

Os tokens de antiforgery são criptografados e assinados pelo ASP.NET Core Data Protection. A validação só funciona se a instância que lê o token ainda mantiver a chave que o gravou. Há quatro formas de perder essa chave:

- **As chaves são efêmeras.** Sem configuração explícita, o Data Protection persiste as chaves em `%LOCALAPPDATA%\ASP.NET\DataProtection-Keys` (Windows) ou `$HOME/.aspnet/DataProtection-Keys` (Linux). Em um contêiner esse caminho vive dentro da camada de escrita e é apagado a cada reinício, então cada novo contêiner gera um conjunto de chaves novo e rejeita todos os tokens emitidos pelo anterior.
- **Você escalou horizontalmente.** Duas ou mais instâncias atrás de um balanceador de carga geram cada uma seu próprio conjunto de chaves. Um token emitido pela instância A chega na instância B, cujo conjunto não contém a chave de A. Esta é a causa mais comum em produção.
- **A identidade mudou.** Ao rodar sob o IIS, a reciclagem do pool de aplicações ou uma mudança de identidade move a pasta de chaves, porque o caminho padrão é vinculado ao usuário. Os slots de deploy do Azure App Service têm o mesmo efeito: o slot de staging e o de produção não compartilham chaves a menos que você os instrua.
- **Duas aplicações, um conjunto, sem nome de aplicação.** Quando várias aplicações apontam para o mesmo armazenamento mas não definem um `SetApplicationName` correspondente, seus tokens colidem. O Data Protection isola por discriminador de aplicação, então uma incompatibilidade produz `The payload was invalid`.

O tempo de vida padrão das chaves é de 90 dias, então a rotação legítima de chaves quase nunca causa isso. Se você está vendo, a chave está faltando, não expirou.

## Reprodução mínima

Esta é a menor aplicação que reproduz o erro através de um reinício. Execute-a, envie o formulário e então reinicie o processo antes de enviá-lo de novo.

```csharp
// .NET 11, ASP.NET Core 11
// No Data Protection configuration: keys are ephemeral.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();

app.MapGet("/", (HttpContext ctx, IAntiforgery af) =>
{
    var tokens = af.GetAndStoreTokens(ctx);
    return Results.Content($"""
        <form action="/submit" method="post">
          <input name="{tokens.FormFieldName}" type="hidden" value="{tokens.RequestToken}" />
          <button type="submit">Submit</button>
        </form>
        """, "text/html");
});

app.MapPost("/submit", () => "OK").RequireAntiforgery();

app.Run();
```

Carregue `/`, copie o formulário renderizado, reinicie a aplicação e então faça POST do formulário antigo. Como o conjunto de chaves em memória foi regenerado no reinício, o token não descriptografa mais e você recebe `AntiforgeryValidationException`. Em um único processo de longa duração você não verá, que é exatamente por que isso escapa nos testes locais e só aparece em contêineres e farms.

## A solução, em detalhe

Escolha o armazenamento que combina com onde você executa. Em todos os casos a regra é a mesma: um local que todas as instâncias possam ler e gravar, mais um nome de aplicação estável.

### 1. Compartilhamento de arquivos (UNC ou volume montado): o mais simples para VMs e bare metal

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(@"\\fileserver\dpkeys\myapp"))
    .SetApplicationName("MyApp");
```

No Kubernetes, monte um `PersistentVolume` compartilhado (ReadWriteMany) e aponte `PersistKeysToFileSystem` para o caminho de montagem. As chaves então sobrevivem a qualquer pod individual. Esta é a solução de menor atrito quando você já tem armazenamento compartilhado.

### 2. Banco de dados via EF Core: sem infraestrutura extra se você já tem um banco

Adicione o pacote [`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`](https://www.nuget.org/packages/Microsoft.AspNetCore.DataProtection.EntityFrameworkCore/) e um contexto que implemente `IDataProtectionKeyContext`:

```csharp
// .NET 11, EF Core 11
public class KeysDbContext : DbContext, IDataProtectionKeyContext
{
    public KeysDbContext(DbContextOptions<KeysDbContext> options) : base(options) { }
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
}
```

```csharp
// Program.cs
builder.Services.AddDbContext<KeysDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Keys")));

builder.Services.AddDataProtection()
    .PersistKeysToDbContext<KeysDbContext>()
    .SetApplicationName("MyApp");
```

Execute uma migração que crie a tabela `DataProtectionKeys` uma vez, e cada instância lerá o mesmo conjunto. Esta é a opção à qual eu recorro com mais frequência porque não precisa de nada que a aplicação já não tenha.

### 3. Azure Blob Storage: a escolha limpa para App Service e Azure Container Apps

Adicione [`Azure.Extensions.AspNetCore.DataProtection.Blobs`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Blobs). Use uma identidade gerenciada em vez de uma string de conexão:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToAzureBlobStorage(
        new Uri("https://mystorage.blob.core.windows.net/dpkeys/keys.xml"),
        new DefaultAzureCredential())
    .SetApplicationName("MyApp");
```

Isto também resolve a variante de slots de deploy: quando staging e produção apontam para o mesmo blob, trocar slots não invalida mais as sessões ativas. Para defesa em profundidade, envolva-o com `ProtectKeysWithAzureKeyVault` (pacote [`Azure.Extensions.AspNetCore.DataProtection.Keys`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Keys)) para que o próprio conjunto de chaves fique criptografado em repouso.

### 4. Redis: a menor latência para farms grandes

Adicione `Microsoft.AspNetCore.DataProtection.StackExchangeRedis` e reutilize o multiplexador que você já usa para cache:

```csharp
// .NET 11, ASP.NET Core 11
var redis = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!);
builder.Services.AddDataProtection()
    .PersistKeysToStackExchangeRedis(redis, "DataProtection-Keys")
    .SetApplicationName("MyApp");
```

Seja qual for o armazenamento que você escolher, `SetApplicationName` não é opcional em um cenário de múltiplas aplicações ou slots. Ele define o discriminador de aplicação que o Data Protection mistura na derivação da chave, e o valor deve ser idêntico byte a byte em cada instância e slot que devem confiar nos tokens uns dos outros.

## Detalhes e variantes

**`The payload was invalid` em vez de `key not found`.** A chave existe mas o discriminador de aplicação difere. Duas aplicações compartilham um armazenamento, e uma está sem `SetApplicationName` ou tem um valor diferente. Defina o mesmo nome em ambas. Isto também é por que copiar uma aplicação publicada para um novo caminho de raiz de conteúdo pode quebrar os tokens: o ASP.NET Core recorre a derivar o nome da aplicação do caminho de raiz de conteúdo quando você não define um explicitamente, então o próprio caminho se torna o discriminador.

**Chaves criptografadas em repouso que outras instâncias não conseguem ler.** No Windows, o Data Protection criptografa o conjunto de chaves com DPAPI vinculado ao usuário ou à máquina atual por padrão. Uma chave gravada sob uma identidade é ilegível sob outra, o que produz o mesmo sintoma mesmo que as chaves estejam fisicamente presentes. Quando você compartilha chaves entre máquinas, ou desative a criptografia por máquina, ou use um protetor explícito e portátil como `ProtectKeysWithCertificate`.

**Funciona localmente, falha no contêiner.** Esperado. Um único processo na sua máquina de desenvolvimento mantém seu conjunto efêmero em memória pela sessão inteira, então o token sempre descriptografa. O bug só aparece quando uma segunda instância ou um reinício entra em cena. Reproduza-o rodando duas instâncias localmente em portas diferentes sem nada na frente, ou reiniciando entre requisições como na reprodução acima.

**Não "resolva" desabilitando antiforgery.** Remover `[ValidateAntiForgeryToken]` ou `.RequireAntiforgery()` faz o erro desaparecer e reabre um buraco de CSRF. O token está fazendo seu trabalho. Persista as chaves em vez disso.

**`DisableAutomaticKeyGeneration` em réplicas somente leitura.** Se você executa um worker que deve consumir chaves mas nunca cunhá-las, chame `DisableAutomaticKeyGeneration()` para que ele não crie uma chave concorrente no conjunto compartilhado. Deixe-o desativado na instância que é dona da rotação.

## Leitura relacionada

- [.NET 10.0.7 sai fora de banda para corrigir CVE-2026-40372 no ASP.NET Core Data Protection](/pt-br/2026/04/dotnet-10-0-7-oob-cve-2026-40372-dataprotection/) cobre uma falha de validação HMAC no mesmo stack, e por que você quer seu conjunto de chaves corrigido.
- [Como implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) se apoia no Data Protection para o mesmo pipeline de criptografia.
- [Formulários Blazor com SSR estático ganham validação do lado do cliente no .NET 11 Preview 5](/pt-br/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) é onde os tokens de antiforgery aparecem em formulários Blazor renderizados estaticamente.
- [Como persistir estado através do limite de renderização estático-para-interativo do Blazor no .NET 11](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) trata da classe relacionada de bugs de "estado perdido através de um limite".
- [Como adicionar um filtro de exceções global no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) ajuda você a expor esta exceção de forma limpa em vez de como um 400 pelado.

## Fontes

- [Configure ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-11.0) - as APIs exatas `PersistKeysTo*`, `ProtectKeysWith*` e `SetApplicationName` e os nomes de pacotes.
- [Key storage providers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/implementation/key-storage-providers?view=aspnetcore-11.0) - provedores de sistema de arquivos, Azure Blob, Redis e EF Core.
- [Data Protection key management and lifetime](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/default-settings?view=aspnetcore-11.0) - tempo de vida padrão de 90 dias e locais de armazenamento padrão.
- [dotnet/aspnetcore #47185: The antiforgery token could not be decrypted](https://github.com/dotnet/aspnetcore/issues/47185) - relatos do mundo real e orientação dos mantenedores.
