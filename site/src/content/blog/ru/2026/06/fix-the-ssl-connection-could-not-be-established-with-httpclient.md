---
title: "Исправление: The SSL connection could not be established с HttpClient"
description: "Внутреннее AuthenticationException называет настоящую причину: недоверенная цепочка, несовпадение имени или разрыв в версии TLS. Доверьте сертификат, исправьте хост или согласуйте протоколы. Не отключайте проверку целиком."
pubDate: 2026-06-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "httpclient"
lang: "ru"
translationOf: "2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient"
translatedBy: "claude"
translationDate: 2026-06-13
---

`HttpRequestException: The SSL connection could not be established, see inner exception` почти никогда не означает то, о чём говорит внешнее сообщение. Рукопожатие TLS не удалось, и настоящая причина находится во `InnerException`: недоверенная цепочка сертификатов (`RemoteCertificateChainErrors`), хост, не совпадающий с сертификатом (`RemoteCertificateNameMismatch`), или несоответствие протоколов. Сначала прочитайте внутреннее исключение, затем исправьте цепочку, хост или версию TLS. Не прибегайте к `ServerCertificateCustomValidationCallback => true` в продакшене: это отключает защиту, ради которой рукопожатие и существует.

Это относится к `HttpClient` в .NET 11 (`.NET 11`), но тот же механизм `SslStream` и та же диагностика восходят к .NET Core 3.1.

## Ошибка в контексте

Внешнее исключение является общим. Важна именно внутренняя строка:

```
System.Net.Http.HttpRequestException: The SSL connection could not be established, see inner exception.
 ---> System.Security.Authentication.AuthenticationException: The remote certificate is invalid according to the validation procedure: RemoteCertificateChainErrors, RemoteCertificateNameMismatch
   at System.Net.Security.SslStream.SendAuthResetSignal(...)
   at System.Net.Http.ConnectHelper.EstablishSslConnectionAsync(...)
   at System.Net.Http.HttpConnectionPool.ConnectAsync(...)
```

В .NET 8 и более поздних версиях вам даже не нужно вскрывать внутреннее исключение вручную. `HttpRequestException` несёт enum `HttpRequestError`, и сбой рукопожатия проявляется как `HttpRequestError.SecureConnectionError`:

```csharp
// .NET 11, C# 14
try
{
    using var response = await client.GetAsync("https://api.example.com");
}
catch (HttpRequestException ex) when (ex.HttpRequestError == HttpRequestError.SecureConnectionError)
{
    // TLS handshake failed. Inspect ex.InnerException for the AuthenticationException.
    Console.WriteLine(ex.InnerException?.Message);
}
```

Строка после "according to the validation procedure:" и есть вся диагностика. Это разделённый запятыми список флагов `SslPolicyErrors`, и каждый указывает на отдельное исправление.

## Почему это происходит

Рукопожатие не удаётся по одной из трёх причин, и внутреннее сообщение называет, по какой именно:

- **`RemoteCertificateChainErrors`**: сертификат сервера настоящий, но ваша машина не доверяет цепочке, которая его подписала. Самоподписанные сертификаты, внутренний корпоративный CA, которого нет в хранилище доверия, просроченный конечный или промежуточный сертификат, или сервер, забывший отправить свой промежуточный сертификат, -- все попадают сюда.
- **`RemoteCertificateNameMismatch`**: сертификат доверенный, но имя на нём не совпадает с хостом, к которому вы подключились. Вы обратились к `https://10.0.0.5`, но сертификат выпущен для `api.internal`, или вы зашли на `https://localhost` против сертификата для `127.0.0.1`.
- **`RemoteCertificateNotAvailable`**: сервер вообще не предъявил сертификат, что обычно означает, что вы говорите по TLS с портом, который на самом деле не обслуживает TLS.

Четвёртый класс вообще не порождает `SslPolicyErrors`. Если внутреннее исключение -- это `Win32Exception` ("The client and server cannot communicate, because they do not possess a common algorithm") или сухое "The SSL connection could not be established" без списка политик, две стороны не смогли договориться о версии TLS или наборе шифров. Начиная с .NET 5 значением клиента по умолчанию является `SslProtocols.None`, что означает "пусть операционная система выберет лучшее из доступного", и на современной ОС это согласует TLS 1.3 или TLS 1.2. Сервер, застрявший на TLS 1.0/1.1, или такой, единственные наборы шифров которого ваша ОС отключила, попадает в эту группу.

## Минимальное воспроизведение

