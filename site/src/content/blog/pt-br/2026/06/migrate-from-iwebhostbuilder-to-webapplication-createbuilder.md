---
title: "Migre de IWebHostBuilder para WebApplication.CreateBuilder no .NET 11"
description: "Uma migração passo a passo do antigo modelo de hospedagem Startup.cs mais WebHostBuilder para o modelo de hospedagem mínima com WebApplication.CreateBuilder, incluindo a depreciação ASPDEPR008, a ordenação de middleware, IStartupFilter e como manter seus testes funcionando."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "minimal-hosting"
lang: "pt-br"
translationOf: "2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder"
translatedBy: "claude"
translationDate: 2026-06-06
---

Se o seu `Program.cs` ainda chama `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`, você está rodando o modelo de hospedagem legado e o compilador começou a avisar você sobre isso. A partir do .NET 10, `WebHost`, `WebHostBuilder` e `IWebHost` estão marcados como obsoletos com o diagnóstico `ASPDEPR008`, e essa depreciação continua no .NET 11. A substituição é o modelo de hospedagem mínima construído em torno de `WebApplication.CreateBuilder(args)`, que tem sido o padrão em todos os templates de projeto desde o ASP.NET Core 6.0. Este post migra uma aplicação baseada em `Startup` para a hospedagem mínima usando `net11.0` como alvo, cobrindo os pontos que realmente derrubam as pessoas: a ordenação de middleware, o escopo de DI perdido na inicialização, `IStartupFilter` e manter os testes de `WebApplicationFactory` passando.

A migração é mecânica para um serviço pequeno (uma ou duas horas) e meio dia para um monólito com middleware customizado, implementações de `IStartupFilter` e um `ConfigureServices` grande. Nada no comportamento da sua aplicação precisa mudar. Você está movendo os mesmos registros e o mesmo pipeline de middleware para um arquivo mais plano. A única diferença semântica real é o escopo de DI da inicialização, abordado abaixo.

## Por que migrar agora

- `WebHost` / `WebHostBuilder` / `IWebHost` emitem avisos de compilação `ASPDEPR008` a partir do .NET 10. Se você compila com `TreatWarningsAsErrors`, sua atualização para o .NET 11 não vai compilar até você sair deles.
- O modelo de hospedagem mínima é onde todo o novo investimento no ASP.NET Core acontece. Recursos como Native AOT para minimal APIs, o enxuto `WebApplication.CreateSlimBuilder` e o `CreateEmptyBuilder` só existem no novo caminho.
- Dois arquivos de bootstrap se consolidam em um. `Startup.cs` mais um método de encanamento `CreateHostBuilder` se tornam um único `Program.cs` legível, e a configuração, os serviços e o pipeline se leem de cima para baixo.
- Isso desbloqueia as minimal APIs. Você não consegue chamar `app.MapGet(...)` de forma limpa em uma base de código cujo pipeline vive dentro de uma assinatura `Startup.Configure(IApplicationBuilder, IWebHostEnvironment)`.

## O que quebra

| Área                       | Mudança                                                                                       | Severidade |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `WebHost` / `IWebHost`     | Obsoleto a partir do .NET 10 (`ASPDEPR008`). Avisos, ou erros sob `TreatWarningsAsErrors`     | alta     |
| `Startup` via `builder.Host`| `WebApplicationBuilder.Host.ConfigureWebHostDefaults(...UseStartup<T>())` lança em tempo de execução  | alta     |
| Escopo de DI na inicialização           | Não há escopo em torno do provedor de serviços durante a inicialização; resolver serviços com escopo agora lança    | média   |
| Ordenação de middleware        | O corpo de `Configure` precisa ser reescrito após `builder.Build()`, na mesma ordem             | média   |
| `IStartupFilter`           | Ainda executa, mas agora roda em torno do pipeline de hospedagem mínima; verifique a ordenação       | baixa     |
| `IHostingStartup`          | Ainda suportado, mas lê o `WebApplicationBuilder` de forma diferente para alguns assemblies         | baixa     |
| `IWebHostBuilder` (interface)| Sobrevive via `builder.WebHost` para configuração restrita (`UseKestrel`, `UseUrls`); não sumiu        | baixa     |

