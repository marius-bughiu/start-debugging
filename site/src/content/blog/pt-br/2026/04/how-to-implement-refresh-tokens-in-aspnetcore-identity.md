---
title: "Como implementar refresh tokens no ASP.NET Core Identity"
description: "Dois caminhos válidos no .NET 11: o endpoint /refresh embutido no MapIdentityApi e uma configuração customizada com JWT, rotação de refresh tokens, rastreamento por família e detecção de reuso."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "identity"
  - "authentication"
  - "jwt"
  - "dotnet-11"
template: how-to
lang: "pt-br"
translationOf: "2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity"
translatedBy: "claude"
translationDate: 2026-04-28
---

Se você está no .NET 8 ou posterior e os bearer tokens opacos embutidos servem, chame `app.MapIdentityApi<TUser>()` e faça POST em `/refresh` com o `refreshToken` da resposta de login. Você recebe um novo access token mais um novo refresh token, o refresh token antigo é invalidado e o security stamp é revalidado contra o user store. Se você precisa de JWT de verdade, lifetimes configuráveis, revogação multi-dispositivo ou detecção de reuso, os endpoints embutidos não chegam lá. É preciso fazer na mão: JWT de vida curta + uma linha de refresh token no servidor, com hash em repouso, rotacionada a cada troca, com um identificador de família para que um replay revogue toda a cadeia de sessão.

Este post cobre ambos os caminhos, quando cada um é correto e os detalhes que costumam morder em produção. Versões referenciadas: .NET 11 GA, ASP.NET Core 11, EF Core 11, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0 e `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.

## O que o ASP.NET Core Identity realmente entrega em 2026

A coisa mais importante para internalizar: **o ASP.NET Core Identity clássico (a UI baseada em cookies) nunca teve refresh tokens**. Ele usa um cookie de sessão. Refresh tokens só entram em cena quando você autentica via bearer token, e o Identity ganhou suporte de bearer de primeira classe no .NET 8 via `AddIdentityApiEndpoints` e `MapIdentityApi`. Essa história mudou pouco no .NET 11: a superfície da API está estável, com pequenas correções de bugs e uma revalidação do security stamp mais rigorosa.

Os Identity API endpoints registram um esquema bearer customizado (`IdentityConstants.BearerScheme`) suportado pelo `BearerTokenHandler`. O "access token" que ele retorna **não** é um JWT. É um `AuthenticationTicket` serializado e protegido pelo ASP.NET Data Protection. O cliente trata como opaco. O mesmo vale para o refresh token: blob opaco protegido por Data Protection com um `ExpiresUtc` embutido.

```csharp
// Program.cs, .NET 11
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

builder.Services
    .AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();

builder.Services.AddAuthorization();

