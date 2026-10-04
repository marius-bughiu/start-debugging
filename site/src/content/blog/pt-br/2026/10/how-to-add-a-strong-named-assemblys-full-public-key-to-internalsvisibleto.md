---
title: "Como adicionar a chave pública completa de um assembly com strong name ao InternalsVisibleTo em um projeto no estilo SDK"
description: "Um assembly assinado precisa nomear seu amigo pela chave pública completa de 320 caracteres, não pelo token, ou o build falha com CS1726 ou CS0281. Obtenha a chave com sn -p e sn -tp, ou com um script .NET multiplataforma, e coloque-a no metadado Key de um item InternalsVisibleTo no .csproj. Cobre o fallback da propriedade PublicKey, a chave DynamicProxyGenAssembly2 do Moq e a armadilha das quebras de linha."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "msbuild"
  - "unit-testing"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto"
translatedBy: "claude"
translationDate: 2026-10-04
---

Resposta curta: quando o assembly que concede acesso tem strong name, o `InternalsVisibleTo` precisa carregar a **chave pública completa** do assembly amigo (a longa string hexadecimal que começa com `0024000004800000...`), nunca o `PublicKeyToken` de 16 caracteres. Em um projeto no estilo SDK você não precisa de um `AssemblyInfo.cs` para isso: adicione `<InternalsVisibleTo Include="MyLib.Tests" Key="0024000004800000940000000602..." />` a um `ItemGroup` e o SDK gera o atributo para você. Obtenha a chave a partir do `.snk` do amigo com `sn -p key.snk key.pub` seguido de `sn -tp key.pub` no Windows, ou com o pequeno script .NET abaixo em qualquer sistema operacional. A chave precisa ser uma única string contínua, sem espaços nem quebras de linha, ou o compilador ignora a concessão silenciosamente.

Tudo neste post foi executado no .NET 10 (SDK 10.0.302) no macOS, com uma biblioteca de classes com strong name e um projeto de testes com strong name, então os textos de erro citados abaixo são saída real do compilador. O item do MSBuild é suportado desde o SDK do .NET 5, e as regras do lado do compilador não mudam desde o .NET Framework 2.0.

## Os dois erros que você recebe sem a chave completa

Comece pelo cenário que a maioria das pessoas tem: uma biblioteca assinada e um projeto de testes assinado, mais o item que funciona bem para projetos não assinados.

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

O build falha dentro da **biblioteca**, em um arquivo que você nunca escreveu:

```text
obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs(20,12): error CS1726: Friend assembly reference
'Contoso.Core.Tests' is invalid. Strong-name signed assemblies must specify a public key in their
InternalsVisibleTo declarations.
```

O SDK transformou o item `InternalsVisibleTo` em `[assembly: InternalsVisibleTo("Contoso.Core.Tests")]` no `AssemblyInfo.cs` gerado, e o compilador o recusa. O motivo é identidade: o nome de um assembly com strong name é a tupla formada por nome simples, versão, cultura e chave pública. Uma concessão apenas para um nome simples permitiria que qualquer pessoa compilasse um `Contoso.Core.Tests.dll` não assinado e lesse seus internals, o que anula o propósito da assinatura. Então a concessão precisa nomear a chave.

Tentar o token, que é o que a maioria das pessoas tem à mão porque ele aparece em todo nome qualificado por assembly, produz o mesmo erro:

```xml
<InternalsVisibleTo Include="Contoso.Core.Tests, PublicKeyToken=90d333c425def132" />
```

```text
error CS1726: Friend assembly reference 'Contoso.Core.Tests, PublicKeyToken=90d333c425def132' is invalid.
Strong-name signed assemblies must specify a public key in their InternalsVisibleTo declarations.
```

O token é um fragmento SHA-1 de 8 bytes da chave. Ele identifica a chave, mas não consegue verificá-la, então o compilador só aceita a chave completa. Versão, cultura e arquitetura de processador também são rejeitadas: o atributo aceita o nome simples mais, opcionalmente, `PublicKey=`.

O segundo erro aparece quando você passa uma chave, mas é a errada. Esta é a saída do build quando a biblioteca concede acesso com sua própria chave (um erro comum de copiar e colar) ou com a chave de um `.snk` antigo:

```text
Contoso.Core.Tests/Program.cs(1,32): error CS0281: Friend access was granted by 'Contoso.Core,
Version=1.0.0.0, Culture=neutral, PublicKeyToken=d2571df32581560a', but the public key of the output
assembly ('0024000004800000940000000602000000240000525341310004000001000100d938...') does not
match that specified by the InternalsVisibleTo attribute in the granting assembly.
```

O CS0281 é reportado no projeto **amigo**, e é o mais útil dos dois porque imprime a chave que o amigo de fato tem. Se o amigo estiver assinado, você pode copiar essa string hexadecimal direto da mensagem de erro para a concessão. Se os parênteses estiverem vazios (`('')`), o amigo não está assinado: assine-o ou remova a chave da concessão.

## Passo 1: obtenha a chave pública completa do amigo

Você precisa da chave pública do assembly que está **recebendo** acesso (o projeto de testes, o projeto de benchmark, o assembly de proxy da biblioteca de mocking), não da chave da biblioteca que concede o acesso.

### No Windows, com sn.exe

A ferramenta Strong Name vem com o Windows SDK e está no path em um Developer Command Prompt. Ela não consegue imprimir a chave direto de um `.snk` com o par de chaves, então são dois passos:

```bash
# Windows, Developer Command Prompt for VS 2026
sn -p Contoso.Core.Tests.snk Contoso.Core.Tests.pub
sn -tp Contoso.Core.Tests.pub
```

`sn -p` extrai a metade pública para um novo arquivo. `sn -tp` imprime a chave pública e seu token. A chave é impressa quebrada em várias linhas; junte-as em uma única string antes de usá-la. Se você só tem a DLL compilada, `sn -Tp Contoso.Core.Tests.dll` (com `T` maiúsculo) lê a chave do próprio assembly.

### Em qualquer sistema operacional, com um script .NET

O `sn.exe` não existe no macOS nem no Linux e não faz parte do SDK do .NET. O formato é simples o bastante para você calcular por conta própria. Salve isto como `snkpub.cs` e execute com `dotnet run snkpub.cs -- <file>` (file-based apps exigem o SDK do .NET 10):

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

Um arquivo `.snk` é um `PRIVATEKEYBLOB` da CryptoAPI do Windows. A chave pública de strong name que vai para os metadados é um cabeçalho de 12 bytes (algoritmo de assinatura, algoritmo de hash, tamanho do blob) seguido pelo `PUBLICKEYBLOB` da CryptoAPI. A única linha nada óbvia é o ajuste do `aiKeyAlg`: o compilador sempre escreve `CALG_RSA_SIGN` (`0x2400`) no cabeçalho do blob, enquanto uma chave gerada pelo `RSACryptoServiceProvider` ou por algumas ferramentas carrega `CALG_RSA_KEYX` (`0xA400`). Sem o ajuste, o script imprime uma chave que difere da real em um único byte, e você recebe o CS0281 com duas chaves que parecem idênticas à primeira vista. Topei exatamente com isso enquanto testava este post.

Para conferir o script contra uma chave que todo mundo conhece, execute-o sobre o [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk) do Castle DynamicProxy. Ele imprime a mesma chave `0024...5cc7` que o Moq documenta para `DynamicProxyGenAssembly2` (token `a621a9e7e5c32e69`). Passar a DLL assinada em vez do `.snk` é a verificação mais segura de todas, porque assim você está lendo a chave contra a qual o compilador vai de fato comparar.

## Passo 2: coloque a chave no arquivo de projeto

O `Microsoft.NET.GenerateAssemblyInfo.targets` do SDK do .NET lê um metadado `Key` em cada item `InternalsVisibleTo`. Cole a chave ali:

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<ItemGroup>
  <InternalsVisibleTo Include="Contoso.Core.Tests"
                      Key="0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec01921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae125d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6" />
