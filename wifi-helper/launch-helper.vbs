Option Explicit

Dim shell, fileSystem, installDir, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
installDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c """ & installDir & "\run-helper.bat"""
shell.Run command, 0, False