Самая маленькая программа, воспроизводящая ошибку цепочки, направляет `HttpClient` на хост с самоподписанным или иным недоверенным сертификатом:

```csharp
// .NET 11, C# 14
using var client = new HttpClient();

// A host whose cert chains to a CA this machine does not trust.
using var response = await client.GetAsync("https://self-signed.badssl.com/");
response.EnsureSuccessStatusCode();
```

Запустите её, и вы получите форму `RemoteCertificateChainErrors`. Замените URL на `https://wrong.host.badssl.com/`, и вы вместо этого получите `RemoteCertificateNameMismatch`. Эти две публичные конечные точки -- самый быстрый способ убедиться, что ваш код обработки ветвится правильно, без поднятия собственного сломанного сервера.

## Исправление в деталях

Выберите исправление, которое соответствует внутреннему исключению. Они упорядочены от "корректного в продакшене" до "только для разработки".

### 1. Ошибки цепочки: доверьте сертификат, не обходите проверку

Если внутреннее сообщение -- `RemoteCertificateChainErrors`, правильное исправление в том, чтобы сделать цепочку доверенной, а не перестать её проверять.

Для внутреннего корпоративного CA установите корневой сертификат CA в хранилище доверия машины. В Linux это означает поместить PEM в пакет доверия ОС, потому что .NET в Linux читает хранилище доверия OpenSSL, а не специфичное для .NET:

```bash
# Ubuntu/Debian: install a corporate root CA so .NET trusts it
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

В Windows импортируйте корневой сертификат в `Cert:\LocalMachine\Root`. После этого `HttpClient` проверяет цепочку без изменений кода, потому что проверка читает хранилище ОС.

Если вы не можете трогать хранилище машины (заблокированные хосты, эфемерные контейнеры), закрепите конкретный сертификат, который вы ожидаете, вместо того чтобы доверять всему. Это сохраняет проверку включённой для любого другого сервера, принимая ровно один известный сертификат:

```csharp
// .NET 11, C# 14
// Pin the expected leaf/intermediate by thumbprint. Real validation stays on
// for chains we did not explicitly pin.
var expectedThumbprint = "A1B2C3...";

var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (sender, cert, chain, errors) =>
        {
            if (errors == SslPolicyErrors.None) return true;
            return cert is not null
                && cert.GetCertHashString().Equals(expectedThumbprint, StringComparison.OrdinalIgnoreCase);
        }
    }
};

using var client = new HttpClient(handler);
```

Обратите внимание на форму: коллбэк возвращает `true` для цепочек, которые уже проходят (`SslPolicyErrors.None`), а в остальном принимает только тот единственный сертификат, который вы закрепили. В этом и заключается разница между закреплением сертификата (pinning) и отключением проверки.

### 2. Несовпадение имени: исправьте URL или сертификат

`RemoteCertificateNameMismatch` означает, что вы подключились к имени, для которого сертификат не выпускался. Исправление почти всегда в том, чтобы использовать правильный хост в URL, тот, что присутствует в списке Subject Alternative Name сертификата. Подключение по IP-адресу -- классический триггер, потому что сертификаты выпускаются для DNS-имён, а не IP.

Если URL правильный, а сертификат просто неверный (настоящая неправильная конфигурация на сервере, который вы контролируете), перевыпустите сертификат с правильными записями SAN. Если вам действительно нужно подключаться по адресу, отличающемуся от имени сертификата, задайте SNI-хост TLS явно, чтобы согласованное имя совпадало с сертификатом, вместо отключения проверки имени:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        // Present this name in the TLS handshake even though the URL uses an IP.
        TargetHost = "api.internal"
    }
};
using var client = new HttpClient(handler);
```

### 3. Разрыв протокола или шифра: согласуйте версии TLS

Если списка ошибок политики нет и рукопожатие просто не удаётся, две стороны не смогли договориться о протоколе. Оставьте клиент на `SslProtocols.None` (значение по умолчанию, согласуемое ОС) и исправьте сервер, чтобы он предлагал TLS 1.2 или 1.3. Принудительное понижение клиента до TLS 1.0/1.1 ради совместимости с устаревшим сервером -- крайняя мера, и на современной ОС эти протоколы часто отключены на уровне ОС в любом случае, так что явная настройка тихо ничего не делает. Если без неё никак, это выглядит так:

```csharp
// .NET 11, C# 14 - last resort for a legacy server you cannot upgrade
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12
    }
};
```

### 4. Локальный HTTPS: доверьте сертификату разработки ASP.NET Core