</ItemGroup>
```

O `obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs` gerado agora contém:

```csharp
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(@"Contoso.Core.Tests, PublicKey=0024000004800000940000000602...")]
```

Compile, e o projeto de testes consegue chamar `PriceCalculator.ApplyDiscount` de novo. Um metadado `PublicKey` funciona como alias para `Key`; os targets o copiam antes de gerar o atributo, então `<InternalsVisibleTo Include="Contoso.Core.Tests" PublicKey="0024..." />` compila de forma idêntica. Use `Key`, já que esse é o nome que o SDK documenta.

Se você prefere o atributo no código-fonte, isso ainda funciona e ainda é melhor que uma única linha gigante, porque o C# resolve a concatenação de strings constantes em tempo de compilação:

```csharp
// Contoso.Core/FriendAssemblies.cs, .NET 10, C# 14
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Contoso.Core.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa" +
    "216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec0" +
    "1921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae1" +
    "25d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6")]
```

Não misture os dois estilos para o mesmo amigo; você acaba com dois atributos e só um deles é atualizado quando a chave muda.

## Uma chave para muitos amigos: a propriedade PublicKey

A maioria das soluções assina todos os projetos com o mesmo `.snk`. Aí toda concessão precisa da mesma chave, e repetir 320 caracteres hexadecimais por item é ruído. O mesmo arquivo de targets tem um fallback: quando um item `InternalsVisibleTo` não tem `Key`, ele usa a **propriedade** do MSBuild `$(PublicKey)`. O SDK dotnet/arcade, com o qual o dotnet/runtime é compilado, define `$(PublicKey)` desse jeito, e é assim que esses repositórios concedem internals aos seus assemblies de teste.

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

Verifiquei duas coisas sobre isso. Primeiro, o SDK **não** preenche `$(PublicKey)` para você a partir do `AssemblyOriginatorKeyFile`: com a assinatura ligada e sem a propriedade, o item sem chave continua falhando com CS1726. Segundo, definir a propriedade não muda como a própria biblioteca é assinada; a DLL assinada continuou com seu próprio token vindo do seu `.snk`. A propriedade só alimenta o gerador de atributos. Um item com `Key` explícito continua prevalecendo sobre a propriedade, que é o que você quer para amigos de terceiros como o da próxima seção.

## Concedendo acesso a Moq, NSubstitute e outros proxies do Castle

Fazer mock de uma interface `internal` em uma biblioteca com strong name exige uma segunda concessão, porque o tipo do mock é emitido em tempo de execução em um assembly dinâmico chamado `DynamicProxyGenAssembly2`, e não no seu assembly de testes. O Castle DynamicProxy assina esse assembly dinâmico com uma chave fixa, então a concessão é sempre a mesma, seja para Moq, NSubstitute ou FakeItEasy:

```xml
<!-- .NET 10 SDK; key from Castle.Core's DynProxy.snk, documented by Moq -->
<ItemGroup>
  <InternalsVisibleTo Include="DynamicProxyGenAssembly2"
                      Key="0024000004800000940000000602000000240000525341310004000001000100c547cac37abd99c8db225ef2f6c8a3602f3b3606cc9891605d02baa56104f4cfc0734aa39b93bf7852f7d9266654753cc297e7d2edfe0bac1cdcf9f717241550e0a7b191195b7667bb4f64bcb8e2121380fd1d9d46ad2d92d2d15605093924cceaf74c4861eff62abf69b9291ed0a340e113be11e6a7d3113e92484cf7045cc7" />
