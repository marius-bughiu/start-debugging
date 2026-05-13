---
title: "Исправление: System.Security.Cryptography.CryptographicException: Keyset does not exist"
description: "Закрытый ключ сертификата лежит в отдельном файле ключей Windows, который текущий процесс не может прочитать. Настройте ACL, загрузите PFX с MachineKeySet или используйте EphemeralKeySet."
pubDate: 2026-05-13
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "cryptography"
  - "x509"
  - "windows"
lang: "ru"
translationOf: "2026/05/fix-keyset-does-not-exist-when-calling-win32-api-from-dotnet"
translatedBy: "claude"
translationDate: 2026-05-13
---

Исправление: это `NTE_BAD_KEYSET` (HRESULT `0x80090016`), всплывающий из криптографического вызова Win32. Объект сертификата, который у вас на руках, содержит открытый ключ, но **файл закрытого ключа** на диске находится в отдельном месте, и идентичность текущего процесса не имеет прав на чтение этого файла, либо файл больше не существует для профиля пользователя, под которым вы работаете. Три решения покрывают почти все случаи: предоставить идентичности процесса доступ на чтение к закрытому ключу (оснастка сертификатов или `icacls` по файлу контейнера ключей), загрузить PFX с `X509KeyStorageFlags.MachineKeySet | PersistKeySet`, чтобы ключ попал в машинное хранилище, либо загрузить PFX с `EphemeralKeySet`, чтобы файл на диске вовсе не понадобился.

```text
System.Security.Cryptography.CryptographicException: Keyset does not exist
   at System.Security.Cryptography.CryptographicException.ThrowCryptographicException(Int32 hr)
   at System.Security.Cryptography.X509Certificates.CertificatePal.GetPrivateKey[T](Func`2 createCsp, Func`2 createCng)
   at System.Security.Cryptography.X509Certificates.X509Certificate2.GetRSAPrivateKey()
   at MyApp.SigningService.Sign(Byte[] payload)
```

Это руководство написано для .NET 11 preview 4 на Windows Server 2025 / Windows 11 24H2. Ошибка идентична с времён .NET Framework 1.1, потому что сообщение приходит дословно из `NTE_BAD_KEYSET` в `winerror.h`. В современном .NET изменилось **поведение хранилища ключей по умолчанию** при загрузке PFX: в .NET 9 появился `X509CertificateLoader`, конструкторы `X509Certificate2(byte[])` и `new X509Certificate2(path, password)` для PFX-содержимого были помечены как устаревшие (`SYSLIB0057`), и рекомендуемый путь загрузки сдвинулся. Новый API **не** молча сохраняет ключи на диск, как делали старые конструкторы. Если вы механически заменили один на другой, читаемая ошибка — это следствие.

Перед применением любого решения проверьте две вещи. Во-первых, `certificate.HasPrivateKey` возвращает `true` даже когда файл ключа отсутствует или недоступен. Флаг отражает, заявляют ли **метаданные сертификата** о наличии закрытого ключа, а не то, можете ли вы его реально открыть. Во-вторых, ошибка идентична при отсутствующем контейнере ключа, контейнере на другом профиле пользователя и контейнере, чья ACL запрещает доступ вашему процессу. Способ исправления зависит от того, какой из трёх случаев перед вами; разделы ниже разбирают их по порядку.

## Почему у сертификата вообще есть файл ключа

В Windows сертификат X.509 — это публичный документ. Соответствующий закрытый ключ никогда не лежит в файле сертификата; он живёт в контейнере ключей, управляемом криптопровайдером. Есть два провайдера и две области, которые нужно различать:

- **CAPI (Microsoft Cryptographic API)**: устаревший провайдер, контейнеры ключей хранятся в `%APPDATA%\Microsoft\Crypto\RSA\<SID>\` для пользовательской области и в `%ProgramData%\Microsoft\Crypto\RSA\MachineKeys\` для машинной области. Каждый контейнер — один файл с GUID-подобным именем.
- **CNG (Cryptography Next Generation)**: современный провайдер, контейнеры ключей в `%APPDATA%\Microsoft\Crypto\Keys\` и `%ProgramData%\Microsoft\Crypto\Keys\` соответственно.

При импорте PFX загрузчик записывает сертификат в **Личное** хранилище сертификатов (`Cert:\CurrentUser\My` или `Cert:\LocalMachine\My`), а материал ключа — в один из этих четырёх каталогов, в зависимости от `X509KeyStorageFlags`. Извлечение сертификата из хранилища в `X509Certificate2` достаёт только публичную часть плюс указатель на контейнер ключей. При первом вызове `GetRSAPrivateKey()`, `GetECDsaPrivateKey()` или устаревшего свойства `PrivateKey` среда выполнения открывает этот контейнер через соответствующий Win32 API. Если файл исчез, у SID нет ACE на чтение или путь разрешается в профиль, не существующий в текущем сеансе входа, вы получаете `NTE_BAD_KEYSET`.

Вывод: сертификат и ключ развязаны, и вопрос "есть ли у этого процесса закрытый ключ" на самом деле звучит как "есть ли у этой идентичности процесса доступ на чтение к файлу, на который ссылается сертификат". Каждое решение ниже отвечает на этот вопрос по-разному.

## Минимальное воспроизведение

Кратчайшая программа, воспроизводящая ошибку после перехода на загрузчик .NET 9+:

```csharp
// .NET 11 preview 4, Windows 11 24H2
using System.Security.Cryptography.X509Certificates;

var bytes = File.ReadAllBytes("signing.pfx");
var cert = X509CertificateLoader.LoadPkcs12(bytes, password: "test");

using var rsa = cert.GetRSAPrivateKey();
var signature = rsa!.SignData("hello"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
```

Запустите это из интерактивного десктопного сеанса — работает. Запустите тот же бинарник как службу Windows под `NT SERVICE\MyService` или из пула приложений IIS с `LoadUserProfile = false`, и `GetRSAPrivateKey()` выбрасывает "Keyset does not exist". PFX загрузился нормально. Объект сертификата сконструирован. Падение происходит ровно в тот момент, когда вы тянетесь за закрытым ключом.

Причина: `X509CertificateLoader.LoadPkcs12` по умолчанию использует `X509KeyStorageFlags.DefaultKeySet`, что в Windows означает **пользовательское** хранилище ключей. У служебной идентичности без загруженного профиля пользователя нет `%APPDATA%\Microsoft\Crypto\...`, куда писать, поэтому файл ключа либо создаётся во временном недоступном на следующем вызове месте, либо вообще не создаётся.

## Решение 1: дать текущей идентичности доступ на чтение к ключу

Это правильное решение, когда сертификат уже установлен в машинном хранилище и вы не контролируете код импорта (типично для серверов, управляемых эксплуатацией). Откройте `certlm.msc` (LocalMachine) или `certmgr.msc` (CurrentUser), найдите сертификат в **Личное > Сертификаты**, правый клик, **Все задачи > Управление закрытыми ключами**, добавьте идентичность процесса с правом **Чтение**.

Та же операция из PowerShell, скриптом для пула приложений IIS:

```powershell
# Windows 11 24H2 / Windows Server 2025, PowerShell 7.5
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq 'AABBCC...'
$keyFile = $cert.PrivateKey.Key.UniqueName  # CNG

$keyPath = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$keyFile"
$acl = Get-Acl $keyPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS APPPOOL\MyAppPool', 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $keyPath $acl
```

Для CAPI-сертификатов замените `Crypto\Keys` на `Crypto\RSA\MachineKeys` и читайте `cert.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName` вместо этого. Командлет `Get-PfxCertificate` здесь выглядит соблазнительно, но не возвращает живой сертификат хранилища; используйте `Get-ChildItem Cert:\...`, чтобы свойство `PrivateKey` указывало на контейнер на диске.

Для службы Windows, работающей под `NT SERVICE\<ИмяСлужбы>`, SID виртуальный, и вы даёте права через `icacls`:

```powershell
icacls $keyPath /grant "NT SERVICE\MyService:R"
```

Если не уверены, под каким SID работает ваш процесс, `whoami /user` в командной строке, запущенной от этой идентичности, выведет его. Для служб Windows в контейнерах обычные подозреваемые — `nt authority\system` и `nt authority\network service`.

## Решение 2: загружать PFX с правильными флагами хранилища ключей

Это правильное решение, когда ваше приложение владеет файлом сертификата и загружает его при старте. Перестаньте полагаться на `DefaultKeySet` и будьте явными:

```csharp
// .NET 11 preview 4, long-running service that needs the key to survive restarts
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    "signing.pfx",
    password: "test",
    keyStorageFlags: X509KeyStorageFlags.MachineKeySet
                   | X509KeyStorageFlags.PersistKeySet
                   | X509KeyStorageFlags.Exportable);
