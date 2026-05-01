---
title: "C# 12 Interceptors"
description: "Conheça os interceptors do C# 12, um recurso experimental do compilador no .NET 8 que permite substituir chamadas de método em tempo de compilação usando o atributo InterceptsLocation."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/10/c-12-interceptors"
translatedBy: "claude"
translationDate: 2026-05-01
---
Interceptors são um recurso experimental do compilador introduzido no .NET 8, ou seja, podem mudar ou ser removidos em uma versão futura do framework. Para ver o que mais tem de novo no .NET 8, dê uma olhada em [What's new in .NET 8](/2023/06/whats-new-in-net-8/).

Para habilitar o recurso, é preciso ligar uma feature flag adicionando `<Features>InterceptorsPreview</Features>` ao seu arquivo `.csproj`.

## O que é um interceptor?

Um interceptor é um método que pode substituir uma chamada a um método interceptável por uma chamada a si mesmo. O vínculo entre os dois métodos é feito de forma declarativa, com o atributo `InterceptsLocation`, e a substituição acontece durante o processo de compilação, sem que o runtime saiba de nada.

Interceptors podem ser combinados com source generators para alterar código existente, adicionando à compilação um novo código que substitui completamente o método interceptado.

## Primeiros passos

Antes de começar a usar interceptors, é preciso declarar o `InterceptsLocationAttribute` no projeto em que você pretende fazer a interceptação. Isso porque o recurso ainda está em preview e o atributo ainda não vem incluído no .NET 8.

Veja a implementação de referência:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int column)
        {
            
        }
    }
}
```

Agora vamos a um exemplo rápido. Começamos com um setup bem simples: uma classe `Foo` com um método `Interceptable` e algumas chamadas a esse método que vamos querer interceptar mais à frente.

```cs
var foo = new Foo();

foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(2); // "interceptable 2"
foo.Interceptable(1); // "interceptable 1"

class Foo
{
    public void Interceptable(int param)
    {
        Console.WriteLine($"interceptable {param}");
    }
}
```

Em seguida, fazemos a interceptação propriamente dita:

```cs
static class MyInterceptor
{
    [InterceptsLocation(@"C:\test\Program.cs", line: 5, column: 5)]
    public static void InterceptorA(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor A: {param}");
    }

    [InterceptsLocation(@"C:\test\Program.cs", line: 6, column: 5)]
    [InterceptsLocation(@"C:\test\Program.cs", line: 7, column: 5)]
    public static void InterceptorB(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor B: {param}");
    }
}
```

Atualize o caminho do arquivo (`C:\test\Program.cs`) com a localização do seu arquivo de código fonte interceptável. Ao terminar, rode tudo de novo e a saída das chamadas a `Interceptable(...)` deve mudar para isto:

```plaintext
interceptable 1
interceptor A: 1
interceptor B: 2
interceptor B: 1
```

Que magia negra foi essa? Vamos olhar alguns detalhes.

### Assinatura do método interceptor

A primeira coisa a notar é a assinatura do método interceptor: ele é um método de extensão cujo parâmetro `this` tem o mesmo tipo do dono do método interceptável.

```cs
public static void InterceptorA(this Foo foo, int param)
```

Essa é uma limitação da preview e será removida antes do recurso sair do preview.

### O parâmetro `filePath`

Representa o caminho para o arquivo de código fonte que precisa ser interceptado.

Ao usar o atributo em source generators, certifique-se de normalizar o caminho do arquivo aplicando a mesma transformação que o compilador faz:

```cs
string GetInterceptorFilePath(SyntaxTree tree, Compilation compilation)
{
    return compilation.Options.SourceReferenceResolver?.NormalizePath(tree.FilePath, baseFilePath: null) ?? tree.FilePath;
}
```

### `line` e `column`

São localizações 1-indexadas que apontam para o lugar exato onde o método interceptável é invocado.

No caso de `column`, a localização da chamada representa a posição da primeira letra do nome do método interceptável. Por exemplo:

-   para `foo.Interceptable(...)` seria a posição da letra `I`. Considerando nenhum espaço antes do código, daria `5`.
-   para `System.Console.WriteLine(...)` seria a posição da letra `W`. Considerando nenhum espaço antes do código, `column` seria `16`.

### Limitações

Interceptors só funcionam com métodos comuns. Por enquanto, não dá para interceptar construtores, propriedades ou funções locais, embora a lista de membros suportados possa mudar no futuro.
