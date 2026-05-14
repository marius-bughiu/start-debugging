---
title: "Fix: A possible object cycle was detected"
description: "System.Text.Json se recusa a serializar grafos com referências circulares. Configure ReferenceHandler.IgnoreCycles, projete para um DTO, ou marque o ponteiro de volta com [JsonIgnore]. Preserve é último recurso."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/05/fix-possible-object-cycle-was-detected-system-text-json"
translatedBy: "claude"
translationDate: 2026-05-14
---

A solução: `System.Text.Json` se recusa a serializar qualquer grafo de objetos que retorne sobre si mesmo. Em uma entidade do EF Core com uma propriedade `Parent` e uma coleção `Children` que se referenciam mutuamente, o writer entra em loop infinito, atinge o guard de profundidade e lança a exceção. Configure `JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles` para uma correção de uma linha, marque o ponteiro de volta com `[JsonIgnore]` para uma permanente, ou projete a entidade para um DTO que simplesmente não tenha o ponteiro de volta. `ReferenceHandler.Preserve` funciona, mas muda o formato no fio para `$id`/`$ref`, o que raramente é o que um consumidor de API quer.

```text
System.Text.Json.JsonException: A possible object cycle was detected. This can either be due to a cycle or if the object depth is larger than the maximum allowed depth of 32. Consider using ReferenceHandler.Preserve on JsonSerializerOptions to support cycles. Path: $.Children.Parent.Children.Parent.Children.Parent...
   at System.Text.Json.ThrowHelper.ThrowJsonException_SerializerCycleDetected(Int32 maxDepth)
   at System.Text.Json.Serialization.JsonConverter`1.TryWrite(Utf8JsonWriter writer, T& value, JsonSerializerOptions options, WriteStack& state)
   at System.Text.Json.Serialization.Metadata.JsonTypeInfo`1.SerializeAsObject(Utf8JsonWriter writer, Object rootValue)
   at System.Text.Json.JsonSerializer.WriteString[TValue](TValue value, JsonTypeInfo jsonTypeInfo)
```

Este guia foi escrito contra .NET 11 preview 4 e `System.Text.Json` 11.0.0-preview.4. A mensagem da exceção não mudou desde que `System.Text.Json` adicionou detecção de ciclos no .NET 5, e `ReferenceHandler.IgnoreCycles` está disponível desde o .NET 6. O segmento `Path` na exceção é o caminho JSON em que o writer estava quando desistiu. Se o caminho é um padrão repetido como `$.Children.Parent.Children.Parent`, você tem um ciclo real. Se o caminho é uma descida reta como `$.Order.Customer.Address.Country.Region.Continent...`, você não tem um ciclo, você tem um grafo que é genuinamente mais profundo do que 32 níveis e precisa de `MaxDepth`, que é uma correção diferente.

## Por que o writer se recusa a seguir o loop

`System.Text.Json` serializa grafos como árvores. Um documento JSON é uma árvore por definição, não há sintaxe para "este nó é o mesmo que aquele nó ali". Então o writer percorre o grafo de objetos em profundidade e emite cada referência como um novo objeto aninhado. No momento em que uma propriedade aponta para um ancestral, o percurso não termina.

Para evitar que o processo rode até esgotar a pilha, o writer rastreia a profundidade atual e lança uma `JsonException` quando ela excede `JsonSerializerOptions.MaxDepth`, que por padrão é 64. A mensagem de erro padrão mistura dois casos (um ciclo real e uma árvore honestamente profunda) porque o writer não consegue distingui-los de dentro, ele só vê que está fundo demais. A dica `Consider using ReferenceHandler.Preserve` no final da mensagem é o melhor palpite do runtime. É correto que `Preserve` permitiria que a chamada tivesse sucesso, mas raramente é a correção certa para uma API. Projetar para um DTO ou quebrar o ponteiro de volta é.

O padrão no ASP.NET Core mudou no .NET 6 para que as `JsonOptions` do framework (usadas por minimal APIs e ações de controller) não troquem para `IgnoreCycles` automaticamente. Você opta explicitamente. O raciocínio foi que descartar ciclos silenciosamente esconde bugs no modelo de resposta, a resposta canônica é consertar o modelo.

