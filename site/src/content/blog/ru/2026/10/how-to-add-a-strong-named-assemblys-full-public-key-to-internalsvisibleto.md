---
title: "Как добавить полный открытый ключ сборки со строгим именем в InternalsVisibleTo в проекте SDK-стиля"
description: "Подписанная сборка должна указывать дружественную сборку по полному открытому ключу из 320 символов, а не по токену, иначе сборка падает с CS1726 или CS0281. Получите ключ с помощью sn -p и sn -tp или кроссплатформенного скрипта на .NET, затем поместите его в метаданные Key элемента InternalsVisibleTo в .csproj. Также разобраны запасной вариант со свойством PublicKey, ключ DynamicProxyGenAssembly2 для Moq и ловушка с переносами строк."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "msbuild"
  - "unit-testing"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto"
translatedBy: "claude"
translationDate: 2026-10-04
---

Короткий ответ: если сборка, которая предоставляет доступ, имеет строгое имя, `InternalsVisibleTo` должен содержать **полный открытый ключ** дружественной сборки (длинную шестнадцатеричную строку, начинающуюся с `0024000004800000...`), а не 16-символьный `PublicKeyToken`. В проекте SDK-стиля для этого не нужен `AssemblyInfo.cs`: добавьте `<InternalsVisibleTo Include="MyLib.Tests" Key="0024000004800000940000000602..." />` в `ItemGroup`, и SDK сгенерирует атрибут за вас. Ключ можно получить из `.snk` дружественной сборки командой `sn -p key.snk key.pub`, а затем `sn -tp key.pub` в Windows, или небольшим скриптом на .NET, приведённым ниже, в любой ОС. Ключ должен быть одной непрерывной строкой без пробелов и переносов, иначе компилятор молча проигнорирует разрешение.

Всё в этой статье запускалось на .NET 10 (SDK 10.0.302) в macOS, на библиотеке классов со строгим именем и тестовом проекте со строгим именем, поэтому приведённые ниже тексты ошибок представляют собой реальный вывод компилятора. Элемент MSBuild поддерживается начиная с .NET 5 SDK, а правила на стороне компилятора не менялись со времён .NET Framework 2.0.

## Две ошибки, которые вы получите без полного ключа

Начнём с конфигурации, которая есть у большинства: подписанная библиотека и подписанный тестовый проект, плюс элемент, который прекрасно работает для неподписанных проектов.

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <SignAssembly>true</SignAssembly>
    <AssemblyOriginatorKeyFile>../lib.snk</AssemblyOriginatorKeyFile>
  </PropertyGroup>
  <ItemGroup>
    <InternalsVisibleTo Include="Contoso.Core.Tests" />
  </ItemGroup>
</Project>
```

```csharp
// Contoso.Core/PriceCalculator.cs, .NET 10, C# 14
namespace Contoso.Core;

