---
title: "Flet em 2026: UI Flutter, lógica em Python e os trade-offs que você precisa admitir de cara"
description: "O Flet permite construir UIs Flutter com lógica em Python. Aqui estão os trade-offs reais: latência por conversa de eventos, descasamento de ecossistema com plugins Dart e depuração com cérebro dividido, mais quando faz sentido de verdade."
pubDate: 2026-01-10
tags:
  - "flutter"
  - "python"
lang: "pt-br"
translationOf: "2026/01/flet-in-2026-flutter-ui-python-logic-and-the-trade-offs-you-need-to-admit-upfront"
translatedBy: "claude"
translationDate: 2026-04-30
---
Uma thread no r/FlutterDev trouxe o Flet de volta como "construir apps Flutter em Python". Não é uma ideia nova, mas é persistente porque a motivação é real: muitos times têm expertise profunda em Python e querem uma UI multiplataforma sem adotar Dart já de cara.

Fontes: a [thread do Reddit](https://www.reddit.com/r/FlutterDev/comments/1q87a7j/flet_build_flutter_apps_in_python/) e [flet.dev](https://flet.dev/).

## O que o Flet é (e o que não é)

Flet não é "Python que compila para Flutter". O modelo comum é:

-   Um front-end Flutter que renderiza a UI.
-   Um runtime Python que executa a lógica do seu app.
-   Um protocolo que sincroniza eventos de UI e estado (frequentemente JSON sobre WebSockets).

Essa distinção importa porque muda a história de desempenho e depuração. Você está, na prática, construindo um app distribuído, mesmo quando ele roda no seu notebook.

## Um exemplo minúsculo que você pode rodar e raciocinar

```python
import flet as ft

def main(page: ft.Page):
    page.title = "Start Debugging: Flet demo"

    name = ft.TextField(label="Name")
    out = ft.Text()

    def greet(e):
        out.value = f"Hello, {name.value}"
        page.update()

    page.add(name, ft.ElevatedButton("Greet", on_click=greet), out)

ft.app(main)
```

Se você é desenvolvedor Python, esse é o gancho: você obtém uma UI rápido e fica no ecossistema Python para lógica de negócio e bibliotecas.

## Os trade-offs em relação a escrever Flutter direto (Dart 3.12, Flutter 3.x)

Você paga pela conveniência em lugares que importam em produção:

-   Latência e conversa de eventos: interações de UI viram mensagens. Pode ser ok para formulários e dashboards, mas é um perfil diferente do Flutter puro.
-   Descasamento de ecossistema: plugins e pacotes Flutter são desenhados para Dart. Fazer ponte para APIs nativas a partir de Python pode ser desconfortável, especialmente em mobile.
-   Depuração com cérebro dividido: o Flutter DevTools e o profiling em nível Dart não expõem automaticamente gargalos do lado Python.

Nada disso torna o Flet ruim. Só o torna um produto diferente: UI renderizada por Flutter com semântica Python.

## Quando eu escolheria o Flet

-   Ferramentas internas em que tempo até a primeira UI é a principal restrição.
-   Alvos de desktop e web primeiro, mobile depois.
-   Times com forte competência em Python que precisam de uma superfície de UI, não uma cultura de engenharia "Flutter-first".

Se você está construindo um app mobile de consumo em que timing de frames, profundidade de plugins e depuração nativa importam, eu ainda vou direto de Flutter. O Flet é interessante porque baixa a barreira de entrada, mas você deve ser explícito sobre o que está abrindo mão.
