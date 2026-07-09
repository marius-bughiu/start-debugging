---
title: "Migrar uma minimal API de verificações de validação manuais para a validação integrada no ASP.NET Core 11"
description: "Guia passo a passo para substituir verificações manuais (if) nos handlers de uma minimal API do ASP.NET Core 11 pelo validador integrado baseado em DataAnnotations e geração de código-fonte: o que quebra, quais regras manuais dá para portar e quais não, e como verificar que o contrato 400 ProblemDetails continua idêntico."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "pt-br"
translationOf: "2026/07/migrate-a-minimal-api-from-manual-validation-to-built-in-validation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-09
---

Se a sua minimal API do ASP.NET Core é anterior ao .NET 10, provavelmente cada handler começa com um bloco de verificações `if (string.IsNullOrWhiteSpace(...)) return Results.BadRequest(...)`. Esta migração substitui essas verificações feitas à mão pela validação integrada que chegou no .NET 10 e permanece inalterada no .NET 11: chame `builder.Services.AddValidation()`, mova as regras para os seus records de requisição como atributos `DataAnnotations` e apague as guardas manuais. Para um serviço típico de 15 a 40 endpoints, conte com meio dia a um dia de trabalho mecânico. O que quebra não é o framework, são as suas suposições: algumas das suas regras manuais faziam coisas que os atributos não conseguem expressar (consultas assíncronas, verificações entre serviços), e o formato da sua resposta de erro pode mudar se você montava payloads `BadRequest` à mão em vez de retornar `ProblemDetails`. A migração vale a pena porque apaga código, torna a validação declarativa e reutilizável, e permanece segura para o recorte (trim) sob Native AOT. Ela também é reversível endpoint por endpoint, então você pode fazê-la de forma incremental. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14; o recurso é idêntico no .NET 10, onde apareceu pela primeira vez.

## Por que abandonar as verificações manuais

O padrão manual funciona, então o argumento para migrar é sobre manutenibilidade e correção, não "o jeito antigo está quebrado":

- **Você apaga código e as regras ficam declarativas.** Um `[Required, Length(3, 20)] string Sku` no record substitui três linhas de verificação imperativa em cada handler que aceita um `Sku`. Escreva a restrição uma vez, ao lado dos dados.
- **Você para de retornar formatos de erro inconsistentes.** Um `Results.BadRequest("Sku is required")` feito à mão retorna uma string simples em um endpoint e um objeto JSON em outro, dependendo de quem escreveu. O validador integrado retorna um único corpo `HttpValidationProblemDetails` (RFC 9457) em todo lugar, com chave por nome de propriedade.
- **A validação permanece segura para o recorte.** O recurso é um gerador de código-fonte em tempo de compilação, não reflexão em tempo de execução, então ele publica limpo sob Native AOT e recorte agressivo, a mesma razão pela qual ele acompanha o [stack de minimal API com Native AOT](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).
- **Parâmetros de query, rota e cabeçalho também são validados.** As verificações manuais quase sempre cobrem o corpo JSON e esquecem os parâmetros de paginação. O filtro integrado valida os parâmetros escalares vinculados a partir da rota e da query com os mesmos atributos.

## O que quebra

O framework em si não quebra, mas estas cinco coisas mudam, e você precisa saber quais das suas regras manuais sobrevivem ao porte:

| Área                                | Mudança                                                                                              | Severidade |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| Corpo da resposta de erro           | Corpos de string simples ou `BadRequest(...)` personalizados viram `ProblemDetails` (RFC 9457) com chave por propriedade | alta       |
| Regras assíncronas / de BD          | `if (await repo.SkuExists(...))` não pode virar atributo; precisa de outro lugar                     | alta       |
| Acessibilidade do tipo de requisição | O record deve ser `public` ou o gerador não emite nada e a validação silenciosamente não roda        | alta       |
| Regras entre campos                 | Blocos `if` de várias propriedades vão para `IValidatableObject`, não para atributos                 | média      |
| Testes que verificam o texto do erro | Testes que verificam suas antigas strings de mensagem personalizadas vão falhar contra o novo `ProblemDetails` | média      |
| Tipo de retorno do handler          | Os handlers podem remover seu braço `BadRequest`; o filtro produz o 400 antes de o handler rodar     | baixa      |

As duas linhas de severidade alta que decidem o formato da sua migração são o corpo do erro e as regras assíncronas. Se os clientes analisam o corpo 400 atual, planeje uma mudança de contrato ou uma camada de compatibilidade. Se alguma verificação manual aguarda E/S, essa regra não vira atributo de forma alguma, e fingir o contrário é o jeito mais comum de essa migração dar errado.