var app = builder.Build();
app.MapIdentityApi<IdentityUser>();
app.MapGet("/me", (ClaimsPrincipal u) => u.Identity!.Name).RequireAuthorization();
app.Run();
```

Essa única chamada de `MapIdentityApi<IdentityUser>()` cabeia `/register`, `/login`, `/refresh`, `/confirmEmail`, `/resendConfirmationEmail`, `/forgotPassword`, `/resetPassword`, `/manage/2fa`, `/manage/info`. O endpoint `/login` retorna:

```json
{
  "tokenType": "Bearer",
  "accessToken": "CfDJ8...redacted...",
  "expiresIn": 3600,
  "refreshToken": "CfDJ8...redacted..."
}
```

Para refrescar, faça POST `{ "refreshToken": "..." }` em `/refresh`. O handler desprotege o ticket, confere `ExpiresUtc` contra `TimeProvider.GetUtcNow()`, chama `signInManager.ValidateSecurityStampAsync` para que uma troca de senha force novo login, reconstrói o principal via `CreateUserPrincipalAsync(user)` e retorna um par fresco access + refresh via `TypedResults.SignIn`. Se algo falha, retorna `401 Unauthorized`. O código exato vive em [IdentityApiEndpointRouteBuilderExtensions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs).

## Quando o MapIdentityApi basta e quando não

O fluxo embutido funciona bem para uma SPA de primeira parte ou app móvel onde você controla a API e a camada de armazenamento, os tokens são opacos para todos exceto seu servidor e você não precisa inspecioná-los como JWT. **Não** funciona se qualquer um dos itens abaixo se aplica:

- Você precisa compartilhar um token entre vários servidores de recursos que validam por assinatura, não por chave de Data Protection.
- Você quer JWT que serviços ou gateways downstream possam introspectar.
- Você precisa revogar sessões individuais ("desloga só este iPad") sem mexer no security stamp do usuário e deslogar todos os dispositivos de uma vez.
- Você precisa de visibilidade do servidor sobre quais refresh tokens estão vivos: quem, quando, de qual IP, quando foi a última rotação.
- Você precisa de rotação de refresh tokens com detecção de reuso.

O refresh ticket de Data Protection é opaco para você. Não existe linha no seu banco. Uma vez emitido, a única forma de invalidá-lo antes do `ExpiresUtc` é alterar o security stamp do usuário via `UserManager.UpdateSecurityStampAsync`, o que desloga todos os dispositivos. Isso sozinho desqualifica o caminho embutido para a maioria de apps multi-dispositivo. O time do dotnet/aspnetcore reconheceu isso na [issue #50009](https://github.com/dotnet/aspnetcore/issues/50009) e na [#55792](https://github.com/dotnet/aspnetcore/issues/55792); extensibilidade mais granular é um pedido antigo.

## Um fluxo customizado pronto para produção com JWT e refresh tokens rotacionados

O padrão abaixo é onde a maioria dos códigos .NET 11 em produção termina. O usuário autentica com usuário + senha contra `UserManager`. No sucesso, você emite um JWT de vida curta (típico: 5 a 15 minutos) e um refresh token de vida longa (7 a 30 dias). O refresh token é armazenado no servidor em uma tabela dedicada e **só o hash SHA-256 é persistido**. No refresh, você acha a linha pelo hash, marca como consumida e emite um par novo.

### O esquema

```csharp
// .NET 11, EF Core 11
public class RefreshToken
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = default!;
    public string TokenHash { get; set; } = default!; // SHA-256 of opaque token
    public Guid FamilyId { get; set; }                // shared across one chain
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public DateTime? ConsumedUtc { get; set; }        // set when rotated
    public DateTime? RevokedUtc { get; set; }
    public Guid? ReplacedByTokenId { get; set; }
    public string? CreatedByIp { get; set; }
}
```

`FamilyId` é a ideia chave. Cada refresh token emitido a partir do mesmo login é encadeado em uma família. Quando você rotaciona a cadeia, o novo token herda o `FamilyId` do pai. Se alguém apresentar um refresh token cuja linha já tem `ConsumedUtc != null`, isso é reuso, quase sempre roubo, e a única resposta segura é revogar a família inteira (toda linha com o mesmo `FamilyId`).

Indexe agressivamente: `(UserId, ExpiresUtc)` para limpeza, e índice único em `TokenHash`. Hash, não criptografar: mesmo se seu banco vazar, o atacante não consegue apresentar o token bruto.

### Emitindo o par

```csharp
// .NET 11, C# 14
public sealed class TokenService(
    IOptions<JwtOptions> jwtOptions,
    AppDbContext db,
    TimeProvider time)
{
    public async Task<TokenPair> IssueAsync(IdentityUser user, Guid? existingFamily, string? ip, CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        var jwt = BuildJwt(user, now);
        var raw = GenerateRefreshToken();
        var family = existingFamily ?? Guid.NewGuid();

        db.RefreshTokens.Add(new RefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = Sha256(raw),
            FamilyId = family,
            CreatedUtc = now,
            ExpiresUtc = now.AddDays(jwtOptions.Value.RefreshDays),
            CreatedByIp = ip,
        });
        await db.SaveChangesAsync(ct);

        return new TokenPair(jwt, raw, jwtOptions.Value.AccessMinutes * 60);
    }

    private static string GenerateRefreshToken()
    {
        Span<byte> bytes = stackalloc byte[64]; // 512 bits, well above guidance floor
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes);
    }

    private static string Sha256(string raw)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(raw), hash);
        return Convert.ToHexString(hash);
    }

    private string BuildJwt(IdentityUser user, DateTime now)
    {
        var opts = jwtOptions.Value;
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new("name", user.UserName ?? string.Empty),
            new("stamp", user.SecurityStamp ?? string.Empty),
        };

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(opts.SigningKey));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: opts.Issuer,
            audience: opts.Audience,
            claims: claims,
            notBefore: now,
            expires: now.AddMinutes(opts.AccessMinutes),
            signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

