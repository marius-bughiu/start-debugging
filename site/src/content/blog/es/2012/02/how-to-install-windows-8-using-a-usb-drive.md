---
title: "Cómo instalar Windows 8 usando un USB"
description: "Guía paso a paso para instalar Windows 8 desde un USB usando la Windows 7 USB/DVD Download Tool, incluyendo consejos de formato, ajustes de BIOS y troubleshooting."
pubDate: 2012-02-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "es"
translationOf: "2012/02/how-to-install-windows-8-using-a-usb-drive"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para empezar necesitarás una imagen ISO de Windows 8 y también la Windows 7 USB / DVD Download Tool, que te ayudará a poner esa imagen en el USB. Puedes descargar ambas haciendo clic en sus respectivas imágenes abajo.

[![Windows 8 Developer Preview 64bit](https://lh6.googleusercontent.com/-mq-MQd8BRhI/TylZRYlL90I/AAAAAAAAADU/8EBFMLQqkiw/s257/Windows%25208%2520Developer%2520Preview%252064bit.PNG)](http://msdn.microsoft.com/en-us/windows/apps/br229516)

[![Windows USB Tool](https://lh3.googleusercontent.com/-RTG-V-mR--I/TylZRp6bKsI/AAAAAAAAADQ/CLxQ1-cwuis/s256/Windows%2520USB%2520DVD%2520Tool.PNG)](https://go.microsoft.com/fwlink/?LinkId=691209)

Instala la Windows 7 USB Tool una vez que termine la descarga. No te preocupes por el nombre, que dice Windows 7: funciona perfectamente con Windows 8 también.

Ahora que tienes todos los archivos necesarios, inserta tu USB en el PC, haz clic derecho y selecciona format. La mayoría de tutoriales que he visto dicen que hay que formatearlo a FAT32 o no funcionará -- aunque, cuando uso la herramienta para copiar los archivos de Windows al USB, la propia herramienta lo formatea a NTFS. Extraño, pero qué le vamos a hacer.

[![Windows Format Window](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)

Hazle un quick format como FAT32 y **¡no olvides hacer backup de tus datos!**

Una vez formateado el USB, abre la Windows 7 USB Tool, pulsa **Browse** y selecciona la imagen ISO que acabas de descargar.

[![Windows USB Tool Choose an ISO File](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)

Haz clic en **Next** y, en la siguiente pantalla, donde te pide elegir el tipo de medio, selecciona **USB device**. Como ves, también te dan la opción de escribir la imagen directamente a un DVD. Para este tutorial nos quedaremos con el USB.

[![Windows USB Tool Choose Media Type](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)

Elige el USB en el que quieres que la herramienta ponga los archivos de instalación y pulsa **Begin copying.**

[![Windows USB Tool Choose USB Drive](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)

La herramienta empezará entonces a copiar los archivos de instalación de Windows a tu USB.

[![Windows USB Tool Copying Files](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)

Cuando todo el proceso termine y si no has tenido errores, reinicia el PC, abre el menú de boot (F12 en mi caso, durante el POST) y selecciona el USB. Si el USB no aparece en esa lista, entra en la BIOS y asegúrate de que **Legacy USB Support** está **Enabled**.

**Notas:**

-   No puedes crear un USB booteable con Windows 64-bit si actualmente estás corriendo un sistema operativo de 32-bit. Necesitas tener un sistema operativo de 64-bit para crear un USB booteable con Windows 64-bit.
-   El USB tiene que ser lo suficientemente grande. 4 GB sirve para las versiones simples 32-bit y 64-bit, pero para la versión de 64-bit que incluye las developer tools necesitarás un USB de 8 GB, porque el tamaño de la ISO ya es de 4.7 GB.
-   Asegúrate de hacer backup de los datos del USB antes de formatearlo. Si no, se pierden. Además, elige con cuidado la partición en la que instalas el SO para no sobrescribir por error tu instalación actual de Windows, porque en ese caso también se perderán todos los datos.

Y una última cosa: publicado desde una instalación nueva de Windows 8. Para que sepas seguro que funciona.