```

`MachineKeySet` пишет ключ в `%ProgramData%\Microsoft\Crypto\Keys` (CNG) под ACL, которую идентичность службы может прочитать. `PersistKeySet` оставляет файл на диске после освобождения `X509Certificate2`; без него поведение по умолчанию начиная с .NET Framework 4.7.2 — удалять ключ в момент, когда объект сертификата выходит из области видимости, что приводит к "Keyset does not exist" на **втором** вызове того же кода. `Exportable` опционален и нужен только если вы потом вызываете `ExportPkcs8PrivateKey` или записываете ключ в другое хранилище. Замечание: `PersistKeySet` и `EphemeralKeySet` взаимоисключающи; передача обоих приводит к `CryptographicException` из `X509CertificateLoader`.

Для хостируемого приложения .NET 11, где ключ нужен только в процессе и файл на диске не нужен никогда, используйте `EphemeralKeySet` и пропустите вопрос о персистентности полностью:

```csharp
// .NET 11 preview 4, ASP.NET Core minimal API loading a cert from configuration
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    path,
    password,
    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet);
```

`EphemeralKeySet` — самый надёжный выбор для контейнеров, нагрузок со scale-to-zero и любой среды, где профиль пользователя может отсутствовать или утилизироваться. Ключ живёт только внутри экземпляра `X509Certificate2`; как только вы его освобождаете, ключ исчезает. Компромисс: сертификат после этого нельзя импортировать в хранилище Windows, а в .NET Framework до 4.7.2 / .NET Core до 2.0 флаг отсутствовал. На Linux и macOS он не имеет эффекта, потому что там нет файла ключей Windows как такового.

## Решение 3: особенности идентичности пула приложений IIS и службы Windows

Пулы приложений IIS — самый частый единичный источник этой ошибки. Две настройки определяют, сработает ли поиск вашего закрытого ключа:

- **Загружать профиль пользователя**: в `applicationHost.config` или в IIS Manager, в **Расширенных настройках** пула приложений, поставьте **Загружать профиль пользователя** в `True`. Без этого у идентичности `IIS APPPOOL\MyAppPool` нет `%APPDATA%`, поэтому любой путь кода, попадающий по умолчанию в `UserKeySet` или `DefaultKeySet`, валится на втором вызове.
- **Модель процесса > Идентичность**: оставьте `ApplicationPoolIdentity` и дайте виртуальному SID `IIS APPPOOL\MyAppPool` доступ на чтение к файлу ключа (Решение 1). Не запускайте пулы приложений от `LocalSystem`, чтобы "обойти" это; это реальное повышение привилегий, а не исправление.

Для служб Windows, написанных с [шаблоном hosted-service .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) плюс `Microsoft.Extensions.Hosting.WindowsServices`, эквивалентная настройка — зарегистрировать службу с собственной виртуальной учётной записью:

```powershell
sc.exe create MyService binPath= "C:\svc\MyService.exe" obj= "NT SERVICE\MyService" start= auto
icacls "C:\ProgramData\Microsoft\Crypto\Keys\<keyfile>" /grant "NT SERVICE\MyService:R"
```

Избегайте запуска служб под `LocalSystem` по той же причине, что и пулов: вы заодно случайно даёте чтение каждому другому машинному ключу на хосте. Принцип наименьших привилегий применим к крипто-контейнерам так же, как к файловым путям.

## Решение 4: Azure App Service, Azure Functions, контейнеры

Облачные хосты сталкиваются с более острой версией этой проблемы, потому что нижележащая файловая система не ваша. Три специфичные для платформ настройки:

- **Azure App Service**: загрузите PFX/PEM в **TLS/SSL settings > Private Key Certificates**, затем установите настройку приложения `WEBSITE_LOAD_CERTIFICATES` в `*` или в thumbprint сертификата. Песочница App Service откажется загружать закрытый ключ, если эта переменная не белым списком разрешает thumbprint; без неё вы получаете "Keyset does not exist" в момент вызова `GetRSAPrivateKey()`. Настройка `WEBSITE_LOAD_USER_PROFILE = 1` — эквивалент **Загружать профиль пользователя** в IIS для App Service и нужна, если код разрешается в пользовательские ключи.
- **Azure Functions (Windows consumption / Premium)**: то же требование `WEBSITE_LOAD_CERTIFICATES`. Для isolated worker функций предпочитайте загружать сертификат из `cert:\CurrentUser\My`, а не читать PFX из `D:\home\site\wwwroot`, потому что этот PFX-путь только на чтение, и `PersistKeySet` молча провалится.
- **Linux-контейнеры (включая планы Linux App Service и AKS)**: файла ключей Windows нет, поэтому `X509KeyStorageFlags`, кроме `EphemeralKeySet`, фактически игнорируются. Ошибка в образах `dotnet publish` — не "Keyset does not exist", а `PlatformNotSupportedException`, если вы тянетесь к `CspParameters` или к сеттеру `PrivateKey = ...`. Используйте современный API `CopyWithPrivateKey` и `EphemeralKeySet`, и код становится переносимым.

Для [AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) применяется та же логика, что и для Linux-контейнеров: хранилища ключей Windows нет, загружайте PFX с `EphemeralKeySet` из Lambda-слоя или Secrets Manager, никогда из `/tmp` между вызовами, потому что песочница не гарантирует выживания `/tmp` между холодными стартами.

## Решение 5: читайте ключ современным API, а не `PrivateKey`

Свойство `X509Certificate2.PrivateKey` ещё существует в .NET 11, но устарело (`SYSLIB0028` для сеттера, `SYSLIB0058` для геттера для EC-ключей). Оно возвращает `AsymmetricAlgorithm`, который внутри вызывает CAPI, даже если сертификат был импортирован как CNG, и слой совместимости CAPI — это тот, который наиболее надёжно бросает "Keyset does not exist", когда контейнер ключей отсутствует. Современные аксессоры делают дополнительную проверку перед открытием файла и выдают более ясные исключения:

```csharp
// .NET 11 preview 4
using var rsa = cert.GetRSAPrivateKey();
using var ecdsa = cert.GetECDsaPrivateKey();
using var dsa = cert.GetDSAPrivateKey();
```

Если `HasPrivateKey` равно `true`, но `GetRSAPrivateKey()` возвращает `null`, сертификат использует не-RSA алгоритм; попробуйте `GetECDsaPrivateKey()`. Если `GetRSAPrivateKey()` бросает "Keyset does not exist", метаданные утверждают, что ключ существует, а файла нет — применяется одно из Решений 1–4.

## Подводные камни и похожие ошибки

- **`X509CertificateLoader` в .NET 11 не опционален.** Старый конструктор `new X509Certificate2(path, password)` помечен `SYSLIB0057` и будет удалён в будущем релизе. Мигрируйте сейчас и пересмотрите выбор `X509KeyStorageFlags`, потому что значения по умолчанию загрузчика строже.
- **`HasPrivateKey` лжёт.** Он проверяет расширение `keyUsage` сертификата и наличие `CERT_KEY_PROV_INFO_PROP_ID`, а не то, чисто ли открывается файл в `Crypto\Keys`. Тестируйте, фактически извлекая ключ, ловите `CryptographicException` и трактуйте как "нет ключа", а не разветвляйте логику по `HasPrivateKey`.
- **"Access is denied" — родственная ошибка.** Та же корневая причина (отсутствие ACL), другой путь кода: устаревший CAPI возвращает `NTE_BAD_KEYSET`, современный CNG иногда возвращает `0x80090010 NTE_PERM`, который всплывает как `CryptographicException: Access is denied`. Исправление идентично; поисковый результат другой.
- **С PFX всё хорошо; устарела ссылка на хранилище.** Если вы импортировали PFX, удалили его из `Cert:\LocalMachine\My` и заново импортировали, путь файла ключа в метаданных сертификата может указывать на старый (удалённый) контейнер. Экспортируйте, полностью удалите (`Remove-Item Cert:\LocalMachine\My\<thumbprint>` плюс `certutil -delstore`) и заново импортируйте.
- **`SqlClient` и `X509Chain.Build()` бросают то же исключение.** Оба вызывают `GetRSAPrivateKey()` под капотом при валидации цепочек или подписи строк подключения. SQL-соединение, валящееся на аутентификации по сертификату с этим сообщением, — тот же баг, что и подписант JWT, валящийся на нём; [режим сбоя `SqlException: Timeout expired`](/ru/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) сюда не относится.
- **Несоответствия CryptoAPI и CNG.** Импорт PFX, сгенерированного CAPI, через CNG (или наоборот) иногда оставляет ключ у одного провайдера, тогда как метаданные указывают на другой. `certutil -repairstore My <thumbprint>` восстанавливает связь без повторного импорта.
- **Профиль пользователя не загружен.** Запланированные задачи, пулы IIS без `LoadUserProfile` и Docker-контейнеры Windows, работающие под `ContainerUser`, разделяют это свойство. Либо включите настройку профиля, либо переключитесь на машинные ключи, либо используйте `EphemeralKeySet`.

## Связанное

- [Исправление: System.IO.FileNotFoundException: Could not load file or assembly](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) покрывает другую половину ошибок развёртывания "работает на моей машине", где проблема в бинарнике, а не в ключе.
- [Исправление: PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/) — то, что вы увидите, если опубликовали Native AOT-приложение и вызываете `new RSACryptoServiceProvider()` напрямую; AOT-компилятор полностью вырезает слой CAPI.
- [Как реализовать refresh-токены в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) показывает обвязку для самой частой причины загрузки закрытого ключа: подписи JWT в хостируемом провайдере идентичности.
- [Как сократить время холодного старта AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) обсуждает загрузку сертификатов в серверлесс-средах, где `EphemeralKeySet` — единственный флаг хранилища ключей, делающий правильное.
- [Как настроить структурированное журналирование с Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) полезно для отслеживания точного момента, когда доступ к ключу падает в продакшен-службе, поскольку операции `X509Certificate2` по умолчанию ничего не журналируют.

## Источники

- [`X509KeyStorageFlags` Enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags)
- [`X509CertificateLoader` class, .NET 9+, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509certificateloader)
- [`SYSLIB0057`: Obsolete X509Certificate2 PFX constructors](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0057)
- [Private Key Lifetime on Windows, January 2021 .NET Framework rollup, Microsoft Support](https://support.microsoft.com/en-us/topic/private-key-lifetime-on-windows-and-the-january-2021-net-framework-security-and-quality-rollup-3f097a10-f798-4ffd-8511-4757ebaf2c70)
- [`dotnet/runtime` issue 67752: occasional "Keyset does not exist" with `GetRSAPrivateKey` on Windows](https://github.com/dotnet/runtime/issues/67752)
- [`dotnet/aspnetcore` issue 3218: Data Protection "Keyset does not exist" even with PrivateKey set programmatically](https://github.com/dotnet/aspnetcore/issues/3218)
- [Load certificates in Azure App Service, MS Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate-in-code)