internal static class PriceCalculator
{
    internal static decimal ApplyDiscount(decimal price, decimal percent) =>
        price * (1 - percent / 100m);
}
```

Сборка падает внутри **библиотеки**, в файле, который вы никогда не писали:

```text
obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs(20,12): error CS1726: Friend assembly reference
'Contoso.Core.Tests' is invalid. Strong-name signed assemblies must specify a public key in their
InternalsVisibleTo declarations.
```

SDK превратил элемент `InternalsVisibleTo` в `[assembly: InternalsVisibleTo("Contoso.Core.Tests")]` в сгенерированном `AssemblyInfo.cs`, и компилятор его отвергает. Причина в идентичности: имя сборки со строгим именем представляет собой кортеж из простого имени, версии, культуры и открытого ключа. Разрешение только по простому имени позволило бы любому скомпилировать неподписанную `Contoso.Core.Tests.dll` и читать ваши внутренние члены, что лишает подпись всякого смысла. Поэтому разрешение обязано указывать ключ.

Попытка использовать токен, который у большинства под рукой, потому что он встречается в каждом имени с указанием сборки, приводит к той же ошибке:

```xml
<InternalsVisibleTo Include="Contoso.Core.Tests, PublicKeyToken=90d333c425def132" />
```

```text
error CS1726: Friend assembly reference 'Contoso.Core.Tests, PublicKeyToken=90d333c425def132' is invalid.
Strong-name signed assemblies must specify a public key in their InternalsVisibleTo declarations.
```

Токен представляет собой 8-байтовый фрагмент SHA-1 от ключа. Он идентифицирует ключ, но не может его проверить, поэтому компилятор принимает только полный ключ. Версия, культура и архитектура процессора тоже отклоняются: атрибут принимает простое имя и, при необходимости, `PublicKey=`.

Вторая ошибка появляется, когда ключ вы передаёте, но не тот. Вот вывод сборки, когда библиотека предоставляет доступ со своим собственным ключом (частая ошибка копирования) или с ключом от старого `.snk`:

```text
Contoso.Core.Tests/Program.cs(1,32): error CS0281: Friend access was granted by 'Contoso.Core,
Version=1.0.0.0, Culture=neutral, PublicKeyToken=d2571df32581560a', but the public key of the output
assembly ('0024000004800000940000000602000000240000525341310004000001000100d938...') does not
match that specified by the InternalsVisibleTo attribute in the granting assembly.
```

CS0281 выдаётся в **дружественном** проекте, и из двух ошибок она полезнее, потому что печатает ключ, который у дружественной сборки есть на самом деле. Если дружественная сборка подписана, эту шестнадцатеричную строку можно скопировать прямо из сообщения об ошибке в разрешение. Если скобки пустые (`('')`), дружественная сборка вообще не подписана: либо подпишите её, либо уберите ключ из разрешения.

## Шаг 1: получить полный открытый ключ дружественной сборки

Нужен открытый ключ сборки, которая **получает** доступ (тестового проекта, проекта бенчмарков, прокси-сборки библиотеки мокирования), а не ключ библиотеки, которая его предоставляет.

### В Windows, с помощью sn.exe

Инструмент Strong Name поставляется с Windows SDK и доступен в пути в Developer Command Prompt. Он не умеет печатать ключ напрямую из `.snk` с парой ключей, поэтому процесс состоит из двух шагов:

```bash
# Windows, Developer Command Prompt for VS 2026
sn -p Contoso.Core.Tests.snk Contoso.Core.Tests.pub
sn -tp Contoso.Core.Tests.pub
```

`sn -p` извлекает открытую половину в новый файл. `sn -tp` печатает открытый ключ и его токен. Ключ выводится с переносом на несколько строк; перед использованием соедините их в одну строку. Если у вас есть только скомпилированная DLL, `sn -Tp Contoso.Core.Tests.dll` (с заглавной `T`) прочитает ключ прямо из сборки.

### В любой ОС, с помощью скрипта на .NET

`sn.exe` не существует в macOS и Linux и не входит в .NET SDK. Формат достаточно прост, чтобы вычислить ключ самостоятельно. Сохраните это как `snkpub.cs` и запустите командой `dotnet run snkpub.cs -- <file>` (приложениям на основе файла нужен .NET 10 SDK):

```csharp
// snkpub.cs, .NET 10, C# 14: print the full public key (and token) of a .snk, a .pub or a signed .dll
using System.Reflection;
using System.Security.Cryptography;

