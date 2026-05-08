@echo off
rem Windows wrapper for SSH_ASKPASS. OpenSSH for Windows expects an .exe
rem or .cmd / .bat at SSH_ASKPASS, not a Node script directly. This .cmd
rem just dispatches to the .mjs sibling.
node "%~dp0_askpass.mjs" %*
