---
title: "Cómo agregar la clave pública completa de un ensamblado con nombre seguro a InternalsVisibleTo en un proyecto de estilo SDK"
description: "Un ensamblado firmado debe nombrar a su ensamblado de confianza por la clave pública completa de 320 caracteres, no por el token, o la compilación falla con CS1726 o CS0281. Obtén la clave con sn -p y sn -tp, o con un script de .NET multiplataforma, y luego ponla en el metadato Key de un elemento InternalsVisibleTo en el .csproj. Cubre el respaldo de la propiedad PublicKey, la clave de DynamicProxyGenAssembly2 de Moq y la trampa de los saltos de línea."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "msbuild"
  - "unit-testing"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto"
translatedBy: "claude"
translationDate: 2026-10-04
---

Respuesta corta: cuando el ensamblado que concede el acceso tiene nombre seguro, `InternalsVisibleTo` debe llevar la **clave pública completa** del ensamblado de confianza (la cadena hexadecimal larga que empieza con `0024000004800000...`), nunca el `PublicKeyToken` de 16 caracteres. En un proyecto de estilo SDK no necesitas un `AssemblyInfo.cs` para esto: agrega `<InternalsVisibleTo Include="MyLib.Tests" Key="0024000004800000940000000602..." />` a un `ItemGroup` y el SDK genera el atributo por ti. Obtén la clave del `.snk` del ensamblado de confianza con `sn -p key.snk key.pub` seguido de `sn -tp key.pub` en Windows, o con el pequeño script de .NET de más abajo en cualquier sistema operativo. La clave debe ser una sola cadena continua sin espacios ni saltos de línea, o el compilador ignora la concesión en silencio.

Todo lo de este artículo se ejecutó en .NET 10 (SDK 10.0.302) en macOS, contra una biblioteca de clases con nombre seguro y un proyecto de pruebas con nombre seguro, así que los textos de error citados abajo son salida real del compilador. El elemento de MSBuild está soportado desde el SDK de .NET 5, y las reglas del lado del compilador no han cambiado desde .NET Framework 2.0.

## Los dos errores que obtienes sin la clave completa

Empieza con la configuración que tiene la mayoría: una biblioteca firmada y un proyecto de pruebas firmado, más el elemento que funciona bien para proyectos sin firmar.

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

La compilación falla dentro de la **biblioteca**, en un archivo que nunca escribiste:

```text
obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs(20,12): error CS1726: Friend assembly reference
'Contoso.Core.Tests' is invalid. Strong-name signed assemblies must specify a public key in their
InternalsVisibleTo declarations.
```

El SDK convirtió el elemento `InternalsVisibleTo` en `[assembly: InternalsVisibleTo("Contoso.Core.Tests")]` en el `AssemblyInfo.cs` generado, y el compilador lo rechaza. La razón es la identidad: el nombre de un ensamblado con nombre seguro es la tupla de nombre simple, versión, referencia cultural y clave pública. Una concesión solo a un nombre simple permitiría que cualquiera compilara un `Contoso.Core.Tests.dll` sin firmar y leyera tus miembros internos, lo que anula el propósito de firmar. Por eso la concesión tiene que nombrar la clave.

Probar con el token, que es lo que la mayoría tiene a mano porque aparece en cada nombre calificado por ensamblado, produce el mismo error:

```xml
<InternalsVisibleTo Include="Contoso.Core.Tests, PublicKeyToken=90d333c425def132" />
```

```text
error CS1726: Friend assembly reference 'Contoso.Core.Tests, PublicKeyToken=90d333c425def132' is invalid.
Strong-name signed assemblies must specify a public key in their InternalsVisibleTo declarations.
```

El token es un fragmento SHA-1 de 8 bytes de la clave. Identifica la clave pero no puede verificarla, así que el compilador solo acepta la clave completa. La versión, la referencia cultural y la arquitectura de procesador también se rechazan: el atributo acepta el nombre simple más, opcionalmente, `PublicKey=`.

El segundo error aparece cuando sí pasas una clave, pero es la equivocada. Esta es la salida de compilación cuando la biblioteca concede acceso con su propia clave (un error común de copiar y pegar) o con la clave de un `.snk` antiguo:

```text
Contoso.Core.Tests/Program.cs(1,32): error CS0281: Friend access was granted by 'Contoso.Core,
Version=1.0.0.0, Culture=neutral, PublicKeyToken=d2571df32581560a', but the public key of the output
assembly ('0024000004800000940000000602000000240000525341310004000001000100d938...') does not
match that specified by the InternalsVisibleTo attribute in the granting assembly.
```

CS0281 se reporta en el proyecto **de confianza**, y es el más útil de los dos porque imprime la clave que realmente tiene ese ensamblado. Si el ensamblado de confianza está firmado, puedes copiar esa cadena hexadecimal directamente del mensaje de error a la concesión. Si los paréntesis están vacíos (`('')`), el ensamblado de confianza no está firmado en absoluto: fírmalo, o quita la clave de la concesión.

## Paso 1: obtén la clave pública completa del ensamblado de confianza

Necesitas la clave pública del ensamblado que **recibe** el acceso (el proyecto de pruebas, el proyecto de benchmarks, el ensamblado de proxies de la biblioteca de mocking), no la clave de la biblioteca que lo concede.

### En Windows, con sn.exe

La herramienta Strong Name viene con el Windows SDK y está en el path en un Developer Command Prompt. No puede imprimir la clave directamente desde un `.snk` de par de claves, así que es un proceso de dos pasos:

```bash
# Windows, Developer Command Prompt for VS 2026
sn -p Contoso.Core.Tests.snk Contoso.Core.Tests.pub
sn -tp Contoso.Core.Tests.pub
```

`sn -p` extrae la mitad pública a un archivo nuevo. `sn -tp` imprime la clave pública y su token. La clave se imprime partida en varias líneas; únelas en una sola cadena antes de usarla. Si solo tienes la DLL compilada, `sn -Tp Contoso.Core.Tests.dll` (con `T` mayúscula) lee la clave del ensamblado en su lugar.

### En cualquier sistema operativo, con un script de .NET

`sn.exe` no existe en macOS ni en Linux y no forma parte del SDK de .NET. El formato es lo bastante simple como para calcularlo tú mismo. Guarda esto como `snkpub.cs` y ejecútalo con `dotnet run snkpub.cs -- <file>` (las aplicaciones basadas en archivo necesitan el SDK de .NET 10):

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

Un archivo `.snk` es un `PRIVATEKEYBLOB` de Windows CryptoAPI. La clave pública de nombre seguro que va en los metadatos es un encabezado de 12 bytes (algoritmo de firma, algoritmo de hash, longitud del blob) seguido del `PUBLICKEYBLOB` de CryptoAPI. La única línea no evidente es el parche de `aiKeyAlg`: el compilador siempre escribe `CALG_RSA_SIGN` (`0x2400`) en el encabezado del blob, mientras que una clave generada por `RSACryptoServiceProvider` o por algunas herramientas lleva `CALG_RSA_KEYX` (`0xA400`). Sin el parche, el script imprime una clave que difiere de la real en un solo byte, y obtienes CS0281 con dos claves que parecen idénticas a simple vista. Me topé exactamente con eso mientras probaba este artículo.

Para comprobar el script contra una clave que todo el mundo conoce, ejecútalo sobre el [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk) de Castle DynamicProxy. Imprime la misma clave `0024...5cc7` que Moq documenta para `DynamicProxyGenAssembly2` (token `a621a9e7e5c32e69`). Pasar la DLL firmada en lugar del `.snk` es la comprobación más segura de todas, porque así lees la clave contra la que el compilador realmente va a comparar.

## Paso 2: pon la clave en el archivo de proyecto

El `Microsoft.NET.GenerateAssemblyInfo.targets` del SDK de .NET lee un metadato `Key` en cada elemento `InternalsVisibleTo`. Pega la clave ahí:

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<ItemGroup>
  <InternalsVisibleTo Include="Contoso.Core.Tests"
                      Key="0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec01921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae125d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6" />
</ItemGroup>
```

El `obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs` generado ahora contiene:

```csharp
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(@"Contoso.Core.Tests, PublicKey=0024000004800000940000000602...")]
```

Compila, y el proyecto de pruebas puede volver a llamar a `PriceCalculator.ApplyDiscount`. Un metadato `PublicKey` funciona como alias de `Key`; los targets lo copian antes de generar el atributo, así que `<InternalsVisibleTo Include="Contoso.Core.Tests" PublicKey="0024..." />` compila de forma idéntica. Usa `Key`, ya que es el nombre que documenta el SDK.

Si prefieres el atributo en el código fuente, eso sigue funcionando y sigue siendo mejor que una sola línea gigante, porque C# pliega la concatenación de cadenas constantes en tiempo de compilación:

```csharp
// Contoso.Core/FriendAssemblies.cs, .NET 10, C# 14
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Contoso.Core.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa" +
    "216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec0" +
    "1921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae1" +
    "25d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6")]
