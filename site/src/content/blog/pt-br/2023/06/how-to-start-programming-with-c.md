---
title: "Como começar a programar com C#"
description: "Um guia para iniciantes sobre como começar a programar em C#, desde a configuração do Visual Studio até escrever seu primeiro programa e encontrar recursos de aprendizado."
pubDate: 2023-06-11
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/06/how-to-start-programming-with-c"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# é uma linguagem de programação moderna, de propósito geral e orientada a objetos, desenvolvida pela Microsoft. É amplamente utilizada para aplicações desktop no Windows, jogos (especialmente com a engine Unity) e desenvolvimento web por meio do framework ASP.NET.

C# é considerada amigável para iniciantes e é uma ótima linguagem para novos programadores. Abaixo exploramos alguns dos motivos pelos quais C# é considerada amigável para iniciantes:

-   **Sintaxe** -- a sintaxe de C# é clara, consistente e fácil de entender, o que é ideal para iniciantes. Além disso, se você conhece C# fica relativamente fácil aprender outras linguagens da família C (Java, C++).
-   **Linguagem fortemente tipada** -- por ser fortemente tipada, C# garante que você defina com qual tipo de dado está trabalhando, como inteiros ou strings. Isso pode levar a um código menos sujeito a erros.
-   **Suporte de IDE** -- C# tem um suporte robusto de IDE, com ferramentas como Visual Studio e Visual Studio Code oferecendo recursos como IntelliSense (autocompletar de código), depuração e várias outras utilidades, o que torna a experiência de programação fluida e gerenciável para iniciantes.
-   **Documentação abrangente e comunidade** -- a Microsoft oferece documentação detalhada para C#. Além disso, há uma comunidade grande e ativa de C# que pode ajudar a responder perguntas e resolver problemas que você venha a encontrar.
-   **Programação orientada a objetos** -- C# é fundamentalmente orientada a objetos. Aprender sobre classes, objetos, herança e polimorfismo é crítico para desenvolver software em larga escala e jogos, e C# é uma ótima linguagem para aprender esses conceitos.
-   **Ampla variedade de usos** -- aprender C# abre oportunidades para programar em uma ampla variedade de plataformas, incluindo aplicações Windows, sites com ASP.NET e desenvolvimento de jogos com Unity.
-   **Tratamento de erros** -- C# é boa em apontar erros no código. Foi projetada para parar de compilar assim que encontra erros, ajudando novos programadores a identificar e corrigir seus erros facilmente.

## Como começar

A primeira coisa a fazer é configurar seu ambiente. Você pode usar qualquer sistema operacional para escrever C# e também há várias opções de editores. Você pode até escrever e executar código C# no navegador, no celular ou no tablet, usando sites como [.NET Fiddle](https://dotnetfiddle.net/).

