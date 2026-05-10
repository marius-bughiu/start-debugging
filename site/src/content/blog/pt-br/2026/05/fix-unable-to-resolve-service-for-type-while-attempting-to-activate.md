---
title: "Correção: Unable to resolve service for type 'X' while attempting to activate 'Y'"
description: "O ASP.NET Core lança esta exceção quando um construtor pede um tipo que nunca foi registrado, foi registrado no contêiner errado ou foi adicionado depois que o host foi construído. Três correções concretas cobrem quase todos os casos."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate"
translatedBy: "claude"
translationDate: 2026-05-10
---

A correção: o `ActivatorUtilities` do ASP.NET Core percorreu o construtor de `Y`, pediu ao `IServiceProvider` um `X` e não recebeu nada. Ou você esqueceu de chamar `services.AddScoped<X, XImpl>()` (ou `AddSingleton` / `AddTransient`), registrou a implementação mas pediu uma interface ou classe base que o contêiner não conhece, ou o registro vive em um `IServiceCollection` diferente daquele que o host realmente construiu. Adicione o registro faltante em `Program.cs` antes de `builder.Build()` e confirme que os nomes dos tipos batem exatamente.

```text
System.InvalidOperationException: Unable to resolve service for type 'MyApp.Data.IUserRepository' while attempting to activate 'MyApp.Api.Controllers.UsersController'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.ConstructorMatcher.CreateInstance(IServiceProvider provider)
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.CreateInstance(IServiceProvider provider, Type instanceType, Object[] parameters)
   at Microsoft.AspNetCore.Mvc.Controllers.ServiceBasedControllerActivator.Create(ControllerContext context)
   at Microsoft.AspNetCore.Mvc.Controllers.ControllerActivatorProvider.<>c__DisplayClass4_0.<CreateActivator>b__0(ControllerContext controllerContext)
   at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.Next(State& next, Scope& scope, Object& state, Boolean& isCompleted)
```

Este guia foi escrito contra .NET 11 preview 4, `Microsoft.AspNetCore.App` 11.0.0-preview.4 e `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4. O texto da exceção tem sido estável desde o ASP.NET Core 2.1, então cada correção abaixo se aplica diretamente até .NET Core 3.1, .NET 5, 6, 8 e 10.

Os dois nomes de tipos na mensagem são a parte mais útil: o **primeiro** nome (`X`) é o tipo que o contêiner não conseguiu encontrar, e o **segundo** nome (`Y`) é o consumidor que o pediu. Leia-os nessa ordem antes de fazer qualquer outra coisa, porque a consulta de busca que te trouxe até aqui vai bater com a metade errada da mensagem na metade das vezes.

## Por que o contêiner não encontrou o tipo

Três causas explicam quase todas as ocorrências:

1. **Nada registrado para aquele tipo.** Você escreveu `public UsersController(IUserRepository repo)` mas nunca chamou `services.AddScoped<IUserRepository, UserRepository>()`. O contêiner não tem nenhum mapeamento da interface para a implementação.
2. **Você registrou com a chave errada.** Chamou `services.AddScoped<UserRepository>()` (tipo concreto) mas o controller pede `IUserRepository` (interface). O contêiner só resolve o que você registrou, pelo tipo exato usado como parâmetro genérico ou argumento `serviceType`.
3. **Você registrou em um `IServiceCollection` diferente.** Comum em testes onde o host de testes constrói sua própria coleção, ou em casos incomuns onde você muta `builder.Services` depois de `builder.Build()`. O host tira um snapshot da coleção no momento da build.

Existem algumas variantes menos comuns que vale a pena nomear: um tipo genérico aberto registrado sem o tipo fechado correspondente (`AddScoped(typeof(IRepo<>), typeof(Repo<>))` está OK; `AddScoped<IRepo<User>>(...)` não é o mesmo registro), um serviço `keyed` solicitado por um consumidor sem chave, e um `Action` ou delegate de factory passado a um construtor que a injeção de dependência não consegue sintetizar. Cubra primeiro as três principais.

## Reprodução mínima

Esta é a menor API mínima de .NET 11 que lança a exceção:

```csharp
// .NET 11 preview 4, Microsoft.AspNetCore.App 11.0.0-preview.4
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);