## Lista de verificação prévia

Antes de tocar em um handler:

- **SDK.** Instale o SDK do .NET 10 ou 11. Confirme com `dotnet --version` (espere `11.0.x` ou `10.0.x`).
- **Web SDK.** O projeto deve usar `Microsoft.NET.Sdk.Web`. O gerador de código-fonte de validação é conectado por esse SDK assim que você chama `AddValidation()`.
- **Registre o contrato atual.** Capture as respostas 400 exatas que seus endpoints retornam hoje (algumas chamadas `curl` salvas em arquivos, ou um teste de snapshot). Você está prestes a mudar esse formato e quer uma foto do antes.
- **Faça grep da superfície.** Encontre cada verificação manual para acompanhar o progresso: `grep -rn "return Results.BadRequest\|return TypedResults.BadRequest" src/`. Essa lista é o seu backlog de migração.
- **Inventarie as verificações assíncronas.** Separadamente, `grep -rn "await" src/` dentro dos seus handlers e marque as que condicionam um `BadRequest`. Essas são as regras que não virarão atributos.
- **Tenha uma suíte de testes ou um script de fumaça.** Você quer rodar algo depois de cada endpoint para confirmar que as requisições válidas continuam passando e as inválidas continuam dando 400.

## Passos da migração

### 1. Ative a validação integrada

Registre os serviços antes de construir a app. Este é o único encanamento global que a migração precisa.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();   // registers the validation services and endpoint filter
var app = builder.Build();
```

Com o web SDK atual do .NET 10 ou 11 o gerador de código-fonte fica ativo automaticamente assim que `AddValidation()` está presente. Se você copiou um `.csproj` recortado ou o seu build é anterior à GA, adicione o namespace do interceptor explicitamente:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

**Verificar:** a app ainda compila e inicia. `dotnet build` reporta zero erros. Nenhum comportamento mudou ainda porque nenhum dos seus tipos carrega atributos.

### 2. Mova as regras por campo para o record de requisição

Pegue um endpoint. Leia suas verificações manuais e traduza cada regra expressável como atributo para um atributo `DataAnnotations` no tipo de requisição. Aqui está o antes, um handler carregando sua validação inline:

```csharp
// .NET 11, C# 14 -- BEFORE: manual checks
app.MapPost("/products", (CreateProduct product) =>
{
    if (string.IsNullOrWhiteSpace(product.Sku) || product.Sku.Length is < 3 or > 20)
        return Results.BadRequest("Sku must be 3 to 20 characters.");
    if (string.IsNullOrWhiteSpace(product.Name) || product.Name.Length < 2)
        return Results.BadRequest("Name is required and must be at least 2 characters.");
    if (product.Quantity is < 1 or > 10_000)
        return Results.BadRequest("Quantity must be between 1 and 10000.");

    return Results.Created($"/products/{product.Sku}", product);
});

public record CreateProduct(string Sku, string Name, int Quantity);
```

E o depois: as regras vão para o record como atributos, o handler perde seu bloco de guarda, e o tipo vira `public` para que o gerador possa vê-lo.

```csharp
// .NET 11, C# 14 -- AFTER: declarative validation
using System.ComponentModel.DataAnnotations;

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Repare que o tipo virou `public`. Essa é a razão mais comum de um endpoint migrado parar de validar silenciosamente: o gerador só pode emitir código para tipos que ele consegue nomear, então um `record` deixado com a acessibilidade interna ao arquivo padrão não recebe validação nem erro.

**Verificar:** `curl -i -X POST .../products -d '{"sku":"x","name":"","quantity":0}'` retorna `400` com um corpo `ProblemDetails` listando `Sku`, `Name` e `Quantity`. Um corpo válido ainda retorna `201`.

### 3. Mova as regras entre campos para IValidatableObject

Os atributos validam um membro por vez. Qualquer verificação manual que comparava dois campos ("fim depois do início", "desconto exige um motivo") não vira atributo. Implemente `IValidatableObject` no record de requisição no lugar:

```csharp
// .NET 11, C# 14 -- cross-field rule ported from a manual if-block
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

O array de nomes de membro que você passa como segundo argumento controla sob qual chave o erro cai, então passe o campo que a sua UI deve destacar. `Validate` roda depois das verificações de atributo, então um `Start` em `null` já é reportado por `[Required]` antes de a sua lógica entre campos rodar.

**Verificar:** poste um intervalo onde `End <= Start` e confirme que a chave do erro é `End`, não uma chave vazia no nível do modelo.

### 4. Realoque as verificações assíncronas e entre serviços

Este é o passo que o backlog de migração do seu grep de `await` alimenta. Uma regra como "rejeitar se o SKU já existe no catálogo" bate no banco de dados, e nem `DataAnnotations` nem `IValidatableObject` conseguem aguardar. Você tem duas opções honestas:

Mantenha essa verificação específica como uma chamada explícita dentro do handler, depois de o validador integrado já ter garantido que o formato é válido:

```csharp
// .NET 11, C# 14 -- async rule stays explicit, but shape is pre-validated
app.MapPost("/products", async (CreateProduct product, IProductRepository repo, CancellationToken ct) =>
{
    // Built-in validation already ran: Sku is non-null, 3-20 chars, Quantity in range.
    if (await repo.SkuExistsAsync(product.Sku, ct))
        return Results.Conflict($"A product with SKU {product.Sku} already exists.");

    await repo.AddAsync(product, ct);
    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

Ou, se você tem muitas regras assíncronas, mantenha o FluentValidation exatamente para esses tipos de requisição e deixe o recurso integrado cuidar dos simples. As vantagens e desvantagens estão detalhadas em [validação de minimal API vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/); a versão curta é que regras assíncronas e lógica condicional rica são as duas razões para manter uma biblioteca de validação. Não tente forçar uma chamada a `DbContext` dentro de um `IValidatableObject`; ela é síncrona e vai ou bloquear uma thread ou empurrar você para o território de deadlock com `.Result`.

**Verificar:** a verificação de unicidade ainda rejeita um SKU duplicado (agora como um `409`, ou o status que você escolher), e um SKU inédito ainda tem sucesso.

### 5. Reutilize uma regra com um ValidationAttribute personalizado

Se a mesma verificação manual aparecia em três handlers ("esta data não pode estar no passado"), não copie um `IValidatableObject` em três records. Escreva um `ValidationAttribute` e o gerador o captura como qualquer atributo integrado:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

Esta é a resposta baseada em atributos aos blocos `if` duplicados: a regra vive uma vez e se aplica onde quer que o tipo seja usado.

**Verificar:** um endpoint que antes repetia a mesma verificação de data agora rejeita uma data passada com o atributo, e os demais endpoints que compartilham o tipo herdam a regra.

### 6. Apague o código de guarda morto e simplifique os tipos de retorno

Uma vez que as regras de um endpoint são declarativas, remova o bloco `if` manual por completo, e simplifique o tipo de retorno declarado do handler. Como o 400 é produzido pelo filtro de endpoint antes de o corpo do handler rodar, um handler não precisa mais de um braço `BadRequest` na sua união `Results<...>`:

```csharp
// .NET 11, C# 14 -- return type no longer needs BadRequest
app.MapPost("/products", (CreateProduct product)
    => TypedResults.Created($"/products/{product.Sku}", product))
   .Produces<CreateProduct>(StatusCodes.Status201Created)
   .ProducesValidationProblem();   // documents the 400 the filter produces
```

**Verificar:** o OpenAPI ainda anuncia o `400` (via `ProducesValidationProblem`), e o endpoint compila sem o braço de união removido.

## Verificação

Depois de migrar um lote de endpoints, passe por esta lista antes de dar por concluído:

- **Compila.** `dotnet build` reporta zero avisos e zero erros. Observe especificamente que não há nada, porque um tipo faltando `public` falha em silêncio, não de forma barulhenta. Isso é o que o próximo item captura.
- **Cada endpoint migrado realmente valida.** Rode de novo suas chamadas `curl` de requisição inválida (ou testes) contra cada endpoint migrado. Um endpoint que retorna `201` para um corpo que você espera que seja rejeitado significa que o gerador não viu o tipo; verifique o modificador de acesso primeiro.
- **As requisições válidas ainda passam.** Confirme que o caminho feliz retorna o mesmo status de sucesso que retornava antes.
- **O contrato de erro é o que os clientes esperam.** Compare o novo corpo `ProblemDetails` com a sua foto prévia. Se um cliente analisa o dicionário `errors`, confirme que as chaves batem com os nomes de propriedade que ele espera.
- **A suíte de testes está verde.** `dotnet test` passa. Espera-se que os testes que verificavam suas antigas strings de erro personalizadas falhem; atualize-os para verificar o formato `ProblemDetails` em vez de reverter a migração.
- **Sem regressão de desempenho na inicialização.** Como o recurso é gerado em código-fonte, a inicialização deve ser plana ou um pouco mais rápida (você removeu código). Se você manteve o FluentValidation para alguns tipos, a compilação de expressão no primeiro uso ainda se aplica a esses tipos.

## Plano de rollback

Esta migração é reversível e, melhor ainda, é incremental, então você raramente precisa de um rollback completo. Dois níveis:

- **Por endpoint, sem reverter código.** Se um endpoint migrado se comportar mal em produção, encadeie `DisableValidation()` nele para desligar o filtro para aquela rota enquanto mantém o registro global e todos os demais endpoints validados:

  ```csharp
  // .NET 11, C# 14 -- disable validation on a single endpoint
  app.MapPost("/internal/import", (CreateProduct product)
      => TypedResults.Accepted($"/products/{product.Sku}", product))
     .DisableValidation();
  ```

- **Rollback completo.** Como você migrou endpoint por endpoint, o diff de cada endpoint é autocontido: restaure seu bloco `if` manual e remova os atributos do record se nenhum outro endpoint depender deles. Remover a chamada global `AddValidation()` desliga o recurso por completo sem nenhuma outra mudança de código. Nada nesta migração é de mão única no nível do framework.

## Pegadinhas que enfrentamos

Problemas reais que custaram tempo, e suas soluções:

- **O no-op silencioso de um tipo que não é `public`.** De longe o mais frequente. Você move os atributos para um `record CreateProduct(...)`, o build tem sucesso, e a validação nunca dispara porque o tipo não é `public`. Não há aviso. Se um endpoint migrado para de rejeitar entradas ruins, verifique o modificador de acesso antes de qualquer coisa.
- **Alvos de atributo em records posicionais.** Em um record posicional, `[Required] string Name` é lido diretamente pelo gerador de validação. Você só precisa do alvo explícito `[property: Required] string Name` se alguma outra ferramenta refletir sobre a propriedade gerada em tempo de execução. Misturar as duas expectativas é uma fonte comum de confusão do tipo "por que este atributo é ignorado".
- **Objetos aninhados validam recursivamente, o que pode te surpreender.** Se um record de requisição referencia um record `BillingAddress`, o gerador valida também o endereço, e as chaves de erro usam um caminho com pontos como `Billing.PostalCode`. Se o seu antigo código manual só verificava o objeto de nível superior, você agora pode obter 400 em campos aninhados que nunca validou antes. Isso geralmente é correto, mas é uma mudança de comportamento a se esperar.
- **Ordem dos filtros.** A validação roda como um filtro por endpoint. Se você já adiciona suas próprias chamadas `AddEndpointFilter`, saiba onde a validação se posiciona na cadeia, especialmente entre grupos de rotas; as regras de composição são as mesmas de [organizar endpoints de minimal API com MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Não mude o contrato de erro em silêncio por acidente.** Se você quer que o `ProblemDetails` migrado bata com um formato específico (um `type` URI personalizado, membros adicionais), dê forma a ele de maneira centralizada em vez de por endpoint; a mecânica está em [personalizar as respostas de erro de validação de minimal API com IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

O modelo mental para levar embora: esta migração não é adotar um framework novo, é apagar código de guarda imperativo e reexpressar as mesmas regras de forma declarativa sobre os seus tipos de requisição. As regras expressáveis como atributo vão para `DataAnnotations`, as entre campos para `IValidatableObject`, as reutilizáveis para um `ValidationAttribute` personalizado, e as assíncronas ficam explícitas no handler depois de o formato já estar garantido como válido. Faça uma de cada vez, verifique cada uma com a chamada de requisição inválida, e o código repetitivo de blocos `if` que abria cada handler simplesmente some.

## Relacionados

- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para a configuração completa do recurso integrado para o qual você está migrando.
- [Validação de minimal API vs FluentValidation no ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) para decidir o que manter em uma biblioteca de validação versus mover para dentro da caixa.
- [Como personalizar as respostas de erro de validação de minimal API com IProblemDetailsService no ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para dar forma ao corpo 400 depois da migração.
- [Minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para a decisão do modelo de endpoint que está por baixo desta.
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para onde o filtro de validação se posiciona em relação aos filtros de grupo.

## Fontes

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (validação integrada de minimal API, `AddValidation`, gerador de código-fonte, `DisableValidation`, `ProblemDetails`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (validação de objetos aninhados, descoberta do gerador de código-fonte, formato do erro).