## Uma reprodução mínima

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4, System.Text.Json 11.0.0-preview.4
public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Book> Books { get; set; } = new();
}

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var author = new Author { Id = 1, Name = "Carla" };
var book = new Book { Id = 1, Title = "Refactoring", Author = author };
author.Books.Add(book);

var json = JsonSerializer.Serialize(author); // throws
```

`author.Books[0].Author` é a mesma instância que `author`. O writer desce em `Books`, desce no primeiro `Book`, então desce no seu `Author`, encontra `Books` de novo, e entra em loop. O guard de 64 níveis de profundidade dispara antes do processo morrer.

A mesma forma aparece no momento em que você faz `Include` de uma propriedade de navegação no EF Core e retorna a entidade rastreada de um controller sem projetá-la. O EF Core corrige as propriedades de navegação para que o pai aponte para os filhos e os filhos apontem de volta para o pai. Esse é o comportamento certo para rastreamento de mudanças. É a forma errada para JSON.

## Solução, em detalhe

### 1. Projetar para um DTO

A resposta canônica é nunca serializar entidades do EF Core diretamente. Retorne um DTO que achate ou omita o ponteiro de volta:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public record AuthorDto(int Id, string Name, IReadOnlyList<BookDto> Books);
public record BookDto(int Id, string Title);

var dto = await db.Authors
    .Where(a => a.Id == 1)
    .Select(a => new AuthorDto(
        a.Id,
        a.Name,
        a.Books.Select(b => new BookDto(b.Id, b.Title)).ToList()))
    .FirstAsync();

var json = JsonSerializer.Serialize(dto); // works
```

Esta é a resposta que o time do .NET recomenda e é a resposta certa para qualquer API pública. O DTO é o que o consumidor realmente quer, a entidade é um tipo interno que por acaso tem os mesmos nomes de campos. Projetar na consulta do EF Core também torna o SQL menor, o banco de dados retorna apenas as colunas que o DTO precisa. Para mais contexto sobre o lado do EF Core deste padrão, o post [aquecer o modelo do EF Core antes da primeira consulta](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) cobre a mecânica de projeção com mais profundidade.

### 2. Configurar ReferenceHandler.IgnoreCycles globalmente

Se você precisar serializar uma entidade diretamente (um endpoint interno rápido, uma ferramenta admin, um dump de depuração), configure a opção uma vez no host:

```csharp
// .NET 11, C# 14, ASP.NET Core 11
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

Para controllers (System.Text.Json):

```csharp
// .NET 11, C# 14, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

`IgnoreCycles` escreve `null` sempre que o writer detecta que está prestes a revisitar uma instância já presente no ramo atual. O ciclo é quebrado, a chamada tem sucesso, e o consumidor recebe uma árvore. O custo é que `book.Author` será serializado como `null` mesmo estando claramente populado, o que pode ser confuso se o consumidor espera fidelidade de ida e volta.

`IgnoreCycles` foi adicionado no .NET 6 especificamente porque `Preserve` era um padrão disruptivo demais e `[JsonIgnore]` só resolve o problema caso a caso. Recorra a ele como a configuração global do serializador para caminhos de resposta somente leitura e deixe o modelo em paz.

### 3. Marcar o ponteiro de volta com [JsonIgnore]

Se o ponteiro de volta nunca é útil em JSON (o consumidor sempre conhece o pai porque acabou de pedi-lo), marque-o diretamente:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }

    [JsonIgnore]
    public Author Author { get; set; } = null!;
}
```

`[JsonIgnore]` remove a propriedade tanto do serializador quanto do desserializador para aquele tipo. O ciclo desaparece em tempo de compilação, nenhuma opção de runtime necessária. Esta é a correção certa para uma propriedade de navegação que existe apenas para rastreamento de mudanças e que nenhum consumidor de JSON precisa.

A contrapartida é que `Author` agora está invisível para a camada JSON em todo lugar. Se você tem um endpoint diferente que quer retornar um `Book` com seu `Author` aninhado, `[JsonIgnore]` é grosseiro demais e você deve projetar para um DTO no lugar.

### 4. ReferenceHandler.Preserve, quando você realmente precisa de ida e volta

Se seu cenário é interno-para-interno (um sistema de atores, um protocolo servidor-a-servidor, um snapshot que você lê de volta em outro processo .NET), `Preserve` é a opção que mantém o grafo intacto:

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.Preserve
};

var json = JsonSerializer.Serialize(author, options);
```

