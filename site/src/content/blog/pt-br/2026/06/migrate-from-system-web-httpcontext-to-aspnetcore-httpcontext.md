---
title: "Migrar de System.Web.HttpContext para Microsoft.AspNetCore.Http.HttpContext"
description: "Uma migração prática do System.Web.HttpContext do ASP.NET Framework para o HttpContext do ASP.NET Core 11: HttpContext.Current, o mapa de propriedades, Server.MapPath, Session e o shim dos adaptadores System.Web para migrações incrementais."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "httpcontext"
  - "system-web"
lang: "pt-br"
translationOf: "2026/06/migrate-from-system-web-httpcontext-to-aspnetcore-httpcontext"
translatedBy: "claude"
translationDate: 2026-06-06
---

A única linha que quebra mais migrações de ASP.NET Framework do que qualquer outra é `HttpContext.Current`. Ela não existe no ASP.NET Core. Não há um contexto ambiental estático para acessar a partir de uma classe arbitrária, o tipo `HttpContext` é um tipo diferente em um namespace diferente (`Microsoft.AspNetCore.Http.HttpContext`, não `System.Web.HttpContext`), e a maioria das propriedades das quais você dependia foram movidas, mudaram de forma ou sumiram. Este artigo mapeia a API antiga para a nova no .NET 11 / ASP.NET Core 11, e depois mostra os dois caminhos reais à frente: uma reescrita limpa para o código que você controla, e os adaptadores oficiais `System.Web` quando você tem uma pilha de bibliotecas compartilhadas que passam `HttpContext` de um lado para o outro e não podem ser reescritas de uma só vez.

Para um handler pequeno ou um único controller, a reescrita leva uma hora. Para um monólito onde `HttpContext.Current` está costurado por uma camada de negócio em um assembly separado, reserve dias e recorra aos adaptadores para que as bibliotecas continuem compilando contra ambos os frameworks enquanto você migra aplicação por aplicação. Nada da semântica HTTP muda; o que muda é como você alcança a requisição, que o ciclo de vida agora está estritamente vinculado à requisição, e que não há afinidade de thread em que se apoiar.

## Por que esta migração não é um localizar-e-substituir

`System.Web.HttpContext` e `Microsoft.AspNetCore.Http.HttpContext` são objetos genuinamente diferentes, e as lacunas são comportamentais, não apenas cosméticas:

- **`HttpContext.Current` sumiu.** O ASP.NET Framework dava a cada requisição afinidade de thread, então um acessador estático conseguia encontrar o contexto correto a partir da thread atual. O ASP.NET Core não oferece tal garantia, então não há nada equivalente para ler de forma estática. Você injeta o contexto em vez disso.
- **O contexto não pode sobreviver à requisição.** No ASP.NET Core o contexto é reciclado ao final da requisição. Tocá-lo depois (uma referência capturada em uma tarefa fire-and-forget, um campo em cache) lança `ObjectDisposedException`. No Framework isso muitas vezes "funcionava" por acidente.
- **Sem afinidade de thread.** Uma única requisição pode pular de thread através dos pontos `await`. Ler e escrever `HttpContext` de forma concorrente é agora uma condição de corrida que pertence a você.
- **Leituras e escritas passam a ser assíncronas.** `Response.Write` vira `await Response.WriteAsync`. Ler o formulário ou o corpo é `await ReadFormAsync()` / uma leitura de stream. Os cabeçalhos e cookies de resposta devem ser definidos antes de a resposta começar.

O próprio [guia de migração do HttpContext](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0) da Microsoft enquadra isso como duas estratégias, e a escolha conduz tudo o que vem abaixo: reescrita completa, ou adaptadores `System.Web` para uma migração incremental.

## O que quebra

