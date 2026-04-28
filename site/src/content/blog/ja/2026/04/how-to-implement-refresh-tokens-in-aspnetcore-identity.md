---
title: "ASP.NET Core Identity でリフレッシュトークンを実装する方法"
description: ".NET 11 における 2 つの実用的な選択肢: MapIdentityApi に組み込まれた /refresh エンドポイントと、JWT、リフレッシュトークンのローテーション、ファミリー追跡、再利用検出を備えたカスタム実装。"
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "identity"
  - "authentication"
  - "jwt"
  - "dotnet-11"
template: how-to
lang: "ja"
translationOf: "2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity"
translatedBy: "claude"
translationDate: 2026-04-28
---

.NET 8 以降を使っており、組み込みの不透明な bearer トークンで十分なら、`app.MapIdentityApi<TUser>()` を呼び、ログインレスポンスの `refreshToken` を `/refresh` に POST します。新しいアクセストークンと新しいリフレッシュトークンが返り、古いリフレッシュトークンは無効化され、security stamp はユーザーストアに対して再検証されます。本物の JWT、設定可能な有効期間、デバイス単位の失効、再利用検出が必要なら、組み込みエンドポイントでは届きません。自前で書くことになります。短命の JWT に加えて、サーバー側に保存され、保存時にハッシュ化され、交換のたびにローテーションされ、リプレイがセッションチェーン全体を失効させるためのファミリー ID を持つリフレッシュトークン行が必要です。

