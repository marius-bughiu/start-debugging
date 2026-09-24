---
title: "Microsoft меняет сертификат авторской подписи NuGet: исправьте trustedSigners до появления NU3034"
description: "С 23 сентября 2026 года пакеты Microsoft в NuGet получают авторскую подпись новым сертификатом (SHA-256 9A1B131B...). Если ваш nuget.config закрепляет Microsoft в trustedSigners, восстановление пакетов завершится ошибкой NU3034. Разбираем исправление, включая правильную команду dotnet nuget trust."
pubDate: 2026-09-24
tags:
  - "nuget"
  - "dotnet"
  - "security"
  - "supply-chain"
lang: "ru"
translationOf: "2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034"
translatedBy: "claude"
translationDate: 2026-09-24
---

23 сентября 2026 года команда .NET [объявила](https://devblogs.microsoft.com/dotnet/microsoft-author-signing-certificate-update-2026/), что Microsoft меняет сертификат, которым подписывает пакеты на nuget.org как автор. Большинство проектов этого никогда не заметит. Но если вы используете NuGet с `signatureValidationMode="require"` и списком `<trustedSigners>`, в котором указан Microsoft, или запускаете `dotnet nuget verify --certificate-fingerprint` в CI, то первый же пакет, подписанный новым сертификатом, вызовет ошибку `NU3034` и сломает сборку.

## Отпечатки сертификатов

У нового сертификата SHA-256 отпечаток `9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630`. Заменяемый сертификат имеет отпечаток `566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353`. Два более старых отпечатка, `3F9001EA...` и `AA12DA22...`, тоже остаются действительными для пакетов, подписанных много лет назад.

Не удаляйте ни один из них. Пакеты, уже опубликованные на nuget.org, сохраняют свои исходные подписи, поэтому ваш список доверенных подписантов должен принимать все сертификаты, которые когда-либо использовал Microsoft, а не только самый новый.

## Переход происходит постепенно

Я скачал `Microsoft.Playwright` 1.63.0 (опубликован 23 сентября в 20:23 UTC) и `Microsoft.Identity.Web` 4.15.0 и запустил `dotnet nuget verify --all -v normal` на SDK 10.0.302. Оба пакета всё ещё подписаны старым сертификатом:

```text
Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353
  Valid from: 27/07/2023 03:00:00 to 18/10/2026 02:59:59
```

Срок действия старого сертификата истекает 18 октября 2026 года. Команды Microsoft публикуют пакеты по собственному графику, так что пакеты будут переходить на новый сертификат в течение ближайших нескольких недель. После 18 октября старым сертификатом ничего нового подписать уже нельзя. Сборка, которая работает сегодня, вполне может упасть в следующий вторник.

## Команда trust из анонса не работает

В посте блога предлагается `dotnet nuget trust author Microsoft <fingerprint> --algorithm SHA256`. На SDK 10.0.302 она завершается ошибкой `Unrecognized command or argument '--algorithm'`, потому что `trust author` принимает путь к подписанному пакету, а не отпечаток. Чтобы добавить отпечаток напрямую, используйте [`trust certificate`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-trust):

```bash
dotnet nuget trust certificate Microsoft 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630 --algorithm SHA256 --configfile nuget.config
```

Если запись автора `Microsoft` уже существует, команда добавит отпечаток в неё ("Successfully updated the trusted signer 'Microsoft'"). В итоговой конфигурации должны быть перечислены все четыре:

```xml
<trustedSigners>
  <author name="Microsoft">
    <certificate fingerprint="3F9001EA83C560D712C24CF213C3D312CB3BFF51EE89435D3430BD06B5D0EECE" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="AA12DA22A49BCE7D5C1AE64CC1F3D892F150DA76140F210ABD2CBFFCA2C18A27" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
  </author>
</trustedSigners>
```

## Шаги проверки в CI

`dotnet nuget verify` принимает `--certificate-fingerprint` несколько раз. Передайте все четыре. С одним-единственным отпечатком проверка упадёт, как только встретит пакет, подписанный другим сертификатом. Например, проверка Playwright 1.63.0 только по новому отпечатку выводит:

```text
error: NU3034: The package signature did not match any of the allowed certificate fingerprints.
```

Организациям, которые зеркалируют nuget.org во внутренний фид и проверяют подписи при загрузке, нужно внести там такое же изменение. [Справка по NU3034](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu3034) и [руководство по подписанным пакетам](https://learn.microsoft.com/en-us/nuget/consume-packages/installing-signed-packages) описывают остальную часть модели `trustedSigners`. Добавить новый отпечаток сейчас, до того как восстановление встретит использующий его пакет, гораздо проще, чем разбираться с красной сборкой в середине октября.
