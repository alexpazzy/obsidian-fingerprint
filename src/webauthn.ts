// Security key (WebAuthn) unlock.
//
// Uses the renderer's WebAuthn API (navigator.credentials) so hardware
// security keys — YubiKeys and friends — can unlock the vault. Chromium
// handles all the CTAP/USB/NFC details and shows the platform's native
// security-key dialog; on Windows that's the same system dialog Windows
// Hello uses.
//
// Threat-model note: like the rest of this plugin, this is a screen lock,
// not encryption. We don't run a server, so there is nothing to verify a
// signature against — "the registered key completed an assertion" is the
// yes/no answer, exactly like the biometric helpers. We do check that the
// credential ID returned matches one the user registered, so a random
// stranger's key won't work.

export interface SecurityKeyInfo {
	/** base64url-encoded credential ID */
	id: string;
	label: string;
	createdAt: number;
}

export type SecurityKeyError =
	| { status: "failed"; message: string }
	| { status: "unavailable"; message: string };

export type SecurityKeyResult = { status: "success" } | SecurityKeyError;

function bufferToBase64Url(buffer: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(buffer)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuffer(base64url: string): ArrayBuffer {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export function isWebAuthnAvailable(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.credentials !== "undefined" &&
		typeof navigator.credentials.create === "function" &&
		typeof window.PublicKeyCredential !== "undefined"
	);
}

/**
 * Obsidian's desktop app serves the vault from app://obsidian.md, so the
 * effective WebAuthn RP ID is "obsidian.md". Derive it from the actual
 * location rather than hardcoding, in case that ever changes.
 */
function getRpId(): string | undefined {
	return window.location.hostname || undefined;
}

function randomChallenge(): Uint8Array<ArrayBuffer> {
	const challenge = new Uint8Array(new ArrayBuffer(32));
	window.crypto.getRandomValues(challenge);
	return challenge;
}

function describeWebAuthnError(err: unknown): SecurityKeyError {
	if (err instanceof DOMException) {
		switch (err.name) {
			case "NotAllowedError":
				return { status: "failed", message: "The request was cancelled, timed out, or no registered key was presented." };
			case "InvalidStateError":
				return { status: "failed", message: "This security key is already registered." };
			case "NotSupportedError":
			case "SecurityError":
				return { status: "unavailable", message: `WebAuthn isn't supported here (${err.message})` };
			case "AbortError":
				return { status: "failed", message: "The request was aborted." };
		}
	}
	return { status: "failed", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Registers a new security key and returns its credential ID (base64url).
 * The private key never leaves the security key; we only remember the
 * credential ID so we can ask for that specific key at unlock time.
 */
export async function registerSecurityKey(
	existingKeys: SecurityKeyInfo[]
): Promise<{ status: "registered"; id: string } | SecurityKeyError> {
	if (!isWebAuthnAvailable()) {
		return { status: "unavailable", message: "WebAuthn is not available in this Obsidian build." };
	}

	const userId = new Uint8Array(new ArrayBuffer(16));
	window.crypto.getRandomValues(userId);

	try {
		const credential = (await navigator.credentials.create({
			publicKey: {
				challenge: randomChallenge(),
				rp: { name: "Fingerprint Lock", id: getRpId() },
				user: {
					id: userId,
					name: "obsidian-vault",
					displayName: "Obsidian vault",
				},
				pubKeyCredParams: [
					{ type: "public-key", alg: -7 }, // ES256
					{ type: "public-key", alg: -257 }, // RS256
				],
				excludeCredentials: existingKeys.map((key) => ({
					type: "public-key" as const,
					id: base64UrlToBuffer(key.id),
				})),
				authenticatorSelection: {
					userVerification: "preferred",
					residentKey: "discouraged",
				},
				timeout: 60_000,
				attestation: "none",
			},
		})) as PublicKeyCredential | null;

		if (!credential) {
			return { status: "failed", message: "No credential was returned." };
		}
		return { status: "registered", id: bufferToBase64Url(credential.rawId) };
	} catch (err) {
		return describeWebAuthnError(err);
	}
}

/**
 * Prompts for any of the registered security keys and reports success only
 * if the assertion came back from one of them.
 */
export async function authenticateSecurityKey(registeredKeys: SecurityKeyInfo[]): Promise<SecurityKeyResult> {
	if (!isWebAuthnAvailable()) {
		return { status: "unavailable", message: "WebAuthn is not available in this Obsidian build." };
	}
	if (registeredKeys.length === 0) {
		return { status: "unavailable", message: "No security keys are registered." };
	}

	try {
		const assertion = (await navigator.credentials.get({
			publicKey: {
				challenge: randomChallenge(),
				rpId: getRpId(),
				allowCredentials: registeredKeys.map((key) => ({
					type: "public-key" as const,
					id: base64UrlToBuffer(key.id),
				})),
				userVerification: "preferred",
				timeout: 60_000,
			},
		})) as PublicKeyCredential | null;

		if (!assertion) {
			return { status: "failed", message: "No assertion was returned." };
		}

		const returnedId = bufferToBase64Url(assertion.rawId);
		if (!registeredKeys.some((key) => key.id === returnedId)) {
			return { status: "failed", message: "The presented key is not one of the registered keys." };
		}
		return { status: "success" };
	} catch (err) {
		return describeWebAuthnError(err);
	}
}
