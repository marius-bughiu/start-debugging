---
title: "Formulários SSR estáticos do Blazor ganham validação do lado do cliente no .NET 11 Preview 5"
description: "Formulários do Blazor renderizados de forma estática no servidor só podiam validar após um POST completo de ida e volta. O .NET 11 Preview 5 renderiza os metadados de validação para que o JS do Blazor aplique as regras de DataAnnotations no navegador, sem circuito."
pubDate: 2026-06-11
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-11
---

O [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) chegou em 2026-06-09, e uma mudança no ASP.NET Core fecha uma lacuna que incomodava qualquer um que construísse formulários sobre renderização estática do lado do servidor (static SSR): os formulários agora validam no navegador sem um modo de renderização interativo. Até esta versão prévia, um formulário static SSR tinha exatamente uma forma de avisar o usuário de que o e-mail estava malformado: enviar tudo, deixar o servidor executar `DataAnnotations` e re-renderizar a página com as mensagens de erro. Isso é um POST completo de ida e volta por um erro de digitação.

## Por que os formulários static SSR estavam presos ao servidor

O template Blazor Web App renderiza a maior parte do conteúdo como HTML estático. Não há circuito SignalR nem carga de WebAssembly, que é justamente por que o static SSR é barato e rápido. Mas a validação do lado do cliente precisa de código rodando no navegador, e uma página estática não envia nenhuma lógica de componente ao cliente. Então a validação vivia inteiramente no servidor: você enviava o formulário, o `DataAnnotationsValidator` percorria o modelo e qualquer falha voltava como uma página re-renderizada. Correto, mas lento, e uma experiência ruim ao lado de um formulário interativo que sinaliza um campo errado ao perder o foco.

O contorno habitual era optar o componente do formulário por `InteractiveServer` ou `InteractiveWebAssembly` só para obter feedback ao vivo, pagando por um circuito ou um download de WASM que você de outra forma não precisava.

## Como o Preview 5 fecha a lacuna

No Preview 5 o servidor renderiza as regras de validação como metadados dentro do HTML, e o JS do Blazor as aplica no navegador. Seus atributos de `DataAnnotations` continuam sendo a fonte de verdade autoritativa, avaliados de novo no servidor no envio. O navegador apenas recebe uma cópia antecipada e gratuita das mesmas regras. O recurso vem habilitado por padrão para todo formulário static SSR que inclua um `DataAnnotationsValidator`, e funciona com formulários aprimorados e não aprimorados.

Não há uma API nova para aprender. O formulário que você já escreveu começa a validar do lado do cliente assim que você aponta para o SDK do Preview 5:

```razor
<EditForm Model="Model" Enhance FormName="registration" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <div>
        <label for="Email">Email</label>
        <InputText @bind-Value="Model!.Email" id="Email" />
        <ValidationMessage For="@(() => Model!.Email)" />
    </div>
    <button type="submit" id="submit-btn">Register</button>
</EditForm>
```

```csharp
public class RegistrationModel
{
    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    public string Password { get; set; }

    [Required]
    [Compare("Password")]
    [Display(Name = "Confirm Password")]
    public string ConfirmPassword { get; set; }
}
```

Um e-mail errado ou uma senha curta demais agora aparece no navegador antes de o formulário sequer chegar à rede. O servidor continua executando as mesmas verificações no POST, então você não perde a defesa em profundidade: a validação do cliente é uma camada de conveniência, não um limite de segurança, exatamente como deve ser.

## O que ainda falta

As regras assíncronas (uma verificação de unicidade no banco de dados, uma consulta a uma API remota) ainda não fazem parte disso. As notas de versão dizem que a história assíncrona completa chega quando as novas APIs assíncronas de `DataAnnotations` forem lançadas em uma versão prévia posterior. Por enquanto isso cobre o conjunto de atributos síncronos, que é o grosso da validação de formulários do mundo real.

Isso se combina com as outras adições do Preview 5 como a [serialização JSON Lines do System.Text.Json](/pt-br/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/). Para experimentar, instale o SDK do .NET 11 Preview 5 e aponte para `net11.0`. Todos os detalhes estão nas [notas de versão do ASP.NET Core Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md).