public record TokenPair(string AccessToken, string RefreshToken, int ExpiresInSeconds);
```

`RandomNumberGenerator.Fill` em vez de `Guid.NewGuid().ToString()` não é negociável. Guids têm 122 bits de aleatoriedade, vazam dicas de ordem em algumas plataformas e nunca foram projetados para serem inadivinháveis. 64 bytes do CSPRNG do SO é o mínimo.

A claim `stamp` é uma cópia defensiva do `SecurityStamp` do usuário. Você vai conferir em cada refresh: se o stamp persistido não bate mais, o usuário trocou a senha ou foi deslogado à força, e você rejeita o refresh.

### O endpoint /refresh com detecção de reuso

```csharp
// .NET 11, ASP.NET Core 11
app.MapPost("/auth/refresh", async (
    RefreshRequest request,
    AppDbContext db,
    UserManager<IdentityUser> users,
    TokenService tokens,
    TimeProvider time,
    HttpContext http,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.RefreshToken))
        return Results.Unauthorized();

    var hash = Sha256(request.RefreshToken);
    var existing = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
    if (existing is null)
        return Results.Unauthorized();

    var now = time.GetUtcNow().UtcDateTime;

    // Reuse detection: a consumed token presented again means theft.
    if (existing.ConsumedUtc is not null || existing.RevokedUtc is not null)
    {
        await db.RefreshTokens
            .Where(t => t.FamilyId == existing.FamilyId && t.RevokedUtc == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedUtc, now), ct);
        return Results.Unauthorized();
    }

    if (existing.ExpiresUtc <= now)
        return Results.Unauthorized();

    var user = await users.FindByIdAsync(existing.UserId);
    if (user is null) return Results.Unauthorized();

    var pair = await tokens.IssueAsync(user, existing.FamilyId, http.Connection.RemoteIpAddress?.ToString(), ct);

    existing.ConsumedUtc = now;
    existing.ReplacedByTokenId = await db.RefreshTokens
        .Where(t => t.UserId == user.Id && t.CreatedUtc == now)
        .Select(t => (Guid?)t.Id).FirstAsync(ct);
    await db.SaveChangesAsync(ct);

    return Results.Ok(pair);
});

public record RefreshRequest(string RefreshToken);
```

Repasse os casos de falha. Token não está no banco: 401, sem dica para o caller do porquê. Token já consumido: 401 mais revogação de família, porque ou o original foi roubado ou o cliente legítimo retentou e perdeu a resposta. De qualquer forma, force o usuário a re-autenticar. Token expirado: 401, sem precisar revogar. Usuário inexistente: 401.

O `ExecuteUpdateAsync` na família é um único UPDATE de SQL no EF Core 11: não carrega as linhas para a memória nem roda change tracking. Isso importa porque, em uma corrida disputada, você quer que a revogação seja barata e atômica.

### Validação do JWT no lado da API

```csharp
// .NET 11
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>()!;
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = jwt.Issuer,
            ValidAudience = jwt.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SigningKey)),
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

O `ClockSkew` padrão é de cinco minutos, o que significa que um access token "de cinco minutos" na prática vive dez. Trave em trinta segundos a menos que tenha um bom motivo. O padrão de bater no seu endpoint de refresh com um access token aparentemente válido por causa do skew é uma fonte real de janelas de replay sutis.

## Onde guardar o refresh token no cliente

Três opções, em ordem decrescente de quanto eu confio.

**Cookie HttpOnly, Secure, SameSite=Strict definido pelo servidor.** Melhor padrão para SPA em navegador. JavaScript não pode ler, então XSS não consegue exfiltrar. CSRF só importa no endpoint de refresh, e você mitiga com `SameSite=Strict` mais um header anti-forgery explícito. Retorne o access token no corpo JSON para a SPA manter em memória; nunca persista.

**Armazenamento seguro nativo no mobile.** iOS Keychain, Android Keystore, acessados via `SecureStorage` do MAUI. O SO guarda o segredo atrás do desbloqueio do dispositivo.