A saída ganha propriedades `$id` e `$ref`:

```json
{
  "$id": "1",
  "Id": 1,
  "Name": "Carla",
  "Books": {
    "$id": "2",
    "$values": [
      {
        "$id": "3",
        "Id": 1,
        "Title": "Refactoring",
        "Author": { "$ref": "1" }
      }
    ]
  }
}
```

`Preserve` **nunca** é a resposta certa para uma API REST pública. Clientes JavaScript, clientes móveis, Postman, todo gerador de código, todo validador Swagger esperam JSON puro. `$id` e `$ref` são uma convenção própria do System.Text.Json (originalmente do Newtonsoft), eles não são padrão. Navegadores não vão desempacotá-los. Se você não está desserializando do outro lado com `System.Text.Json` configurado com a mesma opção `Preserve`, não os emita.

O uso legítimo é servidor-a-servidor onde ambos os lados são .NET, você controla o contrato, e você genuinamente precisa que o grafo dê ida e volta sem duplicação.

### 5. Aumentar MaxDepth, mas apenas para árvores honestamente profundas

Se você inspecionou o caminho na exceção e não é um padrão repetido mas uma longa descida reta, seu grafo é genuinamente mais profundo do que 64 níveis:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    MaxDepth = 128
};
```

Isto é raro. A maioria dos domínios não tem árvores de 64 níveis de profundidade, e se o seu tem, você quase certamente quer fatiar ou paginar a resposta. Mas é o botão certo para coisas como estruturas de pastas recursivas, hierarquias organizacionais ou árvores de expressão onde a profundidade é dado, não bug.

**Não** aumente `MaxDepth` para "contornar" um ciclo. O guard de profundidade é a única coisa entre seu processo e um stack overflow.

## Formas comuns que produzem isto

### Propriedades de navegação do EF Core em uma entidade serializada

O caso de manual. `Order` tem `Customer`, `Customer` tem `List<Order> Orders`, e um `Include` popula ambos os lados. A correção é projetar para um DTO ou aplicar `[JsonIgnore]` no ponteiro de volta. Retornar entidades de um controller é a fonte individual mais comum desta exceção.

### Árvores auto-referenciantes

Uma `Category` com um `Parent` e `List<Category> Children`, populada por `Include` recursivos. O ciclo é `category.Children[0].Parent == category`. `IgnoreCycles` lida com isso de forma limpa porque o writer detecta o loop no ponteiro de volta e emite `null` ali.

### Tipos anônimos construídos a partir de LINQ

Uma projeção LINQ que se transforma em tipo anônimo dentro de um grafo geralmente é segura (tipos anônimos não têm ponteiros de volta). Mas uma projeção como `Select(a => new { a, Books = a.Books })` reintroduz a entidade e o ciclo está de volta. Inspecione o que você realmente escreveu, não o que você quis dizer.

### Um DTO que copiou as propriedades de navegação da sua fonte

Uma configuração de mapeamento que porta `Author Author` da entidade para o DTO derrota o propósito do DTO. Ou remova a propriedade do DTO, ou mude seu tipo para `AuthorDto` (um record em forma de folha sem ponteiro de volta).

### Um grafo mais profundo do que 32, com a antiga mensagem padrão

Antes do .NET 8, o `MaxDepth` padrão era 64 apenas quando não definido explicitamente; o caminho do gerador de código-fonte e alguns inicializadores legacy usavam 32. A mensagem da exceção tem "32" codificado em algumas versões antigas, e "64" ou seu valor customizado nas novas. Leia a exceção real, não os documentos, a versão do runtime determina o número.

## Variantes que parecem isto mas não são

### "The object or value could not be serialized. There was a recursive call detected."

Erro diferente, mesma família. Esta é a mensagem que o Newtonsoft.Json emite quando seu `ReferenceLoopHandling` é deixado no padrão `Error`. A correção no Newtonsoft é `ReferenceLoopHandling.Ignore` (o análogo de `IgnoreCycles`) ou `PreserveReferencesHandling.All` (o análogo de `Preserve`). Se você está no meio de uma migração, a [trilha de migração de Newtonsoft para System.Text.Json](/pt-br/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) é o mais próximo de um estudo de caso canônico; ambas as bibliotecas chegam à mesma forma de solução mas escrevem as opções de maneira diferente.

### "JsonException: The JSON value could not be converted to ..."

Exceção diferente, stack diferente. Essa é sobre parsear entrada que não combina com o tipo alvo. A exceção de ciclo é um problema do lado de escrita; a exceção de conversão é um problema do lado de leitura. O [guia de conversão de System.DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) é o texto canônico para a família do lado de leitura.

### "Self referencing loop detected for property ..."

Esta é a mensagem do Newtonsoft, palavra por palavra. Se você a vê em uma base de código de 2026 que pensava estar usando `System.Text.Json`, ainda há um serializador Newtonsoft conectado em algum lugar, normalmente uma chamada residual de `AddNewtonsoftJson()` no builder MVC. Procure no startup do host; o framework escolhe o formatter JSON registrado por último.

### "An item with the same key has already been added. Key: $id"

Este é o desserializador de `Preserve` falhando porque o mesmo `$id` aparece duas vezes na entrada. Ou o payload está malformado (dois objetos diferentes receberam o mesmo id) ou foi serializado com `Preserve` e então re-serializado através de um transformador que reescreveu os ids. A correção é no produtor, não no consumidor.

### "PossibleCycleDetected" de um render do Blazor

Camada completamente diferente. O motor de diffing do Blazor tem seu próprio guard de ciclos para parâmetros de componente; o tipo da exceção e a stack são diferentes. Não mude `JsonSerializerOptions` para corrigir um loop de render do Blazor.

## Trabalhando com o gerador de código-fonte

Ao usar a geração de código-fonte do `System.Text.Json`, as mesmas opções se aplicam. Configure `ReferenceHandler` nas `JsonSerializerOptions` que você passa ao contexto gerado, ou use o atributo `[JsonSourceGenerationOptions]` no tipo do contexto:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    ReferenceHandler = JsonKnownReferenceHandler.IgnoreCycles)]
[JsonSerializable(typeof(Author))]
public partial class ApiJsonContext : JsonSerializerContext { }
```