この記事では両方の経路、それぞれが正しい場面、本番で噛みつきがちな細部を扱います。参照バージョンは .NET 11 GA、ASP.NET Core 11、EF Core 11、`Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0、`Microsoft.AspNetCore.Authentication.JwtBearer` 11.0 です。

## 2026 年に ASP.NET Core Identity が実際に提供するもの

最初に押さえておくべき最重要事項: **クラシックな ASP.NET Core Identity (cookie ベースの UI) はリフレッシュトークンを持ったことがありません**。セッション cookie を使います。リフレッシュトークンが登場するのは bearer トークンで認証する場合だけで、Identity が一級の bearer サポートを得たのは .NET 8 の `AddIdentityApiEndpoints` と `MapIdentityApi` からです。.NET 11 でもこの基本構図はほとんど変わりません。API 表面は安定しており、小さなバグ修正と security stamp 再検証の厳格化が入っています。

Identity API endpoints は、`BearerTokenHandler` に支えられた独自の bearer スキーム (`IdentityConstants.BearerScheme`) を登録します。返ってくる "アクセストークン" は JWT では**ありません**。ASP.NET Data Protection でシリアライズされ保護された `AuthenticationTicket` です。クライアントは不透明として扱います。リフレッシュトークンも同様で、`ExpiresUtc` を埋め込んだ data-protected な不透明 blob です。

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

この `MapIdentityApi<IdentityUser>()` 1 行で `/register`、`/login`、`/refresh`、`/confirmEmail`、`/resendConfirmationEmail`、`/forgotPassword`、`/resetPassword`、`/manage/2fa`、`/manage/info` が配線されます。`/login` エンドポイントの戻り値は次のとおりです。

```json
{
  "tokenType": "Bearer",
  "accessToken": "CfDJ8...redacted...",
  "expiresIn": 3600,
  "refreshToken": "CfDJ8...redacted..."
}
```

更新するには `{ "refreshToken": "..." }` を `/refresh` に POST します。ハンドラーはチケットを復号し、`ExpiresUtc` を `TimeProvider.GetUtcNow()` と比較し、`signInManager.ValidateSecurityStampAsync` を呼んでパスワード変更で再ログインを強制し、`CreateUserPrincipalAsync(user)` で principal を再構築し、`TypedResults.SignIn` で新しいアクセス + リフレッシュのペアを返します。何らかの失敗があれば `401 Unauthorized` を返します。実コードは [IdentityApiEndpointRouteBuilderExtensions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) にあります。

## MapIdentityApi で十分なときと不十分なとき

組み込みフローは、API とストレージ層を自分で握り、トークンが自分のサーバー以外には不透明で、JWT として中身を見る必要のない一次党 SPA やモバイルアプリには十分です。次のいずれかが当てはまる場合は**不十分**です。

- 署名で検証する複数のリソースサーバー間でトークンを共有したい (Data Protection キーではなく)。
- 下流のサービスやゲートウェイがイントロスペクトできる JWT が欲しい。
- ユーザーの security stamp に手を入れて全デバイスを一斉ログアウトさせずに、個別のセッションを失効させたい (例: "この iPad だけログアウト")。
- どのリフレッシュトークンが生きているかをサーバー側で見たい。誰が、いつ、どの IP から、最後にいつローテートされたか。
- 再利用検出付きのリフレッシュトークンローテーションが必要。

Data Protection のリフレッシュチケットはあなたから見れば不透明です。データベースに行はありません。一度発行すると、`ExpiresUtc` 前に無効化する唯一の方法は `UserManager.UpdateSecurityStampAsync` でユーザーの security stamp を更新することで、これは全デバイスからログアウトさせます。これだけで、組み込み経路はマルチデバイスアプリの大半に対して失格となります。dotnet/aspnetcore チームは [issue #50009](https://github.com/dotnet/aspnetcore/issues/50009) と [#55792](https://github.com/dotnet/aspnetcore/issues/55792) でこの点を認識しています。きめ細かい拡張性は長年の要望です。

## JWT とローテーション付きリフレッシュトークンを用いた本番向けカスタムフロー

下記のパターンは、.NET 11 の本番コードベースの大半が落ち着く形です。ユーザーは `UserManager` に対してユーザー名とパスワードで認証します。成功したら短命の JWT (5～15 分が一般的) と長命のリフレッシュトークン (7～30 日) を発行します。リフレッシュトークンは専用テーブルにサーバー側で保存し、**保存されるのは SHA-256 ハッシュのみ**です。更新時にはハッシュで行を引き、消費済みとマークし、新しいペアを発行します。

### スキーマ

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

`FamilyId` がキーアイデアです。同じログインから発行されたリフレッシュトークンは 1 つのファミリーに連結されます。チェーンをローテーションするとき、新しいトークンは親の `FamilyId` を引き継ぎます。誰かがすでに `ConsumedUtc != null` の行を持つリフレッシュトークンを提示してきたら、それは再利用、ほぼ確実に窃取であり、唯一安全な対応はファミリー全体を失効させること (同じ `FamilyId` の行をすべて) です。

積極的にインデックスを張ります。クリーンアップ用に `(UserId, ExpiresUtc)`、`TokenHash` にユニークインデックス。暗号化ではなくハッシュ化です。DB が漏洩しても攻撃者は生のトークンを提示できません。

### ペアの発行

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

`RandomNumberGenerator.Fill` を `Guid.NewGuid().ToString()` の代わりに使うのは譲れません。Guid のランダム性は 122 ビットで、プラットフォームによっては順序のヒントが漏れ、もともと予測不能であることを目指して設計されていません。OS の CSPRNG から 64 バイトが下限です。

`stamp` クレームはユーザーの `SecurityStamp` の防御的コピーです。リフレッシュのたびに照合します。永続化された stamp が一致しなくなっていれば、ユーザーがパスワードを変更したか強制ログアウトされたということで、リフレッシュを拒否します。

### 再利用検出付きの /refresh エンドポイント

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

失敗ケースを順に追います。トークンが DB にない: 401、呼び出し側に理由は知らせません。トークンが消費済み: 401 に加えてファミリー失効。オリジナルが盗まれたか、正規クライアントがリトライしてレスポンスを失ったかのどちらかです。いずれにせよ、ユーザーに再認証を強制します。トークンが期限切れ: 401、失効は不要。ユーザーがいない: 401。

ファミリーへの `ExecuteUpdateAsync` は EF Core 11 では単一の SQL UPDATE です。行をメモリにロードせず、change tracking も走りません。これが効くのは、競合した race において失効を安価かつアトミックにしたいからです。

### API 側の JWT 検証

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

`ClockSkew` の既定値は 5 分なので、"5 分のアクセストークン" は実質 10 分有効です。理由がない限り 30 秒に固定してください。skew のせいで一見有効なアクセストークンを持ってリフレッシュエンドポイントに到達するパターンは、実在する微妙なリプレイウィンドウの源です。

## クライアントでのリフレッシュトークンの保存場所

3 つの選択肢を、私が信用する順に並べます。

**サーバーが設定する HttpOnly、Secure、SameSite=Strict cookie。** ブラウザ SPA の最良のデフォルトです。JavaScript から読めないので XSS で持ち出せません。CSRF はリフレッシュエンドポイントでだけ問題で、`SameSite=Strict` と明示的な anti-forgery ヘッダーで緩和します。アクセストークンは JSON ボディで返し、SPA がメモリで保持します。永続化はしません。

**モバイルのネイティブセキュアストレージ。** iOS Keychain、Android Keystore、MAUI の `SecureStorage` 経由でアクセスします。OS が端末ロック越しに秘密を守ります。

**LocalStorage / sessionStorage。** 簡単で、間違いです。XSS で両方のトークンを持ち出されます。

`MapIdentityApi` のようにリフレッシュトークンを JSON ボディで返すのは、クライアントがネイティブアプリ、もしくは厳格な CSP で固めた SPA であれば擁護できる選択です。サードパーティのスクリプトが少しでもページにあるなら、誤った選択です。

## 噛みつく細部

**ローテーションのレース。** 不安定なモバイル回線はリフレッシュ呼び出しをよくリトライします。冪等性がないと、2 回目の呼び出しが消費済みトークンに当たりファミリーを失効させてしまいます。実用的に効く対策は 2 つ。短い猶予ウィンドウ (`ConsumedUtc + 30s > now` で同じクライアントフィンガープリントが提示している場合は `ConsumedUtc` のあるトークンも受け入れる) か、リフレッシュ応答をリクエストトークンをキーにクライアント側で数秒キャッシュ可能にすること。多くのチームは猶予ウィンドウを採ります。

**バックグラウンドのリフレッシュストーム。** タブを複数開いた SPA が、アクセストークンが切れそうなことに同時に気づき、全タブが同じリフレッシュトークンで `/refresh` を叩きます。同じレース、同じ対策です。SPA を握っているなら `BroadcastChannel` ベースのリーダーエレクションが最もきれいな答えです。

**クリーンアップを忘れる。** cron か `IHostedService` が夜間に `db.RefreshTokens.Where(t => t.ExpiresUtc < cutoff || t.ConsumedUtc < cutoff).ExecuteDeleteAsync()` を走らせるべきです。これがないとテーブルはアクティブユーザー数に比例して伸び続けます。EF Core 11 の `ExecuteDeleteAsync` で 1 ステートメントで済みます。

**2 つのフローを混ぜる。** `MapIdentityApi` を呼んだうえで自分の `/auth/refresh` も実装すると、互換性のない 2 つの bearer スキームが走り、`[Authorize]` は既定のスキームに解決されます。どちらかに決めてください。カスタムフローを選ぶなら `AddIdentityApiEndpoints` は登録せず、`AddIdentity` (cookie なしの版) と `AddJwtBearer` を使います。

**Security stamp のドリフト。** `SecurityStamp` を JWT に埋めるなら、リフレッシュ時に DB の現在値と再照合する必要があります。さもないと、パスワードリセットでは生きているアクセストークンが期限まで失効されず、最悪 15 分間の不正アクセスになります。組み込みの `MapIdentityApi` は bearer ハンドラー経由でこれをやってくれますが、カスタムフローでは自分で書かない限りやってくれません。

**`/auth/refresh` にレートリミットを。** 推測しやすい形をした公開エンドポイントで、呼ぶたびに DB を引きます。ASP.NET Core 11 の[エンドポイント単位レートリミッター](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)なら 1 行で済みます。IP あたり 1 分 10 回のトークンバケットは寛大で、雑な攻撃を止めるには十分です。

## 関連

- [HttpClient を使うコードのユニットテスト方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) は、トークンを意識する `DelegatingHandler` のクライアント側のテストを扱います。多くのコンシューマーではここがリフレッシュロジックの居場所です。
- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は、`SecurityTokenExpiredException` をリフレッシュを促す 401 に翻訳するきれいな場所です。
- [DbContext を change tracking を壊さずにモックする方法](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) は、ローテーションロジックこそ実 EF Core の統合テストが最も欲しい場所なので関係します。
- [ASP.NET Core での Scalar: .NET 10 で bearer token が無視される理由](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) は、新フローが Swashbuckle のように振る舞わない最初の場面で多くの人が落ちる落とし穴です。

## ソース

- [IdentityApiEndpointRouteBuilderExtensions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) `/refresh` の実コード。
- [Use Identity to secure a Web API backend for SPAs (MS Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization)。
- [dotnet/aspnetcore #50009: MapIdentityApi HTTP endpoints](https://github.com/dotnet/aspnetcore/issues/50009) と [#55792: split MapIdentityApi into multiple APIs](https://github.com/dotnet/aspnetcore/issues/55792)。長年の拡張性ギャップ。
- [Andrew Lock: introducing the Identity API endpoints](https://andrewlock.net/exploring-the-dotnet-8-preview-introducing-the-identity-api-endpoints/)。設計意図。
- [OWASP cheat sheet on JSON Web Tokens](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)。保存とローテーションのガイダンス。
