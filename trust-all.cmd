@echo off
chcp 65001 >nul
title npm Trusted Publishing setup
cd /d C:\Users\25437\Desktop\dsh-plugins
echo ============================================
echo  npm Trusted Publishing setup (10 packages)
echo.
echo  First package: an auth URL will appear below.
echo  Open it in your browser, complete 2FA, and
echo  check the 'skip 2FA for 5 minutes' option.
echo  Then the rest should run automatically.
echo ============================================
echo.
for %%p in (dsh-plugin-multi-edit dsh-plugin-bash dsh-plugin-loop-guard dsh-plugin-hub-finder dsh-plugin-session-tidy dsh-plugin-hw-monitor dsh-plugin-deepseek-balance dsh-plugin-goal-fold dsh-plugin-queue-fold dsh-plugin-chat-zoom) do (
  echo.
  echo ========== %%p ==========
  call npm trust github %%p --file publish.yml --repo Fanlr1/dsh-plugins --allow-publish --yes
  if errorlevel 1 (echo [FAILED] %%p) else (echo [OK] %%p)
)
echo.
echo ============================================
echo  All done. Press any key to close.
echo ============================================
pause >nul