---
title: "Resolva o erro do Xamarin: Csc.exe exited with code -1073741790. (MSB6006)"
description: "Resolva o erro MSB6006 do Csc.exe no Xamarin executando como Administrador ou limpando as pastas bin e obj da solução."
pubDate: 2015-08-28
updatedDate: 2023-11-05
tags:
  - "xamarin"
lang: "pt-br"
translationOf: "2015/08/fix-xamarin-error-csc-exe-exited-with-code-1073741790-msb6006"
translatedBy: "claude"
translationDate: 2026-05-01
---
Basta executar o Xamarin Studio como Administrador.

O erro geralmente significa que o processo não consegue acessar um determinado recurso. No meu caso, isso era falta de permissões; mas também pode significar que algum arquivo já está em uso. Nesse caso, faça Clean na solução e Rebuild, e se isso também não funcionar, faça uma limpeza manual da solução apagando as pastas "bin" e "obj" de cada projeto.