**LocalStorage / sessionStorage.** Fácil e errado. Qualquer XSS leva os dois tokens.

Retornar o refresh token no corpo JSON, como o `MapIdentityApi` faz, é uma decisão defensável quando o cliente é um app nativo ou sua SPA é endurecida com uma CSP estrita. É a decisão errada se você tem qualquer script de terceiros na página.

## Detalhes que mordem

**Condições de corrida na rotação.** Uma rede móvel instável costuma retentar a chamada de refresh. Sem idempotência, a segunda chamada cai num token já consumido e você revoga a família. Dois remédios funcionam na prática: uma janela de tolerância curta (aceite um token com `ConsumedUtc` se `ConsumedUtc + 30s > now` e a mesma fingerprint do cliente o estiver apresentando), ou tornar a resposta do refresh cacheable do lado cliente por alguns segundos com chave do token da requisição. A maioria dos times escolhe a janela de tolerância.

**Tempestades de refresh em segundo plano.** Uma SPA com várias abas abertas percebe ao mesmo tempo que o access token está prestes a expirar e todas batem em `/refresh` com o mesmo refresh token. Mesma corrida, mesmo remédio. Uma eleição de líder baseada em `BroadcastChannel` no navegador é a resposta mais limpa quando você controla a SPA.

**Esquecer da limpeza.** Um cron ou um `IHostedService` deve rodar à noite: `db.RefreshTokens.Where(t => t.ExpiresUtc < cutoff || t.ConsumedUtc < cutoff).ExecuteDeleteAsync()`. Sem isso, a tabela cresce linearmente com usuários ativos. O `ExecuteDeleteAsync` do EF Core 11 deixa em uma única instrução.

**Misturar os dois fluxos.** Se você chama `MapIdentityApi` e também implementa seu próprio `/auth/refresh`, agora tem dois esquemas bearer incompatíveis e o `[Authorize]` vai resolver para o que estiver como padrão. Escolha um. Se adotar o fluxo customizado, não registre `AddIdentityApiEndpoints`; use `AddIdentity` (variante sem cookies) mais `AddJwtBearer`.

**Deriva do security stamp.** Se você embute `SecurityStamp` no JWT, deve revalidar no refresh contra o valor atual no banco. Senão, um reset de senha não invalida os access tokens vivos até expirarem, o que pode ser 15 minutos de acesso não autorizado. O `MapIdentityApi` embutido faz isso por você via o bearer handler; o fluxo customizado não, a menos que você escreva.

**Aplique rate limit em `/auth/refresh`.** É um endpoint público com forma adivinhável e faz lookup de banco por chamada. O [rate limiter por endpoint](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) do ASP.NET Core 11 deixa isso em uma linha. Um token-bucket de 10 por minuto por IP é generoso e barra os ataques bobos.

## Relacionado

- [Como testar código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) cobre como testar o lado cliente de um `DelegatingHandler` ciente de tokens, que é exatamente onde a lógica de refresh vive na maioria dos consumidores.
- [Como adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) é um lugar limpo para traduzir `SecurityTokenExpiredException` em um 401 com a dica de refrescar.
- [Como mockar DbContext sem quebrar o change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) importa aqui porque a lógica de rotação é o lugar onde você mais quer um teste de integração real com EF Core.
- [Scalar no ASP.NET Core: por que seu bearer token é ignorado no .NET 10](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) é a toca onde a maioria cai na primeira vez que o fluxo novo não se comporta como o Swashbuckle.

## Fontes

- [IdentityApiEndpointRouteBuilderExtensions.cs em dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs): a implementação real de `/refresh`.
- [Use Identity to secure a Web API backend for SPAs (MS Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization).
- [dotnet/aspnetcore #50009: MapIdentityApi HTTP endpoints](https://github.com/dotnet/aspnetcore/issues/50009) e [#55792: split MapIdentityApi into multiple APIs](https://github.com/dotnet/aspnetcore/issues/55792) para os buracos de extensibilidade de longa data.
- [Andrew Lock: introducing the Identity API endpoints](https://andrewlock.net/exploring-the-dotnet-8-preview-introducing-the-identity-api-endpoints/) para o racional do design.
- [OWASP cheat sheet on JSON Web Tokens](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html) para o guia sobre armazenamento e rotação.
