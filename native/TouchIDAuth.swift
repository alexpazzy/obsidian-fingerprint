// TouchIDAuth.swift
//
// A tiny, dependency-free command line helper that prompts macOS Touch ID
// (via the LocalAuthentication framework) and reports the result on stdout
// with an exit code. It never touches the filesystem and never sees or
// stores any biometric data itself -- that's all handled by macOS's Secure
// Enclave. This binary only asks the OS "did the current user just prove it
// with their fingerprint?" and relays a yes/no answer.
//
// Usage (build.sh names the compiled binary "Obsidian" so that macOS shows
// that name in the Touch ID dialog):
//   ./Obsidian --reason "unlock your Obsidian vault"
//
// Output / exit codes:
//   stdout "SUCCESS"                 exit 0   - Touch ID succeeded
//   stdout "FAILURE:<message>"       exit 1   - user cancelled, failed, etc.
//   stdout "UNAVAILABLE:<message>"   exit 2   - no Touch ID hardware / not enrolled

import Foundation
import LocalAuthentication

func readReasonArgument() -> String {
	let args = CommandLine.arguments
	if let flagIndex = args.firstIndex(of: "--reason"), args.count > flagIndex + 1 {
		return args[flagIndex + 1]
	}
	return "unlock your Obsidian vault"
}

let reason = readReasonArgument()
let context = LAContext()

// We only want biometrics here (Touch ID), not a fallback to the macOS
// account password -- Obsidian's own optional password fallback covers that
// case, and keeping this binary biometrics-only makes its behavior predictable.
context.localizedFallbackTitle = ""
context.localizedCancelTitle = "Cancel"

var availabilityError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &availabilityError) else {
	let message = availabilityError?.localizedDescription ?? "Touch ID is not available on this Mac."
	print("UNAVAILABLE:\(message)")
	exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var succeeded = false
var failureMessage = "Authentication failed."

context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, evaluationError in
	succeeded = success
	if let evaluationError = evaluationError as NSError? {
		failureMessage = evaluationError.localizedDescription
	}
	semaphore.signal()
}

semaphore.wait()

if succeeded {
	print("SUCCESS")
	exit(0)
} else {
	print("FAILURE:\(failureMessage)")
	exit(1)
}