| Área | ASP.NET Framework | ASP.NET Core 11 | Severidade |
| --- | --- | --- | --- |
| Contexto ambiental | `HttpContext.Current` | `IHttpContextAccessor` (registrar com `AddHttpContextAccessor`) | alta |
| Ciclo de vida do contexto | Utilizável após a requisição às vezes | `ObjectDisposedException` após a requisição terminar | alta |
| Segurança de threads | Requisição com afinidade de thread | Sem afinidade de thread através de `await` | alta |
| Escrever na resposta | `Response.Write(s)` | `await Response.WriteAsync(s)` | média |
| Ler formulário / corpo | `Request.Form`, `Request.InputStream` (sync) | `await Request.ReadFormAsync()`, `Request.Body` (leitura única) | média |
| Cabeçalhos / cookies de resposta | Definir a qualquer momento | Definir antes de a resposta começar (ou via `OnStarting`) | média |
| Caminhos físicos | `Server.MapPath("~/x")` | `IWebHostEnvironment.ContentRootPath` / `WebRootPath` + `Path.Combine` | média |
| Session | `Session["k"]`, auto-serializada, com lock | `HttpContext.Session.GetString/SetString`, baseada em bytes, sem lock | média |
| Codificação HTML | `Server.HtmlEncode` | `System.Net.WebUtility.HtmlEncode` / `HtmlEncoder` | baixa |
| URL da requisição | `Request.Url`, `Request.RawUrl` | `Request.Scheme/Host/Path/QueryString` ou `GetDisplayUrl()` | baixa |

## Lista de verificação prévia

- Instale o SDK do .NET 11 (`dotnet --version` reporta `11.x`). Fixe `<TargetFramework>net11.0</TargetFramework>` no projeto web.
- Inventarie cada referência a `HttpContext.Current`. `grep -rn "HttpContext.Current"` em toda a solução é a estimativa honesta do escopo.
- Inventarie `Server.MapPath`, `Session[`, `Request.Url`, `Response.Write` e `Request.ServerVariables`. São os infratores de segundo nível.
- Decida por assembly: reescrever para ASP.NET Core nativo, ou manter `System.Web.HttpContext` e adicionar o pacote adaptador. Bibliotecas compartilhadas que precisam continuar servindo a aplicação Framework ainda não migrada são candidatas a adaptadores.
- Tenha uma suíte de testes no verde antes de tocar em qualquer coisa. A migração é mecânica, e uma suíte que passa é como você a mantém honesta.

## Passos da migração

### Passo 1: Registre o acessador e pare de recorrer ao HttpContext.Current

Substitua o acesso ambiental por injeção explícita. No `Program.cs`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddHttpContextAccessor(); // enables IHttpContextAccessor

var app = builder.Build();
app.MapControllers();
app.Run();
```

Um serviço que antes lia `HttpContext.Current` agora recebe `IHttpContextAccessor`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class CurrentUserService(IHttpContextAccessor accessor)
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

Não armazene `accessor.HttpContext` em um campo. Leia-o no ponto de uso toda vez, porque o campo capturaria um contexto de uma requisição e o entregaria a outra, ou a nenhuma. Dentro de um controller ou de uma API mínima você já tem `HttpContext` como propriedade ou parâmetro, então prefira passá-lo explicitamente e pule o acessador por completo.

**Verifique:** a solução compila sem referências a `System.Web` nos projetos reescritos, e uma requisição que exercita `CurrentUserService` retorna o id de usuário esperado.

### Passo 2: Traduza as propriedades da requisição

A maioria dos membros de `Request` foram movidos em vez de sumir. O mapeamento que cobre os casos comuns:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
string method      = httpContext.Request.Method;          // was HttpMethod
bool   isHttps     = httpContext.Request.IsHttps;         // was IsSecureConnection
string? remoteIp   = httpContext.Connection.RemoteIpAddress?.ToString(); // was UserHostAddress
string userAgent   = httpContext.Request.Headers.UserAgent.ToString();

// Query string: IQueryCollection, indexer never throws on a missing key
string q = httpContext.Request.Query["key"].ToString(); // "" if absent

// Full URL: no single Request.Url anymore
// using Microsoft.AspNetCore.Http.Extensions;
string url = httpContext.Request.GetDisplayUrl();
```

Ler o formulário ou o corpo é assíncrono e o corpo é um stream somente-avanço que você pode ler uma vez:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
if (httpContext.Request.HasFormContentType)
{
    IFormCollection form = await httpContext.Request.ReadFormAsync();
    string firstName = form["firstname"].ToString();
}
```

**Verifique:** acesse um endpoint que leia query, formulário e um cabeçalho; confira que os valores batem com o que a aplicação Framework retornava para a mesma requisição.

### Passo 3: Traduza a resposta, e respeite quando os cabeçalhos podem ser definidos

Escrever é assíncrono, e os cabeçalhos e cookies devem ser definidos antes de o corpo começar a fluir:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.StatusCode = StatusCodes.Status200OK;
httpContext.Response.ContentType = "application/json";
httpContext.Response.Headers["X-Custom"] = "value"; // before first write
await httpContext.Response.WriteAsync(payload);
```

