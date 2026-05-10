---
title: "Fix: PlatformNotSupportedException: Operation is not supported on this platform em Native AOT"
description: "Native AOT remove o JIT e o interpretador, então reflection emit, compilação de árvores de expressão e MakeGenericType desconhecidos lançam em runtime. Encontre a chamada via IL3050 e troque por um gerador de código-fonte ou um caminho pré-pronto."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "native-aot"
  - "trimming"
lang: "pt-br"
translationOf: "2026/05/fix-platformnotsupportedexception-in-native-aot"
translatedBy: "claude"
translationDate: 2026-05-10
---

A correção: Native AOT publica um único binário nativo sem JIT e sem interpretador, então qualquer caminho de código que emita IL em runtime, compile uma árvore `Expression<T>` ou peça ao runtime para construir uma instanciação genérica que ele nunca viu, vai lançar `PlatformNotSupportedException`. O primeiro passo é sempre o mesmo: recompile com `dotnet publish -r <rid> -c Release` e leia o aviso `IL3050` que nomeia o membro infrator, depois substitua por uma alternativa compatível com AOT (um gerador de código-fonte, um genérico pré-instanciado ou um feature switch).

```text
System.PlatformNotSupportedException: Operation is not supported on this platform.
   at System.Reflection.Emit.DynamicMethod..ctor(String name, Type returnType, Type[] parameterTypes)
   at SomeLibrary.Internal.ExpressionCompiler.Compile(LambdaExpression expr)
   at SomeLibrary.PublicEntryPoint.DoTheThing()
   at Program.<Main>$(String[] args) in /src/Program.cs:line 12
```

```text
System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
   at System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(...)
   at System.Linq.Expressions.Compiler.LambdaCompiler.CompileLambda(LambdaExpression lambda, Boolean hasClosureArgument)
   at System.Linq.Expressions.Expression`1[[T]].Compile()
```

Este guia foi escrito contra o SDK do .NET 11 (preview 4), `Microsoft.NET.Sdk` 11.0.0-preview.4 e C# 14. O texto da exceção e a restrição subjacente estão estáveis desde que o Native AOT foi lançado como implantação suportada no .NET 8, então tudo abaixo se aplica sem mudanças no .NET 8, 10 e 11. O .NET 9 adicionou a história do analisador `RequiresDynamicCodeAttribute` que sustenta o IL3050, e o .NET 11 reforça mais ainda promovendo mais caminhos da BCL para variantes seguras para AOT.

Duas mensagens distintas compartilham o mesmo tipo de exceção. `Operation is not supported on this platform` vem do caminho rápido do JIT-emit tropeçando em `RuntimeFeature.IsDynamicCodeSupported == false`. `Dynamic code generation is not supported on this platform` vem do próprio `Reflection.Emit` quando algo tenta construir um `DynamicAssembly` ou um `DynamicMethod`. Ambos têm a mesma causa raiz e a mesma superfície de correção, então não perca tempo tratando-os como bugs separados.

## Por que um binário Native AOT de arquivo único não pode emitir IL

`dotnet publish /p:PublishAot=true` produz uma imagem nativa totalmente compilada antecipadamente. O JIT não é linkado estaticamente. O interpretador do Mono não é linkado estaticamente. O escritor `Reflection.Emit` do CoreCLR é compilado fora. Em runtime, `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` retorna `false`, e qualquer API que dependa de escrever IL novo ou montar um delegate novo a partir de código de máquina cru retorna ou uma falha de guarda no estilo `IsSupported` ou esta exceção.

As quatro formas que esbarram nessa restrição em código real:

1. **Uso direto de `Reflection.Emit`.** `DynamicMethod`, `AssemblyBuilder.DefineDynamicAssembly`, `TypeBuilder`, `ILGenerator.Emit`. Lançam imediatamente.
2. **`Expression<T>.Compile()` sobre uma árvore não trivial.** O compilador de expressões internamente desce para `DynamicMethod`. `Compile(preferInterpretation: true)` cai para o interpretador no .NET 8 e 10, mas o interpretador também é removido do Native AOT, então até a sobrecarga `true` lança a menos que a BCL tenha um fallback que percorra a árvore.
3. **`Type.MakeGenericType` / `MethodInfo.MakeGenericMethod` com argumentos de tipo que o compilador não viu.** `List<int>` funciona porque o compilador AOT instanciou. `MakeGenericType(someTypeFromReflection)` sobre um value type que o compilador nunca alcançou lança.
4. **Transitivamente, qualquer coisa construída em cima do acima.** Os mappers compilados por expressão do AutoMapper, FastMember, os genéricos abertos do MediatR, o cache de conversores do Newtonsoft.Json, o caminho de consulta compilada do EF Core sobre grafos POCO que o model builder não cobriu, o gRPC.Core com seu codegen antigo, e os clientes Dataverse / Service Fabric / WCF que se apoiam em proxies dinâmicos.

Em uma build JIT, o runtime simplesmente faz tier-0 codegen do método novo e segue. No Native AOT ele não tem onde colocar o código novo, então lança no primeiro momento em que a API é chamada.

## Reprodução mínima

```csharp
// .NET 11 SDK preview 4, C# 14, <PublishAot>true</PublishAot>
using System.Linq.Expressions;

Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();   // throws on Native AOT
Console.WriteLine(compiled(41));
```

`.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