</ItemGroup>
```

Sem ela, a falha é uma exceção em tempo de execução do Castle dizendo que o tipo não está acessível para `DynamicProxyGenAssembly2`, e a própria mensagem inclui o atributo a adicionar. Se a sua biblioteca não está assinada, o simples `<InternalsVisibleTo Include="DynamicProxyGenAssembly2" />` basta.

## Armadilhas

**Quebras de linha e espaços quebram a concessão sem erro.** É tentador quebrar um atributo `Key` de 320 caracteres em várias linhas no `.csproj`. O MSBuild mantém o espaço em branco, o compilador não consegue interpretar o resultado, e você recebe apenas um aviso na biblioteca:

```text
warning CS1700: Assembly reference 'Contoso.Core.Tests, PublicKey=00240000048000009400...' is invalid and cannot be resolved
```

seguido de `error CS0122: 'PriceCalculator' is inaccessible due to its protection level` no projeto de testes. Se você trata avisos como erros, enxerga isso na hora; caso contrário, o CS0122 parece indicar que a concessão está completamente ausente. Mantenha a chave em uma única linha ou use a concatenação em C# mostrada acima.

**O amigo precisa estar de fato assinado.** Uma concessão com chave só corresponde a um amigo assinado com essa chave. No meu teste, desligar o `SignAssembly` no projeto de testes produziu CS0281 com uma chave vazia, `('')`. A direção inversa é tolerante: uma biblioteca não assinada pode conceder acesso a um amigo assinado pelo nome simples, e o compilador aceita.

**Public signing e delay signing contam como assinados.** Repositórios open source costumam versionar apenas a metade pública da chave e definir `<PublicSign>true</PublicSign>`, para que colaboradores possam compilar no Linux e no macOS sem a chave privada. Isso também funciona nas verificações de amigos: um projeto de testes com public signing usando só o arquivo `.pub` compilou e rodou contra uma concessão com sua chave. O compilador compara chaves, ele não verifica assinaturas. Executar um assembly com delay signing ou public signing no .NET Framework é outro problema, mas o .NET Core e versões posteriores ignoram assinaturas de strong name no carregamento.

**Trocar a chave significa atualizar todas as concessões.** Gerar um novo `.snk` (por exemplo, porque o antigo era de 1024 bits ou vazou) muda a chave pública e o token, então todo `InternalsVisibleTo` que nomeia o amigo precisa mudar junto. A propriedade `$(PublicKey)` no `Directory.Build.props` transforma isso em uma alteração de uma linha. Procure também o token antigo no repositório: nomes de tipo qualificados por assembly em arquivos de configuração e binding redirects o carregam.

**Strong naming oferece menos do que antes.** No .NET Core e no .NET 5+, o runtime não valida assinaturas de strong name e o binding ignora a chave para fins de unificação. A orientação atual da Microsoft é que a maioria das bibliotecas não precisa de strong name, a menos que seja consumida por código .NET Framework que exija isso. Se você controla a solução inteira e só mira o .NET moderno, desligar a assinatura elimina toda essa classe de problema. Se você distribui para consumidores do .NET Framework, mantenha a assinatura e use os padrões acima.

**Uma concessão é mais ampla do que talvez você precise.** Uma concessão abre todos os tipos internos para o amigo, não só aquele de que você precisava. Para testes de integração com minimal hosting, um `public partial class Program` costuma ser a opção mais restrita.

### Leia a seguir

- [Como escrever testes de integração com WebApplicationFactory no ASP.NET Core 11](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) cobre a alternativa `public partial class Program` a conceder a um assembly de testes todos os seus internals.
- [Como corrigir "Could not load file or assembly" em um app .NET publicado](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) explica o lado do binding da identidade de assemblies, onde o public key token também aparece.
- [Como migrar uma solução .NET para o Central Package Management com Directory.Packages.props](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) usa o mesmo padrão de arquivo MSBuild na raiz que a propriedade compartilhada `$(PublicKey)`.
- [xUnit v3 vs NUnit vs MSTest em 2026](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) ajuda a escolher o framework para o projeto de testes ao qual você está concedendo acesso.
- [Como fazer mock de um DbContext sem quebrar o change tracking](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) lembra que nem todo internal precisa de um proxy do Castle para ser testável.

### Fontes

- [Comentários complementares de `InternalsVisibleToAttribute`](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-compilerservices-internalsvisibletoattribute), documentação do .NET
- [Assemblies amigos](https://learn.microsoft.com/en-us/dotnet/standard/assembly/friend), documentação do .NET
- [Referência do MSBuild para projetos do SDK do .NET: `InternalsVisibleTo`](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#internalsvisibleto), documentação do .NET
- [Sn.exe (ferramenta Strong Name)](https://learn.microsoft.com/en-us/dotnet/framework/tools/sn-exe-strong-name-tool), documentação do .NET Framework
- [Assemblies com strong name](https://learn.microsoft.com/en-us/dotnet/standard/assembly/strong-named) e [Orientação sobre strong naming para bibliotecas](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/strong-naming), documentação do .NET
- [`Microsoft.NET.GenerateAssemblyInfo.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets), dotnet/sdk (os metadados `Key` e `PublicKey` e o fallback `$(PublicKey)`)
- [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk), castleproject/Core
