---
title: "Por que seu JWT no ASP.NET Core retorna 401 mesmo com um token válido"
description: "Um token válido que ainda retorna 401 quase sempre significa que o handler bearer nunca rodou ou rodou sob o esquema errado. Verifique a ordem do middleware, o esquema padrão, o nome do esquema e se o cabeçalho sequer chegou ao handler."
pubDate: 2026-06-25
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "pt-br"
translationOf: "2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token"
translatedBy: "claude"
translationDate: 2026-06-25
---

Você decodificou o token no [jwt.io](https://jwt.io/), a assinatura confere, o `exp` está a horas de distância, o `iss` e o `aud` são exatamente o que você configurou, e o ASP.NET Core ainda responde `401 Unauthorized`. Quando o próprio token é comprovadamente bom, o bug quase nunca está no token. O que acontece é que o handler bearer do JWT ou nunca rodou para essa requisição, ou rodou sob um esquema que seu atributo `[Authorize]` não está pedindo. Os quatro culpados de sempre, na ordem em que mordem: `app.UseAuthentication()` está faltando ou fica depois de `app.UseAuthorization()`; nenhum esquema de autenticação padrão está registrado; o nome do esquema em `AddJwtBearer` não corresponde ao que `[Authorize]` desafia; ou o cabeçalho `Authorization` nunca chegou ao handler. Este post usa .NET 11 com `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0-preview e C# 14, mas o diagnóstico é idêntico até o .NET 8.

Se você suspeita que as claims do token estão realmente erradas (uma janela de `ClockSkew` de cinco minutos, uma audience incompatível), isso é outro post: [como validar o issuer, a audience e o tempo de vida de um JWT](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) percorre o lado de `TokenValidationParameters` em detalhe. Aqui presumimos que você já provou que o token é válido e o 401 persiste mesmo assim.

## O que o 401 realmente diz a você

A resposta que você vê é enxuta de propósito:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

De acordo com a [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), um 401 deve carregar um cabeçalho `WWW-Authenticate` nomeando um desafio, e o ASP.NET Core envia `Bearer`. O que ele não envia por padrão é um motivo. Se o handler rodou e rejeitou o token, a verdadeira causa é uma exceção `Microsoft.IdentityModel` que o handler engoliu. Se o handler nunca rodou, não há exceção alguma, apenas uma política de autorização que não encontrou nenhum usuário autenticado e desafiou. Distinguir esses dois casos é o jogo inteiro, e a maneira mais rápida de fazê-lo é fazer o handler falar (abordado perto do fim).

Uma coisa para descartar imediatamente: um 401 significa "não sabemos quem você é." Um 403 significa "sabemos quem você é, você só não tem permissão." Se você está recebendo 403, o token validou bem e seu problema é uma verificação de política ou de role, não de autenticação. Não gaste uma tarde depurando validação de token para um 403.

## Causa 1: UseAuthentication está faltando ou depois de UseAuthorization

Esta é a causa mais comum de todas e a mais fácil de não notar, porque ambas as linhas estão presentes, só que na ordem errada. O middleware de autenticação é o que lê o cabeçalho `Authorization`, executa o handler bearer e define `HttpContext.User`. O middleware de autorização é o que impõe `[Authorize]`. Se a autorização roda primeiro, `HttpContext.User` ainda é o padrão anônimo, então todo endpoint protegido desafia com um 401 não importa quão bom seja o token.

```csharp
// .NET 11, C# 14 -- WRONG: authorization runs before the user is set
app.UseAuthorization();
app.UseAuthentication();   // too late, User is already anonymous
```

```csharp
// .NET 11, C# 14 -- correct order
app.UseAuthentication();   // reads the token, populates HttpContext.User
app.UseAuthorization();    // now enforces [Authorize] against a real user
```

A regra é mecânica: `UseAuthentication` antes de `UseAuthorization`, e ambos depois de `UseRouting` (no modelo moderno de hosting mínimo, `UseRouting` é adicionado para você, então na maioria das vezes você só precisa das duas chamadas de auth na ordem relativa correta). Se você removeu `UseAuthentication` por completo, talvez durante uma refatoração, o sintoma é idêntico: um 401 universal em qualquer coisa com `[Authorize]`. Adicione-o de volta primeiro, antes de mexer em qualquer outra coisa.

## Causa 2: nenhum esquema de autenticação padrão está registrado

Um atributo `[Authorize]` sem esquema nomeado usa o *esquema de autenticação padrão*. Se você nunca disse ao `AddAuthentication` qual é esse padrão, não há esquema para rodar, o usuário permanece anônimo e você recebe um 401. Isso pega as pessoas porque o registro *parece* completo:

```csharp
// .NET 11, C# 14 -- WRONG: no default scheme, [Authorize] has nothing to run
builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`AddAuthentication()` sem argumento registra os serviços, mas não define nenhum esquema padrão. A correção é passar o nome do esquema como o padrão, que é exatamente o que `AddJwtBearer` registra quando você não o nomeia:

```csharp
// .NET 11, C# 14 -- correct: "Bearer" becomes the default scheme
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`JwtBearerDefaults.AuthenticationScheme` é a string `"Bearer"`. Passá-la para `AddAuthentication` define `DefaultAuthenticateScheme` e `DefaultChallengeScheme` como `"Bearer"` de uma só vez, então um `[Authorize]` simples agora sabe executar o handler bearer. Se você prefere ser explícito, defina as propriedades diretamente:

```csharp
// .NET 11, C# 14 -- the explicit form, equivalent to the above
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options => { /* ... */ });
```

## Causa 3: o nome do esquema não corresponde

No momento em que você dá a `AddJwtBearer` um nome de esquema personalizado, você optou por sair do padrão e agora tem que pedir esse esquema pelo nome em todo lugar. Esta é a segunda armadilha mais comum de "token válido, ainda 401", e é traiçoeira porque a configuração no resto está perfeita.

```csharp
// .NET 11, C# 14 -- registers the handler under "MyApi", not "Bearer"
builder.Services.AddAuthentication()
    .AddJwtBearer("MyApi", options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

```csharp
// .NET 11, C# 14 -- a bare [Authorize] looks for the default scheme,
// which is unset, so the "MyApi" handler never runs -> 401
[Authorize]
public class OrdersController : ControllerBase { /* ... */ }
```

Você tem duas saídas. Ou torne `"MyApi"` o padrão para que um `[Authorize]` simples o encontre, ou nomeie o esquema em todo atributo que deve usá-lo:

```csharp
// .NET 11, C# 14 -- option A: make the named scheme the default
builder.Services.AddAuthentication("MyApi")
    .AddJwtBearer("MyApi", options => { /* ... */ });

// .NET 11, C# 14 -- option B: ask for the scheme by name
[Authorize(AuthenticationSchemes = "MyApi")]
public class OrdersController : ControllerBase { /* ... */ }
```

Isso importa mais quando você genuinamente roda mais de um esquema, digamos um esquema bearer para sua API mais cookies para uma área administrativa renderizada no servidor. Com múltiplos esquemas não há um único padrão sensato, então os endpoints bearer devem soletrar `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. Pule isso e a requisição é validada contra qualquer esquema que por acaso seja o padrão, que não é o seu, e o token é ignorado.

## Causa 4: o cabeçalho nunca chegou ao handler

Se o handler rodou, não encontrou nenhum cabeçalho `Authorization` (ou um malformado), ele não consegue autenticar ninguém, e você recebe um 401 que não tem nada a ver com o conteúdo do token. O token na sua aba do Postman é válido; ele só não está chegando da forma que você pensa.

O formato é estrito. O valor do cabeçalho deve ser a palavra literal `Bearer`, um espaço, e então o token bruto, sem aspas e sem confusão entre `Basic`/`Bearer`:

```text
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

Maneiras comuns de isso dar errado na prática:

- **O cliente nunca o anexa.** Um `HttpClient` tipado cujo `DefaultRequestHeaders.Authorization` foi definido em uma instância *diferente* de cliente, ou uma chamada fetch que esqueceu o cabeçalho nas retentativas. Registre os cabeçalhos de entrada no servidor para ver o que de fato chegou.
- **Um preflight de CORS está sendo rejeitado, não sua requisição real.** Um navegador envia um preflight `OPTIONS` sem cabeçalho `Authorization` antes da chamada real. Se o CORS estiver mal configurado, o navegador bloqueia a requisição real e sua aba de rede mostra o que parece ser uma falha de autenticação. A correção é do lado do CORS, não do lado do token: veja [como configurar CORS para uma API protegida por JWT](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) para a ordem correta do middleware e da política.
- **Um proxy reverso ou balanceador de carga o remove.** Alguns proxies descartam `Authorization` no encaminhamento, a menos que sejam explicitamente instruídos a preservá-lo. Se funciona localmente e retorna 401 apenas atrás do nginx, IIS ou de um ingress controller, suspeite disso primeiro.
- **Um explorador de API está descartando-o.** O Swagger UI e o Scalar enviarão requisições silenciosamente sem o token se a integração de auth deles não estiver conectada. Se seu `curl` funciona mas a UI de documentação não, esse é o indício, abordado em [por que seu token bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

## Faça o handler dizer a você o porquê

Pare de adivinhar. Conecte `JwtBearerEvents` para que o handler registre o resultado real, e então você saberá em uma requisição se ele rodou e, se rodou, qual verificação falhou.

```csharp
// .NET 11, C# 14
.AddJwtBearer(options =>
{
    options.Authority = "https://login.example.com";
    options.Audience = "api://my-api";

    options.Events = new JwtBearerEvents
    {
        OnAuthenticationFailed = ctx =>
        {
            // Fires only if the handler RAN and the token was rejected.
            // ctx.Exception carries the IDX code (expired, bad audience, etc.)
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning(ctx.Exception, "JWT rejected");
            return Task.CompletedTask;
        },
        OnChallenge = ctx =>
        {
            // Fires whenever a 401 is about to be sent, INCLUDING the
            // "no token / handler never validated anything" case.
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning("JWT challenge: {Error} {Desc}",
                ctx.Error, ctx.ErrorDescription);
            return Task.CompletedTask;
        },
        OnTokenValidated = ctx =>
        {
            // Fires when a token validated successfully. If you see THIS
            // and still get a 401, the problem is authorization, not auth.
            return Task.CompletedTask;
        },
    };
});
```

A árvore de decisão que isso lhe dá é precisa. Se `OnAuthenticationFailed` dispara, o handler rodou e rejeitou um token real; leia `ctx.Exception` para o código `IDX` e pule para o [guia de validação de token](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Se apenas `OnChallenge` dispara sem uma falha precedente, o handler nunca teve um token para validar, então você está olhando para as causas 1 a 4 acima, não para o token. Se `OnTokenValidated` dispara e você *ainda* recebe um não-200, você tem um problema de autorização com cara de 403 vestido de fantasia de 401, e nenhum ajuste no token vai ajudar.

Você pode obter o mesmo sinal sem código aumentando a categoria de log em `appsettings.Development.json`:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Authentication": "Debug"
    }
  }
}
```

Isso traz à tona linhas como "Bearer was not authenticated. Failure message: ..." direto no console, o que sozinho resolve a maioria desses casos em menos de um minuto.

## Um token comprovadamente bom e confiável para testar

Metade do tempo gasto nesse bug é dúvida sobre se o token é realmente válido. Remova a dúvida com a ferramenta `dotnet user-jwts`, que cunha um token assinado com uma chave que ela também conecta na sua configuração de desenvolvimento, de modo que a validação não pode falhar por incompatibilidade de chave:

```bash
# .NET 11 SDK -- creates a local-dev JWT and configures the app to accept it
dotnet user-jwts create
```

Se um token `user-jwts` autentica mas o token do seu provedor real não, as claims ou a chave de assinatura do token são a diferença e você está de volta aos parâmetros de validação. Se até o token `user-jwts` retorna 401, o token nunca foi o problema, e uma das quatro causas de configuração acima é. Esse único experimento divide o espaço de busca limpamente ao meio.

## Diagnostique na ordem

Quando um token válido retorna 401, percorra este checklist de cima para baixo. Os primeiros passos pegam a esmagadora maioria, então não pule à frente.

1. **Confirme que é um 401, não um 403.** Um 403 significa que a autenticação já teve sucesso; pare aqui e olhe para suas políticas de autorização.
2. **Verifique a ordem do middleware.** `app.UseAuthentication()` deve estar presente e deve vir antes de `app.UseAuthorization()`. Isso sozinho corrige a maioria dos casos.
3. **Verifique o esquema padrão.** Ou passe `JwtBearerDefaults.AuthenticationScheme` para `AddAuthentication`, ou defina `DefaultAuthenticateScheme` explicitamente. Um `AddAuthentication()` simples com um `[Authorize]` simples não pode funcionar.
4. **Verifique o nome do esquema.** Se você nomeou o esquema em `AddJwtBearer("X")`, ou torne `"X"` o padrão ou use `[Authorize(AuthenticationSchemes = "X")]` em todo lugar.
5. **Confirme que o cabeçalho chega.** Registre os cabeçalhos da requisição de entrada no servidor. Verifique o formato exato `Authorization: Bearer <token>`, e descarte um proxy ou preflight de CORS comendo-o.
6. **Cunhe um token `dotnet user-jwts` e tente de novo.** Se ele autentica, as claims ou a chave do seu token real são o problema; vá para o [guia de parâmetros de validação](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Se ele também retorna 401, a configuração ainda está errada; reverifique os passos 2 a 4.
7. **Ative o log de debug de `Microsoft.AspNetCore.Authentication`** ou conecte `JwtBearerEvents` e leia qual evento dispara. Isso diz a você definitivamente se o handler rodou.

## A única distinção que encerra a busca

Todo "token válido mas 401" se reduz a uma única pergunta: o handler bearer rodou e rejeitou o token, ou ele nunca teve a chance de rodar? Parâmetros de validação, `ClockSkew`, incompatibilidades de issuer e audience todos vivem no primeiro ramo, e só importam se `OnAuthenticationFailed` dispara. A ordem do middleware, o esquema padrão, o nome do esquema e um cabeçalho ausente todos vivem no segundo ramo, onde não há falha de validação a encontrar porque não havia nada a validar. Faça o handler emitir uma linha de log e você respondeu a pergunta; a partir daí a correção é mecânica. Quando você for fechar os endpoints, agrupar as rotas protegidas com [MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) mantém o requisito de esquema em um só lugar em vez de espalhado por todo `[Authorize]`, que é justamente como a incompatibilidade de nome de esquema se infiltra para começar.

## Fontes

- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn, incluindo a distinção entre 401 e 403 e a orientação sobre o esquema padrão.
- [Authorize with a specific scheme in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/limitingidentitybyscheme), Microsoft Learn, sobre `[Authorize(AuthenticationSchemes = ...)]`.
- [RFC 9110, section 15.5.2](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), que exige o cabeçalho `WWW-Authenticate` em um 401.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
</content>
</invoke>