```

No mezcles ambos estilos para el mismo ensamblado de confianza; terminas con dos atributos y solo uno de ellos se actualiza cuando la clave rota.

## Una clave para muchos ensamblados de confianza: la propiedad PublicKey

La mayoría de las soluciones firman todos los proyectos con el mismo `.snk`. Entonces cada concesión necesita la misma clave, y repetir 320 caracteres hexadecimales por elemento es ruido. El mismo archivo de targets tiene un respaldo: cuando un elemento `InternalsVisibleTo` no tiene `Key`, usa la **propiedad** de MSBuild `$(PublicKey)`. El SDK dotnet/arcade con el que se compila dotnet/runtime establece `$(PublicKey)` de esta forma, que es como esos repositorios conceden acceso a los miembros internos a sus ensamblados de pruebas.

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

Verifiqué dos cosas sobre esto. Primero, el SDK **no** rellena `$(PublicKey)` por ti a partir de `AssemblyOriginatorKeyFile`: con la firma activada y sin la propiedad, el elemento sin clave sigue fallando con CS1726. Segundo, establecer la propiedad no cambia cómo se firma la propia biblioteca; la DLL firmada seguía teniendo su propio token de su `.snk`. La propiedad solo alimenta al generador del atributo. Un elemento con un `Key` explícito sigue teniendo prioridad sobre la propiedad, que es lo que quieres para ensamblados de confianza de terceros como el de la siguiente sección.

## Conceder acceso a Moq, NSubstitute y otros proxies de Castle

Hacer un mock de una interfaz `internal` en una biblioteca con nombre seguro necesita una segunda concesión, porque el tipo del mock se emite en tiempo de ejecución en un ensamblado dinámico llamado `DynamicProxyGenAssembly2`, no en tu ensamblado de pruebas. Castle DynamicProxy firma ese ensamblado dinámico con una clave fija, así que la concesión siempre se ve igual, para Moq, NSubstitute y FakeItEasy por igual:

```xml
<!-- .NET 10 SDK; key from Castle.Core's DynProxy.snk, documented by Moq -->
<ItemGroup>
  <InternalsVisibleTo Include="DynamicProxyGenAssembly2"
                      Key="0024000004800000940000000602000000240000525341310004000001000100c547cac37abd99c8db225ef2f6c8a3602f3b3606cc9891605d02baa56104f4cfc0734aa39b93bf7852f7d9266654753cc297e7d2edfe0bac1cdcf9f717241550e0a7b191195b7667bb4f64bcb8e2121380fd1d9d46ad2d92d2d15605093924cceaf74c4861eff62abf69b9291ed0a340e113be11e6a7d3113e92484cf7045cc7" />
