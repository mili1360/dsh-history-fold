@echo off
REM Emergency rollback: restore the single-file history-fold that ran before the
REM fold+recall module split. Use this if DSH does not boot or the fold stops logging.
REM ASCII only.
set "BAK=E:\DSH记忆库\backup\20261018-105708-history-fold-拆分模块前\index.js"
set "DST=E:\deepseek插件\dsh-history-fold\lib\index.js"
if not exist "%BAK%" (
  echo backup missing: %BAK%
  exit /b 1
)
copy /y "%BAK%" "%DST%"
echo rolled back. restart DSH.