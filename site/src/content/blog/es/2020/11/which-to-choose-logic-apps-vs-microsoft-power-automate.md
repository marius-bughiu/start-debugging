---
title: "Cuál elegir: Logic Apps frente a Microsoft Power Automate"
description: "Compara Azure Logic Apps y Microsoft Power Automate para determinar qué servicio de automatización de flujos de trabajo se adapta mejor a tu caso de uso."
pubDate: 2020-11-18
tags:
  - "azure"
  - "logic-apps"
  - "microsoft-power-automate"
lang: "es"
translationOf: "2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ambos son tecnologías "design-first", es decir, ofrecen interfaces de usuario que te permiten dibujar tus flujos de trabajo en lugar de programarlos. Otras similitudes entre ambos:

-   Pueden aceptar entradas
-   Pueden ejecutar acciones
-   Pueden controlar el flujo de trabajo mediante condiciones
-   Pueden producir salidas

## Logic Apps

Logic Apps es un servicio de Azure que puedes usar para automatizar, orquestar e integrar componentes dispares de una aplicación distribuida. A través de Logic Apps puedes dibujar flujos de trabajo complejos que modelan procesos de negocio complejos.

Logic Apps también proporciona una vista de código que te permite crear y editar flujos de trabajo usando notación JSON.

Es ideal para proyectos de integración, ya que el servicio incluye cientos de conectores distintos para diferentes apps y servicios externos. Además, puedes crear tus propios conectores personalizados con facilidad.

## Microsoft Power Automate

Microsoft Power Automate es un servicio construido sobre Logic Apps, dirigido a personas sin experiencia en desarrollo o como IT Pro que desean crear flujos de trabajo. Puedes crear flujos complejos que integran muchos componentes diferentes usando el sitio web o la app móvil de Microsoft Power Automate.

Existen cuatro tipos distintos de flujos de trabajo:

-   **Automated**: un flujo iniciado por un trigger. Por ejemplo, el trigger podría ser la llegada de un nuevo tweet o la subida de un nuevo archivo.
-   **Button**: un flujo que se puede activar manualmente desde la aplicación móvil.
-   **Scheduled**: un flujo que se ejecuta de forma periódica.
-   **Business process**: un flujo que modela un proceso de negocio y puede incluir: notificación a las personas requeridas con su aprobación registrada; fechas de calendario para los pasos; y tiempo registrado de los pasos del flujo.

En cuanto a conectores, Microsoft Power Automate tiene exactamente los mismos conectores que Logic Apps, incluyendo la capacidad de crear y usar conectores personalizados.

## Diferencias

| | Microsoft Power Automate | Logic Apps |
| --- | --- | --- |
| **Usuarios objetivo** | Personal de oficina y analistas de negocio | Desarrolladores e IT pros |
| **Escenarios objetivo** | Creación autónoma de flujos | Proyectos de integración avanzados |
| **Herramientas de diseño** | Solo GUI. Navegador y app móvil | Diseñador en navegador y Visual Studio. Es posible editar código usando JSON |
| **Application Lifecycle Management** | Power Automate incluye entornos de pruebas y producción | El código fuente de Logic Apps se puede incluir en Azure DevOps y sistemas de control de código fuente |

## Conclusiones

Los dos servicios son muy parecidos; la principal diferencia está en su público objetivo: Microsoft Power Automate apunta a personal no técnico y Logic Apps se inclina más hacia profesionales de IT, desarrolladores y practicantes de DevOps.