Publique no Linux x64:

```bash
dotnet publish -r linux-x64 -c Release
```

A etapa de publicação imprime:

```text
warning IL3050: Using member 'System.Linq.Expressions.Expression`1<TDelegate>.Compile()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. Compiling a lambda requires dynamic code.
```

Execute o binário:

```text
Unhandled exception. System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
```

Esta é a versão canônica do erro. O mesmo formato se aplica seja o infrator seu próprio código, um pacote NuGet ou uma peça do framework trazida transitivamente.

## A correção, em detalhe

As correções abaixo estão ordenadas da mais barata para a mais invasiva. Pegue a primeira que compilar.

### 1. Substituir a API por uma alternativa compatível com AOT (preferida)

Quase toda API problemática agora tem uma substituição amigável a AOT que o time do .NET lançou especificamente por causa dessa classe de exceção.

| Hostil ao AOT | Substituição amigável ao AOT |
|---|---|
| `Newtonsoft.Json` | `System.Text.Json` com um contexto gerador de código-fonte `[JsonSerializable]` |
| `AutoMapper` (compilado por expressão) | Mappers gerados por código-fonte (modo source-generator do Mapster, Riok.Mapperly, `MapTo`) |
| `MediatR` (registro de genéricos abertos) | Interfaces de handler escritas à mão, ou `Mediator` (o de gerador de código-fonte) |
| `Microsoft.AspNetCore.Mvc.Controllers` | `WebApplication.CreateSlimBuilder` + minimal APIs com `JsonSerializerContext` |
| Modelo de EF Core construído em runtime | `OptimizeQuery` / `dotnet ef dbcontext optimize` para pré-gerar o modelo |
| Interceptores de `Castle.DynamicProxy` | Decoradores gerados por código-fonte (por exemplo via Roslyn ou PolySharp) |
| `Expression<T>.Compile()` | `delegate*<...>`, um literal `Func<...>`, ou uma substituição de `IL` escrita à mão e compilada em build |

Exemplo concreto, substituindo a chamada de compilação de lambda:

```csharp
// .NET 11, C# 14
// Before: AOT-hostile
Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();

