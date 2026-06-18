@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title IBP BOM - Migracion local

echo ============================================================
echo   IBP BOM  -  Migracion LOCAL (sin consumir Vercel)
echo ============================================================
echo.

rem --- Requisito unico: Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] No se encontro Node.js en este equipo.
  echo       Instalalo desde https://nodejs.org  (boton LTS, Siguiente-Siguiente^)
  echo       y vuelve a hacer doble clic en este archivo.
  echo.
  pause
  exit /b 1
)

rem --- Mostrar la version del codigo que se va a ejecutar ---
set "RAMA=desconocida"
for /f "delims=" %%b in ('git branch --show-current 2^>nul') do set "RAMA=%%b"
echo   Rama de codigo: %RAMA%
echo   En LOCAL los topes de volumen de la web NO aplican: migracion sin limite.
echo.

rem --- Dependencias (solo la primera vez) ---
if not exist node_modules (
  echo   Primera vez: instalando dependencias ^(puede tardar 1-2 min^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :err
  echo.
)

rem --- Compilar la interfaz con el codigo actual ---
echo   Compilando la aplicacion...
call npm run build
if errorlevel 1 goto :err
echo.

rem --- Servidor local: interfaz + proxy SAP en un solo puerto (8080) ---
echo   Iniciando servidor local... el navegador se abrira solo.
echo   Para DETENER: cierra esta ventana o pulsa Ctrl+C.
echo.
node servidor-local.mjs
exit /b 0

:err
echo.
echo   [X] Algo fallo. Revisa el mensaje de arriba y vuelve a intentar.
pause
exit /b 1
