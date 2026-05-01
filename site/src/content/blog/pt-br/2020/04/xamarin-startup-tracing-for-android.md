---
title: "Startup Tracing no Xamarin para Android"
description: "Melhore o tempo de inicialização do seu app Xamarin Android em até 48% usando startup tracing, que compila AOT apenas o código necessário na inicialização."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "android"
  - "xamarin"
lang: "pt-br"
translationOf: "2020/04/xamarin-startup-tracing-for-android"
translatedBy: "claude"
translationDate: 2026-05-01
---
O tempo de inicialização do seu app importa porque é a primeira impressão que o usuário tem do desempenho dele. Não importa o que você me prometer se levar 10 segundos para carregar o app toda vez que eu tentar usá-lo. Posso até desinstalar pensando que ele não funciona de verdade. E no Xamarin Android esse tem sido um tema quente ao longo do tempo. Agora o time decidiu atacar o problema de forma um pouco mais agressiva, introduzindo o startup tracing.

## O que é startup tracing?

Basicamente significa que parte dos seus assemblies será compilada ahead-of-time (AOT) em vez de just-in-time (JIT), reduzindo assim a sobrecarga ao executar o código, mas aumentando o tamanho do APK.

Em particular, o startup tracing aplica AOT apenas no que o seu app precisa na inicialização, com base em um perfil personalizado do app. Isso significa que o aumento do APK será mínimo, enquanto o impacto positivo é maximizado.

Alguns números divulgados pela equipe do Xamarin:

| Tipo | Tempo de inicialização | Tamanho do APK |
| --- | --- | --- |
| Normal | 2914 ms | 16.1 MB |
| AOT | 1180 ms (-59%) | 34.6 MB (+115%) |
| Startup Tracing | 1518 ms (-48%) | 20.1 MB (+25%) |

## Ativando o startup tracing

Ativar é simples: vá até as configurações do seu projeto Xamarin Android (clique com o botão direito > Properties) e marque "Enable Startup Tracing" em "Code Generation and Runtime", como mostrado na imagem abaixo.

![](/wp-content/uploads/2020/04/Annotation-2020-04-04-122649-3.png)