Note a última linha. A *interface* `IWebHostBuilder` não foi removida. O `WebApplicationBuilder` a expõe como `builder.WebHost` para que você ainda possa chamar `builder.WebHost.ConfigureKestrel(...)`. O que está depreciado é o bootstrap autônomo `WebHost.CreateDefaultBuilder()` e o `IWebHost` que ele constrói. O alvo da migração é `WebApplication.CreateBuilder`, não a remoção de todo tipo com `WebHost` no nome.

## Checklist pré-decolagem

1. Instale o SDK do .NET 11 em todas as máquinas de desenvolvimento e runners de CI. Verifique com `dotnet --list-sdks` e confirme que `11.0.x` aparece.
2. Confirme que o projeto já tem como alvo `net6.0` ou posterior. O modelo de hospedagem mínima não existe antes do .NET 6, então uma aplicação .NET 5 ou anterior precisa primeiro de um salto de framework. Veja o [checklist de migração do .NET 8 para o .NET 11](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) se você também estiver cruzando versões LTS, ou o [guia do .NET Framework 4.8 para o .NET 11](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) para o salto maior.
3. Faça um inventário da sua classe `Startup`. Liste cada linha em `ConfigureServices` e cada chamada de middleware em `Configure`, em ordem. A ordem em `Configure` é o contrato que você precisa preservar.
4. Faça um grep por implementações de `IStartupFilter` e assemblies de `IHostingStartup`. Eles rodam fora de `Startup` e são fáceis de esquecer.
5. Faça commit de uma baseline limpa para ter um rollback de um comando.

## O antes: uma aplicação baseada em Startup

Aqui está o formato que quase toda aplicação pré-6.0 compartilha. Dois arquivos, com a fiação do host separada da configuração de serviços e pipeline.

```csharp
// Program.cs -- legacy generic host, ASP.NET Core 3.1 / 5.0 style
// Builds with ASPDEPR008 warnings on .NET 10/11 if WebHost APIs are used
public class Program
{
    public static void Main(string[] args) =>
        CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
```

```csharp
// Startup.cs -- legacy services + pipeline split
public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o =>
            o.UseSqlServer(Configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        services.AddSwaggerGen();
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseHttpsRedirection();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

## Passos da migração

### 1. Mova ConfigureServices para o builder

Crie o builder, depois copie cada linha de `Startup.ConfigureServices` literalmente, substituindo `services` por `builder.Services`. `IConfiguration` está disponível como `builder.Configuration`, então a busca da connection string é transportada sem alterações.

```csharp
// Program.cs -- .NET 11, minimal hosting model
var builder = WebApplication.CreateBuilder(args);

// formerly Startup.ConfigureServices, services -> builder.Services
builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSwaggerGen();
```

Verifique: rode `dotnet build`. O projeto deve compilar com os registros de serviço no lugar, antes de você tocar no pipeline. Se um registro falhar ao resolver `builder.Configuration`, você copiou uma referência ao campo `Configuration` que não existe mais; troque-a por `builder.Configuration`.

### 2. Construa a aplicação e reescreva o pipeline na mesma ordem

Chame `builder.Build()`, depois traduza `Startup.Configure` linha por linha. `IApplicationBuilder app` se torna o `WebApplication app`, e `env.IsDevelopment()` se torna `app.Environment.IsDevelopment()`. A ordem do middleware precisa corresponder exatamente à original, porque a ordem é o pipeline.

```csharp
// .NET 11, minimal hosting model -- continued
var app = builder.Build();