// After: pure delegate, no expression tree, no Compile()
Func<int, int> compiled = x => x + 1;
```

Se você genuinamente precisa do formato da árvore de expressão (porque está inspecionando o corpo), mantenha a árvore, mas pare de chamar `Compile()` e mude o consumidor para um `delegate` que você escreveu à mão.

### 2. Use `RuntimeFeature.IsDynamicCodeSupported` como feature switch

Se o caminho dinâmico é opcional, coloque-o atrás da flag de característica de runtime e envie um fallback lento mas seguro para AOT:

```csharp
// .NET 11, C# 14
using System.Runtime.CompilerServices;

public static T Materialize<T>(IDataReader reader)
{
    if (RuntimeFeature.IsDynamicCodeSupported)
    {
        return EmitMaterializer<T>.Compile()(reader);   // existing fast path
    }

    return ReflectionMaterializer<T>.Materialize(reader); // slower but no IL emit
}
```

O compilador AOT avalia estaticamente `IsDynamicCodeSupported` como `false` para o binário publicado e poda toda a ramificação dinâmica fora, incluindo `EmitMaterializer<T>`. Sem mais IL3050, sem mais lançamento em runtime. Importante: o analisador só poda quando o teste é a leitura literal da propriedade; não atribua a uma variável local antes nem encapsule em um método, ou o trimmer manterá a ramificação morta.

### 3. Pré-instancie genéricos que o compilador não consegue ver

Se a mensagem nomeia `MakeGenericType` ou `MakeGenericMethod`, o compilador AOT não sabe qual `T` construir. Duas saídas:

```csharp
// .NET 11, C# 14
// Tell the AOT compiler exactly which generic instantiations to keep.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]
public class Repository<T> { /* ... */ }

// And in your DI bootstrap, use closed generics:
services.AddScoped<Repository<User>>();
services.AddScoped<Repository<Order>>();
// not: services.AddScoped(typeof(Repository<>));
```

Ou, para uma chamada puramente reflexiva, troque para o equivalente gerado por código-fonte. O ASP.NET Core 11 envia sobrecargas seguras para AOT para os formatos comuns de injeção de dependência; o time do runtime também adicionou intrínsecos `Activator.CreateInstance<T>()` amigáveis ao AOT para construtores sem parâmetros.

### 4. Marque o método como `RequiresDynamicCode` e pare de chamá-lo a partir de caminhos AOT

Se você está escrevendo uma biblioteca e um método genuinamente precisa de codegen dinâmico, propague a exigência para os seus chamadores para que o analisador possa avisar no nível deles:

```csharp
// .NET 11, C# 14
[RequiresDynamicCode("Builds a per-type accessor with Reflection.Emit. " +
                     "Not supported in Native AOT. Use SourceGenAccessor<T> instead.")]