// Notice: no services.AddScoped<IUserRepository, UserRepository>();

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}
```

```csharp
// .NET 11 preview 4
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("users")]
public sealed class UsersController(IUserRepository repo) : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(repo.GetName(id));
}
```

Faça `GET /users/1` e a requisição falha com a exceção da seção acima. O contêiner nunca viu `IUserRepository`, então quando o `ServiceBasedControllerActivator` do MVC tenta construir o controller, o parâmetro do construtor não pode ser satisfeito.

## Correção um: registre o serviço faltante

A primeira coisa a tentar, e a resposta em 80% das vezes:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Escolha o tempo de vida que combina com como o serviço é usado:

- `AddScoped` é o padrão certo para qualquer coisa que toca estado por requisição (um `DbContext` do EF Core, um wrapper de `HttpContext` accessor, um resolver de tenant). Uma instância por escopo de requisição.
- `AddSingleton` é para estado compartilhado sem estado ou seguro para threads (caches, opções, clientes HTTP via `IHttpClientFactory`). Uma instância por processo.
- `AddTransient` é para objetos baratos e sem estado dos quais você quer uma cópia nova toda vez (`IValidator<T>`, mappers). Nova instância por resolução.

Erre isto e você troca a exceção de hoje pela `InvalidOperationException: Cannot consume scoped service ... from singleton ...` de amanhã, ou pior, por um bug silencioso de segurança de threads onde duas requisições compartilham um `DbContext`. A orientação oficial na [documentação de Microsoft.Extensions.DependencyInjection](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) é a referência; opte por `AddScoped` na dúvida quando existir um escopo de requisição.

## Correção dois: registre o tipo de serviço que o construtor de fato pede

Se você tem um registro mas ainda recebe a exceção, o tipo registrado e o tipo consumido não batem. Verifique o construtor contra o registro:

```csharp
// Wrong: only the concrete type is registered
builder.Services.AddScoped<UserRepository>();

// Right: register both the interface and the implementation,
// or just the interface mapped to the implementation
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

O contêiner não faz inferência de interface. Se `UserRepository` implementa `IUserRepository`, registrar apenas `UserRepository` não registra `IUserRepository`. Se o consumidor pede a interface, registre a interface.

Se você genuinamente precisa de ambos ("injete `UserRepository` aqui, mas `IUserRepository` ali"), registre os dois e encaminhe a interface ao concreto:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<UserRepository>();
builder.Services.AddScoped<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
```

Esse padrão importa para serviços hospedados e o pattern de opções, onde consumidores às vezes pedem o `MyOptions` concreto e às vezes `IOptions<MyOptions>`.

## Correção três: registre antes do host ser construído

`builder.Build()` é a linha de corte. Qualquer coisa que você adicione a `builder.Services` depois desse ponto é silenciosamente descartada para o host em execução:

```csharp
// .NET 11 preview 4
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Too late. The container was snapshotted in builder.Build().
builder.Services.AddScoped<IUserRepository, UserRepository>();

app.MapControllers();
app.Run();
```

Reordene para que cada registro rode antes de `Build`. Esse padrão morde com mais frequência quando uma refatoração move uma chamada `Add*` para um método, e o método é chamado do lugar errado. Um padrão útil é colocar cada chamada `services.Add*` dentro de um método de extensão sobre `IServiceCollection` e chamá-lo de um único lugar perto do topo de `Program.cs`:

```csharp
// .NET 11 preview 4
public static class DependencyInjectionExtensions
{
    public static IServiceCollection AddDataServices(this IServiceCollection services)
    {
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        return services;
    }
}

// Program.cs
builder.Services.AddDataServices();
var app = builder.Build();
```

Em testes de integração contra `WebApplicationFactory<TEntryPoint>`, a regra equivalente é que `ConfigureTestServices` roda antes do host de teste ser construído. Se você muta o contêiner de dentro do corpo de um método de teste depois de `factory.CreateClient()`, está mutando uma coleção descartada.

## Variantes que parecem o mesmo erro

Vários erros parecidos se resolvem de formas diferentes e desperdiçam tempo se forem tratados como o mesmo bug:

- **`Cannot consume scoped service '<X>' from singleton '<Y>'`**. O registro existe, mas o tempo de vida está errado. A correção é tornar `Y` scoped, ou pegar `IServiceScopeFactory` / `IServiceProvider` em `Y` e criar um escopo sob demanda. Coberto em [o problema de captura singleton-para-scoped](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- **`No service for type 'IOptions<MyOptions>' has been registered`**. Mesma causa raiz, mensagem diferente: você pulou `services.Configure<MyOptions>(...)` ou `services.AddOptions<MyOptions>().Bind(...)`. Adicionar `Configure` registra `IOptions<MyOptions>` de graça.
- **`Implementation type 'X' can't be converted to service type 'Y'`**. Você escreveu `services.AddScoped(typeof(IFoo), typeof(Bar))` e `Bar` não implementa `IFoo`. O compilador não pega isso porque ambos os argumentos são `Type`. Corrija o tipo ou use a sobrecarga genérica.
- **`A suitable constructor for type 'X' could not be located`**. O tipo está registrado mas a injeção de dependência não consegue construí-lo: cada parâmetro de construtor público precisa ser resolvível, e precisa haver exatamente um construtor (ou `[ActivatorUtilitiesConstructor]` no escolhido). Isto não é o erro `Unable to resolve service`.
- **Serviços keyed**: no .NET 8 e posteriores, `AddKeyedScoped<IFoo, Foo>("primary")` requer `[FromKeyedServices("primary")] IFoo foo` no consumidor. Pedir um `IFoo` simples vai lançar a exceção de resolução de serviço mesmo havendo um registro keyed. Os dois namespaces são separados.