Se você está em middleware e precisa definir cabeçalhos logo antes de a resposta ser enviada, use o callback em vez de defini-los tarde:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.OnStarting(static state =>
{
    var ctx = (HttpContext)state;
    ctx.Response.Headers["X-Late"] = "value";
    return Task.CompletedTask;
}, httpContext);
```

**Verifique:** inspecione os cabeçalhos de resposta com `curl -i`; confirme que o cabeçalho está presente e que você não recebe uma exceção `response has already started` sob carga.

### Passo 4: Substitua Server.MapPath por IWebHostEnvironment

`Server.MapPath("~/App_Data/x.json")` não tem equivalente. Injete `IWebHostEnvironment` e combine os caminhos você mesmo:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class FileService(IWebHostEnvironment env)
{
    public string DataPath(string name) =>
        Path.Combine(env.ContentRootPath, "App_Data", name); // project root
    public string AssetPath(string name) =>
        Path.Combine(env.WebRootPath, name);                 // wwwroot
}
```

`ContentRootPath` é a raiz do projeto (o antigo `~/`), `WebRootPath` é `wwwroot` (a antiga raiz de arquivos estáticos). Para a codificação HTML, `Server.HtmlEncode` vira `System.Net.WebUtility.HtmlEncode` ou, em DI, um `HtmlEncoder` injetado.

**Verifique:** uma requisição que carrega um arquivo resolve o mesmo caminho absoluto que você espera, tanto no Windows quanto no Linux (o `Path.Combine` o mantém portável).

### Passo 5: Mova Session, sabendo que ela se comporta de forma diferente

A session do ASP.NET Core é opcional, baseada em bytes, não é serializada automaticamente e não oferece lock por requisição. Registre-a:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
// ...
app.UseSession(); // before endpoints
```

Depois troque o indexador pelos helpers tipados:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Session.SetString("user", "marius"); // was Session["user"] = "marius"
string? user = httpContext.Session.GetString("user");
httpContext.Session.SetInt32("count", 3);
```

Armazenar um objeto significa serializá-lo você mesmo (por exemplo com `System.Text.Json`) e chamar `SetString`. Não há uma session de objetos automática como o Framework tinha. O [guia de migração de session](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0) vale a leitura se você dependia do lock de session.

**Verifique:** defina um valor em uma requisição, leia-o de volta na próxima; confirme que ele sobrevive entre requisições com o mesmo cookie de session.

## Quando uma reescrita é grande demais: os adaptadores System.Web

Se `HttpContext` está entrelaçado por bibliotecas de classes que uma aplicação Framework ainda não migrada também chama, reescrever cada assinatura de uma vez não é viável. A Microsoft entrega os [adaptadores System.Web](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0) exatamente para isso. Eles reimplementam a forma de `System.Web.HttpContext` sobre o contexto do ASP.NET Core, então uma biblioteca pode mirar `netstandard2.0` e servir ambos os runtimes.

Os pacotes que você verá:

- `Microsoft.AspNetCore.SystemWebAdapters`: o shim em si, referenciado pelas bibliotecas compartilhadas. Mira .NET Standard 2.0, .NET Framework 4.5+ e .NET 5+.
- `Microsoft.AspNetCore.SystemWebAdapters.CoreServices`: referenciado pela aplicação ASP.NET Core para configurar o comportamento. Mira .NET 6+.
- `Microsoft.AspNetCore.SystemWebAdapters.FrameworkServices`: referenciado pela aplicação Framework durante a migração incremental.