public static Func<object, object> BuildGetter(PropertyInfo prop) => /* emit */;
```

O atributo não corrige a exceção em runtime, mas converte a quebra silenciosa em um IL3050 em build, que é o contrato que os consumidores de Native AOT esperam.

### 5. Remova a dependência

Último recurso. Se uma biblioteca da qual você depende tem `Reflection.Emit` hardcoded e não oferece modo AOT, as únicas opções honestas são (a) substituir a biblioteca, (b) manter aquele subsistema em uma fronteira de processo não-AOT (um worker publicado com JIT atrás de uma fronteira HTTP ou de named pipe), ou (c) esperar o mantenedor upstream lançar um caminho AOT. Não tape a exceção com um `try/catch`; o programa fica então em um estado indefinido porque o consumidor quase certamente depende da operação que falhou.

## Variantes e parecidos comuns

- **`PlatformNotSupportedException: System.Reflection.Emit.DynamicMethod` a partir de `System.Linq.Expressions`.** Mesma causa raiz que Compile(), costuma aparecer dentro de provedores `Queryable` e conversores JSON. Procure no log de publicação a linha IL3050 que nomeia o método originador. Se você chegou aqui a partir de um serializador JSON, veja [nosso passo a passo sobre como escrever conversores System.Text.Json seguros para AOT](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- **`PlatformNotSupportedException: Operation is not supported on this platform` a partir de `Assembly.Load(byte[])`.** Native AOT não permite carregar assemblies gerenciados adicionais em runtime. Não há fallback. Mova o carregamento de plugins para um host não-AOT.
- **`PlatformNotSupportedException: Cannot emit a dynamic assembly.` a partir de `Castle.DynamicProxy`.** O Castle não tem caminho AOT a partir da 5.x; substitua a interceptação por decoradores gerados por código-fonte ou tire o serviço com proxy do binário AOT.
- **`NotSupportedException: BinaryFormatter serialization and deserialization are disabled.`** Tipo de exceção diferente, mas o mesmo tema geral de "removido do binário AOT". Não troque para um `try/catch` em volta; reescreva a serialização para System.Text.Json.
- **`PlatformNotSupportedException: ... requires the JIT.`** Esta é a mensagem que você vê em alvos do interpretador do Mono (iOS, watchOS, MAUI Catalyst) quando o interpretador também está desligado. A superfície de correção é a mesma do Native AOT: pré-construa o genérico, troque para um gerador de código-fonte ou coloque o caminho atrás de um feature switch.
- **O erro aparece somente em uma única plataforma.** Alguns pacotes enviam um ativo de runtime NuGet por RID. A build de `linux-x64` pode compilar com `Reflection.Emit` desabilitado, enquanto a `win-x64` funciona. Sempre teste a publicação em cada RID que você envia.

## Verificando que você realmente corrigiu

Três checagens antes de cantar vitória:

1. `dotnet publish -r <rid> -c Release` não produz nenhum aviso `IL3050`. Promova-os a erros com `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` e `<IsAotCompatible>true</IsAotCompatible>`.
2. O binário publicado executa o caminho antes falho sob `DOTNET_TieredCompilation=0` e `DOTNET_ReadyToRun=0`. Native AOT não honra essas variáveis, mas as variáveis de ambiente são uma forma rápida de confirmar que você não está acidentalmente testando uma build JIT autocontida.
3. A tabela de imports do binário publicado não contém nenhuma referência ao JIT (`clrjit.dll` / `libclrjit.so`). No Linux, `nm --dynamic` no binário não deve mostrar símbolos `clrjit`.

Se as três passarem, você tem um binário limpo para AOT e a exceção não vai voltar pelo mesmo caminho.

## Relacionado

- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) percorre o caminho completo de publicação e a superfície do aviso IL3050 para um serviço web típico.
- [Como reduzir o tempo de cold-start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) é o motivo pelo qual a maioria dos times recorre a Native AOT em primeiro lugar.
- [Como escrever um JsonConverter customizado em System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) é a substituição segura para AOT quando você ficou tentado a entregar metadados reflexivos para um `JsonSerializer`.
- [Como escrever um gerador de código-fonte para INotifyPropertyChanged](/pt-br/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) é o padrão que você usa sempre que uma biblioteca existente quer fazer `Reflection.Emit` por você.
- [Rider 2026.1 traz um visualizador de ASM que decodifica saída de JIT e Native AOT](/pt-br/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) é útil quando você quer confirmar que o trimmer realmente removeu a ramificação dinâmica.

## Fontes

- [Native AOT deployment overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [IL3050: Avoid calling members annotated with RequiresDynamicCodeAttribute when publishing as Native AOT, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/warnings/il3050)
- [Introduction to AOT warnings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/fixing-warnings)
- [Intrinsic APIs marked RequiresDynamicCode, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/intrinsic-requiresdynamiccode-apis)
- [How to make libraries compatible with Native AOT, .NET Blog](https://devblogs.microsoft.com/dotnet/creating-aot-compatible-libraries/)
- [AOT with Reflection, dotnet/runtime discussion #95244](https://github.com/dotnet/runtime/discussions/95244)
- [RuntimeFeature.IsDynamicCodeSupported, .NET API browser](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimefeature.isdynamiccodesupported)
