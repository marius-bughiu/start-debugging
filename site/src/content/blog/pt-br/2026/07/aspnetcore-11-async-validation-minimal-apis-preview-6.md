---
title: "A validação assíncrona chega às Minimal APIs com o .NET 11 Preview 6"
description: "O Preview 6 adiciona AsyncValidationAttribute e IAsyncValidatableObject para que as regras de DataAnnotations consultem o banco de dados antes de o seu endpoint rodar, sem bloquear uma thread."
pubDate: 2026-07-20
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "validation"
  - "minimal-apis"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/aspnetcore-11-async-validation-minimal-apis-preview-6"
translatedBy: "claude"
translationDate: 2026-07-20
---

O [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) fecha uma lacuna que o DataAnnotations carrega desde o lançamento: a validação era síncrona. Se uma regra precisava consultar o banco de dados (este e-mail já está em uso, este horário ainda está livre?), você bloqueava uma thread dentro do `IsValid` ou abandonava o DataAnnotations e partia para o FluentValidation. O Preview 6 adiciona validadores assíncronos de primeira classe e os conecta à validação integrada de Minimal APIs introduzida no .NET 10.

## Os dois novos ganchos

Dois tipos surgem em `System.ComponentModel.DataAnnotations`. O primeiro é `AsyncValidationAttribute`, para uma regra sobre um único membro:

```csharp
public sealed class UniqueEmailAttribute : AsyncValidationAttribute
{
    // Still required, but throws if the attribute is async-only.
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
        => throw new InvalidOperationException("Use IsValidAsync.");

    protected override async Task<ValidationResult?> IsValidAsync(
        object? value, ValidationContext context, CancellationToken cancellationToken)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var exists = await db.Users.AnyAsync(u => u.Email == (string?)value, cancellationToken);
        return exists ? new ValidationResult("Email is already registered.") : ValidationResult.Success;
    }
}
```

O segundo é `IAsyncValidatableObject`, para regras que abrangem várias propriedades ou precisam do objeto inteiro. Ele retorna um `IAsyncEnumerable<ValidationResult>`, e como estende `IValidatableObject` você ainda implementa o `Validate` síncrono (que lança uma exceção quando você valida apenas de forma assíncrona):

```csharp
public class ReservationRequest : IAsyncValidatableObject
{
    public DateOnly Date { get; set; }
    public int PartySize { get; set; }

    public IEnumerable<ValidationResult> Validate(ValidationContext context)
        => throw new InvalidOperationException("Use ValidateAsync.");

    public async IAsyncEnumerable<ValidationResult> ValidateAsync(
        ValidationContext context,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var taken = await db.Reservations.CountAsync(r => r.Date == Date, cancellationToken);
        if (taken + PartySize > 40)
            yield return new ValidationResult("No capacity left for that date.", [nameof(PartySize)]);
    }
}
```

## Como configurar

Não há nova ativação além da chamada `AddValidation()` que o .NET 10 já introduziu. Registre-a, e o framework executa seus validadores assíncronos antes de o corpo do endpoint ser executado:

```csharp
builder.Services.AddValidation();

app.MapPost("/reservations", (ReservationRequest request) => Results.Ok(request));
```

Uma requisição inválida é interrompida com um `400` e um payload `ValidationProblemDetails`, exatamente como no caminho síncrono. Por baixo dos panos, isso se apoia na nova API `Validator.ValidateObjectAsync` das bibliotecas base, então também funciona fora do ASP.NET Core.

## O detalhe que vale a pena conhecer

A validação assíncrona convida a idas e voltas em série por acidente, então o framework executa o trabalho de forma concorrente quando pode: atributos assíncronos no mesmo membro começam juntos, e os itens de uma coleção são validados em paralelo. Ainda assim preserva a ordem existente entre membro, tipo e `IValidatableObject`, de modo que uma checagem barata de `[Required]` falha rápido antes de você pagar por uma consulta ao banco de dados. Combine isso com a [proteção CSRF automática](/pt-br/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) do Preview 6 e o pipeline integrado cobre muito mais terreno do que cobria uma versão atrás.

Baixe o SDK do .NET 11 Preview 6, mire em `net11.0` e leia as [notas de versão do ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md) para conhecer toda a superfície de validadores.
