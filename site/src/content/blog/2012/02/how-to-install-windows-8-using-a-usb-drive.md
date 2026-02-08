---
title: "How to install Windows 8 using a USB drive"
description: "To get you started you will need an ISO image of Windows 8 and also the Windows 7 USB / DVD Donwload Tool which will help you put that image on the USB stick. You can download both of them by clicking their respective images below. Install the Windows 7 USb Tool after download finishes…."
pubDate: 2012-02-01
updatedDate: 2023-11-05
tags:
  - "windows"
---
To get you started you will need an ISO image of Windows 8 and also the Windows 7 USB / DVD Donwload Tool which will help you put that image on the USB stick. You can download both of them by clicking their respective images below.

[![Windows 8 Developer Preview 64bit](https://lh6.googleusercontent.com/-mq-MQd8BRhI/TylZRYlL90I/AAAAAAAAADU/8EBFMLQqkiw/s257/Windows%25208%2520Developer%2520Preview%252064bit.PNG)](http://msdn.microsoft.com/en-us/windows/apps/br229516)

[![Windows USB Tool](https://lh3.googleusercontent.com/-RTG-V-mR--I/TylZRp6bKsI/AAAAAAAAADQ/CLxQ1-cwuis/s256/Windows%2520USB%2520DVD%2520Tool.PNG)](https://go.microsoft.com/fwlink/?LinkId=691209)

Install the Windows 7 USb Tool after download finishes. Don’t worry about the name of the program which says Windows 7, it works just fine with Windows 8 as well.

Now that you have all the needed files insert your USB drive into the PC, right click it and select format. Most tutorial’s I’ve seen say to format it to FAT32 otherwise it will not work – tho when I use the tool to copy the windows files to the USB drive, the tool formats my drive to NTFS. Strange, but whatever.

[![Windows Format Window](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)

Quick format it as FAT32 and **don’t forget to backup your data!**

Now that you’ve formatted the USB drive open up the Windows 7 USb Tool, hit **Browse** and select the ISO image you’ve just downloaded.

[![Windows USB Tool Choose an ISO File](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)

Click **Next** and on the next screen asking you to select the media type choose **USB device**. As you can see you are also given the option of writing the image directly to a DVD. For this how-to we will stick with the USB.

[![Windows USb Tool Choose Media Type](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)

Choose the USB device on which you want the tool to put the install files and hit **Begin copying.**

[![Windows USB Tool Choose USb Drive](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)

The tool will now start copying the windows install files to your USB drives.

[![Windows USB Tool Copying Files](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)

Once the entire process is complete and if you got no errors during it restart your computer, bring up your boot menu (F12 in my case – during POST) and select the USB drive. If your USB drive doesn’t show up in that list, go into your BIOS and make sure that **Legacy USB Support** is **Enabled**.

**Notes:**

-   you can not make a bootable USB drive with 64bit Windows on it if you are currently running a 32bit operating system. You need to have a 64bit operating system in order to make a bootable USB drive with 64bit windows on it.
-   the USB drive has to be large enough. 4 GB will do for the simple 32bit and 64bit versions but for the 64bit containing the developer tools you will need a 8 GB drive – because the size of the ISO alone is 4.7 GB.
-   make sure you backup the data you got on that USB drive before formatting it. Otherwise it-s lost. And also, carefully choose the partition on which you install the OS, not to overwrite your good Windows install by mistake – because in this case also, all data will be lost.

And one last thing: Published from a fresh copy of Windows 8. So you know for sure that it works.
