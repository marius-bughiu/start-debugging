---
title: "Como compartilhar lógica de validação entre o servidor e o Blazor WebAssembly"
description: "A maior fonte de divergência de validação entre um cliente Blazor WebAssembly e uma API ASP.NET Core é a tentação de escrever as regras duas vezes. Este guia percorre a única estrutura que escala em .NET 11: uma biblioteca de classes Shared que detém os DTOs e seus validadores, consumida tanto pelo cliente WASM (EditForm + DataAnnotationsValidator ou Blazored.FluentValidation) quanto pelo servidor (filtro de endpoint em minimal API ou model binding do MVC), com um round-trip testado que devolve os ValidationProblemDetails do servidor para o EditContext."
pubDate: 2026-04-29
tags:
  - "blazor"
  - "blazor-webassembly"
  - "aspnetcore-11"
  - "dotnet-11"
  - "validation"
  - "fluentvalidation"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly"
translatedBy: "claude"
translationDate: 2026-04-29
---

Se o seu cliente Blazor WebAssembly e a sua API ASP.NET Core mantiverem cópias separadas das regras de validação, elas divergem dentro do primeiro sprint e produzem o pior tipo de bug: o formulário passa no cliente, o servidor rejeita, o usuário vê um 400 sem nenhuma mensagem inline. A única correção duradoura é colocar tanto os DTOs quanto seus validadores em um terceiro projeto que o cliente e o servidor referenciem, e renderizar a resposta de falha do servidor no mesmo `EditContext` que o cliente usou. Este guia constrói essa estrutura de ponta a ponta em .NET 11 (`Microsoft.AspNetCore.App` 11.0.0, `Microsoft.AspNetCore.Components.Web` 11.0.0, C# 14), primeiro com `System.ComponentModel.DataAnnotations` integrado, depois com `FluentValidation` 12 para regras que data annotations não conseguem expressar.

## Por que um projeto Shared, e não regras duplicadas nem um pacote NuGet

Os dois padrões que falham são óbvios em retrospecto. Copiar e colar atributos `[Required]` do DTO da API para um view model quase idêntico no cliente produz divergência toda vez que alguém edita um e esquece o outro. Colocar os contratos em um pacote NuGet externo funciona para sistemas grandes, mas é exagero para uma única aplicação: você paga bumps de versão, latência de restauração de pacotes e um feed interno por algo que deveria ser uma referência de projeto.

Uma biblioteca de classes `Contracts` (ou `Shared`) dentro da mesma solução é a forma certa. Ela tem como alvo `net11.0`, não tem dependências do ASP.NET, e é referenciada tanto por `WebApp.Client` (o projeto Blazor WASM) quanto por `WebApp.Server` (a API ASP.NET Core). O template de projeto Blazor WebAssembly que vem com .NET 11 (`dotnet new blazorwasm --hosted` foi removido no .NET 8 e continuou fora no .NET 11; agora você cria os três projetos manualmente ou usa `dotnet new blazor --interactivity WebAssembly --auth Individual` para o template unificado de Blazor) já aceita esse layout: escolha o scaffold que usar e adicione um terceiro projeto.

```bash
# .NET 11 SDK (11.0.100)
dotnet new sln -n WebApp
dotnet new classlib -n WebApp.Contracts -f net11.0
dotnet new webapi -n WebApp.Server -f net11.0
dotnet new blazorwasm -n WebApp.Client -f net11.0
dotnet sln add WebApp.Contracts WebApp.Server WebApp.Client
dotnet add WebApp.Server reference WebApp.Contracts
dotnet add WebApp.Client reference WebApp.Contracts
```

Duas regras mantêm `WebApp.Contracts` limpo e impedem que ele puxe acidentalmente código do servidor para o bundle WASM:

1. O `.csproj` não lista nenhum `FrameworkReference` nem pacotes `Microsoft.AspNetCore.*`. Se você precisar de `IFormFile` ou `HttpContext` em um contrato, está misturando formato de fio com lógica de servidor; separe-os.
2. `<IsTrimmable>true</IsTrimmable>` é definido para que a etapa de publicação do WASM não emita aviso em todo validador que use reflexão. Voltaremos a isso na seção de gotchas de AOT.

## O DTO que percorre todos os exemplos

```csharp
// WebApp.Contracts/RegistrationRequest.cs
// .NET 11, C# 14, System.ComponentModel.DataAnnotations 11.0.0
using System.ComponentModel.DataAnnotations;

namespace WebApp.Contracts;

public sealed record RegistrationRequest
{
    [Required, EmailAddress, StringLength(254)]
    public required string Email { get; init; }

    [Required, StringLength(72, MinimumLength = 12)]
    public required string Password { get; init; }

    [Required, Compare(nameof(Password))]
    public required string ConfirmPassword { get; init; }

    [Range(13, 130)]
    public int Age { get; init; }

    [Required, RegularExpression(@"^[a-zA-Z0-9_]{3,20}$",
        ErrorMessage = "Username must be 3-20 letters, digits, or underscores.")]
    public required string Username { get; init; }
}
```

Membros `required` combinados com setters somente `init` te dão um record que o cliente pode construir com sintaxe de inicializador de objeto e que o `System.Text.Json` 11 pode desserializar no servidor sem um construtor sem parâmetros (ele encadeia a inferência equivalente a `[JsonConstructor]` através dos membros `required` no .NET 11). O mesmo record é o tipo vinculado pelo endpoint da API e pelo modelo do `EditForm`. Há exatamente um lugar para alterar uma regra.

## O caminho de DataAnnotations: zero pacotes extras

Para a maior parte dos apps CRUD, data annotations no DTO compartilhado são suficientes. Elas rodam no cliente porque o `<DataAnnotationsValidator>` do Blazor (em `Microsoft.AspNetCore.Components.Forms`) usa reflexão sobre o modelo e alimenta mensagens no `EditContext`, e rodam no servidor porque o pipeline de model binding do ASP.NET Core chama `ObjectGraphValidator` para qualquer tipo marcado com `[ApiController]` ou qualquer parâmetro de minimal API que passe pelo `IValidationProblemDetailsService` padrão (introduzido como parte do trabalho de validação por filtro de endpoint registrado em [aspnetcore#52281](https://github.com/dotnet/aspnetcore/pull/52281)).

Endpoint do servidor, no estilo minimal API:

```csharp
// WebApp.Server/Program.cs
// .NET 11, ASP.NET Core 11.0.0
using Microsoft.AspNetCore.Http.HttpResults;
using WebApp.Contracts;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation(); // .NET 11 endpoint filter that runs DataAnnotations

var app = builder.Build();

app.MapPost("/api/register",
    Results<Ok<RegistrationResponse>, ValidationProblem> (RegistrationRequest req) =>
    {
        // model is already validated by the endpoint filter
        return TypedResults.Ok(new RegistrationResponse(Guid.NewGuid()));
    });

app.Run();

public sealed record RegistrationResponse(Guid UserId);
```

`AddValidation()` é o helper do .NET 11 que registra um filtro de endpoint que percorre os membros descobertos por `[Validator]` ou anotados com `DataAnnotations` de cada parâmetro, e curto-circuita com um corpo `400` `ValidationProblemDetails` antes do seu handler rodar. O formato da resposta é o mesmo que o cliente lê abaixo.

Formulário do cliente, em `WebApp.Client/Pages/Register.razor`:

```razor
@* Blazor WebAssembly, .NET 11. Microsoft.AspNetCore.Components 11.0.0 *@
@page "/register"
@using System.Net.Http.Json
@using WebApp.Contracts
@inject HttpClient Http

<EditForm Model="model" OnValidSubmit="SubmitAsync" FormName="register">
    <DataAnnotationsValidator />
    <ValidationSummary />

    <label>Email <InputText @bind-Value="model.Email" /></label>
    <ValidationMessage For="() => model.Email" />

    <label>Password <InputText type="password" @bind-Value="model.Password" /></label>
    <ValidationMessage For="() => model.Password" />

    <button type="submit">Register</button>
</EditForm>

@code {
    private RegistrationRequest model = new()
    {
        Email = "", Password = "", ConfirmPassword = "", Username = ""
    };

    private async Task SubmitAsync()
    {
        var response = await Http.PostAsJsonAsync("api/register", model);
        if (!response.IsSuccessStatusCode)
        {
            await ApplyServerValidationAsync(response);
        }
    }
}
```

Duas coisas tornam isso uma história de validação *compartilhada* em vez de duas paralelas. Primeiro, `model` é `RegistrationRequest`, o mesmo DTO que o servidor vincula. Segundo, quando `<DataAnnotationsValidator>` avalia o formulário, ele executa exatamente a mesma passada de `Validator.TryValidateObject` que o filtro de endpoint do servidor. O que o cliente aceita, o servidor aceita; o que o servidor rejeita com `EmailAddress`, o cliente também rejeita.

## Mapeando o ValidationProblemDetails do servidor de volta para o EditContext

Mesmo com regras compartilhadas, dois casos de falha vêm apenas do servidor: checagens entre agregados (o e-mail é único na tabela de usuários), e falhas de infraestrutura (rate limit, restrição de banco). Para esses casos, o servidor retorna `400` com `ValidationProblemDetails`, e o cliente precisa extrair cada erro de campo e anexá-lo ao `FieldIdentifier` correto no `EditContext` para que o usuário veja a mensagem inline ao lado do campo ofensor, e não como um alerta genérico de "registro falhou".

```csharp
// WebApp.Client/Validation/EditContextExtensions.cs
// .NET 11, C# 14
using Microsoft.AspNetCore.Components.Forms;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

public static class EditContextExtensions
{
    private static readonly JsonSerializerOptions Options =
        new(JsonSerializerDefaults.Web);

    public static async Task ApplyValidationProblemAsync(
        this EditContext editContext,
        HttpResponseMessage response)
    {
        if ((int)response.StatusCode != 400) return;

        var problem = await response.Content
            .ReadFromJsonAsync<ValidationProblemDetails>(Options);
        if (problem?.Errors is null) return;

        var messageStore = new ValidationMessageStore(editContext);
        messageStore.Clear();

        foreach (var (fieldName, messages) in problem.Errors)
        {
            // ASP.NET Core uses lowercase-first names by default; normalize.
            var pascal = char.ToUpperInvariant(fieldName[0]) + fieldName[1..];
            var identifier = new FieldIdentifier(editContext.Model, pascal);
            foreach (var msg in messages) messageStore.Add(identifier, msg);
        }

        editContext.NotifyValidationStateChanged();
    }
}
```

O handler no arquivo Razor então fica assim:

```csharp
private EditContext editContext = default!;

protected override void OnInitialized() =>
    editContext = new EditContext(model);

private async Task SubmitAsync()
{
    var response = await Http.PostAsJsonAsync("api/register", model);
    if (response.StatusCode == System.Net.HttpStatusCode.BadRequest)
        await editContext.ApplyValidationProblemAsync(response);
}
```

A razão disso importar é que o servidor é o único lugar onde algumas checagens podem rodar. Uma regra de "username já em uso" não pode viver na biblioteca compartilhada porque exige uma chamada ao banco. Ao retransmitir sua falha para o mesmo `EditContext`, o usuário tem um único modelo mental: cada erro aparece ao lado do campo ofensor, independentemente de a regra ter disparado no navegador ou na API.

## Quando DataAnnotations não é suficiente: FluentValidation 12 no projeto compartilhado

DataAnnotations não consegue expressar regras condicionais ("Postcode é obrigatório se Country for 'US'"), não consegue rodar checagens assíncronas contra um serviço, e suas mensagens de erro são desconfortáveis de localizar além de um arquivo de recursos por atributo. FluentValidation 12, lançado em 2026 com suporte de primeira classe para .NET 11, vive tranquilamente no mesmo projeto compartilhado e roda nas duas direções.

Adicione o pacote e escreva um validador ao lado do DTO:

```bash
dotnet add WebApp.Contracts package FluentValidation --version 12.0.0
```

```csharp
// WebApp.Contracts/RegistrationRequestValidator.cs
// FluentValidation 12.0.0, .NET 11, C# 14
using FluentValidation;

namespace WebApp.Contracts;

public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator()
    {
        RuleFor(r => r.Email).NotEmpty().EmailAddress().MaximumLength(254);
        RuleFor(r => r.Password).NotEmpty().MinimumLength(12).MaximumLength(72);
        RuleFor(r => r.ConfirmPassword).Equal(r => r.Password)
            .WithMessage("Passwords do not match.");
        RuleFor(r => r.Username).Matches(@"^[a-zA-Z0-9_]{3,20}$");
        RuleFor(r => r.Age).InclusiveBetween(13, 130);
    }
}
```

No servidor, registre o FluentValidation como fonte de validador para o mesmo filtro `AddValidation()`, ou chame-o explicitamente em um filtro de minimal API:

```csharp
// WebApp.Server/Program.cs additions
using FluentValidation;
using WebApp.Contracts;

builder.Services.AddScoped<IValidator<RegistrationRequest>,
                           RegistrationRequestValidator>();

app.MapPost("/api/register", async (
    RegistrationRequest req,
    IValidator<RegistrationRequest> validator) =>
{
    var result = await validator.ValidateAsync(req);
    if (!result.IsValid) return Results.ValidationProblem(result.ToDictionary());
    return Results.Ok(new RegistrationResponse(Guid.NewGuid()));
});
```

`result.ToDictionary()` produz a forma `IDictionary<string, string[]>` que `Results.ValidationProblem` espera, então o formato de fio que o cliente decodifica é idêntico ao do caminho DataAnnotations. Sua extensão `ApplyValidationProblemAsync` continua funcionando.

No cliente, instale o `Blazored.FluentValidation` (o fork de `aksoftware` é o mantido ativamente em 2026, versão 2.4.0, com alvo `net11.0`) e substitua `<DataAnnotationsValidator />` por `<FluentValidationValidator />`:

```bash
dotnet add WebApp.Client package Blazored.FluentValidation --version 2.4.0
```

```razor
@using Blazored.FluentValidation

<EditForm Model="model" OnValidSubmit="SubmitAsync">
    <FluentValidationValidator />
    <ValidationSummary />
    @* same fields as before *@
</EditForm>
```

O componente encontra o validador por convenção (`FooValidator` para `Foo`) no assembly que contém o modelo, que é `WebApp.Contracts`. Como o validador está no projeto compartilhado, o cliente e o servidor executam a mesma instância das mesmas regras. A única diferença é *onde* elas rodam.

## Regras assíncronas que só podem rodar no servidor

FluentValidation permite misturar regras síncronas e assíncronas. A tentação é colocar `MustAsync(IsUsernameAvailableAsync)` no validador e dar-se por satisfeito. Não faça: o lado do cliente não tem acesso ao seu `UserManager`, e um `EditForm` síncrono do Blazor não consegue aguardar uma regra assíncrona no meio da digitação. O padrão que funciona é marcar regras exclusivamente assíncronas com um `RuleSet`:

```csharp
public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator(IUserUniqueness? uniqueness = null)
    {
        // rules that run everywhere
        RuleFor(r => r.Email).NotEmpty().EmailAddress();
        // ... shared rules omitted

        RuleSet("Server", () =>
        {
            if (uniqueness is null) return; // skipped on client
            RuleFor(r => r.Email).MustAsync(uniqueness.IsEmailFreeAsync)
                .WithMessage("This email is already registered.");
            RuleFor(r => r.Username).MustAsync(uniqueness.IsUsernameFreeAsync)
                .WithMessage("Username taken.");
        });
    }
}

// WebApp.Contracts/IUserUniqueness.cs - interface only, no implementation
public interface IUserUniqueness
{
    ValueTask<bool> IsEmailFreeAsync(string email, CancellationToken ct);
    ValueTask<bool> IsUsernameFreeAsync(string username, CancellationToken ct);
}
```

A interface vive em `WebApp.Contracts` para que o validador compile, mas não tem implementação ali. O servidor fornece uma implementação real respaldada pelo EF Core; o cliente não registra nenhuma, então o parâmetro do construtor é `null` e o ruleset `Server` não adiciona regras. No servidor, você opta por ativá-lo:

```csharp
await validator.ValidateAsync(req,
    options => options.IncludeRuleSets("default", "Server"));
```

Assim, a checagem entre agregados dispara apenas onde pode e volta para o cliente pelo mesmo mapeamento de `ValidationProblemDetails` que você já construiu.

## Gotchas de trim e AOT na etapa de publicação do WASM

A publicação do Blazor WebAssembly no .NET 11 executa IL trimming por padrão e suporta uma passada AOT separada com `<RunAOTCompilation>true</RunAOTCompilation>`. As duas passadas avisam sempre que uma biblioteca usa reflexão sem limite, que é o que tanto DataAnnotations quanto FluentValidation fazem. Três coisas concretas para fazer:

1. Marque o projeto compartilhado como recortável: `<IsTrimmable>true</IsTrimmable>` e `<IsAotCompatible>true</IsAotCompatible>` no `WebApp.Contracts.csproj`. Isso faz o SDK expor os avisos de trim dentro da biblioteca compartilhada onde você pode corrigi-los, em vez de silenciosamente descartar a descoberta de regras no consumidor.
2. Para DataAnnotations, o runtime traz anotações `[DynamicallyAccessedMembers(All)]` em `Validator.TryValidateObject` desde o .NET 8, e elas continuam vigentes no .NET 11; você não precisa fazer mais nada desde que seu DTO seja `public` e seja alcançado a partir de uma raiz que o trimmer consiga ver. O `EditForm` alcança o tipo do modelo via argumento genérico, o que conta.
3. Para FluentValidation 12, todo validador que você define é refletido na inicialização. O componente `Blazored.FluentValidation` 2.4.0 escaneia o assembly com anotações `[DynamicDependency]` aplicadas para sobreviver ao trimming, mas se você publicar com `RunAOTCompilation`, adicione `<TrimmerRootAssembly Include="WebApp.Contracts" />` ao `.csproj` do cliente. Isso enraíza todo o assembly compartilhado e é a resposta correta mais simples; o custo de tamanho no WASM é pequeno porque os únicos tipos públicos em `WebApp.Contracts` são os DTOs e validadores que você já usa.

Se você pular essas etapas, o cliente parece saudável em `dotnet run`, e depois publica uma build Release onde a validação silenciosamente não faz nada porque o trimmer removeu as regras que não conseguiu provar estaticamente que estavam em uso.

## Capitalização dos nomes de campo e a armadilha snake_case

As opções JSON padrão do ASP.NET Core 11 serializam nomes de propriedade em `camelCase`. Portanto, `ValidationProblemDetails.Errors` volta com chave `email`, não `Email`, e `FieldIdentifier` é case-sensitive. A normalização para `pascal` em `ApplyValidationProblemAsync` resolve o caso comum, mas não membros aninhados (`Address.PostalCode` vira `address.PostalCode` se você só capitalizar a primeira letra). Para DTOs aninhados, divida por `.`, capitalize a primeira letra de cada segmento e depois entre no objeto aninhado usando os segmentos para construir uma cadeia de instâncias `FieldIdentifier(parent, propertyName)`. Ou, se você controla as opções JSON, configure `JsonNamingPolicy = null` apenas para `ProblemDetails` escrevendo um `IProblemDetailsService` customizado. A resposta mais simples é manter os DTOs planos o suficiente para que a inversão de capitalização seja uma linha só.

Se você adotar uma política de nomes diferente globalmente (snake_case está popular em 2026 por causa das ferramentas OpenAPI), a mesma ideia se aplica: faça parse da política, inverta-a e passe o nome corrigido para `FieldIdentifier`. Não há um helper integrado para isso em `Microsoft.AspNetCore.Components.Forms`; o `EditContext` foi projetado antes de `ProblemDetails` ser o formato padrão de erro, e os dois ainda não foram integrados.

## Guias relacionados e material-fonte

Para a infraestrutura de apoio que este guia presumiu que você tinha: o [padrão de filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) captura as falhas não relacionadas à validação que nunca deveriam chegar ao usuário como um 500. Se quiser uma visão mais aprofundada do endpoint que sustenta este formulário, [refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) mostra a continuação de `/api/register`. Para clientes tipados gerados a partir do mesmo DTO, para você não digitar a URL na mão, veja [gerar clientes fortemente tipados a partir de uma especificação OpenAPI no .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/). E do lado JSON, [um `JsonConverter` customizado em `System.Text.Json`](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) é a saída de emergência certa quando um único campo do DTO compartilhado precisa de formatos diferentes no fio.

Fontes primárias usadas ao escrever isto:

- [Filtro de validação de endpoint para minimal API no ASP.NET Core 11](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-11.0#validation), MS Learn.
- [`EditForm` do Blazor e `DataAnnotationsValidator`](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/validation?view=aspnetcore-11.0), MS Learn.
- [Referência de `ValidationProblemDetails`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails), .NET API Browser.
- [Documentação do FluentValidation 12](https://docs.fluentvalidation.net/en/latest/blazor.html), página de integração com Blazor.
- [Blazored.FluentValidation 2.4.0](https://github.com/Blazored/FluentValidation), README do GitHub.
- [Guia de trimming e AOT para Blazor WebAssembly no .NET 11](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/configure-trimmer?view=aspnetcore-11.0), MS Learn.
