$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$vc = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat'
New-Item -ItemType Directory -Force "$root\build" | Out-Null
Push-Location "$root\build"
try {
  $build = 'call "' + $vc + '" >nul && cl /nologo /O2 /MT /c /TC "..\server\vendor\sqlite3.c" /Fo:sqlite3.obj && cl /nologo /std:c++17 /EHsc /utf-8 /O2 /MT /D_WIN32_WINNT=0x0A00 /DCPPHTTPLIB_THREAD_POOL_COUNT=8 "..\server\main.cpp" sqlite3.obj /Fe:plyt-server.exe /link ws2_32.lib bcrypt.lib crypt32.lib'
  & cmd.exe /d /s /c $build
  if ($LASTEXITCODE -ne 0) { throw 'C++ build failed' }
} finally { Pop-Location }
