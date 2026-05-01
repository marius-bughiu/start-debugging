---
title: "Obter o stream de um Embedded Resource no .NET Core"
description: "Aprenda a obter o stream de um recurso embutido no .NET Core entendendo como o nome do recurso é formado e usando GetManifestResourceStream."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2020/11/get-embedded-resource-stream-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para obter um recurso embutido no .NET Core, primeiro precisamos entender como o nome do recurso é composto. Ele tem 3 elementos, todos unidos por pontos (`.`):

-   o namespace raiz
-   o namespace estendido ou de arquivo
-   o nome do arquivo

Vamos a um exemplo concreto. Temos um projeto (assembly) com namespace raiz `MyApp.Core`. Dentro do projeto, temos uma pasta + subpasta como `Assets` > `Images`. E dentro dela, temos um recurso embutido chamado `logo.png`. Neste caso:

-   namespace raiz: `MyApp.Core`
-   namespace estendido: `Assets.Images`
-   nome do arquivo: `logo.png`

Junte-os com `.` e você terá: `MyApp.Core.Assets.Images.logo.png`.

Uma vez que você sabe o identificador do recurso, só precisa de uma referência ao assembly que contém o recurso. Podemos obtê-la facilmente a partir de qualquer classe definida nesse assembly -- supondo que tenhamos uma classe `MyClass`:

```cs
typeof(MyClass).Assembly.GetManifestResourceStream("MyApp.Core.Assets.Images.logo.png")
```

## Obter a lista de todos os recursos embutidos em um assembly

Se você não encontra o recurso, normalmente é por um dos seguintes motivos:

-   você errou o identificador
-   você não marcou o arquivo como Embedded Resource
-   você está procurando no assembly errado

Para ajudar na depuração, você pode listar todos os recursos embutidos em um assembly e partir dali. Para isso:

```cs
typeof(MyClass).Assembly.GetManifestResourceNames()
```

Isso retorna um simples `string[]`, e você pode usá-lo facilmente na `Immediate Window` para depurar.
