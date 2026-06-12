---
title: "Решение: The antiforgery token could not be decrypted в ASP.NET Core"
description: "Ошибка означает, что Data Protection потерял ключ, которым был подписан токен. Сохраняйте ключи в общем долговечном хранилище и вызывайте SetApplicationName, чтобы каждый экземпляр читал одно и то же кольцо ключей."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
lang: "ru"
translationOf: "2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-12
---

The antiforgery token could not be decrypted, потому что ключ Data Protection, которым он был подписан, больше не находится в кольце ключей, которое читает ваше приложение. По умолчанию ASP.NET Core записывает эти ключи в папку, привязанную к машине и пользователю, которая не переживает перезапуск контейнера и не разделяется между экземплярами. Сохраняйте ключи в долговечном хранилище, которое может читать каждый экземпляр (файловая шара, база данных, Azure Blob, Redis), и фиксируйте `SetApplicationName` на одно и то же значение везде. Это полное решение. Остальная часть статьи объясняет, почему это происходит, и приводит точный код для каждого хранилища.

Это относится к ASP.NET Core 11 (`.NET 11`), но тот же стек Data Protection и то же решение восходят к ASP.NET Core 2.x.

## Ошибка в контексте

Вы увидите одну из этих, обычно при POST сразу после развёртывания, горизонтального масштабирования или перезапуска контейнера:

```
Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException: The antiforgery token could not be decrypted.
 ---> System.Security.Cryptography.CryptographicException: The key {0cf0e637-...} was not found in the key ring.
   at Microsoft.AspNetCore.DataProtection.KeyManagement.KeyRingBasedDataProtector.UnprotectCore(...)
   at Microsoft.AspNetCore.Antiforgery.DefaultAntiforgeryTokenSerializer.Deserialize(String serializedToken)
```

Внутреннее исключение - это ключевая подсказка. `The key {guid} was not found in the key ring` означает, что токен ссылается на ключ, который этот экземпляр никогда не видел. Другое внутреннее сообщение, `The payload was invalid`, указывает на ключ, который существует, но не может расшифровать именно этот токен, что обычно означает, что два приложения разделяют кольцо ключей без совпадающего имени приложения (подробнее об этом ниже).

В Blazor и Razor Pages та же первопричина проявляется как HTTP 400 с `Bad Request - antiforgery token validation failed`, а в MVC - как цикл перенаправлений при входе, потому что cookie antiforgery никогда не может быть проверен.

## Почему это происходит

Токены antiforgery шифруются и подписываются с помощью ASP.NET Core Data Protection. Проверка работает только если экземпляр, читающий токен, всё ещё хранит ключ, который его записал. Есть четыре способа потерять этот ключ:

- **Ключи эфемерны.** Без явной настройки Data Protection сохраняет ключи в `%LOCALAPPDATA%\ASP.NET\DataProtection-Keys` (Windows) или `$HOME/.aspnet/DataProtection-Keys` (Linux). В контейнере этот путь находится в записываемом слое и стирается при каждом перезапуске, поэтому каждый новый контейнер генерирует свежее кольцо ключей и отклоняет все токены, выданные предыдущим.
- **Вы масштабировались горизонтально.** Два или более экземпляров за балансировщиком нагрузки каждый генерируют собственное кольцо ключей. Токен, выданный экземпляром A, попадает на экземпляр B, чьё кольцо не содержит ключ A. Это самая частая причина в продакшене.
- **Изменилась учётная запись.** При работе под IIS переработка пула приложений или смена учётной записи перемещает папку ключей, потому что путь по умолчанию привязан к пользователю. Слоты развёртывания Azure App Service имеют тот же эффект: слот staging и слот production не разделяют ключи, если вы это не укажете.
- **Два приложения, одно кольцо, нет имени приложения.** Когда несколько приложений указывают на одно хранилище, но не задают совпадающий `SetApplicationName`, их токены конфликтуют. Data Protection изолирует по дискриминатору приложения, поэтому несовпадение даёт `The payload was invalid`.

Срок жизни ключей по умолчанию - 90 дней, поэтому легитимная ротация ключей почти никогда этого не вызывает. Если вы это видите, ключ отсутствует, а не истёк.