Um ambiente típico de desenvolvimento seria o Visual Studio rodando no Windows. O Visual Studio vem com uma edição Community gratuita que você pode [baixar aqui](https://visualstudio.microsoft.com/downloads/). Depois de baixar o instalador, siga o assistente com as cargas de trabalho padrão e, quando terminar, você deve ter tudo pronto para escrever seu primeiro programa em C#.

## Escrevendo sua primeira linha de código C#

Os arquivos de código C# são escritos e compilados como parte de um projeto. Vários projetos formam uma solução. Para começar, precisamos criar primeiro um **Novo Projeto**. Você pode usar as **Ações Rápidas** na página de **Boas-vindas** para criar um novo projeto C#.

[![](/wp-content/uploads/2023/06/image.png)](/wp-content/uploads/2023/06/image.png)

Ações rápidas no Visual Studio 2022, com Novo Projeto destacado.

Para começar de forma simples, vamos criar uma nova aplicação de console. Pesquise na lista de templates por 'console' e escolha o que tem o selo C# como indicado abaixo:

[![](/wp-content/uploads/2023/06/image-1.png)](/wp-content/uploads/2023/06/image-1.png)

Uma lista de templates de projeto no Visual Studio 2022, com o template de aplicação de console C# destacado.

Continue pelo assistente usando os valores padrão e você deve terminar em um estado parecido com este:

[![](/wp-content/uploads/2023/06/image-2.png)](/wp-content/uploads/2023/06/image-2.png)

Visual Studio 2022 mostrando uma nova aplicação de console C# usando instruções de nível superior.

À direita você tem o **Solution Explorer**, que mostra sua solução, seu projeto e seu arquivo de código: **Program.cs**. A extensão de arquivo: **.cs** -- significa **CSharp** (C#). Todos os seus arquivos de código C# terão a mesma extensão.

No centro do editor você tem este arquivo **Program.cs** aberto. O arquivo contém duas linhas de código.

-   **Linha 1**: esta linha representa um comentário em C#. Tudo o que é escrito após `//` na mesma linha é um comentário e é ignorado pelo compilador, não sendo executado quando você roda o programa. Comentários são usados para explicar o código e são especialmente úteis para lembrar você mesmo e outros sobre o propósito e os detalhes do código.
-   **Linha 2**: Esta linha de código escreve a string "Hello, World!" no console e em seguida termina a linha atual.
    -   `Console` é uma classe estática no namespace `System`, representando os fluxos padrão de entrada, saída e erro para aplicações de console. Essa classe é mais usada para ler e escrever no console.
    -   `WriteLine` é um método da classe `Console`. Esse método escreve uma linha no fluxo de saída padrão, que normalmente é o console. A linha a ser escrita é passada como argumento para o método. Nesse caso, é a string "Hello, World!".
    -   O ponto e vírgula `;` no final da linha indica o fim da instrução, semelhante ao ponto final no fim de uma frase em português.

A seguir, vamos rodar o programa e ver o que ele produz. Para compilar e executar o programa, você pode usar o botão Run na barra de ferramentas ou simplesmente pressionar **F5**.

[![](/wp-content/uploads/2023/06/image-3.png)](/wp-content/uploads/2023/06/image-3.png)

Uma barra de ferramentas no Visual Studio 2022, com o botão Run destacado.

O Visual Studio primeiro compilará seu projeto e depois o executará. Por se tratar de uma aplicação de console, uma janela de console aparecerá, com a mensagem "Hello, World!" na primeira linha.

[![](/wp-content/uploads/2023/06/image-4.png)](/wp-content/uploads/2023/06/image-4.png)

Uma janela de console exibindo "Hello, World!".

## Recursos de aprendizado

Agora que seu ambiente está configurado corretamente e você executou seu primeiro programa em C#, é hora de começar a aprender mais sobre a linguagem. Para isso, há vários recursos ótimos disponíveis para começar. Listamos alguns abaixo:

-   [Microsoft Learn](https://dotnet.microsoft.com/en-us/learn/csharp) -- a plataforma oficial da Microsoft oferece diversas trilhas de aprendizado, módulos e tutoriais gratuitos de C#. É um ótimo recurso para aprender C# direto da fonte.
-   [Codecademy](https://www.codecademy.com/learn/learn-c-sharp) -- a Codecademy oferece lições interativas e projetos que podem ajudá-lo a aprender C#. É amigável para iniciantes e a natureza interativa do aprendizado é altamente eficaz para muitos estudantes.
-   [Coursera](https://www.coursera.org/courses?query=c%20sharp) -- o Coursera oferece cursos de universidades e empresas. A especialização C# Programming for Unity Game Development da Universidade do Colorado é um bom curso se você se interessa por desenvolvimento de jogos.
-   [Pluralsight](https://www.pluralsight.com/browse/software-development/c-sharp) -- o Pluralsight tem uma biblioteca abrangente de cursos de C# cobrindo tópicos do iniciante ao avançado. É uma plataforma paga, mas oferece um teste gratuito.
-   [Udemy](https://www.udemy.com/topic/c-sharp/) -- o Udemy tem uma ampla variedade de cursos de C# para diferentes níveis e usos, incluindo desenvolvimento web com ASP.NET, desenvolvimento de jogos com Unity etc. Espere as promoções frequentes para conseguir um bom preço.
-   [LeetCode](https://leetcode.com/) -- o LeetCode é uma plataforma de resolução de problemas onde você pode praticar programando em C#. Não é um site de tutoriais, mas é inestimável para praticar e melhorar suas habilidades depois que você aprende o básico.