var path = args[0];
byte[] publicKey;
if (path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
{
    publicKey = AssemblyName.GetAssemblyName(path).GetPublicKey()
        ?? throw new InvalidOperationException("Assembly is not strong-named.");
}
else if (File.ReadAllBytes(path) is [0x06 or 0x07, ..] capiBlob) // full key pair .snk
{
    using var rsa = new RSACryptoServiceProvider();
    rsa.ImportCspBlob(capiBlob);
    byte[] blob = rsa.ExportCspBlob(includePrivateParameters: false); // PUBLICKEYBLOB
    BitConverter.TryWriteBytes(blob.AsSpan(4), 0x00002400); // aiKeyAlg = CALG_RSA_SIGN, as the compiler writes it
    // Strong-name public key = SigAlgID (CALG_RSA_SIGN) + HashAlgID (CALG_SHA1) + blob length + blob
    publicKey = [.. BitConverter.GetBytes(0x00002400), .. BitConverter.GetBytes(0x00008004),
                 .. BitConverter.GetBytes(blob.Length), .. blob];
}
else
{
    publicKey = File.ReadAllBytes(path); // public-key-only file from "sn -p", already in this format
}
byte[] hash = SHA1.HashData(publicKey);
byte[] token = hash[^8..];
Array.Reverse(token);
Console.WriteLine($"PublicKey={Convert.ToHexStringLower(publicKey)}");
Console.WriteLine($"PublicKeyToken={Convert.ToHexStringLower(token)}");
```

Файл `.snk` представляет собой `PRIVATEKEYBLOB` из Windows CryptoAPI. Открытый ключ строгого имени, который попадает в метаданные, состоит из 12-байтового заголовка (алгоритм подписи, алгоритм хеширования, длина блоба), за которым следует `PUBLICKEYBLOB` из CryptoAPI. Единственная неочевидная строка здесь касается исправления `aiKeyAlg`: компилятор всегда записывает в заголовок блоба `CALG_RSA_SIGN` (`0x2400`), тогда как ключ, сгенерированный `RSACryptoServiceProvider` или некоторыми инструментами, содержит `CALG_RSA_KEYX` (`0xA400`). Без этого исправления скрипт печатает ключ, отличающийся от настоящего одним байтом, и вы получаете CS0281 с двумя ключами, которые на первый взгляд выглядят одинаково. Я наткнулся ровно на это, пока проверял эту статью.

Чтобы проверить скрипт на ключе, который все знают, запустите его на [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk) из Castle DynamicProxy. Он печатает тот же ключ `0024...5cc7`, который Moq документирует для `DynamicProxyGenAssembly2` (токен `a621a9e7e5c32e69`). Передать подписанную DLL вместо `.snk` надёжнее всего, потому что тогда вы читаете именно тот ключ, с которым компилятор будет сравнивать.

## Шаг 2: поместить ключ в файл проекта

`Microsoft.NET.GenerateAssemblyInfo.targets` из .NET SDK читает метаданные `Key` у каждого элемента `InternalsVisibleTo`. Вставьте ключ туда:

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<ItemGroup>
  <InternalsVisibleTo Include="Contoso.Core.Tests"
                      Key="0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec01921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae125d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6" />
</ItemGroup>
```

Сгенерированный `obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs` теперь содержит:

```csharp
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(@"Contoso.Core.Tests, PublicKey=0024000004800000940000000602...")]
```

Соберите проект, и тестовый проект снова может вызывать `PriceCalculator.ApplyDiscount`. Метаданные `PublicKey` работают как псевдоним для `Key`; targets копируют их перед генерацией атрибута, так что `<InternalsVisibleTo Include="Contoso.Core.Tests" PublicKey="0024..." />` собирается точно так же. Используйте `Key`, поскольку именно это имя документирует SDK.

Если вы предпочитаете атрибут в исходном коде, это по-прежнему работает и всё равно лучше гигантской единой строки, потому что C# сворачивает конкатенацию константных строк на этапе компиляции:

```csharp
// Contoso.Core/FriendAssemblies.cs, .NET 10, C# 14
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Contoso.Core.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa" +
    "216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec0" +
    "1921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae1" +
    "25d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6")]
```

Не смешивайте оба стиля для одной и той же дружественной сборки; в итоге получатся два атрибута, и при смене ключа обновится только один из них.

## Один ключ для многих дружественных сборок: свойство PublicKey

Большинство решений подписывают каждый проект одним и тем же `.snk`. Тогда каждому разрешению нужен один и тот же ключ, и повторять 320 шестнадцатеричных символов в каждом элементе означает лишний шум. В том же файле targets есть запасной вариант: если у элемента `InternalsVisibleTo` нет `Key`, используется **свойство** MSBuild `$(PublicKey)`. SDK dotnet/arcade, с которым собирается dotnet/runtime, задаёт `$(PublicKey)` именно так, и именно так эти репозитории открывают внутренние члены своим тестовым сборкам.

```xml
<!-- Directory.Build.props at the repo root, .NET 10 SDK -->
<Project>
  <PropertyGroup>
    <SignAssembly>true</SignAssembly>
    <AssemblyOriginatorKeyFile>$(MSBuildThisFileDirectory)build/Contoso.snk</AssemblyOriginatorKeyFile>
    <PublicKey>0024000004800000940000000602000000240000525341310004000001000100d938683d...</PublicKey>
  </PropertyGroup>
</Project>
```

```xml
<!-- Any library project -->
<ItemGroup>
  <InternalsVisibleTo Include="$(AssemblyName).Tests" />
  <InternalsVisibleTo Include="Contoso.Benchmarks" />
</ItemGroup>
```

Две вещи я здесь проверил. Во-первых, SDK **не** заполняет `$(PublicKey)` за вас из `AssemblyOriginatorKeyFile`: при включённой подписи и без свойства голый элемент по-прежнему падает с CS1726. Во-вторых, задание свойства не меняет того, как подписывается сама библиотека; подписанная DLL по-прежнему имела собственный токен от своего `.snk`. Свойство лишь питает генератор атрибутов. Элемент с явным `Key` по-прежнему имеет приоритет над свойством, а это как раз то, что нужно для сторонних дружественных сборок вроде той, что описана в следующем разделе.

## Предоставление доступа Moq, NSubstitute и другим прокси Castle

Мокирование `internal` интерфейса в библиотеке со строгим именем требует второго разрешения, потому что тип мока генерируется во время выполнения в динамическую сборку с именем `DynamicProxyGenAssembly2`, а не в вашу тестовую сборку. Castle DynamicProxy подписывает эту динамическую сборку фиксированным ключом, поэтому разрешение всегда выглядит одинаково, что для Moq, что для NSubstitute и FakeItEasy:

```xml
<!-- .NET 10 SDK; key from Castle.Core's DynProxy.snk, documented by Moq -->
<ItemGroup>
  <InternalsVisibleTo Include="DynamicProxyGenAssembly2"
                      Key="0024000004800000940000000602000000240000525341310004000001000100c547cac37abd99c8db225ef2f6c8a3602f3b3606cc9891605d02baa56104f4cfc0734aa39b93bf7852f7d9266654753cc297e7d2edfe0bac1cdcf9f717241550e0a7b191195b7667bb4f64bcb8e2121380fd1d9d46ad2d92d2d15605093924cceaf74c4861eff62abf69b9291ed0a340e113be11e6a7d3113e92484cf7045cc7" />
</ItemGroup>
```

Без него сбой проявляется как исключение времени выполнения от Castle, сообщающее, что тип недоступен для `DynamicProxyGenAssembly2`, причём само сообщение содержит атрибут, который нужно добавить. Если ваша библиотека не подписана, достаточно голого `<InternalsVisibleTo Include="DynamicProxyGenAssembly2" />`.

## Подводные камни

**Переносы строк и пробелы ломают разрешение без ошибки.** Возникает соблазн перенести 320-символьный атрибут `Key` на несколько строк в `.csproj`. MSBuild сохраняет пробельные символы, компилятор не может разобрать результат, и вы получаете лишь предупреждение в библиотеке:

```text
warning CS1700: Assembly reference 'Contoso.Core.Tests, PublicKey=00240000048000009400...' is invalid and cannot be resolved
```

за которым следует `error CS0122: 'PriceCalculator' is inaccessible due to its protection level` в тестовом проекте. Если вы считаете предупреждения ошибками, вы увидите это сразу; иначе CS0122 выглядит так, будто разрешения нет вовсе. Держите ключ в одной строке или используйте конкатенацию C#, показанную выше.

**Дружественная сборка должна быть действительно подписана.** Разрешение с ключом подходит только для дружественной сборки, подписанной этим ключом. В моём прогоне отключение `SignAssembly` в тестовом проекте дало CS0281 с пустым ключом, `('')`. В обратном направлении правила мягкие: неподписанная библиотека может предоставить доступ подписанной дружественной сборке по простому имени, и компилятор это принимает.

**Публичная подпись и отложенная подпись считаются подписью.** Репозитории с открытым исходным кодом часто коммитят только открытую половину своего ключа и задают `<PublicSign>true</PublicSign>`, чтобы контрибьюторы могли собирать проект в Linux и macOS без закрытого ключа. Для проверок дружественных сборок это тоже работает: тестовый проект с публичной подписью только по файлу `.pub` собрался и запустился с разрешением, использующим его ключ. Компилятор сравнивает ключи, а не проверяет подписи. Запуск сборки с отложенной или публичной подписью под .NET Framework представляет собой отдельную проблему, но .NET Core и более поздние версии игнорируют подписи строгих имён при загрузке.

**Смена ключа означает обновление всех разрешений.** Генерация нового `.snk` (например, потому что старый был 1024-битным или утёк) меняет открытый ключ и токен, поэтому каждый `InternalsVisibleTo`, указывающий на дружественную сборку, должен измениться вместе с ним. Свойство `$(PublicKey)` в `Directory.Build.props` превращает это в изменение одной строки. Поищите старый токен в репозитории тоже: его содержат имена типов с указанием сборки в конфигурационных файлах и перенаправления привязок.

**Строгое имя даёт меньше, чем раньше.** В .NET Core и .NET 5+ среда выполнения не проверяет подписи строгих имён, а привязка игнорирует ключ при унификации. Текущая рекомендация Microsoft состоит в том, что большинству библиотек строгое имя не нужно, если только их не использует код .NET Framework, который этого требует. Если вы контролируете всё решение и нацелены только на современный .NET, отключение подписи устраняет весь этот класс проблем. Если вы поставляете библиотеку потребителям .NET Framework, сохраняйте подпись и используйте описанные выше приёмы.

**Разрешение шире, чем вам может быть нужно.** Разрешение открывает дружественной сборке все внутренние типы, а не только тот, который вам понадобился. Для интеграционных тестов с minimal hosting обычно более узким выбором будет `public partial class Program`.

### Читайте далее

- [Как писать интеграционные тесты с WebApplicationFactory в ASP.NET Core 11](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) описывает альтернативу с `public partial class Program` вместо того, чтобы открывать тестовой сборке все внутренние члены.
- [Как исправить "Could not load file or assembly" в опубликованном .NET-приложении](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) объясняет сторону привязки в идентичности сборок, где тоже фигурирует токен открытого ключа.
- [Как перевести решение .NET на Central Package Management с Directory.Packages.props](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) использует тот же шаблон файла MSBuild на корневом уровне, что и общее свойство `$(PublicKey)`.
- [xUnit v3 vs NUnit vs MSTest в 2026 году](/ru/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) помогает выбрать фреймворк для тестового проекта, которому вы предоставляете доступ.
- [Как мокировать DbContext, не ломая отслеживание изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) напоминает, что не каждому внутреннему члену нужен прокси Castle, чтобы быть тестируемым.

### Источники

- [Дополнительные примечания к `InternalsVisibleToAttribute`](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-compilerservices-internalsvisibletoattribute), документация .NET
- [Дружественные сборки](https://learn.microsoft.com/en-us/dotnet/standard/assembly/friend), документация .NET
- [Справочник MSBuild для проектов .NET SDK: `InternalsVisibleTo`](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#internalsvisibleto), документация .NET
- [Sn.exe (инструмент Strong Name)](https://learn.microsoft.com/en-us/dotnet/framework/tools/sn-exe-strong-name-tool), документация .NET Framework
- [Сборки со строгими именами](https://learn.microsoft.com/en-us/dotnet/standard/assembly/strong-named) и [Рекомендации по строгим именам для библиотек](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/strong-naming), документация .NET
- [`Microsoft.NET.GenerateAssemblyInfo.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets), dotnet/sdk (метаданные `Key`, `PublicKey` и запасной вариант `$(PublicKey)`)
- [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk), castleproject/Core