## Минимальное воспроизведение

Это наименьшее приложение, которое воспроизводит ошибку при перезапуске. Запустите его, отправьте форму, затем перезапустите процесс перед повторной отправкой.

```csharp
// .NET 11, ASP.NET Core 11
// No Data Protection configuration: keys are ephemeral.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();

app.MapGet("/", (HttpContext ctx, IAntiforgery af) =>
{
    var tokens = af.GetAndStoreTokens(ctx);
    return Results.Content($"""
        <form action="/submit" method="post">
          <input name="{tokens.FormFieldName}" type="hidden" value="{tokens.RequestToken}" />
          <button type="submit">Submit</button>
        </form>
        """, "text/html");
});

app.MapPost("/submit", () => "OK").RequireAntiforgery();

app.Run();
```

Загрузите `/`, скопируйте отрендеренную форму, перезапустите приложение, затем отправьте POST старой формы. Поскольку кольцо ключей в памяти было пересоздано при перезапуске, токен больше не расшифровывается, и вы получаете `AntiforgeryValidationException`. В одном долгоживущем процессе вы этого не увидите, что и есть причина, почему это проскальзывает через локальное тестирование и проявляется только в контейнерах и фермах.

## Решение, подробно

Выберите хранилище, соответствующее тому, где вы выполняете приложение. Во всех случаях правило одно: место, которое могут читать и записывать все экземпляры, плюс стабильное имя приложения.

### 1. Файловая шара (UNC или смонтированный том): проще всего для виртуальных машин и физического железа

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(@"\\fileserver\dpkeys\myapp"))
    .SetApplicationName("MyApp");
```

В Kubernetes смонтируйте общий `PersistentVolume` (ReadWriteMany) и направьте `PersistKeysToFileSystem` на путь монтирования. Тогда ключи переживут любой отдельный pod. Это решение с наименьшим трением, когда у вас уже есть общее хранилище.

### 2. База данных через EF Core: без дополнительной инфраструктуры, если у вас уже есть БД

Добавьте пакет [`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`](https://www.nuget.org/packages/Microsoft.AspNetCore.DataProtection.EntityFrameworkCore/) и контекст, реализующий `IDataProtectionKeyContext`:

```csharp
// .NET 11, EF Core 11
public class KeysDbContext : DbContext, IDataProtectionKeyContext
{
    public KeysDbContext(DbContextOptions<KeysDbContext> options) : base(options) { }
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
}
```

```csharp
// Program.cs
builder.Services.AddDbContext<KeysDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Keys")));

builder.Services.AddDataProtection()
    .PersistKeysToDbContext<KeysDbContext>()
    .SetApplicationName("MyApp");
```

Один раз выполните миграцию, создающую таблицу `DataProtectionKeys`, и каждый экземпляр будет читать одно и то же кольцо. Это вариант, к которому я прибегаю чаще всего, потому что ему не нужно ничего, чего у приложения ещё нет.

### 3. Azure Blob Storage: чистый выбор для App Service и Azure Container Apps

Добавьте [`Azure.Extensions.AspNetCore.DataProtection.Blobs`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Blobs). Используйте управляемую идентичность вместо строки подключения:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToAzureBlobStorage(
        new Uri("https://mystorage.blob.core.windows.net/dpkeys/keys.xml"),
        new DefaultAzureCredential())
    .SetApplicationName("MyApp");
```

Это также устраняет вариант со слотами развёртывания: когда staging и production указывают на один и тот же blob, переключение слотов больше не делает недействительными активные сессии. Для эшелонированной защиты оберните это в `ProtectKeysWithAzureKeyVault` (пакет [`Azure.Extensions.AspNetCore.DataProtection.Keys`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Keys)), чтобы само кольцо ключей было зашифровано в покое.

### 4. Redis: наименьшая задержка для больших ферм

Добавьте `Microsoft.AspNetCore.DataProtection.StackExchangeRedis` и переиспользуйте мультиплексор, который вы уже используете для кеширования:

```csharp
// .NET 11, ASP.NET Core 11
var redis = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!);
builder.Services.AddDataProtection()
    .PersistKeysToStackExchangeRedis(redis, "DataProtection-Keys")
    .SetApplicationName("MyApp");
```

Какое бы хранилище вы ни выбрали, `SetApplicationName` не является необязательным в сценарии с несколькими приложениями или слотами. Он задаёт дискриминатор приложения, который Data Protection подмешивает в вывод ключа, и значение должно быть побайтово идентичным на каждом экземпляре и слоте, которые должны доверять токенам друг друга.

## Тонкости и варианты

**`The payload was invalid` вместо `key not found`.** Ключ существует, но дискриминатор приложения отличается. Два приложения разделяют хранилище, и у одного отсутствует `SetApplicationName` или задано другое значение. Установите одинаковое имя в обоих. Это также причина, почему копирование опубликованного приложения в новый путь корня контента может сломать токены: ASP.NET Core по умолчанию выводит имя приложения из пути корня контента, когда вы не задаёте его явно, поэтому сам путь становится дискриминатором.

**Зашифрованные в покое ключи, которые другие экземпляры не могут прочитать.** В Windows Data Protection по умолчанию шифрует кольцо ключей с помощью DPAPI, привязанного к текущему пользователю или машине. Ключ, записанный под одной учётной записью, не читается под другой, что даёт тот же симптом, хотя ключи физически присутствуют. Когда вы разделяете ключи между машинами, либо отключите шифрование, привязанное к машине, либо используйте явный переносимый защитник, такой как `ProtectKeysWithCertificate`.

**Работает локально, падает в контейнере.** Ожидаемо. Один процесс на вашей машине разработки держит эфемерное кольцо в памяти всю сессию, поэтому токен всегда расшифровывается. Баг проявляется только когда в игру вступает второй экземпляр или перезапуск. Воспроизведите его, запустив два экземпляра локально на разных портах без чего-либо впереди, или перезапуская между запросами, как в воспроизведении выше.

**Не "чините" это отключением antiforgery.** Удаление `[ValidateAntiForgeryToken]` или `.RequireAntiforgery()` заставляет ошибку исчезнуть и снова открывает дыру CSRF. Токен делает свою работу. Вместо этого сохраняйте ключи.

**`DisableAutomaticKeyGeneration` на репликах только для чтения.** Если вы запускаете worker, который должен потреблять ключи, но никогда их не создавать, вызовите `DisableAutomaticKeyGeneration()`, чтобы он не создавал конкурирующий ключ в общем кольце. Оставьте это выключенным на экземпляре, который владеет ротацией.

## Связанное чтение

- [.NET 10.0.7 выходит вне очереди для устранения CVE-2026-40372 в ASP.NET Core Data Protection](/ru/2026/04/dotnet-10-0-7-oob-cve-2026-40372-dataprotection/) описывает изъян проверки HMAC в том же стеке и почему вам нужно пропатченное кольцо ключей.
- [Как реализовать refresh-токены в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) опирается на Data Protection для того же конвейера шифрования.
- [Формы Blazor со статическим SSR получают клиентскую валидацию в .NET 11 Preview 5](/ru/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) - это место, где токены antiforgery появляются в статически отрендеренных формах Blazor.
- [Как сохранить состояние через границу статического-к-интерактивному рендеринга Blazor в .NET 11](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) разбирает связанный класс багов "состояние потеряно через границу".
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) помогает вам выводить это исключение аккуратно, а не как голый 400.

## Источники

- [Configure ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-11.0) - точные API `PersistKeysTo*`, `ProtectKeysWith*` и `SetApplicationName` и имена пакетов.
- [Key storage providers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/implementation/key-storage-providers?view=aspnetcore-11.0) - провайдеры файловой системы, Azure Blob, Redis и EF Core.
- [Data Protection key management and lifetime](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/default-settings?view=aspnetcore-11.0) - срок жизни по умолчанию 90 дней и расположения хранилища по умолчанию.
- [dotnet/aspnetcore #47185: The antiforgery token could not be decrypted](https://github.com/dotnet/aspnetcore/issues/47185) - реальные сообщения и рекомендации сопровождающих.
