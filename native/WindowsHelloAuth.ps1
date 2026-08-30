# WindowsHelloAuth.ps1
#
# The Windows counterpart of TouchIDAuth.swift: prompts Windows Hello
# (fingerprint, face, or PIN — whatever the user has enrolled) via WinRT's
# UserConsentVerifier API and reports the result on stdout with an exit code.
# It never touches the filesystem and never sees any biometric data itself —
# Windows handles the verification and only tells this script yes or no.
#
# Unlike the macOS helper there is nothing to compile: the plugin runs this
# script with Windows PowerShell 5.1, which ships with every Windows 10/11
# install and can project WinRT types directly.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File WindowsHelloAuth.ps1 -Reason "unlock your Obsidian vault"
#
# Output / exit codes (same protocol as the macOS helper):
#   stdout "SUCCESS"                 exit 0   - verification succeeded
#   stdout "FAILURE:<message>"       exit 1   - user cancelled, failed, etc.
#   stdout "UNAVAILABLE:<message>"   exit 2   - Windows Hello not set up / not available

param(
	[string]$Reason = "unlock your Obsidian vault"
)

$ErrorActionPreference = "Stop"

try {
	# Project the WinRT verifier class into this session, then load the
	# .NET<->WinRT async bridge.
	$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
	Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
	Write-Output "UNAVAILABLE:The Windows Hello API could not be loaded. This requires Windows 10 or later with Windows PowerShell 5.1. ($($_.Exception.Message))"
	exit 2
}

# WinRT async operations must be bridged to .NET tasks before PowerShell can
# wait on them. Grab the generic AsTask(IAsyncOperation<T>) overload once.
# The enum result types are read off the verifier's method signatures rather
# than loaded by name — PowerShell 5.1 cannot reliably resolve WinRT enum
# type literals, and this stays correct regardless of metadata naming.
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
	$_.Name -eq "AsTask" -and
	$_.GetParameters().Count -eq 1 -and
	$_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
} | Select-Object -First 1

$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier]
$availabilityType = $verifier.GetMethod("CheckAvailabilityAsync").ReturnType.GetGenericArguments()[0]
$verificationType = $verifier.GetMethod("RequestVerificationAsync").ReturnType.GetGenericArguments()[0]

function Wait-WinRtOperation($operation, $resultType) {
	$task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
	$task.Wait()
	return $task.Result
}

# Plain RequestVerificationAsync creates the Hello dialog with no owner
# window: it shows up as its own "Windows Security" taskbar entry and often
# opens BEHIND other windows. The fix is the Win32 interop factory
# (IUserConsentVerifierInterop::RequestVerificationForWindowAsync), which
# parents the dialog to a window of our choosing — Obsidian's — so it opens
# on top of Obsidian, focused, with no separate taskbar button. That
# interface isn't reachable from PowerShell directly, so a small C# shim
# does the COM legwork. C# 5 only — Add-Type compiles with the old csc.
$interopSource = @'
using System;
using System.Runtime.InteropServices;