</ItemGroup>
```

Sin ella, la falla es una excepción en tiempo de ejecución de Castle que te dice que el tipo no es accesible para `DynamicProxyGenAssembly2`, y el propio mensaje incluye el atributo que debes agregar. Si tu biblioteca no está firmada, basta con el `<InternalsVisibleTo Include="DynamicProxyGenAssembly2" />` sin clave.

## Trampas

**Los saltos de línea y los espacios rompen la concesión sin un error.** Es tentador partir un atributo `Key` de 320 caracteres en varias líneas en el `.csproj`. MSBuild conserva los espacios en blanco, el compilador no puede analizar el resultado, y solo obtienes una advertencia en la biblioteca:

```text
warning CS1700: Assembly reference 'Contoso.Core.Tests, PublicKey=00240000048000009400...' is invalid and cannot be resolved
```

seguida de `error CS0122: 'PriceCalculator' is inaccessible due to its protection level` en el proyecto de pruebas. Si tratas las advertencias como errores lo ves de inmediato; de lo contrario, CS0122 parece indicar que la concesión falta por completo. Mantén la clave en una sola línea, o usa la concatenación de C# mostrada arriba.

**El ensamblado de confianza realmente debe estar firmado.** Una concesión con clave solo coincide con un ensamblado de confianza firmado con esa clave. En mi prueba, desactivar `SignAssembly` en el proyecto de pruebas produjo CS0281 con una clave vacía, `('')`. La dirección inversa es permisiva: una biblioteca sin firmar puede conceder acceso a un ensamblado de confianza firmado por su nombre simple, y el compilador lo acepta.

**La firma pública y la firma retrasada cuentan como firmadas.** Los repositorios de código abierto a menudo solo hacen commit de la mitad pública de su clave y establecen `<PublicSign>true</PublicSign>`, para que los colaboradores puedan compilar en Linux y macOS sin la clave privada. Eso también funciona para las comprobaciones de ensamblados de confianza: un proyecto de pruebas con firma pública usando solo el archivo `.pub` compiló y se ejecutó contra una concesión que usaba su clave. El compilador compara claves, no verifica firmas. Ejecutar un ensamblado con firma retrasada o firma pública en .NET Framework es un problema aparte, pero .NET Core y versiones posteriores ignoran las firmas de nombre seguro al cargar.

**Rotar la clave significa actualizar cada concesión.** Generar un `.snk` nuevo (por ejemplo, porque el anterior era de 1024 bits, o se filtró) cambia la clave pública y el token, así que cada `InternalsVisibleTo` que nombra al ensamblado de confianza tiene que cambiar con él. La propiedad `$(PublicKey)` en `Directory.Build.props` lo convierte en un cambio de una línea. Busca también el token antiguo en el repositorio: los nombres de tipo calificados por ensamblado en archivos de configuración y las redirecciones de enlace lo llevan.

**El nombre seguro te aporta menos que antes.** En .NET Core y .NET 5+, el runtime no valida las firmas de nombre seguro y el enlace ignora la clave a efectos de unificación. La guía actual de Microsoft es que la mayoría de las bibliotecas no necesitan nombre seguro, salvo que las consuma código de .NET Framework que lo requiera. Si controlas toda la solución y solo apuntas a .NET moderno, desactivar la firma elimina toda esta clase de problemas. Si distribuyes para consumidores de .NET Framework, mantén la firma y usa los patrones de arriba.

**Una concesión es más amplia de lo que quizá necesites.** Una concesión abre todos los tipos internos al ensamblado de confianza, no solo el que necesitabas. Para pruebas de integración con minimal hosting, un `public partial class Program` suele ser la opción más acotada.

### Lee a continuación

- [Cómo escribir pruebas de integración con WebApplicationFactory en ASP.NET Core 11](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) cubre la alternativa `public partial class Program` a concederle a un ensamblado de pruebas todos tus miembros internos.
- [Cómo solucionar "Could not load file or assembly" en una aplicación .NET publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) explica el lado del enlace de la identidad de ensamblados, donde también aparece el token de clave pública.
- [Cómo migrar una solución .NET a Central Package Management con Directory.Packages.props](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) usa el mismo patrón de archivo MSBuild en la raíz que la propiedad compartida `$(PublicKey)`.
- [xUnit v3 vs NUnit vs MSTest en 2026](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) te ayuda a elegir el framework para el proyecto de pruebas al que le concedes acceso.
- [Cómo hacer mock de un DbContext sin romper el seguimiento de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) es un recordatorio de que no todo miembro interno necesita un proxy de Castle para ser comprobable.

### Fuentes

- [Comentarios complementarios de `InternalsVisibleToAttribute`](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-compilerservices-internalsvisibletoattribute), documentación de .NET
- [Ensamblados de confianza](https://learn.microsoft.com/en-us/dotnet/standard/assembly/friend), documentación de .NET
- [Referencia de MSBuild para proyectos del SDK de .NET: `InternalsVisibleTo`](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#internalsvisibleto), documentación de .NET
- [Sn.exe (herramienta Strong Name)](https://learn.microsoft.com/en-us/dotnet/framework/tools/sn-exe-strong-name-tool), documentación de .NET Framework
- [Ensamblados con nombre seguro](https://learn.microsoft.com/en-us/dotnet/standard/assembly/strong-named) y [Guía de nombres seguros para bibliotecas](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/strong-naming), documentación de .NET
- [`Microsoft.NET.GenerateAssemblyInfo.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets), dotnet/sdk (los metadatos `Key` y `PublicKey` y el respaldo `$(PublicKey)`)
- [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk), castleproject/Core
