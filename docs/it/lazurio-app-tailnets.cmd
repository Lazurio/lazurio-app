@echo off
rem Lazurio App (Alpha): the network of your Organization, for your own Windows account only.
rem It writes HKCU\Software\Lazurio\App, value Tailnets, and needs no administrator.
reg add "HKCU\Software\Lazurio\App" /v Tailnets /t REG_SZ /d "[{\"tailnet\":\"<tailnet>\",\"controlUrl\":\"https://<control-server>\",\"domains\":[\"<domain>\"]}]" /f
if errorlevel 1 (echo The network setting was not saved.) else (echo Done. The network setting is saved for this Windows account.)
pause
