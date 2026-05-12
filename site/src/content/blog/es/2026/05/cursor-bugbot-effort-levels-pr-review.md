---
title: "Cursor Bugbot incorpora niveles de esfuerzo Default, High y Custom"
description: "El 11 de mayo de 2026, Cursor lanzó los niveles de esfuerzo para Bugbot. Default encuentra 0.7 bugs por revisión, High lo eleva a 0.95 y Custom te permite describir en lenguaje natural cuándo se activa cada modo."
pubDate: 2026-05-12
tags:
  - "cursor"
  - "bugbot"
  - "ai-agents"
  - "pull-requests"
lang: "es"
translationOf: "2026/05/cursor-bugbot-effort-levels-pr-review"
translatedBy: "claude"
translationDate: 2026-05-12
---

El 11 de mayo de 2026, Cursor [lanzó los niveles de esfuerzo para Bugbot](https://cursor.com/changelog), el agente de revisión de PR que comenta en las pull requests abiertas contra los repos que vigila. Hasta ahora, cada revisión ejecutaba el mismo bucle con el mismo presupuesto. La nueva versión entrega a los admins de Teams y a los usuarios Individual con facturación por uso tres perillas: Default, High y Custom. Las cifras que Cursor publicó junto con la versión vale la pena fijarlas antes de hablar de cómo se configura.

## Default contra High, en bugs medidos por ejecución

Cursor reporta dos cifras concretas en la [entrada del changelog](https://cursor.com/changelog):

- **Default** promedia **0.7 bugs encontrados por revisión** y se describe como "optimizado para eficiencia y velocidad." Más del 79% de los problemas que marca se resuelven antes de que la PR se fusione, que es la parte que importa para la relación señal-ruido.
- **High** promedia **0.95 bugs encontrados por revisión**. Gasta más en tokens de razonamiento y tarda más por PR.

Eso es un 36% más de bugs por ejecución, pagado con latencia y tokens extra. Si vale la pena el intercambio es una pregunta sobre dónde se agrupan tus PR: un repo con una larga cola de regresiones sutiles es un problema distinto al de un repo donde la mayoría de los bugs son obvios en diez segundos de leer el diff. Cursor no está tomando esa decisión por ti, que es el sentido del tercer modo.

## Custom es un router en lenguaje natural

El modo Custom no te da un slider ni un esquema YAML. Escribes una instrucción corta y Bugbot la usa como prompt de enrutamiento para elegir Default o High por revisión. El patrón que Cursor sugiere en la [documentación de Bugbot](https://docs.cursor.com/en/bugbot) se parece más a una regla de triage que a un archivo de configuración:

```text
Use High effort for any PR that:
- touches files under src/billing/** or src/auth/**
- changes a database migration (paths matching db/migrations/**)
- modifies a public API surface (anything in src/api/v1/**)

Use Default effort for everything else, including
documentation, tests, and dependency bumps.
```

Pegas eso en el dashboard de Bugbot dentro de la configuración de esfuerzo de tu repo. En la siguiente PR, Bugbot lee los metadatos del diff, aplica la regla y elige un modo antes de iniciar la revisión. No hay paso de compilación ni `bugbot.yaml`. Si la regla es ambigua, Bugbot vuelve a Default.

## Dónde configurarlo

El esfuerzo vive a nivel de repositorio, no a nivel de usuario, así que un mismo repo no puede tener a un ingeniero en High y a otro en Default. El ajuste está en el dashboard de Bugbot en `cursor.com/dashboard/bugbot/<repo>`, bajo "Review effort." Los admins de Teams lo configuran de forma global para los repos de una organización. Los usuarios del plan Individual con facturación por uso ven el mismo panel para sus propios repos. Los planes Individual de tarifa plana no reciben selección de esfuerzo: ese cubo se queda en Default.

## Elegir un modo sin quemar el presupuesto

La lectura honesta es que **High no es un botón "hazlo más inteligente," es un botón "gasta más"**. Un 36% más de bugs por ejecución también implica aproximadamente un 36% más de tokens facturados contra tu tope de uso, y el golpe de latencia aparece de forma más dolorosa en las PR que quieres fusionar antes del almuerzo. Custom es el único modo que te permite mantener esa cuenta acotada: escribe una regla que apunte a las partes del código donde un bug omitido realmente te cuesta y deja el resto en Default. Si no puedes articular esa regla en tres líneas de español, probablemente no necesitas High en absoluto.

La versión llega junto con [las funciones de construcción en paralelo y división de PR de Cursor 3.3](/es/2026/05/cursor-3-3-build-in-parallel-split-prs/), que es el patrón más amplio: Cursor está desagregando sus agentes en perillas que puedes configurar por flujo de trabajo, no en un único default que tiene que agradar a todos.