Если вы столкнулись с этим, обращаясь к собственному сервису по `https://localhost` во время разработки, исправление в том, чтобы один раз доверить локальный сертификат разработки:

```bash
dotnet dev-certs https --trust
```

Это правильное локальное исправление. Оно не ослабляет проверку, потому что устанавливает настоящий доверенный сертификат для `localhost`, а не велит клиенту пропустить проверку.

## Подводные камни и варианты

**`ServerCertificateCustomValidationCallback => true` -- не исправление.** Это самый популярный ответ на StackOverflow, и он неверен вне одноразового теста. Безусловный возврат `true` принимает любой сертификат от кого угодно, что превращает HTTPS в открытый текст с лишними шагами и снова открывает ровно ту дыру для атаки «человек посередине», которую TLS предотвращает. Если вы используете это, чтобы разблокировать демо, ограничьте его так, чтобы оно никогда не попало в продакшен: оградите его через `if (env.IsDevelopment())` и убедитесь, что в продакшене оно выключено. Коллбэк закрепления из исправления 1 -- это то, что вам нужно, когда вам действительно нужно принять конкретный непубличный сертификат.

**Работает в Postman или curl, но падает в .NET.** Эти инструменты и .NET читают разные хранилища доверия. curl в Linux использует пакет OpenSSL (который .NET тоже читает), но Postman поставляется с собственным списком CA, а инструменты Windows читают хранилище Windows. CA, доверенный одному, не доверен автоматически другим. Установите корневой сертификат в хранилище, которое .NET действительно читает для вашей ОС.

**Работает в Windows, падает в контейнере Linux.** Та же первопричина. Корпоративный корневой CA находится в хранилище доверия Windows у разработчика, но никогда не добавлялся в образ контейнера. Добавьте CA в ваш Dockerfile через `update-ca-certificates` до запуска приложения или примонтируйте его.

**Сервер забыл свой промежуточный сертификат.** Сервер может быть настроен с действительным конечным сертификатом, но не отправлять промежуточный, который связывает его с доверенным корнем. Браузеры часто скрывают это, кэшируя промежуточные сертификаты из предыдущих сессий; .NET -- нет. Исправление принадлежит серверу: настройте его на отправку полной цепочки. Вы можете подтвердить это через `openssl s_client -connect host:443 -showcerts`, посчитав возвращённые сертификаты.

**`AuthenticationException` с `RemoteCertificateNotAvailable`.** Сервер не отправил никакого сертификата. Вы почти наверняка указываете на порт с обычным HTTP со схемой `https://` или на сервис, который ещё не поднят. Проверьте порт и схему, прежде чем трогать любой код TLS.

**Не путайте это с `TaskCanceledException`.** Рукопожатие, которое зависает, а затем срабатывает по `HttpClient.Timeout`, проявляется как отмена, а не как ошибка TLS. Если ваш симптом -- таймаут, а не сообщение о проверке, причина и исправление другие.

## Связанные материалы

- [Исправление: TaskCanceledException: A task was canceled в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) разбирает сбои в форме таймаута, которые поверхностно похожи на медленное рукопожатие, но имеют совершенно другую первопричину.
- [HttpClient vs HttpClientFactory vs Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/) объясняет, где настраивать пользовательский `SocketsHttpHandler`, чтобы ваши настройки TLS пережили переиспользование клиента.
- [Как писать модульные тесты для кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) показывает, как подменить транспорт, чтобы вы могли отрабатывать ветки ошибок выше без живого сломанного сервера.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) помогает вам показать это исключение с сохранённым внутренним сообщением вместо голого 500.

## Источники

- [Enum `SslPolicyErrors`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslpolicyerrors), Microsoft Learn: флаги (`RemoteCertificateChainErrors`, `RemoteCertificateNameMismatch`, `RemoteCertificateNotAvailable`), которые появляются во внутреннем сообщении.
- [Enum `HttpRequestError`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn: значение `SecureConnectionError`, используемое для классификации сбоя в .NET 8+.
- [`SslClientAuthenticationOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslclientauthenticationoptions), Microsoft Learn: `TargetHost`, `EnabledSslProtocols` и `RemoteCertificateValidationCallback` на `SocketsHttpHandler`.
- [Enforce TLS in .NET](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls), Microsoft Learn: почему `SslProtocols.None` (согласуемый ОС) является рекомендуемым значением по умолчанию.
- [dotnet/runtime #32498: The SSL connection could not be established](https://github.com/dotnet/runtime/issues/32498): сообщения из реальной практики и диагностика хранилища доверия.
