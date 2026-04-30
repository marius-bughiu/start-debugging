---
title: "Flet en 2026: UI de Flutter, lógica en Python y los trade-offs que tienes que admitir desde el principio"
description: "Flet te permite construir UIs de Flutter con lógica en Python. Aquí están los trade-offs reales: latencia por la conversación de eventos, desajuste de ecosistema con los plugins de Dart y depuración con cerebro dividido, además de cuándo tiene sentido de verdad."
pubDate: 2026-01-10
tags:
  - "flutter"
  - "python"
lang: "es"
translationOf: "2026/01/flet-in-2026-flutter-ui-python-logic-and-the-trade-offs-you-need-to-admit-upfront"
translatedBy: "claude"
translationDate: 2026-04-30
---
Un hilo de r/FlutterDev volvió a poner sobre la mesa a Flet como "construir apps de Flutter en Python". No es una idea nueva, pero es persistente porque la motivación es real: muchos equipos tienen una experiencia profunda en Python y quieren una UI multiplataforma sin adoptar Dart desde el primer día.

Fuentes: el [hilo de Reddit](https://www.reddit.com/r/FlutterDev/comments/1q87a7j/flet_build_flutter_apps_in_python/) y [flet.dev](https://flet.dev/).

## Qué es Flet (y qué no es)

Flet no es "Python que compila a Flutter". El modelo común es:

-   Un front-end de Flutter que renderiza la UI.
-   Un runtime de Python que ejecuta la lógica de tu app.
-   Un protocolo que sincroniza eventos de UI y estado (a menudo JSON sobre WebSockets).

Esa distinción importa porque cambia la historia de rendimiento y depuración. En la práctica estás construyendo una app distribuida, aun cuando se ejecuta en tu laptop.

## Un ejemplo minúsculo que puedes ejecutar y razonar

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

Si eres desarrollador de Python, este es el gancho: obtienes una UI rápido y te mantienes en el ecosistema de Python para la lógica de negocio y las bibliotecas.

## Los trade-offs frente a escribir Flutter directamente (Dart 3.12, Flutter 3.x)

Pagas por la comodidad en lugares que importan en producción:

-   Latencia y conversación de eventos: las interacciones de UI se convierten en mensajes. Puede estar bien para formularios y dashboards, pero es un perfil distinto al de Flutter puro.
-   Desajuste de ecosistema: los plugins y paquetes de Flutter están diseñados para Dart. Puentear APIs nativas desde Python puede ser incómodo, especialmente en móvil.
-   Depuración con cerebro dividido: Flutter DevTools y el profiling a nivel de Dart no exponen automáticamente los cuellos de botella del lado de Python.

Nada de esto hace que Flet sea malo. Solo lo convierte en un producto distinto: UI renderizada por Flutter con semántica de Python.

## Cuándo elegiría Flet

-   Herramientas internas donde el tiempo hasta la primera UI es la principal restricción.
-   Targets de escritorio y web primero, móvil después.
-   Equipos con competencia fuerte en Python que necesitan una superficie de UI, no una cultura de ingeniería "Flutter-first".

Si estás construyendo una app móvil de consumo donde el timing de frames, la profundidad de plugins y la depuración nativa importan, sigo recurriendo a Flutter directamente. Flet es interesante porque baja la barrera de entrada, pero deberías ser explícito sobre qué estás cediendo.
