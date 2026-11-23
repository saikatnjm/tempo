#!/usr/bin/env python3
"""Remake the feature pages of Tempo's website.

    python3 tools/site.py

Tempo does several things people look for separately (a system monitor, an internet speed
meter, a music visualizer, CPU temperature, fans, desktop widgets). Each gets a page of its own
in docs/, so that someone searching for one of them finds a page about exactly that. The pages
are made from the texts below with one template, so they stay alike; the home page (index.html)
and the install guide (install.html) are written by hand.

This script also writes docs/sitemap.xml, and refreshes the block of search-engine data in
index.html (between the SEO:START and SEO:END marks) from that page's own questions.

Every figure in the texts comes from `make bench` (see the README, "Light by design"). When
they change there, change them here.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
SITE = 'https://saikatnjm.github.io/tempo/'
REPO = 'https://github.com/saikatnjm/tempo'
VERSION = (ROOT / 'VERSION').read_text().strip()
UPDATED = '2026-11-23'
DOWNLOAD_NEW = f'{REPO}/releases/latest/download/tempo-gnome45-plus.shell-extension.zip'
DOWNLOAD_OLD = f'{REPO}/releases/latest/download/tempo-gnome42-44.shell-extension.zip'
# Proves to Google Search Console that the site is the project's own. Not a secret: it is meant
# to be read from the page.
GOOGLE_VERIFICATION = 'RF5trxrdZtkytEnmTEsT2Wl1QqtxB0JtmKpjnZm3wFc'

# What Tempo is, in one sentence, for search engines and link previews.
APP_DESCRIPTION = ('A super light system monitor for the GNOME top bar on Linux: CPU and memory '
                   'rings, temperature, internet speed and fans, with a music visualizer and '
                   'desktop widgets when you want them.')

# slug, short name (menus and links), one line for the "also in Tempo" cards
PAGES = [
    {
        'slug': 'system-monitor',
        'name': 'System monitor',
        'teaser': 'CPU and memory as two small rings, with the details one click away.',
        'title': 'Lightweight system monitor for the GNOME top bar | Tempo',
        'description': 'Tempo is a super light system monitor for GNOME on Linux: CPU and memory '
                       'rings, temperature and network speed in the top bar, at no measurable '
                       'processor cost.',
        'h1': 'A super light system monitor for your top bar',
        'lead': 'Tempo puts your processor, memory and temperature in the GNOME top bar as two '
                'small rings and a number, and keeps the details one click away. It was built on '
                'a laptop that runs hot, so it does nothing unless something on screen needs to '
                'change.',
        'figures': [
            ('bar-ember.png', 466, 'Tempo in the top bar: music bars, a processor ring, a memory ring, the temperature and the network speed',
             'Tempo in the top bar, twice life size: music bars, processor, memory, temperature, network speed.'),
            ('menu.png', 300, "Tempo's menu: processor, memory, temperature, fan, network and the busiest apps",
             'One click shows the numbers.'),
        ],
        'get': [
            '<b>Processor and memory as rings.</b> One ring fills as the processor gets busier, the other as memory is used. No numbers to read; a glance is enough.',
            '<b>Temperature next to them</b>, turning amber above 75 °C and red above 85 °C. <a href="cpu-temperature.html">More about temperature</a>.',
            '<b>The details in one menu:</b> processor usage and clock speed, load average, memory and swap, graphics and disk temperature, every fan, network speed, and the four busiest apps.',
            '<b>Internet speed</b> as two small lines of fixed width, if you switch it on. <a href="network-speed.html">More about network speed</a>.',
            '<b>On the desktop instead, if you like:</b> a floating system panel with the same readings and a little fan. <a href="desktop-widgets.html">More about the panels</a>.',
            '<b>Yours to tune:</b> every part has its own switch, readings refresh every 1 to 10 seconds (3 by default), and there are four palettes.',
        ],
        'cost_intro': 'Measured on a 2019 laptop (Ryzen 5 3500U, GNOME Shell 42) with the project\'s own benchmark, which anyone can run with <code>make bench</code>. Figures are percent of one processor core.',
        'cost': [
            ('Rings, temperature and network speed in the top bar', 'Nothing measurable'),
            ('The same in the floating system panel', '0.2 %'),
            ('Menu details (busiest apps, fans, disk)', 'Read only while the menu is open'),
            ('While the screens are off', 'Nothing runs'),
            ('Installed size', '250 KB, no background service'),
        ],
        'cost_note': 'One timer every 3 seconds reads three small files in <code>/proc</code> and one sensor. A ring is repainted only when its percentage changes, a label only when its text changes.',
        'on': [
            '<b>Install Tempo</b> with the buttons above (the <a href="install.html">install guide</a> has every step).',
            '<b>That is all.</b> The two rings and the temperature appear at the right of the top bar. Click them for the menu.',
            '<b>Adjust</b> what is shown under <b>Settings</b>, at the bottom of that menu.',
        ],
        'faq': [
            ('How do I show CPU and RAM usage in the GNOME top bar?',
             'Install Tempo. Two rings appear at the right of the top bar: one fills with processor use, the other with memory use. Click them for the exact numbers.'),
            ('Does it work on Ubuntu, Fedora, Debian and Arch?',
             'Yes. Tempo is a GNOME Shell extension, so it runs on any distribution with the GNOME desktop, versions 42 to 50: Ubuntu 22.04 to 26.04, Fedora, Debian 12 and 13, Arch, openSUSE and others. It does not run on KDE Plasma, Xfce or Cinnamon.'),
            ('Will a system monitor slow my computer down?',
             'This one was measured so that it does not: the rings, temperature and network speed add no measurable processor load. One timer every 3 seconds reads three small files, and nothing is redrawn unless a value changed.'),
            ('Can I see which app is using the processor?',
             'Yes. The menu lists the four busiest apps. They are only measured while the menu is open.'),
            ('Can it show numbers instead of rings?',
             'The numbers are one click away in the menu, and the floating system panel shows the percentages all the time. The top bar itself stays calm on purpose.'),
        ],
    },
    {
        'slug': 'network-speed',
        'name': 'Internet speed',
        'teaser': 'Download and upload speed in the top bar, in a width that never changes.',
        'title': 'Internet speed meter for the GNOME top bar on Linux | Tempo',
        'description': 'See your download and upload speed in the GNOME top bar on Ubuntu, Fedora '
                       'or any Linux with GNOME. Fixed width, no flicker, no measurable processor '
                       'cost.',
        'h1': 'Internet speed in your top bar',
        'lead': 'Tempo shows how fast you are downloading and uploading right now, as two small '
                'lines in the GNOME top bar: download over upload. The numbers change; the width '
                'never does, so nothing in your top bar shuffles sideways.',
        'figures': [
            ('bar-ember.png', 466, 'Tempo in the top bar, with download and upload speed at the right',
             'Download over upload, at the right of Tempo, twice life size.'),
        ],
        'get': [
            '<b>Download and upload speed</b>, updated every 3 seconds (or every 1 to 10, your choice).',
            '<b>A fixed width</b>, measured in your own font. Other items in the top bar stay exactly where they are as the numbers change.',
            '<b>Counted once.</b> Tempo adds up your real network cards (Wi-Fi, Ethernet, USB tethering). Traffic through VPN tunnels, Docker bridges and virtual machines is not counted a second time.',
            '<b>Short in the bar, spelled out in the menu:</b> 892K and 1.2M in the top bar, 892 KiB/s and 1.2 MiB/s in the menu.',
            '<b>Also on the desktop:</b> the floating system panel shows the same speeds. <a href="desktop-widgets.html">More about the panels</a>.',
        ],
        'cost_intro': 'Measured with the project\'s own benchmark (<code>make bench</code>), in percent of one processor core.',
        'cost': [
            ('Network speed in the top bar', 'Nothing measurable'),
            ('While the screens are off', 'Nothing runs'),
        ],
        'cost_note': 'Every few seconds Tempo reads one small file the Linux kernel keeps (<code>/proc/net/dev</code>) and subtracts the previous reading. No network traffic is created, and nothing is sent anywhere.',
        'on': [
            '<b>Install Tempo</b> with the buttons above (the <a href="install.html">install guide</a> has every step).',
            '<b>Click Tempo</b> in the top bar and open <b>Settings</b>.',
            '<b>Switch on Network speed.</b> It is off by default, like every extra.',
        ],
        'faq': [
            ('How do I show internet speed in the top bar on Ubuntu?',
             'Install Tempo, open its Settings and switch on Network speed. Download and upload speed appear in the top bar as two small lines. It works the same on Fedora, Debian, Arch and any other distribution with GNOME 42 to 50.'),
            ('Is it bits or bytes?',
             'Bytes per second, the same unit your browser shows for a download. 1.2M means 1.2 mebibytes per second, which is about 10 megabits per second.'),
            ('Does it measure how fast my connection can go?',
             'No. It shows the traffic that is happening right now, not a speed test. Start a big download and you will see roughly what your connection can do.'),
            ('Why does it show 0K although I am online?',
             'Because nothing is being transferred at that moment. The number moves as soon as something loads.'),
            ('Does it count VPN or Docker traffic twice?',
             'No. Only real network cards are counted, so traffic that also passes through a tunnel or a bridge is counted once.'),
        ],
    },
    {
        'slug': 'music-visualizer',
        'name': 'Music visualizer',
        'teaser': 'Bars that move with your music, in the top bar or floating on the desktop.',
        'title': 'Music visualizer for Linux and the GNOME desktop | Tempo',
        'description': 'A light music visualizer for Linux: spectrum bars in the GNOME top bar or '
                       'a floating panel on your desktop. Works with any player, on PulseAudio and '
                       'PipeWire.',
        'h1': 'A music visualizer for Linux that stays out of the way',
        'lead': 'While something is playing, Tempo moves with the sound: ten small bars in the top '
                'bar, a thin line along it, or a floating visualizer on your desktop with '
                'segmented bars, falling peak caps and a reflection. When the music stops, it '
                'stops, and nothing is left running.',
        'figures': [
            ('float-viz-bars.png', 408, 'The floating visualizer: bars of lit segments with peak caps and a faint reflection',
             'The floating visualizer, as bars.'),
            ('float-viz-mirror.png', 408, 'The floating visualizer mirrored around its middle',
             'Mirrored.'),
            ('float-viz-wave.png', 408, 'The floating visualizer as a smooth wave',
             'As a wave.'),
            ('tip.png', 330, 'A small card under the music bars in the top bar, naming the song and the app',
             'In the top bar: rest the pointer on the bars to see what is playing.'),
        ],
        'get': [
            '<b>Three ways to see your music:</b> small bars next to the system rings, a level line along the whole top bar, or a floating panel that you place and size anywhere.',
            '<b>A real spectrum:</b> bass on the left, treble on the right, in your palette\'s colours. In the floating panel a wider window shows more bars (up to 64) and a taller one more segments.',
            '<b>Works with what you already use:</b> any player with the standard media controls, such as a browser playing YouTube or Spotify, the Spotify app, VLC or Rhythmbox, on PulseAudio or PipeWire.',
            '<b>Tells you what is playing:</b> rest the pointer on the bars for the song and the app; a click in the menu takes you there.',
            '<b>Private:</b> Tempo reads the sound going to your speakers, never the microphone. Nothing is saved and nothing is sent anywhere.',
        ],
        'cost_intro': 'Measured with the project\'s own benchmark (<code>make bench</code>) at the default 8 updates a second, in percent of one processor core. Moving pictures are the one thing in Tempo that costs something, so the numbers are published.',
        'cost': [
            ('Level line along the top bar', '1.4 %'),
            ('Small bars in the top bar', '2.1 %'),
            ('Floating visualizer panel', '2.7 %'),
            ('The sound recorder, while music is shown', '1 %, and 6 MB of memory'),
            ('Nothing is playing, or the screens are off', 'Nothing runs'),
        ],
        'cost_note': 'Each bar is drawn once; after that your graphics card only uncovers more or less of it. The sound is looked at once per frame, and the update rate is yours to set, from 5 to 30 a second.',
        'on': [
            '<b>Install Tempo</b> with the buttons above (the <a href="install.html">install guide</a> has every step).',
            '<b>Click Tempo</b> in the top bar and switch on <b>Music visuals</b>. Play something: the bars appear.',
            '<b>For the floating panel,</b> open <b>Floating panels</b> in the same menu and switch on <b>Visualizer panel</b>. Its design (bars, mirror, wave) is under Settings.',
            '<b>If nothing moves,</b> install the small <code>parec</code> tool: <code>sudo apt install pulseaudio-utils</code> on Ubuntu and Debian, <code>sudo dnf install pulseaudio-utils</code> on Fedora. Most GNOME desktops already have it.',
        ],
        'faq': [
            ('Is there a music visualizer for GNOME on Ubuntu or Fedora?',
             'Yes. Tempo is a GNOME Shell extension with a music visualizer built in: small bars or a level line in the top bar, or a floating visualizer panel on the desktop. It works on GNOME 42 to 50.'),
            ('Does it work with Spotify, YouTube and VLC?',
             'Yes, with any player that supports the standard media controls. If the player shows up in GNOME\'s media controls in the notification list, Tempo follows it. That covers browsers, the Spotify app, VLC, Rhythmbox and most others.'),
            ('Does it work with PipeWire?',
             'Yes, with PipeWire and with PulseAudio. Tempo uses the small parec tool, which talks to both.'),
            ('Does it listen to my microphone?',
             'No. It reads only the sound going to your speakers, turns it into bar heights in memory and throws it away. You can check with pactl list source-outputs: the stream is called Tempo and is attached to your speakers.'),
            ('How much processor time does it use?',
             'At the default 8 updates a second: 1.4 % of one processor core for the level line, 2.1 % for the small bars and 2.7 % for the floating panel, plus about 1 % for the sound recorder. While nothing is playing, nothing runs.'),
            ('The bars do not move. What now?',
             'Check that Music visuals is switched on, that sound is really playing, and that the parec tool is installed (package pulseaudio-utils). Games and apps without media controls do not start the bars.'),
        ],
    },
    {
        'slug': 'cpu-temperature',
        'name': 'CPU temperature',
        'teaser': 'The processor\'s temperature in the top bar, amber and red when it gets hot.',
        'title': 'CPU temperature in the GNOME top bar on Linux | Tempo',
        'description': 'Show your CPU temperature in the top bar on Ubuntu, Fedora or any Linux '
                       'with GNOME. AMD, Intel and ARM, with graphics and disk temperature one '
                       'click away.',
        'h1': 'Your CPU temperature, always in view',
        'lead': 'Tempo shows the processor\'s temperature in the GNOME top bar and tints it amber '
                'above 75 °C and red above 85 °C, so a hot machine catches your eye before it '
                'slows itself down.',
        'figures': [
            ('bar-ember.png', 466, 'Tempo in the top bar, showing 66 degrees next to the two rings',
             'The temperature sits next to the rings, twice life size here.'),
            ('menu.png', 300, "Tempo's menu with processor, graphics and disk temperature and the fan speed",
             'Graphics, disk and fans are in the menu.'),
        ],
        'get': [
            '<b>Works out of the box</b> on AMD (<code>k10temp</code>), Intel (<code>coretemp</code>) and most ARM boards. There is nothing to set up: Tempo reads the sensors the Linux kernel already offers.',
            '<b>A warning you cannot miss:</b> amber above 75 °C, red above 85 °C.',
            '<b>Graphics card and disk temperature</b> (NVMe and SATA) in the menu, read only while the menu is open.',
            '<b>Every fan and its speed</b> in the same menu. <a href="fan-control.html">More about fans</a>.',
            '<b>Celsius or Fahrenheit.</b>',
            '<b>Never in the way:</b> sensors are read on a worker thread, so a slow sensor cannot make your desktop stutter.',
        ],
        'cost_intro': 'Measured with the project\'s own benchmark (<code>make bench</code>), in percent of one processor core.',
        'cost': [
            ('Temperature in the top bar', 'Nothing measurable'),
            ('Graphics, disk and fans in the menu', 'Read only while the menu is open'),
            ('While the screens are off', 'Nothing runs'),
        ],
        'cost_note': 'One small file is read every 3 seconds, and the number is redrawn only when it changes.',
        'on': [
            '<b>Install Tempo</b> with the buttons above (the <a href="install.html">install guide</a> has every step).',
            '<b>That is all.</b> The temperature is on by default and appears next to the rings.',
            '<b>For Fahrenheit,</b> click Tempo, open <b>Settings</b> and change the temperature unit.',
        ],
        'faq': [
            ('How do I see my CPU temperature on Ubuntu without the terminal?',
             'Install Tempo. The processor temperature appears in the top bar at once, and stays there. The same works on Fedora, Debian, Arch and any other distribution with GNOME 42 to 50.'),
            ('Do I need lm-sensors?',
             'No. Tempo reads the temperature files the Linux kernel provides directly, so there is nothing else to install or configure.'),
            ('What temperature is too hot?',
             'That depends on the processor; most slow themselves down somewhere between 90 and 105 °C. Tempo turns amber at 75 °C and red at 85 °C as a heads-up, not as a verdict.'),
            ('The temperature is not shown. Why?',
             'Your computer has no temperature sensor Tempo recognises yet. Please open an issue on GitHub with the output of grep . /sys/class/hwmon/hwmon*/name and it can be added.'),
            ('Can it show the graphics card temperature too?',
             'Yes, in the menu, together with the disk temperature and the fans, where the kernel reports them (AMD and Intel graphics, and Nouveau).'),
        ],
    },
    {
        'slug': 'fan-control',
        'name': 'Fans',
        'teaser': 'Every fan and its speed, and an optional cooler fan curve for late starters.',
        'title': 'Fan speed and fan control for Linux laptops and PCs | Tempo',
        'description': 'See every fan\'s speed from the GNOME top bar on Linux, and give fans '
                       'that start too late a cooler curve. Made for laptops like the Dell '
                       'Inspiron.',
        'h1': 'See your fans, and start them sooner',
        'lead': 'Tempo lists every fan your computer reports, with its speed. And if your fans '
                'start too late (some laptops wait until 90 °C), the optional fan control gives '
                'them a cooler curve and a mode switch in the menu.',
        'figures': [
            ('float-system-rings.png', 358, 'The floating system panel: three rings and a small fan with its speed, 2500 RPM',
             'The little fan in the system panel turns while your real fan does.'),
            ('menu.png', 300, "Tempo's menu with the fan speed and the Fan mode switch",
             'Fan speed and Fan mode in the menu.'),
        ],
        'get': [
            '<b>Every fan, by name:</b> processor, case, graphics card and laptop fans, up to four, each with its speed. Empty connectors are left out.',
            '<b>A fan you can watch:</b> in the floating system panel a little fan turns while the real one does, faster as it speeds up. <a href="desktop-widgets.html">More about the panels</a>.',
            '<b>Optional fan control</b> with three modes in the menu: <b>Cool</b> (30 % below 60 °C, rising evenly to full speed at 85 °C), <b>Full speed</b>, and <b>Automatic</b> (hands off).',
            '<b>Made for laptops that wait too long.</b> A Dell Inspiron 3505 keeps its fan off until about 90 °C; with fan control it starts at 70 °C and stays on until the laptop is back below 58 °C, so it does not flicker on and off.',
            '<b>Works on</b> desktop motherboards (Nuvoton, ITE and Fintek chips), AMD graphics cards, Dell, ASUS and Framework laptops, ThinkPads after one setting, and fan hubs. Fans Linux can only read are shown, not controlled.',
            '<b>Safe by design:</b> when the service stops for any reason every fan goes back to the computer\'s own control, an unreadable temperature counts as hot, and a hot laptop\'s fan is never switched off when it is handed back.',
        ],
        'cost_intro': 'Fan control is a few lines of bash that run as a system service. Tempo itself works without it.',
        'cost': [
            ('Fan speeds in the menu', 'Read only while the menu is open'),
            ('The little fan in the system panel', '0.7 % of one core, only while the real fan turns'),
            ('The fan control service', 'No measurable processor use, about 5 MB of memory'),
        ],
        'cost_note': 'The service reads one temperature every 5 seconds and writes a fan setting only when it should change. It starts no other programs while it runs.',
        'on': [
            '<b>Install Tempo</b> with the buttons above. The fan speeds are in its menu straight away.',
            '<b>For fan control,</b> click Tempo, open <b>Settings</b>, scroll to <b>Fan control</b> and press <b>Install</b>. GNOME asks for your password once, because fans can only be driven with administrator rights.',
            '<b>Choose the mode</b> under <b>Fan mode</b> in Tempo\'s menu. The same Settings button removes fan control again.',
        ],
        'faq': [
            ('My laptop fan does not spin until it is very hot. Is it broken?',
             'Often not. Some laptops are set up by their maker to keep the fan off until about 90 °C. If the fan runs during start-up and Tempo shows a speed when the laptop is hot, the fan is fine and only starts late. Tempo\'s optional fan control can start it sooner.'),
            ('Is it safe to control fans from Linux?',
             'Tempo\'s fan control is built to fail safe: when it stops for any reason every fan goes back to the computer\'s own control, a temperature it cannot read counts as hot, and a fan that nothing else looks after is never stopped. It is tested against simulated fan hardware on every change.'),
            ('Which computers does fan control work on?',
             'Any computer where Linux can set the fan speed through its standard interface: most desktop motherboards, AMD graphics cards, Dell, ASUS and Framework laptops, and ThinkPads after adding fan_control=1. The installer lists what it found before it changes anything, and installs nothing if there is nothing to control.'),
            ('How do I see my fan speed on Linux?',
             'Install Tempo and click it: the menu lists every fan the computer reports with its speed in RPM. No terminal and no lm-sensors setup is needed.'),
            ('Can I remove fan control again?',
             'Yes: Settings, Fan control, Remove. Every fan goes straight back to the computer\'s own control, and Tempo keeps working without it.'),
        ],
    },
    {
        'slug': 'desktop-widgets',
        'name': 'Desktop widgets',
        'teaser': 'Floating panels for your desktop: system readings and a music visualizer.',
        'title': 'Desktop widgets for GNOME: system and music panels | Tempo',
        'description': 'Floating desktop widgets for GNOME on Linux: a system panel with CPU, '
                       'memory, temperature, network speed and fan, and a music visualizer. Drag, '
                       'zoom, done.',
        'h1': 'Desktop widgets for GNOME, without the weight',
        'lead': 'Two floating panels that you put anywhere on any screen: a system panel and a '
                'music visualizer. They sit on the desktop behind your windows like widgets, or '
                'on top of them, and each replaces its part of the top bar while it is on.',
        'figures': [
            ('float-both.png', 788, 'The system panel with three rings and a fan, and the visualizer panel with segmented bars, on the desktop',
             'The system panel (as rings) and the visualizer panel (as bars).'),
            ('float-system-bars.png', 358, 'The system panel as bars', 'The system panel, as bars.'),
            ('float-viz-wave.png', 408, 'The visualizer panel as a wave', 'The visualizer, as a wave.'),
        ],
        'get': [
            '<b>System panel:</b> processor, memory, temperature and network speed in one place, as rings or as bars, with a little fan that turns while your real fan does.',
            '<b>Visualizer panel:</b> your music as bars of lit segments with peak caps and a reflection, mirrored, or as a wave. <a href="music-visualizer.html">More about the visualizer</a>.',
            '<b>Drag to move, drag the corner to zoom.</b> A panel keeps its shape and everything in it grows with it. Drag the right or bottom edge to change its shape. Place and size are remembered.',
            '<b>Any screen:</b> put each panel on whichever monitor you like. If that monitor is unplugged, the panel comes to your main screen and goes back when it returns.',
            '<b>Your look:</b> behind your windows like a desktop widget or on top of them; a glass, solid or clear background; four palettes.',
            '<b>No clutter:</b> a panel takes its readings out of the top bar while it is on, so nothing is shown twice.',
        ],
        'cost_intro': 'Measured with the project\'s own benchmark (<code>make bench</code>), in percent of one processor core.',
        'cost': [
            ('System panel', '0.2 %'),
            ('Its little fan, while the real fan turns', '0.7 % more'),
            ('Visualizer panel, while music plays', '2.7 %'),
            ('In the overview, or while the screens are off', 'Nothing is animated'),
        ],
        'cost_note': 'The panels are drawn by GNOME Shell itself, not by a separate program, and reuse the readings Tempo already has. One thing Tempo cannot see is whether a window covers a panel: a visualizer behind a window still animates, so switch it off when you do not want it.',
        'on': [
            '<b>Install Tempo</b> with the buttons above (the <a href="install.html">install guide</a> has every step).',
            '<b>Click Tempo</b> in the top bar, open <b>Floating panels</b> and switch on the system panel, the visualizer panel, or both.',
            '<b>Drag</b> a panel where you want it, and drag its corner to size it. Designs, background and placement are under <b>Settings</b>.',
        ],
        'faq': [
            ('Does GNOME have desktop widgets?',
             'Not by itself. Tempo adds two: a system panel (processor, memory, temperature, network speed, fan) and a music visualizer. Both are drawn by GNOME Shell, so they need no separate program and no configuration files.'),
            ('I cannot drag the panel. Why?',
             'A panel on the desktop sits behind everything else, so a click only reaches it where nothing is in front. If your desktop shows icons (Ubuntu\'s Desktop Icons does) or you use the older X11 session, set Place them to On top of windows in the settings, move and size the panel, then switch back.'),
            ('Does it work with several monitors?',
             'Yes. Each panel can go on any monitor, and its place is remembered.'),
            ('Do the widgets use the processor all the time?',
             'The system panel costs about 0.2 % of one processor core. The visualizer costs 2.7 % while music plays and nothing while it does not. In the overview and while the screens are off, nothing is animated.'),
            ('Can I resize the widgets?',
             'Yes. Drag the bottom-right corner to zoom a panel: it keeps its shape, and the rings, text and bars grow with it. Drag the right or bottom edge to make it wider or taller instead.'),
        ],
    },
]

HOME_KEYWORD_LINKS = [(p['slug'], p['name']) for p in PAGES]


def strip_tags(text):
    return html.unescape(re.sub(r'<[^>]+>', '', text))


def app_data(url):
    """What search engines may show about the program itself."""
    return {
        '@type': 'SoftwareApplication',
        'name': 'Tempo',
        'description': APP_DESCRIPTION,
        'applicationCategory': 'UtilitiesApplication',
        'applicationSubCategory': 'System monitor',
        'operatingSystem': 'Linux with the GNOME desktop (GNOME Shell 42 to 50)',
        'softwareVersion': VERSION,
        'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'},
        'isAccessibleForFree': True,
        'license': 'https://www.gnu.org/licenses/gpl-3.0.html',
        'url': url,
        'downloadUrl': f'{REPO}/releases/latest',
        'codeRepository': REPO,
        'image': f'{SITE}assets/social-card.png',
        'screenshot': f'{SITE}assets/float-both.png',
    }


def faq_data(pairs):
    return {
        '@type': 'FAQPage',
        'mainEntity': [
            {'@type': 'Question', 'name': strip_tags(q),
             'acceptedAnswer': {'@type': 'Answer', 'text': strip_tags(a)}}
            for q, a in pairs
        ],
    }


def json_block(*items):
    data = {'@context': 'https://schema.org', '@graph': list(items)}
    text = json.dumps(data, ensure_ascii=False, indent=1).replace('</', '<\\/')
    return f'<script type="application/ld+json">\n{text}\n</script>'


def head_tags(title, description, url):
    e = html.escape
    return f'''<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<meta name="google-site-verification" content="{GOOGLE_VERIFICATION}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tempo">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}assets/social-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Tempo: a super light system monitor for the GNOME top bar">
<meta name="twitter:card" content="summary_large_image">'''


def figure(src, width, alt, caption, lazy=True):
    loading = ' loading="lazy"' if lazy else ''
    return (f'<figure><img src="assets/{src}" width="{width}" alt="{html.escape(alt)}"{loading}>'
            f'<figcaption>{caption}</figcaption></figure>')


def page_html(page):
    url = f"{SITE}{page['slug']}.html"
    current = ' aria-current="page"'
    nav = '\n  '.join(
        '<a href="{}.html"{}>{}</a>'.format(p['slug'], current if p is page else '', p['name'])
        for p in PAGES)
    figures = page['figures']
    first = figure(*figures[0], lazy=False)    # the first picture is in view at once
    rest = ''
    if len(figures) > 1:
        rest = '<div class="pair">\n' + '\n'.join(figure(*f) for f in figures[1:]) + '\n</div>'
    points = '\n'.join(f'    <li>{item}</li>' for item in page['get'])
    rows = '\n'.join(f'      <tr><td>{state}</td><td>{cost}</td></tr>' for state, cost in page['cost'])
    steps = '\n'.join(f'    <li>{step}</li>' for step in page['on'])
    questions = '\n'.join(
        f'  <details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>'
        for q, a in page['faq'])
    others = '\n'.join(
        f'    <a class="card" href="{p["slug"]}.html"><h3>{p["name"]}</h3><p>{html.escape(p["teaser"])}</p></a>'
        for p in PAGES if p is not page)
    crumbs = {
        '@type': 'BreadcrumbList',
        'itemListElement': [
            {'@type': 'ListItem', 'position': 1, 'name': 'Tempo', 'item': SITE},
            {'@type': 'ListItem', 'position': 2, 'name': page['name'], 'item': url},
        ],
    }
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{head_tags(page['title'], page['description'], url)}
<link rel="icon" type="image/svg+xml" href="assets/logo.svg">
<link rel="stylesheet" href="assets/site.css">
{json_block(app_data(SITE), crumbs, faq_data(page['faq']))}
</head>
<body>
<!-- Made by tools/site.py. Change the texts there, not here. -->
<div class="wrap">
<nav aria-label="Tempo">
  <img src="assets/logo.svg" alt="" width="34" height="34">
  <a class="home" href="./">Tempo</a>
  {nav}
  <a href="install.html">Install</a>
</nav>
<p class="crumbs"><a href="./">Tempo</a> › {page['name']}</p>

<h1>{page['h1']}</h1>
<p class="lead">{page['lead']}</p>
<div class="buttons">
  <a class="button primary" href="{DOWNLOAD_NEW}">Download for GNOME 45+</a>
  <a class="button" href="{DOWNLOAD_OLD}">GNOME 42, 43 and 44</a>
  <a class="button" href="install.html">Install guide</a>
</div>
<ul class="facts">
  <li><b>Free</b> and open source</li>
  <li><b>GNOME 42 to 50</b> on Ubuntu, Fedora, Debian, Arch and more</li>
  <li><b>250 KB</b>, nothing else installed</li>
</ul>
{first}

<section>
  <h2>What you get</h2>
  <ul class="points">
{points}
  </ul>
  {rest}
</section>

<section>
  <h2>What it costs your computer</h2>
  <p>{page['cost_intro']}</p>
  <div class="scroll">
  <table>
    <tbody>
{rows}
    </tbody>
  </table>
  </div>
  <p>{page['cost_note']} <a href="./#light">How Tempo stays light</a>.</p>
</section>

<section>
  <h2>Turn it on</h2>
  <ol class="steps">
{steps}
  </ol>
</section>

<section>
  <h2>Questions</h2>
{questions}
</section>

<section>
  <h2>Also in Tempo</h2>
  <p>Tempo is one small GNOME Shell extension. Every part has its own switch, and a part that is off costs nothing.</p>
  <div class="grid">
{others}
  </div>
</section>
</div>

<footer class="wrap">
  <a href="./">Tempo</a> ·
  <a href="install.html">Install</a> ·
  <a href="{REPO}">Source</a> ·
  <a href="install.html#versions">All versions</a> ·
  <a href="{REPO}/issues">Report a problem</a><br>
  Free software under the GPL-3.0-or-later licence. Not affiliated with or endorsed by the GNOME Foundation.
</footer>
</body>
</html>
'''


def refresh_home():
    """Put fresh search-engine data into index.html, from its own questions."""
    path = DOCS / 'index.html'
    text = path.read_text()
    section = text[text.index('<section class="wrap" id="questions">'):]
    section = section[:section.index('</section>')]
    pairs = re.findall(r'<details><summary>(.*?)</summary><p>(.*?)</p></details>', section, flags=re.S)
    if not pairs:
        raise SystemExit('index.html: no questions found')
    block = json_block(app_data(SITE), {
        '@type': 'WebSite', 'name': 'Tempo', 'url': SITE,
        'description': APP_DESCRIPTION,
    }, faq_data(pairs))
    start, end = '<!-- SEO:START -->', '<!-- SEO:END -->'
    if start not in text or end not in text:
        raise SystemExit('index.html: the SEO:START and SEO:END marks are missing')
    text = text[:text.index(start) + len(start)] + '\n' + block + '\n' + text[text.index(end):]
    path.write_text(text)
    return len(pairs)


def sitemap():
    urls = [SITE, f'{SITE}install.html'] + [f"{SITE}{p['slug']}.html" for p in PAGES]
    body = '\n'.join(f'  <url><loc>{u}</loc><lastmod>{UPDATED}</lastmod></url>' for u in urls)
    (DOCS / 'sitemap.xml').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f'{body}\n</urlset>\n')
    return len(urls)


def main():
    for page in PAGES:
        (DOCS / f"{page['slug']}.html").write_text(page_html(page))
        print(f"docs/{page['slug']}.html")
    print(f'index.html: search-engine data refreshed from {refresh_home()} questions')
    print(f'docs/sitemap.xml: {sitemap()} pages')


if __name__ == '__main__':
    main()
