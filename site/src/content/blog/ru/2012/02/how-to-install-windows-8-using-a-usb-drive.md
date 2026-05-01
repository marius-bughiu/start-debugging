---
title: "Как установить Windows 8 с USB-накопителя"
description: "Пошаговое руководство по установке Windows 8 с USB-накопителя с помощью Windows 7 USB/DVD Download Tool: советы по форматированию, настройкам BIOS и устранению неполадок."
pubDate: 2012-02-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "ru"
translationOf: "2012/02/how-to-install-windows-8-using-a-usb-drive"
translatedBy: "claude"
translationDate: 2026-05-01
---
Для начала вам понадобится ISO-образ Windows 8 и Windows 7 USB / DVD Download Tool, которая поможет записать этот образ на USB-накопитель. Скачать обе вещи можно по соответствующим картинкам ниже.

[![Windows 8 Developer Preview 64bit](https://lh6.googleusercontent.com/-mq-MQd8BRhI/TylZRYlL90I/AAAAAAAAADU/8EBFMLQqkiw/s257/Windows%25208%2520Developer%2520Preview%252064bit.PNG)](http://msdn.microsoft.com/en-us/windows/apps/br229516)

[![Windows USB Tool](https://lh3.googleusercontent.com/-RTG-V-mR--I/TylZRp6bKsI/AAAAAAAAADQ/CLxQ1-cwuis/s256/Windows%2520USB%2520DVD%2520Tool.PNG)](https://go.microsoft.com/fwlink/?LinkId=691209)

После скачивания установите Windows 7 USB Tool. Не смущайтесь словом "Windows 7" в названии - с Windows 8 она тоже работает прекрасно.

Когда нужные файлы у вас есть, вставьте USB-накопитель в ПК, кликните по нему правой кнопкой и выберите format. Большинство туториалов, которые я видел, советуют форматировать в FAT32, иначе ничего не заработает - хотя, когда я пользуюсь утилитой для копирования файлов Windows на USB, она сама форматирует диск в NTFS. Странно, но ок.

[![Windows Format Window](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)

Сделайте quick format в FAT32 и **не забудьте сделать backup ваших данных!**

После того как USB отформатирован, откройте Windows 7 USB Tool, нажмите **Browse** и выберите только что скачанный ISO-образ.

[![Windows USB Tool Choose an ISO File](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)

Нажмите **Next**, на следующем экране, где предлагается выбрать тип носителя, выберите **USB device**. Как видите, есть и опция записать образ напрямую на DVD. В этом how-to остановимся на USB.

[![Windows USB Tool Choose Media Type](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)

Выберите USB-устройство, на которое нужно записать установочные файлы, и нажмите **Begin copying.**

[![Windows USB Tool Choose USB Drive](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)

Утилита начнёт копировать установочные файлы Windows на ваш USB-накопитель.

[![Windows USB Tool Copying Files](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)

Когда весь процесс завершится без ошибок, перезагрузите компьютер, вызовите загрузочное меню (у меня - F12 во время POST) и выберите USB. Если USB не появляется в списке, зайдите в BIOS и убедитесь, что **Legacy USB Support** установлен в **Enabled**.

**Замечания:**

-   Нельзя сделать загрузочный USB с 64-битной Windows, если у вас сейчас 32-битная ОС. Чтобы сделать загрузочный USB с 64-битной Windows, нужна 64-битная ОС.
-   USB-накопитель должен быть достаточно ёмким. 4 GB хватит для обычных 32-bit и 64-bit версий, но для 64-bit версии с developer tools нужен накопитель на 8 GB, потому что одна только ISO весит 4.7 GB.
-   Обязательно сделайте backup данных USB перед форматированием. Иначе они потеряются. Также внимательно выбирайте раздел, на который ставите ОС, чтобы случайно не перезаписать существующую установку Windows - в этом случае все данные тоже будут потеряны.

И последнее: опубликовано с чистой установки Windows 8. Так что точно работает.
