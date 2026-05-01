---
title: "Migrando para o Xamarin Forms 3"
description: "Um guia rápido para migrar para o Xamarin Forms 3, incluindo erros comuns de build e como resolvê-los."
pubDate: 2018-04-07
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2018/04/upgrading-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Atualizar entre versões major do Xamarin costuma quebrar coisas e fazer projetos pararem de compilar por erros estranhos. Na inocência, a maioria dos devs encara esses erros como reais, tenta entender, tenta resolver, e quando falha, vai pro Google; quando, na maioria das vezes, o fix é fechar o Visual Studio, abrir de novo e fazer um clean build da solução. Vamos dar uma olhada no Xamarin Forms 3 (lembre-se que é uma versão pre-release, então isso talvez já esteja resolvido na release oficial).

Abra seu projeto existente ou crie um novo Master Detail usando .NET Standard. Compile e veja que ele roda. Agora, gerencie os pacotes NuGet da sua solução. Se estiver trabalhando com uma versão pre-release como eu, marque a opção "Include prerelease".

Selecione todos os pacotes e Update. Se tentar buildar agora, você provavelmente verá alguns erros sobre GenerateJavaStubs falhando e o parâmetro XamlFiles não suportado pela XamlGTask. Ignore-os, feche o Visual Studio (o VS pode lançar um erro sobre alguma task ser cancelada; ignore também), reabra o VS, limpe a solução e recompile -- sabe, como um verdadeiro dev.

Depois disso, se estiver com um projeto novo e compilando para Android, você vai receber o erro de Java max heap size.

Vá em Properties no seu projeto Android, escolha Android Options e clique em Advanced no fim. Em seguida, digite "1G" na opção Java Max Heap Size. Fico imaginando quando vão deixar isso como padrão em projetos novos...

Compile de novo e voilà! Está funcionando.