Na aplicação ASP.NET Core você opta por ativá-los:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddSystemWebAdapters();
// ...
app.UseSystemWebAdapters();
```

Uma biblioteca que recebia `System.Web.HttpContext` continua compilando depois de você trocar a referência a `System.Web` pelo pacote adaptador. Para converter entre as duas representações dentro de uma requisição você usa as conversões em cache, o que permite reescrever pontos de chamada específicos de forma incremental:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
// Microsoft.AspNetCore.Http.HttpContext -> System.Web.HttpContext
System.Web.HttpContext legacy = coreContext.AsSystemWeb();
// System.Web.HttpContext -> Microsoft.AspNetCore.Http.HttpContext
HttpContext core = legacy.AsAspNetCore();
```

Os adaptadores não são de graça. Eles adicionam overhead frente às APIs nativas, nem todos os membros são suportados, e dois comportamentos precisam ser ativados porque o ASP.NET Core não os fornece por padrão: um stream de requisição com busca e totalmente bufferizado (`PreBufferRequestStream`) e uma resposta bufferizada (`BufferResponseStream`). Se uma biblioteca lê o corpo duas vezes ou depende de `Response.End()`, ative-os nos endpoints relevantes:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapDefaultControllerRoute()
   .PreBufferRequestStream()
   .BufferResponseStream();
```

## Verificação

Após a migração, percorra esta lista:

- `dotnet build` não reporta avisos sobre `System.Web` nos projetos que você reescreveu.
- `dotnet test` passa sem testes de contexto HTTP pulados.
- Um teste de fumaça dos caminhos críticos: login (claims via `HttpContext.User`), um POST de formulário, um download de arquivo, um ida e volta de session.
- Faça um teste de carga breve e observe `ObjectDisposedException` ou `response has already started`. Essas duas exceções são a assinatura de um bug de contexto capturado ou de uma escrita tardia de cabeçalhos.

## Rollback

Isto é uma migração de código, não uma migração de dados, então o rollback é um `git revert` da branch. A única coisa a observar é o formato do estado de session: a session do ASP.NET Core não é compatível no nível de fio com a session do ASP.NET Framework, então se você virou o tráfego de produção e os usuários têm sessões vivas, um rollback descarta essas sessões e força um novo login. Drene ou aceite isso. Nada mais aqui é de mão única.

## Armadilhas que vale a pena conhecer antes de começar

- **`HttpContext` capturado em trabalho em segundo plano.** A falha de produção mais comum: um controller dispara `Task.Run(() => DoWork(HttpContext))` e o contexto já foi descartado quando `DoWork` o lê. Copie primeiro o que você precisa para um objeto simples. Esta é a mesma armadilha de contexto descartado que morde o `DbContext` do EF Core em código fire-and-forget.
- **`accessor.HttpContext` é null fora da requisição.** Em um hosted service ou em uma tarefa de inicialização não há requisição, então o acessador retorna null. Isso é correto, não um bug. Serviços em segundo plano têm seu próprio [padrão de serviços scoped](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **Ler o corpo duas vezes.** `Request.Body` é somente-avanço. Se o model binding já o consumiu, uma leitura posterior não obtém nada. Use `EnableBuffering()` ou o `PreBufferRequestStream` dos adaptadores. Leituras síncronas também lançam exceção a menos que você as permita, que é a mesma causa raiz por trás da exceção [synchronous operations are disallowed](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).
- **Ordem de registro de DI.** Se um serviço que precisa de `IHttpContextAccessor` não consegue resolvê-lo, você esqueceu `AddHttpContextAccessor()`, o que aflora como o familiar erro [unable to resolve service for type](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

Se você faz isso como parte de uma migração de framework mais ampla, isto se encaixa dentro da maior [migração de .NET Framework 4.8 para .NET 11](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/), e você provavelmente também estará substituindo o modelo de hosting no mesmo passo quando [migrar de IWebHostBuilder para WebApplication.CreateBuilder](/pt-br/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/). Para os endpoints novos escritos durante a migração, vale a pena pesar os trade-offs de [APIs mínimas versus controllers](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) antes de portar a forma do controller antigo ao pé da letra.

## Fontes

- [Migrar o HttpContext do ASP.NET Framework para o ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0)
- [Adaptadores System.Web (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0)
- [Acessar o HttpContext no ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-context?view=aspnetcore-10.0)
- [Migração do estado de session de ASP.NET para ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0)
- [dotnet/systemweb-adapters (GitHub)](https://github.com/dotnet/systemweb-adapters)