// formerly Startup.Configure, same order
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Duas coisas encolheram. `UseRouting` e `UseEndpoints` não são mais necessários: o host mínimo adiciona o middleware de roteamento automaticamente, e `app.MapControllers()` substitui o bloco `UseEndpoints(e => e.MapControllers())`. Se você tem um middleware que precisa rodar *entre* o roteamento e a execução do endpoint (por exemplo, um middleware customizado que lê os metadados do endpoint correspondente), mantenha uma chamada explícita a `app.UseRouting()` e coloque esse middleware depois dela. Caso contrário, remova ambos.

Verifique: `dotnet run`, depois acesse uma rota conhecida. Um 200 em uma action de controller confirma que o pipeline está conectado. Um 404 em todas as rotas geralmente significa que `MapControllers` está faltando ou fica antes de um middleware terminal.

### 3. Apague Startup.cs e o encanamento CreateHostBuilder

Uma vez que `Program.cs` contenha tudo, apague `Startup.cs` e o antigo método `CreateHostBuilder`. Não tente manter `Startup` vivo chamando `builder.Host.ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`. Isso lança em tempo de execução: a hospedagem mínima proíbe configurar o web host através de `builder.Host` ou `builder.WebHost` uma vez que você está no `WebApplicationBuilder`.

Se você não consegue apagar `Startup` de uma vez (um `ConfigureServices` gigante que você quer migrar incrementalmente), o padrão de ponte é instanciá-lo manualmente em vez de roteá-lo pelo host:

```csharp
// .NET 11 -- temporary bridge, not the WebApplicationBuilder.Host path
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment); // Configure must accept IApplicationBuilder
app.Run();
```

Isso compila porque `WebApplication` implementa `IApplicationBuilder` e `IEndpointRouteBuilder`. Trate-o como andaime para um único PR, não como destino.

Verifique: busque na solução por `UseStartup`, `WebHost.CreateDefaultBuilder` e `ConfigureWebHostDefaults`. Zero ocorrências significa que o bootstrap legado se foi e `ASPDEPR008` não vai disparar.

### 4. Mova a configuração do host e do Kestrel para o builder

Tudo que você configurou no antigo `IWebHostBuilder` (limites do Kestrel, URLs, content root) se move para `builder.WebHost`, que ainda expõe a superfície de `IWebHostBuilder`. Preocupações de host genérico (logging, a integração com Serilog, `UseWindowsService`) se movem para `builder.Host`.

```csharp
// .NET 11 -- host/web host configuration on the new builder
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 50 * 1024 * 1024);
builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));
```

Verifique: confirme que o limite configurado entra em vigor (um corpo de requisição acima do limite retorna `413`), e que seu sink de logging ainda recebe entradas.

## Verificação

Rode este checklist após a migração antes de fazer o merge:

- `dotnet build` produz zero avisos `ASPDEPR008` e zero referências a `UseStartup`.
- `dotnet run` inicia e serve uma rota conhecida com o código de status esperado.
- `dotnet test` passa, incluindo quaisquer testes de integração com `WebApplicationFactory` (veja a pegadinha abaixo).
- Comportamentos dependentes de middleware ainda funcionam de ponta a ponta: desafios de autenticação, redirecionamento HTTPS, preflight de CORS, respostas do exception-handler.
- Um corpo de requisição acima do seu limite do Kestrel ainda retorna `413`, confirmando que a configuração do host foi migrada.

## Plano de rollback

Esta migração é reversível até você apagar `Startup.cs`. A sequência segura é fazer os passos 1 e 2 em uma branch, confirmar que os testes passam, e só então apagar os arquivos legados em um commit separado. Se algo regredir após a remoção, faça `git revert` do commit de remoção para restaurar `Startup.cs` e o antigo `Program.cs`. Como o padrão `Startup` ainda roda no .NET 11 (ele apenas avisa, não foi removido), um revert temporário mantém você entregando enquanto depura. O ponto sem retorno é remover o bootstrap de host genérico por completo; mantenha isso em seu próprio commit.

## Pegadinhas que encontramos

