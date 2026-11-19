# Security

## What Tempo does and does not do

- It reads a few files under `/proc` and `/sys` (processor, memory, network counters,
  temperature and fan sensors, process names and their processor time).
- While music bars are on **and** a media player is playing, it runs the system's `parec`
  program to read the sound going to your speakers, and turns it into bar heights in memory.
- It never opens the microphone, never writes sound to disk, and never uses the network.
- It needs no root access and installs nothing outside your home folder.

## Supported versions

Security fixes go into the latest release.

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private reporting
instead: on the repository page, open **Security**, then **Report a vulnerability**.
You should get an answer within a week.