## Como confirmar que o registro está conectado corretamente

Três verificações rápidas vencem qualquer quantidade de adivinhação:

1. **`IServiceProvider.GetService<T>()` do console de desenvolvimento.** Coloque uma única linha logo após `app.Build()` e antes de `app.Run()`:

   ```csharp
   // .NET 11 preview 4 - remove before commit
   using (var scope = app.Services.CreateScope())
   {
       var repo = scope.ServiceProvider.GetService<IUserRepository>();
       Console.WriteLine(repo is null ? "NOT REGISTERED" : repo.GetType().FullName);
   }
   ```

   Se `GetService<T>()` retorna `null`, o registro está faltando ou está scoped a um contêiner diferente. `GetRequiredService<T>()` lançaria a mesma `InvalidOperationException` que você está depurando.

2. **Valide os escopos no startup.** Passe `ValidateScopes = true` e `ValidateOnBuild = true` à factory do provider de serviços e o host se recusará a iniciar se algum registro estiver quebrado:

   ```csharp
   // .NET 11 preview 4
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

   `ValidateOnBuild` percorre cada registro uma vez no momento da build e falha rápido se algum parâmetro de construtor não pode ser satisfeito. No ambiente de desenvolvimento o ASP.NET Core habilita isso para você, razão pela qual a exceção frequentemente aparece no momento em que você inicia a aplicação em vez do momento em que atinge um endpoint.

3. **Imprima os registros.** Quando o registro parece correto mas a exceção continua disparando, despeje a coleção em si antes de `Build`:

   ```csharp
   // .NET 11 preview 4
   foreach (var sd in builder.Services.Where(s => s.ServiceType.Name.Contains("UserRepository")))
   {
       Console.WriteLine($"{sd.Lifetime}: {sd.ServiceType.FullName} -> {sd.ImplementationType?.FullName ?? "factory"}");
   }
   ```

   Isso pega o caso em que você registrou `MyApp.OldNamespace.IUserRepository` e o controller importa `MyApp.NewNamespace.IUserRepository`. A mensagem da exceção mostra o namespace completo, mas o olho passa por cima.

## Casos extremos que pegam desenvolvedores experientes

Alguns padrões disparam essa exceção em código que parece correto à inspeção:

- **`IConfiguration` injetado em uma callback `Configure<TOptions>`**. A callback roda preguiçosamente. Se você referencia um serviço dentro da callback que mais tarde é removido, a exceção dispara na primeira vez em que as opções são resolvidas, não no startup.
- **Serviços em segundo plano que resolvem dependências scoped no construtor**. Um `BackgroundService` é um singleton. Seu construtor não pode pedir um `IUserRepository` se este último for scoped. Injete `IServiceScopeFactory`, crie um escopo dentro de `ExecuteAsync` e resolva a partir do escopo.
- **Serviços hospedados genéricos**. `services.AddHostedService<MyHostedService<MyArg>>()` requer que o genérico fechado `MyHostedService<MyArg>` seja construível pela injeção de dependência, o que significa que `MyArg` também precisa ser resolvível. Genéricos abertos precisam de `services.AddTransient(typeof(IRepo<>), typeof(Repo<>))`.
- **Contêineres de injeção de dependência gerados por código-fonte**. Strawberry Shake, Refit e os geradores de código-fonte do gRPC às vezes registram seus próprios clientes com `IServiceCollection`. Se você chama a extensão `Add*` deles depois de `Build`, a mesma regra de descarte silencioso se aplica.
- **Builds Native AOT**. O contêiner padrão amigável a trimming no .NET 11 ainda resolve via reflexão por padrão. Se você publica com `<PublishTrimmed>true</PublishTrimmed>` e o trimmer remove o tipo de implementação, vai ver a exceção de resolução de serviço em runtime mesmo que o código compile bem. A correção é `[DynamicDependency]` ou registrar o tipo via uma factory tipada.

## Relacionados

- Ligando log e injeção de dependência juntos de forma limpa: [registro estruturado com Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).
- A próxima exceção que você vai encontrar depois desta se escolher o tempo de vida errado: [singleton consumindo DbContext scoped](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- Um uso indevido relacionado do EF Core que aparece quando a injeção de dependência entrega o mesmo `DbContext` a duas requisições: [a second operation was started on this context instance](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Trocas de injeção de dependência em testes que driblam essa exceção registrando um fake: [factory de DbContext em pool em testes do EF Core 11](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).
- Para o modo de falha relacionado de `IConfiguration`: [no connection string named 'DefaultConnection' could be found](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fontes

- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines).
- Microsoft Learn, [Keyed services in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services).
- Microsoft Learn, [Use scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-usage#scope-validation).
- Código-fonte do ASP.NET Core, [`ActivatorUtilities.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection.Abstractions/src/ActivatorUtilities.cs) onde a exceção é lançada.
