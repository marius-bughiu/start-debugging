---
title: "Azure MCP Server viene integrado en Visual Studio 2022 17.14.30, sin extensión requerida"
description: "Visual Studio 2022 17.14.30 integra el Azure MCP Server en el workload de desarrollo Azure. Copilot Chat puede alcanzar más de 230 herramientas Azure a través de 45 servicios sin instalar nada."
pubDate: 2026-04-22
tags:
  - "visual-studio"
  - "azure"
  - "mcp"
  - "github-copilot"
lang: "es"
translationOf: "2026/04/azure-mcp-server-visual-studio-2022-17-14-30"
translatedBy: "claude"
translationDate: 2026-04-24
---

El [post del blog de Visual Studio](https://devblogs.microsoft.com/visualstudio/azure-mcp-tools-now-ship-built-into-visual-studio-2022-no-extension-required/) del 15 de abril de 2026 enterró un cambio silencioso pero significativo: a partir de Visual Studio 2022 versión 17.14.30, el Azure MCP Server es parte del workload de desarrollo Azure. Sin extensión del marketplace, sin `mcp.json` manual, sin onboarding por máquina. Si tienes el workload instalado y has iniciado sesión tanto en GitHub como en Azure, Copilot Chat ya puede ver más de 230 herramientas Azure a través de 45 servicios.

## Por qué integrarlo

Hasta 17.14.30, llevar el Azure MCP Server frente a Copilot Chat en VS 2022 significaba una instalación separada, una config JSON por usuario, y un baile de reautenticación cada vez que el server lanzado por npx perdía su token. Empaquetar el server con el workload quita el paso de instalación y liga la auth al account picker de Azure existente del IDE, así que el mismo login que maneja Cloud Explorer maneja las herramientas MCP.

También lleva a VS 2022 a paridad con VS 2026, que ha incluido la integración Azure MCP desde noviembre de 2025.

## Encenderlo

El server viene con el workload pero está deshabilitado por defecto. Para activarlo:

1. Actualiza Visual Studio 2022 a 17.14.30 o superior (Help, Check for Updates).
2. Abre el Visual Studio Installer y confirma que el workload de desarrollo Azure está instalado.
3. Inicia sesión en tu cuenta de GitHub para que Copilot esté activo, luego inicia sesión en tu cuenta de Azure desde el account picker en la barra de título.
4. Abre Copilot Chat, haz clic en el ícono de llave inglesa etiquetado "Select tools," y activa "Azure MCP Server."

Después de eso el server arranca bajo demanda la primera vez que Copilot elige una herramienta Azure. Puedes verificarlo desde un prompt de chat:

```text
> #azmcp list resource groups in subscription Production
```

Copilot enrutará a través del server integrado y devolverá la lista en vivo, acotada a la cuenta con la que iniciaste sesión. El mismo diálogo de llave inglesa muestra las herramientas individuales para que puedas deshabilitar las ruidosas (por ejemplo, las de costo) sin deshabilitar el server completo.

## Qué obtienes realmente

El server integrado expone la misma superficie de herramientas documentada en [aka.ms/azmcp/docs](https://aka.ms/azmcp/docs), agrupadas en cuatro baldes:

- **Learn**: haz preguntas de forma de servicio ("qué tier de Azure SQL soporta private link con una replica serverless") sin salir del IDE.
- **Design and develop**: obtén snippets de config y llamadas SDK basadas en los recursos de tu subscription, no en samples genéricos.
- **Deploy**: provisiona resource groups, despliegues Bicep, y container apps desde el chat.
- **Troubleshoot**: trae queries de Application Insights, streams de log de App Service, y estado de pods AKS a la conversación.

Un chat como "el app service de staging está devolviendo 502, trae la última hora de fallos y dime qué cambió" ahora se ejecuta de extremo a extremo sin copy paste entre pestañas del portal.

## Cuándo el server standalone sigue teniendo sentido

El build integrado sigue la cadencia de servicing de VS, que va detrás de las releases upstream de `Azure.Mcp.Server`. Si necesitas una herramienta que aterrizó la semana pasada, registra el server standalone al lado del integrado en `mcp.json` y Copilot mergeará las listas de herramientas. Para todos los demás, borrar ese archivo de config es ahora la movida correcta.