public static class ObsidianHelloInterop
{
	[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
	private interface IUserConsentVerifierInterop
	{
		IntPtr RequestVerificationForWindowAsync(IntPtr appWindow, IntPtr message, ref Guid riid);
	}

	[DllImport("combase.dll", CharSet = CharSet.Unicode)]
	private static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

	[DllImport("combase.dll")]
	private static extern int WindowsDeleteString(IntPtr hstring);

	[DllImport("combase.dll")]
	private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

	// Returns the raw IAsyncOperation<UserConsentVerificationResult> as an
	// RCW; the caller bridges it to a Task exactly like the non-interop path.
	public static object RequestVerificationForWindow(IntPtr appWindow, string message, Guid asyncOperationIid)
	{
		const string className = "Windows.Security.Credentials.UI.UserConsentVerifier";
		IntPtr classId = IntPtr.Zero, messageHString = IntPtr.Zero, factoryPtr = IntPtr.Zero, operationPtr = IntPtr.Zero;
		try
		{
			Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out classId));
			Guid interopIid = typeof(IUserConsentVerifierInterop).GUID;
			Marshal.ThrowExceptionForHR(RoGetActivationFactory(classId, ref interopIid, out factoryPtr));
			IUserConsentVerifierInterop interop = (IUserConsentVerifierInterop)Marshal.GetObjectForIUnknown(factoryPtr);
			Marshal.ThrowExceptionForHR(WindowsCreateString(message, message.Length, out messageHString));
			operationPtr = interop.RequestVerificationForWindowAsync(appWindow, messageHString, ref asyncOperationIid);
			return Marshal.GetObjectForIUnknown(operationPtr);
		}
		finally
		{
			if (operationPtr != IntPtr.Zero) Marshal.Release(operationPtr);
			if (factoryPtr != IntPtr.Zero) Marshal.Release(factoryPtr);
			if (messageHString != IntPtr.Zero) WindowsDeleteString(messageHString);
			if (classId != IntPtr.Zero) WindowsDeleteString(classId);
		}
	}
}
'@

function Get-ObsidianWindowHandle {
	foreach ($process in [System.Diagnostics.Process]::GetProcessesByName("Obsidian")) {
		if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
			return $process.MainWindowHandle
		}
	}
	return [IntPtr]::Zero
}

function Start-VerificationOperation($reason) {
	$hwnd = Get-ObsidianWindowHandle
	if ($hwnd -ne [IntPtr]::Zero) {
		try {
			Add-Type -TypeDefinition $interopSource
			# The IID of IAsyncOperation<UserConsentVerificationResult>, computed
			# by the CLR from the projected method signature (same algorithm
			# Windows uses for parameterized-interface IIDs).
			$operationIid = $verifier.GetMethod("RequestVerificationAsync").ReturnType.GUID
			return [ObsidianHelloInterop]::RequestVerificationForWindow($hwnd, $reason, $operationIid)
		} catch {
			[Console]::Error.WriteLine("Window-parented dialog unavailable, using default: $($_.Exception.Message)")
		}
	}
	return $verifier::RequestVerificationAsync($reason)
}

try {
	$availability = Wait-WinRtOperation ($verifier::CheckAvailabilityAsync()) $availabilityType

	if ("$availability" -ne "Available") {
		$message = switch ("$availability") {
			"DeviceNotPresent" { "No Windows Hello device (fingerprint reader or camera) was found, and no PIN is set up." }
			"NotConfiguredForUser" { "Windows Hello is not set up for this user. Enroll a fingerprint, face, or PIN in Settings > Accounts > Sign-in options." }
			"DisabledByPolicy" { "Windows Hello is disabled by group policy on this machine." }
			"DeviceBusy" { "The Windows Hello device is busy. Try again in a moment." }
			default { "Windows Hello is not available ($availability)." }
		}
		Write-Output "UNAVAILABLE:$message"
		exit 2
	}

	$result = Wait-WinRtOperation (Start-VerificationOperation $Reason) $verificationType

	if ("$result" -eq "Verified") {
		Write-Output "SUCCESS"
		exit 0
	}

	$message = switch ("$result") {
		"Canceled" { "Verification was cancelled." }
		"RetriesExhausted" { "Too many failed attempts. Windows has temporarily locked Hello verification." }
		"DeviceBusy" { "The Windows Hello device is busy. Try again in a moment." }
		"DeviceNotPresent" { "The Windows Hello device is no longer available." }
		"DisabledByPolicy" { "Windows Hello is disabled by group policy on this machine." }
		"NotConfiguredForUser" { "Windows Hello is not set up for this user." }
		default { "Verification did not complete ($result)." }
	}
	Write-Output "FAILURE:$message"
	exit 1
} catch {
	Write-Output "FAILURE:$($_.Exception.Message)"
	exit 1
}