`JsonKnownReferenceHandler` é o enum amigável a atributos, ele mapeia para os mesmos handlers que `ReferenceHandler.IgnoreCycles` / `Preserve` em runtime. O post sobre [interceptors e a ergonomia do gerador de código-fonte do System.Text.Json](/pt-br/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) percorre a forma do registro do contexto que sobrevive ao trimming e à publicação AOT, a mesma forma se aplica aqui.

## Relacionados

Para a contraparte do lado de leitura desta exceção, veja a [correção de The JSON value could not be converted to System.DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/). O andaime geral para escrever seus próprios conversores que ignoram o tratamento de referência padrão vive no [walkthrough de JsonConverter customizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Se a entidade que você está serializando vem do EF Core 11 e você quer a história de ida e volta com o banco de dados, o [walkthrough do JSON contains do SQL Server 2025](/pt-br/2026/04/efcore-11-json-contains-sql-server-2025/) cobre como o tipo de coluna JSON lida com grafos na camada do banco de dados. Para o caso mais amplo de migrar uma base de código inteira para longe do `ReferenceLoopHandling` do Newtonsoft, a nota sobre [vstest removendo Newtonsoft.Json no .NET 11 preview 4](/pt-br/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) tem o playbook do próprio time do .NET.

## Fontes

- [Preserve references and handle circular references in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references), Microsoft Learn.
- [`JsonSerializerOptions.ReferenceHandler`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.referencehandler), Microsoft Learn.
- [`JsonSerializerOptions.MaxDepth`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.maxdepth), Microsoft Learn.
- [`JsonIgnoreAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignoreattribute), Microsoft Learn.
- [dotnet/runtime issue 30820: cycle detection in JSON serialization](https://github.com/dotnet/runtime/issues/30820), a discussão original de design que trouxe `Preserve` e depois `IgnoreCycles`.
