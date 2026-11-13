!define KEY_PRODUCT_LEGACY "Software\stratusadv\scribe"
!define KEY_UNINSTALL_LEGACY "Software\Microsoft\Windows\CurrentVersion\Uninstall\scribe"
!define PUBLISHER_LEGACY "stratusadv"
!define SHORTCUT_LEGACY "scribe.lnk"

!macro NSIS_HOOK_POSTINSTALL
    ReadRegStr $R0 HKCU "${KEY_UNINSTALL_LEGACY}" "Publisher"
    ReadRegStr $R1 HKCU "${KEY_PRODUCT_LEGACY}" ""
    StrCpy $R2 0
    StrCpy $R3 0

    ${If} $R0 == "${PUBLISHER_LEGACY}"
    ${AndIf} $R1 != ""
    ${AndIf} $R1 != $INSTDIR
    ${AndIf} ${FileExists} "$R1\uninstall.exe"
        ${If} ${FileExists} "$SMPROGRAMS\${SHORTCUT_LEGACY}"
            StrCpy $R2 1
        ${EndIf}

        ${If} ${FileExists} "$DESKTOP\${SHORTCUT_LEGACY}"
            StrCpy $R3 1
        ${EndIf}

        ExecWait '"$R1\uninstall.exe" /S _?=$R1' $R4

        ${If} $R4 = 0
            Delete "$R1\uninstall.exe"
            RMDir "$R1"
            DeleteRegKey HKCU "${KEY_PRODUCT_LEGACY}"
        ${EndIf}
    ${EndIf}

    ${If} $UpdateMode = 1
    ${AndIf} $R2 = 1
        CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ${If} $UpdateMode = 1
    ${AndIf} $R3 = 1
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
!macroend
