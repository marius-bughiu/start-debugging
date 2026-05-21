---
title: "Cursor 3.4 añade entornos multirepositorio y compilaciones Dockerfile más rápidas para agentes en la nube"
description: "Cursor 3.4 (13 de mayo de 2026) permite que un mismo entorno de agente en la nube incluya varios repositorios, añade secretos de compilación para Dockerfile, recompilaciones con caché de capas un 70% más rápidas y un paso de configuración guiado por el agente que valida las credenciales antes de la primera ejecución."
pubDate: 2026-05-21
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "docker"
lang: "es"
translationOf: "2026/05/cursor-3-4-multi-repo-cloud-agent-environments"
translatedBy: "claude"
translationDate: 2026-05-21
---

El 13 de mayo de 2026, Cursor lanzó la [versión 3.4](https://cursor.com/changelog), y la entrega trata sobre todo de la fontanería que las flotas de agentes en la nube necesitan para trabajar de verdad. El titular son los entornos multirepositorio, pero los cambios de secretos de compilación y caché de capas que están por debajo son los que hacen que ejecutar muchos agentes en paralelo sea lo bastante barato como para ser práctico. Es una continuación directa del trabajo de paralelismo de [Cursor 3.3](/es/2026/05/cursor-3-3-build-in-parallel-split-prs/), pensada para equipos que ya reparten tareas entre subagentes y chocaban con el muro de "un repo por entorno".

## Un entorno, muchos repositorios

Hasta 3.4, el entorno de un agente en la nube estaba acotado a un único repositorio. Eso se rompía en cuanto una tarea cruzaba límites: una API de backend más su paquete de tipos compartidos, una app de Flutter más un servidor en Dart, o una solución de `.NET` más un repo de infraestructura hermano. O clonabas los repos extra manualmente en el script de configuración (lento y frágil) o dividías la tarea y perdías el contexto entre repos.

Cursor 3.4 reutiliza la maquinaria de los workspaces multi-root y deja que listes cada repositorio que el agente necesita como parte de la definición del entorno. Una configuración típica se ve así:

```json
{
  "name": "api-and-shared-types",
  "repositories": [
    { "url": "github.com/acme/api", "branch": "main" },
    { "url": "github.com/acme/shared-types", "branch": "main" }
  ],
  "dockerfile": "./infra/agent.Dockerfile"
}
```

Ambos repos se clonan en el mismo entorno, y el agente los ve como un único workspace. Las sesiones reutilizan el entorno, así que levantar un nuevo agente contra el mismo par es un acierto de caché en lugar de un clon desde cero.

## Secretos de compilación y aciertos de caché un 70% más rápidos

La ruta del Dockerfile también recibió dos arreglos prácticos. El primero es `--mount=type=secret` para secretos de compilación que se quedan fuera del contenedor en ejecución:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:9.0
RUN --mount=type=secret,id=nuget_pat \
    dotnet nuget add source https://nuget.pkg.github.com/acme/index.json \
      --name acme --username ci \
      --password "$(cat /run/secrets/nuget_pat)" --store-password-in-clear-text
COPY . /src
WORKDIR /src
RUN dotnet restore
```

El PAT está acotado al paso de compilación, así que el proceso del agente que se ejecuta después no puede leerlo. Eso cierra el agujero por el que antes los feeds privados de paquetes implicaban incrustar credenciales en la imagen o en el script del entorno.

El segundo arreglo es el caché de capas. Las compilaciones que aciertan en caché son un 70% más rápidas, según las notas de la versión, porque sólo se recompilan las capas modificadas cuando editas el Dockerfile. En la práctica, iterar sobre la línea `RUN apt-get install ...` ya no invalida un `dotnet restore` largo que esté debajo, siempre que la capa del restore esté por encima del cambio.

## La configuración guiada por el agente detecta credenciales faltantes antes de la ejecución

Cuando creas o actualizas un entorno, Cursor ejecuta ahora un paso de configuración que hace preguntas aclaratorias, identifica credenciales faltantes y verifica que la compilación tiene éxito antes de dejar que un agente lo use. Si la compilación falla, el entorno cae a una imagen base y muestra la advertencia en lugar de fallar en silencio en el momento en que un agente intenta clonar.

Cada entorno también guarda un historial de versiones con rollback restringido a admins y un registro de auditoría de quién cambió qué. Para los equipos que ya ejecutan agentes paralelizados a escala, esas barandillas importan más que las ganancias de velocidad.

Consulta el [changelog completo de Cursor](https://cursor.com/changelog) para el resto de 3.4.
