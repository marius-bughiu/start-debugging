---
title: "Aumente sua produtividade usando code snippets"
description: "Aprenda como os code snippets do Visual Studio podem aumentar sua produtividade ao permitir inserir trechos de código reutilizáveis com um alias curto."
pubDate: 2012-01-06
updatedDate: 2023-11-04
tags:
  - "csharp"
  - "visual-studio"
lang: "pt-br"
translationOf: "2012/01/improve-productivity-by-using-code-snippets"
translatedBy: "claude"
translationDate: 2026-05-01
---
Code snippets são uma ótima maneira de aumentar a produtividade, pois permitem definir trechos de código que depois você pode inserir nos seus projetos usando um alias curto.

Embora estejam no Visual Studio há bastante tempo, poucas pessoas sabem o que são, o que fazem exatamente e como usá-los a seu favor. Uma coisa é ouvir falar deles, outra é usá-los. Quase todos nós (que escrevemos código) já usamos pelo menos uma vez na vida, e o melhor exemplo que me vem à cabeça ao dizer isso é: foreach. Quantas vezes você já digitou foreach e pressionou TAB duas vezes para um código aparecer magicamente na posição do cursor? Pois é, isso é um code snippet! E tem muito mais de onde esse veio. Existem code snippets para coisas como definição de classe, constructors, destructors, structures, for, do-while etc., e a lista completa (para C#) está aqui: [Visual C# Default Code Snippets](http://msdn.microsoft.com/en-US/library/z41h7fat%28v=VS.100%29.aspx "Visual C# Default Code Snippets").

Mas esses são só uma pequena parte do que os code snippets oferecem -- são apenas os que vêm por padrão no Visual Studio. O bom mesmo é que você pode definir os seus próprios e usá-los para inserir código nos seus projetos onde e quando quiser. Vou tentar criar um tutorial simples sobre como criar seu próprio code snippet em algum momento na próxima semana; até lá [dê uma olhada nesta página](http://msdn.microsoft.com/en-us/library/ms165393.aspx "can check out this page").

Para quem procura alguns snippets gerais para somar aos já existentes, há um [bom projeto no codeplex](http://vssnippets.codeplex.com/ "C# Code Snippets") com exatamente 38 code snippets em C# prontos para adicionar à sua coleção. Adicioná-los ao Visual Studio é fácil: baixe o zip pelo link acima e extraia. Em seguida, vá em Tools -> Code Snippet Manager ou pressione Ctrl + K, Ctrl + B e clique em Import. Navegue até a pasta para onde você extraiu o zip, selecione todos os code snippets na pasta, clique em Open, escolha a pasta / categoria onde adicionar (por padrão My Code Snippets) e clique em finish. E pronto! Estão prontos para uso. Para testar e ver se funcionam, tente digitar task ou thread em algum lugar e pressionar TAB duas vezes -- o código deve ser inserido automaticamente.

Por enquanto é isso. Como prometido, na próxima semana vem o "como criar seus próprios code snippets" e talvez algo sobre snippet designers.