**O escopo de DI da inicialização se foi.** O antigo host genérico criava um escopo de DI enquanto construía o provedor de serviços, então código que resolvia um serviço com escopo durante a inicialização acabava funcionando. A hospedagem mínima não faz isso. Se você resolvia um `DbContext` em `Configure` para rodar uma migração ou um passo de seed, agora você recebe `Cannot resolve scoped service '...' from root provider`. Envolva o trabalho de inicialização em um escopo explícito:

```csharp
// .NET 11 -- explicit scope for startup-time scoped resolution
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
app.Run();
```

Esta é a quebra de tempo de execução mais comum da migração. A regra geral e suas variantes são abordadas em [resolver serviços com escopo a partir de um singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) e em [usar serviços com escopo dentro de um BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

**`WebApplicationFactory<TStartup>` não tem mais um `Startup` para apontar.** Testes de integração que referenciavam `WebApplicationFactory<Startup>` precisam de um novo tipo de ponto de entrada. O ponto de entrada do host mínimo é a classe `Program` gerada automaticamente, mas ela é `internal`, então o projeto de teste não consegue vê-la. Exponha-a adicionando uma declaração parcial no final de `Program.cs`:

```csharp
// Program.cs -- end of file, .NET 11
public partial class Program { }
```

Depois mude a factory de teste para `WebApplicationFactory<Program>`. Sem a declaração parcial você recebe `'Program' is inaccessible due to its protection level` no projeto de teste.

**`IStartupFilter` ainda executa, mas a ordem muda.** Filtros registrados via `services.AddTransient<IStartupFilter, MyFilter>()` continuam a executar, envolvendo o pipeline configurado. Com a hospedagem mínima não há um método `Configure` explícito para eles envolverem, então um filtro que assumia rodar antes da sua configuração de roteamento pode agora rodar em uma posição ligeiramente diferente. Se você usou `IStartupFilter` puramente para injetar middleware de uma biblioteca, audite onde esse middleware aterrissa em relação às suas chamadas `app.Use...` e reordene se uma requisição se comportar de forma diferente.

**Middleware que lê o endpoint correspondente precisa de `UseRouting` explícito.** Remover `UseRouting` é tranquilo para o caso comum, mas se você tem um middleware chamando `context.GetEndpoint()`, ele precisa ficar depois que o roteamento rodou. Readicione `app.UseRouting()` antes desse middleware e mantenha `app.MapControllers()` depois dele. Para uma comparação mais profunda dos dois estilos de endpoint, veja [minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

**Registro dependente de ordem de named options.** Um punhado de equipes dependia de `ConfigureServices` rodar antes do `IHostingStartup` de uma biblioteca. O host mínimo avalia `builder.Services` ansiosamente em `builder.Build()`, então se você registrou um serviço depois de chamar uma extensão de biblioteca que capturou a coleção, o timing pode diferir. Isso é raro, mas se uma option configurada voltar nula após a migração, verifique se você a registrou depois da chamada `Add...` que a consome.

Uma vez que você esteja em `WebApplication.CreateBuilder`, o resto da superfície moderna se abre: endpoints de minimal API ao lado dos seus controllers, `CreateSlimBuilder` para Native AOT, e o tratamento de exceções mais limpo mostrado em [adicionar um manipulador global de exceções no ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/). A migração de hospedagem é o portão; todo o resto é incremental a partir daí.

## Fontes

- [WebHostBuilder, IWebHost, and WebHost are obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/webhostbuilder-deprecated) (.NET breaking changes, diagnóstico `ASPDEPR008`)
- [Migrate from ASP.NET Core in .NET 5 to .NET 6](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60) (o guia original de migração para hospedagem mínima)
- [Code samples migrated to the new minimal hosting model](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60-samples) (exemplos de `Startup` antes/depois)
- [Deprecating WebHostBuilder, IWebHost, and WebHost](https://github.com/dotnet/aspnetcore/discussions/63480) (discussão dotnet/aspnetcore #63480)
